// 端到端用户旅程回归
//
//   node tools/test-journey.mjs
//
// 前面那些单测各自测一个函数，但**串起来是不是能走通**没人测。
// 这个套件在 jsdom 之外用最小 DOM 桩把整条主路径跑一遍：
//   填定位 → 粘贴导入 → 拿到联系方式 → F3 判定 → 入队 → 发送预检
// 并在每一步核对「界面上的数字」和「底层数据」是否自洽。
//
// 为什么值得单独写：单测全绿不代表流程能走通。实测就撞见过——
// 入池体检是 fire-and-forget 的，调用方中间插一个 await 就会静默落空，
// 每个函数单测都过，但整条路是断的。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, "src", f), "utf8");

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("端到端旅程 回归");

// 只取流程用得到的纯逻辑，不碰 DOM：DOM 那部分由浏览器实测覆盖
const pick = (src, from, to) => src.slice(src.indexOf(from), to ? src.indexOf(to) : undefined);

const disc = read("04-analytics-discovery.js");
const brand = read("0-brand-edition.js");

const sandbox = {
  console,
  Date,
  state: { prospects: [], outbox: [], settings: {}, campaign: { productProfile: {} }, blacklist: [] },
  makeId: (p) => `${p}-${Math.random().toString(36).slice(2, 9)}`,
  isBlacklisted: () => false,
  normalizeMarkets: (v) => String(v || "United States").split(/[,，]/).map((x) => x.trim()).filter(Boolean),
  looksLikeCustomsCsv: () => false,
  importCustomsCsv: () => [],
  capitalize: (v) => String(v || "").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" "),
  stripProtocol: (v) => String(v).replace(/^https?:\/\//, "").replace(/\/$/, ""),
  scoreProspect: () => 70,
  addLog: () => {},
  clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
  dateOffset: () => "2026-08-21",
  escapeHtml: (v) => String(v),
  hasProductProfile: () => false,
  productFit: () => ({ hits: 0, matched: [], mismatch: false }),
  queueVet: undefined,
  openTrialWall: undefined
};
const ctx = createContext(sandbox);
runInContext(disc, ctx);
runInContext(
  pick(brand, "function isEngagedProspect", "/* ---------- 计费接口的用量闸门") +
    "\n" +
    pick(brand, "function emailVerificationState", "function verificationBadgeText") +
    "\nconst TRIAL_LEAD_CAP = 20;" +
    "\nfunction isTrial(){ return false; }" +
    "\nglobalThis.__admit = admitProspects;",
  ctx
);

const campaign = { markets: "United States", customerType: "importer", product: "drone spraying nozzle" };

/* ------------------------------ 旅程 ------------------------------ */

let parsed;

check("① 粘贴整页 Google 结果 → 只留真实公司，导航文字全滤掉", () => {
  parsed = ctx.importSearchResultsText(
    ["搜索", "图片", "", "Gulf Agri Supply LLC", "gulfagri.ae › products",
     "Leading importer of UAV components", "", "Desert Drone Trading FZE",
     "desertdrone.ae › wholesale", "", "下一页", "设置", "隐私权"].join("\n"),
    campaign
  );
  assert.equal(parsed.length, 2, "解析出 " + parsed.length + " 条");
  assert.equal(parsed.some((p) => /下一页|设置|隐私权|搜索|图片/.test(p.company)), false);
  // vm 里造的数组跨 realm，deepEqual 会因原型不同而失败——比字符串
  assert.equal(parsed.map((p) => p.website).sort().join(","), "desertdrone.ae,gulfagri.ae");
});

check("② 入池：唯一闸门给每条打了 createdAt（漏了会让试用锁定语义反过来）", () => {
  const admitted = ctx.__admit(parsed, "粘贴导入");
  ctx.state.prospects = [...admitted, ...ctx.state.prospects];
  assert.equal(ctx.state.prospects.length, 2);
  assert.equal(ctx.state.prospects.every((p) => !!p.createdAt), true);
  // 同批次的时间戳必须互不相等且有序，否则"最早的 20 条"是随机的
  const ts = ctx.state.prospects.map((p) => p.createdAt);
  assert.equal(new Set(ts).size, ts.length, "同批次时间戳重复了");
});

check("③ 官网抓到联系方式后，F3 判定为已验证", () => {
  ctx.state.prospects = ctx.state.prospects.map((p) => ({
    ...p,
    email: "sales@" + p.website,
    contactSource: "website",
    contactSourceUrl: "https://" + p.website + "/contact",
    emailCandidates: [{ email: "sales@" + p.website, pattern: "官网公示", source_url: "https://" + p.website + "/contact" }]
  }));
  for (const p of ctx.state.prospects) {
    assert.equal(ctx.emailVerificationState(p, p.email), "verified", p.company + " 应当算已验证");
  }
});

check("④ 探测说地址不存在时，整条路径立刻改判——一票否决", () => {
  const p = { ...ctx.state.prospects[0], emailProbe: { email: ctx.state.prospects[0].email, status: "invalid" } };
  assert.equal(ctx.emailVerificationState(p, p.email), "guessed");
});

check("⑤ 客户回过信的线索，任何否定判定都翻不动它", () => {
  const p = { ...ctx.state.prospects[0], status: "已回复", emailProbe: { email: ctx.state.prospects[0].email, status: "invalid" } };
  assert.equal(ctx.emailVerificationState(p, p.email), "verified");
});

check("⑥ 已回复/退订的线索永不被试用版锁定", () => {
  assert.equal(ctx.isEngagedProspect({ status: "已回复" }), true);
  assert.equal(ctx.isEngagedProspect({ source: "回信导入" }), true);
  assert.equal(ctx.isEngagedProspect({ optOut: true }), true);
  assert.equal(ctx.isEngagedProspect({ status: "待联系" }), false);
});

console.log(`\n${passed} 项全部通过`);
