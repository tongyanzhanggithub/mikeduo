// 激活码编解码与验签的单元测试（对应 PRD F1 验收标准）
//
//   node tools/test-license.mjs
//
// 用一对临时密钥跑，不依赖 tools/keys 下的正式私钥。
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const licPath = join(root, "electron", "license.js");

// 用临时公钥造一份 license.js 副本，避免动到正式公钥
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const der = publicKey.export({ type: "spki", format: "der" });
const rawPub = der.subarray(der.length - 32).toString("base64");
const tmp = mkdtempSync(join(tmpdir(), "mkd-lic-"));
const testLic = join(tmp, "license.cjs");
writeFileSync(testLic, readFileSync(licPath, "utf8").replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${rawPub}";`));

const require = createRequire(import.meta.url);
const L = require(testLic);
const pem = privateKey.export({ type: "pkcs8", format: "pem" });

const MACHINE_A = "7f3a4b2c9d10e8cd";
const MACHINE_B = "0011223344556677";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("激活码单测");

const code = L.issueCode({ machineRaw: MACHINE_A, tierId: "pro", issuedAt: "2026-08-02", privateKeyPem: pem });

check("激活码为 14 段 × 8 位", () => {
  const parts = code.split("-");
  assert.equal(parts.length, 14);
  parts.forEach((p) => assert.equal(p.length, 8));
  assert.match(code.replace(/-/g, ""), /^[A-Z2-7]+$/);
});

check("本机验证通过，并还原出档位与签发日", () => {
  const r = L.verifyCode(code, MACHINE_A);
  assert.equal(r.ok, true);
  assert.equal(r.tier, "pro");
  assert.equal(r.tierLabel, "VIP版");
  assert.equal(r.issuedAt, "2026-08-02");
});

check("换一台机器验证失败（跨机不通用）", () => {
  assert.deepEqual(L.verifyCode(code, MACHINE_B), { ok: false, reason: "verify" });
});

check("粘贴脏数据能自愈：小写、换行、空格、O/0 与 I/1 混淆", () => {
  const dirty = code.toLowerCase().replace(/-/g, " \n ").replace(/O/gi, "0").replace(/I/gi, "1");
  assert.equal(L.verifyCode(dirty, MACHINE_A).ok, true);
});

check("改一个字符就失效", () => {
  const chars = code.split("");
  const i = chars.findIndex((c) => /[A-Z]/.test(c));
  chars[i] = chars[i] === "A" ? "B" : "A";
  assert.equal(L.verifyCode(chars.join(""), MACHINE_A).ok, false);
});

check("长度不对报格式错误而不是验证失败（错误分型正确）", () => {
  assert.equal(L.verifyCode("ABCDE-FGHIJ", MACHINE_A).reason, "format");
  assert.equal(L.verifyCode("", MACHINE_A).reason, "format");
  assert.equal(L.verifyCode(code + "AAAAAAAA", MACHINE_A).reason, "format");
});

check("三个档位分别可签可验", () => {
  ["basic", "pro", "coach"].forEach((tier) => {
    const c = L.issueCode({ machineRaw: MACHINE_A, tierId: tier, issuedAt: "2026-01-15", privateKeyPem: pem });
    const r = L.verifyCode(c, MACHINE_A);
    assert.equal(r.ok, true);
    assert.equal(r.tier, tier);
    assert.equal(r.issuedAt, "2026-01-15");
  });
});

check("未知档位直接抛错，不会签出一个坏码", () => {
  assert.throws(() => L.issueCode({ machineRaw: MACHINE_A, tierId: "vip", issuedAt: "2026-01-01", privateKeyPem: pem }));
});

check("别人的私钥签不出能过验的码", () => {
  const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const forged = L.issueCode({ machineRaw: MACHINE_A, tierId: "coach", issuedAt: "2026-08-02", privateKeyPem: other });
  assert.equal(L.verifyCode(forged, MACHINE_A).ok, false);
});

check("base32 编解码是可逆的", () => {
  const buf = Buffer.from([0, 1, 127, 128, 255, 42, 7]);
  assert.equal(L.base32Decode(L.base32Encode(buf)).subarray(0, buf.length).toString("hex"), buf.toString("hex"));
});

console.log(`\n${passed} 项全部通过`);
