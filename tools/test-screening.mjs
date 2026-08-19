// 合规筛查 单测
//
//   node tools/test-screening.mjs
//
// 这块的对错直接关系法律责任，两个方向的错都要防：
//   漏判 —— 用户跟受限主体做了生意，后果是法律责任
//   误判 —— 正常客户被拦，用户不敢做生意，很快就不信任这个功能
//
// 数据方点名的三个坑各钉一条。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sc = require(join(root, "electron", "screening.js"));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("合规筛查 单测");

/* ---------------------------- 归一化 ---------------------------- */

check("数据方点名的坑：少一个逗号仍判为同一家", () => {
  // CHINA SPACESAT CO., LTD. 是名单主体；写成 CO. LTD. 精确匹配就失效
  assert.equal(sc.normalize("CHINA SPACESAT CO., LTD."), sc.normalize("CHINA SPACESAT CO. LTD."));
  assert.equal(sc.normalize("china spacesat co ltd"), sc.normalize("CHINA SPACESAT CO., LTD."));
});

check("法律形式后缀不影响比对（LLC / GmbH / FZE / 有限公司）", () => {
  const same = (a, b) => assert.equal(sc.normalize(a), sc.normalize(b), `${a} ≠ ${b}`);
  same("Gulf Agri Supply LLC", "GULF AGRI SUPPLY");
  same("Muster GmbH", "MUSTER");
  same("Desert Drone FZE", "DESERT DRONE");
  same("深圳华强集团有限公司", "深圳华强");
});

check("但不能剥掉带区分度的词——否则会制造误报", () => {
  // TRADING / HOLDINGS / INTERNATIONAL 是名字的一部分。
  // 剥掉的话 "ACME TRADING" 和 "ACME HOLDINGS" 会双双压成 ACME，一起撞上名单里的 ACME。
  assert.notEqual(sc.normalize("ACME TRADING"), sc.normalize("ACME HOLDINGS"));
  assert.notEqual(sc.normalize("PACIFIC INTERNATIONAL"), sc.normalize("PACIFIC GROUP"));
});

check("单词包含不等于同一家", () => {
  assert.notEqual(sc.normalize("CHINA MOBILE"), sc.normalize("MOBILE"));
});

/* ---------------------------- 名单查询 ---------------------------- */

check("名单能载入，且带构建日期与限制说明", () => {
  const s = sc.stats();
  assert.equal(s.ok, true);
  assert.equal(s.count > 30000, true, `只载入了 ${s.count} 条`);
  assert.match(s.builtAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(s.caveats.length >= 3, true, "限制说明必须随结果一起给出");
});

check("名单主体能被查到（三种写法都命中同一条）", () => {
  for (const q of ["CHINA SPACESAT CO., LTD.", "CHINA SPACESAT CO. LTD.", "china spacesat co ltd"]) {
    const r = sc.screen(q);
    assert.equal(r.hit, true, `${q} 应当命中`);
    assert.equal(r.match, "exact");
    assert.equal(r.matchedName, "CHINA SPACESAT CO., LTD.");
  }
});

check("CMIC-EO13959 不是贸易禁令，必须标成 info 而不是 block", () => {
  // 中国移动、中海油都属这类：只限制美国人买卖其证券。
  // 标成"禁止交易"是明确的误报，会吓退正常生意。
  const r = sc.screen("CHINA SPACESAT CO., LTD.");
  assert.equal(r.level, "info");
  assert.equal(r.hits.every((h) => h.level === "info"), true);
  assert.match(r.hits[0].means, /不是贸易禁令/);
});

check("三条法律线分别给出各自的后果，不合并成「被制裁」", () => {
  const seen = new Set();
  for (const name of ["CHINA SPACESAT CO., LTD."]) {
    sc.screen(name).hits.forEach((h) => seen.add(h.regime));
  }
  assert.equal(seen.size >= 1, true);
  const d = sc._internals.describeHit({ r: "UFLPA", d: "" });
  assert.equal(d.level, "block");
  assert.match(d.means, /口岸|扣留/);
  const b = sc._internals.describeHit({ r: "BIS-DPL", d: "" });
  assert.match(b.means, /美国成分/);
  const o = sc._internals.describeHit({ r: "OFAC", d: "SDGT" });
  assert.match(o.means, /美元|美国渠道/);
});

check("正常客户不被误伤", () => {
  for (const n of [
    "Gulf Agri Supply LLC",
    "Desert Drone Trading FZE",
    "Acme Import Export Co., Ltd",
    "Shenzhen Huaqiang Electronics",
    "Oasis Agro Equipment"
  ]) {
    assert.equal(sc.screen(n).hit, false, `${n} 不该命中`);
  }
});

check("空名字/垃圾输入不报命中", () => {
  for (const n of ["", "   ", null, undefined, ",,,", "CO., LTD."]) {
    assert.equal(sc.screen(n).hit, false, `${JSON.stringify(n)} 不该命中`);
  }
});

/* ------------------- 预检判定（渲染层的 screeningVerdict） ------------------- */

const netsrc = readFileSync(join(root, "src", "09-netprobe.js"), "utf8");
const ctx = createContext({ console });
runInContext(
  netsrc.slice(netsrc.indexOf("function screeningVerdict"), netsrc.indexOf("if (typeof preflightOutboxItem")),
  ctx
);
const verdict = ctx.screeningVerdict;

check("精确命中 block 级 → 拦下发送", () => {
  const v = verdict({
    company: "X",
    screening: { hit: true, match: "exact", matchedName: "BAD CO", hits: [{ level: "block", label: "UFLPA 涉疆实体清单" }] }
  });
  assert.equal(v.level, "block");
  assert.match(v.text, /UFLPA/);
});

check("只命中证券投资限制类 → 提示但不拦", () => {
  const v = verdict({
    company: "X",
    screening: { hit: true, match: "exact", matchedName: "CM", hits: [{ level: "info", label: "OFAC（证券投资限制类）" }] }
  });
  assert.equal(v.level, "info");
});

check("疑似（名称相近）只警告，不阻断——误判的代价同样高", () => {
  const v = verdict({ company: "X", screening: { hit: true, match: "partial", candidates: [{}, {}] } });
  assert.equal(v.level, "warn");
});

check("人工推翻后不再拦，但状态可见（留痕）", () => {
  const v = verdict({
    company: "X",
    screening: { hit: true, match: "exact", hits: [{ level: "block", label: "L" }] },
    screeningOverride: { by: "me", at: "2026-08-19", reason: "同名不同家" }
  });
  assert.equal(v.level, "overridden");
});

check("没查过的线索不产生任何判定——不能把「没查」当成「没问题」", () => {
  assert.equal(verdict({ company: "X" }), null);
  assert.equal(verdict({ company: "X", screening: { hit: false } }), null);
});

console.log(`\n${passed} 项全部通过`);
