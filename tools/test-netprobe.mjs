// 网络探测与新增能力的回归测试
//
//   node tools/test-netprobe.mjs
//
// 覆盖两部分：
//   1) electron/netprobe.js 的纯函数（提取邮箱/事实/robots 判定）——直接 require
//   2) src/09-netprobe.js 与 F3 判定的联动——在 vm 沙箱里跑真源码
//
// 这里钉住的每一条，多数是开发过程中真的踩过的坑，不是补形式。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const np = require(join(root, "electron", "netprobe.js"));
const { extractEmails, extractFacts, rankEmail, robotsAllows, extractSocial } = np._internals;

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("网络探测 单测");

/* ------------------------- 主进程：联系方式提取 ------------------------- */

check("mailto / 明文 / 防爬混淆三种写法都能抓到", () => {
  const html = `
    <a href="mailto:purchasing@acme.com">buy</a>
    info@acme.com
    sales [at] acme [dot] com`;
  const got = extractEmails(html, "https://acme.com/contact").map((e) => e.email);
  assert.equal(got.includes("purchasing@acme.com"), true);
  assert.equal(got.includes("info@acme.com"), true);
  assert.equal(got.includes("sales@acme.com"), true);
});

check("采购类信箱排在销售前，销售排在 info 前", () => {
  assert.equal(rankEmail("purchasing@a.com") < rankEmail("sales@a.com"), true);
  assert.equal(rankEmail("sales@a.com") < rankEmail("info@a.com"), true);
  assert.equal(rankEmail("info@a.com") < rankEmail("john.smith@a.com"), true);
});

check("垃圾地址不进结果：noreply / 示例域名 / 被当成邮箱的图片名", () => {
  const html = "noreply@acme.com test@example.com logo@2x.png webmaster@acme.com hello@acme.com";
  const got = extractEmails(html, "u").map((e) => e.email);
  assert.deepEqual(got, ["hello@acme.com"]);
});

check("每个邮箱都带出处 URL——不能溯源的联系方式等于没有", () => {
  const got = extractEmails('<a href="mailto:a@b.com">x</a>', "https://b.com/contact");
  assert.equal(got[0].sourceUrl, "https://b.com/contact");
  assert.equal(got[0].how, "mailto");
});

check("社媒链接抓得到，且只认真实平台域名", () => {
  const s = extractSocial('<a href="https://www.linkedin.com/company/acme-ltd">x</a> wa.me/971501234567', "https://acme.com");
  assert.match(s.linkedin, /linkedin\.com\/company\/acme-ltd/);
  assert.match(s.whatsapp, /wa\.me\/971501234567/);
});

/* --------------------------- 主进程：官网事实 --------------------------- */

check("抓官网事实用于开发信个性化，且每条带出处", () => {
  const html = `
    <title>Gulf Agri Supply</title>
    <meta name="description" content="We import and distribute agricultural drone components across the GCC region." />
    <h2>Our Product Range</h2>`;
  const facts = extractFacts(html, "https://gulfagri.ae/");
  assert.equal(facts.length >= 2, true);
  assert.equal(facts.every((f) => f.sourceUrl === "https://gulfagri.ae/"), true);
  assert.equal(facts.some((f) => f.kind === "描述" && /agricultural drone components/.test(f.text)), true);
});

check("导航类小标题不当成事实（Home/About/Contact 不是业务描述）", () => {
  const facts = extractFacts("<h1>Home</h1><h2>About</h2><h3>Contact</h3>", "u");
  assert.equal(facts.length, 0);
});

/* ------------------------------ robots.txt ------------------------------ */

check("robots 整站封禁被识别，只封子路径时不误伤", () => {
  assert.equal(robotsAllows(["/"], "/contact"), false);
  assert.equal(robotsAllows(["/admin"], "/contact"), true);
  assert.equal(robotsAllows(["/admin"], "/admin/users"), false);
  assert.equal(robotsAllows([], "/anything"), true);
});

/* ------------------- 渲染层：F3 判定优先级与行为分支 ------------------- */

const sandbox = {
  console,
  state: { prospects: [], outbox: [], settings: {}, campaign: { productProfile: {} } },
  WARMUP_DAYS: 14,
  Date
};
const ctx = createContext(sandbox);

// 只取 F3 判定核心与行为分支这两段真源码
const brand = readFileSync(join(root, "src", "0-brand-edition.js"), "utf8");
const verifyFn = brand.slice(
  brand.indexOf("function emailVerificationState"),
  brand.indexOf("function verificationBadgeText")
);
const netsrc = readFileSync(join(root, "src", "09-netprobe.js"), "utf8");
const grab = (start, end) => netsrc.slice(netsrc.indexOf(start), netsrc.indexOf(end));
runInContext(
  verifyFn +
    "\n" +
    grab("const FOLLOWUP_BRANCHES", "// 连续没打开就自动暂停") +
    "\n" +
    grab("function protectedTerms", "function calibrateProspect") +
    "\nfunction trackingReady(){ return !!(state.settings.trackingBase || '').trim(); }" +
    "\nfunction prospectOpenCount(id){ return state.outbox.filter(o=>o.prospectId===id&&o.status==='已发送').reduce((n,o)=>n+(o.openCount||(o.opened?1:0)),0); }" +
    // const 声明不会挂到 vm 的全局对象上（只有函数声明会），显式导出一下
    "\nglobalThis.FOLLOWUP_BRANCHES = FOLLOWUP_BRANCHES;",
  ctx
);

const verify = (p) => ctx.emailVerificationState(p, p.email);

check("SMTP 探测「不存在」一票否决来源可信度", () => {
  // 官网公示本来算已验证，但实测这个地址收不了信——放行就是明知会退信
  assert.equal(
    verify({ email: "a@b.com", contactSource: "website", emailProbe: { email: "a@b.com", status: "invalid" } }),
    "guessed"
  );
});

check("SMTP 探测「存在」能救回推测来源", () => {
  assert.equal(
    verify({ email: "a@b.com", contactSource: "claude", emailProbe: { email: "a@b.com", status: "valid" } }),
    "verified"
  );
});

check("官网公示算已验证（企业自己写在 contact 页上的地址）", () => {
  assert.equal(verify({ email: "a@b.com", contactSource: "website" }), "verified");
});

check("客户回过信压倒一切，包括探测说不存在", () => {
  assert.equal(
    verify({ email: "a@b.com", contactSource: "claude", status: "已回复", emailProbe: { email: "a@b.com", status: "invalid" } }),
    "verified"
  );
});

check("catch-all 域名测不出时，回落到来源判定而不是当成无效", () => {
  assert.equal(
    verify({ email: "a@b.com", contactSource: "website", emailProbe: { email: "a@b.com", status: "catch-all" } }),
    "verified"
  );
});

/* ------------------------------ 行为分支 ------------------------------ */

const branchOf = (tracking, outbox, prospect = {}) => {
  ctx.state.settings.trackingBase = tracking ? "https://t.example/p" : "";
  ctx.state.prospects = [{ id: "t", company: "T", ...prospect }];
  ctx.state.outbox = outbox.map((o, i) => ({ id: "o" + i, prospectId: "t", status: "已发送", ...o }));
  const c = {
    replied: prospect.status === "已回复",
    bounced: ctx.state.outbox.some((o) => o.bounced),
    ooo: !!prospect.autoReply,
    opens: ctx.prospectOpenCount("t"),
    sent: ctx.state.outbox.length,
    tracking: ctx.trackingReady() || ctx.state.outbox.some((o) => o.openCount || o.opened)
  };
  return (ctx.FOLLOWUP_BRANCHES.find((b) => b.when(c)) || {}).key;
};

check("没配追踪时不把所有人误判成「没打开」——测不到不等于没打开", () => {
  // 这条如果错了，autoPauseColdSequences 会把每个人的序列全暂停掉
  assert.equal(branchOf(false, [{}, {}, {}, {}, {}]), "unknown");
});

check("配了追踪且确实 0 打开，才判定为冷", () => {
  assert.equal(branchOf(true, [{}, {}, {}, {}, {}]), "cold");
});

check("中继报回过打开事件时，即使没配像素也算有数据", () => {
  assert.equal(branchOf(false, [{ openCount: 4 }, {}, {}]), "hot");
});

check("打开 ≥3 次未回 = 意向最强，1-2 次 = 温", () => {
  assert.equal(branchOf(true, [{ openCount: 4 }]), "hot");
  assert.equal(branchOf(true, [{ openCount: 1 }]), "warm");
});

check("退信与已回复都立即停掉序列", () => {
  assert.equal(branchOf(true, [{ bounced: true }, {}, {}, {}]), "bounced");
  assert.equal(branchOf(true, [{ openCount: 1 }], { status: "已回复" }), "replied");
});

/* -------------------------- 定位校准的产品词保护 -------------------------- */

check("标记不对口时，绝不把用户自己的产品词加进排除词", () => {
  // 用户卖无人机配件，标了一家无人机工厂为不对口。
  // 如果 drone / quadcopter 进了排除词，下次搜索式会把所有无人机公司排掉。
  ctx.state.campaign = {
    product: "drone spraying nozzle",
    productTerms: ["drone", "UAV", "spraying nozzle"],
    productProfile: { synonyms: ["quadcopter"], englishTerm: "drone sprayer parts", excludeTerms: [] }
  };
  const got = ctx.offTargetSignals({
    company: "Shenzhen Drone Factory",
    profile: "Manufacturer and OEM supplier of drone frames and quadcopter parts"
  });
  assert.equal(got.includes("drone"), false);
  assert.equal(got.includes("quadcopter"), false);
  // 但"这是工厂不是买家"的信号要留下来
  assert.equal(got.includes("factory") || got.includes("manufacturer"), true);
});

console.log(`\n${passed} 项全部通过`);
