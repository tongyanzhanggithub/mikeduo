/* ============================================================================
 * 觅客舵 · 商业化基座（本文件按文件名排序排在 00-core 之前，先于一切初始化执行）
 *
 * 放在这里的东西有两类：
 *   ① 全局常量与纯函数——被后面所有模块调用，必须先完成初始化，否则 TDZ 崩溃；
 *   ② 全局错误捕获与操作环形缓冲——越早装上越好，装晚了就抓不到早期错误。
 * 需要 DOM / state 的一切在 08-commerce.js 里做。
 * ==========================================================================*/

/* ---------- 品牌（F9） ---------- */

const BRAND = {
  name: "觅客舵",
  en: "MiKeDuo",
  tagline: "本地 AI 获客工作台",
  version: "1.0.0",
  supportWechat: "mikeduo-support", // 发货前替换为真实客服微信号
  salesUrl: "https://example.com/mikeduo" // 桌面版会用主进程给的真实地址覆盖
};

/* ---------- 版本与试用限制（F2，所有限制逻辑集中于此） ---------- */

// 试用版线索池存量硬上限。口径是"存量"不是"累计"：删掉旧线索就能继续加。
const TRIAL_LEAD_CAP = 20;

// ── 明确决定：以下能力试用版**不设任何次数限制**（2026-08-19 拍板）──────
//
//   官网抓联系方式 / 邮箱真伪验证(RCPT) / 发信域名体检(SPF·DKIM·DMARC) /
//   合规筛查(OFAC·UFLPA·BIS) / HS 编码校验 / 公共部门采购官库检索
//
// 理由：这六样全在本机跑，一分钱接口费都不花，限制它们我们什么成本都省不下来。
// 更重要的是产品处境——我们真正的优势（拦退信、防域名被废、不编造数据）**全都是
// 滞后显现的**，用户试用时只体验到"这软件老拦着我不让发"；而劣势（要自己配 key、
// 自己找线索）第一小时就撞上。这六样恰恰是**即时能感受到价值**的东西，
// 用它们把体验前置，正好补上这个结构性短板。
//
// 唯一权衡过的是采购官库（4,433 个真实联系人，理论上有人只为拿名单而下载）：
// 但导入仍受上面 TRIAL_LEAD_CAP 约束，拿不走多少，不值得为此牺牲试用体验。
//
// **所以：以后不要"顺手"给这些加配额。** 要改先回来读这段。

const TIER_LABELS = { basic: "基础版", pro: "VIP版", coach: "陪跑版" };

// 激活信息（桌面版由主进程给出；浏览器直开时恒为未激活）
let MKD_LICENSE = { activated: false, tier: null, tierLabel: null, issuedAt: null, updateUntil: null, updateExpired: false };
let MKD_APP_INFO = null;
// 收发信凭据的安全摘要（主机/账号/配没配）。密码永远在主进程，这里拿不到。
let MKD_MAIL = { smtp: { configured: false }, imap: { configured: false } };
let MKD_MACHINE = null;

function mkdBridge() {
  return typeof window !== "undefined" && window.mkd ? window.mkd : null;
}

function isTrial() {
  return !MKD_LICENSE.activated;
}

function editionLabel() {
  return MKD_LICENSE.activated ? MKD_LICENSE.tierLabel || TIER_LABELS[MKD_LICENSE.tier] || "正式版" : "试用版";
}

/* ---------- 试用版：墙立在"联系"而不是"导入" ----------
   海关数据一导就是几百条买家。如果在入池处就截断，用户第一次导入直接撞墙，
   而那时他还没看到任何价值（邮箱没补、信没发、一个回复都没见着）。
   所以：全部让进池，超出上限的标记为锁定态，在补全/入队/发送环节才拦。
   他先看见"我找到了 300 个真实买家"，墙出现在"我想真的联系他们"那一刻。

   锁定与否是算出来的，不是存下来的——按入池先后取最早的 TRIAL_LEAD_CAP 条为可用。
   这样新导入不会把正在跟的客户挤成锁定态，删几条也自动补位，不需要任何重平衡逻辑。 */
// 已经和你有往来的客户永不锁定：回过信的人是最有价值的线索，锁掉他荒唐且伤人。
// 也不怕被刷——要产生一条这样的线索，得先有真实客户主动回信。
function isEngagedProspect(prospect) {
  return !!prospect && (prospect.status === "已回复" || prospect.source === "回信导入" || !!prospect.optOut);
}

// 排序结果做记忆化：sendGuard → isTrialLocked 会被发信队列每一行调到，
// 每次重排整个线索池的话，几百条线索 × 上百行队列就是几万次排序。
// 数组引用 + 长度作为签名：入池路径要么整体替换数组（[...新, ...旧]/map/filter），
// 要么改变长度（push/unshift/splice），两者都会让签名失效。
let mkdTrialLockCache = { arr: null, len: -1, set: null };

/* ---------- 渲染期互动索引（性能） ----------

   质量分和发信预检都要反复问同几个问题：这条线索回过信没、开过信没、
   发过没、对应的线索对象在哪。原本每问一次就 some()/find() 扫一遍全表，
   而这两个函数又是**对每条线索各调一次**的，于是就是平方级。

   实测（tools/bench-scale.mjs，只算 JS 不含排版）：
     1000 条  质量分 13ms   预检  9ms   潜客页渲染  27ms
     5000 条  质量分 394ms  预检 225ms  潜客页渲染 680ms
   数据 ×5 → 耗时 ×25，教科书式的 O(n²)。

   修法是渲染开始时把三张表各扫一遍建索引，之后每次查是 O(1)。

   关键在**生命周期**：索引只在一次同步渲染期间存在，渲染一结束立刻丢掉。
   不做长期缓存——发送会把 outbox 条目的 status 就地改成"已发送"，
   数组引用和长度都不变，任何"按引用+长度"的失效判据都会失灵，
   于是质量分会一直停在发送前的旧值。渲染期作用域没有这个问题：
   一次同步渲染中间不会有人写数据。

   不在渲染中时（depth 为 0）索引为 null，各处自动退回原来的扫表写法——
   行为完全一致，只是没有加速。 */

let mkdScanDepth = 0;
let mkdScanIndex = null;

function buildScanIndex() {
  const idx = {
    prospectById: new Map(),
    replied: new Set(), // 收到过回信
    opened: new Set(), // 邮件被打开 或 WhatsApp 被读
    sent: new Set(), // 已经真实发出去过（邮件或 WhatsApp）
    sentOutboxByProspect: new Map(), // 查重复触达用
    memo: new Map() // 渲染期通用备忘（见 renderMemo）
  };
  for (const p of state.prospects || []) if (p && p.id) idx.prospectById.set(p.id, p);
  for (const m of state.inbound || []) if (m && m.prospectId) idx.replied.add(m.prospectId);
  for (const o of state.outbox || []) {
    if (!o || !o.prospectId || o.status !== "已发送") continue;
    idx.sent.add(o.prospectId);
    if (o.opened) idx.opened.add(o.prospectId);
    const list = idx.sentOutboxByProspect.get(o.prospectId);
    if (list) list.push(o);
    else idx.sentOutboxByProspect.set(o.prospectId, [o]);
  }
  for (const w of state.whatsappQueue || []) {
    if (!w || !w.prospectId || w.status !== "已发送") continue;
    idx.sent.add(w.prospectId);
    if (w.read) idx.opened.add(w.prospectId);
  }
  return idx;
}

// 返回当前渲染期的索引；不在渲染中则返回 null（调用方退回扫表）
function scanIndex() {
  if (mkdScanDepth <= 0) return null;
  if (!mkdScanIndex) mkdScanIndex = buildScanIndex();
  return mkdScanIndex;
}

/* 渲染期备忘。

   活动线索 / 活动发信队列 / 分析口径这几个派生集合，被 86 个渲染函数反复调用，
   每次都要重新 filter 一遍全池、重新建一遍 Set。更糟的是有些是在**遍历线索的
   循环体里**调的（比如 axReplied → axInbound → activeProspectIdSet），
   于是每条线索都要把全池重建一遍——这是分析页 5000 条要 2.4 秒的主因。

   同一次渲染里这些集合不会变，算一次就够。生命周期跟索引一致：渲染结束即丢。

   注意：返回的是**共享引用**，调用方不能原地改（sort/push/splice）。
   接入前已全量扫过一遍，当前没有这种用法；新增调用方请照此约定。 */
function renderMemo(key, fn) {
  const idx = scanIndex();
  if (!idx) return fn(); // 不在渲染中：照旧现算，行为不变
  if (idx.memo.has(key)) return idx.memo.get(key);
  const value = fn();
  idx.memo.set(key, value);
  return value;
}

// 在 fn 执行期间维持一份索引。可重入：嵌套调用共用同一份，最外层退出时才丢。
function withScanIndex(fn) {
  mkdScanDepth += 1;
  try {
    return fn();
  } finally {
    mkdScanDepth -= 1;
    if (mkdScanDepth <= 0) {
      mkdScanDepth = 0;
      mkdScanIndex = null;
    }
  }
}

// 下面四个是索引与扫表的统一入口：有索引走索引，没有就按原来的方式扫。
function prospectById(id) {
  const idx = scanIndex();
  if (idx) return idx.prospectById.get(id);
  return (state.prospects || []).find((p) => p.id === id);
}

function hasRepliedInbound(prospectId) {
  const idx = scanIndex();
  if (idx) return idx.replied.has(prospectId);
  return (state.inbound || []).some((m) => m.prospectId === prospectId);
}

function hasOpenedOutbound(prospectId) {
  const idx = scanIndex();
  if (idx) return idx.opened.has(prospectId);
  return (
    (state.outbox || []).some((o) => o.prospectId === prospectId && o.status === "已发送" && o.opened) ||
    (state.whatsappQueue || []).some((w) => w.prospectId === prospectId && w.status === "已发送" && w.read)
  );
}

// 按线索归拢发信队列（**全部状态**，区别于只收"已发送"的 sentOutboxFor）。
// 到期跟进要看「这条线索名下都有哪些邮件、有没有还没发的后续」，
// 原本每条线索都 filter 一遍整个队列 → 平方级。懒建，用到才建。
function outboxFor(prospectId) {
  const idx = scanIndex();
  if (!idx) return (state.outbox || []).filter((o) => o.prospectId === prospectId);
  if (!idx.outboxByProspect) {
    const map = new Map();
    for (const o of state.outbox || []) {
      if (!o || !o.prospectId) continue;
      const list = map.get(o.prospectId);
      if (list) list.push(o);
      else map.set(o.prospectId, [o]);
    }
    idx.outboxByProspect = map;
  }
  return idx.outboxByProspect.get(prospectId) || [];
}

function sentOutboxFor(prospectId) {
  const idx = scanIndex();
  if (idx) return idx.sentOutboxByProspect.get(prospectId) || [];
  return (state.outbox || []).filter((o) => o.prospectId === prospectId && o.status === "已发送");
}



function trialUnlockedIdSet() {
  if (!isTrial()) return null; // null = 不限，全部可用
  const list = typeof state === "undefined" ? [] : state.prospects || [];
  if (mkdTrialLockCache.arr === list && mkdTrialLockCache.len === list.length) return mkdTrialLockCache.set;
  const sorted = [...list]
    .filter((p) => !isEngagedProspect(p))
    .sort((a, b) => String(a?.createdAt || "").localeCompare(String(b?.createdAt || "")));
  const set = new Set(sorted.slice(0, TRIAL_LEAD_CAP).map((p) => p?.id));
  mkdTrialLockCache = { arr: list, len: list.length, set };
  return set;
}

// 这条线索现在能不能被联系（补全/入队/发送）
function isTrialLocked(prospect, unlockedSet) {
  if (!isTrial() || !prospect) return false;
  if (isEngagedProspect(prospect)) return false;
  const set = unlockedSet || trialUnlockedIdSet();
  return set ? !set.has(prospect.id) : false;
}

function trialLockedCount() {
  if (!isTrial() || typeof state === "undefined") return 0;
  return Math.max(0, (state.prospects || []).length - TRIAL_LEAD_CAP);
}

// 所有入池路径的唯一闸门：粘贴解析 / 联网找客户 / CSV 导入 / 手动新建 / 找相似客户 /
// 竞品反查 / Agent 起量 / 回信自动建档，全部经过这里。
// 试用版不再截断，只在会产生锁定线索时提示一次。
function admitProspects(list, sourceLabel = "") {
  const incoming = Array.isArray(list) ? list : [];
  if (!incoming.length) return incoming;

  // 入池时间戳统一在这个唯一闸门上打——让各创建路径自己写必漏，
  // 而漏掉后按 createdAt 的排序会静默退化成数组序（新在前），
  // 于是"可联系的最早 20 条"变成"最新 20 条"，语义正好反过来。
  // 同批次用 now + i 保证批内先后稳定且互不相等。
  const now = Date.now();
  incoming.forEach((p, i) => {
    if (p && !p.createdAt) p.createdAt = new Date(now + i).toISOString();
  });

  // 入池体检：抓官网核实这家公司真实存在，并批量判一次对不对口。
  // 放在这个唯一闸门上，三条入池路径（联网搜索 / 直连 SerpAPI / 粘贴导入）
  // 一次覆盖。实现在 09-netprobe.js，浏览器直开时不存在，所以要判一下。
  if (typeof queueVet === "function") queueVet(incoming.map((p) => p && p.id));

  if (!isTrial()) return incoming;

  const used = typeof state === "undefined" ? 0 : (state.prospects || []).length;
  const willLock = Math.max(0, used + incoming.length - TRIAL_LEAD_CAP);
  const newlyLocked = Math.min(incoming.length, willLock);
  if (newlyLocked > 0) {
    if (typeof addLog === "function") {
      addLog(
        `${sourceLabel ? sourceLabel + "的 " : ""}${incoming.length} 条线索已全部入池。试用版可联系其中 ${TRIAL_LEAD_CAP} 条，另外 ${newlyLocked} 条锁定中——激活后立即解锁，数据一条不丢。`
      );
    }
    if (typeof openTrialWall === "function") openTrialWall({ rejected: newlyLocked, source: sourceLabel });
  }
  return incoming;
}

/* ---------- 计费接口的用量闸门 ----------
   邮件日限做得很严，但 SerpAPI / Hunter 是按次真金白银计费的，而自动驾驶与
   周期补量会在后台静默调用——用户开着托盘常驻睡一觉，可能醒来额度就烧光了。
   同一套"每日上限"的口径覆盖到花钱的接口上。 */
const API_DAILY_DEFAULTS = { serp: 50, hunter: 100 };

function apiUsageToday(name) {
  const today = new Date().toISOString().slice(0, 10);
  const u = state.apiUsage || {};
  if (u.date !== today) return 0;
  return Number(u[name]) || 0;
}

function apiDailyLimit(name) {
  const v = Number(state.settings?.[`${name}DailyLimit`]);
  return Number.isFinite(v) && v > 0 ? v : API_DAILY_DEFAULTS[name] || 50;
}

// 返回 true 表示还能调；到顶时记一条日志并返回 false
function apiQuotaOk(name, label) {
  const used = apiUsageToday(name);
  const limit = apiDailyLimit(name);
  if (used < limit) return true;
  if (typeof addLog === "function") {
    addLog(`${label} 今日调用已达上限（${used}/${limit} 次，按次计费）。明天自动重置，或到「设置 → 数据源」调整上限。`);
  }
  return false;
}

function apiUsageBump(name, n = 1) {
  const today = new Date().toISOString().slice(0, 10);
  const u = state.apiUsage || {};
  state.apiUsage = u.date === today ? { ...u, [name]: (Number(u[name]) || 0) + n } : { date: today, [name]: n };
}

/* ---------- 邮箱验证状态（F3 的判定核心） ---------- */

// 返回 "verified"（真实源/客户回过信/导入原始地址）｜ "manual"（人工核实过）｜ "guessed"（推测未验证）
//
// 注意：不能直接复用上游的 emailLooksVerified —— 它在"没有候选记录"时一律返回 true
// （假定地址是抓来的原始地址）。但 AI / 规则补全出来的邮箱恰恰是猜的，有没有候选记录
// 只取决于补全走了哪条分支。这里以 contactSource 为准，宁可多拦不可漏放。
function emailVerificationState(prospect, email) {
  if (!prospect) return "guessed";
  const target = email || prospect.email;
  if (!target) return "guessed";
  if (prospect.manualVerified && prospect.manualVerified.email === target) return "manual";
  if (prospect.status === "已回复") return "verified"; // 客户用这个地址回过信，比任何验证服务都硬

  // SMTP 探测是直接问对方服务器的结果，比任何「来源可信度」都硬，所以先判。
  // 尤其是探测说"这个地址不存在"时必须一票否决——官网上印错邮箱、写的是
  // 早就停用的地址，这些都真实发生。让来源盖过实测就等于明知会退信还放行。
  const probe = prospect.emailProbe;
  if (probe && probe.email === target) {
    if (probe.status === "invalid") return "guessed";
    if (probe.status === "valid") return "verified";
  }

  if (prospect.contactSource === "webhook") return "verified"; // 真实源（Hunter/Apollo 等）返回并验证过

  // 官网公示：企业自己写在 contact 页上给人联系的地址，可信度不低于任何第三方接口，
  // 而且我们留了 sourceUrl，随时能点开核对。这不是推测，是抄下来的。
  if (prospect.contactSource === "website") return "verified";

  const cand = (prospect.emailCandidates || []).find((c) => c.email === target);
  if (cand) return /verified|导入原始邮箱|官网公示/.test(cand.pattern || "") ? "verified" : "guessed";

  // 没有候选记录：来源是推测类就仍然当推测，其余（粘贴导入/CSV/联网抓到的原始地址）放行
  // claude / local 是**历史遗留值**：这两条产出编造联系人的路径已经删掉了，
  // 现在没有任何代码会写出这两个值。但老用户的数据里还有——升级迁移只清理了
  // 明显是拼出来的地址，contactSource 本身保留着。所以这条判断必须留着，
  // 走查工具会把它报成「读了没人写」，那是预期的，别当死代码删掉。
  return prospect.contactSource === "claude" || prospect.contactSource === "local" ? "guessed" : "verified";
}

function verificationBadgeText(stateKey) {
  return stateKey === "verified" ? "已验证" : stateKey === "manual" ? "人工核实" : "推测未验证";
}

/* ---------- 合规与限流（F8） ---------- */

// 欧盟 + 英国：GDPR / PECR 覆盖范围，命中即走强制退订与一次性提示
const EU_MARKETS =
  /austria|belgium|bulgaria|croatia|cyprus|czech|denmark|estonia|finland|france|germany|greece|hungary|ireland|italy|latvia|lithuania|luxembourg|malta|netherlands|holland|poland|portugal|romania|slovakia|slovenia|spain|sweden|united kingdom|\buk\b|britain|england|scotland|wales|europe|eu\b|欧盟|德国|法国|意大利|西班牙|荷兰|波兰|瑞典|英国/i;

function campaignHitsEu(campaign) {
  return EU_MARKETS.test(String(campaign?.markets || ""));
}

// 每封开发信必须带的退订元素（模板级注入，删掉会被预检 ⛔ 拦下）
const UNSUBSCRIBE_LINE =
  'Should you prefer not to receive further messages, kindly reply with "unsubscribe" and I will remove your details from my list.';

function hasUnsubscribeElement(body) {
  return /unsubscribe|opt[-\s]?out|退订/i.test(String(body || ""));
}

// 新域名预热：首次发信起 14 天内日发硬顶 20 封（软件卡合规底线；
// 课程教第 1 周 ≤10 封是最佳实践，两者并存不冲突）
const WARMUP_DAYS = 14;
const WARMUP_DAILY_CAP = 20;

// 预热起点 = 第一封真实发出的邮件时间。用发件记录反推而不是单独存字段，
// 换机恢复备份后进度自动跟着数据走，也不怕用户手改配置绕过。
function firstSendAt() {
  if (typeof state === "undefined") return null;
  let earliest = null;
  state.outbox.forEach((item) => {
    if (item.sentAt && (!earliest || item.sentAt < earliest)) earliest = item.sentAt;
  });
  return earliest;
}

function warmupDayIndex() {
  const first = firstSendAt();
  if (!first) return 1; // 还没发过 → 视为第 1 天
  return Math.floor((Date.now() - new Date(first).getTime()) / 86400000) + 1;
}

function inWarmup() {
  return warmupDayIndex() <= WARMUP_DAYS;
}

/* ---------- 脱敏（F4：诊断日志绝不能带完整邮箱/电话/正文） ---------- */

function maskEmail(value) {
  return String(value || "").replace(/([\w.+-])[\w.+-]*@([\w-])[\w.-]*\.(\w+)/g, "$1***@$2***.$3");
}

function maskPhone(value) {
  return String(value || "").replace(/(\+?\d{1,3})[\d\s\-()]{4,}(\d{2})/g, "$1****$2");
}

function desensitize(value) {
  return maskPhone(maskEmail(String(value == null ? "" : value)));
}

// 第一个买家回复到达时，收件箱里那一条要脉冲一次（B9 允许的两处"表演"之一）。
// 放这里是因为 02 渲染会话列表时要读它，而 02 排在 08 前面。
let mkdPulseConversationId = null;

/* ---------- 操作环形缓冲 + 全局错误捕获（F4） ---------- */

const MKD_OPS_MAX = 200;
const MKD_OPS = [];
const MKD_ERRORS = [];

function pushOp(module, action, result = "") {
  MKD_OPS.push({ t: new Date().toISOString(), m: module, a: desensitize(action), r: desensitize(result) });
  if (MKD_OPS.length > MKD_OPS_MAX) MKD_OPS.splice(0, MKD_OPS.length - MKD_OPS_MAX);
}

function pushError(scope, message, stack) {
  MKD_ERRORS.push({ t: new Date().toISOString(), scope, message: desensitize(message), stack: String(stack || "").slice(0, 4000) });
  if (MKD_ERRORS.length > 20) MKD_ERRORS.splice(0, MKD_ERRORS.length - 20);
}

// 装在最早的位置：08-commerce.js 里的 showFatalError 还没定义时也不会二次报错
window.addEventListener("error", (event) => {
  pushError("渲染进程", event.message, event.error?.stack);
  if (typeof showFatalError === "function") showFatalError(event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  pushError("未处理的 Promise", reason?.message || String(reason), reason?.stack);
  // Promise 失败多为网络/接口问题，不整页拦截，只记进诊断日志
});
