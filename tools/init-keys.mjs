// 一次性：生成 Ed25519 密钥对
//
//   node tools/init-keys.mjs            生成（已存在则拒绝覆盖）
//   node tools/init-keys.mjs --force    强制重新生成（旧激活码全部作废！）
//
// 私钥写到 tools/keys/private.pem（.gitignore 已排除，绝不入仓库、绝不发给任何人）；
// 公钥回写到 electron/license.js 的 PUBLIC_KEY_B64 常量。
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyDir = join(root, "tools", "keys");
const privPath = join(keyDir, "private.pem");
const pubPath = join(keyDir, "public.pem");
const licPath = join(root, "electron", "license.js");
const force = process.argv.includes("--force");

if (existsSync(privPath) && !force) {
  console.error(`已存在私钥：${privPath}`);
  console.error("重新生成会让所有已发出的激活码作废。确认要换请加 --force。");
  process.exit(1);
}

mkdirSync(keyDir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));

// SPKI DER 的后 32 字节就是原始公钥
const der = publicKey.export({ type: "spki", format: "der" });
const raw = der.subarray(der.length - 32).toString("base64");

const src = readFileSync(licPath, "utf8");
const replaced = src.replace(/const PUBLIC_KEY_B64 = "[^"]*";/, `const PUBLIC_KEY_B64 = "${raw}";`);
if (replaced === src) {
  console.error("没能在 electron/license.js 里找到 PUBLIC_KEY_B64 常量，请手动填入：", raw);
  process.exit(1);
}
writeFileSync(licPath, replaced);

console.log("密钥对已生成");
console.log("  私钥（务必离线备份，泄露=激活体系失守）:", privPath);
console.log("  公钥已写入 electron/license.js:", raw);
