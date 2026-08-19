// 内置数据集陈旧度判定 单测
//
//   node tools/test-dataset-age.mjs
//
// 这个功能的存在理由只有一句：**用一份过期的制裁名单做合规判断，比不做更危险**。
// 不做的话用户知道自己没查；用旧名单查完显示「未命中」，他会以为自己是安全的。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ageOf, THRESHOLDS } = createRequire(import.meta.url)(join(root, "electron", "dataset-age.js"));

const NOW = Date.parse("2026-08-19T00:00:00Z");
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("数据集陈旧度 单测");

check("三份数据的阈值按各自更新频率分开定，不是一刀切", () => {
  // 制裁名单几乎每周变；HS 五年一修。用同一个阈值必然一头太松一头太紧。
  assert.equal(THRESHOLDS.screening.warn < THRESHOLDS.tenders.warn, true);
  assert.equal(THRESHOLDS.tenders.warn < THRESHOLDS.hscodes.warn, true);
  assert.equal(THRESHOLDS.screening.warn, 90);
  assert.equal(THRESHOLDS.hscodes.warn, 730);
});

check("制裁名单：90 天提示、180 天告警", () => {
  assert.equal(ageOf("screening", "2026-08-01", NOW).level, "ok");
  assert.equal(ageOf("screening", "2026-05-01", NOW).level, "warn");
  assert.equal(ageOf("screening", "2026-01-01", NOW).level, "alert");
});

check("告警文案必须点破「未命中不等于安全」——这是整个功能的要害", () => {
  const a = ageOf("screening", "2026-01-01", NOW);
  assert.match(a.text, /未命中.*不代表安全|不代表安全/);
  assert.match(a.text, /官方站点|OFAC/);
});

check("每份数据说自己的话，不套用同一段模板", () => {
  // 曾经写成一套通用文案，结果对采购官库说出「新增主体查不到、未命中不等于安全」，
  // 而采购官库根本没有「未命中」这回事。
  const t = ageOf("tenders", "2025-01-01", NOW).text;
  const h = ageOf("hscodes", "2020-01-01", NOW).text;
  assert.equal(/未命中/.test(t), false, "采购官库不该出现「未命中」的说法");
  assert.equal(/未命中/.test(h), false, "HS 目录不该出现「未命中」的说法");
  assert.match(t, /调岗|离职|退信/);
  assert.match(h, /税则|HS 版本|修订/);
});

check("采购官库过期时，建议先验邮箱——把陈旧转成可执行的动作", () => {
  assert.match(ageOf("tenders", "2025-01-01", NOW).text, /验证邮箱真伪|验一/);
});

check("天数算得对", () => {
  assert.equal(ageOf("screening", "2026-08-19", NOW).days, 0);
  assert.equal(ageOf("screening", "2026-08-09", NOW).days, 10);
});

check("构建日期在未来 → 判 unknown，不当成「很新」", () => {
  // 用户机器时钟不对是真事。当成很新就等于悄悄关掉了这个保护。
  const a = ageOf("screening", "2027-01-01", NOW);
  assert.equal(a.level, "unknown");
  assert.match(a.text, /时钟/);
});

check("日期读不出来 → 判 unknown，不当成 ok", () => {
  const a = ageOf("screening", "不是日期", NOW);
  assert.equal(a.level, "unknown");
  assert.equal(a.days, null);
});

check("未知的数据类型返回 null，不瞎编一个判定", () => {
  assert.equal(ageOf("不存在的数据集", "2026-01-01", NOW), null);
});

/* -------------------- 三个模块是否真的把 age 带出来了 -------------------- */

const req = createRequire(import.meta.url);
const sc = req(join(root, "electron", "screening.js"));
const hs = req(join(root, "electron", "hscode.js"));
const td = req(join(root, "electron", "tenders.js"));

check("三个模块的 stats() 都带 age", () => {
  for (const [name, m] of [["screening", sc], ["hscode", hs], ["tenders", td]]) {
    const a = m.stats().age;
    assert.equal(!!a, true, `${name}.stats() 没有 age`);
    assert.match(a.level, /^(ok|warn|alert|unknown)$/);
  }
});

check("查询结果本身也带 age——面板直接用返回值渲染，不能只在 stats 里有", () => {
  assert.equal(!!sc.screen("anything").age, true);
  assert.equal(!!hs.lookup("847989").age, true);
  assert.equal(!!td.search({ limit: 1 }).age, true);
});

console.log(`\n${passed} 项全部通过`);
