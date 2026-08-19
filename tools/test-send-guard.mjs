// sendGuard / 试用容量 / 合规判定的单元测试
//
//   node tools/test-send-guard.mjs
//
// 直接把 src/0-brand-edition.js 放进 vm 沙箱跑真源码（不复制一份逻辑来测），
// 沙箱里补上它运行时依赖的几个全局：window / state / addLog / emailLooksVerified。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src", "0-brand-edition.js"), "utf8");

const logs = [];
const walls = [];
const sandbox = {
  console,
  window: { addEventListener() {} },
  state: { prospects: [], outbox: [], ui: {} },
  addLog: (m) => logs.push(m),
  openTrialWall: (info) => walls.push(info)
};
const ctx = createContext(sandbox);
runInContext(
  source + "\n;globalThis.__T = { TRIAL_LEAD_CAP, WARMUP_DAYS, WARMUP_DAILY_CAP, MKD_OPS, get license(){return MKD_LICENSE}, set license(v){MKD_LICENSE=v} };",
  ctx
);
const T = sandbox.__T;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("sendGuard / edition 单测");

/* ---------- 邮箱验证状态判定（F3 的判定核心） ---------- */

check("真实源(webhook)补全的邮箱算已验证", () => {
  const p = { id: "a", contactSource: "webhook", email: "buyer@acme.com" };
  assert.equal(ctx.emailVerificationState(p, p.email), "verified");
});

check("AI 推测的邮箱算未验证", () => {
  const p = { id: "b", contactSource: "claude", email: "john.doe@acme.com" };
  assert.equal(ctx.emailVerificationState(p, p.email), "guessed");
});

check("规则推测的邮箱算未验证", () => {
  const p = { id: "c", contactSource: "local", email: "info@acme.com" };
  assert.equal(ctx.emailVerificationState(p, p.email), "guessed");
});

check("客户回过信的邮箱算已验证", () => {
  const p = { id: "d", contactSource: "claude", status: "已回复", email: "ceo@acme.com" };
  assert.equal(ctx.emailVerificationState(p, p.email), "verified");
});

check("候选邮箱按 pattern 判：verified / 导入原始邮箱 放行，模式猜测拦下", () => {
  const base = { id: "f", contactSource: "claude", email: "a@acme.com" };
  const withPattern = (pattern) => ({ ...base, emailCandidates: [{ email: "a@acme.com", confidence: 90, pattern }] });
  assert.equal(ctx.emailVerificationState(withPattern("verified"), "a@acme.com"), "verified");
  assert.equal(ctx.emailVerificationState(withPattern("导入原始邮箱"), "a@acme.com"), "verified");
  assert.equal(ctx.emailVerificationState(withPattern("firstname.lastname"), "a@acme.com"), "guessed");
  assert.equal(ctx.emailVerificationState(withPattern("info@"), "a@acme.com"), "guessed");
});

check("粘贴导入/CSV 来的原始地址（无 contactSource）放行", () => {
  assert.equal(ctx.emailVerificationState({ id: "g", email: "sales@acme.com" }, "sales@acme.com"), "verified");
});

check("没有邮箱一律算未验证", () => {
  assert.equal(ctx.emailVerificationState({ id: "h", contactSource: "webhook" }, ""), "guessed");
});

check("人工核实只对被核实的那个地址生效", () => {
  const p = {
    id: "e",
    contactSource: "claude",
    email: "john@acme.com",
    manualVerified: { email: "john@acme.com", at: "2026-08-02T00:00:00Z", by: "me" }
  };
  assert.equal(ctx.emailVerificationState(p, p.email), "manual");
  // 换成另一个候选邮箱：核实记录不跟着走，仍然拦
  assert.equal(ctx.emailVerificationState(p, "sales@acme.com"), "guessed");
});

/* ---------- 试用版容量闸门（F2） ---------- */

// 造一批带 id 与入池时间的线索：锁定与否按 createdAt 先后算
const mkLeads = (n, startDay = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${startDay}-${i}`,
    createdAt: `2026-08-${String(startDay).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`
  }));

check("试用版：导入不再被截断，几百条也全部入池", () => {
  ctx.state.prospects = [];
  walls.length = 0;
  const incoming = mkLeads(300);
  assert.equal(ctx.admitProspects(incoming, "海关数据").length, 300);
});

check("试用版：超出上限的部分进锁定态并弹墙一次", () => {
  ctx.state.prospects = mkLeads(18, 1);
  walls.length = 0;
  const admitted = ctx.admitProspects(mkLeads(5, 2), "粘贴导入");
  assert.equal(admitted.length, 5); // 全进池
  assert.equal(walls.length, 1);
  assert.equal(walls[0].rejected, 3); // 3 条锁定
});

check("试用版：可联系的是最早入池的 20 条，新导入不会挤掉在跟的客户", () => {
  const old = mkLeads(20, 1); // 早
  const fresh = mkLeads(10, 9); // 晚
  ctx.state.prospects = [...fresh, ...old]; // 数组顺序是新在前，不影响判定
  const unlocked = ctx.trialUnlockedIdSet();
  assert.equal(unlocked.size, 20);
  assert.equal(
    old.every((p) => !ctx.isTrialLocked(p)),
    true
  );
  assert.equal(
    fresh.every((p) => ctx.isTrialLocked(p)),
    true
  );
});

check("锁定名额是存量：删掉可联系的，锁定的自动补位", () => {
  const old = mkLeads(20, 1);
  const fresh = mkLeads(3, 9);
  ctx.state.prospects = [...old, ...fresh];
  assert.equal(ctx.isTrialLocked(fresh[0]), true);
  // 删掉 5 条最早的 → 腾出名额，fresh 里最早的那条应自动解锁
  ctx.state.prospects = [...old.slice(5), ...fresh];
  assert.equal(ctx.isTrialLocked(fresh[0]), false);
  assert.equal(ctx.trialLockedCount(), 0);
});

// 这条钉的是一个真实翻过车的地方：五个创建路径都没写 createdAt，
// 排序静默退化成数组序（新在前），"可联系的最早 20 条"变成"最新 20 条"。
// 上一版单测因为测试数据自带 createdAt 而没抓到——这里显式测闸门会补时间戳。
check("入池闸门给没有 createdAt 的线索补上时间戳", () => {
  ctx.state.prospects = [];
  const raw = [{ id: "n1" }, { id: "n2" }, { id: "n3" }];
  ctx.admitProspects(raw, "粘贴导入");
  assert.equal(
    raw.every((p) => !!p.createdAt),
    true
  );
  // 批内先后必须稳定且互不相等，否则排序又回到数组序
  assert.equal(raw[0].createdAt < raw[1].createdAt, true);
  assert.equal(raw[1].createdAt < raw[2].createdAt, true);
});

check("已回复/回信导入的客户永不锁定", () => {
  const filler = mkLeads(30, 1);
  const replied = { id: "vip", createdAt: "2026-12-31T00:00:00Z", status: "已回复" };
  const inbound = { id: "vip2", createdAt: "2026-12-31T00:00:00Z", source: "回信导入" };
  ctx.state.prospects = [replied, inbound, ...filler];
  // 时间戳最晚、排在最前，按纯时间规则本该被锁——但它们是回过信的客户
  assert.equal(ctx.isTrialLocked(replied), false);
  assert.equal(ctx.isTrialLocked(inbound), false);
  // 且不占用可联系名额：30 条普通线索里仍有 20 条可联系
  assert.equal(filler.filter((p) => !ctx.isTrialLocked(p)).length, 20);
});

check("正式版：不限量、不锁定、不弹墙", () => {
  T.license = { activated: true, tier: "pro", tierLabel: "VIP版" };
  ctx.state.prospects = mkLeads(500);
  walls.length = 0;
  assert.equal(ctx.admitProspects(mkLeads(80, 9), "x").length, 80);
  assert.equal(walls.length, 0);
  assert.equal(ctx.trialUnlockedIdSet(), null);
  assert.equal(ctx.isTrialLocked({ id: "p9-0" }), false);
  T.license = { activated: false };
});

/* ---------- 合规（F8） ---------- */

check("欧盟市场识别：德国 / United Kingdom / 中文欧盟都命中", () => {
  assert.equal(ctx.campaignHitsEu({ markets: "Germany, Nigeria" }), true);
  assert.equal(ctx.campaignHitsEu({ markets: "United Kingdom" }), true);
  assert.equal(ctx.campaignHitsEu({ markets: "德国, 巴西" }), true);
  assert.equal(ctx.campaignHitsEu({ markets: "United States, Nigeria, Peru" }), false);
});

check("退订元素检测认得英文与中文两种写法", () => {
  assert.equal(ctx.hasUnsubscribeElement('reply with "unsubscribe"'), true);
  assert.equal(ctx.hasUnsubscribeElement("如需退订请回复"), true);
  assert.equal(ctx.hasUnsubscribeElement("Best regards, Aaron"), false);
});

check("预热期按首封已发邮件起算，满 14 天后结束", () => {
  ctx.state.outbox = [];
  assert.equal(ctx.warmupDayIndex(), 1); // 还没发过 = 第 1 天
  assert.equal(ctx.inWarmup(), true);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  ctx.state.outbox = [{ sentAt: daysAgo(3) }, { sentAt: daysAgo(9) }];
  assert.equal(ctx.warmupDayIndex(), 10); // 取最早那封
  assert.equal(ctx.inWarmup(), true);
  ctx.state.outbox = [{ sentAt: daysAgo(20) }];
  assert.equal(ctx.inWarmup(), false);
});

/* ---------- 诊断脱敏（F4） ---------- */

check("诊断日志里检索不到完整邮箱", () => {
  const masked = ctx.desensitize("联系 john.doe@acme-trading.com 确认");
  assert.equal(masked.includes("john.doe@acme-trading.com"), false);
  assert.match(masked, /j\*\*\*@a\*\*\*\.com/);
});

check("电话只留国家码与末两位", () => {
  const masked = ctx.desensitize("+86 138 0013 8000");
  assert.equal(masked.includes("13800138000"), false);
  assert.equal(masked.includes("1380013"), false);
});

check("操作环形缓冲不超过 200 条且自动脱敏", () => {
  for (let i = 0; i < 260; i += 1) ctx.pushOp("测试", `发信给 user${i}@corp.com`);
  assert.equal(T.MKD_OPS.length, 200);
  assert.equal(T.MKD_OPS.some((o) => /user\d+@corp\.com/.test(o.a)), false);
});

/* ------------- 试用版不限次的六项能力（2026-08-19 拍板，别顺手加配额） ------------- */

check("试用版对本机跑的六项能力不设配额——这是明确决定，不是遗漏", () => {
  // 官网抓取 / RCPT 验证 / 域名体检 / 合规筛查 / HS 校验 / 采购官库检索。
  // 全在本机跑、不花接口费，限制了一分钱省不下来；而它们恰恰是用户第一小时
  // 就能感受到价值的东西——我们真正的优势（拦退信、防域名被废）全是滞后显现的。
  assert.match(source, /不设任何次数限制/, "0-brand-edition.js 里的决定说明被删了");

  // 配额只该覆盖按次真金白银计费的接口
  const quota = /API_DAILY_DEFAULTS\s*=\s*\{([^}]*)\}/.exec(source);
  assert.equal(!!quota, true, "找不到 API_DAILY_DEFAULTS");
  const keys = [...quota[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["hunter", "serp"], `配额表变成了 ${keys.join("/")}，只该有按次计费的接口`);

  // 六项本机能力一个都不该有配额
  for (const name of ["harvest", "screen", "hs", "probe", "tender", "domain"]) {
    assert.equal(new RegExp(name + "DailyLimit", "i").test(source), false, name + " 被加了配额");
  }
});

console.log(`\n${passed} 项全部通过`);
