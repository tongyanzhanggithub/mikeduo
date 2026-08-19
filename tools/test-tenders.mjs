// 公共部门采购官线索源 单测
//
//   node tools/test-tenders.mjs
//
// 这块最容易犯的错不是技术错，是**把它包装成"最新标讯"**。
// 实测 GO 类公告没有截止日字段、全库只有 231 条截止日未过——当机会卖是骗人的。
// 所以测试里钉的第一组，是"限制说明必须存在且说对了话"。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const td = createRequire(import.meta.url)(join(root, "electron", "tenders.js"));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("公共部门采购官 单测");

/* ---------------------- 诚实性：这块最容易出的错 ---------------------- */

check("必须自带限制说明，且明确否认自己是招标机会", () => {
  const s = td.stats();
  assert.equal(s.ok, true);
  assert.equal(s.caveats.length >= 3, true);
  const all = s.caveats.join(" ");
  assert.match(all, /联系人库/);
  assert.match(all, /不是招标机会/);
});

check("必须给出数据截止日期——过期的采购数据不标日期就是误导", () => {
  const s = td.stats();
  assert.match(s.dataThrough, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(s.builtAt, /^\d{4}-\d{2}-\d{2}$/);
});

check("限制说明里要写明「别按个人邮箱过滤」——这是数据方点名的坑", () => {
  // 官方公布的联系邮箱约 44% 是 gmail 之类。按"个人邮箱=不可信"筛会杀掉大量真实机构联系人。
  assert.match(td.stats().caveats.join(" "), /个人邮箱|免费邮箱/);
});

check("限制说明里要写明画像与进口商不同", () => {
  assert.match(td.stats().caveats.join(" "), /公共部门|进口商|分销商/);
});

/* ---------------------------- 查询本身 ---------------------------- */

check("库能载入，规模符合预期", () => {
  const s = td.stats();
  assert.equal(s.count > 4000, true, `只有 ${s.count} 人`);
});

check("按国家筛选精确匹配，不做模糊", () => {
  const r = td.search({ country: "India", limit: 50 });
  assert.equal(r.rows.length > 0, true);
  assert.equal(r.rows.every((x) => x.country === "India"), true);
});

check("activeSince 能筛掉多年没动静的——这是这份数据最有价值的一维", () => {
  const all = td.search({ country: "India", limit: 500 });
  const recent = td.search({ country: "India", activeSince: "2025-01-01", limit: 500 });
  assert.equal(recent.rows.length < all.rows.length, true, "筛选没起作用");
  assert.equal(recent.rows.every((x) => x.lastNotice >= "2025-01-01"), true);
});

check("关键词命中「买过什么」或机构名", () => {
  const r = td.search({ keyword: "laptop", limit: 20 });
  assert.equal(r.rows.length > 0, true);
  assert.equal(
    r.rows.every((x) => `${x.org} ${x.buys.join(" ")}`.toLowerCase().includes("laptop")),
    true
  );
});

check("每条都带联系方式与「最近一次公告」——没有时效标记的联系人不能用", () => {
  const r = td.search({ limit: 20 });
  assert.equal(r.rows.every((x) => x.email && x.email.includes("@")), true);
  assert.equal(r.rows.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.lastNotice || "")), true);
  assert.equal(r.rows.every((x) => typeof x.noticeCount === "number" && x.noticeCount > 0), true);
});

check("默认按最近活动排序（最新的在前）", () => {
  const r = td.search({ limit: 30 });
  const dates = r.rows.map((x) => x.lastNotice);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

check("免费邮箱没有被过滤掉——数据方明确警告不可这么做", () => {
  const r = td.search({ limit: 300 });
  const free = r.rows.filter((x) => /@(gmail|yahoo|hotmail|outlook)\./i.test(x.email));
  assert.equal(free.length > 0, true, "免费邮箱被误过滤了，这会杀掉大量真实机构联系人");
});

check("国家清单可用于做筛选下拉", () => {
  const c = td.countries();
  assert.equal(c.ok, true);
  assert.equal(c.rows.length > 10, true);
  assert.equal(c.rows[0].n >= c.rows[c.rows.length - 1].n, true, "应按数量降序");
});

check("空查询与超限查询不炸", () => {
  assert.equal(td.search({}).ok, true);
  assert.equal(td.search({ country: "不存在的国家" }).rows.length, 0);
  assert.equal(td.search({ limit: 0 }).rows.length, 0);
});

console.log(`\n${passed} 项全部通过`);
