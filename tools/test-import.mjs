// 粘贴导入解析的回归测试
//
//   node tools/test-import.mjs
//
// 这条链路真实翻过车：用户粘了内容，提示「这段内容里没有公司官网或邮箱可用」，
// 但完全不知道卡在哪。排查后发现两个真 bug 加一堆误伤，这里把各种形态全钉住。
//
// 解析器依赖一堆全局（state / campaign / 黑名单等），所以在 vm 沙箱里跑真源码，
// 只补它运行时真正用到的几个全局。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, "src", f), "utf8");

// 直接把整个 04 模块丢进沙箱跑真源码——比"从大文件里正则切函数"稳得多。
// 04 里几乎全是声明，顶层没有 DOM 副作用；它运行时用到的外部函数在 sandbox 里补桩。
const sandbox = {
  console,
  state: { prospects: [], blacklist: [], campaign: {}, settings: {}, ui: {} },
  makeId: (p) => `${p}-${Math.random().toString(36).slice(2, 9)}`,
  isBlacklisted: () => false,
  normalizeMarkets: (v) =>
    String(v || "United States")
      .split(/[,，;；]/)
      .map((x) => x.trim())
      .filter(Boolean),
  stripProtocol: (v) => String(v).replace(/^https?:\/\//, "").replace(/\/$/, ""),
  scoreProspect: () => 70,
  // 按空格分词大写首字母：不用词边界，避免转义序列在生成时被吃成控制字符
  capitalize: (v) => String(v || "").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" "),
  clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
  dateOffset: () => "2026-08-05",
  escapeHtml: (v) => String(v),
  addLog: () => {},
  hasProductProfile: () => false,
  productFit: () => ({ hits: 0, matched: [], mismatch: false })
};
const ctx = createContext(sandbox);
runInContext(readFileSync(join(root, "src", "04-analytics-discovery.js"), "utf8"), ctx);

const campaign = { markets: "United States", customerType: "importer distributor", product: "drone parts" };
const parse = (text) => {
  ctx.state.prospects = [];
  return ctx.importSearchResultsText(text, campaign);
};

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("粘贴导入解析 单测");

// —— 两个真 bug ——

check("散文里的两段式裸域名能被扫出来（原正则要求三段，acme.com 全漏）", () => {
  const r = parse("We are a leading importer, visit us at gulfagri.ae or email us anytime.");
  assert.equal(r.length, 1);
  assert.equal(r[0].website, "gulfagri.ae");
});

check("整页粘贴时导航文字不再被当成公司（Google 现在是 domain › path，没有 http/www）", () => {
  const r = parse(
    "搜索\n图片\n视频\n\nGulf Agri Supply LLC\ngulfagri.ae › products\nLeading importer of UAV components...\n\nDesert Drone Trading FZE\ndesertdrone.ae › wholesale\n\n下一页\n设置\n隐私权"
  );
  assert.equal(r.length, 2);
  assert.equal(r.map((p) => p.website).sort().join(","), "desertdrone.ae,gulfagri.ae");
  assert.equal(r.some((p) => /搜索|图片|下一页|设置|隐私权/.test(p.company)), false);
});

// —— 误伤 ——

check("report.pdf / Ltd.Co 不会被当成公司官网", () => {
  const r = parse("See report.pdf (e.g. Acme Ltd.Co) and visit realbuyer.ae");
  assert.equal(r.length, 1);
  assert.equal(r[0].website, "realbuyer.ae");
});

check("整句散文不会被当成公司名", () => {
  assert.equal(parse("这是一段完全没有网址的说明文字，只是随便写写。").length, 0);
});

// —— 正常形态都要能用 ——

check("纯公司名清单保留裸名字（之后可用「批量解析官网」补域名）", () => {
  const r = parse("Gulf Agri Supply\nDesert Drone Trading\nOasis Agro Equipment");
  assert.equal(r.length, 3);
  assert.equal(r.every((p) => !p.website), true);
});

check("完整 URL 与邮箱都能抓到，同一家公司跨行合并", () => {
  const r = parse("Gulf Agri — https://gulfagri.ae/about buyer@gulfagri.ae\nDesert Drone — https://desertdrone.ae");
  assert.equal(r.length, 2);
  assert.equal(r.find((p) => p.website === "gulfagri.ae").email, "buyer@gulfagri.ae");
});

check("www 与裸域名视为同一家，不重复入池", () => {
  const r = parse("www.gulfagri.ae\ngulfagri.ae");
  assert.equal(r.length, 1);
});

// —— 失败时要讲清楚是哪一种 ——

check("粘的是搜索式本身 → 明确告知，而不是笼统的「没有可用内容」", () => {
  const text = '("Drone Parts" OR "UAV Components") ("importer" OR "distributor") -alibaba -site:facebook.com -"market research"';
  assert.equal(parse(text).length, 0);
  assert.match(ctx.explainImportFailure(text).reason, /搜索式/);
});

check("全是平台站 → 说清有几个域名、为什么不能用", () => {
  const text = "https://www.linkedin.com/company/abc\nhttps://www.facebook.com/abc";
  assert.equal(parse(text).length, 0);
  assert.match(ctx.explainImportFailure(text).reason, /平台\/社媒站/);
});

check("压根没有域名 → 提示可以直接粘公司名", () => {
  const text = "这是一段完全没有网址的说明文字，只是随便写写。";
  assert.equal(parse(text).length, 0);
  assert.match(ctx.explainImportFailure(text).reason, /没有任何网址或邮箱/);
});

check("平台站域名一律不进池", () => {
  assert.equal(parse("alibaba.com\namazon.com\nlinkedin.com\ngulfagri.ae").length, 1);
});

console.log(`\n${passed} 项全部通过`);
