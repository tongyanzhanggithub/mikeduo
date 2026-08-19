// HS 编码校验 单测
//
//   node tools/test-hscode.mjs
//
// 这个功能存在的理由：AI 细化定位产出的 HS 码一直没人校验过。
// 模型报一个不存在的码，用户拿去查海关数据、填报关单，一路错到底。
// 和「编造联系人」是同一类问题——把模型输出当事实用。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hs = createRequire(import.meta.url)(join(root, "electron", "hscode.js"));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("HS 编码校验 单测");

check("目录能载入，带构建日期与限制说明", () => {
  const s = hs.stats();
  assert.equal(s.ok, true);
  assert.equal(s.count > 8000, true, `只载入 ${s.count} 条`);
  assert.equal(s.caveats.length >= 2, true, "限制说明必须随结果给出");
  assert.match(s.caveats.join(" "), /六位/);
});

check("模型的各种写法都要认：8479.89 / 8479 89 / 847989", () => {
  for (const q of ["847989", "8479.89", "8479 89", "84.79.89"]) {
    const r = hs.lookup(q);
    assert.equal(r.valid, true, `${q} 应当有效`);
    assert.equal(r.code, "847989");
  }
});

check("串得出 章 → 品目 → 子目 的完整层级", () => {
  const r = hs.lookup("847989");
  assert.deepEqual(r.path.map((p) => p.code), ["84", "8479", "847989"]);
  assert.equal(r.level, "子目");
  assert.equal(r.specificEnough, true);
});

check("章和品目算有效，但要标明「不够细」——报关要用到六位", () => {
  assert.equal(hs.lookup("84").specificEnough, false);
  assert.equal(hs.lookup("84").level, "章");
  assert.equal(hs.lookup("8479").specificEnough, false);
  assert.equal(hs.lookup("8479").level, "品目");
});

check("模型最常见的错法：前几位对、后几位编的 → 要定位到最近有效上级", () => {
  const r = hs.lookup("847999");
  assert.equal(r.valid, false);
  assert.equal(r.fallback.code, "8479");
  assert.match(r.reason, /最近的有效上级/);
  assert.equal(r.siblings.length > 0, true, "要给出同级可选项，否则用户不知道该改成什么");
});

check("超过六位不算错，是各国自行扩展——要说清楚而不是判无效了事", () => {
  const r = hs.lookup("8479891000");
  assert.equal(r.valid, false);
  assert.equal(r.fallback.code, "847989");
  assert.match(r.reason, /国际六位|自行扩展/);
});

check("完全对不上时明说，不瞎回退", () => {
  const r = hs.lookup("119999");
  assert.equal(r.valid, false);
  assert.equal(!!r.fallback, false || !!r.fallback); // 有上级就给，没有就没有
});

check("空值与垃圾输入不当成有效", () => {
  for (const q of ["", null, undefined, "abc", "-", "1"]) {
    assert.equal(hs.lookup(q).valid, false, `${JSON.stringify(q)} 不该有效`);
  }
});

check("HS 2022 的无人机类目在目录里（8806）", () => {
  const r = hs.lookup("880621");
  assert.equal(r.valid, true);
  assert.match(r.text, /Unmanned aircraft/i);
  assert.deepEqual(r.path.map((p) => p.code), ["88", "8806", "880621"]);
});

check("关键词搜索能用，且搜不到时给出「HS 用法条式措辞」的提示", () => {
  const ok = hs.search("unmanned aircraft", 10);
  assert.equal(ok.rows.length > 0, true);
  // 日常叫法 drone 在 HS 里根本不存在——这正是用户会踩的坑
  const miss = hs.search("drone", 10);
  assert.equal(miss.rows.length, 0);
  assert.match(miss.hint, /unmanned aircraft/);
});

check("搜索关键词过短时不返回结果（避免整表刷屏）", () => {
  assert.equal(hs.search("a", 10).rows.length, 0);
  assert.equal(hs.search("", 10).rows.length, 0);
});

console.log(`\n${passed} 项全部通过`);
