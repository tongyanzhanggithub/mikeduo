// 离线激活（主进程）——Ed25519 非对称签名，全程不联网
//
// 激活码结构（68 字节 → base32 → 112 位分 14 段）：
//   [0]   版本号 1
//   [1]   档位   B=basic 基础版 / P=pro VIP版 / C=coach 陪跑版
//         注意：档位字符 B/P/C 是签名内容的一部分，改显示名不影响已发出的码
//   [2-3] 签发日 距 2020-01-01 的天数（大端 16 位）
//   [4-67] Ed25519 签名，签名对象是明文 `机器码raw|档位|签发日YYYY-MM-DD`
//
// 验证 = 用硬编码公钥验签 + 比对本机机器码。私钥只在开发者本机 tools/keys/ 下，
// 绝不入仓库（.gitignore 已排除）。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// ---- 公钥（由 tools/init-keys.mjs 生成并回写此处；换密钥对后旧码全部失效）----
const PUBLIC_KEY_B64 = "bXBdmX5rB97Qn+M13QgXZ1lp2Ozq0jmmYf2tpT6GoLY=";

const TIERS = {
  B: { id: "basic", label: "基础版" },
  P: { id: "pro", label: "VIP版" },
  C: { id: "coach", label: "陪跑版" }
};
const TIER_BY_ID = { basic: "B", pro: "P", coach: "C" };

const EPOCH = Date.UTC(2020, 0, 1);
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 粘贴清洗：去空格换行与分隔符、统一大写、把最常见的抄错 0→O、1→I 纠正回来
function normalizeCode(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
}

function groupCode(code) {
  return code.match(/.{1,8}/g).join("-");
}

function daysToDate(days) {
  return new Date(EPOCH + days * 86400000).toISOString().slice(0, 10);
}

function dateToDays(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000);
}

function signedMessage(machineRaw, tierId, issuedAt) {
  return `${machineRaw}|${tierId}|${issuedAt}`;
}

// 开发者侧：用私钥出码
function issueCode({ machineRaw, tierId, issuedAt, privateKeyPem }) {
  const tierChar = TIER_BY_ID[tierId];
  if (!tierChar) throw new Error(`未知档位：${tierId}（应为 basic / pro / coach）`);
  const days = dateToDays(issuedAt);
  const header = Buffer.alloc(4);
  header[0] = 1;
  header[1] = tierChar.charCodeAt(0);
  header.writeUInt16BE(days, 2);
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(signedMessage(machineRaw, tierId, issuedAt), "utf8"), key);
  const blob = Buffer.concat([header, sig]);
  return groupCode(base32Encode(blob).padEnd(112, "A"));
}

// 应用侧：验码。返回 { ok, reason, tier, tierLabel, issuedAt }
// reason: "format" 格式不对 ｜ "verify" 签名或机器码不匹配
function verifyCode(rawInput, machineRaw) {
  const clean = normalizeCode(rawInput);
  if (clean.length < 109 || clean.length > 112) return { ok: false, reason: "format" };
  const blob = base32Decode(clean);
  if (!blob || blob.length < 68) return { ok: false, reason: "format" };
  if (blob[0] !== 1) return { ok: false, reason: "format" };
  const tierChar = String.fromCharCode(blob[1]);
  const tier = TIERS[tierChar];
  if (!tier) return { ok: false, reason: "format" };
  const issuedAt = daysToDate(blob.readUInt16BE(2));
  const sig = blob.subarray(4, 68);
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"), // Ed25519 SPKI 前缀
        Buffer.from(PUBLIC_KEY_B64, "base64")
      ]),
      format: "der",
      type: "spki"
    });
    const okSig = crypto.verify(
      null,
      Buffer.from(signedMessage(machineRaw, tier.id, issuedAt), "utf8"),
      key,
      sig
    );
    if (!okSig) return { ok: false, reason: "verify" };
  } catch {
    return { ok: false, reason: "verify" };
  }
  return { ok: true, tier: tier.id, tierLabel: tier.label, issuedAt, code: groupCode(clean) };
}

/* ---------- 本地落盘（safeStorage 加密） ---------- */

function licensePath(app) {
  return path.join(app.getPath("userData"), "license.dat");
}

function saveLicense(app, safeStorage, payload) {
  const json = JSON.stringify(payload);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(`plain:${json}`, "utf8");
  fs.writeFileSync(licensePath(app), buf);
}

// 读激活信息。文件损坏/被改/机器码对不上 → 一律静默回退试用，绝不抛错崩溃。
function loadLicense(app, safeStorage, machineRaw) {
  try {
    const file = licensePath(app);
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    let json;
    if (buf.subarray(0, 6).toString("utf8") === "plain:") json = buf.subarray(6).toString("utf8");
    else json = safeStorage.decryptString(buf);
    const data = JSON.parse(json);
    if (!data?.code) return null;
    const check = verifyCode(data.code, machineRaw);
    return check.ok ? { ...check, activatedAt: data.activatedAt } : null;
  } catch {
    return null;
  }
}

function clearLicense(app) {
  try {
    fs.rmSync(licensePath(app), { force: true });
  } catch {
    /* 删不掉就算了，下次验签仍会拦住 */
  }
}

module.exports = {
  TIERS,
  issueCode,
  verifyCode,
  normalizeCode,
  groupCode,
  base32Encode,
  base32Decode,
  saveLicense,
  loadLicense,
  clearLicense,
  licensePath
};
