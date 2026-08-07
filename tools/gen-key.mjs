// 发码工具：把用户回传的机器码换成激活码
//
//   node tools/gen-key.mjs 7F3A-K2M9-QX41-B8CD pro
//   node tools/gen-key.mjs 7F3A-K2M9-QX41-B8CD basic 2026-08-02
//
// 档位：basic 基础版 ¥699 ｜ pro VIP版 ¥1499 ｜ coach 陪跑版 ¥4999
// 签发日省略则取今天。签发日决定「首年免费更新」的到期时间。
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { issueCode } = require(join(root, "electron", "license.js"));

const [machineInput, tierInput, dateInput] = process.argv.slice(2);
if (!machineInput || !tierInput) {
  console.error("用法：node tools/gen-key.mjs <机器码> <basic|pro|coach> [签发日 YYYY-MM-DD]");
  process.exit(1);
}

const privPath = join(root, "tools", "keys", "private.pem");
if (!existsSync(privPath)) {
  console.error(`找不到私钥 ${privPath}，先运行：node tools/init-keys.mjs`);
  process.exit(1);
}

const machineRaw = machineInput.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
if (machineRaw.length !== 16) {
  console.error(`机器码应为 16 位十六进制（4 段 ×4 位），收到 ${machineRaw.length} 位：${machineInput}`);
  process.exit(1);
}

const issuedAt = dateInput || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) {
  console.error(`签发日格式应为 YYYY-MM-DD，收到：${issuedAt}`);
  process.exit(1);
}

const code = issueCode({
  machineRaw,
  tierId: tierInput,
  issuedAt,
  privateKeyPem: readFileSync(privPath, "utf8")
});

console.log("");
console.log("  机器码：", machineInput.toUpperCase());
console.log("  档位：  ", tierInput);
console.log("  签发日：", issuedAt, "（更新服务到期：" + new Date(new Date(issuedAt).getTime() + 365 * 86400000).toISOString().slice(0, 10) + "）");
console.log("");
console.log("  激活码：");
console.log("  " + code);
console.log("");

// 发码流水：核对订单、处理换机、查重都靠它
try {
  appendFileSync(
    join(root, "tools", "keys", "issued.log"),
    `${new Date().toISOString()}\t${machineRaw}\t${tierInput}\t${issuedAt}\t${code}\n`
  );
} catch {
  /* 记不上流水不影响出码 */
}
