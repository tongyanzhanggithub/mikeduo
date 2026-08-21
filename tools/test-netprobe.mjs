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
const {
  extractEmails,
  extractFacts,
  rankEmail,
  robotsAllows,
  extractSocial,
  extractPhones,
  extractWhatsappPhone,
  resolveFailCode
} = np._internals;

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

/* ---------- HAO MA CHOU QU ---------- */

check("tel: 链接与 Phone: 标签都能抽出号码", () => {
  const got = extractPhones('<a href="tel:+8613800138000">call</a> Phone: +1 (415) 555-0132');
  assert.equal(got.includes("+8613800138000"), true);
  assert.equal(got.includes("+14155550132"), true);
});

check("WhatsApp / Mob / Cell 这些标签以前全漏，现在能抽到", () => {
  const html = "WhatsApp: +86 138 0013 8001<br>Mob: +44 7700 900123<br>Cell: +1 415 555 0199";
  const got = extractPhones(html);
  assert.equal(got.includes("+8613800138001"), true, "WhatsApp label");
  assert.equal(got.includes("+447700900123"), true, "Mob label");
  assert.equal(got.includes("+14155550199"), true, "Cell label");
});

check("wa.me 链接里的数字直接当成 WhatsApp 号，并补上 +", () => {
  assert.equal(extractWhatsappPhone('<a href="https://wa.me/8613800138000">chat</a>'), "+8613800138000");
  assert.equal(
    extractWhatsappPhone('<a href="https://api.whatsapp.com/send?phone=447700900123">x</a>'),
    "+447700900123"
  );
});

check("没有 WhatsApp 入口时返回空串，不瞎猜", () => {
  assert.equal(extractWhatsappPhone("<p>Tel: +1 415 555 0132</p>"), "");
});

check("订单号那种超长数字串不会被当成电话", () => {
  const got = extractPhones("Order phone reference 123456789012345678901234");
  assert.equal(got.some((x) => x.replace(/\D/g, "").length > 15), false);
});

check("太短的数字不算电话", () => {
  assert.equal(extractPhones("Tel: 12345").length, 0);
});

/* resolveFailCode 决定一条线索会不会被入池体检判死。误判的代价是不对称的：
   放进来一家假公司只是浪费一次触达，把一家真公司判死是直接丢掉客户。
   所以这几条守的是同一件事——除非真的解析不到域名，否则不许报 ENOTFOUND。 */

check("两次尝试都解析不到，才判定域名不存在", () => {
  assert.equal(
    resolveFailCode([
      { url: "https://x.com/", ok: false, reason: "域名解析不到", code: "ENOTFOUND" },
      { url: "http://x.com/", ok: false, reason: "域名解析不到", code: "ENOTFOUND" }
    ]),
    "ENOTFOUND"
  );
});

check("robots.txt 整站封禁时请求没发出去，不能当成域名不存在", () => {
  assert.equal(resolveFailCode([]), "");
});

check("超时、403、证书问题都只是这次没抓着，不判域名死", () => {
  assert.equal(resolveFailCode([{ ok: false, reason: "超时", code: "ETIMEDOUT" }]), "ETIMEDOUT");
  assert.equal(resolveFailCode([{ ok: false, reason: "HTTP 403", code: "" }]), "");
  assert.equal(resolveFailCode([{ ok: false, reason: "HTTPS 握手失败", code: "EPROTO" }]), "EPROTO");
});

check("https 解析不到但 http 是别的错——说明域名在，只是没抓着", () => {
  assert.equal(
    resolveFailCode([
      { ok: false, reason: "域名解析不到", code: "ENOTFOUND" },
      { ok: false, reason: "超时", code: "ETIMEDOUT" }
    ]),
    "ETIMEDOUT"
  );
});

/* ------------------- 动态渲染站：抓不到 ≠ 对方没公示 ------------------- */

check("React / Next / Wix 的空壳页判为 spa", () => {
  const { detectRenderMode } = np._internals;
  const cases = [
    ['<html><body><div id="root"></div><script src=a></script><script src=b></script><script src=c></script></body></html>', "React 空壳"],
    ['<html><body><div id="__next"></div><script id="__NEXT_DATA__">{}</script></body></html>', "Next.js"],
    ['<html><head><script src="https://static.parastorage.com/x.js"></script></head><body><div id="root"></div></body></html>', "Wix"]
  ];
  for (const [html, name] of cases) {
    assert.equal(detectRenderMode(html).mode, "spa", `${name} 应判为 spa`);
  }
});

check("服务端渲染过的 React 不能被误判成空壳", () => {
  // 有框架特征但正文很足 —— 说明内容已经在 HTML 里了，照常抓即可。
  // 误判成 spa 会让我们对着一个本来抓得到的站说"我们抓不到"。
  const html =
    '<html><body><div id="root" data-reactroot><h1>Acme</h1><p>' +
    "We supply industrial pumps and spare parts to distributors worldwide. ".repeat(14) +
    "</p></div></body></html>";
  assert.equal(np._internals.detectRenderMode(html).mode, "static");
});

check("普通静态站判为 static", () => {
  const html =
    "<html><body><h1>Gulf Agri</h1><p>" +
    "We import agricultural drone components across the GCC region. ".repeat(12) +
    '</p><a href="mailto:info@gulfagri.ae">m</a></body></html>';
  assert.equal(np._internals.detectRenderMode(html).mode, "static");
});

check("正文长度统计排除 script/style，只算真正看得见的字", () => {
  const { visibleTextLength } = np._internals;
  const noisy = "<script>" + "x".repeat(5000) + "</script><style>" + "y".repeat(5000) + "</style><p>hello</p>";
  assert.equal(visibleTextLength(noisy) < 20, true, "脚本和样式被算进正文了");
});

check("harvestSite 的返回里带 renderMode——界面靠它决定说哪句话", () => {
  // 抓不到东西时，说「对方没公示」还是「我们抓不到」，对用户意义完全不同：
  // 前者会让他把好线索删掉。
  const src = readFileSync(join(root, "electron", "netprobe.js"), "utf8");
  const ret = src.slice(src.lastIndexOf("const list = [...emails"), src.length);
  assert.match(ret, /renderMode: render\.mode/);
  assert.match(ret, /renderWhy: render\.why/);
});

check("渲染层对空壳站说的是「我们抓不到」而不是「没有公示」", () => {
  const ui = readFileSync(join(root, "src", "09-netprobe.js"), "utf8");
  const branch = ui.slice(ui.indexOf('res.renderMode === "spa"'), ui.indexOf('res.renderMode === "spa"') + 900);
  assert.match(branch, /动态渲染/);
  assert.match(branch, /不代表对方没公示|不等于没有/);
  assert.match(branch, /手动打开|Hunter/);
});

/* -------------------- 电话判定：一串数字不等于电话 -------------------- */

check("日期和编号不能被当成电话号码", () => {
  // 覆盖率实测时真抓到过这两个假号码，把「拿到电话」的比例从 81.3% 虚高到 87.5%。
  // 不实测就会拿着虚高的数字去写销售页。
  const { looksLikeRealPhone } = np._internals;
  assert.equal(looksLikeRealPhone("20250909"), false, "这是日期 2025-09-09");
  assert.equal(looksLikeRealPhone("00512512"), false, "这是编号");
  assert.equal(looksLikeRealPhone("11111111"), false, "全同一个数字是占位符");
  assert.equal(looksLikeRealPhone("0000000000"), false);
  assert.equal(looksLikeRealPhone("1234567"), false, "7 位裸数字无分隔符，不可信");
});

check("真实号码的各种写法都要认——宁可漏也不能瞎认，但不能连真的都漏", () => {
  const { looksLikeRealPhone } = np._internals;
  for (const p of ["+254795555318", "+8615002096837", "+971 52 209 2367", "(011) 234-5678", "0782853853", "551141788099"]) {
    assert.equal(looksLikeRealPhone(p), true, p + " 应当被认作电话");
  }
});

/* ---------- RCPT 判定：550 不等于 550（真网实测出来的） ---------- */

check("被黑名单拦下 ≠ 地址不存在——这两个都是 550，含义完全相反", () => {
  // 真网实测拿到的两条原文：
  //   github.com → 550 5.7.1 ... Client host [x.x.x.x] blocked using Spamhaus
  //   qq.com     → 550 Mailbox not found
  // 把前者判成 invalid 会把真客户的地址拉黑，而 invalid 在 F3 里是一票否决。
  const { classifyRcpt } = np._internals;
  assert.equal(
    classifyRcpt(550, "550 5.7.1 Service unavailable, Client host [1.2.3.4] blocked using Spamhaus"),
    "blocked"
  );
  assert.equal(classifyRcpt(550, "550 Mailbox not found."), "invalid");
});

check("各种拒绝话术都要认出是「拦我们」而不是「地址不存在」", () => {
  const { classifyRcpt } = np._internals;
  for (const t of [
    "550 5.7.1 Access denied, banned sending IP",
    "451 4.7.1 Greylisting in effect",
    "421 Too many connections",
    "550 rejected due to policy reasons",
    "554 5.7.1 Service unavailable; blacklisted"
  ]) {
    assert.equal(classifyRcpt(parseInt(t, 10), t), "blocked", t);
  }
});

check("明确说不存在的才判 invalid", () => {
  const { classifyRcpt } = np._internals;
  for (const t of [
    "550 5.1.1 The email account that you tried to reach does not exist",
    "550 Mailbox unavailable",
    "550 User unknown",
    "550 5.1.0 Recipient address rejected"
  ]) {
    assert.equal(classifyRcpt(parseInt(t, 10), t), "invalid", t);
  }
});

check("看不出是哪一种就判 unknown——宁可说测不出，也不冤枉一个地址", () => {
  const { classifyRcpt } = np._internals;
  assert.equal(classifyRcpt(550, "550 Requested action not taken"), "unknown");
  assert.equal(classifyRcpt(452, "452 Insufficient storage"), "unknown");
  assert.equal(classifyRcpt(250, "250 2.1.5 OK"), "ok");
});

check("MX 查询走多解析器，且区分「确实没有」和「查不到」", () => {
  // 实测撞过：系统解析器查不到 github.com / qq.com 的 MX，被判成「收不了信」。
  // 而 invalid 在 F3 里一票否决——DNS 一抖，用户所有邮件都会被拦。
  const src = readFileSync(join(root, "electron", "netprobe.js"), "utf8");
  assert.match(src, /async function mxChecked/);
  assert.match(src, /definitelyNone/);
  const vf = src.slice(src.indexOf("async function verifyEmail"), src.indexOf("function resetProbeState"));
  assert.equal(/dns\.resolveMx/.test(vf), false, "verifyEmail 里还留着裸的系统解析器");
  assert.match(vf, /mxq\.definitelyNone && mxq\.trusted/, "必须两个条件都满足才敢判 invalid");
});

/* -------------------- 成本透明：不许悄悄改回「零配置」 -------------------- */

check("上手向导必须把「哪些免费、哪些要钱」摊开写", () => {
  // 「零配置」这个说法只对第一封信成立。粘贴搜索结果 + 抓官网 + 自己的 SMTP
  // 确实一个 key 都不用；但要跑量、要 AI 写信就得配 key。
  // 含糊过去的结果是用户走完五步之后突然撞上收费墙。
  const ui = readFileSync(join(root, "src", "09-netprobe.js"), "utf8");
  const fn = ui.slice(ui.indexOf("function costRealityHtml"), ui.indexOf("function mountFirstSendPanel"));
  assert.equal(fn.length > 200, true, "成本表被删了");
  assert.match(fn, /免费/);
  assert.match(fn, /¥14\/月/, "AI 的实际月成本必须写出来");
  assert.match(fn, /deepseek\.com/, "要给申请链接，不能只说「去配一个 key」");
  assert.match(fn, /serpapi\.com/);
});

check("必须写明没有「内置额度」，并说清为什么", () => {
  // 内置我们自己的 key 是可解包的，等于把 key 送人。这个理由要讲出来，
  // 否则用户只会觉得我们抠。
  const ui = readFileSync(join(root, "src", "09-netprobe.js"), "utf8");
  const fn = ui.slice(ui.indexOf("function costRealityHtml"), ui.indexOf("function mountFirstSendPanel"));
  assert.match(fn, /内置额度/);
  assert.match(fn, /安装包|asar|送给所有人/);
});

check("向导副标题如实说明「这五步不用 key」，不宣称整个产品零配置", () => {
  const ui = readFileSync(join(root, "src", "09-netprobe.js"), "utf8");
  const sub = ui.slice(ui.indexOf('class="firstsend-sub"'), ui.indexOf('class="firstsend-sub"') + 260);
  assert.match(sub, /这五步/, "范围必须限定在这五步，不能泛化成整个产品");
  assert.match(sub, /跑量|AI 写信/, "必须点出后面要配 key 的场景");
});

console.log(`\n${passed} 项全部通过`);
