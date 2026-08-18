/* 源码卫生检查：不该出现的控制字符。

   起因是一次真实事故：写代码时 `\b`（词边界）被工具链吃掉一层反斜杠，
   变成了真的退格符 0x08，于是 04 里那条 looksLikeQuery 的
   `/-site:|\bOR\b\s*"/` 有一整个分支永远匹配不上——语法合法、测试全绿、
   静静地坏了很久，靠肉眼根本发现不了。

   同类的还有 \n 被吃成真换行（会直接语法报错，反而好发现）。
   这一条守的是"看不见的坏"。 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 合法的空白：制表、换行、回车。其余 C0 控制字符都不该出现在源码里。
const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const targets = [
  ...readdirSync(join(root, "src")).filter((f) => f.endsWith(".js")).map((f) => join("src", f)),
  ...readdirSync(join(root, "electron")).filter((f) => f.endsWith(".js")).map((f) => join("electron", f)),
  "main.js",
  "preload.js",
  "build.mjs"
];

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("源码卫生");

check("源码里没有控制字符（退格符等）", () => {
  const hits = [];
  for (const rel of targets) {
    const text = readFileSync(join(root, rel), "utf8");
    let m;
    BAD.lastIndex = 0;
    while ((m = BAD.exec(text))) {
      hits.push(`${rel}:${text.slice(0, m.index).split("\n").length} 出现 0x${m[0].charCodeAt(0).toString(16)}`);
    }
  }
  assert.deepEqual(hits, [], `发现控制字符：\n${hits.join("\n")}`);
});

check("looksLikeQuery 的词边界没有被吃掉", () => {
  const text = readFileSync(join(root, "src", "04-analytics-discovery.js"), "utf8");
  // 针里的反斜杠用字符码拼——直接写字面量的话，这个断言自己就会被同一个
  // 吃反斜杠的问题弄坏，变成一条永远通过的假测试。
  const BS = String.fromCharCode(92);
  assert.ok(text.includes("-site:|" + BS + "bOR" + BS + "b"), "looksLikeQuery 里的词边界不见了");
  assert.ok(!text.includes(String.fromCharCode(8)), "04 里又出现退格符了");
});

console.log(`\n${passed} 项全部通过`);
