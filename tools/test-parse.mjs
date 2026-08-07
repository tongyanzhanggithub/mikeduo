// 联网找客户的「公司列表解析」回归测试
//
//   node tools/test-parse.mjs
//
// 这条链路真实翻过车：一键起量报「AI 有回复，但内容里解析不出公司列表」。
// 原实现是「第一个 [ 到最后一个 ]」的朴素切片，遇到两种常见情况必然失败：
//   ① 联网回复里混着散文和引文标记 [1][2] —— 起点被带偏；
//   ② web_search 的检索结果吃掉 token，数组写到一半被 max_tokens 截断 —— 没有收尾的 ]。
// 这里把 extractJsonArray 从 06 里切出来单独跑，钉住这些形态。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "06-ui-ai-engine-contacts.js"), "utf8");

// 从源码里切出这一个函数（自包含，只用到 String / JSON）
const start = src.indexOf("function extractJsonArray(text) {");
if (start < 0) throw new Error("找不到 extractJsonArray —— 函数被改名了？");
const end = src.indexOf("\nfunction extractJsonObject", start);
const extractJsonArray = new Function(`${src.slice(start, end)}\nreturn extractJsonArray;`)();

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("公司列表解析 单测");

const three = `[{"company":"Acme Trading","website":"acme.com","market":"UAE","note":"进口记录活跃"},
{"company":"Gulf Parts","website":"gulfparts.ae","market":"UAE","note":"经销商列表命中"},
{"company":"Desert Drone","website":"desertdrone.ae","market":"UAE","note":"官网有采购页"}]`;

check("干净的 JSON 数组", () => {
  assert.equal(extractJsonArray(three).length, 3);
});

check("包在 markdown 代码围栏里", () => {
  const r = extractJsonArray("我找到了这些公司：\n\n```json\n" + three + "\n```\n\n以上均已核实官网。");
  assert.equal(r.length, 3);
  assert.equal(r[0].company, "Acme Trading");
});

// 这条是原实现的第一个死穴
check("散文里的引文标记 [1][2] 不会把起点带偏", () => {
  const text = `根据搜索结果[1]，UAE 市场有若干进口商[2]。整理如下：\n${three}\n数据来源见上方引用[3]。`;
  const r = extractJsonArray(text);
  assert.equal(r.length, 3);
  assert.equal(r[2].website, "desertdrone.ae");
});

// 这条是原实现的第二个死穴，也是最常见的失败
check("被 max_tokens 截断时仍能捞出已写完的公司", () => {
  const truncated = `这是我找到的公司：\n[{"company":"Acme Trading","website":"acme.com","market":"UAE","note":"进口记录活跃"},
{"company":"Gulf Parts","website":"gulfparts.ae","market":"UAE","note":"经销商列表命中"},
{"company":"Desert Dro`;
  const r = extractJsonArray(truncated);
  assert.equal(r.length, 2, "两条完整的应该被救回来");
  assert.equal(r[0].company, "Acme Trading");
  assert.equal(r[1].company, "Gulf Parts");
});

check("字符串里的方括号不会打乱配平", () => {
  const text = `[{"company":"A [Holdings] Ltd","website":"a.com","note":"名字里带方括号"}]`;
  const r = extractJsonArray(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].company, "A [Holdings] Ltd");
});

check("转义引号不会提前结束字符串", () => {
  const text = String.raw`[{"company":"B \"Best\" Co","website":"b.com","note":"带转义引号"}]`;
  const r = extractJsonArray(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].company, 'B "Best" Co');
});

check("纯散文没有公司 → 返回 null 而不是抛错", () => {
  assert.equal(extractJsonArray("抱歉，我无法联网搜索，建议你手动查询相关目录站。"), null);
});

check("空数组当作没结果", () => {
  assert.equal(extractJsonArray("[]"), null);
});

check("空输入 / 非字符串不炸", () => {
  assert.equal(extractJsonArray(""), null);
  assert.equal(extractJsonArray(null), null);
  assert.equal(extractJsonArray(undefined), null);
});

check("只有半个对象、一条都凑不齐 → null", () => {
  assert.equal(extractJsonArray(`[{"company":"Half Writ`), null);
});

check("数组前后都有散文时取的是数组不是散文", () => {
  const r = extractJsonArray(`前言。\n${three}\n后记：以上 3 家均在阿联酋。`);
  assert.equal(r.length, 3);
});

console.log(`\n${passed} 项全部通过`);
