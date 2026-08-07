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

// 剩余可"联系"的线索数（不是可入池数——试用版导入不设限）。正式版无限。
function leadCapacityLeft() {
  if (!isTrial()) return Infinity;
  const used = typeof state === "undefined" ? 0 : state.prospects.length;
  return Math.max(0, TRIAL_LEAD_CAP - used);
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

window.__APP_V = "13934109";

const STORAGE_KEY = "foreign-trade-automation-v2";

// AI 服务商预设。除 Anthropic 外都走 OpenAI 兼容的 /chat/completions 协议，
// 所以 ChatGPT、DeepSeek、通义千问、Kimi、智谱 GLM 等用同一套客户端，只是地址/模型不同。
// 放在最顶部：初始化时 bindSettingsForm() 会经 applyAiProviderToForm 读它，需先于其初始化（避免 const TDZ）。
// 模型下拉里「自定义模型名…」这一项的哨兵值，选中后展开手填输入框
const AI_MODEL_CUSTOM = "__custom__";

const AI_PROVIDERS = {
  anthropic: {
    label: "Claude (Anthropic)",
    url: "https://api.anthropic.com/v1/messages",
    auth: "anthropic",
    keyHint: "sk-ant-...（用中转站则填中转站给的 Key）",
    // 模型下拉只是候选，输入框可自由填写任意模型名（中转站常有自己的别名）
    models: [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-fable-5"
    ],
    webSearch: true
  },
  openai: {
    label: "OpenAI ChatGPT",
    url: "https://api.openai.com/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3"]
  },
  deepseek: {
    label: "DeepSeek 深度求索",
    url: "https://api.deepseek.com/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["deepseek-chat", "deepseek-reasoner"]
  },
  qwen: {
    label: "通义千问 Qwen（阿里）",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"]
  },
  kimi: {
    label: "Kimi（Moonshot）",
    url: "https://api.moonshot.cn/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["kimi-k2-0711-preview", "moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"]
  },
  zhipu: {
    label: "智谱 GLM",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    auth: "bearer",
    keyHint: "xxxxx.xxxxx",
    models: ["glm-4-plus", "glm-4-air", "glm-4-airx", "glm-4-flash", "glm-4-long"]
  },
  doubao: {
    label: "豆包（字节·火山方舟）",
    url: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    auth: "bearer",
    keyHint: "火山方舟 API Key",
    // 方舟要填「推理接入点 ID」（ep-xxxx）而不是模型名，各账号不同，只能自己填
    models: []
  },
  hunyuan: {
    label: "腾讯混元",
    url: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["hunyuan-turbos-latest", "hunyuan-large", "hunyuan-standard", "hunyuan-lite"]
  },
  ernie: {
    label: "文心一言（百度千帆）",
    url: "https://qianfan.baidubce.com/v2/chat/completions",
    auth: "bearer",
    keyHint: "千帆 API Key（bce-v3/...）",
    models: ["ernie-4.5-turbo-128k", "ernie-4.0-8k", "ernie-3.5-8k", "ernie-speed-128k"]
  },
  spark: {
    label: "讯飞星火",
    url: "https://spark-api-open.xf-yun.com/v1/chat/completions",
    auth: "bearer",
    keyHint: "APIKey:APISecret（星火 HTTP 用冒号拼接）",
    models: ["4.0Ultra", "generalv3.5", "max-32k", "lite"]
  },
  minimax: {
    label: "MiniMax",
    url: "https://api.minimax.chat/v1/text/chatcompletion_v2",
    auth: "bearer",
    keyHint: "MiniMax API Key",
    models: ["MiniMax-Text-01", "abab6.5s-chat"]
  },
  stepfun: {
    label: "阶跃星辰 Step",
    url: "https://api.stepfun.com/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["step-2-16k", "step-1-8k", "step-1-flash"]
  },
  yi: {
    label: "零一万物 Yi",
    url: "https://api.lingyiwanwu.com/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["yi-lightning", "yi-large", "yi-medium"]
  },
  baichuan: {
    label: "百川 Baichuan",
    url: "https://api.baichuan-ai.com/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["Baichuan4-Turbo", "Baichuan4-Air", "Baichuan3-Turbo"]
  },
  siliconflow: {
    label: "硅基流动（一个 Key 跑多家开源模型）",
    url: "https://api.siliconflow.cn/v1/chat/completions",
    auth: "bearer",
    keyHint: "sk-...",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "THUDM/glm-4-9b-chat"]
  },
  custom: {
    label: "自定义（OpenAI 兼容）",
    url: "",
    auth: "bearer",
    keyHint: "填你的 API Key",
    models: []
  }
};

const $ = (selector) => document.querySelector(selector);

// 防抖：把连续触发（如筛选框逐字输入）合并成停顿后一次执行，避免每个字符都重建整张列表
function debounce(fn, wait = 160) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const elements = {
  navTabs: document.querySelectorAll(".nav-tab"),
  views: document.querySelectorAll(".view"),
  campaignForm: $("#campaignForm"),
  productInput: $("#productInput"),
  marketsInput: $("#marketsInput"),
  customerTypeInput: $("#customerTypeInput"),
  dailyLimitInput: $("#dailyLimitInput"),
  valuePropsInput: $("#valuePropsInput"),
  certificationsInput: $("#certificationsInput"),
  senderInput: $("#senderInput"),
  companyInput: $("#companyInput"),
  originInput: $("#originInput"),
  campaignStatus: $("#campaignStatus"),
  generatePlan: $("#generatePlan"),
  categoryPresets: $("#categoryPresets"),
  focusProductInput: $("#focusProductInput"),
  refineFocus: $("#refineFocus"),
  focusHint: $("#focusHint"),
  productDescInput: $("#productDescInput"),
  oneClickPipeline: $("#oneClickPipeline"),
  resetDemo: $("#resetDemo"),
  runAutomationTop: $("#runAutomationTop"),
  runStatusBar: $("#runStatusBar"),
  runStatusDot: $("#runStatusDot"),
  runStatusTitle: $("#runStatusTitle"),
  runStatusDetail: $("#runStatusDetail"),
  runStatusTime: $("#runStatusTime"),
  runStatusAction: $("#runStatusAction"),
  runStatusClose: $("#runStatusClose"),
  exportJson: $("#exportJson"),
  metricGrid: $("#metricGrid"),
  workflowSteps: $("#workflowSteps"),
  queryPreview: $("#queryPreview"),
  topProspects: $("#topProspects"),
  copyQueries: $("#copyQueries"),
  runDiscovery: $("#runDiscovery"),
  webSearchFind: $("#webSearchFind"),
  competitorUrl: $("#competitorUrl"),
  reverseCompetitor: $("#reverseCompetitor"),
  createProspects: $("#createProspects"),
  loadImportExample: $("#loadImportExample"),
  loadCustomsExample: $("#loadCustomsExample"),
  bulkResolveWebsites: $("#bulkResolveWebsites"),
  importSearchResults: $("#importSearchResults"),
  searchResultsInput: $("#searchResultsInput"),
  queryFilter: $("#queryFilter"),
  queryList: $("#queryList"),
  exportQueries: $("#exportQueries"),
  prospectFilter: $("#prospectFilter"),
  statusFilter: $("#statusFilter"),
  gradeFilter: $("#gradeFilter"),
  prospectSort: $("#prospectSort"),
  gradeSegments: $("#gradeSegments"),
  sourceFilter: $("#sourceFilter"),
  verifyFilter: $("#verifyFilter"),
  marketFilter: $("#marketFilter"),
  prospectVerifyBanner: $("#prospectVerifyBanner"),
  prospectBulkBar: $("#prospectBulkBar"),
  prospectDrawerOverlay: $("#prospectDrawerOverlay"),
  queueQualityLeads: $("#queueQualityLeads"),
  prospectTable: $("#prospectTable"),
  prospectDetail: $("#prospectDetail"),
  bulkEnrichContacts: $("#bulkEnrichContacts"),
  enrichProspects: $("#enrichProspects"),
  verifyProspects: $("#verifyProspects"),
  buildWhatsappProspects: $("#buildWhatsappProspects"),
  exportProspects: $("#exportProspects"),
  emailProspectSelect: $("#emailProspectSelect"),
  regenerateEmail: $("#regenerateEmail"),
  queueSequence: $("#queueSequence"),
  sequenceGrid: $("#sequenceGrid"),
  whatsappProspectSelect: $("#whatsappProspectSelect"),
  regenerateWhatsapp: $("#regenerateWhatsapp"),
  queueWhatsapp: $("#queueWhatsapp"),
  whatsappSequenceGrid: $("#whatsappSequenceGrid"),
  simulateSend: $("#simulateSend"),
  queueFollowups: $("#queueFollowups"),
  scheduleFollowups: $("#scheduleFollowups"),
  exportOutbox: $("#exportOutbox"),
  outboxList: $("#outboxList"),
  exportWhatsappQueue: $("#exportWhatsappQueue"),
  whatsappQueueList: $("#whatsappQueueList"),
  taskList: $("#taskList"),
  runLog: $("#runLog"),
  managementKpis: $("#managementKpis"),
  saveCampaignSnapshot: $("#saveCampaignSnapshot"),
  runManagementJobs: $("#runManagementJobs"),
  exportManagement: $("#exportManagement"),
  newManagedCampaign: $("#newManagedCampaign"),
  campaignManager: $("#campaignManager"),
  resetJobs: $("#resetJobs"),
  jobBoard: $("#jobBoard"),
  approveAll: $("#approveAll"),
  approvalCenter: $("#approvalCenter"),
  accountManager: $("#accountManager"),
  saveRules: $("#saveRules"),
  ruleEmailLimit: $("#ruleEmailLimit"),
  ruleWhatsappLimit: $("#ruleWhatsappLimit"),
  ruleScoreThreshold: $("#ruleScoreThreshold"),
  ruleCooldownDays: $("#ruleCooldownDays"),
  ruleRequireApproval: $("#ruleRequireApproval"),
  saveSettings: $("#saveSettings"),
  backupNow: $("#backupNow"),
  importBackup: $("#importBackup"),
  importBackupFile: $("#importBackupFile"),
  dataSafety: $("#dataSafety"),
  localMode: $("#localMode"),
  webhookMode: $("#webhookMode"),
  searchWebhook: $("#searchWebhook"),
  inboundWebhook: $("#inboundWebhook"),
  statusWebhook: $("#statusWebhook"),
  enrichWebhook: $("#enrichWebhook"),
  sendWebhook: $("#sendWebhook"),
  whatsappWebhook: $("#whatsappWebhook"),
  crmWebhook: $("#crmWebhook"),
  searchProvider: $("#searchProvider"),
  emailProvider: $("#emailProvider"),
  crmProvider: $("#crmProvider"),
  runRelay: $("#runRelay"),
  markAllRead: $("#markAllRead"),
  relayEmailToWa: $("#relayEmailToWa"),
  relayWaToEmail: $("#relayWaToEmail"),
  relayEmailDays: $("#relayEmailDays"),
  relayWaDays: $("#relayWaDays"),
  relayKpis: $("#relayKpis"),
  conversationFilter: $("#conversationFilter"),
  conversationStatusFilter: $("#conversationStatusFilter"),
  conversationList: $("#conversationList"),
  inboxTimeline: $("#inboxTimeline"),
  inboxAiPanel: $("#inboxAiPanel"),
  // 快捷回复与 AI 操作分在时间线和右侧 AI 栏两列里，事件统一委托到它们的共同父节点
  inboxLayout: $("#inboxLayout"),
  crmKpis: $("#crmKpis"),
  crmBoard: $("#crmBoard"),
  scheduleFollowupsCrm: $("#scheduleFollowupsCrm"),
  exportCrm: $("#exportCrm"),
  analyticsKpis: $("#analyticsKpis"),
  analyticsInsight: $("#analyticsInsight"),
  analyticsFunnel: $("#analyticsFunnel"),
  channelCompare: $("#channelCompare"),
  relayImpact: $("#relayImpact"),
  marketPerformance: $("#marketPerformance"),
  templateRank: $("#templateRank"),
  simulateCallbacks: $("#simulateCallbacks"),
  exportAnalytics: $("#exportAnalytics"),
  dispatchWebhooks: $("#dispatchWebhooks"),
  webhookLog: $("#webhookLog"),
  autopilotToggle: $("#autopilotToggle"),
  sendDueBtn: $("#sendDueBtn"),
  toastStack: $("#toastStack"),
  onboardingChecklist: $("#onboardingChecklist"),
  todoPanel: $("#todoPanel"),
  productManager: $("#productManager"),
  quoteManager: $("#quoteManager"),
  subjectAb: $("#subjectAb"),
  backgroundOptions: $("#backgroundOptions"),
  marketPlaybook: $("#marketPlaybook"),
  customsPanel: $("#customsPanel"),
  directMode: $("#directMode"),
  modeHint: $("#modeHint"),
  mailConfig: $("#mailConfig"),
  serpApiKeyInput: $("#serpApiKeyInput"),
  hunterApiKeyInput: $("#hunterApiKeyInput"),
  dataSourceHint: $("#dataSourceHint"),
  serpDailyLimitInput: $("#serpDailyLimitInput"),
  hunterDailyLimitInput: $("#hunterDailyLimitInput"),
  relayModeRelay: $("#relayModeRelay"),
  relayModeParallel: $("#relayModeParallel"),
  relayModeHint: $("#relayModeHint"),
  quoteOverlay: $("#quoteOverlay"),
  openQuoteBuilder: $("#openQuoteBuilder"),
  weeklyReportBtn: $("#weeklyReportBtn"),
  reportOverlay: $("#reportOverlay"),
  welcomeOverlay: $("#welcomeOverlay"),
  welcomeDemo: $("#welcomeDemo"),
  welcomeStart: $("#welcomeStart"),
  welcomeLater: $("#welcomeLater"),
  campaignSwitch: $("#campaignSwitch"),
  campaignSwitchName: $("#campaignSwitchName"),
  sidebarProjectList: $("#sidebarProjectList"),
  sidebarProjectNew: $("#sidebarProjectNew"),
  sidebarProjectManage: $("#sidebarProjectManage"),
  openPaletteBtn: $("#openPaletteBtn"),
  themeToggle: $("#themeToggle"),
  paletteOverlay: $("#paletteOverlay"),
  paletteInput: $("#paletteInput"),
  paletteResults: $("#paletteResults"),
  crmDrawerOverlay: $("#crmDrawerOverlay"),
  crmDrawer: $("#crmDrawer"),
  analyticsRange: $("#analyticsRange"),
  analyticsScope: $("#analyticsScope"),
  aiEngineStatus: $("#aiEngineStatus"),
  aiLocalMode: $("#aiLocalMode"),
  aiCloudMode: $("#aiCloudMode"),
  aiProviderSelect: $("#aiProviderSelect"),
  aiCloudRow: $("#aiCloudRow"),
  aiBaseUrlRow: $("#aiBaseUrlRow"),
  aiBaseUrlLabel: $("#aiBaseUrlLabel"),
  aiBaseUrlInput: $("#aiBaseUrlInput"),
  aiModelCustomRow: $("#aiModelCustomRow"),
  aiModelCustomInput: $("#aiModelCustomInput"),
  aiModelFetch: $("#aiModelFetch"),
  aiApiKeyInput: $("#aiApiKeyInput"),
  aiModelSelect: $("#aiModelSelect"),
  testAiEngine: $("#testAiEngine"),
  aiEngineTestStatus: $("#aiEngineTestStatus"),
  aiWriteEmail: $("#aiWriteEmail"),
  agentPromptInput: $("#agentPromptInput"),
  agentParse: $("#agentParse"),
  agentEngineTag: $("#agentEngineTag"),
  agentTaskCard: $("#agentTaskCard"),
  agentSteps: $("#agentSteps"),
  agentFunnel: $("#agentFunnel"),
  agentFunnelHint: $("#agentFunnelHint"),
  agentApprovalPanel: $("#agentApprovalPanel"),
  agentApprovalList: $("#agentApprovalList"),
  agentApproveAll: $("#agentApproveAll"),
  agentHandoff: $("#agentHandoff"),
  agentDemoData: $("#agentDemoData"),
  agentReset: $("#agentReset"),
  agentDevelopPanel: $("#agentDevelopPanel"),
  agentAutoRespond: $("#agentAutoRespond"),
  agentRespondLive: $("#agentRespondLive"),
  agentKnowledgeBase: $("#agentKnowledgeBase"),
  agentSaveKb: $("#agentSaveKb"),
  agentAutoLog: $("#agentAutoLog")
};

const WEBHOOK_CONNECTORS = {
  search: { urlKey: "searchWebhook", label: "搜索采集" },
  enrich: { urlKey: "enrichWebhook", label: "邮箱查找/验证" },
  send: { urlKey: "sendWebhook", label: "发信" },
  whatsapp: { urlKey: "whatsappWebhook", label: "WhatsApp" },
  crm: { urlKey: "crmWebhook", label: "CRM 同步" },
  inbound: { urlKey: "inboundWebhook", label: "拉取回复" },
  status: { urlKey: "statusWebhook", label: "发送状态回传" }
};

const DEAL_STAGES = ["线索", "已触达", "已回复", "询盘", "报价", "成交"];

// 客户意图识别字典，按优先级从高到低排列（拒绝优先，其次议价、样品、价格等）
const INTENTS = [
  {
    key: "reject",
    label: "拒绝 / 暂不需要",
    tone: "red",
    next: "礼貌保留，转入季度培育名单",
    keywords: ["not interested", "no thanks", "no need", "unsubscribe", "already have", "not looking", "no longer", "stop sending", "remove me"]
  },
  {
    key: "discount",
    label: "砍价 / 议价",
    tone: "amber",
    next: "了解目标价与年采购量，给出阶梯报价",
    keywords: ["discount", "cheaper", "lower price", "best price", "target price", "too expensive", "better price", "reduce the price", "price down"]
  },
  {
    key: "sample",
    label: "要样品",
    tone: "teal",
    next: "确认样品政策与收货地址，安排寄样",
    keywords: ["sample", "samples", "样品", "free sample", "send a sample", "sample policy"]
  },
  {
    key: "price",
    label: "询价 / 报价",
    tone: "blue",
    next: "发送报价单与价格区间，追问目标采购量",
    keywords: ["price", "quote", "quotation", "cost", "how much", "pricing", "fob", "price list", "catalog", "catalogue", "offer"]
  },
  {
    key: "leadtime",
    label: "交期 / 物流",
    tone: "blue",
    next: "说明生产与打样周期，确认目标到货时间",
    keywords: ["lead time", "delivery", "how long", "shipping", "when can", "dispatch", "eta", "production time"]
  },
  {
    key: "moq",
    label: "MOQ / 起订量",
    tone: "blue",
    next: "说明起订量与价格档位，争取首单",
    keywords: ["moq", "minimum order", "minimum quantity", "min order"]
  },
  {
    key: "cert",
    label: "认证 / 资质",
    tone: "blue",
    next: "提供认证与检测报告，确认目标市场合规要求",
    keywords: ["certificate", "certification", "test report", "fda", "ce", "iso", "compliance", "lfgb", "bsci", "rohs"]
  }
];

const sourceChannels = [
  "Google",
  "LinkedIn",
  "B2B Directory",
  "Customs Data",
  "Marketplace",
  "Industry Association"
];

// 模块级 UI 运行时状态（不持久化）——必须在首次 render() 前初始化，避免 TDZ 崩溃
const quickReplyDrafts = {};
const quickReplyChannels = {};
let stateNeedsInitialSave = false;

let state = loadState();

bindCampaignForm();
bindSettingsForm();
bindManagementForm();
bindInboxForm();
applyTheme();
// 首次 render() 移到文件末尾执行——render 会读取本文件后段定义的模块级 const
// （Agent/风险/意图字典等），在此处调用会因这些 const 尚未初始化而 TDZ 崩溃。

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return createDemoState();

  try {
    const parsed = JSON.parse(saved);
    return normalizeStoredState(parsed);
  } catch {
    return createDemoState();
  }
}

function normalizeStoredState(parsed) {
  if (!parsed?.campaign) return createDemoState();

  const fallback = createDemoState();
  let migrated = false;
  const merged = {
    ...fallback,
    ...parsed,
    campaign: { ...fallback.campaign, ...parsed.campaign },
    settings: { ...fallback.settings, ...parsed.settings },
    searchPlan: Array.isArray(parsed.searchPlan) ? parsed.searchPlan : fallback.searchPlan,
    prospects: Array.isArray(parsed.prospects) ? parsed.prospects : fallback.prospects,
    sequence: Array.isArray(parsed.sequence) ? parsed.sequence : fallback.sequence,
    whatsappSequence: Array.isArray(parsed.whatsappSequence)
      ? parsed.whatsappSequence
      : fallback.whatsappSequence,
    outbox: Array.isArray(parsed.outbox) ? parsed.outbox : fallback.outbox,
    whatsappQueue: Array.isArray(parsed.whatsappQueue) ? parsed.whatsappQueue : fallback.whatsappQueue,
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : fallback.tasks,
    inbound: Array.isArray(parsed.inbound) ? parsed.inbound : fallback.inbound,
    webhookLog: Array.isArray(parsed.webhookLog) ? parsed.webhookLog : fallback.webhookLog,
    selectedConversationId: parsed.selectedConversationId || fallback.selectedConversationId,
    relay: { ...fallback.relay, ...(parsed.relay || {}) },
    autopilot: { ...fallback.autopilot, ...(parsed.autopilot || {}) },
    ui: { ...fallback.ui, ...(parsed.ui || {}) },
    agent: {
      task: parsed.agent?.task || null,
      approvals: Array.isArray(parsed.agent?.approvals) ? parsed.agent.approvals : [],
      autoRespond: !!parsed.agent?.autoRespond,
      autoRespondLive: !!parsed.agent?.autoRespondLive
    },
    logs: Array.isArray(parsed.logs) ? parsed.logs : fallback.logs,
    blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : fallback.blacklist,
    products: Array.isArray(parsed.products) ? parsed.products : fallback.products,
    quotes: Array.isArray(parsed.quotes) ? parsed.quotes : fallback.quotes,
    management: parsed.management
      ? mergeManagement(fallback.management, parsed.management)
      : fallback.management
  };

  // 迁移：aiEngine 的遗留值 "claude"（多服务商之前的老写法）。
  // 以前靠 aiProviderId() 在每次读取时把它翻译成 anthropic，等于让一个陈旧的
  // 字段永久压过用户在下拉里的真实选择：选了通义也照样发去 api.anthropic.com，
  // 而且下拉每次 render 都被回写成 Claude，用户在界面上根本逃不出去。
  // 改成读档时一次性迁移：引擎归为 cloud，服务商保留用户存过的选择（没存过才落到 anthropic）。
  if (parsed.settings?.aiEngine === "claude") {
    migrated = true;
    merged.settings.aiEngine = "cloud";
    merged.settings.aiProvider = parsed.settings.aiProvider || "anthropic";
  }

  // 迁移：老数据的线索没有 createdAt（此前没有任何创建路径写它）。
  // 试用锁定按 createdAt 排序取最早的 N 条为可联系；缺了会退化成数组序，
  // 而数组是"新在前"，于是可联系的变成最新的、最早跟进的反被锁死。
  // 线索池数组本身就是可靠的先后证据：越靠后越早入池，据此倒推补一组时间戳。
  if (merged.prospects.some((p) => !p.createdAt)) {
    migrated = true;
    const base = Date.now() - merged.prospects.length * 1000;
    const last = merged.prospects.length - 1;
    merged.prospects = merged.prospects.map((p, i) =>
      p.createdAt ? p : { ...p, createdAt: new Date(base + (last - i) * 1000).toISOString() }
    );
  }

  // 迁移：老数据的线索没有 campaignId，归到当前活动，保证活动计数不落空
  const homeId = merged.activeCampaignId || merged.management.campaigns[0]?.id || null;
  if (homeId && merged.prospects.some((p) => !p.campaignId)) migrated = true;
  merged.prospects = merged.prospects.map((p) => (p.campaignId ? p : { ...p, campaignId: homeId }));

  // 迁移：v35 起 "待发送" 表示已人工批准；旧版未发送队列先回到待审批，避免升级后被误认为已批准。
  if (!parsed.ui?.sendApprovalMigrated) {
    migrated = true;
    merged.outbox = merged.outbox.map((item) =>
      item.status === "待发送" && !item.sentAt ? { ...item, status: "待审批" } : item
    );
    merged.ui.sendApprovalMigrated = true;
  }

  // 迁移：只有真实已发送记录才算已触达；修正曾经因"仅入队"被推进的 CRM 阶段。
  if (!parsed.ui?.sentOnlyStageMigrated) {
    migrated = true;
    const sentProspects = new Set([
      ...merged.outbox.filter((item) => item.status === "已发送").map((item) => item.prospectId),
      ...merged.whatsappQueue.filter((item) => item.status === "已发送").map((item) => item.prospectId)
    ]);
    const repliedProspects = new Set([
      ...merged.inbound.map((item) => item.prospectId),
      ...merged.prospects.filter((item) => item.status === "已回复").map((item) => item.id)
    ]);
    merged.prospects = merged.prospects.map((item) =>
      item.dealStage === "已触达" && !sentProspects.has(item.id) && !repliedProspects.has(item.id)
        ? { ...item, dealStage: "线索" }
        : item
    );
    merged.ui.sentOnlyStageMigrated = true;
  }

  // 迁移：清掉旧版本编造出来的联系人。
  //
  // 老代码会凭公司名和域名"补全"联系方式：从名字库拼一个人名、按 firstname.lastname
  // 拼一串邮箱、再按市场编一个电话。这些数据一条都不真——留着只会让用户拿去发错人，
  // 或者当着真实客户的面叫错名字。新版本已经不再生成，但存量数据还在本地，必须清。
  //
  // 清的口径只针对"推测来源"：contactSource 是 claude / local，或候选邮箱的 pattern
  // 标着 firstname/lastname 之类。真实源（webhook）、联网核实（claude-web）、
  // 粘贴导入的原始邮箱、客户回过信的地址，一律原样保留。
  if (!parsed.ui?.fabricatedContactsPurged) {
    const GUESSED_SOURCE = /^(claude|local)$/;
    const GUESSED_PATTERN = /first|last|name|initial|functional|department|guessed/i;
    let purged = 0;
    merged.prospects = merged.prospects.map((p) => {
      if (!p || p.status === "已回复" || p.source === "回信导入") return p;
      const guessedSource = GUESSED_SOURCE.test(p.contactSource || "");
      const cands = Array.isArray(p.emailCandidates) ? p.emailCandidates : [];
      const keep = cands.filter((c) => c && c.email && !(guessedSource && GUESSED_PATTERN.test(c.pattern || "")));
      const droppedEmails = keep.length !== cands.length;
      // 人名只在推测来源上清（真实源/联网核实拿到的名字是真的）
      const dropName = guessedSource && p.contactName && !["", "待补全", "待确认"].includes(p.contactName);
      if (!droppedEmails && !dropName) return p;
      purged += 1;
      const emailStillValid = keep.some((c) => c.email === p.email);
      return {
        ...p,
        contactName: dropName ? "" : p.contactName,
        emailCandidates: keep,
        email: emailStillValid ? p.email : keep[0]?.email || "",
        emailStatus: emailStillValid || keep.length ? p.emailStatus : "待查找",
        // 电话同理：推测来源的号码是按市场编的
        phone: guessedSource && p.phoneStatus !== "已验证" ? "" : p.phone,
        phoneStatus: guessedSource && p.phoneStatus !== "已验证" ? "待查找" : p.phoneStatus,
        contactSource: guessedSource ? "" : p.contactSource,
        status: p.status === "已入队" ? p.status : keep.length ? p.status : "待查联系人"
      };
    });
    merged.ui.fabricatedContactsPurged = true;
    migrated = true;
    if (purged) {
      merged.logs = [
        {
          id: `log-purge-${Date.now()}`,
          time: new Date().toLocaleString("zh-CN", { hour12: false }),
          message: `已清理 ${purged} 条线索上由旧版本推测生成的联系人与邮箱（那些人名和地址都是拼出来的，不真实）。这些线索现在是「待查联系人」——用 Hunter 直连、邮箱查找 Webhook 或「官网深挖联系人」去拿真实联系方式。`
        },
        ...(merged.logs || [])
      ].slice(0, 80);
    }
  }

  if (migrated) stateNeedsInitialSave = true;

  return merged;
}

function activeCampaignScopeId() {
  return state?.activeCampaignId || state?.management?.campaigns?.[0]?.id || null;
}

function isActiveCampaignProspect(prospect) {
  const cid = activeCampaignScopeId();
  if (!cid || !prospect) return true;
  return !prospect.campaignId || prospect.campaignId === cid;
}

function activeProspects() {
  return (state.prospects || []).filter(isActiveCampaignProspect);
}

function activeProspectIdSet() {
  return new Set(activeProspects().map((prospect) => prospect.id));
}

function activeOutboxItems() {
  const ids = activeProspectIdSet();
  return (state.outbox || []).filter((item) => ids.has(item.prospectId));
}

function activeWhatsappQueueItems() {
  const ids = activeProspectIdSet();
  return (state.whatsappQueue || []).filter((item) => ids.has(item.prospectId));
}

function activeInboundItems() {
  const ids = activeProspectIdSet();
  return (state.inbound || []).filter((item) => ids.has(item.prospectId));
}

function activeTasks() {
  const ids = activeProspectIdSet();
  return (state.tasks || []).filter((item) => ids.has(item.prospectId));
}

function activeAgentApprovals() {
  const ids = activeProspectIdSet();
  return (state.agent?.approvals || []).filter((item) => !item.prospectId || ids.has(item.prospectId));
}

function replaceProspectsById(updated) {
  const byId = new Map((updated || []).map((item) => [item.id, item]));
  state.prospects = state.prospects.map((item) => byId.get(item.id) || item);
  return updated;
}

function createDemoState() {
  const campaign = {
    product: "",
    markets: "",
    customerType: "",
    valueProps: "",
    certifications: "",
    senderName: "",
    companyName: "",
    originCity: "", // 你所在的城市/产地，留空则开发信里只说 China
    dailyLimit: 30,
    knowledgeBase: ""
  };
  const searchPlan = [];
  let prospects = [];
  const selectedProspectId = prospects[0]?.id || null;
  const sequence = selectedProspectId
    ? buildEmailSequence(campaign, prospects.find((item) => item.id === selectedProspectId))
    : [];
  const whatsappSequence = selectedProspectId
    ? buildWhatsappSequence(campaign, prospects.find((item) => item.id === selectedProspectId))
    : [];

  return {
    campaign,
    activeCampaignId: "campaign-demo",
    settings: {
      mode: "local",
      searchWebhook: "",
      inboundWebhook: "",
      statusWebhook: "",
      enrichWebhook: "",
      sendWebhook: "",
      whatsappWebhook: "",
      crmWebhook: "",
      searchProvider: "Google Custom Search / SerpAPI",
      emailProvider: "Hunter / Apollo / Dropcontact",
      crmProvider: "Twenty / Wukong CRM",
      webhookStatus: {},
      aiEngine: "local",
      aiProvider: "deepseek",
      aiApiKey: "",
      aiBaseUrl: "",
      aiModel: "deepseek-chat",
      // 「拉取可用模型」的结果，按服务商 id 分开存，换回来还在
      aiModelCache: {}
    },
    searchPlan,
    prospects,
    selectedProspectId,
    sequence,
    whatsappSequence,
    outbox: [],
    whatsappQueue: [],
    tasks: [],
    inbound: [],
    webhookLog: [],
    selectedConversationId: null,
    relay: {
      // relay = 接力（邮件没回才转 WhatsApp）；parallel = 协同（入队即两条一起排）
      mode: "relay",
      parallelWaDelayDays: 2, // 协同模式下 WhatsApp 比邮件晚几天——同一分钟双渠道是骚扰不是勤奋
      emailToWhatsapp: true,
      whatsappToEmail: true,
      emailNoReplyDays: 3,
      whatsappNoReplyDays: 2
    },
    autopilot: { enabled: false, intervalSec: 8 },
    ui: {
      checklistDismissed: false,
      theme: "light",
      analyticsRange: "all",
      sendApprovalMigrated: true,
      sentOnlyStageMigrated: true,
      starterTemplate: true
    },
    agent: { task: null, approvals: [], autoRespond: false },
    blacklist: [], // 持久退订黑名单：[{ email, domain, company, reason, at }]，清空线索池也不丢
    products: [], // 产品库：[{ id, model, name, moq, price, unit, packing, certs }]，喂 AI 知识 + 报价单选行
    quotes: [], // 报价单：[{ id, number, prospectId, company, items, currency, incoterm, port, validDays, total, createdAt }]
    management: createManagementState(campaign),
    logs: [{ id: makeId("log"), time: timestamp(), message: "欢迎使用觅客舵：先填写产品和目标市场，或点击一键体验跑通演示" }]
  };
}

function createManagementState(campaign) {
  const campaignName =
    campaign.product && campaign.markets
      ? `${campaign.product} · ${normalizeMarkets(campaign.markets).slice(0, 2).join(", ")}`
      : "未配置开发活动";
  return {
    campaigns: [
      {
        id: "campaign-demo",
        name: campaignName,
        // 完整配置快照：切换活动时整套恢复，避免只换产品导致卖点/品类串味
        product: campaign.product,
        markets: campaign.markets,
        customerType: campaign.customerType,
        valueProps: campaign.valueProps,
        certifications: campaign.certifications,
        owner: campaign.senderName,
        companyName: campaign.companyName,
        originCity: campaign.originCity || "",
        dailyLimit: campaign.dailyLimit,
        presetKey: campaign.presetKey || null,
        createdAt: dateOffset(0)
      }
    ],
    jobs: [
      { id: "job-search", name: "搜索采集", cadence: "点「运行待执行」或自动驾驶触发", status: "待执行", progress: 0, nextRun: "手动/自动驾驶" },
      { id: "job-enrich", name: "资料补全", cadence: "点「运行待执行」或自动驾驶触发", status: "待执行", progress: 0, nextRun: "手动/自动驾驶" },
      { id: "job-verify", name: "邮箱/号码验证", cadence: "点「运行待执行」或自动驾驶触发", status: "待执行", progress: 0, nextRun: "手动/自动驾驶" },
      { id: "job-sequence", name: "话术生成", cadence: "入队时自动生成", status: "待执行", progress: 0, nextRun: "触发后" },
      { id: "job-queue", name: "入队与限流", cadence: "点「运行待执行」或自动驾驶触发", status: "待执行", progress: 0, nextRun: "手动/自动驾驶" },
      { id: "job-crm", name: "CRM 同步", cadence: "需配置 CRM Webhook", status: "待配置", progress: 0, nextRun: "配置后" }
    ],
    rules: {
      emailDailyLimit: 80,
      whatsappDailyLimit: 30,
      scoreThreshold: 70,
      cooldownDays: 7,
      requireWhatsappApproval: true
    }
  };
}

function mergeManagement(fallback, current) {
  return {
    campaigns: Array.isArray(current.campaigns) ? current.campaigns : fallback.campaigns,
    jobs: Array.isArray(current.jobs) ? current.jobs : fallback.jobs,
    rules: { ...fallback.rules, ...(current.rules || {}) }
  };
}

let storageWriteFailed = false;

// 持久化改用防抖：把一次操作里连续多次 saveState 合并成一次写盘（整份 state 的
// JSON.stringify 在数据量大时开销明显）。为避免防抖丢数据，做了三重兜底：
//   ① maxWait：即使 saveState 被持续触发（如自动驾驶），最多攒 SAVE_MAX_WAIT 就强制落盘；
//   ② 页面隐藏/卸载时（pagehide / visibilitychange→hidden / beforeunload）同步 flush；
//   ③ flushState() 供关键路径显式立即落盘。
const SAVE_DEBOUNCE = 400;
const SAVE_MAX_WAIT = 2000;
let saveTimer = null;
let saveDirty = false;
let saveFirstPendingAt = 0;

// 立即把内存 state 同步写入 localStorage。防抖计时器与关键路径都走它。
function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveDirty = false;
  saveFirstPendingAt = 0;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageWriteFailed = false;
  } catch (error) {
    // localStorage 满（约 5MB）或被禁用：改动会丢，必须立刻让用户知道并引导备份
    if (!storageWriteFailed) {
      storageWriteFailed = true;
      addLog("⛔ 本地存储已满或不可用，最新改动没有保存！请立即点右上角「导出全部数据」备份，然后删除老线索/已发邮件释放空间");
    }
  }
}

// 防抖入口：绝大多数调用点用它，攒一小会儿再合并写盘，最长不超过 SAVE_MAX_WAIT。
function saveState() {
  const now = Date.now();
  if (!saveDirty) {
    saveDirty = true;
    saveFirstPendingAt = now;
  }
  if (saveTimer) clearTimeout(saveTimer);
  // 距首次待写已超过 maxWait 就立刻落盘，避免持续触发把写盘无限往后推
  if (now - saveFirstPendingAt >= SAVE_MAX_WAIT) {
    flushState();
    return;
  }
  saveTimer = setTimeout(flushState, SAVE_DEBOUNCE);
}

// 页面隐藏/关闭时把未落盘的改动同步写下去（localStorage.setItem 同步，能在处理器内完成）
function flushOnExit() {
  if (saveDirty) flushState();
}
window.addEventListener("pagehide", flushOnExit);
window.addEventListener("beforeunload", flushOnExit);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushOnExit();
});

/* ---------- 备份快照：抹掉所有 API Key ----------
   备份 JSON 是要给客服看、要跨机搬迁、要放网盘的。Key 混在里面等于随手外发凭据，
   而 Key 是"每台机器重填一次"的东西，本来就不该跟着数据走。
   （SMTP/IMAP 密码不在这里——它们从来没进过 state，在主进程加密存着。） */
const BACKUP_REDACTED_KEYS = ["aiApiKey", "serpApiKey", "hunterApiKey"];

function backupSnapshot() {
  const settings = { ...state.settings };
  BACKUP_REDACTED_KEYS.forEach((k) => {
    if (settings[k]) settings[k] = "";
  });
  return { ...state, settings, __keysRedacted: true };
}

function backupJson() {
  return JSON.stringify(backupSnapshot());
}

// 当前数据占用（KB）与大致上限占比，供设置页展示
function storageUsage() {
  const bytes = new Blob([JSON.stringify(state)]).size;
  const kb = Math.round(bytes / 1024);
  const pct = Math.min(100, Math.round((bytes / (5 * 1024 * 1024)) * 100));
  return { kb, pct };
}

function renderDataSafety() {
  if (!elements.dataSafety) return;
  const { kb, pct } = storageUsage();
  const slimItems = slimmableOutbox();
  const slimN = slimItems.length;
  const slimBytes = slimItems.reduce((sum, o) => sum + (o.body || "").length, 0);
  const last = state.ui?.lastBackupAt;
  const lastText = last ? `${new Date(last).toLocaleString("zh-CN", { hour12: false })}（${Math.floor((Date.now() - new Date(last).getTime()) / 86400000)} 天前）` : "从未备份";
  const overdue = !last || Date.now() - new Date(last).getTime() > 7 * 86400000;
  elements.dataSafety.innerHTML = `
    <div class="safety-row">
      <span>存储占用</span>
      <div class="job-progress"><span style="width:${pct}%;${pct > 80 ? "background:#b42318" : ""}"></span></div>
      <strong>${kb} KB / ~5 MB${pct > 80 ? " ⚠ 接近上限，建议清理老数据" : ""}</strong>
    </div>
    <div class="safety-row">
      <span>上次备份</span>
      <div></div>
      <strong class="${overdue ? "backup-overdue" : ""}">${lastText}${overdue ? " ⚠ 建议现在备份" : " ✓"}</strong>
    </div>
    <div class="safety-row">
      <span>数据规模</span>
      <div></div>
      <strong>${state.prospects.length} 线索 · ${state.outbox.length} 邮件 · ${state.blacklist?.length || 0} 黑名单</strong>
    </div>
    <div class="safety-row">
      <span>数据瘦身</span>
      <div>${slimN ? `<button class="ghost-button" data-safety="slim" type="button"><span>一键瘦身老邮件</span></button>` : ""}</div>
      <strong>${slimN ? `${slimN} 封老邮件可归档正文（约省 ${Math.max(1, Math.round(slimBytes / 1024))} KB）` : "暂无可瘦身（30 天前发出且未回复的已发邮件才会归档）"}</strong>
    </div>
  `;
}

/* ---------- 产地：用户自己的城市，不预设任何产业带 ----------
   开发信、WhatsApp、多语言开场里所有"我们在哪"都从这里取。留空退回 China，
   软件绝不替用户认领某个产业带（认领错了信就发错了）。产业带背书由用户
   自己写进「卖点」，模板不硬编码任何集群名。 */

// "Ningbo-based exporter" / 留空时 "China-based exporter"；也用于主题行 "... from X"
function originName(campaign) {
  return ((campaign && campaign.originCity) || "").trim() || "China";
}

// "Ningbo, China" / 留空或本身就填 China 时只说 "China"
function originLocation(campaign) {
  const city = ((campaign && campaign.originCity) || "").trim();
  return city && !/^china$/i.test(city) ? `${city}, China` : "China";
}

// 常用出口品类模板：一键填好整套开发活动（产品/市场/客户类型/卖点/认证）
// 卖点保持地域中立——用户套用后按自己的供应链改写即可
const CATEGORY_PRESETS = {
  moto: {
    label: "摩托车 & 配件",
    product: "motorcycle spare parts (engines, tyres, chains, brakes, electrical)",
    markets: "Nigeria, Egypt, Indonesia, Colombia, Peru",
    customerType: "importer distributor",
    valueProps:
      "OEM-grade quality, dependable volume supply, flexible MOQ with mixed-SKU container loading, and competitive FOB pricing",
    certifications: "CCC, SONCAP, ISO 9001, export packing & documents"
  },
  auto: {
    label: "汽车零部件",
    product: "automotive aftermarket parts (filters, brake pads, suspension, lighting)",
    markets: "UAE, Saudi Arabia, Russia, Mexico, Vietnam",
    customerType: "importer distributor",
    valueProps:
      "OE-standard quality, broad aftermarket coverage, consistent quality control, flexible MOQ, and prompt sampling",
    certifications: "IATF 16949, E-mark, ISO 9001, export documents"
  },
  electronics: {
    label: "笔电 & 电子",
    product: "consumer electronics & IT accessories (laptops, peripherals, adapters)",
    markets: "United States, Germany, United Arab Emirates, Brazil",
    customerType: "retailer chain buyer",
    valueProps:
      "an established electronics manufacturing base, ODM/OEM capability, CE/FCC compliance, and reliable lead times",
    certifications: "CE, FCC, RoHS, ISO 9001"
  },
  machinery: {
    label: "机械 & 装备",
    product: "general machinery & industrial equipment",
    markets: "Indonesia, Saudi Arabia, Nigeria, Brazil, Vietnam",
    customerType: "contractor project buyer",
    valueProps:
      "project-grade reliability, with spare-parts provision, after-sales support, and proper export crating",
    certifications: "CE, ISO 9001, export documents"
  }
};

function applyCampaignPreset(key) {
  const preset = CATEGORY_PRESETS[key];
  if (!preset) return;
  elements.productInput.value = preset.product;
  elements.marketsInput.value = preset.markets;
  elements.customerTypeInput.value = preset.customerType;
  elements.valuePropsInput.value = preset.valueProps;
  elements.certificationsInput.value = preset.certifications;
  readCampaignFromForm();
  state.campaign.presetKey = key; // 记住品类，开发信序列会套用该品类的专门话术
  addLog(`已套用品类模板「${preset.label}」——在下方填你的具体产品点「AI 细化定位」更准，或直接「一键起量」`);
  saveState();
  render();
}

/* ---------- 具体产品聚焦：把"泛品类"细化成一个具体零件/小设备的精准定位 ---------- */

const AI_FOCUS_SCHEMA = {
  type: "object",
  properties: {
    english_term: { type: "string", description: "该具体产品最标准的英文行业叫法（买家搜索时会用的词）" },
    synonyms: {
      type: "array",
      items: { type: "string" },
      description: "2-4 个英文同义词/行业别称/常见拼法（不含 english_term 本身）"
    },
    hs_code: { type: "string", description: "最可能的 HS 编码（6 位即可），不确定给最接近的" },
    buyer_types: { type: "string", description: "一句中文：这个具体产品真实的海外买家是谁（如：摩托车修配店供货商、砖厂设备经销商）" },
    buyer_segments: {
      type: "array",
      description: "2-4 个具体的买家细分段。每段是真实采购这个产品的一类公司。",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "该买家段的中文短名（如：摩配件批发商、三轮车组装厂配套采购）" },
          terms: {
            type: "array",
            items: { type: "string" },
            description: "2-3 个英文搜索词，用于在网上找到这一段买家（如 motorcycle spare parts wholesaler）"
          }
        },
        required: ["name", "terms"]
      }
    },
    end_use_terms: {
      type: "array",
      items: { type: "string" },
      description: "2-4 个英文『终端用途/关联品』搜索词——买家常按用途而非零件名采购（如 motorcycle repair shop supplies、engine rebuild parts）"
    },
    exclude_terms: {
      type: "array",
      items: { type: "string" },
      description: "2-4 个英文排除词：明显不是这个产品买家的类型（如纯汽车配件商、该产品的原厂品牌、只做整车的）。用于搜索取反与入池过滤。"
    },
    fit_signals: {
      type: "array",
      items: { type: "string" },
      description: "3-6 个英文信号词：如果一家公司官网/简介里出现这些，说明它很可能真采购这个产品（产品名、关联品、终端用途、目标机型等）"
    },
    keywords: { type: "array", items: { type: "string" }, description: "3-5 个用于搜索该产品买家的英文关键词" },
    value_props_addon: {
      type: "string",
      description: "一句专业、克制的英文补充卖点，针对这个具体产品（材质/精度/兼容机型/产能/标准等），正式商务书面语，不夸张、不用感叹号"
    },
    product_description: {
      type: "string",
      description: "2-3 句专业英文产品描述，适合放进开发信或报价单：说明这是什么、关键规格/材质、兼容机型或适用范围、符合的标准。正式 B2B 书面语，客观克制，不营销腔"
    }
  },
  required: ["english_term", "synonyms", "hs_code", "buyer_types", "buyer_segments", "exclude_terms", "fit_signals", "keywords", "value_props_addon", "product_description"]
};

function renderFocusHint() {
  if (!elements.focusHint) return;
  const c = state.campaign;
  if (c.productTerms?.length > 1) {
    const prof = c.productProfile || {};
    const segLine = prof.segments?.length
      ? `<br />买家段：${prof.segments.map((s) => `<code>${escapeHtml(s.name)}</code>`).join(" ")}`
      : "";
    const exLine = prof.excludeTerms?.length
      ? `<br />排除：${prof.excludeTerms.map((t) => escapeHtml(t)).join("、")}`
      : "";
    elements.focusHint.innerHTML = `已聚焦：<strong>${escapeHtml(c.product)}</strong> · 同义词 ${c.productTerms
      .slice(1)
      .map((t) => `<code>${escapeHtml(t)}</code>`)
      .join(" ")}${c.hsCode ? ` · HS <code>${escapeHtml(c.hsCode)}</code>` : ""}${
      c.buyerHint ? `<br />目标买家：${escapeHtml(c.buyerHint)}` : ""
    }${segLine}${exLine}`;
  } else if (c.focusProduct) {
    elements.focusHint.textContent = `已按原文聚焦「${c.focusProduct}」——配置 Claude 后点「AI 细化定位」可自动翻译成行业术语并扩展同义词`;
  } else {
    elements.focusHint.textContent = "";
  }
}

async function refineProductFocus() {
  readCampaignFromForm();
  const raw = (state.campaign.focusProduct || "").trim();
  if (!raw) {
    addLog("请先在「具体产品聚焦」里输入你要卖的具体零件或设备（可中文）");
    return;
  }
  if (!aiEnabled()) {
    // 无 Claude：按原文聚焦，至少让搜索式围绕这个词
    state.campaign.productTerms = [raw];
    state.campaign.product = raw;
    bindCampaignForm();
    state.searchPlan = generateSearchPlan(state.campaign);
    addLog(`已按原文聚焦「${raw}」（未配置 Claude，无法翻译/扩展同义词；建议到设置配置 AI 引擎）`);
    saveState();
    render();
    return;
  }
  addLog(`Claude 正在细化定位「${raw}」…`);
  renderLogs();
  try {
    const system =
      "你是外贸产品定位专家。用户给出一个具体产品（可能是中文的某个零件或小设备），你要围绕这个具体产品产出精细的获客定位：标准英文行业叫法、同义词、HS 编码、真实海外买家画像、把买家拆成 2-4 个具体细分段（每段给搜索词）、终端用途/关联品搜索词、要排除的非买家类型、判断一家公司是否真买这个产品的信号词、以及针对性补充卖点。全部要具体到这个产品，不要泛品类。";
    const user = `具体产品: ${raw}
所属大类: ${CATEGORY_PRESETS[state.campaign.presetKey]?.label || state.campaign.product}
目标市场: ${state.campaign.markets}`;
    const data = await callAI(system, user, AI_FOCUS_SCHEMA, 1200);
    const terms = [data.english_term, ...(data.synonyms || [])].filter(Boolean);
    state.campaign.product = data.english_term;
    state.campaign.productTerms = terms;
    state.campaign.hsCode = data.hs_code || "";
    state.campaign.buyerHint = data.buyer_types || "";
    state.campaign.productDescription = (data.product_description || "").trim(); // 专业产品描述，供开发信/报价用
    // 产品买家画像：驱动搜索式（按段+用途+排除）、联网找客户提示、以及质量分的产品契合度
    state.campaign.productProfile = {
      segments: (data.buyer_segments || []).filter((s) => s && s.name).map((s) => ({ name: s.name, terms: (s.terms || []).filter(Boolean) })),
      endUseTerms: (data.end_use_terms || []).filter(Boolean),
      excludeTerms: (data.exclude_terms || []).filter(Boolean),
      fitSignals: (data.fit_signals || []).filter(Boolean)
    };
    // 补充卖点：追加不覆盖（品类卖点仍保留）
    if (data.value_props_addon && !state.campaign.valueProps.includes(data.value_props_addon)) {
      state.campaign.valueProps = `${state.campaign.valueProps}; ${data.value_props_addon}`;
    }
    // Agent 关键词：给周期任务/联网搜索用
    if (state.agent?.task?.parsed) {
      state.agent.task.parsed.keywords = [...new Set([...(data.keywords || []), ...(state.agent.task.parsed.keywords || [])])];
    }
    bindCampaignForm();
    state.searchPlan = generateSearchPlan(state.campaign);
    const segN = state.campaign.productProfile.segments.length;
    addLog(
      `细化完成：「${raw}」→ ${data.english_term}（同义词 ${terms.length - 1} · HS ${data.hs_code} · ${segN} 个买家段 · 排除 ${state.campaign.productProfile.excludeTerms.length} 类）。搜索式已按买家段+用途重建，质量分将按产品契合度打分，可直接「一键起量」`
    );
    saveState();
    render();
  } catch (error) {
    addLog(`AI 细化定位失败：${error.message}`);
    saveState();
    render();
  }
}

// 搜索式里的产品表达：有同义词组时用 ("a" OR "b" OR "c")，否则用 "product"
function productSearchExpr(campaign) {
  const terms = (campaign.productTerms || []).filter(Boolean).slice(0, 3);
  if (terms.length > 1) return `(${terms.map((t) => `"${t}"`).join(" OR ")})`;
  return `"${(terms[0] || campaign.product).trim()}"`;
}

// 是否已经做过产品级细化（有买家画像）——决定要不要按产品契合度打分/过滤
function hasProductProfile(campaign) {
  const p = (campaign || state.campaign)?.productProfile;
  return !!(p && (p.segments?.length || p.fitSignals?.length || p.excludeTerms?.length));
}

// 一条线索的可比对文本（公司/网站/角色/信号/画像/搜索词），小写
function prospectText(prospect) {
  return [
    prospect.company,
    prospect.website,
    prospect.role,
    prospect.buyingSignal,
    prospect.searchQuery,
    prospect.companyProfile,
    prospect.fitNote,
    prospect.source
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// 产品契合度：命中产品词/同义词/买家段词/终端用途/信号词 → 正分；命中排除词 → 负（疑似不匹配）
// 返回 { hits, mismatch, matched:[...] }
function productFit(prospect, campaign = state.campaign) {
  const prof = campaign.productProfile || {};
  if (!hasProductProfile(campaign)) return { hits: 0, mismatch: false, matched: [] };
  const text = prospectText(prospect);
  const pos = [
    ...(campaign.productTerms || []),
    ...(prof.fitSignals || []),
    ...(prof.endUseTerms || []),
    ...(prof.segments || []).flatMap((s) => s.terms || [])
  ]
    .map((t) => (t || "").toLowerCase().trim())
    .filter((t) => t.length >= 3);
  const matched = [...new Set(pos.filter((t) => text.includes(t)))];
  const neg = (prof.excludeTerms || []).map((t) => (t || "").toLowerCase().trim()).filter((t) => t.length >= 3);
  const mismatch = neg.some((t) => text.includes(t)) && matched.length === 0;
  return { hits: matched.length, mismatch, matched };
}

function bindCampaignForm() {
  const campaign = state.campaign;
  if (elements.focusProductInput) elements.focusProductInput.value = campaign.focusProduct || "";
  if (elements.productDescInput) elements.productDescInput.value = campaign.productDescription || "";
  renderFocusHint();
  elements.productInput.value = campaign.product;
  elements.marketsInput.value = campaign.markets;
  elements.customerTypeInput.value = campaign.customerType;
  elements.dailyLimitInput.value = campaign.dailyLimit;
  elements.valuePropsInput.value = campaign.valueProps;
  elements.certificationsInput.value = campaign.certifications;
  elements.senderInput.value = campaign.senderName;
  elements.companyInput.value = campaign.companyName;
  if (elements.originInput) elements.originInput.value = campaign.originCity || "";
}

function bindSettingsForm() {
  const settings = state.settings;
  elements.searchWebhook.value = settings.searchWebhook;
  if (elements.inboundWebhook) elements.inboundWebhook.value = settings.inboundWebhook || "";
  if (elements.statusWebhook) elements.statusWebhook.value = settings.statusWebhook || "";
  elements.enrichWebhook.value = settings.enrichWebhook;
  elements.sendWebhook.value = settings.sendWebhook;
  elements.whatsappWebhook.value = settings.whatsappWebhook;
  elements.crmWebhook.value = settings.crmWebhook;
  elements.searchProvider.value = settings.searchProvider;
  elements.emailProvider.value = settings.emailProvider;
  elements.crmProvider.value = settings.crmProvider;
  elements.aiApiKeyInput.value = settings.aiApiKey || "";
  renderAiModelOptions();
  if (elements.aiProviderSelect) elements.aiProviderSelect.value = aiProviderId();
  if (elements.aiBaseUrlInput) elements.aiBaseUrlInput.value = settings.aiBaseUrl || "";
  if (elements.serpApiKeyInput) elements.serpApiKeyInput.value = settings.serpApiKey || "";
  if (elements.hunterApiKeyInput) elements.hunterApiKeyInput.value = settings.hunterApiKey || "";
  if (elements.serpDailyLimitInput) elements.serpDailyLimitInput.value = apiDailyLimit("serp");
  if (elements.hunterDailyLimitInput) elements.hunterDailyLimitInput.value = apiDailyLimit("hunter");
  if (elements.dataSourceHint) {
    elements.dataSourceHint.textContent = `今日已用：SerpAPI ${apiUsageToday("serp")}/${apiDailyLimit("serp")} 次 · Hunter ${apiUsageToday("hunter")}/${apiDailyLimit("hunter")} 次`;
  }
  applyAiProviderToForm();
  updateModeButtons();
}

function bindManagementForm() {
  const rules = state.management.rules;
  elements.ruleEmailLimit.value = rules.emailDailyLimit;
  elements.ruleWhatsappLimit.value = rules.whatsappDailyLimit;
  elements.ruleScoreThreshold.value = rules.scoreThreshold;
  elements.ruleCooldownDays.value = rules.cooldownDays;
  elements.ruleRequireApproval.checked = rules.requireWhatsappApproval;
}

function bindInboxForm() {
  const relay = state.relay;
  elements.relayEmailToWa.checked = relay.emailToWhatsapp;
  elements.relayWaToEmail.checked = relay.whatsappToEmail;
  elements.relayEmailDays.value = relay.emailNoReplyDays;
  elements.relayWaDays.value = relay.whatsappNoReplyDays;
}

function readInboxRulesFromForm() {
  state.relay = {
    emailToWhatsapp: elements.relayEmailToWa.checked,
    whatsappToEmail: elements.relayWaToEmail.checked,
    emailNoReplyDays: clamp(Number(elements.relayEmailDays.value) || 0, 0, 60),
    whatsappNoReplyDays: clamp(Number(elements.relayWaDays.value) || 0, 0, 60)
  };
}

function readCampaignFromForm() {
  // 具体产品聚焦：手动改了聚焦文本（没点 AI 细化）时，同义词组退回为该文本本身
  const focusText = elements.focusProductInput ? elements.focusProductInput.value.trim() : state.campaign.focusProduct || "";
  if (focusText !== (state.campaign.focusProduct || "")) {
    state.campaign.focusProduct = focusText;
    state.campaign.productTerms = focusText ? [focusText] : [];
  }
  state.campaign = {
    ...state.campaign,
    product: elements.productInput.value.trim() || "your product",
    markets: elements.marketsInput.value.trim() || "United States",
    customerType: elements.customerTypeInput.value,
    dailyLimit: clamp(Number(elements.dailyLimitInput.value) || 30, 1, 300),
    valueProps: elements.valuePropsInput.value.trim() || "consistent quality, prompt sampling, and export-standard packing",
    certifications: elements.certificationsInput.value.trim() || "standard export documents",
    senderName: elements.senderInput.value.trim() || "Your Name",
    companyName: elements.companyInput.value.trim() || "Your Company",
    // 产地留空是合法值：开发信自动退回 China-based，不替用户瞎认产业带
    originCity: elements.originInput ? elements.originInput.value.trim() : state.campaign.originCity || "",
    productDescription: elements.productDescInput ? elements.productDescInput.value.trim() : state.campaign.productDescription || ""
  };
  autoNameCampaign();
}

function campaignBriefStatus() {
  const product = (elements.productInput?.value || "").trim();
  const markets = (elements.marketsInput?.value || "").trim();
  const missing = [];
  if (!product) missing.push({ field: "product", label: "产品" });
  if (!markets) missing.push({ field: "markets", label: "目标市场" });
  return { ok: missing.length === 0, product, markets, missing };
}

// 种子活动的名字是建库时写死的「未配置开发活动」，此前没有任何代码改过它——
// 用户把产品和市场都填好了，顶栏、标题栏和分析页的口径说明却还在说「未配置」，
// 看着像是没保存成功。这里在定位齐了之后自动改成「产品 · 市场」。
// 读 campaignBriefStatus() 而不是 state.campaign，是因为后者在表单为空时会兜底
// 写入 "your product" / "United States"，拿它命名会造出一个假活动名。
function autoNameCampaign() {
  const list = state.management?.campaigns || [];
  const target = list.find((c) => c.id === state.activeCampaignId) || list[0];
  if (!target) return;
  if (target.name && target.name !== "未配置开发活动") return; // 用户自己起过名就不动
  const brief = campaignBriefStatus();
  if (!brief.ok) return;
  target.name = `${brief.product} · ${brief.markets}`;
}

function requireCampaignBrief(actionLabel = "继续") {
  const brief = campaignBriefStatus();
  if (brief.ok) return true;

  const missingText = brief.missing.map((item) => item.label).join("和");
  const message = `先填写${missingText}，再${actionLabel}。外贸开发必须先锁定产品和目标市场，否则找客户、写信和评分都会跑偏。`;
  if (typeof addLog === "function") addLog(message);
  // 前置条件没满足就直接返回的话，用户点了按钮只看到页面一跳，不知道为什么没跑起来
  runAbort(`缺${missingText}，先在控制台填好再回来`, null, actionLabel);

  if (typeof navigateTo === "function") navigateTo("dashboard");
  window.scrollTo({ top: 0, behavior: "auto" });
  setTimeout(() => {
    const target = brief.missing[0]?.field === "markets" ? elements.marketsInput : elements.productInput;
    target?.focus();
  }, 40);
  saveState();
  render();
  return false;
}

function readSettingsFromForm() {
  state.settings = {
    ...state.settings,
    searchWebhook: elements.searchWebhook.value.trim(),
    inboundWebhook: elements.inboundWebhook ? elements.inboundWebhook.value.trim() : state.settings.inboundWebhook || "",
    statusWebhook: elements.statusWebhook ? elements.statusWebhook.value.trim() : state.settings.statusWebhook || "",
    enrichWebhook: elements.enrichWebhook.value.trim(),
    sendWebhook: elements.sendWebhook.value.trim(),
    whatsappWebhook: elements.whatsappWebhook.value.trim(),
    crmWebhook: elements.crmWebhook.value.trim(),
    searchProvider: elements.searchProvider.value,
    emailProvider: elements.emailProvider.value,
    crmProvider: elements.crmProvider.value,
    aiApiKey: elements.aiApiKeyInput.value.trim(),
    aiProvider: elements.aiProviderSelect ? elements.aiProviderSelect.value : state.settings.aiProvider || "anthropic",
    aiBaseUrl: elements.aiBaseUrlInput ? elements.aiBaseUrlInput.value.trim() : state.settings.aiBaseUrl || "",
    aiModel: readAiModelFromForm(),
    serpApiKey: elements.serpApiKeyInput ? elements.serpApiKeyInput.value.trim() : state.settings.serpApiKey || "",
    hunterApiKey: elements.hunterApiKeyInput ? elements.hunterApiKeyInput.value.trim() : state.settings.hunterApiKey || "",
    serpDailyLimit: clamp(Number(elements.serpDailyLimitInput?.value) || apiDailyLimit("serp"), 1, 5000),
    hunterDailyLimit: clamp(Number(elements.hunterDailyLimitInput?.value) || apiDailyLimit("hunter"), 1, 5000)
  };
}

// 每个视图对应的渲染函数。render() 只重建当前可见视图，隐藏视图在
// navigateTo 切过去时才渲染——避免每次操作都重建全部 12 个视图的 innerHTML。
const VIEW_RENDERERS = {
  dashboard: [renderTodo, renderMetrics, renderWorkflow, renderTopProspects, renderChecklist],
  agent: [renderAgent],
  discovery: [renderMarketPlaybook, renderCustomsPanel, renderQueries],
  prospects: [renderProspects, renderProspectDetail],
  email: [renderEmailSelect, renderSequence],
  whatsapp: [renderWhatsappSelect, renderWhatsappSequence],
  inbox: [renderInbox],
  crm: [renderCrm],
  automation: [renderOutbox, renderWhatsappQueue, renderTasks, renderLogs],
  analytics: [renderAnalytics],
  management: [renderManagement, renderProducts, renderQuotes],
  settings: [renderDataSafety, renderWebhookPanel, renderMailConfig, renderBackgroundOptions]
};

function getActiveView() {
  const active = document.querySelector(".view.is-active");
  return active ? active.id.replace(/View$/, "") : "dashboard";
}

function render() {
  ensureSelection();
  // 全局元素（顶栏状态、导航徽标、模式/自动驾驶/AI 开关）——成本低且始终可见，每次都刷新
  renderStatus();
  updateModeButtons();
  updateAutopilotButton();
  updateAiEngineButtons();
  renderNavBadges();
  if (typeof renderSidebarProjects === "function") renderSidebarProjects();
  // 仅渲染当前视图
  const fns = VIEW_RENDERERS[getActiveView()];
  if (fns) fns.forEach((fn) => fn());
}

function ensureSelection() {
  const prospects = activeProspects();
  if (!prospects.length) {
    state.selectedProspectId = null;
    state.sequence = [];
    state.whatsappSequence = [];
    return;
  }

  const previousId = state.selectedProspectId;
  const exists = prospects.some((prospect) => prospect.id === state.selectedProspectId);
  if (!exists) state.selectedProspectId = prospects[0].id;
  const selected = getSelectedProspect();
  if ((!state.sequence.length || previousId !== state.selectedProspectId) && selected) {
    state.sequence = buildEmailSequence(state.campaign, selected);
  }
  if ((!state.whatsappSequence.length || previousId !== state.selectedProspectId) && selected) {
    state.whatsappSequence = buildWhatsappSequence(state.campaign, selected);
  }
}

function renderStatus() {
  const mode = state.settings.mode === "webhook" ? "Webhook 模式" : "本地模式";
  elements.campaignStatus.textContent = state.autopilot?.enabled ? `${mode} · 自动驾驶` : mode;
}

/* ---------- 运行状态条 ----------
   长任务原来只往日志里写一行，而日志面板未必在当前页面上：用户点完按钮界面毫无反应，
   几秒后又被自动切到别的视图，无从判断任务到底开始没有、在跑、跑完了还是中断了。
   这个条子挂在顶栏下方、独立于视图，四种状态始终看得见。 */

const RUN_STATUS_META = {
  running: { cls: "is-running", icon: "●", verb: "进行中" },
  done: { cls: "is-done", icon: "✓", verb: "已完成" },
  failed: { cls: "is-failed", icon: "✕", verb: "失败" },
  aborted: { cls: "is-aborted", icon: "!", verb: "已中止" }
};
// 成功的结果看一眼就够，失败/中止必须留在条上，否则用户又错过原因
const RUN_STATUS_AUTOHIDE_MS = 10000;

let runTracker = { status: "idle", name: "", step: "", startedAt: 0, endedAt: 0, action: null };
let runTickTimer = null;
let runHideTimer = null;

function runBegin(name, step = "正在开始…") {
  clearTimeout(runHideTimer);
  runTracker = { status: "running", name, step, startedAt: Date.now(), endedAt: 0, action: null };
  if (!runTickTimer) runTickTimer = setInterval(renderRunStatus, 1000);
  renderRunStatus();
}

function runStep(step) {
  if (runTracker.status !== "running") return;
  runTracker.step = step;
  renderRunStatus();
}

function runIsActive() {
  return runTracker.status === "running";
}

function runEnd(status, step, action) {
  if (runTickTimer) {
    clearInterval(runTickTimer);
    runTickTimer = null;
  }
  runTracker = { ...runTracker, status, step, endedAt: Date.now(), action: action || null };
  renderRunStatus();
  if (status === "done") {
    clearTimeout(runHideTimer);
    runHideTimer = setTimeout(runDismiss, RUN_STATUS_AUTOHIDE_MS);
  }
}

function runDone(step, action) {
  runEnd("done", step, action);
}

function runFail(reason) {
  runEnd("failed", reason);
}

// 中止 = 没跑成但不是报错（缺前置条件），所以要顺手给出补齐条件的入口。
// 前置条件在 runBegin 之前就拦下来的情况没有「进行中」可结束，这里补一个空跑记录，
// startedAt 留 0 表示没真跑过，避免显示一个没意义的耗时。
function runAbort(reason, action, name) {
  if (runTracker.status !== "running") {
    runTracker = { status: "running", name: name || runTracker.name || "任务", step: "", startedAt: 0, endedAt: 0, action: null };
  } else if (name) {
    runTracker.name = name;
  }
  runEnd("aborted", reason, action);
}

function runDismiss() {
  clearTimeout(runHideTimer);
  runTracker = { ...runTracker, status: "idle", action: null };
  renderRunStatus();
}

function runElapsedText() {
  if (!runTracker.startedAt) return "";
  const end = runTracker.endedAt || Date.now();
  const sec = Math.max(0, Math.round((end - runTracker.startedAt) / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

function renderRunStatus() {
  const bar = elements.runStatusBar;
  if (!bar) return;
  const meta = RUN_STATUS_META[runTracker.status];
  if (!meta) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.className = `run-status ${meta.cls}`;
  if (elements.runStatusDot) elements.runStatusDot.textContent = meta.icon;
  if (elements.runStatusTitle) elements.runStatusTitle.textContent = `${runTracker.name} · ${meta.verb}`;
  if (elements.runStatusDetail) elements.runStatusDetail.textContent = runTracker.step || "";
  if (elements.runStatusTime) {
    const elapsed = runElapsedText();
    elements.runStatusTime.textContent = !elapsed
      ? ""
      : runTracker.status === "running"
        ? `已用 ${elapsed}`
        : `耗时 ${elapsed}`;
  }
  if (elements.runStatusAction) {
    elements.runStatusAction.hidden = !runTracker.action;
    if (runTracker.action) elements.runStatusAction.textContent = runTracker.action.label;
  }
}

function renderMetrics() {
  const prospects = activeProspects();
  const outbox = activeOutboxItems();
  const whatsappQueue = activeWhatsappQueueItems();
  const verified = prospects.filter((item) => item.status === "邮箱有效" || item.status === "已入队").length;
  const queued = outbox.filter((item) => ["待发送", "待审批"].includes(item.status)).length;
  const sent = outbox.filter((item) => item.status === "已发送").length;
  const whatsappReady = prospects.filter((item) => item.phone && item.phoneStatus !== "待查找").length;
  const metrics = [
    ["搜索式", state.searchPlan.length, "可直接打开或接入搜索 API"],
    ["潜客", prospects.length, "当前活动的客户池"],
    ["可发信", verified, "邮箱规则验证通过"],
    ["WhatsApp", whatsappReady, "有号码可生成聊天链接"],
    ["队列", queued + sent, `${queued} 待审/待发 · ${sent} 已发送`],
    ["WA 队列", whatsappQueue.length, "待人工确认或 API 发送"]
  ];

  elements.metricGrid.innerHTML = metrics
    .map(
      ([label, value, hint]) => `
        <article class="metric-card">
          <p class="eyebrow">${label}</p>
          <strong>${value}</strong>
          <span>${hint}</span>
        </article>
      `
    )
    .join("");
}

function renderWorkflow() {
  const prospects = activeProspects();
  const outbox = activeOutboxItems();
  const whatsappQueue = activeWhatsappQueueItems();
  const tasks = activeTasks();
  const steps = [
    ["采集", state.searchPlan.length, "搜索式"],
    ["筛选", prospects.length, "潜客"],
    ["验证", prospects.filter((item) => item.emailStatus === "格式有效").length, "邮箱"],
    ["写信", state.sequence.length, "邮件"],
    ["WhatsApp", state.whatsappSequence.length, "话术"],
    ["发信", outbox.length + whatsappQueue.length, "队列"],
    ["跟进", tasks.length, "任务"]
  ];

  elements.workflowSteps.innerHTML = steps
    .map(
      ([name, count, unit], index) => `
        <div class="workflow-step ${count ? "" : "is-waiting"}">
          <span class="step-index">${index + 1}</span>
          <div>
            <strong>${name}</strong>
            <span>${count ? `${count} ${unit}` : "待运行"}</span>
          </div>
          <span class="status-pill">${count ? "完成" : "等待"}</span>
        </div>
      `
    )
    .join("");
}

function renderQueries() {
  const filter = elements.queryFilter.value.trim().toLowerCase();
  const filtered = state.searchPlan.filter((item) => {
    const text = `${item.channel} ${item.market} ${item.intent} ${item.query}`.toLowerCase();
    return !filter || text.includes(filter);
  });

  const queryHtml = filtered.length
    ? filtered.map(renderQueryItem).join("")
    : `<div class="empty-state">暂无搜索式<button class="ghost-button" data-goto="dashboard" type="button">去生成开发计划 →</button></div>`;

  elements.queryList.innerHTML = queryHtml;
  elements.queryPreview.innerHTML = state.searchPlan.length
    ? state.searchPlan.slice(0, 6).map(renderQueryItem).join("")
    : `<div class="empty-state">先生成开发计划</div>`;
}

function renderQueryItem(item) {
  return `
    <article class="query-item">
      <div class="query-main">
        <strong>${escapeHtml(item.channel)} · ${escapeHtml(item.market)} · ${escapeHtml(item.priority || "P2")}</strong>
        <code>${escapeHtml(item.query)}</code>
        <span>${escapeHtml(item.intent)} · 下一步：${escapeHtml(item.nextAction || "打开搜索并导入公司官网")}</span>
      </div>
      <a class="ghost-button" href="${item.url}" target="_blank" rel="noreferrer">
        <svg><use href="#icon-link" /></svg>
        <span>打开</span>
      </a>
    </article>
  `;
}

function renderTopProspects() {
  const top = [...activeProspects()]
    .map((item) => ({ item, lead: computeLeadScore(item) }))
    .sort((a, b) => b.lead.probability - a.lead.probability)
    .slice(0, 6);
  elements.topProspects.innerHTML = top.length
    ? top
        .map(
          ({ item, lead }) => `
            <button class="mini-prospect" data-prospect-id="${item.id}" type="button">
              <span>
                <strong>${escapeHtml(item.company)}</strong>
                <span>${escapeHtml(item.market)} · ${escapeHtml(item.source)}</span>
              </span>
              <span class="score">${lead.probability}</span>
            </button>
          `
        )
        .join("")
    : `<div class="empty-state">暂无潜客</div>`;
}

function renderProspects() {
  const prospects = activeProspects();
  const hasProspects = prospects.length > 0;
  [
    elements.queueQualityLeads,
    elements.bulkResolveWebsites,
    elements.bulkEnrichContacts,
    elements.enrichProspects,
    elements.verifyProspects,
    elements.buildWhatsappProspects,
    elements.exportProspects
  ].forEach((button) => {
    if (button) button.hidden = !hasProspects;
  });

  const filter = elements.prospectFilter.value.trim().toLowerCase();
  const status = elements.statusFilter.value;
  const gradeWanted = elements.gradeFilter?.value || "all";
  const sortBy = elements.prospectSort?.value || "quality";

  // 计算一次质量分并缓存，供筛选/排序/展示复用
  const scored = prospects.map((item, index) => ({ item, index, lead: computeLeadScore(item) }));

  // 质量分概览（全池，不受筛选影响）：让用户一眼看到有多少优质客户可入队
  const tally = { A: 0, B: 0, C: 0, D: 0 };
  scored.forEach((s) => {
    tally[s.lead.grade] += 1;
  });
  if (elements.queueQualityLeads) {
    const qty = prospects.filter(isQualityQueueable).length;
    elements.queueQualityLeads.querySelector("span").textContent = qty ? `一键入队优质客户 (${qty})` : "一键入队优质客户";
  }

  // D2 筛选栏：搜索 + 质量分分段 + 来源 + 验证状态 + 市场 + 状态
  const sourceWanted = elements.sourceFilter?.value || "all";
  const verifyWanted = elements.verifyFilter?.value || "all";
  const marketWanted = elements.marketFilter?.value || "all";
  syncMarketFilterOptions();

  const rows = scored
    .filter(({ item, lead }) => {
      const text = `${item.company} ${item.market} ${item.source} ${item.website} ${item.email}`.toLowerCase();
      const matchesFilter = !filter || text.includes(filter);
      const matchesStatus = status === "all" || item.status === status;
      const matchesGrade = gradeWanted === "all" || lead.grade === gradeWanted;
      const src = item.contactSource || "local";
      const matchesSource = sourceWanted === "all" || src === sourceWanted;
      const matchesVerify = verifyWanted === "all" || (item.email ? emailVerificationState(item, item.email) : "guessed") === verifyWanted;
      const matchesMarket = marketWanted === "all" || item.market === marketWanted;
      return matchesFilter && matchesStatus && matchesGrade && matchesSource && matchesVerify && matchesMarket;
    })
    .sort((a, b) => {
      if (sortBy === "recent") return b.index - a.index === 0 ? 0 : a.index - b.index; // 新导入的在数组前面
      if (sortBy === "market") return a.item.market.localeCompare(b.item.market) || b.lead.probability - a.lead.probability;
      return b.lead.probability - a.lead.probability; // quality: 高分在前
    });

  const summary = `<div class="grade-summary">质量分：<span class="prob-grade grade-A">A</span> ${tally.A} · <span class="prob-grade grade-B">B</span> ${tally.B} · <span class="prob-grade grade-C">C</span> ${tally.C} · <span class="prob-grade grade-D">D</span> ${tally.D}</div>`;

  renderVerifyBanner();

  if (!rows.length) {
    elements.prospectTable.innerHTML =
      `${prospects.length ? summary : ""}` +
      emptyState("users", "暂无匹配潜客", prospects.length ? "换个筛选条件，或者去搜索页再灌一批线索。" : "当前活动还没有线索。从一次搜索开始，或直接一键起量。", [
        { label: "导入线索", goto: "discovery", primary: true },
        { label: "一键起量", action: "one-click" },
        { label: "回工作台填产品", goto: "dashboard" }
      ]);
    renderProspectBulkBar();
    return;
  }

  elements.prospectTable.innerHTML = `
    ${summary}
    <div class="prospect-row header">
      <span><input type="checkbox" id="prospectSelectAll" aria-label="全选当前筛选结果" /></span>
      <span>公司</span>
      <span>市场</span>
      <span>质量分</span>
      <span>联系人</span>
      <span>验证状态</span>
      <span>操作</span>
    </div>
    ${rows
      .map(
        ({ item, lead }) => `
          <div class="prospect-row ${item.id === state.selectedProspectId ? "is-selected" : ""}" data-prospect-id="${item.id}" role="button" tabindex="0">
            <span class="pr-check"><input type="checkbox" data-prospect-check="${item.id}" ${isProspectSelected(item.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(item.company)}" /></span>
            <span>
              <span class="company-name">${escapeHtml(item.company)}</span>
              <span class="company-meta">${escapeHtml(item.website || item.websiteStatus || "无官网")} · ${escapeHtml(item.status)}</span>
            </span>
            <span>${escapeHtml(item.market)}</span>
            <span><button class="prob-grade grade-${lead.grade}" data-grade-detail="${item.id}" type="button" title="点开看这个分是怎么算出来的">${lead.grade} ${lead.probability}</button></span>
            <span class="pr-contact">
              <span class="company-meta">${escapeHtml(item.contactName || "待补全")}</span>
              ${item.contactSource ? sourceBadge(item.contactSource) : ""}
            </span>
            <span>${verifyPill(item)}</span>
            <span class="pr-actions">
              <button class="text-button" data-prospect-open="${item.id}" type="button">详情</button>
              ${
                item.status === "已入队"
                  ? `<button class="text-button" data-prospect-view-queue="${item.id}" type="button">看队列</button>`
                  : `<button class="text-button" data-prospect-queue="${item.id}" type="button">入队</button>`
              }
            </span>
          </div>
        `
      )
      .join("")}
  `;
  renderProspectBulkBar();
}


// 该市场适合走哪个渠道——把 MARKET_CHANNEL 的判定摆到台面上，
// 否则用户只会觉得"为什么这条没生成 WhatsApp"
function renderChannelFit(prospect) {
  const conf = marketChannel(prospect.market);
  if (conf.whatsapp) return `<span class="pf-badge pf-ok">邮件 + WhatsApp</span>`;
  return `<span class="pf-badge pf-warn">建议走${escapeHtml(conf.primary)}</span> ${escapeHtml(conf.note)}（手动仍可排 WhatsApp）`;
}

function renderProspectDetail() {
  const prospect = getSelectedProspect();
  if (!prospect) {
    elements.prospectDetail.innerHTML = `<div class="detail-empty">暂无潜客</div>`;
    return;
  }
  const lead = computeLeadScore(prospect);

  elements.prospectDetail.innerHTML = `
    <div class="detail-title">
      <div>
        <h3>${escapeHtml(prospect.company)}</h3>
        <span class="badge">${escapeHtml(prospect.status)}</span>
      </div>
      <span class="score">${lead.probability}</span>
    </div>
    <dl class="detail-list">
      <div>
        <dt>网站</dt>
        <dd>${
          prospect.website
            ? `<a href="https://${escapeHtml(prospect.website)}" target="_blank" rel="noreferrer">${escapeHtml(prospect.website)}</a>${
                prospect.websiteStatus && prospect.websiteStatus !== "待解析"
                  ? ` <span class="badge">${escapeHtml(prospect.websiteStatus)}</span>`
                  : ""
              }`
            : // 海关数据这类只有公司名的线索：说清现在什么状态，别渲染一个点不开的空链接
              `<span class="badge">${escapeHtml(prospect.websiteStatus || "无官网")}</span> 用「批量解析官网」补，或手动填`
        }</dd>
      </div>
      <div>
        <dt>联系人</dt>
        <dd>${escapeHtml(prospect.contactName)} · ${escapeHtml(prospect.role)}${
          prospect.contactSource ? ` ${sourceBadge(prospect.contactSource)}` : ""
        }</dd>
      </div>
      <div>
        <dt>邮箱${prospect.emailCandidates?.length > 1 ? "候选" : ""}</dt>
        <dd>${
          prospect.emailCandidates?.length
            ? prospect.emailCandidates
                .map(
                  (c, i) =>
                    `<div class="email-cand ${i === 0 ? "primary" : ""}" data-set-email="${escapeHtml(c.email)}" title="点此设为主邮箱">${escapeHtml(c.email)} <span class="cand-conf">${c.confidence}% · ${escapeHtml(c.pattern)}</span></div>`
                )
                .join("")
            : `${escapeHtml(prospect.email || "待补全")} · ${escapeHtml(prospect.emailStatus)}`
        }</dd>
      </div>
      <div>
        <dt>发信资格</dt>
        <dd>${renderSendEligibility(prospect)}</dd>
      </div>
      <div>
        <dt>WhatsApp</dt>
        <dd>${escapeHtml(prospect.phone || "待查找")} · ${escapeHtml(prospect.phoneStatus || "待查找")}</dd>
      </div>
      <div>
        <dt>该市场渠道</dt>
        <dd>${renderChannelFit(prospect)}</dd>
      </div>
      <div>
        <dt>市场与来源</dt>
        <dd>${escapeHtml(prospect.market)} · ${escapeHtml(prospect.source)}</dd>
      </div>
      <div>
        <dt>采购信号</dt>
        <dd>${escapeHtml(prospect.buyingSignal)}</dd>
      </div>
      <div>
        <dt>搜索来源</dt>
        <dd>${escapeHtml(prospect.searchQuery)}</dd>
      </div>
      <div>
        <dt>公司规模</dt>
        <dd>${escapeHtml(prospect.companySize)} · 置信度 ${prospect.confidence}%</dd>
      </div>
      ${
        prospect.companyProfile || prospect.fitNote
          ? `<div><dt>AI 画像</dt><dd>${escapeHtml(prospect.companyProfile || "")}${
              prospect.fitNote
                ? ` <strong>匹配：${escapeHtml(prospect.fitNote)}${typeof prospect.fitScore === "number" ? `（${prospect.fitScore}%）` : ""}</strong>`
                : ""
            }</dd></div>`
          : ""
      }
    </dl>
    ${renderLeadScorePanel(prospect)}
    <div class="detail-actions">
      <button class="primary-button" data-action="find-contact" type="button" title="真实源(Hunter/Apollo via Webhook)优先，否则 Claude 推测，兜底本地规则">
        <svg><use href="#icon-search" /></svg>
        <span>AI 找联系人</span>
      </button>
      <button class="ghost-button" data-action="deep-dig-contact" type="button" title="Claude 联网翻这家官网 About/Team/Contact 页，找真实决策人与邮箱（需配置 AI 引擎）">
        <svg><use href="#icon-robot" /></svg>
        <span>官网深挖联系人</span>
      </button>
      <button class="ghost-button" data-action="find-lookalike" type="button" title="以这家为样本，联网(或本地)扩展出一批相似公司进线索池">
        <svg><use href="#icon-users" /></svg>
        <span>找相似客户</span>
      </button>
      <button class="ghost-button" data-action="approve-prospect" type="button">
        <svg><use href="#icon-check" /></svg>
        <span>审核通过</span>
      </button>
      <button class="ghost-button" data-action="write-email" type="button">
        <svg><use href="#icon-mail" /></svg>
        <span>生成邮件</span>
      </button>
      <button class="ghost-button" data-action="open-whatsapp" type="button">
        <svg><use href="#icon-message" /></svg>
        <span>打开 WhatsApp</span>
      </button>
      <button class="primary-button" data-action="queue-selected" type="button">
        <svg><use href="#icon-zap" /></svg>
        <span>加入队列</span>
      </button>
      <button class="primary-button" data-action="queue-whatsapp" type="button">
        <svg><use href="#icon-message" /></svg>
        <span>加入 WA</span>
      </button>
    </div>
  `;
}

function renderLeadScorePanel(prospect) {
  const { probability, grade, factors } = computeLeadScore(prospect);
  const maxPoints = Math.max(1, ...factors.map((f) => f.points));
  const rows = factors
    .map((factor) => {
      const width = factor.points > 0 ? Math.max(8, Math.round((factor.points / maxPoints) * 100)) : 0;
      const value = factor.points > 0 ? `+${factor.points}` : factor.detail || "0";
      return `
        <div class="factor-row ${factor.tone}">
          <span class="factor-label">${escapeHtml(factor.label)}</span>
          <span class="factor-bar"><span style="width:${width}%"></span></span>
          <span class="factor-points">${escapeHtml(value)}</span>
        </div>
      `;
    })
    .join("");

  return `
    <div class="ai-score">
      <div class="ai-score-head">
        <span class="ai-badge">线索优先级</span>
        <span class="prob-grade grade-${grade}">${grade} 级</span>
      </div>
      <div class="prob-value"><strong>${probability}</strong><span>分 · 用于排序，不预测成交</span></div>
      <p class="score-disclaimer">这是按下面这些客观信号加权算出的<strong>排队顺序</strong>，不是成交概率，也不预测结果。谁先跟、谁后跟，最终由你判断。</p>
      <div class="factor-list">${rows}</div>
    </div>
  `;
}

function renderEmailSelect() {
  const prospects = activeProspects();
  const hasProspects = prospects.length > 0;
  if (elements.emailProspectSelect) elements.emailProspectSelect.disabled = !hasProspects;
  [elements.regenerateEmail, elements.queueSequence].forEach((button) => {
    if (!button) return;
    button.disabled = !hasProspects;
    button.title = hasProspects ? "" : "先导入或生成潜客，再重写开发信或加入队列";
  });
  elements.emailProspectSelect.innerHTML = prospects.length
    ? prospects
        .map(
          (item) =>
            `<option value="${item.id}" ${item.id === state.selectedProspectId ? "selected" : ""}>${escapeHtml(item.company)}</option>`
        )
        .join("")
    : `<option value="">暂无潜客</option>`;
}

function renderSequence() {
  const prospect = getSelectedProspect();
  if (!prospect) {
    elements.sequenceGrid.innerHTML = `<div class="empty-state">暂无邮件序列<button class="ghost-button" data-goto="discovery" type="button">先去导入线索 →</button></div>`;
    return;
  }

  if (!state.sequence.length) state.sequence = buildEmailSequence(state.campaign, prospect);

  elements.sequenceGrid.innerHTML = state.sequence
    .map(
      (item) => `
        <article class="panel sequence-card">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Day ${item.dayOffset}</p>
              <h2>${escapeHtml(item.label)}</h2>
            </div>
            <button class="icon-button" data-copy="${item.id}" type="button" aria-label="复制邮件" title="复制邮件">
              <svg><use href="#icon-copy" /></svg>
            </button>
          </div>
          <pre>${escapeHtml(formatEmail(item))}</pre>
        </article>
      `
    )
    .join("");
}

function renderWhatsappSelect() {
  const prospects = activeProspects();
  const hasProspects = prospects.length > 0;
  if (elements.whatsappProspectSelect) elements.whatsappProspectSelect.disabled = !hasProspects;
  [elements.regenerateWhatsapp, elements.queueWhatsapp].forEach((button) => {
    if (!button) return;
    button.disabled = !hasProspects;
    button.title = hasProspects ? "" : "先导入或生成潜客，再重写 WhatsApp 话术或加入队列";
  });
  elements.whatsappProspectSelect.innerHTML = prospects.length
    ? prospects
        .map(
          (item) =>
            `<option value="${item.id}" ${item.id === state.selectedProspectId ? "selected" : ""}>${escapeHtml(item.company)}</option>`
        )
        .join("")
    : `<option value="">暂无潜客</option>`;
}

function renderWhatsappSequence() {
  const prospect = getSelectedProspect();
  if (!prospect) {
    elements.whatsappSequenceGrid.innerHTML = `<div class="empty-state">暂无 WhatsApp 话术<button class="ghost-button" data-goto="discovery" type="button">先去导入线索 →</button></div>`;
    return;
  }

  if (!state.whatsappSequence.length) {
    state.whatsappSequence = buildWhatsappSequence(state.campaign, prospect);
  }

  elements.whatsappSequenceGrid.innerHTML = state.whatsappSequence
    .map(
      (item) => `
        <article class="panel sequence-card">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">${escapeHtml(item.stage)}</p>
              <h2>${escapeHtml(item.label)}</h2>
            </div>
            <button class="icon-button" data-copy-whatsapp="${item.id}" type="button" aria-label="复制 WhatsApp 话术" title="复制 WhatsApp 话术">
              <svg><use href="#icon-copy" /></svg>
            </button>
          </div>
          <pre>${escapeHtml(item.message)}</pre>
          <a class="ghost-button" href="${buildWhatsappUrl(prospect, item.message)}" target="_blank" rel="noreferrer">
            <svg><use href="#icon-message" /></svg>
            <span>打开聊天</span>
          </a>
        </article>
      `
    )
    .join("");
}

/* 队列顶部的一句话指路。
   带着导航红点点进来的人，看到的是一排数字和一堆卡片，没有一句话说该干什么。
   更糟的是「可发送 0」和按钮上的「批准并发送（4）」在同一行里自相矛盾——
   前者数的是"没有任何提示"的，后者数的是"能发的"（含带提示的）。
   标签已改成 无提示 / 有提示 / 被拦住，这里再直说下一步。 */
function outboxGuidanceHtml(tally, canBatchSend) {
  let text = "";
  if (tally.block && !canBatchSend) {
    text = `${tally.block} 封被拦住了：邮箱是推测的、没验证过，发出去大概率退信。先去「潜客」批量验证，通过了才会放行。`;
  } else if (tally.block) {
    text = `${canBatchSend} 封可以批准发送；另有 ${tally.block} 封被拦住（邮箱没验证过），先去「潜客」批量验证。`;
  } else if (tally.warn && !tally.ok) {
    text = `${tally.warn} 封都带提示——提示不拦发送，但每条都指出了一个会拉低送达率的写法。点「预览」逐封看并改掉，或直接批准发送。`;
  } else if (tally.warn) {
    text = `${tally.ok} 封没有任何问题，另 ${tally.warn} 封带提示（能发，但建议先按提示改写）。`;
  } else if (tally.ok) {
    text = `${tally.ok} 封已通过全部预检，逐封过目后点「批准并发送」。发送始终等你点最后一下。`;
  }
  return text ? `<p class="outbox-guidance">${escapeHtml(text)}</p>` : "";
}

function renderOutbox() {
  if (elements.queueFollowups) {
    const dueN = dueFollowupProspects().length;
    elements.queueFollowups.querySelector("span").textContent = dueN ? `一键批量跟进 (${dueN})` : "一键批量跟进";
  }
  const outbox = activeOutboxItems();
  const hasOutbox = outbox.length > 0;
  [elements.simulateSend, elements.sendDueBtn, elements.queueFollowups, elements.scheduleFollowups].forEach((button) => {
    if (button) button.hidden = !hasOutbox;
  });
  if (!outbox.length) {
    elements.outboxList.innerHTML = emptyState("mail", "当前活动的发信队列还是空的", "先去潜客队列挑几家勾上，点「一键入队」——草稿会生成到这里，发不发还是你点最后一下。", [
      { label: "去挑选潜客", goto: "prospects", primary: true },
      { label: "一键起量", action: "one-click" }
    ]);
    return;
  }

  const all = [...outbox].sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
  const actionable = all.filter((i) => ["待审批", "待发送"].includes(i.status));

  // 预检三色汇总：一眼看到堵在哪，点数字即筛选（D3）
  const tally = { ok: 0, warn: 0, block: 0 };
  const kindOf = (item) => {
    const pf = preflightOutboxItem(item);
    return pf.blockers.length ? "block" : pf.warnings.length ? "warn" : "ok";
  };
  actionable.forEach((i) => {
    tally[kindOf(i)] += 1;
  });
  const canBatchSend = tally.ok + tally.warn;
  const blockedOnly = actionable.length > 0 && canBatchSend === 0 && tally.block > 0;
  const hasApprovedSendable = all.some((item) => item.status === "待发送" && preflightOutboxItem(item).ok);
  const hasDueApprovedSendable = all.some((item) => item.status === "待发送" && item.dueDate <= dateOffset(0) && preflightOutboxItem(item).ok);
  if (elements.simulateSend) elements.simulateSend.disabled = !hasApprovedSendable;
  if (elements.sendDueBtn) elements.sendDueBtn.disabled = !hasDueApprovedSendable;

  const filter = state.ui?.outboxFilter || "all";
  const items = filter === "all" ? all : actionable.filter((i) => kindOf(i) === filter);

  const seg = (key, icon, label, count, cls) =>
    `<button class="pf-seg ${cls} ${filter === key ? "is-on" : ""}" data-outbox-filter="${key}" type="button" ${count ? "" : "disabled"}>
       <span class="pf-seg-icon">${icon}</span><b>${count}</b><span>${label}</span>
     </button>`;

  const strip = actionable.length
    ? `<div class="outbox-controls">
        ${outboxGuidanceHtml(tally, canBatchSend)}
        <label class="outbox-check-all"><input type="checkbox" id="outboxSelectAll" /><span>全选待审/待发 (${actionable.length})</span></label>
        <div class="pf-segments">
          ${seg("ok", "✓", "无提示", tally.ok, "is-ok")}
          ${seg("warn", "⚠", "有提示", tally.warn, "is-warn")}
          ${seg("block", "⛔", "被拦住", tally.block, "is-block")}
          ${filter !== "all" ? `<button class="pf-seg is-clear" data-outbox-filter="all" type="button">显示全部</button>` : ""}
        </div>
        ${
          blockedOnly
            ? `<button class="primary-button" data-empty-action="verify-blocked" type="button"><svg><use href="#icon-check" /></svg><span>批量验证邮箱（${tally.block}）</span></button>`
            : `<button class="primary-button" id="batchApproveSend" type="button" ${canBatchSend ? "" : "disabled"}><svg><use href="#icon-check" /></svg><span>批准并发送（${canBatchSend}）</span></button>`
        }
      </div>`
    : "";

  elements.outboxList.innerHTML =
    strip +
    (items.length
      ? items
          .map((item) => {
            const selectable = ["待审批", "待发送"].includes(item.status);
            // D3：预检徽章放最左，扫一眼就知道堵点在哪；主题过长在这一行直接提示
            const subjectLen = (item.subject || "").length;
            const expanded = state.ui?.outboxPreviewId === item.id;
            return `
        <article class="outbox-item ${selectable ? "selectable" : ""} ${expanded ? "is-open" : ""}">
          <span class="outbox-pf">${selectable ? preflightBadge(item) : `<span class="pf-badge pf-done">已处理</span>`}</span>
          ${selectable ? `<input type="checkbox" data-outbox-id="${item.id}" aria-label="选择${escapeHtml(item.status)}邮件" />` : `<span class="outbox-spacer"></span>`}
          <span class="outbox-main">
            <strong>${escapeHtml(item.company)} · ${escapeHtml(item.label)}</strong>
            <span>${escapeHtml(item.email || "（缺邮箱）")} · ${item.dueDate} · ${escapeHtml(item.subject)}${
              subjectLen > 60 ? ` <span class="subject-long" title="主题 ${subjectLen} 字符。超过 60 字符在手机客户端会被截断，收件人看不到重点">主题偏长 ${subjectLen}</span>` : ""
            }</span>
            ${selectable ? sendTimingBadge(item) : ""}
          </span>
          <span class="outbox-status">
            <span class="badge">${escapeHtml(item.status)}</span>
            <button class="text-button" data-outbox-preview="${item.id}" type="button">${expanded ? "收起" : "预览"}</button>
          </span>
          ${expanded ? `<div class="outbox-preview"><pre>${escapeHtml(formatEmail(item))}</pre></div>` : ""}
        </article>
      `;
          })
          .join("")
      : `<div class="empty-state">这一档里暂时没有邮件</div>`);
}

function renderWhatsappQueue() {
  const queue = activeWhatsappQueueItems();
  if (!queue.length) {
    elements.whatsappQueueList.innerHTML = `<div class="empty-state">当前活动暂无 WhatsApp 队列</div>`;
    return;
  }

  elements.whatsappQueueList.innerHTML = queue
    .map(
      (item) => `
        <article class="outbox-item">
          <span>
            <strong>${escapeHtml(item.company)} · ${escapeHtml(item.label)}</strong>
            <span>${escapeHtml(item.phone)} · ${item.dueDate} · ${escapeHtml(item.status)}</span>
          </span>
          <a class="ghost-button" href="${item.url}" target="_blank" rel="noreferrer">
            <svg><use href="#icon-message" /></svg>
            <span>打开</span>
          </a>
        </article>
      `
    )
    .join("");
}

function renderTasks() {
  const tasks = activeTasks();
  if (!tasks.length) {
    elements.taskList.innerHTML = `<div class="empty-state">当前活动暂无跟进任务</div>`;
    return;
  }

  const sorted = [...tasks].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  elements.taskList.innerHTML = sorted
    .map(
      (task) => `
        <article class="task-item">
          <span>
            <strong>${escapeHtml(task.title)}</strong>
            <span>${escapeHtml(task.company)} · ${task.dueDate}</span>
          </span>
          <span class="tag">${escapeHtml(task.type)}</span>
        </article>
      `
    )
    .join("");
}

function renderLogs() {
  elements.runLog.innerHTML = state.logs.length
    ? state.logs
        .slice(0, 60)
        .map(
          (item) => `
            <article class="log-item">
              <strong>${escapeHtml(item.message)}</strong>
              <span>${item.time}</span>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">暂无日志</div>`;
}

/* ---------- 全渠道统一收件箱 + 跨渠道接力 ---------- */

function toTime(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function daysSinceMs(ms) {
  if (!ms) return 0;
  return Math.floor((Date.now() - ms) / 86400000);
}

/* 收件箱跨活动。
   获客和触达按活动分是对的（不同产品/市场，话术不一样），但「客户回信」不是。
   之前这里用 activeProspects()，结果 A 活动的客户回信时你正在 B 活动，
   那条回复根本看不到、红点也不亮——等于把询盘藏起来了。
   客户关系全局统一，只在条目上标出它属于哪个活动。 */
function conversationScopeProspects() {
  return state.prospects || [];
}

// 线索属于哪个活动（用于在收件箱/CRM 里标注来源），当前活动返回空串不加标签
function prospectCampaignLabel(prospect) {
  const cid = prospect?.campaignId;
  if (!cid || cid === state.activeCampaignId) return "";
  return (state.management?.campaigns || []).find((c) => c.id === cid)?.name || "其他活动";
}

function buildConversations() {
  const map = new Map();
  const prospects = conversationScopeProspects();
  const prospectById = new Map(prospects.map((item) => [item.id, item]));

  const ensure = (id, company) => {
    if (!map.has(id)) {
      const p = prospectById.get(id) || null;
      map.set(id, {
        prospectId: id,
        company: company || "未知客户",
        events: [],
        channels: new Set(),
        replied: false,
        unread: 0,
        relayed: false,
        prospect: p,
        campaignLabel: prospectCampaignLabel(p)
      });
    }
    const conversation = map.get(id);
    if (company && conversation.company === "未知客户") conversation.company = company;
    return conversation;
  };

  (state.outbox || []).forEach((item) => {
    const conversation = ensure(item.prospectId, item.company);
    conversation.channels.add("email");
    if (item.relay) conversation.relayed = true;
    conversation.events.push({
      kind: "outbound",
      channel: "email",
      relay: !!item.relay,
      title: item.label,
      subject: item.subject,
      body: item.body,
      status: item.status,
      timeLabel: item.sentAt ? `已发送 ${item.dueDate}` : `计划 ${item.dueDate}`,
      sortKey: toTime(item.sentAt || item.createdAt || item.dueDate)
    });
  });

  (state.whatsappQueue || []).forEach((item) => {
    const conversation = ensure(item.prospectId, item.company);
    conversation.channels.add("whatsapp");
    if (item.relay) conversation.relayed = true;
    conversation.events.push({
      kind: "outbound",
      channel: "whatsapp",
      relay: !!item.relay,
      title: item.label,
      body: item.message,
      status: item.status,
      url: item.url,
      timeLabel: item.dueDate,
      sortKey: toTime(item.sentAt || item.createdAt || item.dueDate)
    });
  });

  (state.inbound || []).forEach((item) => {
    const conversation = ensure(item.prospectId, item.company);
    conversation.channels.add(item.channel);
    conversation.replied = true;
    if (!item.read) conversation.unread += 1;
    conversation.events.push({
      kind: "inbound",
      channel: item.channel,
      body: item.body,
      timeLabel: item.time,
      sortKey: toTime(item.at || item.time)
    });
  });

  const list = [...map.values()];
  list.forEach((conversation) => {
    conversation.events.sort((a, b) => a.sortKey - b.sortKey);
    conversation.lastEvent = conversation.events[conversation.events.length - 1] || null;
    conversation.lastActivity = conversation.lastEvent ? conversation.lastEvent.sortKey : 0;
  });
  list.sort((a, b) => b.lastActivity - a.lastActivity);
  return list;
}

function getRelayCandidates(conversations) {
  const emailToWa = [];
  const waToEmail = [];

  conversations.forEach((conversation) => {
    if (conversation.replied || !conversation.prospect) return;
    const emailEvents = conversation.events.filter((e) => e.kind === "outbound" && e.channel === "email");
    const waEvents = conversation.events.filter((e) => e.kind === "outbound" && e.channel === "whatsapp");

    // 协同模式下 WhatsApp 在入队时就一并排好了，接力不该再排第二条；
    // 该市场不适合 WhatsApp 的（美国/德国/俄罗斯等）也不接力过去
    const parallelQueued =
      state.relay.mode === "parallel" &&
      state.whatsappQueue.some((w) => w.prospectId === conversation.prospectId && w.step === "邮件跟进");

    if (
      state.relay.emailToWhatsapp &&
      emailEvents.length &&
      !waEvents.length &&
      !parallelQueued &&
      conversation.prospect.phone &&
      whatsappFitsMarket(conversation.prospect.market)
    ) {
      const firstEmail = Math.min(...emailEvents.map((e) => e.sortKey));
      if (daysSinceMs(firstEmail) >= state.relay.emailNoReplyDays) emailToWa.push(conversation);
    }

    if (state.relay.whatsappToEmail && waEvents.length && !emailEvents.length && conversation.prospect.email) {
      const firstWa = Math.min(...waEvents.map((e) => e.sortKey));
      if (daysSinceMs(firstWa) >= state.relay.whatsappNoReplyDays) waToEmail.push(conversation);
    }
  });

  return { emailToWa, waToEmail };
}

function renderInbox() {
  const conversations = buildConversations();
  updateRelayModeButtons();
  renderRelayKpis(conversations);
  renderConversationList(conversations);

  const exists = conversations.some((c) => c.prospectId === state.selectedConversationId);
  if (!exists) state.selectedConversationId = conversations[0]?.prospectId || null;
  const selected = conversations.find((c) => c.prospectId === state.selectedConversationId) || null;
  renderTimeline(selected);
}

function updateRelayModeButtons() {
  const mode = state.relay?.mode === "parallel" ? "parallel" : "relay";
  if (elements.relayModeRelay) elements.relayModeRelay.classList.toggle("is-active", mode === "relay");
  if (elements.relayModeParallel) elements.relayModeParallel.classList.toggle("is-active", mode === "parallel");
  if (elements.relayModeHint) {
    elements.relayModeHint.textContent =
      mode === "parallel"
        ? `协同：入队时邮件立即排、WhatsApp 排在 ${state.relay?.parallelWaDelayDays || 2} 天后，内容是"我给你发了封邮件，标题是…"——用到达率高的渠道把邮件从垃圾箱捞出来。仅对适合 WhatsApp 的市场生效，且每条都要人工确认。`
        : "接力：先只发邮件，超过设定天数没回复才转 WhatsApp。最保守，触达面最小。";
  }
}

function renderRelayKpis(conversations) {
  const candidates = getRelayCandidates(conversations);
  const pending = candidates.emailToWa.length + candidates.waToEmail.length;
  const relayed = conversations.filter((c) => c.relayed).length;
  const replied = conversations.filter((c) => c.replied).length;
  const cards = [
    ["待接力", pending, "达到接力条件的会话"],
    ["已接力", relayed, "已跨渠道补触达"],
    ["已回复", replied, "客户已回复，停止接力"]
  ];
  elements.relayKpis.innerHTML = cards
    .map(
      ([label, value, hint]) => `
        <article class="metric-card">
          <p class="eyebrow">${label}</p>
          <strong>${value}</strong>
          <span>${hint}</span>
        </article>
      `
    )
    .join("");
}

function channelBadge(channel) {
  return channel === "whatsapp"
    ? `<span class="channel-badge whatsapp">WhatsApp</span>`
    : `<span class="channel-badge email">邮件</span>`;
}

function renderConversationList(conversations) {
  const filter = elements.conversationFilter.value.trim().toLowerCase();
  const statusFilter = elements.conversationStatusFilter.value;

  const filtered = conversations.filter((conversation) => {
    const text = `${conversation.company} ${conversation.prospect?.market || ""}`.toLowerCase();
    if (filter && !text.includes(filter)) return false;
    if (statusFilter === "unreplied") return !conversation.replied;
    if (statusFilter === "replied") return conversation.replied;
    if (statusFilter === "relayed") return conversation.relayed;
    if (statusFilter === "unread") return conversation.unread > 0;
    return true;
  });

  if (!filtered.length) {
    elements.conversationList.innerHTML = emptyState(
      "inbox",
      "还没有会话",
      "先把潜客加入触达队列发出去；配好「拉取回复」Webhook 后，客户回信会自动出现在这里。",
      [{ label: "去邮件序列", goto: "email", primary: true }]
    );
    return;
  }

  elements.conversationList.innerHTML = filtered
    .map((conversation) => {
      const active = conversation.prospectId === state.selectedConversationId ? "is-active" : "";
      const channels = [...conversation.channels].map(channelBadge).join("");
      const relayTag = conversation.relayed ? `<span class="channel-badge relay">接力</span>` : "";
      const unread = conversation.unread ? `<span class="unread-dot">${conversation.unread}</span>` : "";
      const status = conversation.replied ? `<span class="status-pill">已回复</span>` : "";
      const last = conversation.lastEvent;
      const preview = last
        ? `${last.kind === "inbound" ? "↩ 客户：" : "→ "}${escapeHtml((last.body || "").replace(/\s+/g, " ").slice(0, 64))}`
        : "暂无消息";
      // B9 允许的两处"表演"之一：第一个买家回复到达时，这一条脉冲 400ms
      const pulse = conversation.prospectId === mkdPulseConversationId ? "is-first-reply" : "";
      return `
        <button class="conversation-item ${active} ${pulse}" data-conversation-id="${conversation.prospectId}" type="button">
          <strong>${escapeHtml(conversation.company)}</strong>
          <span class="conversation-meta">${
            conversation.campaignLabel
              ? `<span class="channel-badge campaign" title="这条会话属于其他开发活动，收件箱不按活动切分">${escapeHtml(
                  conversation.campaignLabel
                )}</span>`
              : ""
          }${channels}${relayTag}${status}${unread}${intentPill(conversation)}</span>
          <span class="conv-preview">${preview}</span>
        </button>
      `;
    })
    .join("");
}

function renderTimeline(conversation) {
  if (!conversation) {
    elements.inboxTimeline.innerHTML = emptyState("message", "选一条会话", "左侧点任意客户，这里显示邮件与 WhatsApp 混排的完整时间线。", []);
    if (elements.inboxAiPanel) elements.inboxAiPanel.innerHTML = "";
    return;
  }

  const prospect = conversation.prospect;
  const emailEvents = conversation.events.filter((e) => e.kind === "outbound" && e.channel === "email");
  const waEvents = conversation.events.filter((e) => e.kind === "outbound" && e.channel === "whatsapp");
  const canRelayWa =
    !conversation.replied && emailEvents.length && !waEvents.length && prospect?.phone;
  const canRelayEmail =
    !conversation.replied && waEvents.length && !emailEvents.length && prospect?.email;

  const events = conversation.events
    .map((event) => {
      if (event.kind === "inbound") {
        const intent = classifyIntent(event.body);
        return `
          <article class="timeline-item inbound">
            <div class="tl-meta">${channelBadge(event.channel)}<strong>客户回复</strong><span class="intent-tag ${intent.tone}">意图：${intent.label}</span><span>${escapeHtml(event.timeLabel || "")}</span></div>
            <div class="tl-body">${escapeHtml(event.body || "")}</div>
          </article>
        `;
      }
      const relayTag = event.relay ? `<span class="channel-badge relay">接力</span>` : "";
      const subject = event.subject ? `Subject: ${event.subject}\n\n` : "";
      return `
        <article class="timeline-item outbound ${event.status === "已取消" ? "cancelled" : ""}">
          <div class="tl-meta">${channelBadge(event.channel)}${relayTag}<strong>${escapeHtml(event.title || "")}</strong><span>${escapeHtml(event.status || "")} · ${escapeHtml(event.timeLabel || "")}</span></div>
          <div class="tl-body">${escapeHtml(subject + (event.body || ""))}</div>
        </article>
      `;
    })
    .join("");

  const sub = prospect
    ? `${escapeHtml(prospect.market || "")} · ${escapeHtml(prospect.email || "无邮箱")} · ${escapeHtml(prospect.phone || "无号码")}`
    : "潜客已从列表移除";

  const actions = [
    !conversation.replied
      ? `<button class="ghost-button" data-inbox-action="simulate-reply" type="button"><svg><use href="#icon-message" /></svg><span>模拟客户回复</span></button>`
      : "",
    canRelayWa
      ? `<button class="primary-button" data-inbox-action="relay-wa" type="button"><svg><use href="#icon-shuffle" /></svg><span>转 WhatsApp 接力</span></button>`
      : "",
    canRelayEmail
      ? `<button class="primary-button" data-inbox-action="relay-email" type="button"><svg><use href="#icon-shuffle" /></svg><span>转邮件接力</span></button>`
      : "",
    conversation.unread
      ? `<button class="ghost-button" data-inbox-action="mark-read" type="button"><svg><use href="#icon-check" /></svg><span>标记已读</span></button>`
      : ""
  ]
    .filter(Boolean)
    .join("");

  const status = conversation.replied
    ? `<span class="status-pill">已回复 · 接力已停止</span>`
    : conversation.relayed
      ? `<span class="channel-badge relay">已接力</span>`
      : `<span class="tag">未回复</span>`;

  const intent = getConversationIntent(conversation);
  let aiPanel = "";
  if (intent) {
    const inboundEvents = conversation.events.filter((e) => e.kind === "inbound");
    const replyChannel = inboundEvents[inboundEvents.length - 1]?.channel || "email";
    const stored = getStoredAI(conversation.prospectId);
    const intentLabel = stored ? stored.intent_label : intent.label;
    const confidence = stored ? stored.confidence : intent.confidence;
    const summary = stored
      ? `${stored.summary} 建议：${stored.next_action}`
      : summarizeConversation(conversation);
    const suggestion = stored?.suggested_reply || suggestReply(prospect, intent.key);
    const sourceTag = stored
      ? `<span class="channel-badge whatsapp">Claude · ${escapeHtml(stored.model || "")}</span>`
      : `<span class="tag">本地规则</span>`;
    const analyzeBtn =
      !stored && aiEnabled()
        ? `<button class="ghost-button" data-inbox-action="ai-analyze" type="button"><svg><use href="#icon-zap" /></svg><span>用 Claude 分析</span></button>`
        : "";
    const risks = conversationRisks(conversation.prospectId);
    const riskBlock = risks.length
      ? `
        <div class="risk-block risk-${highestRiskLevel(risks)}">
          <p class="eyebrow">⚠️ 风险提示 · ${risks.length} 项</p>
          ${risks
            .map(
              (r) => `
              <div class="risk-item">
                <span class="intent-tag ${riskLevelTone(r.level)}">${r.level === "high" ? "高" : r.level === "medium" ? "中" : "低"} · ${escapeHtml(r.category)}</span>
                <div class="risk-detail"><strong>${escapeHtml(r.evidence)}</strong><span>应对：${escapeHtml(r.action)}</span></div>
              </div>
            `
            )
            .join("")}
        </div>
      `
      : "";
    // D4：高风险红卡置顶——先看见"这单可能有诈"，再看回复建议
    const riskFirst = highestRiskLevel(risks) === "high";
    aiPanel = `
      <div class="ai-panel">
        <div class="ai-panel-head">
          <span class="ai-badge">AI 助手</span>
          <span class="intent-tag ${intent.tone}">意图：${escapeHtml(intentLabel)} · 置信度 ${confidence}%</span>
          ${risks.length ? `<span class="intent-tag ${riskLevelTone(highestRiskLevel(risks))}">⚠️ ${risks.length} 项风险</span>` : ""}
          ${sourceTag}
        </div>
        ${riskFirst ? riskBlock : ""}
        <p class="ai-summary">${escapeHtml(summary)}</p>
        ${riskFirst ? "" : riskBlock}
        <p class="eyebrow">建议回复（${replyChannel === "whatsapp" ? "WhatsApp" : "邮件"}）</p>
        <div class="ai-suggestion" id="aiSuggestion">${escapeHtml(suggestion)}</div>
        <div class="ai-actions">
          ${analyzeBtn}
          <button class="ghost-button" data-inbox-action="copy-suggestion" type="button"><svg><use href="#icon-copy" /></svg><span>复制建议</span></button>
          <button class="primary-button" data-inbox-action="adopt-suggestion" type="button"><svg><use href="#icon-mail" /></svg><span>加入待审回复</span></button>
        </div>
      </div>
    `;
  }

  const inboundList = conversation.events.filter((e) => e.kind === "inbound");
  const activeChannel =
    quickReplyChannels[conversation.prospectId] || inboundList[inboundList.length - 1]?.channel || "email";
  const draft = quickReplyDrafts[conversation.prospectId] || "";
  const quickReply = prospect
    ? `
      <div class="quick-reply">
        <div class="quick-reply-head">
          <p class="eyebrow">快捷回复</p>
          <div class="segmented small" role="group" aria-label="回复渠道">
            <button class="segment ${activeChannel === "email" ? "is-active" : ""}" data-reply-channel="email" type="button">邮件</button>
            <button class="segment ${activeChannel === "whatsapp" ? "is-active" : ""}" data-reply-channel="whatsapp" type="button">WhatsApp</button>
          </div>
        </div>
        <textarea id="quickReplyText" rows="3" placeholder="输入回复内容，Ctrl+Enter 发送">${escapeHtml(draft)}</textarea>
        <div class="ai-actions">
          <button class="primary-button" data-inbox-action="send-quick-reply" type="button"><svg><use href="#icon-mail" /></svg><span>发送回复</span></button>
        </div>
      </div>
    `
    : "";

  // 若用户正在快捷回复框打字，记录焦点与光标，重渲染后恢复（避免自动驾驶 tick 打断输入）
  const wasTyping = document.activeElement?.id === "quickReplyText";
  const selStart = wasTyping ? document.activeElement.selectionStart : 0;
  const selEnd = wasTyping ? document.activeElement.selectionEnd : 0;

  // D4 三栏：会话列表 300 ｜ 时间线 ｜ AI 面板 320。AI 面板独立成栏，
  // 长会话滚动时右侧的意图/风险/建议不跟着滚走。
  elements.inboxTimeline.innerHTML = `
    <div class="timeline-head">
      <div>
        <h3>${escapeHtml(conversation.company)}</h3>
        <p class="conv-sub">${sub}</p>
      </div>
      ${status}
    </div>
    <div class="timeline">${events || `<div class="empty-state">暂无消息</div>`}</div>
    ${actions ? `<div class="timeline-actions">${actions}</div>` : ""}
  `;

  if (elements.inboxAiPanel) {
    elements.inboxAiPanel.innerHTML =
      aiPanel || `<div class="ai-panel-idle"><p class="eyebrow">AI 助手</p><p>等客户回信后，这里会给出意图识别、风险扫描和可直接采用的回复建议。</p></div>`;
    elements.inboxAiPanel.innerHTML += quickReply;
  }

  if (wasTyping) {
    const textarea = document.querySelector("#quickReplyText");
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(selStart, selEnd);
    }
  }
}

function createRelayWhatsapp(prospect, quiet = false) {
  if (!prospect.phone) return false;
  const exists = state.whatsappQueue.some((item) => item.prospectId === prospect.id);
  if (exists) return false;

  const first =
    prospect.contactName && prospect.contactName !== "待补全" && prospect.contactName !== "待确认"
      ? prospect.contactName.split(" ")[0]
      : "there";
  const message = `Hi ${first}, I emailed you about ${state.campaign.product} for ${prospect.company} but wasn't sure it reached you. Happy to share a short catalog and price range here on WhatsApp if that is easier. Thanks!`;
  const status = state.management.rules.requireWhatsappApproval ? "待人工确认" : "已审批";

  state.whatsappQueue.push({
    id: makeId("waq"),
    prospectId: prospect.id,
    company: prospect.company,
    phone: prospect.phone,
    label: "接力触达",
    message,
    dueDate: dateOffset(0),
    createdAt: new Date().toISOString(),
    status,
    step: "接力触达",
    relay: true,
    origin: "邮件未回接力",
    url: buildWhatsappUrl(prospect, message)
  });

  if (!quiet) addLog(`邮件未回，已为 ${prospect.company} 生成 WhatsApp 接力（${status}）`);
  return true;
}

function createRelayEmail(prospect, quiet = false) {
  if (!prospect.email) return false;
  const exists = state.outbox.some((item) => item.prospectId === prospect.id);
  if (exists) return false;

  const first =
    prospect.contactName && prospect.contactName !== "待补全" && prospect.contactName !== "待确认"
      ? prospect.contactName.split(" ")[0]
      : "there";
  const subject = `Following up by email · ${state.campaign.product}`;
  const body = `Hi ${first},

I tried to reach you on WhatsApp about ${state.campaign.product} for ${prospect.company}. In case email is easier, I can send a short catalog and a price range for your reference.

Best regards,
${state.campaign.senderName}
${state.campaign.companyName}`;

  state.outbox.push({
    id: makeId("outbox"),
    prospectId: prospect.id,
    company: prospect.company,
    email: prospect.email,
    label: "接力邮件",
    subject,
    body,
    dueDate: dateOffset(0),
    createdAt: new Date().toISOString(),
    status: "待审批",
    step: "接力邮件",
    relay: true,
    origin: "WhatsApp 未覆盖回退邮件"
  });

  if (!quiet) addLog(`WhatsApp 未覆盖，已为 ${prospect.company} 生成邮件接力`);
  return true;
}

function relayPass(quiet = false) {
  const conversations = buildConversations();
  const candidates = getRelayCandidates(conversations);
  let relayed = 0;

  candidates.emailToWa.forEach((conversation) => {
    if (createRelayWhatsapp(conversation.prospect, true)) relayed += 1;
  });
  candidates.waToEmail.forEach((conversation) => {
    if (createRelayEmail(conversation.prospect, true)) relayed += 1;
  });

  if (relayed && !quiet) {
    addLog(
      `跨渠道接力：${candidates.emailToWa.length} 个转 WhatsApp、${candidates.waToEmail.length} 个回退邮件，共 ${relayed} 条`
    );
  }
  return relayed;
}

function runCrossChannelRelay() {
  readInboxRulesFromForm();
  const relayed = relayPass();
  if (!relayed) addLog("没有会话达到接力条件（可把未回天数设为 0，或对单个会话手动接力）");
  saveState();
  render();
}

function simulateInboundReply(prospectId) {
  const conversation = buildConversations().find((c) => c.prospectId === prospectId);
  if (!conversation) return;
  const lastOutbound = [...conversation.events].reverse().find((e) => e.kind === "outbound");
  const channel = lastOutbound?.channel || "email";
  const product = state.campaign.product;
  // 多样化的买家回复，覆盖不同意图，便于演示 AI 意图识别
  const replyBank = [
    `Hi, thanks for reaching out. Please send your best FOB price list and MOQ for ${product}. What is the lead time?`,
    `Interested. Could you send a free sample of ${product} and share your sample policy?`,
    `Your price looks a bit high compared to our current supplier. Can you offer a better price for a full container order?`,
    `Do you have FDA and LFGB certificates and test reports for ${product}?`,
    `Thanks, but we already have a supplier and are not looking to switch right now.`
  ];
  const existing = state.inbound.filter((m) => m.prospectId === prospectId).length;
  const body = replyBank[(hashInt(prospectId) + existing) % replyBank.length];
  ingestInboundMessage(prospectId, channel, body);
}

// 回信入库统一入口：模拟回复与「拉取回复 Webhook」的真实回信都走这里，
// 全套规则（回复即停/退订黑名单/意图推进/AI 分析与初轮应答）一致生效
function ingestInboundMessage(prospectId, channel, body, at = Date.now()) {
  const prospect = state.prospects.find((item) => item.id === prospectId);
  const company = prospect?.company || "未知客户";

  state.inbound.push({
    id: makeId("inbound"),
    prospectId,
    company,
    channel,
    body,
    time: timestamp(),
    at,
    read: false
  });

  if (prospect) {
    state.prospects = state.prospects.map((item) =>
      item.id === prospectId ? { ...item, status: "已回复" } : item
    );
    advanceDealStage(prospectId, "已回复");
  }
  addLog(`收到客户回复（${channel === "whatsapp" ? "WhatsApp" : "邮件"}）：${company}`);

  // 规则1：客户回复 → 自动停止其剩余触达序列
  cancelSequenceOnReply(prospectId);

  // 规则1.5：退订永久生效（无论是否开启 AI 自动应答），进持久黑名单
  if (isOptOut(body)) markProspectOptOut(prospectId);

  // 规则2：意图驱动 CRM——询价/要样/MOQ/认证/交期 视为有效询盘，自动推进
  const intent = classifyIntent(body);
  if (["price", "sample", "moq", "cert", "leadtime", "discount"].includes(intent.key)) {
    advanceDealStage(prospectId, "询盘");
    addLog(`AI 意图「${intent.label}」→ 商机自动推进到「询盘」：${company}`);
  } else if (intent.key === "reject") {
    addLog(`AI 意图「拒绝」→ ${company} 转入培育名单，停止主动触达`);
  }

  // 规则3/4/5：先做语义分析，再决定初轮应答与草稿（顺序保证 opt-out/敏感优先于自动发送）
  processInboundIntelligence(prospectId);
}

/* ---------- 退信入库（直连模式） ----------
   口径与「发送状态回传 Webhook」一致：硬退信（5.x.x，地址不存在）立即拉黑，
   软退信（4.x.x，对方满了/暂时不可达）只标记不拉黑——拉黑软退信会误伤正常客户。 */
function ingestBounces(bounces) {
  if (!bounces?.length) return 0;
  let hard = 0;
  let soft = 0;
  bounces.forEach((b) => {
    const email = (b.email || "").toLowerCase().trim();
    if (!email) return;
    const items = state.outbox.filter((o) => (o.email || "").toLowerCase() === email && o.status === "已发送");
    items.forEach((o) => {
      o.bounced = true;
      o.delivered = false;
      o.bounceHard = !!b.hard;
    });
    const prospect = state.prospects.find(
      (p) => (p.email || "").toLowerCase() === email || (p.emailCandidates || []).some((c) => c.email.toLowerCase() === email)
    );
    if (b.hard) {
      hard += 1;
      if (prospect) {
        prospect.emailStatus = "退信";
        addToBlacklist(prospect, "硬退信（邮箱无效，自动拉黑保护发信域名）");
      }
    } else {
      soft += 1;
      if (prospect) prospect.emailStatus = "软退信（暂时投递失败）";
    }
  });
  if (hard || soft) {
    addLog(
      `收信识别到退信：${hard ? `⚠ ${hard} 封硬退信（地址无效，已拉黑）` : ""}${hard && soft ? " · " : ""}${
        soft ? `${soft} 封软退信（暂时失败，未拉黑）` : ""
      }`
    );
  }
  return hard + soft;
}

// 拉取真实客户回信。两条来源，归一成同一种形状后走同一套入库逻辑：
//   直连模式 → 主进程 IMAP 直接收
//   Webhook 模式 → 向「拉取回复 Webhook」要增量（n8n/IMAP 侧按 since 返回）
async function pullInboundReplies(quiet = false) {
  const directReady = state.settings.mode === "direct" && MKD_MAIL?.imap?.configured;
  const webhookReady = state.settings.mode === "webhook" && webhookUrl("inbound");
  if (!directReady && !webhookReady) {
    if (!quiet) {
      addLog(
        state.settings.mode === "direct"
          ? "还没配置 IMAP：到「设置 → 收发信」填好收件服务器，客户回信才能进收件箱"
          : "未配置「拉取回复 Webhook」：请在设置里接入你的收件服务（n8n/IMAP），真实客户回信才能进收件箱"
      );
    }
    return 0;
  }

  let replies = [];
  if (directReady) {
    const res = await mkdBridge().imapFetch({ since: state.lastInboundPullAt || null, limit: 50 });
    if (!res?.ok) {
      if (!quiet) addLog(`IMAP 收信失败：${res?.error || "未知错误"}`);
      return 0;
    }
    // 退信先处理掉：它们绝不能当客户回信入库（会被自动建档成"已回复"商机，
    // 开了 AI 自动应答还会去回复退信服务器），而且坏地址必须立刻拉黑
    ingestBounces(res.bounces || []);
    // 归一到 Webhook 那套字段名，下面的入库逻辑两条来源共用
    replies = (res.messages || []).map((m) => ({
      from_email: m.from,
      company: m.fromName || "",
      subject: m.subject,
      text: m.body,
      at: m.at
    }));
  } else {
    const result = await callWebhook("inbound", { since: state.lastInboundPullAt || null });
    if (!result.ok) {
      if (!quiet) addLog(`拉取回复失败：${result.error || result.code || "无响应"}`);
      return 0;
    }
    replies = Array.isArray(result.data?.replies) ? result.data.replies : [];
  }
  state.lastInboundPullAt = new Date().toISOString();
  if (!replies.length) {
    if (!quiet) addLog("拉取回复：暂无新回信");
    saveState();
    return 0;
  }

  let ingested = 0;
  replies.forEach((r) => {
    const email = (r.from_email || r.email || "").toLowerCase().trim();
    const text = (r.text || r.body || "").trim();
    if (!text) return;
    // 按邮箱匹配线索（主邮箱或候选邮箱），否则按公司名，都没有就补建一条线索避免丢回信
    let prospect =
      (email &&
        state.prospects.find(
          (p) => (p.email || "").toLowerCase() === email || (p.emailCandidates || []).some((c) => c.email.toLowerCase() === email)
        )) ||
      (r.company && state.prospects.find((p) => p.company.toLowerCase() === String(r.company).toLowerCase()));
    if (!prospect) {
      prospect = {
        id: makeId("prospect"),
        company: r.company || domainToCompany(email.split("@")[1] || "") || email || "未知回信客户",
        market: r.market || "待确认",
        source: "回信导入",
        website: email.split("@")[1] || "",
        contactName: r.from_name || "待确认",
        role: "回信联系人",
        email,
        emailStatus: "已验证",
        phone: r.phone || "",
        phoneStatus: r.phone ? "待人工确认" : "待查找",
        status: "已回复",
        score: 80,
        confidence: 88,
        presetKey: state.campaign.presetKey || null,
        campaignId: state.activeCampaignId || null,
        buyingSignal: "主动回信（真实回信导入）",
        companySize: "待确认",
        searchQuery: "inbound",
        // 这条不走 admitProspects（回信建档不该弹试用墙），所以时间戳在这里自己打
        createdAt: new Date().toISOString()
      };
      state.prospects = [prospect, ...state.prospects];
      addLog(`回信来自陌生地址 ${email || r.company}，已自动补建线索：${prospect.company}`);
    }
    // 去重：同一线索同样内容不重复入库
    if (state.inbound.some((m) => m.prospectId === prospect.id && m.body === text)) return;
    ingestInboundMessage(prospect.id, r.channel === "whatsapp" ? "whatsapp" : "email", text, r.at ? new Date(r.at).getTime() : Date.now());
    ingested += 1;
  });

  if (ingested) addLog(`拉取回复：${ingested} 条真实客户回信已进收件箱（意图识别/风险扫描/AI 应答已联动）`);
  saveState();
  render();
  return ingested;
}

// 拉取发送状态回传：从「发送状态回传 Webhook」同步 送达/退信/打开/投诉。
// 硬退信与投诉自动进黑名单（保护发信域名信誉，避免继续往坏地址发）。
// 期望响应：{ events: [ { email, event: "delivered"|"opened"|"bounced"|"complained", at } ] }
async function pullDeliveryStatus(quiet = false) {
  if (!(state.settings.mode === "webhook" && webhookUrl("status"))) {
    if (!quiet) addLog("未配置「发送状态回传 Webhook」：接入后自动同步送达/退信/打开；硬退信会自动拉黑，保护发信域名不被拖垮");
    return 0;
  }
  const result = await callWebhook("status", { since: state.lastStatusPullAt || null });
  if (!result.ok) {
    if (!quiet) addLog(`拉取发送状态失败：${result.error || result.code || "无响应"}`);
    return 0;
  }
  const events = Array.isArray(result.data?.events) ? result.data.events : [];
  state.lastStatusPullAt = new Date().toISOString();
  if (!events.length) {
    if (!quiet) addLog("发送状态回传：暂无更新");
    saveState();
    return 0;
  }

  let delivered = 0;
  let opened = 0;
  let bounced = 0;
  let complained = 0;
  events.forEach((e) => {
    const email = (e.email || e.to || "").toLowerCase().trim();
    const ev = (e.event || e.status || e.type || "").toLowerCase();
    if (!email) return;
    const items = state.outbox.filter((o) => (o.email || "").toLowerCase() === email && o.status === "已发送");
    const prospect = items[0] && state.prospects.find((p) => p.id === items[0].prospectId);
    if (/bounce|fail|invalid|reject|undeliver|hard/.test(ev)) {
      items.forEach((o) => {
        o.bounced = true;
        o.delivered = false;
      });
      if (prospect) {
        prospect.emailStatus = "退信";
        addToBlacklist(prospect, "硬退信（邮箱无效，自动拉黑保护发信域名）");
      }
      bounced += 1;
    } else if (/complain|spam|abuse/.test(ev)) {
      if (prospect) markProspectOptOut(prospect.id, "对方标记为垃圾邮件");
      complained += 1;
    } else if (/open/.test(ev)) {
      // 累加次数而不只置一个布尔值：「打开 3 次还没回」是意向最强的信号，
      // 布尔值表达不了它和「打开 1 次」的区别。
      items.forEach((o) => {
        o.opened = true;
        o.delivered = true;
        o.openCount = (o.openCount || 0) + 1;
        o.lastOpenAt = e.at || e.timestamp || new Date().toISOString();
        if (!o.firstOpenAt) o.firstOpenAt = o.lastOpenAt;
      });
      opened += 1;
    } else if (/deliver|sent|accept/.test(ev)) {
      items.forEach((o) => {
        o.delivered = true;
      });
      delivered += 1;
    }
  });

  const parts = [];
  if (delivered) parts.push(`${delivered} 送达`);
  if (opened) parts.push(`${opened} 打开`);
  if (bounced) parts.push(`⚠ ${bounced} 退信（已拉黑）`);
  if (complained) parts.push(`⛔ ${complained} 投诉（已拉黑）`);
  addLog(`发送状态回传：${parts.join(" · ") || "无变化"}`);
  saveState();
  render();
  return events.length;
}

async function processInboundIntelligence(prospectId) {
  // 已配置 Claude 时先做语义级意图分析（回填后 auto-respond 用真实意图判断）
  if (aiEnabled()) await enrichInboundWithAI(prospectId);

  // 第 4 步护栏：开启初轮自动应答时，opt-out/敏感话题优先处理
  if (state.agent?.autoRespond) {
    await handleInboundAutoRespond(prospectId);
    const message = [...state.inbound].reverse().find((m) => m.prospectId === prospectId);
    // 已被护栏处理（自动答复/转人工/opt-out）则不再走审批草稿
    if (message?.autoAction) return;
  }

  // 未自动应答时，自动驾驶下生成 AI 回复草稿送审批
  if (state.autopilot?.enabled) createAiDraft(prospectId);
}

function cancelSequenceOnReply(prospectId) {
  let cancelled = 0;
  state.outbox.forEach((item) => {
    if (item.prospectId === prospectId && ["待审批", "待发送"].includes(item.status) && !item.reply) {
      item.status = "已取消";
      cancelled += 1;
    }
  });
  state.whatsappQueue.forEach((item) => {
    if (item.prospectId === prospectId && ["待人工确认", "已审批"].includes(item.status) && !item.reply) {
      item.status = "已取消";
      cancelled += 1;
    }
  });
  if (cancelled) addLog(`客户已回复，自动取消剩余 ${cancelled} 条待发触达（回复即停）`);
  return cancelled;
}

function markConversationRead(prospectId) {
  state.inbound = state.inbound.map((item) =>
    item.prospectId === prospectId ? { ...item, read: true } : item
  );
}

/* ---------- AI 助手：意图识别 + 回复建议 + 摘要 ---------- */

function classifyIntent(text) {
  const lower = (text || "").toLowerCase();
  // INTENTS 已按优先级排序（拒绝 > 议价 > 样品 > 询价 ...），
  // 返回第一个命中的意图，避免通用词（如 "price"）盖过强信号（如 "better price"）
  for (const intent of INTENTS) {
    const hits = intent.keywords.filter((word) => lower.includes(word)).length;
    if (hits > 0) return { ...intent, confidence: Math.min(95, 60 + hits * 15), hits };
  }
  return { key: "other", label: "需人工判断", tone: "muted", next: "追问客户具体需求后再决定话术", confidence: 0, hits: 0 };
}

function firstName(prospect) {
  return prospect && prospect.contactName && !["待补全", "待确认"].includes(prospect.contactName)
    ? prospect.contactName.split(" ")[0]
    : "there";
}

function suggestReply(prospect, intentKey) {
  const first = firstName(prospect);
  const product = state.campaign.product;
  const props = state.campaign.valueProps;
  const certs = state.campaign.certifications;
  const sender = state.campaign.senderName;
  const templates = {
    price: `Hi ${first}, thanks! I'll send our latest ${product} price list and a reference FOB quote today. Could you share your target quantity so I can give the most accurate pricing?`,
    sample: `Hi ${first}, happy to arrange ${product} samples. I'll share our sample policy and lead time — could you confirm the models and a shipping address?`,
    discount: `Hi ${first}, thanks for the feedback. Our pricing reflects ${props}. If you can share your target price and annual volume, I'll check the best rate we can support.`,
    leadtime: `Hi ${first}, for ${product} our typical lead time is 25-35 days after order confirmation, and samples in 5-7 days. I can confirm exact timing once I know your quantity.`,
    moq: `Hi ${first}, our MOQ for ${product} is flexible for a first order. Tell me your target quantity and I'll confirm the MOQ and price tiers.`,
    cert: `Hi ${first}, we can provide ${certs} and full test reports for ${product}. I'll attach the certificates — is there any specific compliance your market requires?`,
    reject: `Hi ${first}, understood, and thanks for letting me know. If your sourcing needs change I'm glad to help — may I share one or two key updates each quarter?`,
    other: `Hi ${first}, thanks for your reply. Could you tell me a bit more about your needs for ${product} so I can help precisely?`
  };
  return `${templates[intentKey] || templates.other}\n\nBest regards,\n${sender}`;
}

function getConversationIntent(conversation) {
  const inbound = conversation.events.filter((e) => e.kind === "inbound");
  if (!inbound.length) return null;
  return classifyIntent(inbound[inbound.length - 1].body);
}

function summarizeConversation(conversation) {
  const outbound = conversation.events.filter((e) => e.kind === "outbound");
  const inbound = conversation.events.filter((e) => e.kind === "inbound");
  const channels = [...conversation.channels].map((c) => (c === "whatsapp" ? "WhatsApp" : "邮件")).join("+");
  const stage = conversation.prospect?.dealStage || "线索";
  if (!inbound.length) {
    return `已通过 ${channels || "邮件"} 触达 ${outbound.length} 次，客户尚未回复；当前阶段「${stage}」。`;
  }
  const intent = classifyIntent(inbound[inbound.length - 1].body);
  return `已触达 ${outbound.length} 次、收到 ${inbound.length} 条回复；最新意图「${intent.label}」，当前阶段「${stage}」。建议：${intent.next}。`;
}

function getSuggestionForConversation(prospectId) {
  const conversation = buildConversations().find((c) => c.prospectId === prospectId);
  if (!conversation) return null;
  const intent = getConversationIntent(conversation);
  if (!intent) return null;
  const prospect = state.prospects.find((p) => p.id === prospectId);
  const inbound = conversation.events.filter((e) => e.kind === "inbound");
  const channel = inbound[inbound.length - 1]?.channel || "email";
  const stored = getStoredAI(prospectId);
  return {
    conversation,
    intent,
    prospect,
    channel,
    text: stored?.suggested_reply || suggestReply(prospect, intent.key)
  };
}

function hasPendingAiReply(prospectId) {
  return (
    state.outbox.some((o) => o.prospectId === prospectId && o.label === "AI 回复" && o.status !== "已发送") ||
    state.whatsappQueue.some((w) => w.prospectId === prospectId && w.label === "AI 回复" && w.status !== "已发送")
  );
}

function adoptSuggestedReply(prospectId, asDraft = false) {
  const suggestion = getSuggestionForConversation(prospectId);
  if (!suggestion) return false;
  if (hasPendingAiReply(prospectId)) {
    if (!asDraft) addLog("该客户已有待处理的 AI 回复，避免重复");
    return false;
  }
  const { conversation, intent, prospect, channel, text } = suggestion;

  if (channel === "whatsapp") {
    state.whatsappQueue.push({
      id: makeId("waq"),
      prospectId,
      company: conversation.company,
      phone: prospect?.phone || "",
      label: "AI 回复",
      message: text,
      dueDate: dateOffset(0),
      createdAt: new Date().toISOString(),
      status: "待人工确认",
      step: `AI回复-${intent.key}-${state.whatsappQueue.length}`,
      reply: true,
      url: buildWhatsappUrl(prospect || {}, text)
    });
  } else {
    state.outbox.push({
      id: makeId("outbox"),
      prospectId,
      company: conversation.company,
      email: prospect?.email || "",
      label: "AI 回复",
      subject: `Re: ${state.campaign.product}`,
      body: text,
      dueDate: dateOffset(0),
      createdAt: new Date().toISOString(),
      status: "待审批",
      step: `AI回复-${intent.key}-${state.outbox.length}`,
      reply: true
    });
  }
  addLog(
    asDraft
      ? `AI 自动生成回复草稿（${channel === "whatsapp" ? "WhatsApp" : "邮件"}·${intent.label}）待审批：${conversation.company}`
      : `已采用 AI 建议回复并加入待审批队列（${channel === "whatsapp" ? "WhatsApp" : "邮件"}·${intent.label}）：${conversation.company}`
  );
  return true;
}

function createAiDraft(prospectId) {
  return adoptSuggestedReply(prospectId, true);
}

/* ---------- AI 线索评分（排序用优先级 + 可解释因子） ----------
   注意口径：这个分只用来决定「先跟谁」，不是成交概率、不预测结果。
   界面上任何地方都不要把它说成"成交概率/成交率"——软件明确不承诺任何商业成果，
   一个写着"78% 成交概率"的数字会让用户产生错误预期，事后把没成交归咎到工具上。 */

function leadGrade(probability) {
  if (probability >= 80) return "A";
  if (probability >= 65) return "B";
  if (probability >= 50) return "C";
  return "D";
}

function computeLeadScore(prospect) {
  const campaign = state.campaign;
  const factors = [];
  let score = 20; // 基础分

  const add = (points, label, tone = "pos", detail = "") => {
    score += points;
    factors.push({ label, points, tone, detail });
  };

  // 1. 官网真实性
  const directWebsite =
    prospect.website &&
    !/(google|linkedin|facebook|instagram|youtube|amazon|alibaba|made-in-china|globalsources|temu|shein|directory)/i.test(prospect.website);
  if (directWebsite) add(12, "官网真实可直达");
  else factors.push({ label: prospect.website ? "仅平台/目录来源" : "缺公司官网", points: 0, tone: "neg", detail: "建议补公司官网" });

  // 2. 邮箱质量
  // 这里判的只是「格式对不对」。真正的"已验证"另有严格口径（真实源返回 / 客户回过信 /
  // 人工核实），见 emailVerificationState。两者不能混称，否则用户会以为这条已经能发了。
  if (prospect.emailStatus === "格式有效") add(10, "邮箱格式有效", "pos", "只校验了写法，未确认这个地址真实存在");
  else if (prospect.email) add(5, "有邮箱待验证");
  else factors.push({ label: "缺邮箱", points: 0, tone: "neg", detail: "需补全联系方式" });

  // 3. WhatsApp 号码
  if (prospect.phone) add(6, "有 WhatsApp 号码");

  // 4. 采购信号与角色
  const signalText = `${prospect.buyingSignal || ""} ${prospect.searchQuery || ""} ${prospect.role || ""}`.toLowerCase();
  if (/(import|distribut|wholesale|retail|buyer|sourcing|procurement|purchas|stockist)/.test(signalText)) {
    add(10, "采购角色/信号匹配");
  }

  // 5. 客户类型匹配
  const typeWords = (campaign.customerType || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (typeWords.some((word) => signalText.includes(word))) add(5, "客户类型匹配");

  // 5.5 产品契合度（做过 AI 细化定位后生效）：这家是否真采购这个具体产品
  if (hasProductProfile(campaign)) {
    const fit = productFit(prospect, campaign);
    if (fit.mismatch) {
      add(-14, "疑似不匹配该产品", "neg", `命中排除类型、且无产品相关信号，可能不是「${campaign.product}」的买家`);
    } else if (fit.hits >= 2) {
      add(16, "高度契合该产品", "pos", `命中 ${fit.hits} 个产品/买家段/用途信号：${fit.matched.slice(0, 3).join("、")}`);
    } else if (fit.hits === 1) {
      add(8, "契合该产品", "pos", `命中信号：${fit.matched[0]}`);
    } else {
      factors.push({ label: "无明确产品信号", points: 0, tone: "neg", detail: "官网/资料里未见该产品相关信号，建议核验" });
    }
  }

  // 5.6 AI 已判定不对口：直接压到最低档。
  //     出现过「AI 说完全不对口 0%」但质量分仍是「B 78」的情况——两个数字互相打脸，
  //     用户只会觉得系统在胡说。不对口就是不对口，排序上必须沉底。
  if (prospect.offTarget) {
    add(-45, "AI 判定不对口", "neg", prospect.fitNote || "不是采购/进口/分销我方产品的角色");
  } else if (typeof prospect.fitScore === "number" && prospect.fitScore < 60) {
    add(-12, `AI 匹配度偏低（${prospect.fitScore}%）`, "neg", prospect.fitNote || "对口程度存疑，建议先核验");
  }

  // 6. 互动信号（权重最高，主导评分分层）
  const replied =
    state.inbound.some((m) => m.prospectId === prospect.id) ||
    prospect.status === "已回复" ||
    stageIndex(prospect.dealStage || "线索") >= stageIndex("已回复");
  const opened =
    state.outbox.some((o) => o.prospectId === prospect.id && o.status === "已发送" && o.opened) ||
    state.whatsappQueue.some((w) => w.prospectId === prospect.id && w.status === "已发送" && w.read);
  const touched = hasSentOutbound(prospect.id);
  if (replied) add(25, "客户已回复（强意向）");
  else if (opened) add(12, "邮件/消息已打开");
  else if (touched) add(6, "已触达待响应");
  else factors.push({ label: "尚未触达", points: 0, tone: "neg", detail: "加入队列开始触达" });

  // 7. 资料置信度
  if ((prospect.confidence || 0) >= 80) add(4, "资料置信度高");

  // 8. 外部/AI 源评分作为先验，但不单独决定分级，避免和可解释质量分脱节
  const sourceScore = Number(prospect.score) || 0;
  // 说清楚这一项到底代表什么：它只反映「这条线索是从哪个渠道来的」，
  // 不代表引擎看过这家公司并认为它优质。原文案"引擎判断为高价值线索"是夸大。
  if (sourceScore >= 84) add(12, "来源渠道可信度高", "pos", "海关提单这类来源，本身就说明对方有真实进口行为");
  else if (sourceScore >= 76) add(8, "来源渠道可信度中等", "pos", "领英/行业协会等来源，比泛搜索更可能是真实企业");
  else if (sourceScore >= 70) add(4, "来源渠道一般", "pos", "搜索结果/目录站来源，是否对口需自行核验");

  const probability = clamp(Math.round(score), 5, 99);
  return { probability, grade: leadGrade(probability), factors };
}

/* ---------- 商机管道看板 (CRM) ---------- */

function stageIndex(stage) {
  const index = DEAL_STAGES.indexOf(stage);
  return index < 0 ? 0 : index;
}

function hasSentOutbound(prospectId) {
  return (
    state.outbox.some((item) => item.prospectId === prospectId && item.status === "已发送") ||
    state.whatsappQueue.some((item) => item.prospectId === prospectId && item.status === "已发送")
  );
}

function deriveDealStage(prospect) {
  const replied =
    prospect.status === "已回复" || state.inbound.some((item) => item.prospectId === prospect.id);
  if (replied) return "已回复";
  if (hasSentOutbound(prospect.id)) return "已触达";
  return "线索";
}

function ensureDealStages() {
  activeProspects().forEach((prospect) => {
    if (!prospect.dealStage || !DEAL_STAGES.includes(prospect.dealStage)) {
      prospect.dealStage = deriveDealStage(prospect);
    }
    if (typeof prospect.dealValue !== "number") {
      prospect.dealValue = 6000 + Math.round((prospect.score || 50) * 220);
    }
  });
}

function advanceDealStage(prospectId, minStage) {
  const prospect = state.prospects.find((item) => item.id === prospectId);
  if (!prospect) return;
  if (!prospect.dealStage || !DEAL_STAGES.includes(prospect.dealStage)) {
    prospect.dealStage = deriveDealStage(prospect);
  }
  if (stageIndex(prospect.dealStage) < stageIndex(minStage)) prospect.dealStage = minStage;
}

function getProspectDue(prospectId) {
  const today = dateOffset(0);
  const dues = state.tasks
    .filter((task) => task.prospectId === prospectId)
    .map((task) => task.dueDate)
    .sort();
  if (!dues.length) return { kind: "none", date: null };
  const overdue = dues.filter((date) => date < today);
  if (overdue.length) return { kind: "overdue", date: overdue[0] };
  if (dues.includes(today)) return { kind: "today", date: today };
  return { kind: "upcoming", date: dues.find((date) => date > today) || dues[0] };
}

function formatMoney(value) {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function renderCrm() {
  ensureDealStages();
  renderCrmKpis();
  renderCrmBoard();
}

/* CRM 跨活动：客户关系不该被"这批是哪一轮找来的"切碎。
   商机、跟进、成交是同一个客户身上的连续过程，按活动分开看等于把一个客户
   拆成几个人。获客与触达仍按活动分——那才是"在做的活儿"。 */
function crmProspects() {
  return state.prospects || [];
}

function renderCrmKpis() {
  const prospects = crmProspects();
  const total = prospects.length;
  const inquiry = prospects.filter((p) => stageIndex(p.dealStage) >= stageIndex("询盘")).length;
  const quoting = prospects.filter((p) => p.dealStage === "报价").length;
  const won = prospects.filter((p) => p.dealStage === "成交").length;
  const winRate = total ? Math.round((won / total) * 100) : 0;
  const overdue = prospects.filter(
    (p) => p.dealStage !== "成交" && getProspectDue(p.id).kind === "overdue"
  ).length;
  const openValue = prospects
    .filter((p) => p.dealStage !== "成交")
    .reduce((sum, p) => sum + (p.dealValue || 0), 0);

  const cards = [
    ["总商机", total, "管道内客户数"],
    ["询盘及以上", inquiry, "进入询盘/报价/成交"],
    ["报价中", quoting, "等待客户决策"],
    ["成交", won, `成交率 ${winRate}%`],
    ["在谈金额", formatMoney(openValue), "未成交商机预估"],
    ["超期跟进", overdue, "需立即处理"]
  ];

  elements.crmKpis.innerHTML = cards
    .map(
      ([label, value, hint]) => `
        <article class="metric-card">
          <p class="eyebrow">${label}</p>
          <strong>${value}</strong>
          <span>${hint}</span>
        </article>
      `
    )
    .join("");
}

function renderCrmBoard() {
  const prospects = crmProspects();
  elements.crmBoard.innerHTML = DEAL_STAGES.map((stage) => {
    const cards = prospects.filter((p) => p.dealStage === stage);
    const value = cards.reduce((sum, p) => sum + (p.dealValue || 0), 0);
    const cardsHtml = cards.length
      ? cards.map(renderCrmCard).join("")
      : `<div class="empty-state">拖入客户到「${stage}」</div>`;
    return `
      <div class="crm-column" data-stage="${stage}">
        <div class="crm-column-head">
          <strong>${stage}</strong>
          <span class="col-meta">${cards.length} · ${formatMoney(value)}</span>
        </div>
        ${cardsHtml}
      </div>
    `;
  }).join("");
}

function renderCrmCard(prospect) {
  const lead = computeLeadScore(prospect);
  const due = getProspectDue(prospect.id);
  const replied = prospect.dealStage === "已回复" || state.inbound.some((m) => m.prospectId === prospect.id);
  const needsFollowup =
    stageIndex(prospect.dealStage) >= stageIndex("已触达") &&
    prospect.dealStage !== "成交" &&
    !replied;

  let dueTag = "";
  if (due.kind === "overdue") dueTag = `<span class="due-tag overdue">超期 ${due.date}</span>`;
  else if (due.kind === "today") dueTag = `<span class="due-tag today">今日跟进</span>`;
  else if (due.kind === "upcoming") dueTag = `<span class="due-tag upcoming">下次 ${due.date}</span>`;
  else if (needsFollowup) dueTag = `<span class="due-tag unplanned">待安排跟进</span>`;
  // D5：下次跟进日期常显——不只在超期时才出现，否则"什么时候该追"要点开才知道
  else if (due.date) dueTag = `<span class="due-tag upcoming">下次 ${due.date}</span>`;
  else dueTag = `<span class="due-tag unplanned">未安排跟进</span>`;

  const channels = [];
  if (state.outbox.some((o) => o.prospectId === prospect.id)) channels.push(`<span class="channel-badge email">邮件</span>`);
  if (state.whatsappQueue.some((w) => w.prospectId === prospect.id)) channels.push(`<span class="channel-badge whatsapp">WhatsApp</span>`);
  if (replied) channels.push(`<span class="channel-badge relay">已回复</span>`);
  // 跨活动看板上标出这个客户是哪一轮找来的（当前活动不加标签，避免满屏噪音）
  const campaignTag = prospectCampaignLabel(prospect);
  if (campaignTag) {
    channels.unshift(
      `<span class="channel-badge campaign" title="这个客户属于其他开发活动，CRM 不按活动切分">${escapeHtml(campaignTag)}</span>`
    );
  }

  const isOverdue = due.kind === "overdue";

  return `
    <article class="crm-card ${isOverdue ? "is-overdue" : ""}" draggable="true" data-prospect-id="${prospect.id}">
      <div class="crm-card-top">
        <strong>${escapeHtml(prospect.company)}</strong>
        <span class="prob-grade grade-${lead.grade} is-micro" title="线索优先级 ${lead.grade} 级 · ${lead.probability} 分（用于排序，不预测成交）">${lead.grade} ${lead.probability}</span>
      </div>
      <div class="crm-card-meta">
        <span>${escapeHtml(prospect.market)}</span>
        <span class="crm-value">${formatMoney(prospect.dealValue || 0)}</span>
      </div>
      <div class="crm-card-badges">${channels.join("")}${dueTag}</div>
    </article>
  `;
}

function exportCrm() {
  const rows = activeProspects().map((p) => ({
    company: p.company,
    market: p.market,
    stage: p.dealStage,
    score: p.score,
    value: p.dealValue,
    email: p.email,
    phone: p.phone,
    nextFollowup: getProspectDue(p.id).date || ""
  }));
  download("crm-pipeline.csv", toCsv(rows), "text/csv");
}

/* ---------- 产品库 + 报价单生成器（询盘 → 报价 → 成交 的转化工具） ---------- */

function renderProducts() {
  const host = elements.productManager;
  if (!host) return;
  const rows = state.products
    .map(
      (p) => `
      <div class="product-row">
        <span class="product-cell"><strong>${escapeHtml(p.model)}</strong></span>
        <span class="product-cell grow">${escapeHtml(p.name)}</span>
        <span class="product-cell">MOQ ${escapeHtml(p.moq || "—")}</span>
        <span class="product-cell">${p.price ? `$${escapeHtml(String(p.price))}/${escapeHtml(p.unit || "pc")}` : "价格面议"}</span>
        <span class="product-cell dim">${escapeHtml(p.packing || "")}${p.certs ? ` · ${escapeHtml(p.certs)}` : ""}</span>
        <button class="ghost-button product-del" data-product-del="${p.id}" type="button"><span>删除</span></button>
      </div>`
    )
    .join("");
  host.innerHTML = `
    <div class="product-form">
      <input id="pfModel" placeholder="型号* 如 CG125-CYL" />
      <input id="pfName" placeholder="英文品名* 如 Cylinder Block Kit" />
      <input id="pfMoq" placeholder="MOQ 如 100 pcs" />
      <input id="pfPrice" type="number" step="0.01" min="0" placeholder="参考单价 USD" />
      <input id="pfUnit" placeholder="单位 如 pc/set" />
      <input id="pfPacking" placeholder="箱规/包装 可空" />
      <input id="pfCerts" placeholder="认证 如 CCC,SONCAP 可空" />
      <button class="primary-button" data-product-action="add" type="button"><span>添加产品</span></button>
    </div>
    ${rows || `<div class="empty-state">还没有产品。先把常卖的型号加进来——AI 回复、报价单都会用它。</div>`}
  `;
}

function addProductFromForm() {
  const val = (id) => (document.getElementById(id)?.value || "").trim();
  const model = val("pfModel");
  const name = val("pfName");
  if (!model || !name) {
    addLog("请至少填写 型号 和 英文品名");
    return;
  }
  state.products.push({
    id: makeId("prod"),
    model,
    name,
    moq: val("pfMoq"),
    price: Number(val("pfPrice")) || 0,
    unit: val("pfUnit") || "pc",
    packing: val("pfPacking"),
    certs: val("pfCerts")
  });
  addLog(`产品已入库：${model} ${name}`);
  saveState();
  renderProducts();
}

/* ----- 报价单 ----- */

function money(n) {
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function openQuoteBuilder(presetProspectId) {
  const host = elements.quoteOverlay;
  if (!host) return;
  const prospects = activeProspects();
  if (!prospects.length) {
    addLog("当前活动还没有客户线索，先去「搜索」导入或一键起量");
    return;
  }
  const selectedId = presetProspectId || crmDrawerProspectId || state.selectedProspectId || prospects[0].id;
  const hot = (p) => (p.dealStage === "询盘" || p.dealStage === "已回复" ? 1 : 0);
  const options = [...prospects]
    .sort((a, b) => hot(b) - hot(a))
    .map((p) => `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(p.company)}（${escapeHtml(p.market)}${p.dealStage ? " · " + escapeHtml(p.dealStage) : ""}）</option>`)
    .join("");
  const productLines = state.products
    .map(
      (p) => `
      <div class="qline">
        <label class="qline-pick"><input type="checkbox" data-qline="${p.id}" /> <strong>${escapeHtml(p.model)}</strong> ${escapeHtml(p.name)}</label>
        <input class="qline-qty" type="number" min="1" value="100" title="数量" />
        <input class="qline-price" type="number" step="0.01" min="0" value="${p.price || ""}" placeholder="单价" title="单价" />
      </div>`
    )
    .join("");
  host.innerHTML = `
    <div class="panel quote-card" role="dialog" aria-modal="true" aria-label="生成报价单">
      <h2>生成报价单</h2>
      <div class="quote-form">
        <label><span>客户</span><select id="qbCustomer">${options}</select></label>
        <div class="quote-form-row">
          <label><span>贸易条款</span><select id="qbIncoterm"><option>FOB</option><option>CIF</option><option>CFR</option><option>EXW</option><option>DDP</option></select></label>
          <label><span>港口/地点</span><input id="qbPort" placeholder="如 Shanghai / Lagos" /></label>
          <label><span>币种</span><select id="qbCurrency"><option>USD</option><option>EUR</option><option>RMB</option></select></label>
          <label><span>有效期(天)</span><input id="qbValid" type="number" min="1" value="15" /></label>
        </div>
        <p class="eyebrow">报价行（勾选产品库，或加自定义行）</p>
        <div id="qbLines">${productLines || ""}</div>
        <div id="qbCustomLines"></div>
        <button class="ghost-button" data-quote-action="add-line" type="button"><span>+ 加一行自定义产品</span></button>
        <label><span>备注/条款（可空，如付款方式、交期）</span><textarea id="qbNote" rows="2" placeholder="Payment and lead time to be confirmed."></textarea></label>
      </div>
      <div class="quote-actions">
        <button class="primary-button" data-quote-action="generate" type="button"><span>生成报价单</span></button>
        <button class="ghost-button" data-quote-action="close" type="button"><span>取消</span></button>
      </div>
    </div>
  `;
  host.hidden = false;
}

function addCustomQuoteLine() {
  const box = document.getElementById("qbCustomLines");
  if (!box) return;
  const row = document.createElement("div");
  row.className = "qline";
  row.innerHTML = `
    <input class="qline-name" placeholder="品名/型号（自定义）" />
    <input class="qline-qty" type="number" min="1" value="100" title="数量" />
    <input class="qline-price" type="number" step="0.01" min="0" placeholder="单价" title="单价" />
  `;
  box.appendChild(row);
}

function collectQuoteLines() {
  const lines = [];
  document.querySelectorAll("#qbLines .qline").forEach((row) => {
    const pick = row.querySelector("[data-qline]");
    if (!pick?.checked) return;
    const product = state.products.find((p) => p.id === pick.dataset.qline);
    if (!product) return;
    const qty = Number(row.querySelector(".qline-qty")?.value) || 0;
    const price = Number(row.querySelector(".qline-price")?.value) || 0;
    if (qty > 0) lines.push({ model: product.model, name: product.name, unit: product.unit || "pc", qty, price });
  });
  document.querySelectorAll("#qbCustomLines .qline").forEach((row) => {
    const name = (row.querySelector(".qline-name")?.value || "").trim();
    const qty = Number(row.querySelector(".qline-qty")?.value) || 0;
    const price = Number(row.querySelector(".qline-price")?.value) || 0;
    if (name && qty > 0) lines.push({ model: "", name, unit: "pc", qty, price });
  });
  return lines;
}

function generateQuote() {
  const prospect = state.prospects.find((p) => p.id === document.getElementById("qbCustomer")?.value);
  const lines = collectQuoteLines();
  if (!prospect) {
    addLog("请选择客户");
    return;
  }
  if (!lines.length) {
    addLog("请至少勾选/填写一行报价（数量>0）");
    return;
  }
  const today = dateOffset(0);
  const seq = state.quotes.filter((q) => (q.createdAt || "").slice(0, 10) === today).length + 1;
  const quote = {
    id: makeId("quote"),
    number: `Q-${today.replaceAll("-", "")}-${String(seq).padStart(2, "0")}`,
    prospectId: prospect.id,
    company: prospect.company,
    contactName: prospect.contactName || "",
    items: lines,
    currency: document.getElementById("qbCurrency")?.value || "USD",
    incoterm: document.getElementById("qbIncoterm")?.value || "FOB",
    port: (document.getElementById("qbPort")?.value || "").trim(),
    validDays: Number(document.getElementById("qbValid")?.value) || 15,
    note: (document.getElementById("qbNote")?.value || "").trim(),
    total: lines.reduce((s, l) => s + l.qty * l.price, 0),
    createdAt: new Date().toISOString()
  };
  state.quotes.unshift(quote);

  // CRM 联动：推进到「报价」并把管道金额换成真实报价额
  prospect.dealValue = Math.round(quote.total);
  advanceDealStage(prospect.id, "报价");

  // 报价跟进闭环：3 天后自动排一封引用报价编号的跟进邮件（待审批）
  if (prospect.email) {
    state.outbox.push({
      id: makeId("outbox"),
      prospectId: prospect.id,
      company: prospect.company,
      email: prospect.email,
      label: "报价跟进",
      step: "报价跟进",
      subject: `Follow-up on Quotation ${quote.number}`,
      body: `Dear ${prospect.contactName && !["待补全", "待确认", "待确认采购角色"].includes(prospect.contactName) ? prospect.contactName.split(" ")[0] : "Sir or Madam"},

I am writing to follow up on Quotation ${quote.number} (${quote.currency} ${money(quote.total)}, valid for ${quote.validDays} days), which I sent for your consideration.

Should any adjustment to quantities or specifications be helpful, I would be glad to revise the quotation accordingly. Please let me know if you have any questions.

Best regards,
${state.campaign.senderName}
${state.campaign.companyName}`,
      dueDate: dateOffset(3),
      createdAt: new Date().toISOString(),
      status: "待审批"
    });
  }

  addLog(`报价单 ${quote.number} 已生成（${quote.currency} ${money(quote.total)}）：CRM 已推进到「报价」${prospect.email ? "，3 天后跟进邮件已排队待审批" : ""}`);
  saveState();
  showQuoteDoc(quote);
  render();
}

// 报价单纯文本版：直接粘进回信正文。
// forEmail 时标题不用全大写——正文里的全大写词是垃圾邮件评分因子之一，
// 而且预检的全大写检测会给每封报价单挂一个 ⚠（误报多了用户就不看警告了）。
function quoteToText(quote, { forEmail = false } = {}) {
  const t = (upper, title) => (forEmail ? title : upper);
  const head = `${t("QUOTATION", "Quotation")} ${quote.number}
Date: ${quote.createdAt.slice(0, 10)}   Valid: ${quote.validDays} days
To: ${quote.company}${quote.contactName ? " / " + quote.contactName : ""}
Terms: ${quote.incoterm}${quote.port ? " " + quote.port : ""}, ${quote.currency}
`;
  const lines = quote.items
    .map((l, i) => `${i + 1}. ${l.model ? l.model + " " : ""}${l.name} — ${l.qty} ${l.unit} x ${money(l.price)} = ${money(l.qty * l.price)}`)
    .join("\n");
  return `${head}\n${lines}\n\n${t("TOTAL", "Total")}: ${quote.currency} ${money(quote.total)}${quote.note ? `\n\nRemarks: ${quote.note}` : ""}\n\n${state.campaign.senderName}\n${state.campaign.companyName}`;
}

// 报价单历史：生成过的报价随时能再打开、重发、存 PDF
function renderQuotes() {
  const host = elements.quoteManager;
  if (!host) return;
  const rows = state.quotes
    .map((q) => {
      const prospect = state.prospects.find((p) => p.id === q.prospectId);
      // 必须按 quoteId 判，不能按 prospectId——同一客户开第二张单会被误标成已发出，
      // 你看一眼列表以为发过了，实际那张还躺在草稿里
      const sent = state.outbox.some((o) => o.quoteId === q.id && o.status === "已发送");
      const stateLabel = sent
        ? `<span class="pf-badge pf-ok">已发出</span>`
        : q.emailQueuedAt
          ? `<span class="pf-badge pf-warn">待审批</span>`
          : `<span class="pf-badge">未发送</span>`;
      return `
      <div class="product-row">
        <span class="product-cell"><strong>${escapeHtml(q.number)}</strong></span>
        <span class="product-cell grow">${escapeHtml(q.company)}${q.contactName ? ` · ${escapeHtml(q.contactName)}` : ""}</span>
        <span class="product-cell">${escapeHtml(q.currency)} ${money(q.total)}</span>
        <span class="product-cell dim">${escapeHtml(q.createdAt.slice(0, 10))} · ${escapeHtml(q.incoterm)}</span>
        <span class="product-cell">${stateLabel}</span>
        <button class="ghost-button" data-quote-open="${q.id}" type="button"><span>打开</span></button>
        ${prospect ? "" : `<span class="product-cell dim">客户已删除</span>`}
      </div>`;
    })
    .join("");
  host.innerHTML =
    rows || `<div class="empty-state">还没有报价单。客户询价后，在 CRM 点「生成报价单」——生成后可一键发给客户。</div>`;
}

// 报价单一键排进发信队列。
// 明细走正文纯文本而不是 PDF 附件：冷发/半冷发带附件会显著拉低送达率，
// 而报价这封往往是客户询价后的第一封实质回复，进垃圾箱代价最大。
// 要正式 PDF 的场景仍走「打印 / 存 PDF」手工发。
function queueQuoteEmail(quoteId) {
  const quote = state.quotes.find((q) => q.id === quoteId);
  if (!quote) return;
  const prospect = state.prospects.find((p) => p.id === quote.prospectId);
  if (!prospect) {
    addLog(`报价单 ${quote.number} 对应的客户已不在线索池，无法排队发送`);
    return;
  }
  if (!prospect.email) {
    addLog(`${prospect.company} 还没有邮箱：先在潜客详情「AI 找联系人」补全并验证，报价单才能发出`);
    return;
  }
  if (quote.emailQueuedAt) {
    addLog(`报价单 ${quote.number} 已经排过队了，去「发信队列」审批即可（避免重复发送）`);
    navigateTo("automation");
    return;
  }

  const first =
    prospect.contactName && !["待补全", "待确认", "待确认采购角色"].includes(prospect.contactName)
      ? prospect.contactName.split(" ")[0]
      : "Sir or Madam";
  const body = `Dear ${first},

Thank you for your interest. Please find our quotation ${quote.number} below, valid for ${quote.validDays} days from ${quote.createdAt.slice(0, 10)}.

${quoteToText(quote, { forEmail: true })}

Should you wish to adjust quantities or specifications, I would be glad to revise the quotation accordingly. I look forward to your feedback.

${UNSUBSCRIBE_LINE}`;

  state.outbox.push({
    id: makeId("outbox"),
    prospectId: prospect.id,
    company: prospect.company,
    email: prospect.email,
    label: "报价单",
    step: "报价单",
    quoteId: quote.id, // 按单号而不是客户关联：同一客户可以有多张报价单
    subject: `Quotation ${quote.number} — ${state.campaign.product}`,
    body,
    dueDate: dateOffset(0),
    createdAt: new Date().toISOString(),
    status: "待审批"
  });
  quote.emailQueuedAt = new Date().toISOString();

  // 与开发信同一个闸门：未验证邮箱照样发不出去，这里只是提前把话说清楚
  const last = state.outbox[state.outbox.length - 1];
  const pf = preflightOutboxItem(last);
  addLog(
    pf.ok
      ? `报价单 ${quote.number} 已排进发信队列，去「发信队列」审批后发出`
      : `报价单 ${quote.number} 已排进发信队列，但预检拦下了：${pf.blockers.join("；")}——点 ⛔ 徽章可直接修复`
  );
  saveState();
  if (elements.quoteOverlay) elements.quoteOverlay.hidden = true;
  navigateTo("automation");
  render();
}

function showQuoteDoc(quote) {
  const host = elements.quoteOverlay;
  if (!host) return;
  const rows = quote.items
    .map(
      (l, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(l.model)}</td>
        <td>${escapeHtml(l.name)}</td>
        <td class="num">${l.qty} ${escapeHtml(l.unit)}</td>
        <td class="num">${money(l.price)}</td>
        <td class="num">${money(l.qty * l.price)}</td>
      </tr>`
    )
    .join("");
  host.innerHTML = `
    <div class="panel quote-card quote-doc-wrap" role="dialog" aria-modal="true" aria-label="报价单">
      <div class="quote-doc" id="quotePrintArea">
        <div class="qd-head">
          <div>
            <h1>${escapeHtml(state.campaign.companyName)}</h1>
            <p class="qd-sub">QUOTATION</p>
          </div>
          <div class="qd-meta">
            <p><strong>No.:</strong> ${escapeHtml(quote.number)}</p>
            <p><strong>Date:</strong> ${quote.createdAt.slice(0, 10)}</p>
            <p><strong>Valid:</strong> ${quote.validDays} days</p>
          </div>
        </div>
        <p class="qd-to"><strong>To:</strong> ${escapeHtml(quote.company)}${quote.contactName ? ` — ${escapeHtml(quote.contactName)}` : ""}</p>
        <p class="qd-to"><strong>Terms:</strong> ${escapeHtml(quote.incoterm)}${quote.port ? " " + escapeHtml(quote.port) : ""} · Currency: ${escapeHtml(quote.currency)}</p>
        <table class="qd-table">
          <thead><tr><th>#</th><th>Model</th><th>Description</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="5" class="num"><strong>TOTAL (${escapeHtml(quote.currency)})</strong></td><td class="num"><strong>${money(quote.total)}</strong></td></tr></tfoot>
        </table>
        ${quote.note ? `<p class="qd-note"><strong>Remarks:</strong> ${escapeHtml(quote.note)}</p>` : ""}
        <p class="qd-sign">${escapeHtml(state.campaign.senderName)}<br />${escapeHtml(state.campaign.companyName)}</p>
      </div>
      <div class="quote-actions">
        <button class="primary-button" data-quote-action="send" data-quote-id="${quote.id}" type="button" title="正文内嵌明细排进发信队列，仍需你在批量审批里过目才发出">
          <span>${quote.emailQueuedAt ? "已排队待审批" : "发给客户"}</span>
        </button>
        <button class="ghost-button" data-quote-action="print" type="button"><span>打印 / 存 PDF</span></button>
        <button class="ghost-button" data-quote-action="copy" data-quote-id="${quote.id}" type="button"><span>复制文本版</span></button>
        <button class="ghost-button" data-quote-action="close" type="button"><span>完成</span></button>
      </div>
    </div>
  `;
  host.hidden = false;
}

function copyQuoteText(quoteId, button) {
  const quote = state.quotes.find((q) => q.id === quoteId);
  if (!quote) return;
  const text = quoteToText(quote);
  const done = () => {
    const span = button?.querySelector("span");
    if (span) span.textContent = "已复制 ✓";
    addLog(`报价单 ${quote.number} 文本已复制，可直接粘进回信`);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } catch {}
  ta.remove();
}

/* ---------- 数据分析看板 ---------- */

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 100) : 0;
}

function hashInt(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

function isReplied(prospect) {
  return (
    activeInboundItems().some((m) => m.prospectId === prospect.id) ||
    prospect.status === "已回复" ||
    stageIndex(prospect.dealStage || "线索") >= stageIndex("已回复")
  );
}

function replyChannels(prospect) {
  const fromInbound = [...new Set(activeInboundItems().filter((m) => m.prospectId === prospect.id).map((m) => m.channel))];
  if (fromInbound.length) return fromInbound;
  if (!isReplied(prospect)) return [];
  if (activeOutboxItems().some((o) => o.prospectId === prospect.id)) return ["email"];
  if (activeWhatsappQueueItems().some((w) => w.prospectId === prospect.id)) return ["whatsapp"];
  return [];
}

function simulateChannelCallbacks() {
  const activeIds = activeProspectIdSet();
  const openChance = (id, extra) => {
    const prospect = state.prospects.find((p) => p.id === id);
    const score = prospect?.score || 60;
    return Math.min(88, 38 + Math.round(score * 0.5)) + extra;
  };

  let emailUpdated = 0;
  state.outbox = state.outbox.map((item) => {
    if (item.status !== "已发送" || !activeIds.has(item.prospectId)) return item;
    const h = hashInt(item.prospectId + item.step);
    const delivered = h % 100 < 95;
    const opened = delivered && (h >> 3) % 100 < openChance(item.prospectId, 0);
    emailUpdated += 1;
    return {
      ...item,
      sentAt: item.sentAt || new Date().toISOString(),
      delivered,
      opened
    };
  });

  let whatsappUpdated = 0;
  state.whatsappQueue = state.whatsappQueue.map((item) => {
    if (item.status !== "已发送" || !activeIds.has(item.prospectId)) return item;
    const h = hashInt(item.prospectId + item.step);
    const delivered = h % 100 < 98;
    const read = delivered && (h >> 3) % 100 < openChance(item.prospectId, 12);
    whatsappUpdated += 1;
    return { ...item, delivered, read };
  });

  addLog(
    emailUpdated || whatsappUpdated
      ? `模拟渠道回传：${emailUpdated} 封已发送邮件、${whatsappUpdated} 条已发送 WhatsApp 已更新送达/打开状态`
      : "模拟渠道回传：暂无已发送记录可更新"
  );
  saveState();
  render();
}

function analyticsRangeMs() {
  const range = state.ui?.analyticsRange || "all";
  if (range === "7d") return 7 * 86400000;
  if (range === "30d") return 30 * 86400000;
  return null;
}

function inAnalyticsRange(ts) {
  const ms = analyticsRangeMs();
  if (!ms) return true;
  return ts >= Date.now() - ms && ts <= Date.now() + 86400000;
}

function axOutbox() {
  return activeOutboxItems().filter((o) => inAnalyticsRange(toTime(o.sentAt || o.createdAt || o.dueDate)));
}

function axWa() {
  return activeWhatsappQueueItems().filter((w) => inAnalyticsRange(toTime(w.sentAt || w.createdAt || w.dueDate)));
}

function axInbound() {
  return activeInboundItems().filter((m) => inAnalyticsRange(toTime(m.at || m.time)));
}

function axReplied(prospect) {
  if (!analyticsRangeMs()) return isReplied(prospect);
  return axInbound().some((m) => m.prospectId === prospect.id);
}

function computeFunnel() {
  const prospects = activeProspects();
  const outbox = axOutbox();
  const wa = axWa();
  const reached = prospects.filter(
    (p) => outbox.some((o) => o.prospectId === p.id) || wa.some((w) => w.prospectId === p.id)
  );
  const delivered = reached.filter(
    (p) =>
      outbox.some((o) => o.prospectId === p.id && o.delivered) ||
      wa.some((w) => w.prospectId === p.id && w.delivered)
  );
  const opened = reached.filter(
    (p) =>
      outbox.some((o) => o.prospectId === p.id && o.opened) ||
      wa.some((w) => w.prospectId === p.id && w.read)
  );
  const replied = reached.filter(axReplied);
  const inquiry = prospects.filter((p) => stageIndex(p.dealStage) >= stageIndex("询盘"));
  // 前段获客阶段（合并原「线索阶段漏斗」）：线索总数 → 有联系方式
  const contactable = prospects.filter((p) => emailLooksValid(p.email) || p.phone);
  return {
    total: prospects.length,
    contactable: contactable.length,
    reached: reached.length,
    delivered: delivered.length,
    opened: opened.length,
    replied: replied.length,
    inquiry: inquiry.length
  };
}

function renderAnalytics() {
  if (elements.analyticsRange) {
    const active = state.ui?.analyticsRange || "all";
    elements.analyticsRange.querySelectorAll("[data-range]").forEach((segment) => {
      segment.classList.toggle("is-active", segment.dataset.range === active);
    });
  }
  renderAnalyticsScope();
  const funnel = computeFunnel();
  renderAnalyticsInsight(funnel);
  renderAnalyticsKpis(funnel);
  renderAnalyticsFunnel(funnel);
  renderChannelCompare();
  renderRelayImpact();
  renderMarketPerformance();
  renderTemplateRank();
  renderSubjectAb();
}

/* 分析页的口径必须写在页面上。
   这里全程按当前活动过滤——不同产品、不同市场的回复率混成一个数字没有意义，
   所以按活动分是对的。但页面原来只写「数据分析看板」，一个字没提范围，
   用户会当成全局数据读；收件箱和 CRM 改成跨活动之后更容易对不上
   （CRM 显示 2 个客户、这里只算 1 个），必须说清楚差在哪。 */
function renderAnalyticsScope() {
  const host = elements.analyticsScope;
  if (!host) return;
  const name = typeof activeCampaignName === "function" ? activeCampaignName() : "";
  const total = (state.prospects || []).length;
  const scoped = activeProspects().length;
  const others = Math.max(0, total - scoped);
  host.textContent =
    `本页只统计当前活动${name ? `「${name}」` : ""}的 ${scoped} 条线索` +
    (others ? `，另有 ${others} 条属于其他活动、不计入本页。` : "。") +
    `不同产品与市场的回复率混算没有意义，所以分析按活动分开；收件箱与 CRM 则是跨活动的。`;
}

// 效果闭环提示：把"哪个市场/话术回复率最高 + 有多少客户该跟进"变成一句可执行结论
function renderAnalyticsInsight(funnel) {
  if (!elements.analyticsInsight) return;
  const outbox = axOutbox();
  const wa = axWa();

  // 退信率：保护发信域名的第一信号。样本够且偏高时红字警告先停量
  const sentItems = outbox.filter((o) => o.status === "已发送");
  const bouncedN = sentItems.filter((o) => o.bounced).length;
  const bounceRate = pct(bouncedN, sentItems.length);
  const bounceWarn =
    sentItems.length >= 10 && bounceRate >= 5
      ? `<div class="bounce-warn">⚠ 退信率 <strong>${bounceRate}%</strong>（${bouncedN}/${sentItems.length}）偏高——建议先暂停放量，检查邮箱验证质量与发信域名设置；退信率高会拖垮送达、伤域名信誉。</div>`
      : bouncedN
        ? `<div class="insight-sub">已回传退信 ${bouncedN} 封（率 ${bounceRate}%），相关邮箱已自动拉黑。</div>`
        : "";

  // 回复率最高的市场（至少触达 2 家才纳入，避免小样本噪音）
  const prospects = activeProspects();
  const markets = [...new Set(prospects.map((p) => p.market))];
  const marketStats = markets
    .map((market) => {
      const list = prospects.filter((p) => p.market === market);
      const reached = list.filter((p) => outbox.some((o) => o.prospectId === p.id) || wa.some((w) => w.prospectId === p.id)).length;
      const replied = list.filter(axReplied).length;
      return { market, reached, replied, rate: pct(replied, reached) };
    })
    .filter((m) => m.reached >= 2)
    .sort((a, b) => b.rate - a.rate || b.replied - a.replied);
  const bestMarket = marketStats[0];

  // 回复率最高的话术
  const repliedIds = new Set(prospects.filter(axReplied).map((p) => p.id));
  const buckets = new Map();
  [...outbox, ...wa].forEach((item) => {
    if (!buckets.has(item.label)) buckets.set(item.label, { recipients: new Set(), replied: new Set() });
    const b = buckets.get(item.label);
    b.recipients.add(item.prospectId);
    if (repliedIds.has(item.prospectId)) b.replied.add(item.prospectId);
  });
  const scriptStats = [...buckets.entries()]
    .map(([label, b]) => ({ label, sent: b.recipients.size, replied: b.replied.size, rate: pct(b.replied.size, b.recipients.size) }))
    .filter((s) => s.sent >= 2)
    .sort((a, b) => b.rate - a.rate || b.sent - a.sent);
  const bestScript = scriptStats[0];

  const dueN = dueFollowupProspects().length;

  const parts = [];
  if (bestMarket) parts.push(`回复率最高的市场：<strong>${escapeHtml(bestMarket.market)}</strong>（${bestMarket.rate}%，${bestMarket.replied}/${bestMarket.reached}）`);
  if (bestScript) parts.push(`最有效话术：<strong>${escapeHtml(bestScript.label)}</strong>（${bestScript.rate}%）`);

  // 优先联系名单：按机会排序（已回复 > 已打开 > 高分），告诉你今天先追谁
  const priority = priorityProspects(5);
  const priorityHtml = priority.length
    ? `
      <div class="priority-list">
        <p class="eyebrow">优先联系 · 按机会排序</p>
        ${priority
          .map(
            (x, i) => `
            <button class="priority-row" data-priority="${x.p.id}" type="button">
              <span class="priority-rank">${i + 1}</span>
              <span class="priority-name"><strong>${escapeHtml(x.p.company)}</strong><small>${escapeHtml(x.p.market)}</small></span>
              <span class="priority-tags">${
                x.replied ? `<span class="ptag hot">🔥 已回复</span>` : x.opened ? `<span class="ptag warm">👁 已打开</span>` : ""
              }<span class="ptag">${x.lead.grade} · ${x.lead.probability}%</span></span>
            </button>`
          )
          .join("")}
      </div>`
    : "";

  if (!parts.length && !dueN && !priority.length && !bounceWarn) {
    elements.analyticsInsight.innerHTML = `<span class="insight-hint">先触达并积累回复数据，这里会告诉你哪个市场/话术成功率最高、该优先追谁、以及给谁发跟进。</span>`;
    return;
  }

  const action = dueN
    ? `<button class="primary-button" id="insightFollowup" type="button"><svg><use href="#icon-shuffle" /></svg><span>一键批量跟进 (${dueN})</span></button>`
    : "";
  elements.analyticsInsight.innerHTML = `
    ${bounceWarn}
    <div class="insight-text">💡 ${parts.join(" · ") || "已有触达数据"}${dueN ? ` · <strong>${dueN}</strong> 位客户到期未回复，该跟进了` : ""}</div>
    ${action}
    ${priorityHtml}
  `;
}

// 优先联系名单：只保留有信号（回复/打开）或高分的客户，按机会分排序
function priorityProspects(limit = 5) {
  const inboundBy = new Set(activeInboundItems().map((m) => m.prospectId));
  const openedBy = new Set(axOutbox().filter((o) => o.opened).map((o) => o.prospectId));
  return activeProspects()
    .filter((p) => p.dealStage !== "成交" && p.status !== "已退订")
    .map((p) => {
      const lead = computeLeadScore(p);
      const replied = axReplied(p) || inboundBy.has(p.id);
      const opened = openedBy.has(p.id);
      const score = lead.probability + (replied ? 200 : opened ? 60 : 0);
      return { p, lead, replied, opened, score };
    })
    .filter((x) => x.replied || x.opened || x.lead.probability >= 60)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function renderAnalyticsKpis(funnel) {
  const cards = [
    ["有效询盘 / 月", funnel.inquiry, "北极星指标", true],
    ["触达客户", funnel.reached, "邮件或 WhatsApp 已触达", false],
    ["打开率", `${pct(funnel.opened, funnel.delivered)}%`, "已送达中打开占比", false],
    ["回复率", `${pct(funnel.replied, funnel.reached)}%`, "触达中回复占比", false],
    ["询盘转化率", `${pct(funnel.inquiry, funnel.reached)}%`, "触达到询盘", false]
  ];
  elements.analyticsKpis.innerHTML = cards
    .map(
      ([label, value, hint, star]) => `
        <article class="metric-card ${star ? "is-star" : ""}">
          <p class="eyebrow">${label}</p>
          <strong>${value}</strong>
          <span>${hint}</span>
        </article>
      `
    )
    .join("");
}

function renderAnalyticsFunnel(funnel) {
  // 全流程漏斗：从线索获取到最终询盘，合并了原管理页的「线索阶段漏斗」
  const stages = [
    ["线索", funnel.total],
    ["有联系方式", funnel.contactable],
    ["已入队/触达", funnel.reached],
    ["送达", funnel.delivered],
    ["打开", funnel.opened],
    ["回复", funnel.replied],
    ["询盘", funnel.inquiry]
  ];
  const top = Math.max(1, funnel.total);
  elements.analyticsFunnel.innerHTML = stages
    .map(([label, count], index) => {
      const width = Math.max(3, Math.round((count / top) * 100));
      const prev = index === 0 ? count : stages[index - 1][1];
      const conv = index === 0 ? 100 : pct(count, prev);
      return `
        <div class="funnel-row">
          <span>${label}</span>
          <div class="funnel-bar"><span style="width:${width}%"></span></div>
          <span class="funnel-figure"><strong>${count}</strong> · 环比 ${conv}%</span>
        </div>
      `;
    })
    .join("");
}

function channelStats(channel) {
  const prospects = activeProspects();
  const queue = channel === "email" ? axOutbox() : axWa();
  const openKey = channel === "email" ? "opened" : "read";
  const has = (id) => queue.some((item) => item.prospectId === id);
  const reached = prospects.filter((p) => has(p.id));
  const delivered = reached.filter((p) => queue.some((item) => item.prospectId === p.id && item.delivered));
  const opened = reached.filter((p) => queue.some((item) => item.prospectId === p.id && item[openKey]));
  const replied = reached.filter((p) =>
    analyticsRangeMs()
      ? axInbound().some((m) => m.prospectId === p.id && m.channel === channel)
      : replyChannels(p).includes(channel)
  );
  return {
    reached: reached.length,
    delivered: delivered.length,
    opened: opened.length,
    replied: replied.length
  };
}

function renderChannelCompare() {
  const blocks = [
    ["email", "邮件", "打开"],
    ["whatsapp", "WhatsApp", "已读"]
  ];
  elements.channelCompare.innerHTML = blocks
    .map(([channel, name, openLabel]) => {
      const stat = channelStats(channel);
      const rows = [
        ["触达", stat.reached, stat.reached],
        ["送达", stat.delivered, stat.reached],
        [openLabel, stat.opened, stat.reached],
        ["回复", stat.replied, stat.reached]
      ];
      const rowsHtml = rows
        .map(
          ([label, value, base]) => `
            <div class="channel-metric">
              <span>${label}</span>
              <div class="mini-bar ${channel}"><span style="width:${Math.max(2, pct(value, base))}%"></span></div>
              <strong>${value}</strong>
            </div>
          `
        )
        .join("");
      return `
        <div class="channel-block">
          <div class="channel-block-head">
            <span class="channel-badge ${channel}">${name}</span>
            <span class="score">回复率 ${pct(stat.replied, stat.reached)}%</span>
          </div>
          ${rowsHtml}
        </div>
      `;
    })
    .join("");
}

function renderRelayImpact() {
  const prospects = activeProspects();
  const outbox = axOutbox();
  const wa = axWa();
  const hasEmail = (id) => outbox.some((o) => o.prospectId === id);
  const hasWa = (id) => wa.some((w) => w.prospectId === id);

  const dual = prospects.filter((p) => hasEmail(p.id) && hasWa(p.id));
  const single = prospects.filter((p) => (hasEmail(p.id) || hasWa(p.id)) && !(hasEmail(p.id) && hasWa(p.id)));
  const dualRate = pct(dual.filter(axReplied).length, dual.length);
  const singleRate = pct(single.filter(axReplied).length, single.length);

  let liftNote;
  if (!dual.length && !single.length) liftNote = "先触达客户并运行接力后查看对比";
  else if (!single.length) liftNote = "本批客户已全部双渠道覆盖";
  else if (!singleRate) liftNote = dualRate ? "双渠道接力回复率显著高于单渠道" : "样本较小，继续触达后更准确";
  else liftNote = `双渠道接力回复率约为单渠道的 ${(dualRate / singleRate).toFixed(1)} 倍`;

  elements.relayImpact.innerHTML = `
    <div class="impact-row">
      <span>单渠道回复率<br /><small>${single.length} 个客户</small></span>
      <strong>${singleRate}%</strong>
    </div>
    <div class="impact-row">
      <span>双渠道接力回复率<br /><small>${dual.length} 个客户</small></span>
      <strong>${dualRate}%</strong>
    </div>
    <div class="impact-lift">${liftNote}</div>
  `;
}

function renderMarketPerformance() {
  const prospects = activeProspects();
  const markets = [...new Set(prospects.map((p) => p.market))];
  if (!markets.length) {
    elements.marketPerformance.innerHTML = `<div class="empty-state">暂无数据</div>`;
    return;
  }

  const outbox = axOutbox();
  const wa = axWa();
  const rows = markets
    .map((market) => {
      const list = prospects.filter((p) => p.market === market);
      const reached = list.filter(
        (p) => outbox.some((o) => o.prospectId === p.id) || wa.some((w) => w.prospectId === p.id)
      ).length;
      const replied = list.filter(axReplied).length;
      const inquiry = list.filter((p) => stageIndex(p.dealStage) >= stageIndex("询盘")).length;
      return { market, touched: reached, replied, inquiry, rate: pct(replied, reached) };
    })
    .sort((a, b) => b.rate - a.rate || b.replied - a.replied);

  elements.marketPerformance.innerHTML = `
    <div class="market-row header">
      <span>市场</span><span>触达</span><span>回复</span><span>询盘</span><span>回复率</span>
    </div>
    ${rows
      .map(
        (row) => `
          <div class="market-row">
            <span>${escapeHtml(row.market)}</span>
            <span>${row.touched}</span>
            <span>${row.replied}</span>
            <span>${row.inquiry}</span>
            <span>${row.rate}%</span>
          </div>
        `
      )
      .join("")}
  `;
}

function renderTemplateRank() {
  const repliedIds = new Set(activeProspects().filter(axReplied).map((p) => p.id));
  const buckets = new Map();
  const add = (channel, label, prospectId) => {
    const key = `${channel}|${label}`;
    if (!buckets.has(key)) buckets.set(key, { channel, label, recipients: new Set(), replied: new Set() });
    const bucket = buckets.get(key);
    bucket.recipients.add(prospectId);
    if (repliedIds.has(prospectId)) bucket.replied.add(prospectId);
  };

  axOutbox().forEach((item) => add("email", item.label, item.prospectId));
  axWa().forEach((item) => add("whatsapp", item.label, item.prospectId));

  const rows = [...buckets.values()]
    .map((bucket) => ({
      channel: bucket.channel,
      label: bucket.label,
      sent: bucket.recipients.size,
      replied: bucket.replied.size,
      rate: pct(bucket.replied.size, bucket.recipients.size)
    }))
    .sort((a, b) => b.rate - a.rate || b.sent - a.sent)
    .slice(0, 8);

  if (!rows.length) {
    elements.templateRank.innerHTML = `<div class="empty-state">先在「邮件」「WhatsApp」里把话术加入队列</div>`;
    return;
  }

  elements.templateRank.innerHTML = `
    <div class="template-row header">
      <span>话术模板</span><span>发送</span><span>回复</span><span>回复率</span>
    </div>
    ${rows
      .map(
        (row) => `
          <div class="template-row">
            <span class="template-name"><span class="channel-badge ${row.channel}">${row.channel === "email" ? "邮件" : "WA"}</span> ${escapeHtml(row.label)}</span>
            <span>${row.sent}</span>
            <span>${row.replied}</span>
            <span class="rate-bar"><span style="width:${Math.max(3, row.rate)}%"></span></span>
          </div>
        `
      )
      .join("")}
  `;
}

/* ---------- 首封主题行 A/B ----------
   只统计已发出的首封（未发的算进去会稀释分母）。样本不足时明确说"还看不出来"，
   不给结论——小样本上的百分比差异基本都是噪声，据此改话术是负收益。 */
const AB_MIN_PER_VARIANT = 20; // 每个变体至少这么多封才敢下结论

function subjectAbStats() {
  const repliedIds = new Set(activeProspects().filter(axReplied).map((p) => p.id));
  const stats = { A: { sent: 0, opened: 0, replied: 0 }, B: { sent: 0, opened: 0, replied: 0 } };
  axOutbox()
    .filter((o) => o.status === "已发送" && o.subjectVariant && stats[o.subjectVariant])
    .forEach((o) => {
      const s = stats[o.subjectVariant];
      s.sent += 1;
      if (o.opened) s.opened += 1;
      if (repliedIds.has(o.prospectId)) s.replied += 1;
    });
  return stats;
}

function renderSubjectAb() {
  const host = elements.subjectAb;
  if (!host) return;
  const stats = subjectAbStats();
  const total = stats.A.sent + stats.B.sent;
  // 本地模拟模式下"打开"是按哈希算出来的假数据。展示无妨，但绝不能据此给
  // "把话术往这个方向调"的建议——那等于让用户拿随机数改文案。
  if (state.settings.mode === "local" && total) {
    host.innerHTML = `
      <div class="template-row header"><span>主题写法</span><span>发出</span><span>打开</span><span>回复</span></div>
      <div class="template-row"><span class="template-name"><span class="channel-badge email">A</span> 品类卖点式</span><span>${stats.A.sent}</span><span>${stats.A.opened}</span><span>${stats.A.replied}</span></div>
      <div class="template-row"><span class="template-name"><span class="channel-badge email">B</span> 点名公司提问式</span><span>${stats.B.sent}</span><span>${stats.B.opened}</span><span>${stats.B.replied}</span></div>
      <p class="connector-hint">⚠️ 当前是<b>本地模拟</b>模式，上面的打开与回复是程序生成的假数据，<b>不能据此判断哪种主题更好</b>。切到「直连」或「Webhook」真实发信后，这里才会给出结论。</p>`;
    return;
  }
  if (!total) {
    host.innerHTML = `<div class="empty-state">首封开发信发出后，这里会对比两种主题写法的效果。A＝品类卖点式，B＝点名公司的提问式，按线索稳定分配。</div>`;
    return;
  }
  const rate = (v) => pct(v.replied, v.sent);
  const enough = stats.A.sent >= AB_MIN_PER_VARIANT && stats.B.sent >= AB_MIN_PER_VARIANT;
  const diff = rate(stats.A) - rate(stats.B);
  const verdict = !enough
    ? `<p class="connector-hint">样本还不够（每个变体各需 ${AB_MIN_PER_VARIANT} 封，现在 A ${stats.A.sent} / B ${stats.B.sent}）。这个阶段的百分比差异多半是噪声，先继续发，别急着改话术。</p>`
    : Math.abs(diff) < 3
      ? `<p class="connector-hint">两种写法差异不明显（相差 ${Math.abs(diff)} 个百分点）。主题不是当前瓶颈，把精力放在线索质量或产品聚焦上更划算。</p>`
      : `<p class="connector-hint">✅ <b>${diff > 0 ? "A（品类卖点式）" : "B（点名公司提问式）"}</b> 回复率高 ${Math.abs(diff)} 个百分点。可以把另一种的写法往这个方向调。</p>`;

  const row = (key, name, v) => `
    <div class="template-row">
      <span class="template-name"><span class="channel-badge email">${key}</span> ${name}</span>
      <span>${v.sent}</span>
      <span>${v.opened}</span>
      <span>${v.replied}</span>
      <span class="rate-bar"><span style="width:${Math.max(3, rate(v))}%"></span></span>
    </div>`;

  host.innerHTML = `
    <div class="template-row header">
      <span>主题写法</span><span>发出</span><span>打开</span><span>回复</span><span>回复率</span>
    </div>
    ${row("A", "品类卖点式", stats.A)}
    ${row("B", "点名公司提问式", stats.B)}
    ${verdict}
  `;
}

function exportAnalytics() {
  const funnel = computeFunnel();
  const email = channelStats("email");
  const wa = channelStats("whatsapp");
  const rows = [
    { metric: "触达客户", value: funnel.reached },
    { metric: "送达", value: funnel.delivered },
    { metric: "打开", value: funnel.opened },
    { metric: "回复", value: funnel.replied },
    { metric: "有效询盘", value: funnel.inquiry },
    { metric: "回复率(%)", value: pct(funnel.replied, funnel.reached) },
    { metric: "询盘转化率(%)", value: pct(funnel.inquiry, funnel.reached) },
    { metric: "邮件回复率(%)", value: pct(email.replied, email.reached) },
    { metric: "WhatsApp回复率(%)", value: pct(wa.replied, wa.reached) }
  ];
  download("analytics-metrics.csv", toCsv(rows), "text/csv");
}

function renderManagement() {
  refreshManagementDerivedData();
  renderManagementKpis();
  renderCampaignManager();
  renderJobBoard();
  renderApprovalCenter();
  renderAccountManager();
}

// 按活动实时统计（线索按 campaignId 归属，队列/回复据其线索反查）
function campaignStats(id) {
  const leads = state.prospects.filter((p) => (p.campaignId || null) === id);
  const ids = new Set(leads.map((l) => l.id));
  const queued =
    state.outbox.filter((o) => ids.has(o.prospectId)).length +
    state.whatsappQueue.filter((w) => ids.has(w.prospectId)).length;
  const replies = leads.filter((l) => l.status === "已回复").length;
  const stage = queued ? "触达中" : leads.length ? "采集中" : "待启动";
  const status = leads.length ? "运行中" : "草稿";
  return { prospects: leads.length, queued, replies, stage, status };
}

function sidebarProjectMeta(campaign, stats) {
  if (!campaign) return "未配置";
  const product = (campaign.product || "").trim() || "未填写产品";
  const markets = normalizeMarkets(campaign.markets || "").slice(0, 2).join(", ") || "未选市场";
  const activity = stats.replies
    ? `${stats.replies} 回复`
    : stats.queued
      ? `${stats.queued} 触达`
      : stats.prospects
        ? `${stats.prospects} 线索`
        : "草稿";
  return `${product} · ${markets} · ${activity}`;
}

function renderSidebarProjects() {
  const host = elements.sidebarProjectList;
  if (!host) return;
  const list = state.management?.campaigns || [];
  if (!list.length) {
    host.innerHTML = `<div class="sidebar-project-empty">暂无项目</div>`;
    return;
  }

  const activeId = state.activeCampaignId;
  const active = list.find((campaign) => campaign.id === activeId);
  const ordered = [active, ...list.filter((campaign) => campaign.id !== activeId)].filter(Boolean).slice(0, 6);
  host.innerHTML =
    ordered
      .map((campaign) => {
        const stats = campaignStats(campaign.id);
        const activeClass = campaign.id === activeId ? " is-active" : "";
        return `
          <button class="sidebar-project${activeClass}" data-sidebar-campaign="${campaign.id}" type="button" title="切换到 ${escapeHtml(campaign.name || "未命名项目")}">
            <span class="sidebar-project-dot" aria-hidden="true"></span>
            <span class="sidebar-project-copy">
              <strong>${escapeHtml(campaign.name || "未命名项目")}</strong>
              <small>${escapeHtml(sidebarProjectMeta(campaign, stats))}</small>
            </span>
            <span class="sidebar-project-count" title="线索数">${stats.prospects}</span>
          </button>
        `;
      })
      .join("") +
    (list.length > ordered.length
      ? `<button class="sidebar-project-more" data-sidebar-project-manage="1" type="button">还有 ${list.length - ordered.length} 个项目</button>`
      : "");
}

function refreshManagementDerivedData() {
  // 把当前编辑中的配置同步回选中的活动（保证活动列表里显示的是最新配置）
  const activeCampaign = getActiveManagedCampaign();
  if (activeCampaign) {
    activeCampaign.product = state.campaign.product;
    activeCampaign.markets = state.campaign.markets;
    activeCampaign.customerType = state.campaign.customerType;
    activeCampaign.valueProps = state.campaign.valueProps;
    activeCampaign.certifications = state.campaign.certifications;
    activeCampaign.owner = state.campaign.senderName;
    activeCampaign.companyName = state.campaign.companyName;
    activeCampaign.dailyLimit = state.campaign.dailyLimit;
    activeCampaign.presetKey = state.campaign.presetKey || null;
    activeCampaign.focusProduct = state.campaign.focusProduct || "";
    activeCampaign.productTerms = state.campaign.productTerms || [];
    activeCampaign.hsCode = state.campaign.hsCode || "";
    activeCampaign.buyerHint = state.campaign.buyerHint || "";
  }
}

function getActiveManagedCampaign() {
  return (
    state.management.campaigns.find((campaign) => campaign.id === state.activeCampaignId) ||
    state.management.campaigns[0] ||
    null
  );
}

// 审批中心：从真实待办实时汇总，每项可点击直达对应页面
function realApprovals() {
  const outbox = activeOutboxItems();
  const whatsappQueue = activeWhatsappQueueItems();
  const agentPending = activeAgentApprovals().filter((a) => a.status === "pending").length;
  // 两条邮件分类必须正好把「待审批 + 待发送」切干净，否则会漏。
  // 原来 ap-draft 要求 status==="待审批" 且 reply，ap-send 要求 !reply，
  // 于是「已批准待发的 AI 回信草稿」（待发送 + reply）两边都不算，管理徽标比触达队列少。
  const actionable = outbox.filter((o) => ["待审批", "待发送"].includes(o.status));
  const emailDrafts = actionable.filter((o) => o.status === "待审批" && o.reply).length;
  const waPending = whatsappQueue.filter((w) => w.status === "待人工确认").length;
  const emailReady = actionable.length - emailDrafts;
  return [
    { id: "ap-agent", type: "Agent", title: "Agent 触达卡待审批", count: agentPending, goto: "agent" },
    { id: "ap-draft", type: "AI 草稿", title: "AI 回复草稿待审批", count: emailDrafts, goto: "automation" },
    { id: "ap-wa", type: "WhatsApp", title: "WhatsApp 待人工确认", count: waPending, goto: "whatsapp" },
    { id: "ap-send", type: "邮件", title: "邮件待批量审批发送", count: emailReady, goto: "automation" }
  ];
}

// 渠道账号：真实反映 Webhook 配置/测试状态与今日实际用量
function connectorHealth(name) {
  if (!(state.settings.mode === "webhook" && webhookUrl(name))) return "本地模拟";
  const st = state.settings.webhookStatus?.[name];
  if (!st) return "已接入·未测";
  return st.ok ? "正常" : "异常";
}

function realAccounts() {
  const today = dateOffset(0);
  const waSentToday = state.whatsappQueue.filter(
    (w) => w.status === "已发送" && (w.sentAt || "").slice(0, 10) === today
  ).length;
  return [
    { channel: "Email", name: connectorHealth("send") === "本地模拟" ? "本地模拟发送" : "发信 Webhook", health: connectorHealth("send"), used: sentTodayCount(), limit: state.management.rules.emailDailyLimit },
    { channel: "WhatsApp", name: connectorHealth("whatsapp") === "本地模拟" ? "本地待确认队列" : "WhatsApp Webhook", health: connectorHealth("whatsapp"), used: waSentToday, limit: state.management.rules.whatsappDailyLimit },
    { channel: "Search API", name: connectorHealth("search") === "本地模拟" ? "本地/手动导入" : "采集 Webhook", health: connectorHealth("search"), used: null, limit: null },
    { channel: "CRM", name: connectorHealth("crm") === "本地模拟" ? "本地看板" : "CRM Webhook", health: connectorHealth("crm"), used: null, limit: null }
  ];
}

function renderManagementKpis() {
  const pendingApprovals = realApprovals().reduce((sum, item) => sum + item.count, 0);
  const liveAccounts = realAccounts().filter((a) => a.health !== "异常").length;
  const kpis = [
    ["活动", state.management.campaigns.length, "正在管理的开发活动"],
    ["线索总数", state.prospects.length, "全部活动累计线索"],
    ["待审批", pendingApprovals, "需要人工确认/发送"],
    ["渠道", liveAccounts, "在线渠道/接口"],
    ["最低评分", state.management.rules.scoreThreshold, "低于此分不自动发送"]
  ];

  elements.managementKpis.innerHTML = kpis
    .map(
      ([label, value, hint]) => `
        <article class="metric-card">
          <p class="eyebrow">${label}</p>
          <strong>${value}</strong>
          <span>${hint}</span>
        </article>
      `
    )
    .join("");
}

const PRESET_LABEL = { moto: "摩托车", auto: "汽配", electronics: "电子", machinery: "机械" };

function renderCampaignManager() {
  elements.campaignManager.innerHTML = `
    <div class="management-row header campaign-head">
      <span>活动</span>
      <span>市场</span>
      <span>阶段</span>
      <span>线索</span>
      <span>队列</span>
      <span>回复</span>
      <span>操作</span>
    </div>
    ${state.management.campaigns
      .map((campaign) => {
        const st = campaignStats(campaign.id);
        const active = campaign.id === state.activeCampaignId;
        const presetTag = campaign.presetKey ? `<span class="tag">${PRESET_LABEL[campaign.presetKey] || campaign.presetKey}</span>` : "";
        return `
          <div class="management-row campaign-row ${active ? "is-selected" : ""}">
            <button class="campaign-open" data-campaign-id="${campaign.id}" type="button" title="切换到该活动（整套配置恢复到控制台）">
              <span class="company-name">${escapeHtml(campaign.name)} ${active ? '<span class="tag tag-live">当前</span>' : ""}</span>
              <span class="company-meta">${escapeHtml(campaign.product)} · ${escapeHtml(campaign.owner || "未署名")} ${presetTag}</span>
            </button>
            <span>${escapeHtml(campaign.markets)}</span>
            <span><span class="tag">${st.stage}</span></span>
            <span>${st.prospects}</span>
            <span>${st.queued}</span>
            <span>${st.replies}</span>
            <span class="campaign-actions">
              <button class="icon-button" data-campaign-rename="${campaign.id}" type="button" title="重命名" aria-label="重命名">✎</button>
              <button class="icon-button" data-campaign-delete="${campaign.id}" type="button" title="删除活动" aria-label="删除"${state.management.campaigns.length <= 1 ? " disabled" : ""}>🗑</button>
            </span>
          </div>
        `;
      })
      .join("")}
  `;
}

function renderJobBoard() {
  elements.jobBoard.innerHTML = state.management.jobs
    .map(
      (job) => `
        <article class="job-card">
          <div>
            <strong>${escapeHtml(job.name)}</strong>
            <span>${escapeHtml(job.cadence)} · 下次 ${escapeHtml(job.nextRun)}</span>
          </div>
          <div class="job-progress">
            <span style="width:${job.progress}%"></span>
          </div>
          <span class="badge">${escapeHtml(job.status)}</span>
        </article>
      `
    )
    .join("");
}

function renderApprovalCenter() {
  const all = realApprovals();
  const total = all.reduce((s, i) => s + i.count, 0);
  // 有数的排前面：四类里常常只有一类非零，固定顺序会把唯一有内容的那张压到最下面，
  // 用户看到的前几张全是 0，就以为"这里没东西"。
  const items = [...all].sort((a, b) => b.count - a.count);
  // 页面上明说这里只是总览。红点只出现在能动手的那个页面，管理页不出红点，
  // 所以这块要说清楚"活在别处"，否则用户会在这里等着操作。
  const where = { automation: "触达队列", agent: "Agent", whatsapp: "触达队列" };
  const note =
    total === 0
      ? ""
      : `<p class="approval-note" style="grid-column:1/-1">这里是<strong>跨页总览</strong>，不在这儿操作——${items
          .filter((i) => i.count)
          .map((i) => `${escapeHtml(i.title)} ${i.count} 条在「${where[i.goto] || i.goto}」`)
          .join("，")}。左侧红点也只标在那些页面上。点下面任一张卡片直接过去处理。</p>`;
  elements.approvalCenter.innerHTML =
    (total === 0 ? `<div class="empty-state" style="grid-column:1/-1">暂无待审批事项 ✓</div>` : note) +
    items
      .map(
        (item) => `
        <button class="approval-card ${item.count ? "" : "is-empty"}" data-goto="${item.goto}" type="button" title="点击前往处理">
          <span>
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.type)}${item.count ? " · 点击前往处理" : ""}</span>
          </span>
          <span class="badge ${item.count ? "badge-alert" : ""}">${item.count}</span>
        </button>
      `
      )
      .join("");
}

function renderAccountManager() {
  elements.accountManager.innerHTML = realAccounts()
    .map((account) => {
      const hasQuota = account.limit != null;
      const usage = hasQuota ? Math.min(100, Math.round((account.used / Math.max(account.limit, 1)) * 100)) : 0;
      const healthClass = account.health === "异常" ? "health-bad" : account.health === "正常" ? "health-ok" : "health-soft";
      return `
        <article class="account-card">
          <div>
            <strong>${escapeHtml(account.channel)}</strong>
            <span>${escapeHtml(account.name)} · <span class="${healthClass}">${escapeHtml(account.health)}</span></span>
          </div>
          <div class="job-progress"><span style="width:${usage}%"></span></div>
          <span>${hasQuota ? `今日 ${account.used}/${account.limit}` : "—"}</span>
        </article>
      `;
    })
    .join("");
}

/* 市场别名：客户官网上写的往往不是国家全称，而是简称或主要城市。
   只搜 "UAE" 会漏掉满页写 Dubai / Sharjah 的经销商。只给差异明显的市场配别名。 */
const MARKET_ALIASES = {
  "united arab emirates": ["UAE", "Dubai", "Sharjah", "Abu Dhabi"],
  uae: ["UAE", "Dubai", "Sharjah", "Abu Dhabi"],
  "united states": ["USA", "United States"],
  usa: ["USA", "United States"],
  us: ["USA", "United States"],
  "united kingdom": ["UK", "United Kingdom"],
  uk: ["UK", "United Kingdom"],
  "saudi arabia": ["Saudi Arabia", "KSA", "Riyadh"],
  "south korea": ["South Korea", "Korea"],
  netherlands: ["Netherlands", "Holland"]
};

function marketSearchExpr(market) {
  const alias = MARKET_ALIASES[String(market || "").trim().toLowerCase()];
  return alias ? `(${alias.map((a) => `"${a}"`).join(" OR ")})` : `"${market}"`;
}

function generateSearchPlan(campaign) {
  const product = campaign.product.trim();
  const productExpr = productSearchExpr(campaign); // 聚焦具体产品时是 ("a" OR "b") 同义词组
  const markets = normalizeMarkets(campaign.markets);
  const intent = buildCustomerSearchTerms(campaign.customerType);
  const prof = campaign.productProfile || {};
  /* 排除项只放"整站都不是客户"的域名，不放描述性词组。
     实测教训：把 AI 生成的产品排除词写成 -"tire manufacturer" 这种否定词组，
     既拦不住真正想排除的厂商（Continental / Dunlop 的页面未必出现那个确切词组），
     又会误伤真目标——分销商官网上常常大量出现厂商名和"manufacturer"字样。
     这类词只用于线索评分，不该进 Google 查询。 */
  const SOCIAL_NEG = "-site:facebook.com -site:instagram.com -site:youtube.com -site:pinterest.com -site:reddit.com -site:tiktok.com -site:x.com";
  const PLATFORM_NEG = "-alibaba -amazon -made-in-china -globalsources -temu -shein";
  // 市场研究报告站会大量占据结果位，且永远不是客户
  const REPORT_NEG = '-"market research" -"market size" -"industry report" -"forecast to 20"';
  const exclusions = `${PLATFORM_NEG} ${SOCIAL_NEG} ${REPORT_NEG}`;
  const patterns = [
    {
      channel: "Google",
      intent: "找真实进口商/分销商官网",
      priority: "P1",
      nextAction: "打开官网，找 About/Brands/Contact/Wholesale 页面",
      // 不加 "contact"：每个网站都有 Contact Us，没有任何区分度，白占一个 AND 约束
      build: (market) => `${productExpr} (${intent.buyers}) ${marketSearchExpr(market)} ${exclusions}`
    },
    {
      channel: "Google",
      intent: "找批发目录和经销商列表",
      priority: "P1",
      nextAction: "把目录里的公司官网粘贴到导入框",
      build: (market) => `${productExpr} ${marketSearchExpr(market)} ("distributor list" OR "wholesale directory" OR "stockist") ${exclusions}`
    },
    {
      channel: "Google",
      intent: "找采购/品类负责人",
      priority: "P1",
      nextAction: "记录公司名、负责人职位、邮箱或 LinkedIn",
      build: (market) => `${productExpr} ${marketSearchExpr(market)} ("sourcing manager" OR "buyer" OR "category manager" OR "procurement") ${exclusions}`
    },
    {
      channel: "LinkedIn",
      intent: "找公司主页和采购角色",
      priority: "P2",
      nextAction: "复制公司页 URL 或公司官网",
      build: (market) => `site:linkedin.com/company ${productExpr} ${marketSearchExpr(market)} (${intent.buyers})`
    },
    {
      channel: "Retail",
      intent: "找零售商/品牌商采购入口",
      priority: "P2",
      nextAction: "找 vendor/supplier application 页面",
      build: (market) => `${productExpr} ${marketSearchExpr(market)} ("vendor application" OR "supplier application" OR "become a supplier") ${exclusions}`
    },
    {
      channel: "Association",
      intent: "找协会会员名录",
      priority: "P2",
      nextAction: "导入会员公司名录",
      build: (market) => `${productExpr} ${marketSearchExpr(market)} ("member directory" OR "association members" OR "trade association")`
    },
    {
      channel: "Customs Data",
      intent: "找有进口记录的买家线索",
      priority: "P3",
      nextAction: "用海关数据服务核验真实进口商",
      build: (market) => `${productExpr} ${marketSearchExpr(market)} ("importer" OR "bill of lading" OR "import data") ${exclusions}`
    },
    {
      channel: "Competitor",
      intent: "找竞品渠道和经销商",
      priority: "P3",
      nextAction: "从竞品 Where to buy/Dealer 页面反查客户",
      build: (market) => `${productExpr} ${marketSearchExpr(market)} ("where to buy" OR "dealer locator" OR "authorized distributor") ${exclusions}`
    }
  ];

  // 买家段：每个细分买家段一条专门搜索式（P1，最精准）
  (prof.segments || []).slice(0, 4).forEach((seg) => {
    const segExpr = (seg.terms || []).length ? `(${seg.terms.slice(0, 3).map((t) => `"${t}"`).join(" OR ")})` : "";
    if (!segExpr) return;
    patterns.push({
      channel: "买家段",
      intent: `按买家段找：${seg.name}`,
      priority: "P1",
      nextAction: "打开官网核验是否采购该产品，再入池",
      build: (market) => `${productExpr} ${segExpr} ${marketSearchExpr(market)} ${exclusions}`
    });
  });

  // 终端用途/关联品：买家常按用途而非零件名采购，多撒一网（P2）
  const endUse = (prof.endUseTerms || []).slice(0, 4);
  if (endUse.length) {
    patterns.push({
      channel: "终端用途",
      intent: "按终端用途/关联品找买家",
      priority: "P2",
      nextAction: "从用途页面找采购这类产品的店/商",
      build: (market) => `(${endUse.map((t) => `"${t}"`).join(" OR ")}) ${marketSearchExpr(market)} ${exclusions}`
    });
  }

  return markets.flatMap((market) =>
    patterns.map((pattern) => {
      const query = pattern.build(market);
      return {
        id: makeId("query"),
        channel: pattern.channel,
        market,
        intent: pattern.intent,
        priority: pattern.priority,
        nextAction: pattern.nextAction,
        query,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`
      };
    })
  );
}

function buildCustomerSearchTerms(customerType) {
  if (customerType.includes("retailer")) {
    return { buyers: '"retailer" OR "chain store" OR "category buyer" OR "vendor application"' };
  }
  if (customerType.includes("brand")) {
    return { buyers: '"private label" OR "brand owner" OR "product manager" OR "sourcing"' };
  }
  if (customerType.includes("wholesaler")) {
    return { buyers: '"wholesaler" OR "distributor" OR "trade supplier" OR "stockist"' };
  }
  if (customerType.includes("contractor")) {
    return { buyers: '"project buyer" OR "contractor" OR "procurement" OR "building supply"' };
  }
  // "authorized/official distributor" 实测最有效：厂商官网不会这么写，真经销商会
  return { buyers: '"importer" OR "authorized distributor" OR "official distributor" OR "wholesaler" OR "stockist"' };
}

function generateProspects(campaign, targetCount = 18, salt = "") {
  const markets = normalizeMarkets(campaign.markets);
  const productNoun = getProductNoun(campaign.product);
  const perMarket = Math.max(4, Math.ceil(targetCount / Math.max(markets.length, 1)));
  const prefixes = ["Atlas", "Northstar", "Prime", "Summit", "Blueport", "Harbor", "Apex", "Metro", "Pioneer", "Meridian", "Continental", "TradeLink", "Urban", "Global"];
  const suffixes = suffixesForType(campaign.customerType);
  const roles = rolesForType(campaign.customerType);
  // salt 用于让不同轮次/相似扩展产出不同公司：仅用来错位命名组合并保证域名唯一，绝不进入展示名
  const saltNum = salt ? [...salt].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) : 0;
  const prospects = [];

  markets.forEach((market, marketIndex) => {
    for (let index = 0; index < perMarket; index += 1) {
      const source = sourceChannels[(index + marketIndex) % sourceChannels.length];
      const prefix = prefixes[(index + marketIndex * 2 + saltNum) % prefixes.length];
      const suffix = suffixes[(index + marketIndex + saltNum) % suffixes.length];
      const company = `${prefix} ${capitalize(productNoun)} ${suffix}`;
      const domain = makeDomain(salt ? `${company} ${salt}` : company, market);
      const query = `${campaign.product} ${market} ${campaign.customerType}`;
      prospects.push({
        id: makeId("prospect"),
        company,
        market,
        source,
        website: domain,
        contactName: "待补全",
        role: roles[index % roles.length],
        email: "",
        emailStatus: "待查找",
        phone: "",
        phoneStatus: "待查找",
        status: "新发现",
        score: scoreProspect(source, market, index),
        confidence: 42 + ((index * 7 + marketIndex * 9) % 24),
        presetKey: campaign.presetKey || null,
        campaignId: state.activeCampaignId || null,
        buyingSignal: `${market} 市场存在 ${campaign.product} 采购或分销线索`,
        companySize: ["11-50", "51-200", "201-500", "500+"][index % 4],
        searchQuery: query
      });
    }
  });

  return prospects.slice(0, targetCount);
}

// 全文域名兜底扫描时，这些"看起来像顶级域"的词其实是英文缩写或文件后缀，一律不当域名
const NON_TLD_WORDS =
  /^(g|eg|ie|etc|inc|ltd|co|jr|sr|vs|no|pp|al|ed|js|css|html|json|png|jpg|jpeg|gif|svg|pdf|csv|xml|txt|zip|doc|docx|xls|xlsx|md)$/i;

/* ---------- 粘贴解析的诊断 ----------
   解析出 0 条时，原来只说一句"没有公司官网或邮箱可用"，用户完全不知道问题在哪：
   是粘错了内容？全被平台站过滤了？还是这些公司早就在池子里？
   这里记下每一步筛掉了多少、为什么，供失败提示和诊断日志使用。 */
let lastImportStats = null;

// 平台/社媒/目录站域名——扫描时跳过，避免把 google.com 之类当成客户
// 平台站、社媒、目录站、海关数据商——搜"importer/distributor"时排在最前面的恰恰是这些，
// 它们本身不是买家。漏一个就会有人对着 B2B 平台的客服邮箱发开发信。
// 用 (^|\.) 而不是 ^：这些站大量使用国家/语种子域，us.tradeford.com、
// in.kompass.com 只锚定首段就会整批漏过去。要求前后都是完整的标签边界，
// 所以 myamazon-supplier.com 这种不会被误伤。
const NON_COMPANY_DOMAIN =
  /(^|\.)(google|bing|linkedin|facebook|instagram|twitter|x|youtube|amazon|ebay|alibaba|made-in-china|globalsources|temu|shein|wikipedia|yelp|yellowpages|tripadvisor|pinterest|reddit|medium|wordpress|blogspot|gmail|yahoo|hotmail|outlook|tradewheel|tradeford|tradekey|ec21|exporthub|go4worldbusiness|importyeti|volza|panjiva|importgenius|usimportdata|zauba|infodriveindia|trademap|kompass|europages|thomasnet|indiamart|dhgate|aliexpress|etsy|crunchbase|bloomberg|zoominfo|glassdoor|indeed|owler|dnb|manta|bbb)\./i;

/* ---------- 海关提单数据 CSV 导入 ----------
   各家平台（ImportYeti / ImportGenius / Volza / 腾道 等）导出的列名不统一，但都绕不开
   「收货人 + 发货人/HS/提单号/到港日」这几族列。按列名族识别，把同一个买家的多条提单
   聚合成一条线索，进口条数写进采购信号——这是质量分里权重最高的因子之一。

   ⚠️ 海关数据只有公司名、没有官网域名，所以导进来的线索 website 是空的，必须先跑
   「批量解析官网」补出域名，才能往下找联系人。这不是缺陷，是这类数据本身就没有。 */

const CUSTOMS_CONSIGNEE_COL = /(consignee|importer|buyer|purchaser|收货人|进口商|买家|采购商)/i;
// 佐证列：出现其中之一才认定是海关数据，避免把普通通讯录 CSV 误判进来
const CUSTOMS_EVIDENCE_COL =
  /(shipper|exporter|supplier|hs.?code|bill.?of.?lading|b\/l|arrival|shipment|manifest|container|发货人|出口商|供应商|海关编码|商品编码|提单|到港)/i;
const CUSTOMS_SHIPPER_COL = /(shipper|exporter|supplier|发货人|出口商|供应商)/i;
const CUSTOMS_COUNTRY_COL = /(country|destination|nation|国家|目的国|国别)/i;
const CUSTOMS_DATE_COL = /(date|arrival|shipped|日期|时间|到港)/i;
const CUSTOMS_HS_COL = /(hs.?code|tariff|hs.?编码|海关编码|商品编码)/i;
const CUSTOMS_DESC_COL = /(description|product|goods|commodity|品名|货物|产品)/i;
// 这些收货人名不是真买家（货代/保密/占位），别进池
const CUSTOMS_JUNK_NAME = /^(n\/?a$|unknown|to order|to the order|order of|same as|see above|confidential|不详|未知)/i;
// 只剥法定实体后缀算去重键；绝不剥 import/export/trading——那是公司名的区分部分
const COMPANY_LEGAL_SUFFIX =
  /\b(llc|ltd|limited|inc|incorporated|co|corp|corporation|company|gmbh|sa|sas|srl|bv|nv|pvt|private|plc|ag|oy|ab|aps|pte|sdn|bhd|jsc|ooo|fzc|fze|dmcc)\b/gi;
// 习惯写成全大写的实体后缀与国名缩写；Ltd/Inc/Co/Corp 按常规写法首字母大写，不进这张表
const COMPANY_ACRONYM = /^(llc|sa|sas|srl|bv|nv|plc|pvt|pte|jsc|ooo|pt|cv|eirl|usa|uae|uk|fzc|fze|dmcc|oem)$/i;
// 点分缩写（S.A.S. / E.I.R.L.）整体保持大写，别被标题化成 E.i.r.l.
const COMPANY_INITIALISM = /^([a-z]\.){2,}[a-z]?\.?$/i;
const CUSTOMS_COUNTRY_ALIAS = {
  us: "United States", usa: "United States", unitedstates: "United States", america: "United States",
  uk: "United Kingdom", gb: "United Kingdom", britain: "United Kingdom",
  uae: "United Arab Emirates", ae: "United Arab Emirates", emirates: "United Arab Emirates",
  ksa: "Saudi Arabia", sa: "Saudi Arabia", ru: "Russia", br: "Brazil", mx: "Mexico", vn: "Vietnam",
  ng: "Nigeria", eg: "Egypt", id: "Indonesia", in: "India", tr: "Turkey", za: "South Africa",
  co: "Colombia", pe: "Peru", cl: "Chile", ar: "Argentina", de: "Germany", fr: "France",
  es: "Spain", it: "Italy", pl: "Poland", nl: "Netherlands", au: "Australia", ca: "Canada",
  jp: "Japan", kr: "South Korea", th: "Thailand", my: "Malaysia", ph: "Philippines",
  bd: "Bangladesh", pk: "Pakistan"
};

// 分隔符按表头里出现最多的那个定（海关导出有用逗号的、有用分号的、有用制表符的）
function detectCsvDelimiter(headerLine) {
  return [",", ";", "\t"]
    .map((d) => [d, headerLine.split(d).length - 1])
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n > 0)
    .map(([d]) => d)[0] || ",";
}

// 最小可用 CSV 解析：认双引号包裹（海关数据的地址列里全是逗号）、认 "" 转义、认字段内换行
function parseCsvRows(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

function looksLikeCustomsCsv(text) {
  const first = (text || "").split(/\r?\n/)[0] || "";
  const cols = first.split(detectCsvDelimiter(first));
  if (cols.length < 3) return false;
  return cols.some((c) => CUSTOMS_CONSIGNEE_COL.test(c)) && cols.some((c) => CUSTOMS_EVIDENCE_COL.test(c));
}

// 选列：优先挑不含 avoid 词的那列（"Consignee Name" 优先于 "Consignee Address"；
// "Country of Destination" 优先于 "Country of Origin"——原产国是中国，不是买家所在地）
function pickCsvCol(header, want, avoid) {
  const clean = header.findIndex((h) => want.test(h) && !(avoid && avoid.test(h)));
  return clean >= 0 ? clean : header.findIndex((h) => want.test(h));
}

// 严格版：只匹配到被排除的列时返回 -1，不做"忽略排除再找一遍"的回落。
// 用于国家列——CSV 里常常只有 "Country of Origin"（货从哪来），
// 拿它当买家所在市场是错的：巴西买家会被标成 China，连累时区、渠道建议和工具清单。
// 认不出目的国时留空反而正确——下游会退回活动配置的目标市场，那是更好的猜测。
function pickCsvColStrict(header, want, avoid) {
  return header.findIndex((h) => want.test(h) && !(avoid && avoid.test(h)));
}

// "ACME LTD C/O SEAFREIGHT NIG" 里 C/O 后面是货代不是买家，去掉才能和主记录并成一家
function cleanConsigneeName(raw) {
  return (raw || "")
    .replace(/\s+(c\s*[/\\]\s*o|care of)\s+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function companyDedupeKey(name) {
  return name.toLowerCase().replace(COMPANY_LEGAL_SUFFIX, " ").replace(/[^a-z0-9一-龥]+/g, " ").trim();
}

// 海关数据的公司名基本全大写，转成正常大小写；本来就大小写混排的保持原样
function titleCaseCompany(name) {
  const raw = (name || "").replace(/\s+/g, " ").trim();
  if (!/^[^a-z]*$/.test(raw)) return raw;
  return raw
    .split(" ")
    .map((w) =>
      COMPANY_INITIALISM.test(w) || COMPANY_ACRONYM.test(w.replace(/[^a-z]/gi, ""))
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(" ");
}

function customsMarket(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  return CUSTOMS_COUNTRY_ALIAS[v.toLowerCase().replace(/[^a-z]/g, "")] || titleCaseCompany(v);
}

/* ---------- 本地海关提单库（桌面版） ----------
   导入的原始提单存主进程独立文件，聚合进线索池的只是摘要。
   有了原始记录才能做提单数据独有的那件事：按供应商反查竞品的客户。 */
function stashCustomsRecords(records) {
  const bridge = mkdBridge();
  if (!bridge?.customsAppend || !records?.length) return;
  bridge
    .customsAppend(records)
    .then((res) => {
      if (!res?.ok) {
        addLog(`提单入库失败（不影响本次线索导入）：${res?.error || "未知错误"}`);
      } else if (res.added) {
        addLog(`本地提单库：新增 ${res.added} 条${res.skipped ? `，跳过重复 ${res.skipped} 条` : ""}，累计 ${res.total} 条。可在「搜索与采集 → 按供应商反查」查竞品的客户`);
      } else if (res.skipped) {
        addLog(`本地提单库：这批 ${res.skipped} 条都已存在，没有新记录`);
      }
      renderCustomsPanel();
      renderLogs();
    })
    .catch(() => {
      /* 入库失败不影响线索导入，静默即可（上面的分支已覆盖可报告的失败） */
    });
}

let customsQueryResult = null;

async function renderCustomsPanel() {
  const host = elements.customsPanel;
  if (!host) return;
  const bridge = mkdBridge();
  if (!bridge?.customsStats) {
    host.innerHTML = `<div class="empty-state">本地提单库是桌面版功能（原始提单要写独立文件，浏览器模式做不到）。</div>`;
    return;
  }
  const s = await bridge.customsStats();
  const empty = !s?.records;
  const r = customsQueryResult;
  host.innerHTML = `
    <div class="customs-stats">
      <span>提单 <b>${s?.records || 0}</b> 条</span>
      <span>买家 <b>${s?.buyers || 0}</b> 家</span>
      <span>供应商 <b>${s?.suppliers || 0}</b> 家</span>
      ${s?.latest ? `<span>最近提单 ${escapeHtml(s.latest)}</span>` : ""}
      ${empty ? "" : `<button class="text-button" data-customs="clear" type="button">清空提单库</button>`}
    </div>
    ${
      empty
        ? `<div class="empty-state">还没有提单数据。在下方「搜索结果导入」里粘贴海关 CSV，原始提单会自动存进本地库（只存本机，不上传）。</div>`
        : `
      <div class="query-toolbar">
        <input id="customsShipperInput" placeholder="输入竞争对手/供应商名称，如 Zongshen" value="${escapeHtml(customsQueryResult?.query || "")}" />
        <button class="primary-button" data-customs="search" type="button"><span>反查它的客户</span></button>
      </div>
      ${
        r
          ? r.buyers.length
            ? `
        <p class="connector-hint">
          匹配到供应商：${r.matchedShippers.map((x) => `<code>${escapeHtml(x)}</code>`).join(" ")}${r.matchedShippers.length >= 8 ? " …" : ""}
          · 从 ${r.scanned} 条提单里找到 <b>${r.buyers.length}</b> 家买家
        </p>
        <div class="template-row header"><span>买家</span><span>提单数</span><span>最近</span><span>市场</span><span></span></div>
        ${r.buyers
          .map(
            (b, i) => `<div class="template-row">
              <span class="template-name">${escapeHtml(b.company)}</span>
              <span>${b.count}</span>
              <span>${escapeHtml(b.latest || "—")}</span>
              <span>${escapeHtml(b.country || "—")}</span>
              <span><input type="checkbox" data-customs-pick="${i}" checked aria-label="选择 ${escapeHtml(b.company)}" /></span>
            </div>`
          )
          .join("")}
        <div class="connector-foot">
          <button class="primary-button" data-customs="admit" type="button"><span>把勾选的买家加进线索池</span></button>
        </div>`
            : `<div class="empty-state">没查到从「${escapeHtml(r.query)}」进货的买家。换个写法试试（只填公司名主体，别带 Co./Ltd.）。</div>`
          : ""
      }`
    }`;
}

async function runCustomsShipperQuery() {
  const input = document.getElementById("customsShipperInput");
  const query = (input?.value || "").trim();
  if (!query) {
    addLog("请输入要反查的供应商名称");
    renderLogs();
    return;
  }
  const res = await mkdBridge().customsByShipper({ query, limit: 100 });
  if (!res?.ok) {
    addLog(`反查失败：${res?.error || "未知错误"}`);
    renderLogs();
    return;
  }
  customsQueryResult = { ...res, query };
  addLog(`按供应商反查「${query}」：找到 ${res.buyers.length} 家买家`);
  renderCustomsPanel();
  renderLogs();
}

// 把反查到的买家加进线索池——走 admitProspects 同一个闸门
function admitCustomsBuyers() {
  const r = customsQueryResult;
  if (!r?.buyers?.length) return;
  const picked = [...document.querySelectorAll("[data-customs-pick]:checked")].map((c) => r.buyers[Number(c.dataset.customsPick)]);
  if (!picked.length) {
    addLog("请先勾选要加入的买家");
    renderLogs();
    return;
  }
  const markets = normalizeMarkets(state.campaign.markets);
  const roles = rolesForType(state.campaign.customerType);
  const seen = new Set(state.prospects.map((p) => p.website || p.company.toLowerCase()));
  const fresh = [];
  picked.forEach((b, index) => {
    const company = titleCaseCompany(b.company);
    if (!company || seen.has(company.toLowerCase())) return;
    seen.add(company.toLowerCase());
    fresh.push({
      id: makeId("prospect"),
      company,
      market: customsMarket(b.country) || markets[index % Math.max(markets.length, 1)] || "United States",
      source: "竞品客户反查",
      website: "",
      websiteStatus: "待解析",
      contactName: "待补全",
      role: roles[index % roles.length],
      email: "",
      emailStatus: "待查找",
      phone: "",
      phoneStatus: "待查找",
      status: "新发现",
      // 从竞品那儿进货的买家是最高意向的一类：品类对、且已经在买
      score: Math.min(97, 78 + Math.min(16, b.count * 4)),
      confidence: Math.min(93, 60 + b.count * 3),
      presetKey: state.campaign.presetKey || null,
      campaignId: state.activeCampaignId || null,
      buyingSignal: `从「${r.query}」进货 ${b.count} 次${b.latest ? ` · 最近 ${b.latest}` : ""}${b.hs.length ? ` · HS ${b.hs.slice(0, 2).join("/")}` : ""}`,
      companySize: "待确认",
      customsRecords: b.count,
      searchQuery: `按供应商反查：${r.query}`
    });
  });
  if (!fresh.length) {
    addLog("勾选的买家都已经在线索池里了");
    renderLogs();
    return;
  }
  const admitted = admitProspects(fresh, "竞品客户反查");
  state.prospects = [...admitted, ...state.prospects];
  addLog(`已加入 ${admitted.length} 家竞品客户——它们没有官网，先跑「批量解析官网」再补邮箱`);
  saveState();
  render();
}

function importCustomsCsv(text, campaign) {
  const rows = parseCsvRows(text, detectCsvDelimiter((text || "").split(/\r?\n/)[0] || ""));
  if (rows.length < 2) return [];
  const header = rows[0];
  const iName = pickCsvCol(header, CUSTOMS_CONSIGNEE_COL, /address|地址|phone|tel|city|zip|postal|country/i);
  if (iName < 0) return [];
  const iShipper = pickCsvCol(header, CUSTOMS_SHIPPER_COL, /address|地址/i);
  const iCountry = pickCsvColStrict(header, CUSTOMS_COUNTRY_COL, /origin|原产|shipper|出口|supplier/i);
  const iDate = pickCsvCol(header, CUSTOMS_DATE_COL);
  const iHs = pickCsvCol(header, CUSTOMS_HS_COL);
  const iDesc = pickCsvCol(header, CUSTOMS_DESC_COL, /code|编码/i);

  // 原始提单存进本地库：聚合只留一个数字，而供应商名、日期、品名才是
  // 提单数据真正值钱的部分（"谁在买竞争对手的货"靠的就是它）。
  // 走主进程写独立文件，不进 localStorage。
  const rawRecords = [];

  // 按买家聚合：一家公司几十条提单，进池的是一条线索 + "有 N 条进口记录"
  const groups = new Map();
  rows.slice(1).forEach((r) => {
    const raw = cleanConsigneeName(r[iName]);
    if (!raw || CUSTOMS_JUNK_NAME.test(raw)) return;
    const key = companyDedupeKey(raw);
    if (!key) return;
    rawRecords.push({
      consignee: raw,
      shipper: iShipper >= 0 ? cleanConsigneeName(r[iShipper]) : "",
      country: iCountry >= 0 ? customsMarket(r[iCountry]) : "",
      date: iDate >= 0 ? String(r[iDate] || "").trim() : "",
      hs: iHs >= 0 ? String(r[iHs] || "").replace(/\D/g, "").slice(0, 6) : "",
      desc: iDesc >= 0 ? String(r[iDesc] || "").trim() : ""
    });
    const g = groups.get(key) || { name: raw, count: 0, hs: new Set(), shippers: new Set(), latest: "", country: "", desc: "" };
    g.count += 1;
    // 同一家公司在提单里常有多种写法，取最短的那个（长的多半带 C/O 货代后缀）
    if (raw.length < g.name.length) g.name = raw;
    if (iHs >= 0 && r[iHs]) g.hs.add(String(r[iHs]).replace(/\D/g, "").slice(0, 6));
    if (iShipper >= 0 && r[iShipper]) g.shippers.add(companyDedupeKey(r[iShipper]));
    if (iCountry >= 0 && r[iCountry] && !g.country) g.country = r[iCountry];
    if (iDesc >= 0 && r[iDesc] && !g.desc) g.desc = r[iDesc];
    if (iDate >= 0 && r[iDate] && r[iDate] > g.latest) g.latest = r[iDate];
    groups.set(key, g);
  });

  // 入库是异步的，不阻塞线索解析：库写不进去也不该影响正常导入
  stashCustomsRecords(rawRecords);

  const markets = normalizeMarkets(campaign.markets);
  const roles = rolesForType(campaign.customerType);
  const seen = new Set(state.prospects.map((item) => item.website || item.company.toLowerCase()));
  const imported = [];

  // 进口记录多的排前面：同样是陌生公司，买得多的那家更值得先打
  [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .forEach((g, index) => {
      const company = titleCaseCompany(g.name);
      const key = company.toLowerCase();
      if (!company || seen.has(key)) return;
      seen.add(key);
      const market = customsMarket(g.country) || markets[index % Math.max(markets.length, 1)] || "United States";
      const hs = [...g.hs].filter(Boolean);
      const signal = [
        `有 ${g.count} 条进口记录`,
        g.latest ? `最近 ${g.latest}` : "",
        hs.length ? `HS ${hs.slice(0, 2).join("/")}` : "",
        g.shippers.size ? `现有 ${g.shippers.size} 家供应商` : ""
      ]
        .filter(Boolean)
        .join(" · ");
      imported.push({
        id: makeId("prospect"),
        company,
        market,
        source: "Customs Data",
        website: "", // 海关数据没有域名，等「批量解析官网」补
        websiteStatus: "待解析",
        contactName: "待补全",
        role: roles[index % roles.length],
        email: "",
        emailStatus: "待查找",
        phone: "",
        phoneStatus: "待查找",
        status: "新发现",
        // 提单条数是这条线索最硬的信号，初始分直接由它决定——别让随机扰动把"买得多的"排到后面
        score: Math.min(96, 74 + Math.min(18, g.count * 4) + (market.length % 4)),
        confidence: Math.min(92, 55 + g.count * 3), // 提单条数越多，这家真在买这个品类的把握越大
        presetKey: campaign.presetKey || null,
        campaignId: state.activeCampaignId || null,
        buyingSignal: signal,
        companySize: "待确认",
        customsRecords: g.count,
        customsProduct: g.desc || "",
        searchQuery: "海关提单数据导入"
      });
    });

  return imported;
}

// 海关提单样例：列结构与 ImportYeti / ImportGenius / Volza / 腾道 的导出一致，
// 含真实数据里必有的几种脏：地址里带逗号、同一家公司两种写法、货代占位收货人。
// 用它可以在没买数据之前先跑通「导入 → 解析官网 → 补联系人 → 验证 → 入队」全链路。
function customsExampleCsv() {
  return [
    'Consignee Name,Consignee Address,Shipper Name,Country of Origin,Country of Destination,Arrival Date,HS Code,Product Description,Quantity,Weight (KG)',
    '"LAGOS MOTO PARTS ENTERPRISES LTD","12 Ojuelegba Road, Surulere, Lagos",GUANGZHOU YIHENG TRADING CO LTD,CHINA,Nigeria,2026-05-18,871410,"MOTORCYCLE SPARE PARTS - CG125 CYLINDER KITS",1200,8400',
    '"LAGOS MOTO PARTS ENTERPRISES LTD","12 Ojuelegba Road, Surulere, Lagos",FOSHAN NANHAI AUTO PARTS,CHINA,Nigeria,2026-03-02,871420,"BRAKE SHOES AND CHAIN SETS",900,5200',
    '"LAGOS MOTO PARTS ENTERPRISES LTD C/O SEAFREIGHT NIG","12 Ojuelegba Road, Surulere, Lagos",NINGBO WELL AUTO,CHINA,Nigeria,2026-01-14,871410,"PISTON RINGS GN125",2000,3100',
    '"AL FAHAD AUTO SPARE PARTS TRADING LLC","Deira, Naif Road, Dubai",CHONGQING LONGXIN EXPORT,CHINA,United Arab Emirates,2026-06-01,870830,"BRAKE PADS ASSORTED",4400,12600',
    '"AL FAHAD AUTO SPARE PARTS TRADING LLC","Deira, Naif Road, Dubai",JIANGSU HUAYU FILTERS,CHINA,United Arab Emirates,2026-04-22,842123,"OIL FILTERS FOR PASSENGER CARS",7800,9400',
    '"IMPORTADORA ANDINA DE REPUESTOS S.A.S.","Calle 13 No. 68-98, Bogota",SHANGHAI KEEP AUTO,CHINA,Colombia,2026-05-09,870830,"BRAKE DISCS AND PADS",3100,15200',
    '"IMPORTADORA ANDINA DE REPUESTOS S.A.S.","Calle 13 No. 68-98, Bogota",GUANGZHOU YIHENG TRADING CO LTD,CHINA,Colombia,2026-02-11,871420,"MOTORCYCLE CHAIN AND SPROCKET",1800,4300',
    'TO ORDER,,ZHEJIANG UNITED EXPORT,CHINA,Peru,2026-04-30,871410,"MOTORCYCLE PARTS",500,1200',
    '"REPUESTOS DEL PACIFICO E.I.R.L.","Av. Argentina 2085, Callao, Lima",WENZHOU RUIAN PARTS,CHINA,Peru,2026-06-12,871490,"MOTORCYCLE ELECTRICAL PARTS",2600,3800',
    '"CAIRO DELTA TRADING CO","45 El Nasr Street, Nasr City, Cairo",QINGDAO TOPWAY IMP EXP,CHINA,Egypt,2026-05-27,401120,"TYRES FOR MOTORCYCLES",5200,26000',
    '"CAIRO DELTA TRADING CO","45 El Nasr Street, Nasr City, Cairo",CHONGQING LONGXIN EXPORT,CHINA,Egypt,2026-03-19,871410,"ENGINE ASSEMBLY 150CC",640,11800',
    '"CAIRO DELTA TRADING CO","45 El Nasr Street, Nasr City, Cairo",FOSHAN NANHAI AUTO PARTS,CHINA,Egypt,2026-01-08,871420,"CLUTCH PLATES",3300,2900',
    '"PT SURYA MOTOR PARTS INDONESIA","Jl. Raya Bekasi KM 27, Jakarta Timur",NINGBO WELL AUTO,CHINA,Indonesia,2026-06-20,871410,"CG125 GN125 SPARE PARTS MIXED",4100,7600',
    '"MEXICO AUTOPARTES DEL NORTE SA DE CV","Av. Industrias 2200, Monterrey",JIANGSU HUAYU FILTERS,CHINA,Mexico,2026-02-27,842123,"AIR AND OIL FILTERS",6900,8100'
  ].join("\n");
}

function importSearchResultsText(text, campaign) {
  // 海关提单 CSV 走专门的聚合解析（按买家合并 + 进口条数当采购信号）
  if (looksLikeCustomsCsv(text)) return importCustomsCsv(text, campaign);

  const markets = normalizeMarkets(campaign.markets);
  const marketAt = (i) => markets[i % Math.max(markets.length, 1)] || markets[0] || "United States";
  const seen = new Set(
    state.prospects.map((item) => (item.website ? item.website.replace(/^www\./, "").toLowerCase() : item.company.toLowerCase()))
  );
  const imported = [];
  const byKey = new Map(); // 本轮已收的线索，供同一家公司跨行合并
  let mi = 0;
  const stats = { 行数: 0, 无联系方式被丢: 0, 平台站被丢: 0, 黑名单被丢: 0, 池中已有被丢: 0, 同公司合并: 0, 收录: 0 };
  lastImportStats = stats;

  const rawLines = text.split(/\r?\n/).map((l) => l.trim());
  // CSV 表头识别：首行是 company/website/email 之类则跳过
  const headerLike = /(company|name|website|domain|url|email|country|market)/i;
  const isCsv = rawLines[0] && rawLines[0].split(/[,;\t]/).length >= 2 && headerLike.test(rawLines[0]) && !/https?:/i.test(rawLines[0]);
  const lines = (isCsv ? rawLines.slice(1) : rawLines).filter(Boolean);

  /* 整页粘贴（尤其是 Google 结果页）里，绝大多数行是导航、页脚、"下一页" 这类界面文字，
     它们没有网址也没有邮箱，一旦被当成公司就会灌进几十条垃圾线索。
     判断依据：只要这份文本里出现过网址/邮箱，就说明它是搜索结果那一类，
     此时"没有任何联系方式的行"一律丢弃；反之（纯公司名清单）才保留裸名字，
     那种清单可以再用「批量解析官网」补齐。 */
  //    还要认得 `domain › path`：现在的 Google 结果页复制出来是「gulfagri.ae › products」，
  //    既没有 https:// 也没有 www.。漏掉这种形态，整页粘贴时导航文字（搜索/图片/下一页/
  //    设置/隐私权）会因为"这不像搜索结果"而被当成公司名灌进线索池。
  const looksLikeSearchDump =
    /https?:\/\/|\bwww\.|@[a-z0-9-]+\.[a-z]{2,}/i.test(text) || /[a-z0-9-]+\.[a-z]{2,}\s*[›»>]/i.test(text);

  const add = (prospect) => {
    if (!prospect) return;
    if (looksLikeSearchDump && !prospect.website && !prospect.email && !prospect.phone) {
      stats.无联系方式被丢 += 1;
      return;
    }
    // 平台/社媒/目录站域名不作为客户线索
    if (prospect.website && NON_COMPANY_DOMAIN.test(prospect.website.replace(/^www\./, ""))) {
      stats.平台站被丢 += 1;
      return;
    }
    // 退订黑名单：同邮箱/域名不再进池
    if (isBlacklisted(prospect)) {
      stats.黑名单被丢 += 1;
      return;
    }
    // 去重键要去掉 www.，否则 acme.com 与 www.acme.com 会各占一条
    const key = prospect.website ? prospect.website.replace(/^www\./, "").toLowerCase() : prospect.company.toLowerCase();
    if (!key) return;
    // 同一家公司常分散在多行：域名一行、摘要里带邮箱又一行。
    // 直接按重复丢掉会把邮箱一起丢了——而没有邮箱就发不出信，所以补进已有那条。
    const merged = byKey.get(key);
    if (merged) {
      if (!merged.email && prospect.email) {
        merged.email = prospect.email;
        merged.emailStatus = prospect.emailStatus;
      }
      if (!merged.phone && prospect.phone) {
        merged.phone = prospect.phone;
        merged.phoneStatus = prospect.phoneStatus;
      }
      if (prospect.score > merged.score) merged.score = prospect.score;
      stats.同公司合并 += 1;
      return;
    }
    if (seen.has(key)) {
      stats.池中已有被丢 += 1;
      return;
    }
    seen.add(key);
    byKey.set(key, prospect);
    imported.push(prospect);
    stats.收录 += 1;
  };

  lines.forEach((line) => {
    // 一行含多个 URL（如整页 Google 结果粘贴）：按每个 URL 拆成多个公司
    const urls = line.match(/https?:\/\/[^\s,，、|]+|www\.[^\s,，、|]+/gi);
    if (urls && urls.length > 1) {
      urls.forEach((u) => add(parseProspectLine(u, campaign, marketAt(mi++))));
      return;
    }
    add(parseProspectLine(line, campaign, marketAt(mi++)));
  });

  // 全文域名兜底扫描：抽出正文里任何还没被捕获的真实域名，补成轻量线索。
  //
  // 原正则是 `(?:\.[a-z0-9-]+)+\.[a-z]{2,}` —— 那个 `+` 要求至少三段，
  // 也就是只有 www.acme.com / sub.acme.com 能命中，最常见的两段式裸域名 acme.com
  // 一个都扫不到。于是"散文里夹着域名"这条兜底形同虚设（实测
  // "visit us at gulfagri.ae" 解析结果为 0）。改成两段起，再用后缀白名单
  // 挡住 "e.g" "Ltd.Co" "report.pdf" 这类误伤。
  const domainSweep = text.match(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b/gi) || [];
  domainSweep.forEach((d) => {
    const domain = d.toLowerCase().replace(/^www\./, "");
    const parts = domain.split(".");
    if (parts.length < 2) return;
    const tld = parts[parts.length - 1];
    if (!/^[a-z]{2,24}$/.test(tld) || NON_TLD_WORDS.test(tld)) return;
    if (parts[parts.length - 2].length < 2) return; // 主体只有一位，多半是切错的
    if (NON_COMPANY_DOMAIN.test(domain)) return;
    if (seen.has(domain)) return;
    add(parseProspectLine(domain, campaign, marketAt(mi++)));
  });

  stats.行数 = lines.length;
  return imported;
}

/* 解析出 0 条时，把"到底卡在哪"讲清楚。同样是 0，原因可能完全不同：
   粘的是搜索语句、全是平台站、这些公司早就在池里、或者这段文字里压根没有域名。 */
function explainImportFailure(text) {
  const st = lastImportStats || {};
  const looksLikeQuery = /-site:|OR\s*"|["“][^"”]+["”]\s*(OR|AND)\s/i.test(text) || /^-\w+(\s+-\w+){2,}/m.test(text);
  if (looksLikeQuery) {
    return {
      reason: "你粘的是「搜索式」本身，不是搜索结果。搜索式要先拿去 Google 搜，再把结果里的公司官网复制回来。",
      action: { label: "回搜索式列表", view: "discovery" }
    };
  }
  if (st.池中已有被丢 > 0 && st.收录 === 0) {
    return { reason: `这 ${st.池中已有被丢} 家公司线索池里都已经有了，没有新增。`, action: { label: "去潜客队列看看", view: "prospects" } };
  }
  if (st.平台站被丢 > 0 && st.收录 === 0) {
    return {
      reason: `找到 ${st.平台站被丢} 个域名，但全是平台/社媒站（领英、脸书、阿里巴巴之类），不能当客户。把搜索结果里公司自己的官网复制过来。`,
      action: null
    };
  }
  if (st.黑名单被丢 > 0 && st.收录 === 0) {
    return { reason: `这 ${st.黑名单被丢} 家都在退订黑名单里，已按合规要求跳过。`, action: null };
  }
  if (!/[a-z0-9-]+\.[a-z]{2,}/i.test(text)) {
    return {
      reason: "这段文字里没有任何网址或邮箱。如果你有的只是一串公司名，可以直接粘公司名，再用「批量解析官网」补域名。",
      action: null
    };
  }
  return {
    reason: `扫到的内容里没有可用的公司官网（导航文字丢弃 ${st.无联系方式被丢 || 0} 行、平台站丢弃 ${st.平台站被丢 || 0} 个）。`,
    action: null
  };
}

// 一个 token 是不是真域名：末段必须是像样的顶级域，主体至少两位。
// 没有这道闸，`report.pdf`、`Ltd.Co`、`v1.2` 都会被当成公司官网。
function looksLikeRealDomain(token) {
  const host = stripProtocol(String(token || "")).split("/")[0].replace(/^www\./, "").toLowerCase();
  const parts = host.split(".");
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1];
  if (!/^[a-z]{2,24}$/.test(tld) || NON_TLD_WORDS.test(tld)) return false;
  return parts[parts.length - 2].length >= 2;
}

function parseProspectLine(line, campaign, market) {
  const urlRaw = line.match(/https?:\/\/[^\s,，]+|www\.[^\s,，]+|[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s,，]*)?/i);
  // 带协议/带 www 的一定是网址；裸 token 要过域名闸，挡掉 report.pdf 这类
  const urlMatch = urlRaw && (/^(https?:|www\.)/i.test(urlRaw[0]) || looksLikeRealDomain(urlRaw[0])) ? urlRaw : null;
  const emailMatch = line.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  const phoneMatch = line.match(
    /\+\d[\d\s().-]{6,}\d|(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{4}/
  );
  const website = urlMatch ? stripProtocol(urlMatch[0]).split("/")[0] : emailMatch ? emailMatch[0].split("@")[1] : "";
  const cleaned = cleanCompanyName(line, website, emailMatch?.[0]);
  // 整句散文里夹着域名时（如 "visit us at x.com or ..."），用域名反推公司名更干净
  const proseStopWords = /(^|\s)(at|or|us|of|in|the|and|to|a|an|for|visit|contact|mention|somewhere|text|please|here|see|from)(\s|$)/i;
  const looksProse = cleaned && cleaned.split(/\s+/).length >= 4 && proseStopWords.test(cleaned);
  // 搜索结果里的面包屑残片（"› patio-furniture"）和纯符号/数字都不是公司名，有域名就用域名反推
  const looksJunk = !!cleaned && (/^[\s›»>/|·—–-]/.test(cleaned) || cleaned.replace(/[^\p{L}\p{N}]/gu, "").length < 2);
  const company =
    website && (looksProse || looksJunk || !cleaned) ? domainToCompany(website) : cleaned || domainToCompany(website);

  if (!company && !website && !emailMatch) return null;
  // 既没网址也没邮箱电话时，只接受"像公司名"的短行。
  // 整句话（带句号问号、或超过 8 个词）是说明文字，不是公司。
  if (!website && !emailMatch && !phoneMatch) {
    const wordCount = company.trim().split(/\s+/).length;
    const cjkCount = (company.match(/[一-龥]/g) || []).length;
    if (/[。！？；.!?;]/.test(company) || wordCount > 8 || cjkCount > 12) return null;
  }

  const directWebsite = website && !/(google|linkedin|facebook|instagram|youtube|amazon|alibaba|made-in-china|globalsources)/i.test(website);
  const score = Math.min(
    96,
    52 +
      (directWebsite ? 18 : 4) +
      (emailMatch ? 14 : 0) +
      (phoneMatch ? 8 : 0) +
      (/(import|distribut|wholesale|retail|buyer|sourcing|procurement)/i.test(line) ? 10 : 0)
  );

  return {
    id: makeId("prospect"),
    company: company || "未命名公司",
    market,
    source: "搜索结果导入",
    website,
    contactName: "待确认",
    role: "待确认采购角色",
    email: emailMatch?.[0] || "",
    emailStatus: emailMatch ? "待验证" : "待查找",
    phone: phoneMatch?.[0]?.replace(/\s+/g, " ") || "",
    phoneStatus: phoneMatch ? "待人工确认" : "待查找",
    status: "待审核",
    score,
    confidence: directWebsite ? 72 : 48,
    presetKey: campaign.presetKey || null,
    campaignId: state.activeCampaignId || null,
    buyingSignal: `从搜索结果导入，需核验是否采购 ${campaign.product}`,
    companySize: "待确认",
    searchQuery: line
  };
}

function cleanCompanyName(line, website, email) {
  let value = line;
  // 先删除带协议/www 的完整 URL（含其后的域名与路径）
  value = value.replace(/https?:\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " ");
  // 删除完整邮箱（须在删除裸域名之前，否则邮箱里的域名会先被删掉导致残留 name@）
  if (email) value = value.split(email).join(" ");
  // 删除残留的裸域名和协议片段
  if (website) value = value.split(website).join(" ");
  value = value.replace(/https?:\/\/+/gi, " ");
  // 删除电话号码簇（宽松匹配 +、括号、空格、连字符组成的长数字串）
  value = value.replace(/\+?\d[\d\s().-]{5,}\d/g, " ");
  // 归一化分隔符与空白
  value = value
    .replace(/[,，|;；]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  value = value.split(/ - | – | \| /)[0]?.trim() || value;
  if (value.length > 80) value = value.slice(0, 80).trim();
  return value;
}

function domainToCompany(website) {
  if (!website) return "";
  const domain = website.replace(/^www\./, "").split(".")[0];
  return capitalize(domain.replace(/[-_]+/g, " "));
}

function enrichProspectList(prospects, campaign) {
  const aliasByType = {
    "importer distributor": "purchasing",
    "retailer chain buyer": "buying",
    "brand private label": "sourcing",
    wholesaler: "sales",
    "contractor project buyer": "procurement"
  };
  const roleAlias = aliasByType[campaign.customerType] || "sourcing";

  // 这里曾经会编造联系人：从名字库拼一个人名、按域名模式拼一串邮箱、再生成一个假号码。
  // 那些数据看起来很完整，但没有一个是真的——用户拿去发信就是发给不存在的人。
  // 现在只做「不需要编也成立」的补全：岗位方向、采购信号措辞。
  // 联系人和邮箱只有两个合法来源：真实源（Hunter/Apollo/邮箱查找 Webhook）与 AI 联网核实。
  return prospects.map((prospect, index) => {
    const imported = prospect.email
      ? prospect.emailCandidates?.length
        ? prospect.emailCandidates
        : [{ email: prospect.email, confidence: 90, pattern: "导入原始邮箱" }]
      : prospect.emailCandidates || [];
    const hasContact = !!prospect.email;
    return {
      ...prospect,
      // 已有的真实姓名保留；没有就留空，不再拿名字库顶上
      contactName:
        prospect.contactName && !["待确认", "待补全", "待确认采购角色"].includes(prospect.contactName)
          ? prospect.contactName
          : "",
      role:
        prospect.role && !["待确认采购角色", "待确认"].includes(prospect.role)
          ? prospect.role
          : rolesForType(campaign.customerType)[index % rolesForType(campaign.customerType).length],
      email: prospect.email || "",
      emailCandidates: imported,
      contactSource: prospect.contactSource || (hasContact ? "import" : ""),
      emailStatus: hasContact ? "待验证" : "待查找",
      // 号码同理：不再凭市场编一个，没有就是没有
      phone: prospect.phone || "",
      phoneStatus: prospect.phone ? "待人工确认" : "待查找",
      status: prospect.status === "已入队" ? prospect.status : hasContact ? "已丰富" : "待查联系人",
      // 原来无脑 +18 是在给编出来的数据加分，去掉
      confidence: prospect.confidence,
      buyingSignal: `${prospect.market} ${campaign.customerType}，匹配 ${campaign.product}，卖点可切入：${campaign.valueProps}`
    };
  });
}

function verifyProspectList(prospects) {
  return prospects.map((prospect) => ({
    ...prospect,
    emailStatus: prospect.email && prospect.email.includes("@") ? "格式有效" : "待查找",
    phoneStatus: prospect.phone ? "可打开聊天" : "待查找",
    status: prospect.status === "已入队" ? "已入队" : prospect.email ? "邮箱有效" : prospect.status,
    confidence: prospect.email ? Math.min(98, prospect.confidence + 9) : prospect.confidence,
    score: prospect.email ? Math.min(99, prospect.score + 5) : prospect.score
  }));
}

/* ---------- AI 每周战报（一键生成本周数据摘要 + 下周行动建议，可复制汇报） ---------- */

let lastReportText = "";

function weeklyStats() {
  const cutoff = Date.now() - 7 * 86400000;
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const prospects = activeProspects();
  const activeIds = activeProspectIdSet();
  const outbox = activeOutboxItems();
  const inbound = activeInboundItems();

  const sent = outbox.filter((o) => o.status === "已发送" && o.sentAt && new Date(o.sentAt).getTime() >= cutoff);
  const delivered = sent.filter((o) => o.delivered).length;
  const opened = sent.filter((o) => o.opened).length;
  const bounced = sent.filter((o) => o.bounced).length;

  const replies = inbound.filter((m) => (m.at || 0) >= cutoff);
  const replyProspects = new Set(replies.map((m) => m.prospectId));
  const HOT = ["price", "sample", "moq", "leadtime", "cert"];
  const hotProspects = new Set(
    replies.filter((m) => HOT.includes(classifyIntent(m.body || "").key)).map((m) => m.prospectId)
  );

  const quotes7 = state.quotes.filter((q) => activeIds.has(q.prospectId) && new Date(q.createdAt).getTime() >= cutoff);
  const quoteTotals = {};
  quotes7.forEach((q) => {
    quoteTotals[q.currency] = (quoteTotals[q.currency] || 0) + q.total;
  });
  // 未回复的报价（发出后客户没再来信）
  const pendingQuotes = state.quotes.filter((q) => {
    const t = new Date(q.createdAt).getTime();
    return activeIds.has(q.prospectId) && !inbound.some((m) => m.prospectId === q.prospectId && (m.at || 0) > t);
  });

  const stage = (s) => prospects.filter((p) => p.dealStage === s).length;

  // 回复率最高的市场（当前活动口径，至少触达 2 家）
  const contactedBy = new Map();
  outbox.filter((o) => o.status === "已发送").forEach((o) => {
    const p = prospects.find((x) => x.id === o.prospectId);
    if (!p) return;
    if (!contactedBy.has(p.market)) contactedBy.set(p.market, new Set());
    contactedBy.get(p.market).add(p.id);
  });
  let bestMarket = null;
  contactedBy.forEach((ids, market) => {
    if (ids.size < 2) return;
    const replied = [...ids].filter((id) => inbound.some((m) => m.prospectId === id)).length;
    if (!replied) return; // 没有任何回复的市场不构成"最佳"，避免推荐 0%
    const rate = Math.round((replied / ids.size) * 100);
    if (!bestMarket || rate > bestMarket.rate) bestMarket = { market, rate, replied, reached: ids.size };
  });

  return {
    from: fmt(cutoff),
    to: fmt(Date.now()),
    sentN: sent.length,
    delivered,
    opened,
    bounced,
    replyN: replies.length,
    replyCompanies: replyProspects.size,
    hotN: hotProspects.size,
    quoteN: quotes7.length,
    quoteTotals,
    pendingQuotes,
    inquiry: stage("询盘"),
    quoting: stage("报价"),
    won: stage("成交"),
    dueFollow: dueFollowupProspects().length,
    pendingApproval: outbox.filter((o) => o.status === "待审批").length,
    bestMarket
  };
}

function weeklySuggestions(s) {
  const tips = [];
  if (s.dueFollow) tips.push(`跟进 ${s.dueFollow} 位到期未回复客户（「一键批量跟进」）`);
  if (s.pendingQuotes.length)
    tips.push(`追未回复的报价 ${s.pendingQuotes.slice(0, 3).map((q) => q.number).join("、")}${s.pendingQuotes.length > 3 ? " 等" : ""}（共 ${s.pendingQuotes.length} 张）`);
  if (s.pendingApproval) tips.push(`过一遍 ${s.pendingApproval} 封待审批邮件（队列「批量审批发送」）`);
  if (s.bestMarket) tips.push(`「${s.bestMarket.market}」回复率最高（${s.bestMarket.rate}%），下周可倾斜补同市场线索`);
  if (!s.sentN) tips.push(`本周零发送——先「一键起量」补线索并入队`);
  if (s.bounced >= 2) tips.push(`本周退信 ${s.bounced} 封，放量前先检查邮箱验证质量`);
  return tips.slice(0, 4);
}

function weeklyReportText(s, tips) {
  const money2 = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const quoteLine = s.quoteN
    ? `新出报价 ${s.quoteN} 张，合计 ${Object.entries(s.quoteTotals).map(([c, v]) => `${c} ${money2(v)}`).join(" + ")}`
    : "本周未出报价";
  return `📊 外贸开发周报（${s.from} ~ ${s.to}）

【触达】发送 ${s.sentN} 封（送达 ${s.delivered} · 打开 ${s.opened}${s.bounced ? ` · ⚠ 退信 ${s.bounced}` : ""}）
【回复】收到 ${s.replyN} 条回信（${s.replyCompanies} 家客户），热意向（询价/要样/MOQ）${s.hotN} 家
【报价】${quoteLine}
【管道】询盘 ${s.inquiry} 家 · 报价 ${s.quoting} 家 · 成交 ${s.won} 家
【待办】${s.dueFollow} 位客户到期未跟进 · ${s.pendingApproval} 封邮件待审批

下周建议：
${tips.map((t) => `- ${t}`).join("\n") || "- 保持当前节奏，持续补充线索"}`;
}

function openWeeklyReport() {
  const host = elements.reportOverlay;
  if (!host) return;
  const s = weeklyStats();
  const tips = weeklySuggestions(s);
  lastReportText = weeklyReportText(s, tips);
  const ai = aiEnabled();
  host.innerHTML = `
    <div class="panel quote-card" role="dialog" aria-modal="true" aria-label="每周战报">
      <h2>📊 每周战报</h2>
      <pre class="report-pre">${escapeHtml(lastReportText)}</pre>
      ${ai ? `<div class="report-ai" id="reportAiSlot">🤖 AI 点评生成中…</div>` : `<p class="connector-hint">配置 AI 引擎后，这里会附上大模型的针对性点评。</p>`}
      <div class="quote-actions">
        <button class="primary-button" data-report-action="copy" type="button"><span>复制周报</span></button>
        <button class="ghost-button" data-report-action="close" type="button"><span>关闭</span></button>
      </div>
    </div>
  `;
  host.hidden = false;

  if (ai) {
    const system =
      "你是外贸开发运营顾问。基于给定周报数据，用中文给 3-5 条具体、可执行的下周行动建议，每条一行以 - 开头；直接说做什么，不要客套和复述数据。";
    callAI(system, lastReportText, null, 800)
      .then((text) => {
        const slot = document.getElementById("reportAiSlot");
        if (slot) slot.innerHTML = `<strong>🤖 AI 点评</strong><pre class="report-pre">${escapeHtml(text)}</pre>`;
        lastReportText += `\n\nAI 点评：\n${text}`;
      })
      .catch((error) => {
        const slot = document.getElementById("reportAiSlot");
        if (slot) slot.textContent = `AI 点评生成失败（${error.message}），以上本地建议仍可用`;
      });
  }
}

function copyWeeklyReport(button) {
  const done = () => {
    const span = button?.querySelector("span");
    if (span) span.textContent = "已复制 ✓";
    addLog("周报已复制，可直接粘贴汇报");
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(lastReportText).then(done).catch(() => fallbackCopy(lastReportText, done));
  } else {
    fallbackCopy(lastReportText, done);
  }
}

/* ---------- 多语言：按市场加当地语言开场（正文英文，提升南美/中东回复率） ---------- */

const MARKET_LANGUAGE = {
  es: /colombia|peru|mexico|chile|argentina|ecuador|spain|bolivia|venezuela|guatemala|dominican|uruguay|paraguay|costa rica|panama|honduras|salvador|nicaragua/i,
  pt: /brazil|brasil|portugal|angola|mozambique/i,
  ar: /egypt|saudi|uae|united arab emirates|emirates|kuwait|qatar|\boman\b|bahrain|jordan|iraq|morocco|algeria|tunisia|libya|yemen|lebanon/i,
  // 注意用词边界：\bniger\b 不能命中 Nigeria（英语国家）、\bmali\b 不能命中 Somalia
  fr: /france|senegal|ivory coast|cote d.ivoire|cameroon|congo|\bmali\b|burkina|\bniger\b|benin|togo|guinea|madagascar/i,
  // 俄语区：摩配/汽配的主力市场。刻意不含 Georgia——它同时是美国州名，撞上会给美国客户发俄语
  ru: /russia|россия|belarus|kazakhstan|uzbekistan|kyrgyz|tajikistan|turkmenistan|armenia|moldova/i,
  vi: /vietnam|viet nam|việt nam/i,
  id: /indonesia/i,
  // Turkmenistan 已被 ru 先行命中，此处的 turkey 不会误伤
  tr: /turkey|türkiye|turkiye/i
};

function marketLanguage(market) {
  const m = market || "";
  for (const [lang, re] of Object.entries(MARKET_LANGUAGE)) {
    if (re.test(m)) return lang;
  }
  return "en";
}

/* ---------- 按市场选渠道 ----------
   WhatsApp 不是通用渠道，地域性极强。给美国/德国买家发陌生 WhatsApp，对方第一反应
   是诈骗而不是商机；俄罗斯用 Telegram、越南用 Zalo、日韩用 LINE/Kakao。
   而且冷发 WhatsApp 本就踩 WhatsApp Business 的 opt-in 政策，代价是号码被封——
   号绑手机，换号比换发信域名还贵。所以自动排队前先过这张表。
   与 MARKET_LANGUAGE / MARKET_TZ 同构：市场 → 触达方式。命中顺序自上而下。 */
const MARKET_CHANNEL = [
  [
    /russia|россия|belarus|kazakhstan|uzbekistan|kyrgyz|tajikistan|turkmenistan|armenia|moldova|\biran\b/i,
    { whatsapp: false, primary: "Telegram", note: "该市场主用 Telegram，WhatsApp 覆盖低" }
  ],
  [/vietnam|viet nam|việt nam/i, { whatsapp: false, primary: "Zalo", note: "越南主用 Zalo，WhatsApp 渗透率低" }],
  [/myanmar|burma/i, { whatsapp: false, primary: "Viber", note: "该市场主用 Viber" }],
  [/japan/i, { whatsapp: false, primary: "邮件 / LINE", note: "日本 B2B 走邮件，即时通讯用 LINE" }],
  [/korea/i, { whatsapp: false, primary: "邮件 / KakaoTalk", note: "韩国 B2B 走邮件，即时通讯用 KakaoTalk" }],
  [
    /united states|usa|america|canada|australia|new zealand/i,
    { whatsapp: false, primary: "邮件 + LinkedIn", note: "该市场 B2B 走邮件与 LinkedIn，陌生 WhatsApp 会被当成诈骗" }
  ],
  [
    // 欧盟+英国：即便当地 WhatsApp 普及（如西班牙、意大利），冷发也踩 GDPR，
    // 默认不自动排；确有往来的客户可在潜客详情手动排一条。
    EU_MARKETS,
    { whatsapp: false, primary: "邮件", note: "欧盟/英国冷发即时通讯踩 GDPR，默认只走邮件（可在潜客详情手动排）" }
  ],
  [
    /brazil|brasil|mexico|colombia|peru|argentina|chile|ecuador|bolivia|uruguay|paraguay|venezuela|guatemala|dominican|costa rica|honduras|salvador|nicaragua|panama/i,
    { whatsapp: true, primary: "WhatsApp", note: "" }
  ],
  [
    /nigeria|kenya|south africa|ghana|tanzania|ethiopia|uganda|egypt|morocco|algeria|tunisia|libya|senegal|cameroon|ivory coast|cote d.ivoire|congo/i,
    { whatsapp: true, primary: "WhatsApp", note: "" }
  ],
  [
    /uae|united arab emirates|dubai|saudi|qatar|kuwait|bahrain|\boman\b|jordan|lebanon|iraq|yemen|turkey|türkiye|turkiye/i,
    { whatsapp: true, primary: "WhatsApp", note: "" }
  ],
  [
    /india|indonesia|malaysia|pakistan|bangladesh|sri lanka|philippines|thailand|singapore/i,
    { whatsapp: true, primary: "WhatsApp", note: "" }
  ]
];

// 未知市场保守放行 WhatsApp（不认识就不拦，避免把没覆盖到的市场一刀切掉）
function marketChannel(market) {
  const m = String(market || "");
  for (const [re, conf] of MARKET_CHANNEL) {
    if (re.test(m)) return conf;
  }
  return { whatsapp: true, primary: "WhatsApp", note: "" };
}

function whatsappFitsMarket(market) {
  return marketChannel(market).whatsapp;
}

/* ---------- 各市场的外贸工具清单 ----------
   不同市场的打法差别极大，最硬的一条差别是"有没有提单级海关数据"——
   欧盟、日韩因隐私法根本查不到，谁说能查谁在拿统计数据冒充提单数据。
   这里只列长期存在、业内公认的服务；价格与免费额度变动频繁，界面上已注明以官网为准。
   与 MARKET_CHANNEL 同一张表的思路：市场 → 该怎么打。 */
const MARKET_PLAYBOOK = [
  {
    match: /united states|usa|america|canada|australia|new zealand/i,
    name: "美国 / 加拿大 / 澳新",
    customs: "✅ 美国提单级公开——ImportYeti（免费搜）、ImportGenius、Panjiva、Descartes Datamyne。加拿大与澳新无公开提单数据。",
    find: "ThomasNet（工业品名录）、LinkedIn、行业协会会员名录、行业展会参展商名单",
    enrich: "Hunter、Apollo（这几个市场覆盖率最高）",
    contact: "邮件 + LinkedIn（人工发 InMail，别用自动化工具，封号风险高）",
    caution: "陌生 WhatsApp 会被当成诈骗。看重产品责任险与 UL/FCC 等认证，付款常见 NET30/60，账期风险要评估。"
  },
  {
    match: EU_MARKETS,
    name: "欧盟 / 英国",
    customs: "❌ 隐私法规下没有提单级数据，任何声称能查欧盟买家进口记录的多半是统计数据。选市场用 ITC Trade Map / Eurostat 看品类进口趋势。",
    find: "Europages、Kompass、德国 wlw（Wer liefert was）、各国行业协会名录；展会权重极高（汉诺威、科隆、米兰）",
    enrich: "Hunter、Dropcontact（对欧洲域名覆盖较好）",
    contact: "只走邮件。GDPR 下冷发要有合法利益依据，且必须带退订说明（本软件已强制注入）",
    caution: "CE / REACH / RoHS 是入场券，没有就别开发。决策慢、看重长期供应稳定性与工厂审核。"
  },
  {
    match: /russia|россия|belarus|kazakhstan|uzbekistan|kyrgyz|tajikistan|turkmenistan|armenia|moldova/i,
    name: "俄罗斯 / 独联体",
    customs: "✅ 有提单级数据，Seair、Volza 等国际服务商及俄本地服务商都覆盖。",
    find: "Yandex（份额高于 Google，搜索式要单独做一套俄语的）、Satom.ru、Pulscen 等本地 B2B",
    enrich: "国际邮箱工具对 .ru 域名覆盖一般，建议官网直挖 + 电话核实",
    contact: "邮件 + Telegram（WhatsApp 在这里不是主流）",
    caution: "首要障碍不是获客而是收款——先确认跨境支付路径与制裁合规再投入开发。俄语是硬门槛，英文信回复率明显偏低。"
  },
  {
    match: /uae|united arab emirates|dubai|saudi|qatar|kuwait|bahrain|\boman\b|jordan|lebanon|iraq/i,
    name: "中东（海湾）",
    customs: "⚠️ 覆盖有限，部分服务商有阿联酋转口数据，可信度参差。",
    find: "Dubai Chamber 会员名录、当地黄页、Alibaba（中东买家渗透率高）、迪拜与利雅得的行业展会",
    enrich: "Hunter / Apollo 覆盖一般，很多公司只有 info@ 邮箱，电话与 WhatsApp 更有效",
    contact: "WhatsApp + 邮件（WhatsApp 在这里是正经商务渠道）",
    caution: "关系导向，先建立信任再谈价。沙特要 SASO / SABER 认证。斋月与周五休假会打乱跟进节奏。"
  },
  {
    match: /brazil|brasil|mexico|colombia|peru|argentina|chile|ecuador|bolivia|uruguay|paraguay|venezuela|guatemala|dominican|costa rica|honduras|salvador|nicaragua|panama/i,
    name: "拉美",
    customs: "✅ 巴西、墨西哥、秘鲁、智利、阿根廷都有提单级数据，是最值得买数据的区域之一。",
    find: "海关数据为主 + Google（用西语/葡语关键词，英文搜不到本地买家）",
    enrich: "Hunter / Apollo 覆盖尚可；本地公司常用 Gmail/Hotmail 个人邮箱做生意，别一律当无效",
    contact: "WhatsApp 极强 + 邮件（首封已自动加西/葡语开场）",
    caution: "巴西进口税高、清关复杂，买家会先问 NCM 编码；阿根廷有外汇管制，付款周期长。"
  },
  {
    match: /nigeria|kenya|south africa|ghana|tanzania|ethiopia|uganda|egypt|morocco|algeria|tunisia|libya|senegal|cameroon|ivory coast|cote d.ivoire|congo/i,
    name: "非洲",
    customs: "⚠️ 公开数据少，多数国家查不到提单。埃及、南非相对好一些。",
    find: "Google + 当地黄页 + 行业协会；广交会等展会上的非洲采购商名单往往比线上更实",
    enrich: "邮箱覆盖差，WhatsApp 号比邮箱更容易拿到也更有效",
    contact: "WhatsApp 是主渠道，邮件是补充",
    caution: "信用风险最高的区域，坚持 T/T 预付或不可撤销 L/C，别做账期。尼日利亚要 SONCAP、肯尼亚要 PVoC，认证不齐货到港会被扣。"
  },
  {
    match: /\bindia\b|sri lanka|bangladesh|pakistan/i,
    name: "印度 / 南亚",
    customs: "✅ 印度海关数据极其公开，Export Genius、Seair、Volza 都是印度本土公司，价格也相对便宜。",
    find: "IndiaMART、TradeIndia（印度最大的两个 B2B 平台）+ 海关数据",
    enrich: "Hunter / Apollo 覆盖尚可",
    contact: "WhatsApp 极强 + 邮件",
    caution: "价格敏感度极高，会拿你的报价去压别家，别一上来给底价。部分品类要 BIS 认证。"
  },
  {
    match: /vietnam|viet nam|việt nam|indonesia|thailand|malaysia|philippines|singapore|cambodia|myanmar/i,
    name: "东南亚",
    customs: "✅ 越南、印尼、泰国有提单级数据可买。",
    find: "Alibaba 在这一带买家中渗透率高；再配合海关数据与 Google",
    enrich: "公司邮箱普及度不错，Hunter / Apollo 可用",
    contact: "越南用 Zalo（不是 WhatsApp）、泰国用 LINE、印尼/马来/菲律宾用 WhatsApp",
    caution: "别把整个东南亚当一个市场——即时通讯工具就完全不同，用错渠道等于没发。"
  },
  {
    match: /japan|korea/i,
    name: "日本 / 韩国",
    customs: "❌ 无提单级数据。",
    find: "Kompass Japan、韩国 EC21、行业协会名录；展会与商社渠道比线上有效得多",
    enrich: "邮箱难挖，官网 inquiry 表单往往是唯一入口",
    contact: "邮件为主（日本 LINE、韩国 KakaoTalk 只在建立关系后用）",
    caution: "决策最慢、要求最细：会要样品、工厂审核、完整质检报告。日本买家常通过商社/代理商而非直接进口，找错对象等于白做。"
  },
  {
    match: /turkey|türkiye|turkiye/i,
    name: "土耳其",
    customs: "⚠️ 覆盖有限。",
    find: "Google（土耳其语关键词）+ 行业协会 + 伊斯坦布尔展会",
    enrich: "Hunter / Apollo 覆盖一般",
    contact: "WhatsApp + 邮件",
    caution: "里拉波动大，报价有效期要短（7-15 天），并明确以美元计价。"
  }
];

function playbookFor(market) {
  const m = String(market || "");
  return MARKET_PLAYBOOK.find((entry) => entry.match.test(m)) || null;
}

// 按活动的目标市场渲染工具清单。多个市场落在同一区域时合并成一张卡，
// 并标出是哪几个市场命中的——用户填 "Brazil, Mexico" 不该看到两张一样的卡。
function renderMarketPlaybook() {
  const host = elements.marketPlaybook;
  if (!host) return;
  const markets = normalizeMarkets(state.campaign.markets);
  if (!markets.length) {
    host.innerHTML = `<div class="empty-state">先在控制台填「目标市场」，这里会按市场给出该用什么工具。</div>`;
    return;
  }

  const groups = new Map();
  const unknown = [];
  markets.forEach((market) => {
    const pb = playbookFor(market);
    if (!pb) {
      unknown.push(market);
      return;
    }
    if (!groups.has(pb.name)) groups.set(pb.name, { pb, markets: [] });
    groups.get(pb.name).markets.push(market);
  });

  const row = (label, value) => (value ? `<div class="pb-row"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>` : "");
  const cards = [...groups.values()]
    .map(
      ({ pb, markets: hit }) => `
      <article class="pb-card">
        <div class="pb-head">
          <strong>${escapeHtml(pb.name)}</strong>
          <span class="pb-hit">${hit.map((m) => escapeHtml(m)).join(" · ")}</span>
          <span class="pf-badge ${marketChannel(hit[0]).whatsapp ? "pf-ok" : "pf-warn"}">${escapeHtml(marketChannel(hit[0]).primary)}</span>
        </div>
        <dl class="pb-list">
          ${row("海关数据", pb.customs)}
          ${row("找客户", pb.find)}
          ${row("补邮箱", pb.enrich)}
          ${row("怎么触达", pb.contact)}
          ${row("⚠️ 注意", pb.caution)}
        </dl>
      </article>`
    )
    .join("");

  host.innerHTML =
    cards +
    (unknown.length
      ? `<p class="connector-hint">${escapeHtml(unknown.join("、"))} 还没有收录打法建议——默认按"邮件为主、WhatsApp 可试"处理。</p>`
      : "");
}

// 首封信的当地语言开场（一小段+说明英文在下方），非英语市场自动加
// 产地按各语言习惯拼：城市名保持拉丁写法（阿语里也是），国名用当地语言
function localIntroFor(market, greeting, product, campaign) {
  const lang = marketLanguage(market);
  const city = ((campaign && campaign.originCity) || "").trim();
  const isChinaOnly = !city || /^china$/i.test(city);
  // 整段介词短语按语言拼：葡语要 "da China"、法语要 "la Chine"、俄语要第二格、
  // 土耳其语要 "Çin'in ... şehrinden"，光换名词会写出病句。城市名一律保持拉丁写法
  // （阿语/俄语里也是）——音译用户自填的城市名不可能可靠，写错反而不专业。
  const from = {
    es: isChinaOnly ? "desde China" : `desde ${city}, China`,
    pt: isChinaOnly ? "da China" : `de ${city}, China`,
    ar: isChinaOnly ? "من الصين" : `من ${city}، الصين`,
    fr: isChinaOnly ? "depuis la Chine" : `depuis ${city} (Chine)`,
    ru: isChinaOnly ? "из Китая" : `из города ${city} (Китай)`,
    vi: isChinaOnly ? "từ Trung Quốc" : `từ ${city}, Trung Quốc`,
    id: isChinaOnly ? "dari Tiongkok" : `dari ${city}, Tiongkok`,
    tr: isChinaOnly ? "Çin'den" : `Çin'in ${city} şehrinden`
  };
  const intros = {
    es: `Estimado/a ${greeting}: Le escribimos ${from.es} como proveedor de ${product}. A continuación los detalles en inglés — también podemos atenderle en español.`,
    pt: `Prezado(a) ${greeting}: Escrevemos ${from.pt} como fornecedor de ${product}. Abaixo seguem os detalhes em inglês — também podemos atender em português.`,
    ar: `تحية طيبة ${greeting}، نراسلكم ${from.ar} كمورد لـ ${product}. التفاصيل بالإنجليزية أدناه — ويمكننا التواصل بالعربية أيضًا.`,
    fr: `Bonjour ${greeting}, nous vous écrivons ${from.fr} en tant que fournisseur de ${product}. Les détails suivent en anglais — nous pouvons aussi échanger en français.`,
    ru: `Здравствуйте, ${greeting}! Мы пишем вам ${from.ru} как поставщик ${product}. Подробности ниже на английском языке — мы также можем общаться по-русски.`,
    vi: `Kính gửi ${greeting}, chúng tôi viết thư ${from.vi} với tư cách là nhà cung cấp ${product}. Thông tin chi tiết bằng tiếng Anh ở bên dưới — chúng tôi cũng có thể trao đổi bằng tiếng Việt.`,
    id: `Yth. ${greeting}, kami menulis ${from.id} sebagai pemasok ${product}. Detail dalam bahasa Inggris ada di bawah — kami juga dapat berkomunikasi dalam bahasa Indonesia.`,
    tr: `Sayın ${greeting}, ${product} tedarikçisi olarak size ${from.tr} yazıyoruz. Ayrıntılar aşağıda İngilizce olarak yer almaktadır — Türkçe olarak da görüşebiliriz.`
  };
  return intros[lang] || "";
}

// 四大品类的专门开发信话术（套用品类模板后，首封+价值跟进自动换成该品类版本）
// 产地一律由 origin 传入（用户填的城市，留空为 China）；模板不写死任何产业带
const CATEGORY_EMAIL_TEMPLATES = {
  moto: {
    firstSubject: (origin) => `Motorcycle parts supply from ${origin} — OEM-grade, flexible MOQ`,
    hook: "OEM-grade, flexible MOQ",
    first: (g, p, sender, company, product, desc, origin) => `Dear ${g},

I am writing from ${company}, a ${origin}-based exporter of ${product}.

We understand ${p.company} may source ${product} for the ${p.market} market, and we would welcome the opportunity to serve as a dependable long-term supplier.

${desc || "Our range covers the fast-moving platforms commonly sold in your market — CG125/150, GN125, CB, Bajaj/TVS-compatible, and tricycle/3-wheeler models — manufactured to OEM-grade standards with consistent availability."}

Buyers in your market particularly value:
• Flexible MOQ, with multiple item numbers consolidated into one 20'/40' container
• CCC, SONCAP and ISO 9001 certification, with complete export documentation
• Consistent repeat-order quality and stable FOB pricing

I would be glad to send our catalogue of fast-moving parts together with a reference price list. May I forward these for your review?

Best regards,
${sender}
${company}`,
    valueSubject: "Following up — motorcycle parts supply for your market",
    value: (g, p, sender, company, product) => `Dear ${g},

I am following up on my previous message regarding ${product}.

To make evaluation straightforward, I can prepare a starter container combining the highest-demand SKUs of ${product} for the ${p.market} market — an efficient way to gauge demand without committing significant capital.

If you could kindly share the models or brands you sell most, I will prepare a tailored quotation accordingly.

Best regards,
${sender}
${company}`
  },
  auto: {
    firstSubject: (origin) => `Automotive aftermarket parts from ${origin} — full coverage, flexible MOQ`,
    hook: "aftermarket coverage, flexible MOQ",
    first: (g, p, sender, company, product, desc, origin) => `Dear ${g},

I am writing from ${company}, a ${origin}-based exporter of ${product}.

We understand ${p.company} may source ${product} for the ${p.market} market.

${desc || "With OE cross-references and consistent batch quality, we are confident we can support your aftermarket range reliably."}

Our customers particularly value:
• Broad aftermarket coverage across common makes and models
• IATF 16949, E-mark and ISO 9001 certification, with stable quality control
• Flexible MOQ, prompt sampling, and mixed-item container loading

I would be pleased to send a catalogue of our best-selling references together with an indicative price range. Could you let me know which vehicle makes are most important in your market?

Best regards,
${sender}
${company}`,
    valueSubject: "Following up — best-selling references for your market",
    value: (g, p, sender, company, product) => `Dear ${g},

I am following up on my previous message regarding ${product}.

I can prepare a starter list of the highest-demand references for the ${p.market} market in a single mixed container, complete with an OE cross-reference so your counter staff can match parts quickly.

If you could share the vehicle models you serve most, I will tailor the quotation to suit.

Best regards,
${sender}
${company}`
  },
  electronics: {
    firstSubject: (origin) => `Consumer electronics from ${origin} — ODM/OEM, CE & FCC ready`,
    hook: "ODM/OEM, CE & FCC ready",
    first: (g, p, sender, company, product, desc, origin) => `Dear ${g},

I am writing from ${company}, a ${origin}-based exporter of ${product}. We work within an established electronics manufacturing base, which allows us to offer stable supply and competitive terms.

We understand ${p.company} may source ${product} for the ${p.market} market, and we would welcome the opportunity to support your range.${desc ? "\n\n" + desc : ""}

Points our customers value:
• ODM/OEM capability for your own brand and packaging
• CE, FCC and RoHS compliance, with reliable lead times
• Dependable supply from an established manufacturing base

I would be glad to send a product list with specifications and an indicative price range, along with our ODM options should you carry a private label. May I forward these for your review?

Best regards,
${sender}
${company}`,
    valueSubject: "Following up — ODM options and best-moving SKUs",
    value: (g, p, sender, company, product) => `Dear ${g},

I am following up on my previous message regarding ${product}.

If you carry a private label, I can share our ODM options — MOQ, customisation and packaging — together with the relevant CE/FCC documentation. If you resell established lines, I will send our best-moving SKUs with a clear price list.

May I ask which categories you are focusing on this season, so I can tailor the proposal accordingly?

Best regards,
${sender}
${company}`
  },
  machinery: {
    firstSubject: (origin) => `Machinery & equipment from ${origin} — project-grade, full after-sales`,
    hook: "project-grade, full after-sales",
    first: (g, p, sender, company, product, desc, origin) => `Dear ${g},

I am writing from ${company}, a ${origin}-based exporter of ${product}, with a focus on project-grade reliability and full after-sales support.

We understand ${p.company} may require ${product} for projects in the ${p.market} market, and we would be glad to be considered as a supplier.${desc ? "\n\n" + desc : ""}

Project buyers typically require, and we are able to provide:
• Specification-matched equipment, with spare parts and after-sales support
• CE and ISO 9001 certification, complete export documentation and proper export crating
• Guidance on installation and commissioning

If you could share the equipment type and capacity required, I will send matching models together with an indicative quotation.

Best regards,
${sender}
${company}`,
    valueSubject: "Following up — specifications, spares and after-sales terms",
    value: (g, p, sender, company, product) => `Dear ${g},

I am following up on my previous message regarding ${product}.

To assist your evaluation, I can prepare a specification sheet, a spare-parts list and our after-sales terms in advance, so the details are ready for your review or tender.

If you could let me know the capacity and timeline you require, I will tailor the quotation accordingly.

Best regards,
${sender}
${company}`
  }
};

/* ---------- 首封主题行 A/B ----------
   开发信里变量最大的就是主题行，但只有一个版本就没有对照可比。
   A = 品类卖点式（供应商自述，原有写法）
   B = 点名公司的提问式（买家视角）
   按线索 id 稳定哈希分配：同一条线索永远落在同一个变体上，
   重建序列、切换活动、重新入队都不会漂移，否则统计就没意义了。 */
function subjectVariantOf(prospect) {
  return hashInt(String(prospect?.id || "")) % 2 === 0 ? "A" : "B";
}

function firstSubjectVariants(tpl, focused, product, origin, prospect) {
  const a = tpl
    ? focused
      ? `${product} from ${origin} — ${tpl.hook || "factory supplier"}`
      : tpl.firstSubject(origin)
    : `Supplier option for ${product}`;
  const company = String(prospect?.company || "").slice(0, 40);
  const b = company ? `${company} — sourcing ${product} from ${origin}?` : `Sourcing ${product} from ${origin}?`;
  return { A: a, B: b };
}

function buildEmailSequence(campaign, prospect) {
  if (!prospect) return [];

  const props = campaign.valueProps;
  const certs = campaign.certifications;
  const product = campaign.product;
  const sender = campaign.senderName;
  const company = campaign.companyName;
  const greeting =
    prospect.contactName && !["待补全", "待确认", "待确认采购角色"].includes(prospect.contactName)
      ? prospect.contactName.split(" ")[0]
      : "Sir or Madam";
  // 优先用线索自己的品类（四品类并行时不串话术），线索没记品类才退回当前活动的品类
  const tpl = CATEGORY_EMAIL_TEMPLATES[prospect.presetKey || campaign.presetKey];
  // 产地：用户填的城市，留空退回 China
  const origin = originName(campaign);
  // 非英语市场：首封加当地语言开场（西/葡/阿/法/俄/越/印尼/土），提高打开后的信任度与回复率
  const localIntro = localIntroFor(prospect.market, greeting, product, campaign);
  const withIntro = (body) => (localIntro ? `${localIntro}\n\n---\n\n${body}` : body);
  // 专业产品描述：AI 细化产出或人工填写，作为首封信里介绍产品的核心段落
  const desc = (campaign.productDescription || "").trim();
  // 聚焦具体产品时（点过 AI 细化或填了聚焦），主题直接点名该产品，比泛品类主题打开率更高
  const focused = (campaign.productTerms || []).length > 0;
  const variant = subjectVariantOf(prospect);
  const firstSubject = firstSubjectVariants(tpl, focused, product, origin, prospect)[variant];

  const sequence = [
    {
      id: makeId("email"),
      label: "首封开发信",
      dayOffset: 0,
      subject: firstSubject,
      subjectVariant: variant,
      body: withIntro(tpl
        ? tpl.first(greeting, prospect, sender, company, product, desc, origin)
        : `Dear ${greeting},

I am writing from ${company}, a ${origin}-based factory and export supplier of ${product}.

We understand ${prospect.company} may source ${product} for the ${prospect.market} market, and we would welcome the opportunity to support your requirements.${desc ? "\n\n" + desc : ""}

Our key strengths include ${props}, and for your market we are able to prepare samples, export packing and documentation such as ${certs}.

I would be glad to send a short catalogue together with an indicative price range. May I forward these for your review?

Best regards,
${sender}
${company}`)
    },
    {
      id: makeId("email"),
      label: "价值跟进",
      dayOffset: 3,
      subject: tpl && !focused ? tpl.valueSubject : `Following up on ${product}`,
      body: tpl
        ? tpl.value(greeting, prospect, sender, company, product)
        : `Dear ${greeting},

I am following up on my previous message regarding ${product}.

Buyers of ${product} typically prioritise consistent quality, dependable delivery and repeat-order reliability — areas in which our key strengths (${props}) allow us to support you well. We would also be glad to begin with a small trial order.

Should this category be on your sourcing list, I would be glad to send three to five matching options for your consideration.

Best regards,
${sender}
${company}`
    },
    {
      id: makeId("email"),
      label: "样品/案例",
      dayOffset: 7,
      subject: `Product options and samples for the ${prospect.market} market`,
      body: `Dear ${greeting},

Following our earlier correspondence, I have prepared a selection of ${product} options suited to the ${prospect.market} market — including standard models, custom-logo versions and export packing choices.

If you could share your target quantity or price range, I will refine the selection and send a clear quotation.

Best regards,
${sender}
${company}`
    },
    {
      id: makeId("email"),
      label: "最后触达",
      dayOffset: 14,
      subject: `Closing the loop on ${product}`,
      body: `Dear ${greeting},

I appreciate you may not have an immediate requirement for ${product}, and I do not wish to crowd your inbox.

If it is not relevant at present, I am glad to keep your details on file and reach out only when it may be useful. Alternatively, I would be happy to send a catalogue for your future reference. Either way, thank you for your time.

Best regards,
${sender}
${company}`
    }
  ];

  // 合规：每封信尾附一句专业的退订说明（回复 unsubscribe 会被系统识别为退订并自动拉黑）
  const unsub = `Should you prefer not to receive further messages, kindly reply with "unsubscribe" and I will remove your details from my list.`;
  return sequence.map((email) => ({ ...email, body: `${email.body}\n\n${unsub}` }));
}

/* ---------- 协同模式的 WhatsApp 话术 ----------
   这条的任务不是再推销一遍，是把那封邮件从垃圾箱/收件箱噪音里捞出来。
   所以它必须引用邮件的主题和日期——两条各自独立推销像群发机器人，
   后者引用前者才像认真跟进的销售。同样两条消息，完全不同的观感。 */
function buildWhatsappEmailAssist(campaign, prospect, emailSubject, emailDate) {
  const greeting =
    prospect.contactName && !["待补全", "待确认", "待确认采购角色"].includes(prospect.contactName)
      ? prospect.contactName.split(" ")[0]
      : "there";
  // 公司名常以 Co./Ltd./Inc. 结尾，直接接句号会写出 "Co.."——每封协同消息都会带这个瑕疵
  const company = String(campaign.companyName || "").replace(/\.\s*$/, "");
  return {
    id: makeId("wa"),
    label: "邮件跟进",
    stage: "确认邮件收到",
    dayOffset: clamp(Number(state.relay?.parallelWaDelayDays) || 2, 1, 14),
    message: `Hello ${greeting}, this is ${campaign.senderName} from ${company}. I sent you an email${
      emailDate ? ` on ${emailDate}` : ""
    } regarding ${campaign.product} — subject: "${emailSubject}". It may have landed in your spam folder. Would you mind taking a look? I am happy to answer any questions here as well.`
  };
}

function buildWhatsappSequence(campaign, prospect) {
  if (!prospect) return [];

  const product = campaign.product;
  const sender = campaign.senderName;
  const company = campaign.companyName;
  const greeting =
    prospect.contactName && !["待补全", "待确认", "待确认采购角色"].includes(prospect.contactName)
      ? prospect.contactName.split(" ")[0]
      : "there";

  return [
    {
      id: makeId("wa"),
      label: "首条触达",
      stage: "确认相关性",
      dayOffset: 0,
      message: `Hello ${greeting}, this is ${sender} from ${company}, a supplier of ${product} in ${originLocation(campaign)}. May I ask whether ${prospect.company} handles sourcing for this category? I would be glad to share our catalogue and pricing.`
    },
    {
      id: makeId("wa"),
      label: "价值补充",
      stage: "发送卖点",
      dayOffset: 1,
      message: `Thank you. We manufacture ${product}; our key strengths include ${campaign.valueProps}. If it is of interest, I would be glad to send a short catalogue and an indicative price range here or by email — whichever you prefer.`
    },
    {
      id: makeId("wa"),
      label: "轻跟进",
      stage: "低压跟进",
      dayOffset: 4,
      message: `Just a brief follow-up on ${product}. If it is not currently on your sourcing list, no problem at all. If it is, I would be happy to share three matching options for your review.`
    }
  ];
}

async function runAutomation() {
  if (!requireCampaignBrief("准备获客队列")) return;
  runBegin("准备获客队列", "读取活动设置…");
  readCampaignFromForm();
  state.searchPlan = generateSearchPlan(state.campaign);
  addLog("开始准备获客队列");

  let prospects = null;
  if (remoteSearchReady()) {
    runStep("联网采集线索…");
    prospects = await trySearchWebhook();
  }

  if (!prospects?.length && elements.searchResultsInput.value.trim()) {
    runStep("解析粘贴的搜索结果…");
    prospects = importSearchResultsText(elements.searchResultsInput.value, state.campaign);
    addLog(`从粘贴结果解析 ${prospects.length} 个线索`);
  }

  if (prospects?.length) {
    const admitted = admitProspects(prospects, "搜索采集");
    state.prospects = [...admitted, ...state.prospects];
    agentOnProspectsImported(admitted);
  }

  // 没有任何线索可跑：主动带用户去导入，而不是静默结束
  if (!activeProspects().length) {
    runAbort("还没有线索，任务没能开跑", { label: "去导入线索", view: "discovery" });
    saveState();
    render();
    navigateTo("discovery");
    elements.searchResultsInput.focus();
    addLog("还没有线索：请在下方粘贴搜索结果（点「示例格式」可快速试用），或在「设置」接入采集 Webhook");
    saveState();
    renderLogs();
    return;
  }

  // 有线索：跑完整一拍——补全验证 → 高分入队待审 → WhatsApp 待确认 → 接力待审
  const raw = activeProspects().filter((item) => ["新发现", "待审核"].includes(item.status));
  if (raw.length) {
    runStep(`补全并验证 ${raw.length} 个线索的联系方式…`);
    const processed = verifyProspectList(enrichProspectList(raw, state.campaign), state.campaign);
    replaceProspectsById(processed);
  }

  runStep("生成邮件与 WhatsApp 话术、排队待审…");
  state.selectedProspectId = activeProspects()[0]?.id || null;
  state.sequence = buildEmailSequence(state.campaign, getSelectedProspect());
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  queueTopProspects();
  queueTopWhatsappProspects();
  scheduleFollowupTasks(false);
  const relayed = relayPass(true);
  const pendingEmail = activeOutboxItems().filter((item) => ["待审批", "待发送"].includes(item.status)).length;
  const pendingWa = activeWhatsappQueueItems().filter((item) => item.status === "待人工确认").length;
  addLog(
    `自动化准备完成：${activeProspects().length} 个线索，${pendingEmail} 封邮件待审批发送，接力 ${relayed} 条${
      pendingWa ? `；${pendingWa} 条 WhatsApp 待人工确认` : ""
    }`
  );
  // 跑通了但一条都没排上队，多半是邮箱没验证过（未验证不许发是铁律），要说清楚而不是干报「完成」
  runDone(
    pendingEmail || pendingWa
      ? `${activeProspects().length} 个线索 · ${pendingEmail} 封邮件待审批 · 接力 ${relayed} 条${
          pendingWa ? ` · ${pendingWa} 条 WhatsApp 待确认` : ""
        }（还没发出去，等你审批）`
      : `${activeProspects().length} 个线索，但没有可发的：邮箱未验证的不会入队，去「潜客」补全联系方式`,
    pendingEmail || pendingWa
      ? { label: "去审批发送", view: "automation" }
      : { label: "去补全联系方式", view: "prospects" }
  );
  saveState();
  render();
  navigateTo("automation");
}

/* ---------- 直连 SerpAPI ----------
   和 AI 引擎同一个模式：填个 key 就能用，不必为了转发一个 HTTP 请求去自建 n8n。
   桌面版 webSecurity:false 所以没有 CORS 问题；浏览器轻量模式下会被跨域拦，
   因此只在桌面版提供直连，浏览器模式仍走 Webhook。 */
function serpApiReady() {
  return !!mkdBridge() && !!(state.settings.serpApiKey || "").trim();
}

// 有没有可用的联网找客户来源（直连 SerpAPI 或搜索 Webhook）。本地模拟模式一律没有。
function remoteSearchReady() {
  if (state.settings.mode === "local") return false;
  return serpApiReady() || (state.settings.mode === "webhook" && !!webhookUrl("search"));
}

async function trySerpApi(maxQueries = 3) {
  const key = (state.settings.serpApiKey || "").trim();
  const queries = (state.searchPlan || []).map((q) => q.query).filter(Boolean).slice(0, maxQueries);
  if (!queries.length) {
    addLog("还没有搜索式：先点「生成搜索式」");
    return null;
  }
  const found = [];
  const seen = new Set();
  for (const q of queries) {
    // 每条搜索式都是一次计费调用，逐条查额度而不是整批
    if (!apiQuotaOk("serp", "SerpAPI")) break;
    try {
      apiUsageBump("serp");
      const url = `https://serpapi.com/search.json?engine=google&num=20&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}`;
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url);
      // eslint-disable-next-line no-await-in-loop
      const data = await res.json();
      if (data.error) {
        addLog(`SerpAPI 返回错误：${data.error}`);
        return null;
      }
      (data.organic_results || []).forEach((r) => {
        let host = "";
        try {
          host = new URL(r.link).hostname.replace(/^www\./, "");
        } catch {
          return;
        }
        // 平台站/社媒/目录站不是客户
        if (!host || NON_COMPANY_DOMAIN.test(host) || seen.has(host)) return;
        seen.add(host);
        found.push({
          company: (r.title || domainToCompany(host)).split(/[|\-–—·]/)[0].trim().slice(0, 60),
          website: host,
          source: "SerpAPI",
          buyingSignal: (r.snippet || "").slice(0, 160) || `Google 搜索命中：${q}`,
          searchQuery: q
        });
      });
    } catch (error) {
      addLog(`SerpAPI 调用失败：${error.message}`);
      return null;
    }
  }
  if (!found.length) {
    addLog("SerpAPI 没返回可用公司（结果里全是平台站/目录站，试试换更具体的搜索式）");
    return null;
  }
  addLog(`SerpAPI 直连：从 ${queries.length} 条搜索式找到 ${found.length} 家公司`);
  return normalizeRemoteProspects(found);
}

async function trySearchWebhook() {
  // 直连优先：配了 SerpAPI key 就不必再经 Webhook 中转
  if (serpApiReady()) {
    const direct = await trySerpApi();
    if (direct?.length) return direct;
  }
  if (!webhookUrl("search")) return null;
  const result = await callWebhook("search", { campaign: state.campaign, searchPlan: state.searchPlan });
  if (result.ok && Array.isArray(result.data?.prospects) && result.data.prospects.length) {
    addLog(`Webhook 返回 ${result.data.prospects.length} 个潜客`);
    return normalizeRemoteProspects(result.data.prospects);
  }
  addLog(result.ok ? "Webhook 未返回线索，等待导入真实搜索结果" : `搜索 Webhook 失败：${result.error || result.code || "未配置"}`);
  return null;
}

/* ---------- Webhook 联调（连接测试 + 真实派发 + 活动日志） ---------- */

function setWebhookStatus(name, status) {
  if (!state.settings.webhookStatus) state.settings.webhookStatus = {};
  state.settings.webhookStatus[name] = { ...status, time: timestamp() };
}

function recordWebhook(name, entry) {
  const label = WEBHOOK_CONNECTORS[name]?.label || name;
  const detail = entry.ok
    ? `${label} · ${entry.code || 200} · ${entry.ms}ms${entry.note ? ` · ${entry.note}` : ""}`
    : `${label} · 失败 · ${entry.note || entry.code || "无响应"}`;
  state.webhookLog.unshift({ id: makeId("wh"), ok: entry.ok, message: detail, url: entry.url || "", time: timestamp() });
  state.webhookLog = state.webhookLog.slice(0, 40);
}

function webhookUrl(name) {
  const cfg = WEBHOOK_CONNECTORS[name];
  if (!cfg) return "";
  return (elements[cfg.urlKey]?.value || state.settings[cfg.urlKey] || "").trim();
}

async function callWebhook(name, payload) {
  const url = webhookUrl(name);
  if (!url) {
    setWebhookStatus(name, { ok: false, note: "未配置" });
    recordWebhook(name, { url: "", ok: false, note: "未配置 URL" });
    return { ok: false, skipped: true };
  }
  // 发信 payload 附带发送时机：n8n 可按 suggested_window_beijing 定时投递（客户当地上午 9-11 点）
  if (name === "send" && Array.isArray(payload?.emails)) {
    payload = {
      ...payload,
      emails: payload.emails.map((e) => {
        const prospect = state.prospects.find((p) => p.id === e.prospectId);
        const t = sendTimingFor(prospect?.market);
        return t
          ? { ...e, recipient_utc_offset: t.offset, recipient_local_time: t.localTime, suggested_window_beijing: t.windowBJ }
          : e;
      })
    };
  }
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: name, sentAt: new Date().toISOString(), ...payload })
    });
    const ms = Date.now() - start;
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    setWebhookStatus(name, { ok: response.ok, code: response.status, ms });
    recordWebhook(name, { url, ok: response.ok, code: response.status, ms });
    return { ok: response.ok, code: response.status, data, ms };
  } catch (error) {
    const ms = Date.now() - start;
    setWebhookStatus(name, { ok: false, note: error.message, ms });
    recordWebhook(name, { url, ok: false, note: error.message, ms });
    return { ok: false, error: error.message, ms };
  }
}

/* ---------- 发信分派：直连 SMTP / Webhook / 本地模拟 三选一 ----------
   原先五个发送入口各写一遍"判断模式 → 调 webhook → 成功改状态"，
   加内置 SMTP 就要改五处、漏一处就有一条路绕过新逻辑。统一收敛到这里。

   返回 { sent, failed, error }，调用方只管数字与提示。
   直连模式下逐封回执：一封认证失败不该把整批标成已发送。 */
function directSendReady() {
  return state.settings.mode === "direct" && !!MKD_MAIL?.smtp?.configured;
}

function markEmailSent(item) {
  item.status = "已发送";
  item.sentAt = new Date().toISOString();
  item.delivered = true;
  advanceDealStage(item.prospectId, "已触达");
}

async function deliverEmailBatch(items, { quiet = false } = {}) {
  if (!items.length) return { sent: 0, failed: 0 };

  // 直连：主进程逐封发，回执逐封回写
  if (directSendReady()) {
    const bridge = mkdBridge();
    const res = await bridge.smtpSend({
      fromName: state.campaign.companyName,
      emails: items.map((i) => ({ id: i.id, email: i.email, subject: i.subject, body: i.body }))
    });
    if (!res?.ok) {
      if (!quiet) addLog(`SMTP 发送失败，${items.length} 封保留待发送：${res?.error || "未知错误"}`);
      return { sent: 0, failed: items.length, error: res?.error };
    }
    const byId = new Map(res.results.map((r) => [r.id, r]));
    let sent = 0;
    let failed = 0;
    const errors = new Set();
    items.forEach((item) => {
      const r = byId.get(item.id);
      if (r?.ok) {
        markEmailSent(item);
        item.messageId = r.messageId || "";
        sent += 1;
      } else {
        failed += 1;
        if (r?.error) errors.add(r.error);
      }
    });
    if (!quiet && sent) addLog(`SMTP 直发：已发出 ${sent} 封`);
    if (failed) addLog(`${failed} 封发送失败，已保留待发送：${[...errors].join("；") || "未知错误"}`);
    return { sent, failed, error: [...errors][0] };
  }

  // Webhook：整批派发，成功才改状态
  if (state.settings.mode === "webhook" && webhookUrl("send")) {
    const result = await callWebhook("send", { emails: items });
    if (result.ok) {
      items.forEach(markEmailSent);
      if (!quiet) addLog(`发信 Webhook：已派发 ${items.length} 封邮件`);
      return { sent: items.length, failed: 0 };
    }
    if (!quiet) addLog(`发信 Webhook 失败，${items.length} 封保留待发送：${result.error || result.code || "未配置"}`);
    return { sent: 0, failed: items.length, error: result.error || result.code };
  }

  // 本地模拟
  items.forEach(deliverEmail);
  if (!quiet) addLog(`本地模拟发送 ${items.length} 封（切到「直连」或「Webhook」才会真的发出去）`);
  return { sent: items.length, failed: 0, simulated: true };
}

async function testWebhook(name) {
  readSettingsFromForm();
  addLog(`测试 ${WEBHOOK_CONNECTORS[name]?.label || name} Webhook 连接`);
  renderWebhookStatus(name, { ok: false, note: "测试中", pending: true });
  const result = await callWebhook(name, {
    ping: true,
    campaign: { product: state.campaign.product, markets: state.campaign.markets }
  });
  addLog(result.skipped ? "未填写该 Webhook 地址" : result.ok ? "连接成功" : `连接失败：${result.error || result.code}`);
  saveState();
  render();
}

async function dispatchPending() {
  readSettingsFromForm();
  const today = dateOffset(0);

  if (state.settings.mode !== "webhook") {
    let sent = 0;
    let blocked = 0;
    activeOutboxItems().forEach((item) => {
      if (item.status !== "待发送" || item.dueDate > today) return;
      if (!preflightOutboxItem(item).ok) {
        blocked += 1;
        return;
      }
      item.status = "已发送";
      item.sentAt = new Date().toISOString();
      const h = hashInt(item.prospectId + item.step);
      item.delivered = h % 100 < 95;
      const prospect = state.prospects.find((p) => p.id === item.prospectId);
      item.opened = item.delivered && (h >> 3) % 100 < Math.min(88, 38 + Math.round((prospect?.score || 60) * 0.5));
      advanceDealStage(item.prospectId, "已触达");
      sent += 1;
    });
    const waSent = deliverApprovedWhatsapp(true);
    addLog(
      `本地模式：模拟发送 ${sent} 封已批准到期邮件、${waSent} 条已审批到期 WhatsApp${blocked ? `，预检拦截 ${blocked} 封` : ""}（切到 Webhook 模式可派发到真实服务）`
    );
    saveState();
    render();
    return;
  }

  const pendingEmailCandidates = activeOutboxItems().filter((item) => item.status === "待发送" && item.dueDate <= today);
  const pendingEmails = pendingEmailCandidates.filter((item) => preflightOutboxItem(item).ok);
  const blockedEmails = pendingEmailCandidates.length - pendingEmails.length;
  const approvedWa = activeWhatsappQueueItems().filter((item) => item.status === "已审批" && item.dueDate <= today);
  if (blockedEmails) addLog(`发信预检拦截 ${blockedEmails} 封已批准邮件，请先修复联系方式或退订状态`);

  if (pendingEmails.length) await deliverEmailBatch(pendingEmails);

  if (approvedWa.length) {
    const result = await callWebhook("whatsapp", { messages: approvedWa });
    if (result.ok) {
      approvedWa.forEach((item) => {
        item.status = "已发送";
        item.sentAt = item.sentAt || new Date().toISOString();
        advanceDealStage(item.prospectId, "已触达");
      });
      addLog(`WhatsApp Webhook：已派发 ${approvedWa.length} 条模板消息`);
    } else {
      addLog(`WhatsApp Webhook 派发失败：${result.error || result.code || "未配置"}`);
    }
  }

  const prospects = activeProspects();
  if (prospects.length) {
    const result = await callWebhook("crm", {
      prospects: prospects.map((p) => ({
        company: p.company,
        market: p.market,
        email: p.email,
        phone: p.phone,
        stage: p.dealStage,
        score: computeLeadScore(p).probability
      }))
    });
    if (result.ok) addLog(`CRM Webhook：已同步 ${prospects.length} 个客户`);
    else addLog(`CRM Webhook 同步失败：${result.error || result.code || "未配置"}`);
  }

  if (!pendingEmails.length && !approvedWa.length) {
    addLog("没有已批准待发送邮件或已审批 WhatsApp（可先在队列/审批中心处理）");
  }
  saveState();
  render();
}

function renderWebhookStatus(name, override) {
  const names = name ? [name] : Object.keys(WEBHOOK_CONNECTORS);
  names.forEach((key) => {
    const el = document.querySelector(`[data-webhook-status="${key}"]`);
    if (!el) return;
    const status = override || state.settings.webhookStatus?.[key];
    el.classList.remove("ok", "fail", "pending");
    if (!status) {
      el.textContent = "未测试";
      return;
    }
    if (status.pending) {
      el.classList.add("pending");
      el.textContent = "测试中…";
      return;
    }
    if (status.ok) {
      el.classList.add("ok");
      el.textContent = `正常 · ${status.code || 200} · ${status.ms ?? "-"}ms`;
    } else {
      el.classList.add("fail");
      el.textContent = status.note === "未配置" ? "未配置" : `失败 · ${status.note || status.code || ""}`;
    }
  });
}

function renderWebhookLog() {
  if (!elements.webhookLog) return;
  elements.webhookLog.innerHTML = state.webhookLog.length
    ? state.webhookLog
        .map(
          (item) => `
            <article class="log-item ${item.ok ? "ok" : "fail"}">
              <strong>${escapeHtml(item.message)}</strong>
              <span>${item.time}</span>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">暂无 Webhook 调用记录</div>`;
}

function renderWebhookPanel() {
  renderWebhookStatus();
  renderWebhookLog();
}

/* ---------- 自动驾驶引擎（全流程自动流转） ---------- */

let autopilotTimer = null;

function setJob(id, patch) {
  state.management.jobs = state.management.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job));
}

function setJobDone(id) {
  setJob(id, { status: "已完成", progress: 100, nextRun: state.autopilot?.enabled ? "自动驾驶中" : "下个周期" });
}

function crmProspectsPayload() {
  return activeProspects().map((p) => ({
    company: p.company,
    market: p.market,
    email: p.email,
    phone: p.phone,
    stage: p.dealStage,
    score: computeLeadScore(p).probability
  }));
}

function startAutopilotTimer() {
  if (autopilotTimer) clearInterval(autopilotTimer);
  autopilotTimer = setInterval(() => {
    autopilotTick();
  }, (state.autopilot?.intervalSec || 8) * 1000);
}

function setAutopilot(enabled) {
  state.autopilot = { ...(state.autopilot || { intervalSec: 8 }), enabled };
  if (enabled) {
    startAutopilotTimer();
    addLog("自动驾驶已开启：自动 找客户→补全联系方式→验证→评分→备好触达方案；发送始终等你审批（Agent 审批卡 / 队列 / 审批中心）");
    saveState();
    render();
    autopilotTick();
  } else {
    if (autopilotTimer) clearInterval(autopilotTimer);
    autopilotTimer = null;
    addLog("自动驾驶已暂停，可随时手动操作");
    saveState();
    render();
  }
}

async function autopilotTick() {
  if (!state.autopilot?.enabled) return;
  const actions = [];

  // -1) 拉取真实客户回信（配置了拉取回复 Webhook 时，每分钟最多拉一次）
  if (
    (state.settings.mode === "direct" && MKD_MAIL?.imap?.configured) ||
    (state.settings.mode === "webhook" && webhookUrl("inbound"))
  ) {
    const lastPull = state.lastInboundPullAt ? new Date(state.lastInboundPullAt).getTime() : 0;
    if (Date.now() - lastPull > 60000) {
      const pulled = await pullInboundReplies(true);
      if (pulled) actions.push(`拉取回信 ${pulled} 条`);
    }
  }

  // -0.5) 拉取发送状态回传（送达/退信/打开；硬退信自动拉黑，保护发信域名）
  if (state.settings.mode === "webhook" && webhookUrl("status")) {
    const lastStatus = state.lastStatusPullAt ? new Date(state.lastStatusPullAt).getTime() : 0;
    if (Date.now() - lastStatus > 60000) {
      const synced = await pullDeliveryStatus(true);
      if (synced) actions.push(`同步发送状态 ${synced} 条`);
    }
  }

  // 0) Agent 周期任务：到周期自动补充一批新线索
  if (agentCycleDue()) {
    const added = await agentRunCycle(false);
    if (added) actions.push(`周期补量 ${added} 家`);
  }

  // 1) 新线索自动补全 + 验证
  const raw = activeProspects().filter((p) => ["新发现", "待审核"].includes(p.status));
  if (raw.length) {
    const processed = verifyProspectList(enrichProspectList(raw, state.campaign), state.campaign);
    replaceProspectsById(processed);
    actions.push(`补全并验证 ${processed.length} 条新线索`);
    setJobDone("job-enrich");
    setJobDone("job-verify");
  }

  // 2) 高分线索入队暂存（仅无 Agent 任务时；Agent 任务运行时由审批卡把关，不越过审批自动入队）
  //    ★ 发送必须人工审批：自动驾驶只把高分线索备到「待审批」，不自动发出
  if (!state.agent?.task || state.agent.task.status === "draft") {
    const queuedBefore = activeOutboxItems().length + activeWhatsappQueueItems().length;
    queueTopProspects();
    queueTopWhatsappProspects();
    const queuedDelta = activeOutboxItems().length + activeWhatsappQueueItems().length - queuedBefore;
    if (queuedDelta > 0) {
      actions.push(`备好 ${queuedDelta} 条待审批触达（等你确认发送）`);
      setJobDone("job-queue");
    }
  }

  // 3) 跨渠道接力（生成的是待审批/待确认，同样等人工发送，不自动发出）
  const relayed = relayPass(true);
  if (relayed) actions.push(`跨渠道接力备好 ${relayed} 条`);

  // 6) 已回复且未响应的会话，自动生成 AI 回复草稿送审批
  //    注意：忽略「已取消」的触达事件（回复即停产生），否则被取消的未来邮件会掩盖客户回复
  let drafts = 0;
  buildConversations().forEach((conversation) => {
    // 已被初轮应答护栏处理（自动答复/转人工/opt-out）的会话不再生成草稿
    const lastInbound = [...state.inbound].reverse().find((m) => m.prospectId === conversation.prospectId);
    if (lastInbound?.autoAction) return;
    const lastMeaningful = [...conversation.events]
      .reverse()
      .find((e) => e.kind === "inbound" || (e.kind === "outbound" && e.status !== "已取消"));
    if (conversation.replied && lastMeaningful?.kind === "inbound" && createAiDraft(conversation.prospectId)) {
      drafts += 1;
    }
  });
  if (drafts) actions.push(`生成 ${drafts} 份 AI 回复草稿待审批`);

  if (actions.length) {
    addLog(`自动驾驶：${actions.join("；")}`);
    if (state.settings.mode === "webhook" && webhookUrl("crm")) {
      callWebhook("crm", { prospects: crmProspectsPayload() }).then((result) => {
        if (result.ok) setJobDone("job-crm");
      });
    }
    saveState();
    render();
  }
}

function updateAutopilotButton() {
  const on = !!state.autopilot?.enabled;
  elements.autopilotToggle.classList.toggle("is-on", on);
  const label = elements.autopilotToggle.querySelector("span");
  if (label) label.textContent = on ? "自动驾驶：开" : "自动驾驶：关";
}

/* ---------- 导航徽标 + 新手引导清单 ---------- */

function renderNavBadges() {
  const outbox = activeOutboxItems();
  /* 红点跟着「能动手的地方」走，同一批活只标一次。
     管理页不出红点：它的审批中心是跨页总览，每一项在各自的操作页上都已经有红点，
     再标一次会让人以为还有另一批要处理（用户实测就是这么误解的）。
     WhatsApp 队列和邮件队列同在「触达队列」页，所以合并计入 automation。 */
  const waPending = activeWhatsappQueueItems().filter((i) => i.status === "待人工确认").length;
  const badges = {
    // 未读回信跨活动统计：收件箱本身已经不按活动切了，红点再按活动算就会
    // 出现「有新询盘但红点不亮」——那是最不该丢的东西。
    inbox: (state.inbound || []).filter((m) => !m.read).length,
    automation: outbox.filter((i) => ["待审批", "待发送"].includes(i.status)).length + waPending,
    agent: activeAgentApprovals().filter((a) => a.status === "pending").length
  };
  elements.navTabs.forEach((tab) => {
    const count = badges[tab.dataset.view] || 0;
    let badge = tab.querySelector(".nav-badge");
    if (!count) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-badge";
      tab.appendChild(badge);
    }
    badge.textContent = count > 99 ? "99+" : String(count);
    // 光一个数字看不出是什么。悬停给出逐项明细，不用点进去猜。
    badge.title = navBadgeDetail(tab.dataset.view, count);
    tab.title = badge.title;
  });
}

// 红点的明细：这 N 条分别是什么、在哪处理
function navBadgeDetail(view, count) {
  if (view === "automation") {
    const outbox = activeOutboxItems();
    const pending = outbox.filter((i) => i.status === "待审批").length;
    const approved = outbox.filter((i) => i.status === "待发送").length;
    const wa = activeWhatsappQueueItems().filter((i) => i.status === "待人工确认").length;
    const rows = [`· 邮件待审批 ${pending} 封`, `· 邮件已批准待发送 ${approved} 封`];
    if (wa) rows.push(`· WhatsApp 待人工确认 ${wa} 条`);
    return `${count} 条在触达队列里：\n${rows.join("\n")}\n（发送始终等你点最后一下）`;
  }
  if (view === "inbox") return `${count} 条客户新回复还没读`;
  if (view === "agent") return `${count} 张 Agent 触达卡等你审批`;
  return `${count} 条待处理`;
}

function nextActionRecommendation() {
  const brief = campaignBriefStatus();
  const prospects = activeProspects();
  const outbox = activeOutboxItems();
  const whatsappQueue = activeWhatsappQueueItems();
  const inbound = activeInboundItems();
  const today = dateOffset(0);
  const contactable = prospects.filter((p) => emailLooksValid(p.email) || p.phone).length;
  // 缺联系方式的家数。原来只判断 contactable 是不是 0：只要有一家碰巧带了邮箱，
  // 「先补全联系方式」这一步就被整个跳过，剩下几十家没邮箱的再没被提起过。
  const missingContact = prospects.length - contactable;
  const guessedEmails = prospects.filter((p) => p.email && emailVerificationState(p, p.email) === "guessed").length;
  const pendingApproval = outbox.filter((i) => i.status === "待审批").length;
  const dueSend = outbox.filter((i) => i.status === "待发送" && i.dueDate <= today).length;
  const waPending = whatsappQueue.filter((i) => i.status === "待人工确认").length;
  const unread = inbound.filter((m) => !m.read).length;
  const dueFollow = dueFollowupProspects().length;

  if (!brief.ok) {
    return {
      icon: "rocket",
      title: "先锁定产品和目标市场",
      detail: "外贸自动化的搜索式、评分、开发信和合规提醒都依赖这个定位。",
      metric: "第 1 步",
      action: `data-next-action="focus-campaign"`,
      button: "填写定位"
    };
  }
  if (!state.searchPlan.length) {
    return {
      icon: "search",
      title: "生成第一版开发计划",
      detail: "先把市场、客户类型和搜索渠道拆出来，再去采集客户会更稳。",
      metric: "0 个搜索式",
      action: `data-next-action="generate-plan"`,
      button: "生成计划"
    };
  }
  if (!prospects.length) {
    return {
      icon: "users",
      title: "导入或采集第一批潜客",
      detail: "把官网、邮箱、海关买家或搜索结果灌进线索池，后面才能补全和触达。",
      metric: "0 条线索",
      action: `data-goto="discovery"`,
      button: "去获客"
    };
  }
  if (missingContact) {
    return {
      icon: "search",
      title: "先补全联系方式",
      // 把后面那步的数量也报出来，让人看得到整条链还剩什么，而不是只盯着当前这一步
      detail: `${missingContact} 家还没有可用邮箱或电话，补全后才能入队发信${
        guessedEmails ? `；另有 ${guessedEmails} 条推测邮箱待验证` : ""
      }。`,
      metric: `${missingContact}/${prospects.length} 缺联系方式`,
      action: `data-next-action="enrich-prospects"`,
      button: "批量补全"
    };
  }
  if (guessedEmails) {
    return {
      icon: "check",
      title: "验证推测邮箱",
      detail: "未验证邮箱会提高退信率，影响发信域名信誉；先验证再放量。",
      metric: `${guessedEmails} 条待验证`,
      action: `data-next-action="verify-prospects"`,
      button: "去验证"
    };
  }
  if (pendingApproval || waPending) {
    return {
      icon: "mail",
      title: "审批待触达内容",
      detail: "系统已经准备好邮件或 WhatsApp，发送前需要你最后确认。",
      metric: `${pendingApproval + waPending} 条待审`,
      action: `data-goto="automation"`,
      button: "去审批"
    };
  }
  if (dueSend) {
    return {
      icon: "zap",
      title: "发送已批准到期邮件",
      detail: "这些邮件已经过审批并到达排期，可以执行发送或继续预检。",
      metric: `${dueSend} 封到期`,
      action: `data-goto="automation"`,
      button: "去发送"
    };
  }
  if (unread) {
    return {
      icon: "inbox",
      title: "处理客户新回复",
      detail: "新回复会触发意图识别、回复即停和商机推进，优先级最高。",
      metric: `${unread} 条未读`,
      action: `data-goto="inbox"`,
      button: "看回复"
    };
  }
  if (dueFollow) {
    return {
      icon: "shuffle",
      title: "给到期未回复客户排跟进",
      detail: "已触达但还没回复的客户，按节奏跟进比继续盲目加量更有效。",
      metric: `${dueFollow} 位客户`,
      action: `data-todo="followup"`,
      button: "排跟进"
    };
  }
  if (!outbox.length && !whatsappQueue.length) {
    return {
      icon: "zap",
      title: "把优质潜客加入触达队列",
      detail: "先按质量分挑 A/B 级客户入队，发送仍会停在人工审批。",
      metric: `${prospects.length} 条线索`,
      action: `data-goto="prospects"`,
      button: "挑客户"
    };
  }
  return {
    icon: "chart",
    title: "复盘本活动效果",
    detail: "看市场、渠道、话术和主题行表现，再决定下一批往哪里加量。",
    metric: "进入复盘",
    action: `data-goto="analytics"`,
    button: "看分析"
  };
}

function renderNextActionCard() {
  const rec = nextActionRecommendation();
  return `
    <div class="next-action-card">
      <span class="next-action-icon"><svg><use href="#icon-${rec.icon}" /></svg></span>
      <div class="next-action-copy">
        <span class="next-action-metric">${escapeHtml(rec.metric)}</span>
        <strong>${escapeHtml(rec.title)}</strong>
        <span>${escapeHtml(rec.detail)}</span>
      </div>
      <button class="primary-button next-action-button" ${rec.action} type="button">
        <span>${escapeHtml(rec.button)}</span>
      </button>
    </div>`;
}

// 今日待办：把每天要处理的事（待审批 / 到期发送 / 新回复 / 到期跟进 / Agent 待审批）聚成一屏，一键直达
function renderTodo() {
  const host = elements.todoPanel;
  if (!host) return;
  const today = dateOffset(0);
  const outbox = activeOutboxItems();
  const agentPending = activeAgentApprovals().filter((a) => a.status === "pending").length;
  const pendingApproval = outbox.filter((i) => i.status === "待审批").length;
  const dueSend = outbox.filter((i) => i.status === "待发送" && i.dueDate <= today).length;
  const unread = activeInboundItems().filter((m) => !m.read).length;
  const dueFollow = dueFollowupProspects().length;

  // [图标, 数字, 说明, 触发属性, 按钮文案, 语气]
  const rows = [];
  if (agentPending) rows.push(["robot", agentPending, "个 Agent 客户待审批", `data-goto="agent"`, "去处理", ""]);
  if (pendingApproval) rows.push(["mail", pendingApproval, "封邮件待审批", `data-goto="automation"`, "去审批", ""]);
  if (dueSend) rows.push(["zap", dueSend, "封已批准邮件到期待发", `data-goto="automation"`, "去发送", "is-hot"]);
  if (unread) rows.push(["inbox", unread, "条新回复待处理", `data-goto="inbox"`, "去收件箱", "is-hot"]);
  if (dueFollow) rows.push(["shuffle", dueFollow, "位客户到期未回复", `data-todo="followup"`, "一键批量跟进", ""]);
  // 备份提醒：有真实数据且超 7 天没备份，直接进待办（数据在浏览器里，清缓存会丢）
  const lastBackup = state.ui?.lastBackupAt ? new Date(state.ui.lastBackupAt).getTime() : 0;
  if (activeProspects().length && Date.now() - lastBackup > 7 * 86400000) {
    const days = lastBackup ? Math.floor((Date.now() - lastBackup) / 86400000) : null;
    rows.push(["download", days ?? "—", lastBackup ? "天未备份数据" : "还没备份过（清缓存会丢）", `data-todo="backup"`, "一键导出备份", "is-warn"]);
  }

  // Webhook 模式且配了对应 Webhook 时，标题栏放一键拉取（前置条件与后台函数一致）
  const wh = state.settings.mode === "webhook";
  const canPull = wh && !!(state.settings.inboundWebhook || "").trim();
  const canStatus = wh && !!(state.settings.statusWebhook || "").trim();
  const pullBtn = canPull
    ? `<button class="ghost-button todo-pull" data-todo="pull" type="button"><svg><use href="#icon-download" /></svg><span>拉取新回复</span></button>`
    : "";
  const statusBtn = canStatus
    ? `<button class="ghost-button todo-pull" data-todo="pullstatus" type="button"><svg><use href="#icon-check" /></svg><span>拉取送达状态</span></button>`
    : "";
  const head = `<div class="todo-head"><strong>下一步</strong>${rows.length ? `<span class="todo-count">${rows.length} 项待办</span>` : ""}<span class="todo-head-spacer"></span>${pullBtn}${statusBtn}</div>`;
  const nextAction = renderNextActionCard();

  if (!rows.length) {
    host.innerHTML =
      head +
      nextAction +
      `<div class="todo-empty">今日暂无紧急待办。${canPull ? "点右上角「拉取新回复」看有没有新回信。" : "保持每天到收件箱点「拉取回复」，有新回信会自动出现在这里。"}</div>`;
    return;
  }
  // 横向卡组：一屏扫完今天要处理的事，数字最大、动作跟在下面（D1 设计）
  host.innerHTML =
    head +
    nextAction +
    `<div class="todo-cards">` +
    rows
      .map(
        ([icon, num, label, action, btn, tone]) => `
        <button class="todo-card ${tone}" ${action} type="button">
          <span class="tc-icon"><svg><use href="#icon-${icon}" /></svg></span>
          <span class="tc-num">${num}</span>
          <span class="tc-label">${label}</span>
          <span class="tc-act">${btn} →</span>
        </button>`
      )
      .join("") +
    `</div>`;
}

function renderChecklist() {
  const host = elements.onboardingChecklist;
  if (!host) return;
  if (state.ui?.checklistDismissed) {
    host.innerHTML = "";
    return;
  }
  const prospects = activeProspects();
  const outbox = activeOutboxItems();
  const whatsappQueue = activeWhatsappQueueItems();
  const inbound = activeInboundItems();
  const steps = [
    { label: "生成开发计划", hint: "填写产品与市场", done: state.searchPlan.length > 0, goto: "dashboard" },
    { label: "导入搜索结果", hint: "粘贴官网/邮箱/CSV", done: prospects.length > 0, goto: "discovery" },
    {
      label: "线索入队触达",
      hint: "审核线索并加入队列",
      done: outbox.length + whatsappQueue.length > 0,
      goto: "prospects"
    },
    {
      label: "开启自动驾驶",
      hint: "全流程自动流转",
      done: !!state.autopilot?.enabled || outbox.some((o) => o.status === "已发送"),
      action: "autopilot"
    },
    { label: "处理回复与审批", hint: "收件箱 + 审批中心", done: inbound.length > 0, goto: "inbox" }
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `
    <div class="checklist-panel">
      <div class="checklist-head">
        <strong>快速上手 · ${doneCount}/${steps.length}</strong>
        <button class="checklist-dismiss" data-checklist-dismiss type="button">不再显示</button>
      </div>
      <div class="checklist-steps">
        ${steps
          .map(
            (step, index) => `
              <button class="checklist-step ${step.done ? "done" : ""}" type="button" ${
                step.action ? `data-checklist-action="${step.action}"` : `data-goto="${step.goto}"`
              }>
                <span class="step-dot">${step.done ? "✓" : index + 1}</span>
                <span class="step-text"><strong>${step.label}</strong><small>${step.hint}</small></span>
              </button>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

/* ---------- 发送时机：按客户市场时区算最佳发送窗口（当地上午 9-11 点） ---------- */

// 市场 → 大致 UTC 偏移（代表性时区，不处理夏令时，够指导发送时段即可）
const MARKET_TZ = [
  [/united states|usa|america|estados unidos/i, -5, "美东"],
  [/canada/i, -5, ""],
  [/mexico/i, -6, ""],
  [/brazil|brasil/i, -3, ""],
  [/argentina/i, -3, ""],
  [/chile/i, -4, ""],
  [/colombia|peru|ecuador/i, -5, ""],
  [/united kingdom|uk|england|britain|ireland|portugal|ghana/i, 0, ""],
  [/germany|france|spain|italy|netherlands|belgium|poland|sweden|norway|denmark|switzerland|austria|czech|morocco|algeria|nigeria/i, 1, ""],
  [/greece|romania|finland|egypt|south africa|israel/i, 2, ""],
  [/turkey|russia|saudi|qatar|kuwait|bahrain|kenya|ethiopia|tanzania|iraq/i, 3, ""],
  [/uae|united arab emirates|dubai|oman/i, 4, ""],
  [/pakistan/i, 5, ""],
  [/india|sri lanka/i, 5.5, ""],
  [/bangladesh/i, 6, ""],
  [/indonesia|vietnam|thailand|cambodia/i, 7, ""],
  [/philippines|malaysia|singapore/i, 8, ""],
  [/japan|korea/i, 9, ""],
  [/australia/i, 10, "悉尼"],
  [/new zealand/i, 12, ""]
];

function marketUtcOffset(market) {
  const m = String(market || "");
  for (const [re, offset, note] of MARKET_TZ) {
    if (re.test(m)) return { offset, note };
  }
  return null;
}

// 返回该市场的发送时机信息；未知市场返回 null（不强行提示）
function sendTimingFor(market) {
  const tz = marketUtcOffset(market);
  if (!tz) return null;
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const localH = (((utcH + tz.offset) % 24) + 24) % 24;
  // 客户当地 9-11 点 对应的北京时间（UTC+8）
  const bjStart = Math.round((((9 - tz.offset + 8) % 24) + 24) % 24);
  const bjEnd = Math.round((((11 - tz.offset + 8) % 24) + 24) % 24);
  const hh = String(Math.floor(localH)).padStart(2, "0");
  const mm = String(Math.floor((localH % 1) * 60)).padStart(2, "0");
  return {
    offset: tz.offset,
    note: tz.note,
    localTime: `${hh}:${mm}`,
    windowBJ: `${bjStart}:00–${bjEnd}:00`,
    good: localH >= 8 && localH < 12, // 当地上午，正合适
    night: localH >= 0 && localH < 7 // 当地深夜，发了会沉箱底
  };
}

// 发信队列里每封待发邮件的时机徽章
function sendTimingBadge(item) {
  const prospect = state.prospects.find((p) => p.id === item.prospectId);
  const t = sendTimingFor(prospect?.market);
  if (!t) return "";
  if (t.good) return `<span class="timing-tag good" title="客户当地现在 ${t.localTime}，正是上午黄金时段">⏰ 当地 ${t.localTime} · 现在发正合适</span>`;
  if (t.night) return `<span class="timing-tag night" title="客户当地现在 ${t.localTime}（深夜），发了会沉到邮箱底部">⏰ 当地 ${t.localTime} 深夜 · 建议北京时间 ${t.windowBJ} 发</span>`;
  return `<span class="timing-tag" title="客户当地现在 ${t.localTime}${t.note ? "（" + t.note + "）" : ""}">⏰ 最佳发送 北京时间 ${t.windowBJ}</span>`;
}

/* ---------- 深色模式 ---------- */

function applyTheme() {
  document.body.classList.toggle("dark", state.ui?.theme === "dark");
}

function toggleTheme() {
  state.ui = { ...(state.ui || {}), theme: state.ui?.theme === "dark" ? "light" : "dark" };
  applyTheme();
  addLog(state.ui.theme === "dark" ? "已切换深色模式" : "已切换浅色模式");
  saveState();
  renderLogs();
}

/* ---------- 全局搜索 / 命令面板 (Ctrl+K) ---------- */

let paletteItemsCache = [];
let paletteIndex = 0;

function buildPaletteItems(query) {
  const q = query.trim().toLowerCase();
  const items = [];
  [
    ["dashboard", "控制台"],
    ["discovery", "搜索与采集"],
    ["prospects", "潜客队列"],
    ["email", "邮件序列"],
    ["whatsapp", "WhatsApp 开发"],
    ["automation", "发信与跟进队列"],
    ["inbox", "统一收件箱"],
    ["crm", "CRM 商机看板"],
    ["analytics", "数据分析看板"],
    ["management", "运营管理后台"],
    ["settings", "自动化接口设置"]
  ].forEach(([view, label]) => items.push({ type: "页面", label, hint: "跳转", run: () => navigateTo(view) }));

  [
    {
      label: state.autopilot?.enabled ? "关闭自动驾驶" : "开启自动驾驶",
      hint: "全流程自动流转",
      run: () => setAutopilot(!state.autopilot?.enabled)
    },
    {
      label: "运行跨渠道接力",
      hint: "邮件未回转 WhatsApp",
      run: () => {
        navigateTo("inbox");
        runCrossChannelRelay();
      }
    },
    {
      label: "发送已批准到期邮件",
      hint: "只发送已批准项",
      run: async () => {
        await sendDueEmails();
        saveState();
        render();
      }
    },
    {
      label: "审批中心全部放行",
      hint: "普通邮件仅批准为待发送",
      run: () => {
        approveAllManagementItems();
        saveState();
        render();
      }
    },
    { label: "切换深色/浅色模式", hint: "外观", run: toggleTheme },
    { label: "导出全部数据 JSON", hint: "备份", run: exportJson }
  ].forEach((action) => items.push({ type: "动作", ...action }));

  activeProspects().forEach((prospect) => {
    items.push({
      type: "客户",
      label: prospect.company,
      hint: `${prospect.market} · ${prospect.dealStage || prospect.status}`,
      run: () => {
        state.selectedProspectId = prospect.id;
        state.selectedConversationId = prospect.id;
        saveState();
        render();
        navigateTo("prospects");
      }
    });
    items.push({
      type: "会话",
      label: `${prospect.company} 的会话`,
      hint: "打开收件箱时间线",
      run: () => {
        state.selectedConversationId = prospect.id;
        saveState();
        render();
        navigateTo("inbox");
      }
    });
  });

  if (!q) return items.slice(0, 12);
  return items.filter((item) => `${item.type} ${item.label} ${item.hint}`.toLowerCase().includes(q)).slice(0, 12);
}

function renderPalette() {
  paletteItemsCache = buildPaletteItems(elements.paletteInput.value);
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItemsCache.length - 1));
  elements.paletteResults.innerHTML = paletteItemsCache.length
    ? paletteItemsCache
        .map(
          (item, index) => `
            <button class="palette-item ${index === paletteIndex ? "is-active" : ""}" data-palette-index="${index}" type="button">
              <span class="palette-type">${item.type}</span>
              <span class="palette-label">${escapeHtml(item.label)}</span>
              <span class="palette-hint">${escapeHtml(item.hint || "")}</span>
            </button>
          `
        )
        .join("")
    : `<div class="empty-state">无匹配结果</div>`;
}

function openPalette() {
  elements.paletteOverlay.hidden = false;
  elements.paletteInput.value = "";
  paletteIndex = 0;
  renderPalette();
  elements.paletteInput.focus();
}

function closePalette() {
  elements.paletteOverlay.hidden = true;
}

function runPaletteItem(index) {
  const item = paletteItemsCache[index];
  if (!item) return;
  closePalette();
  item.run();
}

/* ---------- CRM 详情抽屉 ---------- */

let crmDrawerProspectId = null;

function openCrmDrawer(prospectId) {
  crmDrawerProspectId = prospectId;
  renderCrmDrawer();
  elements.crmDrawerOverlay.hidden = false;
}

function closeCrmDrawer() {
  elements.crmDrawerOverlay.hidden = true;
  crmDrawerProspectId = null;
}

function renderCrmDrawer() {
  const prospect = state.prospects.find((p) => p.id === crmDrawerProspectId);
  if (!prospect) {
    closeCrmDrawer();
    return;
  }
  const conversation = buildConversations().find((c) => c.prospectId === prospect.id);
  const events = (conversation?.events || []).slice(-5).reverse();
  elements.crmDrawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <h3>${escapeHtml(prospect.company)}</h3>
        <p class="conv-sub">${escapeHtml(prospect.market)} · ${escapeHtml(prospect.contactName)} · ${escapeHtml(prospect.role)}</p>
      </div>
      <button class="icon-button" data-drawer-close type="button" aria-label="关闭">
        <svg><use href="#icon-x" /></svg>
      </button>
    </div>
    <dl class="detail-list">
      <div><dt>邮箱</dt><dd>${escapeHtml(prospect.email || "待补全")} · ${escapeHtml(prospect.emailStatus || "")}</dd></div>
      <div><dt>WhatsApp</dt><dd>${escapeHtml(prospect.phone || "待查找")}</dd></div>
      <div><dt>商机阶段</dt><dd>
        <select id="drawerStage">${DEAL_STAGES.map((s) => `<option ${s === prospect.dealStage ? "selected" : ""}>${s}</option>`).join("")}</select>
      </dd></div>
      <div><dt>预估金额 ($)</dt><dd><input id="drawerValue" type="number" min="0" step="100" value="${prospect.dealValue || 0}" /></dd></div>
    </dl>
    ${renderLeadScorePanel(prospect)}
    <p class="eyebrow drawer-section-label">最近动态</p>
    <div class="drawer-events">
      ${
        events
          .map(
            (e) => `
              <div class="drawer-event">
                <span class="tag">${e.kind === "inbound" ? "回复" : e.channel === "whatsapp" ? "WA" : "邮件"}</span>
                <span class="drawer-event-text">${escapeHtml((e.title ? `${e.title}：` : "") + (e.body || "").replace(/\s+/g, " ")).slice(0, 64)}</span>
              </div>
            `
          )
          .join("") || `<div class="empty-state">暂无动态</div>`
      }
    </div>
    <div class="timeline-actions">
      <button class="ghost-button" data-drawer-goto="inbox" type="button"><svg><use href="#icon-inbox" /></svg><span>打开会话</span></button>
      <button class="ghost-button" data-drawer-goto="prospects" type="button"><svg><use href="#icon-users" /></svg><span>潜客详情</span></button>
    </div>
  `;
}

/* ---------- 收件箱快捷回复 ---------- */

async function sendQuickReply(prospectId, channel, text) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  const body = (text || "").trim();
  if (!prospect || !body) {
    addLog("回复内容为空，未发送");
    return;
  }

  if (channel === "whatsapp") {
    if (!prospect.phone) {
      addLog(`无法发送：${prospect.company} 没有 WhatsApp 号码`);
      return;
    }
    const item = {
      id: makeId("waq"),
      prospectId,
      company: prospect.company,
      phone: prospect.phone,
      label: "手动回复",
      message: body,
      dueDate: dateOffset(0),
      createdAt: new Date().toISOString(),
      status: "已审批",
      step: `手动回复-${state.whatsappQueue.length}`,
      reply: true,
      url: buildWhatsappUrl(prospect, body)
    };
    state.whatsappQueue.push(item);
    let sent = false;
    if (state.settings.mode === "webhook" && webhookUrl("whatsapp")) {
      const result = await callWebhook("whatsapp", { messages: [item] });
      if (result.ok) {
        item.status = "已发送";
        item.sentAt = new Date().toISOString();
        item.delivered = true;
        advanceDealStage(item.prospectId, "已触达");
        sent = true;
      } else {
        addLog(`WhatsApp Webhook 发送失败，回复已保留待审批：${result.error || result.code || "未配置"}`);
      }
    } else {
      item.status = "已发送";
      item.sentAt = new Date().toISOString();
      item.delivered = true;
      advanceDealStage(item.prospectId, "已触达");
      sent = true;
    }
    if (sent) addLog(`已发送 WhatsApp 回复：${prospect.company}`);
  } else {
    if (!prospect.email) {
      addLog(`无法发送：${prospect.company} 没有邮箱`);
      return;
    }
    const item = {
      id: makeId("outbox"),
      prospectId,
      company: prospect.company,
      email: prospect.email,
      label: "手动回复",
      subject: `Re: ${state.campaign.product}`,
      body,
      dueDate: dateOffset(0),
      createdAt: new Date().toISOString(),
      status: "待发送",
      step: `手动回复-${state.outbox.length}`,
      reply: true
    };
    state.outbox.push(item);
    const pf = preflightOutboxItem(item);
    if (!pf.ok) {
      item.status = "待审批";
      addLog(`邮件回复预检未通过，已保留为待审批草稿：${pf.blockers.join("、")}`);
      delete quickReplyDrafts[prospectId];
      saveState();
      render();
      return;
    }
    const r = await deliverEmailBatch([item], { quiet: true });
    if (r.sent) addLog(`已发送邮件回复：${prospect.company}`);
    else addLog(`邮件回复发送失败，已保留待发送：${r.error || "未知错误"}`);
  }

  delete quickReplyDrafts[prospectId];
  saveState();
  render();
}

/* ---------- AI 引擎：多服务商（Claude / ChatGPT / 国产大模型），未配置时降级本地规则 ---------- */
// 服务商预设表 AI_PROVIDERS 定义在 00-core.js 顶部（初始化早于设置表单绑定，避免 TDZ）。

// 服务商就以 aiProvider 为准。
// 旧存档的 aiEngine==="claude" 由 normalizeStoredState 在读档时一次性迁移掉，
// 不再在这里翻译——那样会让一个陈旧字段永久压过用户的当前选择。
function aiProviderId() {
  return state.settings.aiProvider || "anthropic";
}
function aiProviderConf() {
  return AI_PROVIDERS[aiProviderId()] || AI_PROVIDERS.anthropic;
}
// 中转站 / 自建网关：任何服务商都可以填 Base URL 覆盖官方地址（自定义服务商则必填）
function aiBaseUrlOverride() {
  return (state.settings.aiBaseUrl || "").trim();
}

// 中转地址三种常见写法都要认：https://host、https://host/v1、以及完整接口路径。
// 统一补全成完整地址，用户从中转站文档里复制哪一种都能用。
function normalizeAiUrl(base, path) {
  const u = String(base || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (u.endsWith(path)) return u;
  if (/\/v\d+$/.test(u)) return u + path.replace(/^\/v\d+/, "");
  return u + path;
}

function aiEndpointPath() {
  return aiProviderConf().auth === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
}

function aiEndpoint() {
  const relay = aiBaseUrlOverride();
  return relay ? normalizeAiUrl(relay, aiEndpointPath()) : aiProviderConf().url || "";
}
// 联网找客户/反查经销商依赖 Claude 的 web_search 工具，仅 Anthropic 支持
function aiWebSearchCapable() {
  return aiEnabled() && aiProviderId() === "anthropic";
}

function aiEnabled() {
  const e = state.settings.aiEngine;
  return (e === "cloud" || e === "claude") && !!(state.settings.aiApiKey || "").trim();
}

function showAiSetup(message) {
  state.settings.aiEngine = "cloud";
  addLog(message);
  updateAiEngineButtons();
  navigateTo("settings");
  elements.aiApiKeyInput?.focus();
  saveState();
}

// 统一入口：按当前服务商分派到 Anthropic 或 OpenAI 兼容协议
async function callAI(systemPrompt, userText, schema, maxTokens = 2048) {
  return aiProviderConf().auth === "anthropic"
    ? callAnthropic(systemPrompt, userText, schema, maxTokens)
    : callOpenAICompatible(systemPrompt, userText, schema, maxTokens);
}

// Anthropic 协议的请求头。官方接口认 x-api-key；第三方中转站不少只认 Authorization: Bearer，
// 所以只在填了中转地址时额外带 Bearer——官方接口同时收到两种凭证会直接拒绝。
function anthropicHeaders() {
  const key = (state.settings.aiApiKey || "").trim();
  const headers = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };
  if (aiBaseUrlOverride()) headers.Authorization = "Bearer " + key;
  return headers;
}

function anthropicModel() {
  return state.settings.aiModel || AI_PROVIDERS.anthropic.models[0];
}

async function callAnthropic(systemPrompt, userText, schema, maxTokens = 2048) {
  const response = await fetch(aiEndpoint(), {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: anthropicModel(),
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
      ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {})
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw new Error(err?.error?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data.stop_reason === "refusal") throw new Error("请求被安全策略拒绝");
  const text = data.content?.find((block) => block.type === "text")?.text || "";
  return schema ? JSON.parse(text) : text;
}

// OpenAI 兼容协议（ChatGPT / DeepSeek / 通义千问 / Kimi / 智谱 等）。
// 结构化输出不用各家不一的 response_format，而是把 JSON 规格写进系统提示 + 兜底抽取，
// 这样对所有兼容服务商都稳。
async function callOpenAICompatible(systemPrompt, userText, schema, maxTokens = 2048) {
  const url = aiEndpoint();
  if (!url) throw new Error("未填写 API 地址（自定义服务商需在设置里填 Base URL）");
  let system = systemPrompt;
  if (schema) {
    system += "\n\n【输出要求】只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 代码块。JSON 严格符合以下结构：\n" + schemaHint(schema);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer " + (state.settings.aiApiKey || "").trim()
    },
    body: JSON.stringify({
      model: state.settings.aiModel || aiProviderConf().models[0] || "",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText }
      ]
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw new Error(err?.error?.message || err?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  return schema ? extractJson(text) : text;
}

// 从模型回复里稳健抽出 JSON（去掉 ```json 围栏、截取首个 { 到末个 }）
function extractJson(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// 把 JSON Schema 转成给模型看的简明字段说明（供不支持原生结构化输出的服务商使用）
function schemaHint(schema, indent = "") {
  if (!schema || schema.type !== "object" || !schema.properties) return "";
  const req = schema.required || [];
  return Object.entries(schema.properties)
    .map(([k, v]) => {
      let t = v.enum ? "取值之一 [" + v.enum.join(", ") + "]" : v.type || "";
      let line = `${indent}- ${k} (${t})${req.includes(k) ? "" : "（可选）"}${v.description ? "：" + v.description : ""}`;
      if (v.type === "object" && v.properties) line += "\n" + schemaHint(v, indent + "  ");
      if (v.type === "array" && v.items) line += `\n${indent}  · 数组每项：\n` + schemaHint(v.items, indent + "    ");
      return line;
    })
    .join("\n");
}

const AI_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["price", "sample", "discount", "leadtime", "moq", "cert", "reject", "other"]
    },
    intent_label: { type: "string", description: "意图的中文短标签，如 询价、要样品、砍价" },
    confidence: { type: "integer", description: "0-100 的置信度" },
    summary: { type: "string", description: "一句中文摘要：客户处境 + 最新诉求" },
    next_action: { type: "string", description: "给业务员的中文下一步建议，一句话" },
    suggested_reply: { type: "string", description: "可直接发送的英文回复全文，含称呼与署名" },
    risks: {
      type: "array",
      description: "客户来信中的风险事项，没有则空数组",
      items: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["high", "medium", "low"] },
          category: {
            type: "string",
            description: "风险类别中文，如 付款风险 / 疑似诈骗 / 制裁合规 / 知识产权 / 利润风险 / 样品滥用"
          },
          evidence: { type: "string", description: "来信中触发该风险的原话或依据（中文说明）" },
          action: { type: "string", description: "给业务员的应对建议，一句话" }
        },
        required: ["level", "category", "evidence", "action"],
        additionalProperties: false
      }
    }
  },
  required: ["intent", "intent_label", "confidence", "summary", "next_action", "suggested_reply", "risks"],
  additionalProperties: false
};

const AI_SEQUENCE_SCHEMA = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "中文步骤名，如 首封开发信" },
          dayOffset: { type: "integer" },
          subject: { type: "string" },
          body: { type: "string" }
        },
        required: ["label", "dayOffset", "subject", "body"],
        additionalProperties: false
      }
    }
  },
  required: ["emails"],
  additionalProperties: false
};

function getStoredAI(prospectId) {
  return [...state.inbound].reverse().find((m) => m.prospectId === prospectId && m.ai)?.ai || null;
}

// 把当前活动里对 AI 最有用的上下文汇成几行，喂给写信/回复提示词，让输出更贴产品、更准确
function campaignContextLines() {
  const c = state.campaign;
  const terms = (c.productTerms || []).filter(Boolean);
  const lines = [];
  if (c.focusProduct) lines.push(`具体产品聚焦: ${c.focusProduct}`);
  if (terms.length > 1) lines.push(`英文术语/同义词: ${terms.join(", ")}`);
  if (c.hsCode) lines.push(`HS 编码: ${c.hsCode}`);
  if (c.buyerHint) lines.push(`目标买家画像: ${c.buyerHint}`);
  if (c.customerType) lines.push(`客户类型: ${c.customerType}`);
  const kb = (c.knowledgeBase || "").trim();
  if (kb) lines.push(`产品知识库/FAQ（回答客户问题、写卖点时以此为准，不要编造）:\n${kb.slice(0, 1200)}`);
  // 产品库：给 AI 真实型号/MOQ/参考价，回复与写信引用真实参数
  if (state.products?.length) {
    const list = state.products
      .slice(0, 12)
      .map((p) => `- ${p.model} ${p.name}${p.moq ? ` | MOQ ${p.moq}` : ""}${p.price ? ` | ~$${p.price}/${p.unit || "pc"}` : ""}${p.certs ? ` | ${p.certs}` : ""}`)
      .join("\n");
    lines.push(`产品库（真实在售型号，报价细节仍由销售确认）:\n${list}`);
  }
  return lines.join("\n");
}

async function analyzeConversationAI(prospectId) {
  const conversation = buildConversations().find((c) => c.prospectId === prospectId);
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!conversation || !prospect) return null;

  const transcript = conversation.events
    .filter((e) => e.status !== "已取消")
    .slice(-12)
    .map((e) =>
      e.kind === "inbound"
        ? `客户: ${e.body}`
        : `我方(${e.channel === "whatsapp" ? "WhatsApp" : "邮件"}·${e.title || ""}): ${e.subject ? `${e.subject} — ` : ""}${e.body || ""}`
    )
    .join("\n---\n");

  const system =
    "你是资深外贸业务与风控助手。根据对话判断客户最新意图并起草回复，同时识别来信中的风险事项（付款风险如先货后款/纯账期/无定金、疑似诈骗如大额急单+异地收货+第三方货代、制裁合规如受限地区/再出口、知识产权如仿制贴牌、利润风险如目标价远低于成本、样品滥用等），没有风险则 risks 为空数组。suggested_reply 必须是英文、专业、简洁、可直接发送；其余字段用中文。";
  const ctx = campaignContextLines();
  const user = `我方产品: ${state.campaign.product}
卖点: ${state.campaign.valueProps}
认证: ${state.campaign.certifications}
署名: ${state.campaign.senderName}, ${state.campaign.companyName}${ctx ? "\n" + ctx : ""}
客户: ${prospect.company}（${prospect.market}，联系人 ${prospect.contactName}）

对话记录（旧→新）:
${transcript}`;

  return callAI(system, user, AI_ANALYSIS_SCHEMA, 1500);
}

async function enrichInboundWithAI(prospectId, force = false) {
  if (!aiEnabled()) return;
  const message = [...state.inbound].reverse().find((m) => m.prospectId === prospectId && (force || !m.ai));
  if (!message) return;
  try {
    const result = await analyzeConversationAI(prospectId);
    if (!result) return;
    message.ai = { ...result, model: state.settings.aiModel, at: Date.now() };
    const riskNote = result.risks?.length ? `，⚠️ ${result.risks.length} 项风险` : "";
    addLog(`Claude 分析完成（${result.intent_label} · 置信度 ${result.confidence}%${riskNote}）：${message.company}`);
    saveState();
    render();
  } catch (error) {
    addLog(`Claude 分析失败，已用本地规则兜底：${error.message}`);
  }
}

/* ---------- 客户回信风险识别（本地规则 + Claude 双引擎） ---------- */

const RISK_RULES = [
  {
    level: "high",
    category: "付款风险",
    test: /pay(ment)? (after|on) (delivery|arrival|receipt)|open account\b|\boa\b|net ?\d{2,3}\b|no deposit|without deposit|credit terms|货到付款|先货后款|无需?定金|不付定金|纯账期|全额账期/i,
    evidence: "客户要求先货后款 / 纯账期 / 无定金",
    action: "坚持定金+尾款或 L/C，先核实客户资信与营业执照"
  },
  {
    level: "high",
    category: "疑似诈骗",
    test: /freight collect|my (shipping|forwarder|freight|agent) will (pick|arrange|handle|collect)|our (agent|forwarder) will contact you|western union|moneygram|ship (it |them )?to (a )?(different|another) (address|country)|deliver to nigeria|大额.*(急|马上|立刻)|异地收货|指定货代来提/i,
    evidence: "大额急单 / 第三方货代提货 / 异地收货等异常安排",
    action: "视频核实公司真实性，核对收货地址与注册地是否一致，先收定金"
  },
  {
    level: "medium",
    category: "制裁 / 合规",
    test: /\b(iran|syria|north korea|dprk|crimea|cuba|sanction)\b|re-?export|end.?use[r]? (certificate|statement)|military use|defen[cs]e (project|ministry)|受限地区|再出口|军工|最终用户/i,
    evidence: "涉及受限地区 / 再出口 / 军事或最终用户敏感用途",
    action: "启动出口管制合规审查，索取最终用户证明，必要时拒单"
  },
  {
    level: "medium",
    category: "知识产权",
    test: /replica|counterfeit|\b1:1\b|same as (nike|adidas|apple|dyson|lego|disney)|copy (of )?(the )?(brand|logo|design)|put (your|our) (customer'?s )?brand.*(without|no) (authoriz|license)|仿(制|货|款)|山寨|高仿|贴(牌|标).*(大牌|知名品牌)|冒牌/i,
    evidence: "要求仿制 / 贴他方品牌 / 疑似侵权",
    action: "拒绝任何仿冒，仅接受自有品牌或有合法授权的贴牌"
  },
  {
    level: "medium",
    category: "利润风险",
    test: /target price (is |of )?\$?\d|below (your |the )?cost|half (of )?(your |the )?price|cheaper than (alibaba|the market)|lowest price (or|otherwise)|骨折价|成本价|亏本|远低于|压到|最低到/i,
    evidence: "目标价疑似低于成本 / 极限压价",
    action: "守住底价，用价值和服务谈判，避免亏本接单"
  },
  {
    level: "low",
    category: "样品滥用",
    test: /free samples? (shipped |sent )?(at|on) your (cost|expense|account)|(just|only) (want|need|looking for) (free )?samples|send (me |us )?(free )?samples? (first|to test).*(no order)|免费(寄|包邮)样|只(要|想要)样品/i,
    evidence: "疑似只索要免费样品，无采购意向",
    action: "收取样品费或运费押金，成单后返还；先要采购量与规格"
  },
  {
    level: "low",
    category: "信息不一致",
    test: null, // 由 detectRisksLocal 特判
    evidence: "",
    action: ""
  }
];

function detectRisksLocal(text, prospect) {
  const risks = [];
  RISK_RULES.forEach((rule) => {
    if (rule.test && rule.test.test(text || "")) {
      risks.push({ level: rule.level, category: rule.category, evidence: rule.evidence, action: rule.action });
    }
  });
  // 信息不一致：邮箱域名与公司名/官网明显不符（免费邮箱冒充企业）
  if (prospect?.email && /@(gmail|yahoo|hotmail|outlook|163|qq|foxmail)\./i.test(prospect.email)) {
    if (/\b(inc|ltd|llc|corp|gmbh|co\.?,? ?ltd)\b/i.test(prospect.company)) {
      risks.push({
        level: "low",
        category: "信息不一致",
        evidence: "自称公司却用免费邮箱，域名与企业名不匹配",
        action: "索取企业邮箱与营业执照核验身份"
      });
    }
  }
  return risks;
}

function conversationRisks(prospectId) {
  const stored = getStoredAI(prospectId);
  const prospect = state.prospects.find((p) => p.id === prospectId);
  const message = [...state.inbound].reverse().find((m) => m.prospectId === prospectId);
  if (stored && Array.isArray(stored.risks)) {
    // Claude 已分析：合并 Claude 结果 + 本地规则兜底（去重按类别）
    const local = message ? detectRisksLocal(message.body, prospect) : [];
    const cats = new Set(stored.risks.map((r) => r.category));
    return [...stored.risks, ...local.filter((r) => !cats.has(r.category))];
  }
  return message ? detectRisksLocal(message.body, prospect) : [];
}

function riskLevelTone(level) {
  return level === "high" ? "red" : level === "medium" ? "amber" : "muted";
}

function highestRiskLevel(risks) {
  if (risks.some((r) => r.level === "high")) return "high";
  if (risks.some((r) => r.level === "medium")) return "medium";
  return risks.length ? "low" : null;
}

/* ---------- 智能找联系方式（真实源 Webhook 优先 → Claude 推测 → 本地兜底） ---------- */

const AI_CONTACT_SCHEMA = {
  type: "object",
  properties: {
    contact_name: {
      type: "string",
      description:
        "决策人姓名。只有当你确实掌握这家公司的公开人员信息时才填；不确定就留空字符串。严禁编造人名或使用占位姓名——编出来的名字会让使用者当着真实客户的面出丑"
    },
    contact_role: { type: "string", description: "决策人职位中文，如 采购经理 / Sourcing Manager；没有确切人名时填岗位方向即可" },
    email_candidates: {
      type: "array",
      description:
        "候选邮箱，全部使用给定域名。contact_name 为空时只给通用信箱（info@ / sales@ / contact@ / export@ / purchasing@），不要生成 firstname.lastname 这类依赖姓名的地址",
      items: {
        type: "object",
        properties: {
          email: { type: "string" },
          confidence: { type: "integer", description: "0-100 可能性" },
          pattern: { type: "string", description: "这个地址的来历：在网页上真实看到的填 verified，通用信箱填 functional。不要用 firstname.lastname 这类拼出来的模式" }
        },
        required: ["email", "confidence", "pattern"],
        additionalProperties: false
      }
    },
    company_profile: { type: "string", description: "一句话公司画像（业务、规模线索、采购可能性）" },
    fit_note: { type: "string", description: "是否对口这次开发的判断，一句话" },
    fit_score: {
      type: "integer",
      description:
        "0-100 与本次任务的匹配度，必须诚实。信息平台、目录站、招投标网站、媒体、同行制造商、平台卖家都不是采购方，一律给 30 以下"
    }
  },
  required: ["contact_name", "contact_role", "email_candidates", "company_profile", "fit_note", "fit_score"],
  additionalProperties: false
};

// 低于这个匹配度就不再往下补联系方式：AI 自己都说不对口了，再给它编一个人名
// 和五个猜的邮箱，是最伤信任的组合——用户会拿着这些东西去发真实客户。
const FIT_OFF_TARGET = 40;

// 依赖姓名的邮箱模式。没拿到真名时这些地址的 firstname 全是编的，一条都不能留。
const NAME_BASED_PATTERN = /first|last|name|initial|f\.?l|姓名/i;

function applyContact(prospectId, data, source) {
  state.prospects = state.prospects.map((p) => {
    if (p.id !== prospectId) return p;

    const fit = typeof data.fit_score === "number" ? data.fit_score : p.fitScore;
    const profile = data.company_profile || p.companyProfile;
    const note = data.fit_note || p.fitNote;

    // ① AI 判定不对口：只留画像和理由，联系人/邮箱一律不写，置信度跟着 fit 走
    if (typeof fit === "number" && fit < FIT_OFF_TARGET) {
      return {
        ...p,
        companyProfile: profile,
        fitNote: note,
        fitScore: fit,
        offTarget: true,
        contactSource: source,
        status: p.status === "已回复" ? p.status : "不对口",
        confidence: Math.max(5, Math.min(p.confidence || 50, fit))
      };
    }

    // ② 对口，但没拿到确切人名：不写人名，也丢掉所有依赖姓名的候选邮箱，
    //    只保留 info@ / sales@ 这类通用信箱——它们至少是真实存在的收件入口。
    const named = String(data.contact_name || "").trim();
    const candidates = (data.email_candidates || [])
      .filter((c) => c && c.email)
      // 联网核实这条路只收「真的在网页上看到过」的地址：没标 verified、也没给出处的，
      // 说明模型又在按域名拼——整条丢掉，宁可这条线索没有邮箱。
      .filter((c) => source !== "claude-web" || /verified/i.test(c.pattern || "") || c.source_url)
      // 没拿到真名时，依赖姓名的地址里 firstname 全是编的
      .filter((c) => named || !NAME_BASED_PATTERN.test(c.pattern || ""));

    return {
      ...p,
      contactName: named || p.contactName || "",
      role: data.contact_role || p.role,
      email: candidates[0]?.email || p.email,
      emailCandidates: candidates.length ? candidates : p.emailCandidates,
      emailStatus: candidates.length || p.email ? "待验证" : "待查找",
      phone: data.phone || p.phone,
      companyProfile: profile,
      fitNote: note,
      fitScore: fit,
      offTarget: false,
      contactSource: source,
      status: p.status === "已入队" ? p.status : "已丰富",
      // 置信度跟匹配度挂钩。原来无论对不对口都 +10，于是出现过
      // 「完全不对口」旁边挂着「置信度 82%」这种自相矛盾的展示。
      confidence: source === "webhook" ? 96 : Math.max(20, Math.min(90, Math.round((typeof fit === "number" ? fit : 60) * 0.6 + 28)))
    };
  });
}

/* ---------- 直连 Hunter ----------
   同 SerpAPI：一个 key 的事，不必为此自建 n8n。仅桌面版（浏览器会被 CORS 拦）。

   ⚠️ domain-search 返回的是"在公开网页上找到的地址"，不等于验证过。
   Hunter 给每条一个 confidence，低分的本质是猜的——按铁律 1 的口径，
   只有高置信度的才当真实源（可直接发），其余降级为候选、走推测那条路被拦下。 */
const HUNTER_TRUST_MIN = 80;

function hunterReady() {
  return !!mkdBridge() && !!(state.settings.hunterApiKey || "").trim();
}

async function tryHunter(prospect) {
  const domain = (prospect.website || "").trim();
  if (!domain) return null; // 没域名无从查起——海关数据线索要先跑「批量解析官网」
  const key = (state.settings.hunterApiKey || "").trim();
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.details || "Hunter 返回错误");
  const emails = json.data?.emails || [];
  if (!emails.length) return null;

  // 优先采购/销售相关职位，其次置信度
  const rank = (e) => (/(purchas|procure|buyer|sourcing|import|owner|ceo|founder|director|sales)/i.test(e.position || "") ? 1 : 0);
  const sorted = [...emails].sort((a, b) => rank(b) - rank(a) || (b.confidence || 0) - (a.confidence || 0));
  const best = sorted[0];
  const trusted = (best.confidence || 0) >= HUNTER_TRUST_MIN;
  return {
    trusted,
    payload: {
      contact_name: [best.first_name, best.last_name].filter(Boolean).join(" ") || "",
      contact_role: best.position || "",
      phone: best.phone_number || "",
      company_profile: json.data?.organization || "",
      email_candidates: sorted.slice(0, 5).map((e) => ({
        email: e.value,
        confidence: e.confidence || 0,
        // 只有高置信度才标 verified，低的留 guessed 让发送闸门拦下
        pattern: (e.confidence || 0) >= HUNTER_TRUST_MIN ? "verified" : "guessed",
        note: e.position || ""
      }))
    }
  };
}

async function enrichContactAI(prospectId, quiet = false) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect) return "none";

  // 0) 直连 Hunter（配了 key 就不必经 Webhook 中转）
  if (hunterReady() && state.settings.mode !== "local" && apiQuotaOk("hunter", "Hunter")) {
    try {
      apiUsageBump("hunter");
      const hit = await tryHunter(prospect);
      if (hit) {
        applyContact(prospectId, hit.payload, hit.trusted ? "webhook" : "claude");
        if (!quiet) {
          addLog(
            hit.trusted
              ? `Hunter 直连找到已验证联系方式：${prospect.company}`
              : `Hunter 直连找到地址但置信度偏低（<${HUNTER_TRUST_MIN}），已标为推测，发送前需验证：${prospect.company}`
          );
        }
        saveState();
        render();
        return "webhook";
      }
      if (!quiet) addLog(`Hunter 没找到 ${prospect.website} 的公开邮箱，改用 AI 推测`);
    } catch (error) {
      if (!quiet) addLog(`Hunter 直连失败，改用 AI 推测：${error.message}`);
    }
  }

  // 1) 真实源：邮箱查找/验证 Webhook（Hunter/Apollo/Dropcontact 等）
  if (state.settings.mode === "webhook" && webhookUrl("enrich")) {
    try {
      const result = await callWebhook("enrich", {
        company: prospect.company,
        domain: prospect.website,
        market: prospect.market,
        role_hint: state.campaign.customerType
      });
      const d = result.data || {};
      if (result.ok && (d.email || d.contact_name || d.email_candidates?.length)) {
        applyContact(
          prospectId,
          {
            contact_name: d.contact_name || d.contactName,
            contact_role: d.contact_role || d.role,
            email_candidates: d.email_candidates || (d.email ? [{ email: d.email, confidence: 95, pattern: "verified" }] : []),
            phone: d.phone,
            company_profile: d.company_profile,
            fit_note: d.fit_note,
            fit_score: d.fit_score
          },
          "webhook"
        );
        if (!quiet) addLog(`真实源找到联系方式（已验证）：${prospect.company}`);
        saveState();
        render();
        return "webhook";
      }
    } catch (error) {
      if (!quiet) addLog(`邮箱查找 Webhook 失败，改用 AI 推测：${error.message}`);
    }
  }

  // 2) AI 联网核实。
  //
  //    这里原来是「Claude 凭公司名和域名推测决策人姓名 + 按模式拼候选邮箱」。
  //    那条路产出的东西看起来很完整，但姓名是编的、邮箱是拼的，用户拿去发信
  //    既发错人又制造退信。已整条删除——联系人只允许有两个来源：
  //    真实源（Hunter / 邮箱查找 Webhook）与联网核实（真的翻官网看到）。
  if (aiWebSearchCapable()) {
    const dug = await deepDigContact(prospectId, quiet);
    if (dug === "claude-web") return "claude-web";
  } else if (aiEnabled() && !quiet) {
    addLog(
      `联网核实联系人目前只有 Claude 支持（当前是${aiProviderConf().label}）。${prospect.company} 的联系方式没有编造，仍是待查找——` +
        `去「设置 → 数据源」配 Hunter，或把 AI 引擎切到 Claude。`
    );
  }

  // 3) 都没拿到：补上不需要编就成立的字段（岗位方向、采购信号），联系方式老实留空。
  //    宁可显示「待查找」，也不给一个编出来的人名和地址。
  const enriched = enrichProspectList([prospect], state.campaign)[0];
  state.prospects = state.prospects.map((p) => (p.id === prospectId ? enriched : p));
  if (!quiet) {
    addLog(
      `没查到 ${prospect.company} 的真实联系方式，已标为「待查找」（不编造）。` +
        `拿到联系人有三条路：配 Hunter 直连、接邮箱查找 Webhook、或用 Claude 联网核实官网。`
    );
  }
  saveState();
  render();
  return "none";
}

function contactSourceLabel(source) {
  return source === "webhook"
    ? "真实验证"
    : source === "claude-web"
    ? "联网核实"
    : source === "claude"
    ? "AI 推测"
    : "规则推测";
}

/* ---------- Claude 联网找客户（web search）+ 相似客户扩展 ---------- */

// 2026-02 版 web_search 带动态过滤（结果更准、更省 token），但只有较新的模型支持；
// 老模型和中转站（不一定跟进了新工具版本）一律退回基础版，宁可少点能力也不要整条链路 400。
const WEB_SEARCH_NEW_MODELS = /^claude-(opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;
function webSearchTool(model) {
  const type = !aiBaseUrlOverride() && WEB_SEARCH_NEW_MODELS.test(model)
    ? "web_search_20260209"
    : "web_search_20250305";
  return { type, name: "web_search", max_uses: 6 };
}

async function callClaudeWebSearch(systemPrompt, userText, maxTokens = 4000) {
  const model = anthropicModel();
  const response = await fetch(aiEndpoint(), {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
      tools: [webSearchTool(model)]
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw new Error(err?.error?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data.stop_reason === "refusal") throw new Error("请求被安全策略拒绝");
  // 记下结束原因：联网检索会吃掉大量 token，被 max_tokens 截断是这条链路最常见的失败，
  // 解析失败时要能说清是"没按格式答"还是"答到一半没写完"。
  lastAiStopReason = data.stop_reason || "";
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// 上一次联网调用的结束原因（max_tokens / end_turn / …）。解析失败时用它区分
// 「模型没按格式答」和「答到一半被长度上限截断」——这两种给用户的话完全不同。
let lastAiStopReason = "";

// 从模型回复里抠出 JSON 数组。
//
// 原来只做「第一个 [ 到最后一个 ]」的朴素切片，在联网搜索这条路上很容易失败：
//   · 联网回复里常混着散文和引文标记 [1][2]，起点会被带偏到引文括号上；
//   · web_search 的检索结果会吃掉大量 token，数组经常写到一半就被截断，
//     根本没有收尾的 ]，于是 lastIndexOf 找到的是某个内层 ]，切出来必然解析失败。
// 三级兜底：markdown 代码围栏 → 括号配平扫描 → 从残缺文本里逐个捞完整对象。
function extractJsonArray(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;

  // 只认「一组对象」。这条判断不能省：散文里的引文标记 [1]、[2] 本身就是合法 JSON 数组，
  // 不加限制就会把 [1] 当成结果收下，白白丢掉后面真正的公司列表。
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      const ok = Array.isArray(v) && v.length && v.some((el) => el && typeof el === "object" && !Array.isArray(el));
      return ok ? v : null;
    } catch {
      return null;
    }
  };

  // ① 代码围栏里的内容最干净，优先
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const hit = tryParse(m[1].trim());
    if (hit) return hit;
  }

  // 括号配平扫描：跳过字符串内的括号与转义，返回与 open 配对的收尾下标
  const matchFrom = (start, open, close) => {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < raw.length; j += 1) {
      const c = raw[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "[" || c === "{") depth += 1;
      else if (c === "]" || c === "}") {
        depth -= 1;
        if (depth === 0) return j;
      }
    }
    return -1;
  };

  // ② 从每个 [ 试一次配平；引文标记 [1] 解析不出数组，会自动跳到下一个
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "[") continue;
    const end = matchFrom(i, "[", "]");
    if (end < 0) continue;
    const hit = tryParse(raw.slice(i, end + 1));
    if (hit) return hit;
  }

  // ③ 数组被截断：把已经写完整的对象一个个捞出来，能救几条算几条
  const salvaged = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "{") continue;
    const end = matchFrom(i, "{", "}");
    if (end < 0) break; // 后面全是残缺的，不用再扫
    try {
      const obj = JSON.parse(raw.slice(i, end + 1));
      if (obj && (obj.company || obj.name || obj.website || obj.domain)) salvaged.push(obj);
    } catch {
      /* 这一段不完整，跳过 */
    }
    i = end;
  }
  return salvaged.length ? salvaged : null;
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function prospectFromFound(item, fallbackMarket, sourceLabel = "Claude 联网") {
  const website = stripProtocol(item.website || item.domain || "").split("/")[0];
  const company = (item.company || item.name || domainToCompany(website) || "未命名公司").trim();
  const directWebsite =
    website && !/(google|linkedin|facebook|instagram|youtube|amazon|alibaba|made-in-china|globalsources|temu|shein|directory)/i.test(website);
  return {
    id: makeId("prospect"),
    company,
    market: item.market || fallbackMarket,
    source: sourceLabel,
    website,
    contactName: "待补全",
    role: "待确认采购角色",
    email: item.email || "",
    emailStatus: item.email ? "待验证" : "待查找",
    phone: item.phone || "",
    phoneStatus: item.phone ? "待人工确认" : "待查找",
    status: "新发现",
    score: directWebsite ? 74 : 60,
    confidence: directWebsite ? 70 : 52,
    presetKey: state.campaign.presetKey || null,
    campaignId: state.activeCampaignId || null,
    buyingSignal: item.note || `Claude 联网找到，疑似 ${state.campaign.product} 相关买家`,
    companySize: item.size || "待确认",
    searchQuery: item.note || "Claude 联网搜索"
  };
}

/* 找客户失败的真实原因。
   联网找客户有四种归零方式（服务商不支持 / 接口报错 / 回复解析不出公司 / 全被去重过滤），
   调用方原来只拿到一个 0，于是不管哪种都提示「请配置 Claude」——用户明明已经配好了。 */
let lastLeadFailure = null;

function noteLeadFailure(reason, action) {
  lastLeadFailure = { reason, action: action || null };
}

function takeLeadFailure() {
  const f = lastLeadFailure;
  lastLeadFailure = null;
  return f;
}

async function webSearchProspects(opts = {}) {
  lastLeadFailure = null;
  if (!aiWebSearchCapable()) {
    if (aiEnabled()) {
      const name = aiProviderConf().label;
      addLog(`「联网找客户」目前仅 Claude 支持（用其内置联网搜索）；当前服务商是${name}，请改用粘贴导入或切到 Claude`);
      noteLeadFailure(`当前 AI 服务商是${name}，只有 Claude 能联网找客户`, { label: "去换服务商", view: "settings" });
      return 0;
    }
    showAiSetup("联网找客户需要先配置支持联网的 AI 引擎（Claude）：填入 API Key 后点「测试连接」");
    noteLeadFailure("还没配置能联网的 AI 引擎（Claude）", { label: "去配置", view: "settings" });
    return 0;
  }
  const count = opts.count || 12;
  const seed = opts.seed || "";
  addLog(seed ? `Claude 正在联网找相似客户…` : "Claude 正在联网搜索真实目标客户…");
  renderLogs();

  const markets = normalizeMarkets(state.campaign.markets);
  const system =
    "你是外贸找客助手，可联网搜索。任务：找出真实存在的目标采购商/进口商/批发商公司。用网络搜索核实公司真实存在并尽量拿到官网域名。只输出一个 JSON 数组，不要额外文字，每个元素含 {company, website, market, note}（note 为一句中文：为什么疑似目标客户/采购信号）。website 只要主域名。排除 alibaba/amazon/made-in-china 等平台与目录站本身。";
  const focusTerms = (state.campaign.productTerms || []).filter(Boolean);
  const prof = state.campaign.productProfile || {};
  const segLine = prof.segments?.length
    ? `\n优先找这些买家段（每段都要覆盖）：${prof.segments.map((s) => `${s.name}（${(s.terms || []).join(" / ")}）`).join("；")}`
    : "";
  const useLine = prof.endUseTerms?.length ? `\n也可按终端用途/关联品找：${prof.endUseTerms.join(", ")}` : "";
  const exLine = prof.excludeTerms?.length ? `\n排除以下非买家：${prof.excludeTerms.join("、")}` : "";
  const focusLine =
    focusTerms.length > 1
      ? `\n【聚焦具体产品】只找真正采购/进口/分销这个具体产品的公司，不要泛品类公司。同义词/行业叫法: ${focusTerms.join(", ")}${state.campaign.hsCode ? `（HS ${state.campaign.hsCode}）` : ""}${state.campaign.buyerHint ? `\n典型买家: ${state.campaign.buyerHint}` : ""}${segLine}${useLine}${exLine}`
      : "";
  const user = seed
    ? `请找 ${count} 家与下面这个客户相似的公司（同市场、同品类、相近规模）：\n${seed}\n我方产品: ${state.campaign.product}${focusLine}`
    : `目标市场: ${markets.join(", ")}
客户类型: ${state.campaign.customerType}
产品/品类: ${state.campaign.product}
搜索关键词: ${state.agent?.task?.parsed?.keywords?.join(", ") || state.campaign.product}${focusLine}
请找 ${count} 家真实公司。`;

  try {
    const text = await callClaudeWebSearch(system, user, 8000);
    return ingestFoundText(text, markets[0] || "United States", "Claude 联网", { quiet: opts.quiet });
  } catch (error) {
    addLog(`Claude 联网找客户失败：${error.message}${aiTestFailHint(error)}`);
    // 中转站多半没转发 Anthropic 的 web_search 服务端工具，这时候要给出能走通的备选
    noteLeadFailure(
      aiBaseUrlOverride()
        ? `联网搜索被中转站拒绝（${error.message.slice(0, 40)}）——中转站通常不支持 Claude 的联网工具`
        : `联网找客户失败：${error.message.slice(0, 40)}`,
      { label: "去粘贴导入线索", view: "discovery" }
    );
    return 0;
  }
}

// 把 Claude 联网返回的公司数组解析、去重并入池，返回新增数量（供联网找客户/相似客户/竞品反查复用）
function ingestFoundText(text, fallbackMarket, sourceLabel, opts = {}) {
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr) || !arr.length) {
    const truncated = lastAiStopReason === "max_tokens";
    // 把回复开头塞进诊断环形缓冲：这条链路一旦失败，没有原文根本查不出是哪种失败
    pushOp("找客户", "解析不出公司列表", `stop=${lastAiStopReason || "?"} 回复前 120 字：${String(text || "").slice(0, 120)}`);
    if (!opts.quiet) {
      addLog(
        truncated
          ? "AI 的回复被长度上限截断了，公司列表没写完——把「找客户数量」调小一点再试，或改用粘贴导入"
          : "AI 有回复但不是公司列表（多半是中转站没转发联网搜索，模型只能凭空作答）——重试一次，或改用粘贴导入"
      );
    }
    noteLeadFailure(
      truncated ? "AI 回复被长度上限截断，公司列表没写完" : "AI 有回复，但内容里解析不出公司列表（可重试一次）",
      { label: "去粘贴导入线索", view: "discovery" }
    );
    return 0;
  }
  const seenKeys = new Set(state.prospects.map((p) => p.website || p.company.toLowerCase()));
  const fresh = [];
  arr.forEach((item) => {
    const p = prospectFromFound(item, fallbackMarket, sourceLabel);
    if (p.website && NON_COMPANY_DOMAIN.test(p.website.replace(/^www\./, ""))) return;
    if (isBlacklisted(p)) return; // 退订黑名单：联网再搜到也不进池
    const key = p.website || p.company.toLowerCase();
    if (!p.company || seenKeys.has(key)) return;
    seenKeys.add(key);
    fresh.push(p);
  });
  if (!fresh.length) {
    if (!opts.quiet) addLog("联网找到的公司都已在库中（已去重）");
    noteLeadFailure(`找到 ${arr.length} 家，但都已在线索池里或被黑名单/平台域名过滤掉了`, {
      label: "去看现有线索",
      view: "prospects"
    });
    return 0;
  }
  const admitted = admitProspects(fresh, sourceLabel);
  state.prospects = [...admitted, ...state.prospects];
  agentOnProspectsImported(admitted);
  if (!opts.quiet)
    addLog(`${sourceLabel}找到 ${admitted.length} 家候选客户，已进线索池${state.agent?.task ? "并走漏斗" : "（去「潜客」审核）"}`);
  saveState();
  render();
  return admitted.length;
}

async function findLookalike(prospectId) {
  const p = state.prospects.find((x) => x.id === prospectId);
  if (!p) return 0;
  if (aiEnabled()) {
    return await webSearchProspects({
      count: 8,
      seed: `公司: ${p.company}\n市场: ${p.market}\n品类/信号: ${p.buyingSignal || state.campaign.product}\n规模: ${p.companySize || "未知"}`
    });
  }
  // 无 Claude：用同市场同类型的规则生成器兜底
  const generated = generateProspects({ ...state.campaign, markets: p.market }, 8, `L${p.company.replace(/\W/g, "").slice(0, 4)}`);
  const seen = new Set(state.prospects.map((x) => x.website || x.company.toLowerCase()));
  const fresh = generated.filter((g) => {
    const key = g.website || g.company.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const admitted = admitProspects(fresh, "找相似客户");
  state.prospects = [...admitted, ...state.prospects];
  agentOnProspectsImported(admitted);
  addLog(`已按「${p.company}」特征生成 ${admitted.length} 家相似线索（本地规则；配 Claude 可联网找真实相似公司）`);
  saveState();
  render();
  return admitted.length;
}

// 竞品渠道反查：从竞品 Where-to-buy / 经销商列表页抽出他家所有经销商作为线索
async function reverseCompetitorChannel(url) {
  if (!url || !/^https?:\/\//i.test(url.trim())) {
    addLog("请先粘贴一个完整的竞品经销商/Where-to-buy 页面链接（http/https 开头）");
    return 0;
  }
  if (!aiWebSearchCapable()) {
    if (aiEnabled()) {
      addLog("「竞品渠道反查」需联网抓取页面，目前仅 Claude 支持；请切到 Claude 或手动粘贴经销商列表");
      return 0;
    }
    showAiSetup("竞品渠道反查需要先配置支持联网的 AI 引擎（Claude）：填入 API Key 后点「测试连接」");
    return 0;
  }
  addLog(`Claude 正在联网反查竞品经销商：${url.trim()}…`);
  renderLogs();
  const markets = normalizeMarkets(state.campaign.markets);
  const system =
    "你是外贸找客助手，可联网搜索。任务：打开给定的经销商定位/Where-to-buy/dealer locator/authorized distributor/stockist 页面，抽取该页面列出的所有经销商/分销商/零售商公司。只输出一个 JSON 数组，不要额外文字，每个元素含 {company, website, market, note}（note 为一句中文，如“X 品牌授权经销商”）。排除品牌方本身与平台/目录站。找不到页面就用网络搜索该品牌的经销商。";
  const user = `竞品经销商页面: ${url.trim()}
我方产品: ${state.campaign.product}
目标市场: ${markets.join(", ") || "不限"}`;
  try {
    const text = await callClaudeWebSearch(system, user, 8000);
    const n = ingestFoundText(text, markets[0] || "United States", "竞品渠道反查");
    if (n === 0) addLog("竞品反查未抽到新经销商（可能页面无列表或都已在库）");
    return n;
  } catch (error) {
    addLog(`竞品渠道反查失败：${error.message}`);
    return 0;
  }
}

// 官网一键深挖联系人：Claude 联网翻公司官网 About/Team/Contact 页，找真实决策人与邮箱
async function deepDigContact(prospectId, quiet = false) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect) return "none";
  if (!aiWebSearchCapable()) {
    if (aiEnabled()) {
      if (!quiet) addLog("「官网深挖联系人」需联网翻官网，目前仅 Claude 支持；可改用「AI 找联系人」（当前模型支持）或切到 Claude");
      return "none";
    }
    if (!quiet) showAiSetup("官网深挖联系人需要先配置支持联网的 AI 引擎（Claude）：填入 API Key 后点「测试连接」");
    return "none";
  }
  if (!quiet) {
    addLog(`Claude 正在联网深挖 ${prospect.company} 官网的采购决策人…`);
    renderLogs();
  }
  const system = [
    "你是外贸找客助手，可联网搜索。任务：访问/搜索该公司官网，优先看 About / Team / Management / Contact / Wholesale 页面与领英，",
    "找出最对口的采购/进口决策人的真实姓名、职位、邮箱、电话。",
    "只输出一个 JSON 对象，不要额外文字：{contact_name, contact_role, email_candidates:[{email,confidence,pattern,source_url}], phone, company_profile, fit_note, fit_score}。",
    "硬规则：",
    "① 只写你在网页上真实看到的信息。每个邮箱都要在 source_url 里给出看到它的页面地址，pattern 一律标 verified。",
    "② 没找到就把 contact_name 留空、email_candidates 给空数组、phone 留空——严禁按域名拼 firstname.lastname 之类的地址，也严禁编造人名。",
    "   拼出来的地址会被用户拿去发真实客户，退信会毁掉他的发信域名；留空是正确答案，猜不是。",
    "③ fit_score 必须诚实：招投标/采购公告平台、B2B 目录站、行业媒体、同行制造商、平台卖家都不是采购方，一律 30 以下并在 fit_note 说明。",
    "④ fit_score 为 0-100 数字。"
  ].join("\n");
  const user = `公司: ${prospect.company}
官网域名: ${prospect.website || "（未知，请先联网找到官网）"}
市场: ${prospect.market}
我方要开发的客户类型: ${state.campaign.customerType}
我方产品: ${state.campaign.product}`;
  try {
    const text = await callClaudeWebSearch(system, user, 2500);
    const data = extractJsonObject(text);
    if (!data) {
      if (!quiet) addLog(`官网深挖未拿到可解析结果：${prospect.company}`);
      return "none";
    }
    applyContact(prospectId, data, "claude-web");
    if (!quiet) addLog(`官网深挖联系人（联网核实）：${prospect.company}`);
    saveState();
    render();
    return "claude-web";
  } catch (error) {
    if (!quiet) addLog(`官网深挖失败：${error.message}`);
    return "none";
  }
}

// 一键批量补全：对所有缺联系方式/新线索依次跑「AI 找联系人」链路（真实源→Claude→本地）
/* ---------- 公司名 → 官网域名解析 ----------
   海关数据只给公司名，不给域名；而「找联系人 / 官网深挖 / 邮箱模式推测」全都要域名。
   缺这一步，海关线索永远补不出可发送的邮箱，会被发送预检一条不剩地拦下。

   只认联网核实与 AI 推测两种来源，绝不用规则凭空拼域名——拼错的域名会让后面所有
   推测邮箱指向另一家公司，等于批量发错人。找不到就明说找不到，留给人工补。 */

const AI_WEBSITE_SCHEMA = {
  type: "object",
  properties: {
    website: {
      type: "string",
      description: "该公司的官网域名，只要域名本身（如 acme-imports.com），不要 http/www/路径。不确定就返回空字符串，绝对不要编造或猜一个相似的。"
    },
    confidence: { type: "number", description: "0-100，你对这个域名确实属于这家公司的把握" },
    note: { type: "string", description: "一句中文说明依据（如：官网页脚公司名与国家一致）" }
  },
  required: ["website"]
};

function isPlausibleDomain(domain) {
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(domain) && /\.[a-z]{2,}$/.test(domain) && !NON_COMPANY_DOMAIN.test(domain);
}

async function resolveWebsiteAI(prospectId, quiet = false) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect) return "none";
  if (prospect.website) return "skip";
  if (!aiEnabled()) {
    if (!quiet) showAiSetup("解析官网需要先配置 AI 引擎：填入 API Key 后点「测试连接」（Claude 可联网核实，最准）");
    return "none";
  }

  const system =
    "你是外贸线索核查助手。给你一个海外公司名和它所在的国家，找出这家公司的官网域名。" +
    "严格要求：只能返回你有把握确实属于这家公司的域名；同名公司很多，国家对不上就不要给；" +
    "找不到就把 website 返回空字符串。宁可空着也绝不能编造——编错一个域名，后续会往完全无关的公司发邮件。";
  const user = `公司名: ${prospect.company}
国家/市场: ${prospect.market}
该公司疑似采购的品类: ${state.campaign.product}
${prospect.customsProduct ? `海关记录里的货物描述: ${prospect.customsProduct}` : ""}`;

  try {
    let data;
    if (aiWebSearchCapable()) {
      const text = await callClaudeWebSearch(`${system} 用联网搜索确认后再回答。只返回一个 JSON 对象：{"website":"","confidence":0,"note":""}`, user, 1200);
      data = extractJsonObject(text);
    } else {
      data = await callAI(system, user, AI_WEBSITE_SCHEMA, 400);
    }
    const domain = stripProtocol(String(data?.website || "").trim())
      .split("/")[0]
      .replace(/^www\./i, "")
      .toLowerCase();

    if (!domain || !isPlausibleDomain(domain)) {
      prospect.websiteStatus = "未找到";
      if (!quiet) addLog(`没查到 ${prospect.company} 的官网——可手动补域名，或配 Claude 用联网核实重试`);
      saveState();
      render();
      return "none";
    }

    prospect.website = domain;
    // 来源要跟着走：联网核实过的和 AI 猜的，在质量分和邮箱验证里待遇不同
    prospect.websiteSource = aiWebSearchCapable() ? "claude-web" : "claude";
    prospect.websiteStatus = aiWebSearchCapable() ? "联网核实" : "AI 推测";
    prospect.websiteConfidence = Number(data?.confidence) || (aiWebSearchCapable() ? 80 : 55);
    if (data?.note) prospect.websiteNote = String(data.note).slice(0, 120);
    if (!quiet) addLog(`${prospect.company} → ${domain}（${prospect.websiteStatus}）`);
    saveState();
    render();
    return prospect.websiteSource;
  } catch (error) {
    prospect.websiteStatus = "解析失败";
    if (!quiet) addLog(`解析官网失败：${error.message}`);
    return "none";
  }
}

async function bulkResolveWebsites(onProgress) {
  // 试用锁定的线索不参与批量补全：这一步会消耗真实 API 额度并产出可直接用的联系方式，
  // 放开等于把上限架空（几百条验证过的邮箱导出去就能在别处发）
  const unlocked = trialUnlockedIdSet();
  const targets = activeProspects().filter((p) => !p.website && p.company && !isTrialLocked(p, unlocked));
  if (!targets.length) {
    addLog("没有需要解析官网的线索（都已有域名）");
    saveState();
    render();
    return 0;
  }
  if (!aiEnabled()) {
    showAiSetup(`有 ${targets.length} 家线索只有公司名没有官网。解析官网需要先配置 AI 引擎（Claude 可联网核实，最准）`);
    return 0;
  }
  addLog(`开始解析 ${targets.length} 家公司的官网域名…（${aiWebSearchCapable() ? "Claude 联网核实" : "AI 推测，建议换 Claude 联网更准"}）`);
  renderLogs();
  let done = 0;
  let hit = 0;
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    const result = await resolveWebsiteAI(t.id, true);
    if (result === "claude-web" || result === "claude") hit += 1;
    done += 1;
    if (onProgress) onProgress(done, targets.length);
    if (done % 3 === 0 || done === targets.length) {
      addLog(`解析官网进度 ${done}/${targets.length}（已找到 ${hit} 个）…`, { toast: false });
      renderLogs();
    }
  }
  addLog(`官网解析完成：${done} 家里找到 ${hit} 个域名${done > hit ? `，${done - hit} 家没查到需手动补` : ""}。接下来可以「批量补全联系方式」`);
  saveState();
  render();
  return hit;
}

async function bulkEnrichContacts(onProgress) {
  // 海关数据导入的线索只有公司名：先补域名，否则找联系人这一步根本无从下手
  // 试用锁定的线索一律跳过（同 bulkResolveWebsites 的理由）
  const unlockedSet = trialUnlockedIdSet();
  const lockedSkipped = activeProspects().filter((p) => isTrialLocked(p, unlockedSet)).length;
  if (lockedSkipped) {
    addLog(`🔒 有 ${lockedSkipped} 条超出试用版可联系上限，本次跳过。激活后一并补全，资料已保留。`);
  }
  const noSite = activeProspects().filter(
    (p) => !p.website && p.company && p.websiteStatus !== "未找到" && !isTrialLocked(p, unlockedSet)
  );
  if (noSite.length && aiEnabled()) {
    addLog(`有 ${noSite.length} 家线索缺官网，先解析域名再找联系人`);
    renderLogs();
    for (const p of noSite) {
      // eslint-disable-next-line no-await-in-loop
      await resolveWebsiteAI(p.id, true);
    }
  }

  const targets = activeProspects().filter(
    (p) =>
      !isTrialLocked(p, unlockedSet) &&
      (!p.email ||
        ["待查找", "待补全", "待确认"].includes(p.contactName) ||
        ["新发现", "待审核"].includes(p.status))
  );
  if (!targets.length) {
    addLog("没有需要补全联系方式的线索（都已补全或缺产品/线索）");
    saveState();
    render();
    return 0;
  }
  addLog(`开始批量补全 ${targets.length} 家线索的联系方式…（真实源/AI/规则按已配置引擎）`);
  renderLogs();
  let done = 0;
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    await enrichContactAI(t.id, true);
    done += 1;
    if (onProgress) onProgress(done, targets.length);
    if (done % 3 === 0 || done === targets.length) {
      addLog(`批量补全进度 ${done}/${targets.length}…`, { toast: false });
      renderLogs();
    }
  }
  addLog(`批量补全完成：处理 ${done} 家线索`);
  saveState();
  render();
  return done;
}

async function generateSequenceAI() {
  const prospect = getSelectedProspect();
  if (!prospect) {
    addLog("请先选择潜客");
    return;
  }
  if (!aiEnabled()) {
    showAiSetup("深度写信需要先配置 Claude API：请填入 Anthropic API Key 后点击「测试连接」");
    return;
  }
  addLog(`Claude 正在为 ${prospect.company} 深度写信…`);
  try {
    const system =
      "你是顶尖外贸开发信专家。为指定客户写一套 4 封开发信序列（D0 首触 / D3 跟进 / D7 案例或样品 / D14 收尾）。每封 90-140 词。风格要求：专业、正式、得体的 B2B 商务书面语——用正式称呼（如 Dear Mr./Ms. 或 Dear Sir or Madam），完整礼貌的句子，克制不浮夸、无感叹号轰炸、无营销套话；开头简述来意与对我方的简短可信介绍，中段给具体而克制的价值点，结尾一个清晰礼貌的行动请求（如 May I send our catalogue?），落款用 Best regards 加署名与公司名。围绕该客户的业务与市场个性化切入。若给了「具体产品聚焦/英文术语」，主题与正文要点名这个具体产品（用英文行业叫法），而非泛泛的品类；卖点与能力只能用给定的知识库/卖点，不要编造参数。label 用中文。语言规则：按客户市场的商务语言写正文——拉美用西班牙语（巴西用葡萄牙语）、法语区非洲用法语、中东可英语正文+阿语问候；首封在正文下附简短英文版本；其他市场用英文。合规：每封信结尾附一句专业的退订说明（英文，如让对方回复 unsubscribe 即不再打扰），语气礼貌自然。";
    const ctx = campaignContextLines();
    const user = `产品: ${state.campaign.product}
卖点: ${state.campaign.valueProps}
认证: ${state.campaign.certifications}
署名: ${state.campaign.senderName}, ${state.campaign.companyName}${ctx ? "\n" + ctx : ""}
客户: ${prospect.company}
市场: ${prospect.market}
联系人: ${prospect.contactName}（${prospect.role}）
网站: ${prospect.website}
采购信号: ${prospect.buyingSignal}`;
    const result = await callAI(system, user, AI_SEQUENCE_SCHEMA, 3000);
    // 合规：AI 写的信同样要带退订说明（模板级注入不可删，AI 不会自己加）
    state.sequence = (result.emails || []).slice(0, 6).map((email) => ({
      id: makeId("email"),
      label: email.label,
      dayOffset: email.dayOffset,
      subject: email.subject,
      body: hasUnsubscribeElement(email.body) ? email.body : `${email.body}\n\n${UNSUBSCRIBE_LINE}`,
      ai: true
    }));
    addLog(`Claude 已生成 ${state.sequence.length} 封深度个性化开发信：${prospect.company}`);
    saveState();
    render();
  } catch (error) {
    addLog(`Claude 写信失败：${error.message}`);
  }
}

// 把常见失败翻译成下一步该做什么。最常踩的坑：拿第三方中转站的 Key 去打官方接口。
/* Key 长什么样：认证失败时把实际填进去的 Key 的形状说出来。
   输入框是密码框，一串点看不出有没有真的换掉——很多人以为换了，其实还是上一家的 Key。
   只暴露长度和首尾各 4 位，中间永远不显示。 */
function aiKeyShape() {
  const key = (state.settings.aiApiKey || "").trim();
  if (!key) return "";
  const head = key.slice(0, 4);
  const tail = key.length > 8 ? key.slice(-4) : "";
  return `当前填的是 ${head}…${tail}，共 ${key.length} 位`;
}

// 各家 Key 的开头。对不上基本可以断定填错了家，比让用户来回猜快得多。
const AI_KEY_PREFIX = {
  deepseek: "sk-",
  openai: "sk-",
  anthropic: "sk-ant-",
  qwen: "sk-",
  kimi: "sk-",
  stepfun: "sk-",
  yi: "sk-",
  baichuan: "sk-",
  siliconflow: "sk-",
  hunyuan: "sk-"
};

function aiKeyPrefixWarning() {
  const id = aiProviderId();
  const want = AI_KEY_PREFIX[id];
  const key = (state.settings.aiApiKey || "").trim();
  if (!want || !key || key.startsWith(want)) return "";
  return `这个 Key 不是 ${want} 开头，多半不是${aiProviderConf().label}的 Key——八成是上一家或中转站的没换掉。`;
}

/* 协议错配：中转地址的协议和所选服务商对不上。
   很多网关（阿里百炼的套餐专属地址就是典型）同时给两个 Base URL——
   一个 OpenAI 兼容（.../compatible-mode/v1），一个 Anthropic 兼容（.../apps/anthropic）。
   挑错那个就是 404，而 404 本身完全看不出是这个原因。 */
function aiProtocolMismatch() {
  const relay = aiBaseUrlOverride().toLowerCase();
  if (!relay) return "";
  const wantAnthropic = aiProviderConf().auth === "anthropic";
  const looksAnthropic = /anthropic|\/messages\b/.test(relay);
  const looksOpenAi = /compatible-mode|chat\/completions|\/openai\b/.test(relay);
  if (!wantAnthropic && looksAnthropic && !looksOpenAi) {
    return `中转地址是 Anthropic 协议的（${relay}），但服务商「${aiProviderConf().label}」走的是 OpenAI 兼容协议，两边对不上。要么把地址换成该网关的 OpenAI 兼容地址（通常是 .../compatible-mode/v1），要么把服务商改成 Claude (Anthropic)。`;
  }
  if (wantAnthropic && looksOpenAi && !looksAnthropic) {
    return `中转地址是 OpenAI 兼容协议的（${relay}），但服务商选的是 Claude (Anthropic)，走的是 Anthropic 协议。要么把地址换成该网关的 Anthropic 兼容地址，要么把服务商改成任一 OpenAI 兼容的（如通义千问）。`;
  }
  return "";
}

function aiTestFailHint(error) {
  const msg = String(error?.message || "");
  const relay = aiBaseUrlOverride();
  // 协议错配最优先报：它能同时解释 404 和一部分认证失败
  const mismatch = aiProtocolMismatch();
  if (mismatch && /404|not found|405|invalid|unauthorized|401/i.test(msg)) return `（${mismatch}）`;
  if (/x-api-key|authentication|unauthorized|401|invalid/i.test(msg)) {
    const parts = [];
    if (relay) {
      // 填了中转地址还认证失败：请求确实到了中转站，是中转站不认这个 Key
      parts.push(`中转站不认这个 Key（请求已经发到 ${relay} 了，不是官方拒的）。`);
    } else {
      parts.push(aiKeyPrefixWarning() || "Key 无效。");
    }
    const shape = aiKeyShape();
    if (shape) parts.push(`${shape}。`);
    parts.push(
      relay
        ? "去中转站后台重新复制 Key，并确认它支持你选的这个服务商。"
        : `请到${aiProviderConf().label}官网重新复制一次；如果这个 Key 是第三方中转站给的，要在下方「中转地址」填中转站域名，官方接口不认中转站的 Key。`
    );
    return `（${parts.join("")}）`;
  }
  if (relay && /404|not found/i.test(msg)) {
    return "（中转地址路径不对，试试只填域名，或按中转站文档填完整接口地址）";
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return "（网络不通或跨域被拦。检查地址拼写与本机网络，浏览器版遇跨域请改用桌面版）";
  }
  if (/model.*(not exist|not found|does not exist|无效|不存在)|invalid.*model/i.test(msg)) {
    const list = (state.settings.aiModelCache || {})[aiProviderId()] || [];
    return list.length
      ? `（这个服务商没有「${state.settings.aiModel}」这个模型。已拉到的 ${list.length} 个里可选：${list.slice(0, 5).join("、")}${
          list.length > 5 ? " 等" : ""
        }，在上面的模型下拉里直接换）`
      : "（模型名不对。点「拉取可用模型」把这个 Key 真正能用的清单拉下来，再从下拉里选）";
  }
  if (/model/i.test(msg)) return "（模型名不对，中转站的模型名可能与官方不同，按其文档填写）";
  return "";
}

async function testAiEngineConnection() {
  readSettingsFromForm();
  const statusEl = elements.aiEngineTestStatus;
  if (!(state.settings.aiApiKey || "").trim()) {
    statusEl.className = "webhook-status fail";
    statusEl.textContent = "未填写 API Key";
    return;
  }
  statusEl.className = "webhook-status pending";
  statusEl.textContent = "测试中…";
  const start = Date.now();
  const conf = aiProviderConf();
  const name = conf.label;
  const model = state.settings.aiModel || conf.models[0] || "默认模型";
  try {
    await callAI("只回复两个字：正常", "连通性测试", null, 16);
    statusEl.className = "webhook-status ok";
    statusEl.textContent = `正常 · ${model} · ${Date.now() - start}ms`;
    addLog(`${name} 连接成功（${model}${aiBaseUrlOverride() ? " · 中转" : ""}）`);
  } catch (error) {
    statusEl.className = "webhook-status fail";
    statusEl.textContent = `失败 · ${error.message.slice(0, 40)}`;
    // 带上真实请求地址：报错文案来自哪一家，一眼就能对上，不必靠猜服务商选没选对
    addLog(`${name} 连接失败（请求发往 ${aiEndpoint()}）：${error.message}${aiTestFailHint(error)}`);
  }
  saveState();
  updateAiEngineButtons();
}

/* ---------- 模型清单：内置候选 + 从服务商实拉 + 手填 ---------- */

// 该服务商的可选模型：优先用「拉取可用模型」实拉到的，其次内置候选。
// 不含当前选中值——换服务商时要靠它判断旧模型还适不适用。
function aiModelCatalog() {
  const fetched = (state.settings.aiModelCache || {})[aiProviderId()] || [];
  return fetched.length ? fetched.slice() : aiProviderConf().models.slice();
}

// 下拉实际渲染的清单：目录 + 当前选中值。
// 必须补上当前值，否则中转站的自定义别名一刷新就从下拉里消失了。
function aiModelChoices() {
  const list = aiModelCatalog();
  const current = (state.settings.aiModel || "").trim();
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}

function renderAiModelOptions() {
  const select = elements.aiModelSelect;
  if (!select) return;
  const list = aiModelChoices();
  const current = (state.settings.aiModel || "").trim();
  select.innerHTML =
    list.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("") +
    `<option value="${AI_MODEL_CUSTOM}">自定义模型名…</option>`;
  select.value = current || list[0] || AI_MODEL_CUSTOM;
  applyAiModelCustomRow();
  renderAiModelNote();
}

// 下拉里只有两三个模型时，用户会以为"就这么点能用"。但这句话成不成立，
// 完全取决于走的是官方接口还是中转站：
//   · 官方接口 —— 内置清单就是全部（DeepSeek 官方确实只开放 chat 和 reasoner）
//   · 中转站   —— 能用哪些只有它自己知道，通常还会多给 deepseek-v3 / r1 之类别名
//
// 刻意不往内置清单里塞猜的模型名：那些在官方接口下会直接报 Model not exist，
// 等于把"编造"从联系人挪到了模型名上。让界面把这件事讲清楚，比塞几个假选项强。
function renderAiModelNote() {
  const note = document.getElementById("aiModelNote");
  if (!note) return;
  const conf = aiProviderConf();
  const fetched = ((state.settings.aiModelCache || {})[aiProviderId()] || []).length;
  const relay = (state.settings.aiBaseUrl || "").trim();

  if (fetched) {
    note.className = "ai-model-note is-ok";
    note.textContent = `这 ${fetched} 个是从你的服务商实拉下来的真实清单，不是内置猜的。换了 Key 或中转站记得重新拉一次。`;
    return;
  }
  if (relay) {
    note.className = "ai-model-note is-warn";
    note.textContent =
      `下拉里这 ${conf.models.length} 个是 ${conf.label} 官方接口的清单。你填了中转地址，` +
      `中转站支持哪些模型由它自己决定（多数会额外提供带版本号或别名的型号），` +
      `点「拉取可用模型」把它的真实清单拉下来；也可以选「自定义模型名…」按中转站文档手填。`;
    return;
  }
  if (!conf.models.length) {
    note.className = "ai-model-note is-warn";
    note.textContent = `${conf.label} 没有固定模型名（要填你自己的接入点 ID），请选「自定义模型名…」手填，或点「拉取可用模型」。`;
    return;
  }
  note.className = "ai-model-note";
  note.textContent = `这 ${conf.models.length} 个就是 ${conf.label} 官方接口开放的全部模型。用中转站的话点「拉取可用模型」会不一样。`;
}

function applyAiModelCustomRow() {
  const custom = elements.aiModelSelect?.value === AI_MODEL_CUSTOM;
  if (elements.aiModelCustomRow) elements.aiModelCustomRow.style.display = custom ? "" : "none";
  if (custom && elements.aiModelCustomInput && !elements.aiModelCustomInput.value) {
    elements.aiModelCustomInput.value = state.settings.aiModel || "";
  }
}

// 表单里的模型可能来自下拉，也可能来自「自定义模型名」输入框
function readAiModelFromForm() {
  const select = elements.aiModelSelect;
  if (!select) return state.settings.aiModel || "";
  if (select.value === AI_MODEL_CUSTOM) return (elements.aiModelCustomInput?.value || "").trim();
  // 下拉还没渲染出选项时 value 是空串，不能拿它把用户已存的模型冲掉
  return (select.value || "").trim() || state.settings.aiModel || "";
}

// 各家（含中转站）都提供 GET <版本段>/models，从接口地址推出来即可。
// 按尾巴替换不够用：各家路径差别很大（/v1/chat/completions、/api/paas/v4/chat/completions、
// MiniMax 的 /v1/text/chatcompletion_v2），尾巴对不上就会把聊天地址当成模型地址去 GET。
// 改成截到版本段（最后一个 /v<数字>）再接 /models，上面几种都能覆盖。
function aiModelsEndpoint() {
  const url = aiEndpoint();
  if (!url) return "";
  const m = url.match(/^(.*\/v\d+)(?:\/|$)/i);
  return m ? `${m[1]}/models` : url.replace(/\/(messages|chat\/completions)\/?$/, "/models");
}

// 内置清单必然会过时，也猜不到中转站的自定义别名 —— 让用户直接问服务商要真实清单
async function fetchAiModels() {
  readSettingsFromForm();
  const statusEl = elements.aiEngineTestStatus;
  const key = (state.settings.aiApiKey || "").trim();
  if (!key) {
    statusEl.className = "webhook-status fail";
    statusEl.textContent = "未填写 API Key";
    return;
  }
  const url = aiModelsEndpoint();
  if (!url) {
    statusEl.className = "webhook-status fail";
    statusEl.textContent = "未填写 API 地址";
    return;
  }
  statusEl.className = "webhook-status pending";
  statusEl.textContent = "拉取模型中…";
  try {
    const headers =
      aiProviderConf().auth === "anthropic" ? anthropicHeaders() : { Authorization: "Bearer " + key };
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const err = await response.json().catch(() => null);
      throw new Error(err?.error?.message || `HTTP ${response.status}`);
    }
    const data = await response.json();
    // Anthropic 与 OpenAI 兼容接口都返回 { data: [...] }，元素可能是对象也可能直接是字符串
    const ids = (data.data || data.models || [])
      .map((m) => (typeof m === "string" ? m : m?.id || m?.name || ""))
      .filter(Boolean);
    if (!ids.length) throw new Error("接口没有返回模型列表");
    state.settings.aiModelCache = { ...(state.settings.aiModelCache || {}), [aiProviderId()]: ids };
    // 刚拿到权威清单：当前选的模型如果不在里面，就是确定用不了的（下一次调用必报
    // Model not exist）。renderAiModelOptions 为了保住中转站别名会把当前值塞回列表并
    // 保持选中，那在这一刻是帮倒忙——直接换成清单里的第一个，并说清楚换了什么。
    const stale = (state.settings.aiModel || "").trim();
    const switched = stale && !ids.includes(stale);
    if (switched || !stale) state.settings.aiModel = ids[0];
    renderAiModelOptions();
    statusEl.className = "webhook-status ok";
    statusEl.textContent = `拉到 ${ids.length} 个模型`;
    addLog(
      switched
        ? `${aiProviderConf().label} 拉取到 ${ids.length} 个可用模型；原来填的「${stale}」不在其中，已改为「${ids[0]}」，可在下拉里换成别的`
        : `${aiProviderConf().label} 拉取到 ${ids.length} 个可用模型`
    );
  } catch (error) {
    statusEl.className = "webhook-status fail";
    statusEl.textContent = `拉取失败 · ${error.message.slice(0, 30)}`;
    addLog(`拉取模型失败（请求发往 ${url}）：${error.message}${aiTestFailHint(error)}`);
  }
  saveState();
  renderLogs();
}

// Base URL 对所有服务商开放：自定义服务商必填，其余留空走官方地址、填了就走中转站。
function applyAiBaseUrlRow() {
  if (!elements.aiBaseUrlRow) return;
  const custom = aiProviderId() === "custom";
  elements.aiBaseUrlRow.style.display = "";
  if (elements.aiBaseUrlLabel) {
    elements.aiBaseUrlLabel.textContent = custom
      ? "API 地址 Base URL（必填）"
      : `中转地址（选填，留空走官方接口；只填域名会自动补 ${aiEndpointPath()}）`;
  }
  if (elements.aiBaseUrlInput) {
    elements.aiBaseUrlInput.placeholder = custom
      ? "https://你的服务/v1/chat/completions"
      : "https://你的中转域名";
  }
}

// 服务商切换：填好默认地址提示、重置模型为该服务商默认、刷新 Base URL 说明
function applyAiProviderToForm() {
  const conf = aiProviderConf();
  if (elements.aiApiKeyInput) elements.aiApiKeyInput.placeholder = conf.keyHint;
  applyAiBaseUrlRow();
  renderAiModelOptions();
  const cloudOn = state.settings.aiEngine === "cloud" || state.settings.aiEngine === "claude";
  if (elements.aiCloudRow) elements.aiCloudRow.style.display = cloudOn ? "" : "none";
}

function updateAiEngineButtons() {
  const engine = state.settings.aiEngine === "claude" ? "cloud" : state.settings.aiEngine || "local";
  const enabled = aiEnabled();
  const conf = aiProviderConf();
  if (elements.aiLocalMode) elements.aiLocalMode.classList.toggle("is-active", engine === "local");
  if (elements.aiCloudMode) elements.aiCloudMode.classList.toggle("is-active", engine === "cloud");
  if (elements.aiProviderSelect) elements.aiProviderSelect.value = aiProviderId();
  elements.aiEngineStatus.textContent = enabled
    ? `${conf.label} · ${state.settings.aiModel}`
    : engine === "cloud"
      ? `${conf.label}（未配置 Key）`
      : "本地规则";
  if (elements.aiCloudRow) elements.aiCloudRow.style.display = engine === "cloud" ? "" : "none";
  applyAiBaseUrlRow();

  // 联网类功能仅 Claude 可用；其余模型下按钮标注但仍可点（会走本地兜底）
  const webCap = aiWebSearchCapable();
  [
    [elements.webSearchFind, "联网找客户", "配置 Claude 后联网找客户", true],
    [elements.reverseCompetitor, "反查经销商", "配置 Claude 后反查", true],
    [elements.aiWriteEmail, "AI 深度写信", "配置 AI 引擎后深度写信", false]
  ].forEach(([button, readyLabel, setupLabel, needsWeb]) => {
    if (!button) return;
    const ok = needsWeb ? webCap : enabled;
    button.classList.toggle("needs-config", !ok);
    const label = button.querySelector("span");
    if (label) label.textContent = ok ? readyLabel : setupLabel;
  });
}

/* ================== AI 自动获客 Agent（任务解析 → 寻客 → 审批 → 开发 → 移交） ================== */

const AGENT_TASK_SCHEMA = {
  type: "object",
  properties: {
    product: { type: "string", description: "客户经营/采购的产品品类，英文小写，如 outdoor furniture" },
    markets: { type: "array", items: { type: "string" }, description: "目标市场英文名列表，如 United States" },
    customer_type: {
      type: "string",
      enum: ["importer distributor", "retailer chain buyer", "brand private label", "wholesaler", "contractor project buyer"]
    },
    keywords: { type: "array", items: { type: "string" }, description: "3-6 个英文行业搜索词，含同义词与当地术语" },
    size_note: { type: "string", description: "规模条件中文描述，没有则空字符串" },
    exclusion_note: { type: "string", description: "排除条件中文描述，没有则空字符串" },
    daily_limit: { type: "integer", description: "每日触达上限，未提及则 30" },
    use_email: { type: "boolean" },
    use_whatsapp: { type: "boolean" },
    summary: { type: "string", description: "一句话中文复述任务" }
  },
  required: ["product", "markets", "customer_type", "keywords", "size_note", "exclusion_note", "daily_limit", "use_email", "use_whatsapp", "summary"],
  additionalProperties: false
};

const AGENT_MARKET_WORDS = [
  ["美国", "United States"], ["加拿大", "Canada"], ["德国", "Germany"], ["英国", "United Kingdom"],
  ["法国", "France"], ["澳大利亚", "Australia"], ["澳洲", "Australia"], ["日本", "Japan"], ["韩国", "South Korea"],
  ["中东", "United Arab Emirates"], ["阿联酋", "United Arab Emirates"], ["迪拜", "United Arab Emirates"],
  ["墨西哥", "Mexico"], ["巴西", "Brazil"], ["西班牙", "Spain"], ["意大利", "Italy"], ["荷兰", "Netherlands"],
  ["波兰", "Poland"], ["俄罗斯", "Russia"], ["印度", "India"], ["越南", "Vietnam"], ["泰国", "Thailand"],
  ["东南亚", "Vietnam, Thailand"], ["欧洲", "Germany, France, United Kingdom"],
  ["usa", "United States"], ["united states", "United States"], ["america", "United States"],
  ["canada", "Canada"], ["germany", "Germany"], ["france", "France"], ["australia", "Australia"],
  ["japan", "Japan"], ["mexico", "Mexico"], ["brazil", "Brazil"], ["spain", "Spain"], ["italy", "Italy"],
  ["uae", "United Arab Emirates"], ["dubai", "United Arab Emirates"]
];

function parseAgentTaskLocal(prompt) {
  const lower = prompt.toLowerCase();
  const markets = [];
  AGENT_MARKET_WORDS.forEach(([word, market]) => {
    const hit = /[a-z]/.test(word) ? new RegExp(`\\b${word}\\b`, "i").test(lower) : prompt.includes(word);
    if (hit) market.split(", ").forEach((m) => !markets.includes(m) && markets.push(m));
  });

  let customerType = "importer distributor";
  if (/零售|连锁|retail/i.test(prompt)) customerType = "retailer chain buyer";
  else if (/品牌|贴牌|oem|private label/i.test(prompt)) customerType = "brand private label";
  else if (/工程|项目采购|contractor/i.test(prompt)) customerType = "contractor project buyer";
  else if (/批发|wholesal/i.test(prompt) && !/进口|import|经销|distribut/i.test(prompt)) customerType = "wholesaler";

  let product = "";
  const zhMatch = prompt.match(/做(.{2,20}?)(?:批发|进口|贸易|生意|的)/);
  if (zhMatch) product = zhMatch[1].trim();
  const enMatch = prompt.match(/[a-zA-Z][a-zA-Z\s]{3,40}[a-zA-Z]/);
  if (!product && enMatch && !/whatsapp/i.test(enMatch[0])) product = enMatch[0].trim().toLowerCase();
  if (!product) product = state.campaign.product;

  const limitMatch = prompt.match(/(?:每日|每天|日|上限)[^\d]{0,6}(\d{1,3})/) || prompt.match(/(\d{1,3})\s*(?:家|个)/);
  const sizeMatch = prompt.match(/规模[^，。,]{0,30}/);
  const exclMatch = prompt.match(/排除[^，。,]{0,30}/);

  return {
    product,
    markets: markets.length ? markets : normalizeMarkets(state.campaign.markets),
    customer_type: customerType,
    keywords: [product, `${product} wholesale`, `${product} importer`].filter(Boolean),
    size_note: sizeMatch ? sizeMatch[0] : "",
    exclusion_note: exclMatch ? exclMatch[0] : "已在 CRM 中的客户自动去重",
    daily_limit: clamp(Number(limitMatch?.[1]) || 30, 1, 300),
    use_email: !/只发?\s*whatsapp/i.test(prompt),
    use_whatsapp: !/只发?(开发信|邮件)|不.{0,3}whatsapp/i.test(prompt),
    summary: prompt.slice(0, 80)
  };
}

async function parseAgentTask() {
  const prompt = elements.agentPromptInput.value.trim();
  if (!prompt) {
    addLog("请先用一句话描述你要开发的客户");
    runAbort("没写任务描述，先用一句话说明要找什么客户");
    return;
  }
  runBegin("解析任务", aiEnabled() ? "AI 正在理解你的需求…" : "本地规则解析中…");
  let parsed = null;
  let source = "local";
  let aiError = "";
  if (aiEnabled()) {
    elements.agentEngineTag.textContent = "Claude 解析中…";
    try {
      parsed = await callAI(
        "你是外贸获客任务解析器。把用户的一句话客户开发需求解析为结构化任务。markets 必须是英文国家/地区名；keywords 用英文并扩展同义词与当地行业术语；未提及的条件给合理默认值。",
        prompt,
        AGENT_TASK_SCHEMA,
        1200
      );
      source = "claude";
    } catch (error) {
      aiError = error.message;
      addLog(`Claude 解析失败，已用本地规则：${error.message}`);
    }
  }
  if (!parsed) {
    runStep("本地规则解析中…");
    parsed = parseAgentTaskLocal(prompt);
  }

  state.agent.task = {
    id: makeId("agent"),
    prompt,
    parsed,
    source,
    approvalMode: "review",
    status: "draft",
    funnel: { raw: 0, matched: 0, verified: 0, deduped: 0, scored: 0 },
    recurring: { enabled: false, interval: "weekly", perCycle: 20, useWebSearch: false, lastRunAt: null, cyclesRun: 0 },
    startedAt: timestamp()
  };
  state.agent.approvals = [];
  addLog(`任务解析完成（${source === "claude" ? "Claude" : "本地规则"}）：请在任务卡片中确认后启动`);
  // 降级到本地规则也算跑通了，但要说清楚是降级来的，别让用户以为 AI 生效了
  runDone(
    aiError
      ? `AI 解析失败已降级本地规则（${aiError.slice(0, 30)}）——任务卡片已生成，确认后才会开跑`
      : `${source === "claude" ? "AI" : "本地规则"}已生成任务卡片——确认后才会开跑`,
    { label: "去确认任务", view: "agent" }
  );
  saveState();
  render();
}

function confirmAgentTask() {
  const task = state.agent.task;
  if (!task) return;
  const parsed = task.parsed;
  parsed.product = $("#agentFProduct").value.trim() || parsed.product;
  parsed.markets = $("#agentFMarkets").value.split(/[,，]/).map((m) => m.trim()).filter(Boolean);
  parsed.customer_type = $("#agentFType").value;
  parsed.daily_limit = clamp(Number($("#agentFLimit").value) || 30, 1, 300);
  parsed.keywords = $("#agentFKeywords").value.split(/[,，]/).map((k) => k.trim()).filter(Boolean);
  parsed.use_email = $("#agentFEmail").checked;
  parsed.use_whatsapp = $("#agentFWa").checked;

  state.campaign = {
    ...state.campaign,
    product: parsed.product,
    markets: parsed.markets.join(", "),
    customerType: parsed.customer_type,
    dailyLimit: parsed.daily_limit
  };

  // 自动做具体产品聚焦：把任务里的产品细化成行业术语+同义词+HS+买家画像，
  // 后续搜索式/联网找客户/周期补量/开发信全部围绕这个具体产品（异步，不阻塞任务启动）
  const isBroadPreset = Object.values(CATEGORY_PRESETS).some((p) => p.product === parsed.product);
  if (aiEnabled() && parsed.product && !isBroadPreset && parsed.product !== state.campaign.focusProduct) {
    state.campaign.focusProduct = parsed.product;
    state.campaign.productTerms = [parsed.product];
    if (elements.focusProductInput) elements.focusProductInput.value = parsed.product;
    refineProductFocus(); // 完成后会自动重建搜索式并提示细化结果
  }

  bindCampaignForm();
  state.searchPlan = generateSearchPlan(state.campaign);
  task.status = "prospecting";
  addLog(
    `Agent 任务已启动（${task.approvalMode === "spot" ? "批量审批" : "逐条审批"}）：已生成 ${state.searchPlan.length} 条搜索任务。去「搜索」导入真实结果，或点「用演示数据体验」`
  );
  saveState();
  render();
}

function agentOnProspectsImported(imported) {
  const task = state.agent.task;
  if (!task || task.status === "draft" || !imported.length) return;

  task.funnel.raw += imported.length;
  const marketSet = new Set(task.parsed.markets);
  const matched = imported.filter((p) => !marketSet.size || marketSet.has(p.market));
  task.funnel.matched += matched.length;

  const ids = new Set(matched.map((p) => p.id));
  const processed = verifyProspectList(
    enrichProspectList(state.prospects.filter((p) => ids.has(p.id)), state.campaign),
    state.campaign
  );
  const byId = new Map(processed.map((p) => [p.id, p]));
  state.prospects = state.prospects.map((p) => byId.get(p.id) || p);
  const verified = processed.filter((p) => p.emailStatus === "格式有效");
  task.funnel.verified += verified.length;
  task.funnel.deduped = task.funnel.verified; // 跨渠道去重在导入阶段已完成

  const capacity = Math.max(0, task.parsed.daily_limit - state.agent.approvals.length);
  const qualified = verified
    .map((p) => ({ p, score: computeLeadScore(p).probability }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, capacity);
  task.funnel.scored += qualified.length;

  qualified.forEach(({ p }) => {
    if (state.agent.approvals.some((a) => a.prospectId === p.id)) return;
    state.agent.approvals.push({ id: makeId("appr"), prospectId: p.id, status: "pending", at: timestamp() });
  });

  // 发送必须人工审批：所有模式都只生成待审批触达方案，不自动发送
  if (qualified.length) {
    addLog(`Agent：找到并验证 ${qualified.length} 个高分客户，触达方案已生成，等待你审批发送`);
  }
  task.status = state.agent.approvals.some((a) => a.status === "pending") ? "reviewing" : "outreach";

  // 配置了真实源(邮箱查找 Webhook)时，自动为入围客户找真实验证的联系方式
  if (state.settings.mode === "webhook" && webhookUrl("enrich") && qualified.length) {
    (async () => {
      for (const { p } of qualified) await enrichContactAI(p.id, true);
      addLog(`真实源已为 ${qualified.length} 个客户补全验证联系方式`);
    })();
  }
}

async function agentApprove(approval, quiet = false) {
  const task = state.agent.task;
  const prospect = state.prospects.find((p) => p.id === approval.prospectId);
  if (!prospect) {
    approval.status = "skipped";
    return;
  }
  // 人工审批通过 = 放行并发送首触（这就是发送前的人工闸口）；后续跟进仍需在队列里单独审批。
  let sentEmail = 0;
  let sentWhatsapp = 0;
  const today = dateOffset(0);

  if (task.parsed.use_email !== false) {
    queueProspect(prospect, false);
    const dueEmails = state.outbox.filter(
      (item) =>
        item.prospectId === prospect.id &&
        !item.reply &&
        ["待审批", "待发送"].includes(item.status) &&
        item.dueDate <= today
    );
    const sendable = dueEmails.filter((item) => preflightOutboxItem(item).ok);
    sendable.forEach((item) => (item.status = "待发送"));
    sentEmail = await sendOutboxItems(sendable);
    if (!quiet && dueEmails.length > sendable.length) addLog(`${prospect.company} 的邮件预检未通过，已保留在待审批队列`);
  }

  if (task.parsed.use_whatsapp && prospect.phone) {
    queueWhatsappProspect(prospect, false);
    const dueWhatsapp = state.whatsappQueue.filter(
      (item) => item.prospectId === prospect.id && ["待人工确认", "已审批"].includes(item.status) && item.dueDate <= today
    );
    dueWhatsapp.forEach((item) => (item.status = "已审批"));
    if (dueWhatsapp.length && state.settings.mode === "webhook" && webhookUrl("whatsapp")) {
      const result = await callWebhook("whatsapp", { messages: dueWhatsapp });
      if (result.ok) {
        dueWhatsapp.forEach((item) => {
          item.status = "已发送";
          item.sentAt = new Date().toISOString();
          item.delivered = true;
          advanceDealStage(item.prospectId, "已触达");
        });
        sentWhatsapp = dueWhatsapp.length;
      }
    } else {
      dueWhatsapp.forEach((item) => {
        item.status = "已发送";
        item.sentAt = new Date().toISOString();
        const h = hashInt(item.prospectId + item.step);
        item.delivered = h % 100 < 98;
        item.read = item.delivered && (h >> 3) % 100 < Math.min(88, 50 + Math.round((prospect.score || 60) * 0.5));
        advanceDealStage(item.prospectId, "已触达");
      });
      sentWhatsapp = dueWhatsapp.length;
    }
  }
  approval.status = "approved";
  if (!quiet) {
    const parts = [];
    if (sentEmail) parts.push(`${sentEmail} 封邮件`);
    if (sentWhatsapp) parts.push(`${sentWhatsapp} 条 WhatsApp`);
    addLog(parts.length ? `已审批并发送首触：${prospect.company}（${parts.join("、")}）` : `已审批：${prospect.company}，但暂无可发送首触`);
  }
  if (!state.agent.approvals.some((a) => a.status === "pending")) task.status = "outreach";
}

function agentRecurring() {
  const task = state.agent.task;
  if (!task) return null;
  if (!task.recurring) task.recurring = { enabled: false, interval: "weekly", perCycle: 20, useWebSearch: false, lastRunAt: null, cyclesRun: 0 };
  return task.recurring;
}

const AGENT_INTERVAL_MS = { daily: 86400000, weekly: 7 * 86400000, monthly: 30 * 86400000 };

function agentCycleDue() {
  const rec = agentRecurring();
  if (!rec || !rec.enabled) return false;
  if (!rec.lastRunAt) return true;
  return Date.now() - new Date(rec.lastRunAt).getTime() >= (AGENT_INTERVAL_MS[rec.interval] || AGENT_INTERVAL_MS.weekly);
}

async function agentRunCycle(manual = false) {
  const task = state.agent.task;
  const rec = agentRecurring();
  if (!task || task.status === "draft") return 0;

  const perCycle = clamp(Number(rec.perCycle) || 20, 1, 200);
  let batch = null;

  // Webhook 模式：走真实采集补充；否则用演示生成器模拟"每周补量"
  if (remoteSearchReady()) batch = await trySearchWebhook();
  // 每日自动联网找真实客户：开启且配置了 Claude 时，优先用联网搜索补量
  if (!batch?.length && rec.useWebSearch && aiEnabled()) {
    const n = await webSearchProspects({ count: perCycle });
    if (n > 0) {
      rec.lastRunAt = new Date().toISOString();
      rec.cyclesRun = (rec.cyclesRun || 0) + 1;
      addLog(
        `周期补量（第 ${rec.cyclesRun} 轮 · ${rec.interval === "daily" ? "每日" : rec.interval === "monthly" ? "每月" : "每周"} · 联网找真实客户）：新增 ${n} 家线索走漏斗`
      );
      saveState();
      render();
      return n;
    }
    // 联网没找到就继续用生成器兜底
  }
  if (!batch?.length) {
    const salt = `R${(rec.cyclesRun || 0) + 1}`;
    const generated = generateProspects(state.campaign, perCycle, salt);
    const seen = new Set(state.prospects.map((p) => p.website || p.company.toLowerCase()));
    batch = generated.filter((p) => {
      const key = p.website || p.company.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!manual && !batch.length) return 0;
  }

  batch = admitProspects(batch, "周期补量");
  state.prospects = [...batch, ...state.prospects];
  agentOnProspectsImported(batch);
  rec.lastRunAt = new Date().toISOString();
  rec.cyclesRun = (rec.cyclesRun || 0) + 1;
  addLog(
    `周期补量（第 ${rec.cyclesRun} 轮 · ${rec.interval === "daily" ? "每日" : rec.interval === "monthly" ? "每月" : "每周"}）：新增 ${batch.length} 家线索走漏斗`
  );
  saveState();
  render();
  return batch.length;
}

const AGENT_HOT_INTENTS = ["price", "sample", "moq", "cert", "leadtime", "discount"];

function agentHandoffData() {
  const hot = [];
  const warm = [];
  const rejected = [];
  let silent = 0;
  buildConversations().forEach((c) => {
    if (c.replied) {
      const lastInbound = [...state.inbound].reverse().find((m) => m.prospectId === c.prospectId);
      const escalated = lastInbound?.autoAction?.type === "escalated";
      const optout = lastInbound?.autoAction?.type === "optout";
      const stored = getStoredAI(c.prospectId);
      const local = getConversationIntent(c);
      const key = stored ? stored.intent : local?.key;
      const label = escalated
        ? `转人工 · ${lastInbound.autoAction.reason}`
        : stored
          ? stored.intent_label
          : local?.label || "已回复";
      const summary = stored ? stored.summary : null;
      if (optout) rejected.push({ c, label: "opt-out 黑名单" });
      else if (escalated || AGENT_HOT_INTENTS.includes(key)) hot.push({ c, label, summary });
      else if (key === "reject") rejected.push({ c, label });
      else warm.push({ c, label });
    } else if (c.events.some((e) => e.kind === "outbound" && e.status === "已发送")) {
      silent += 1;
    }
  });
  return { hot, warm, rejected, silent };
}

function computeAgentInsight() {
  const markets = {};
  activeProspects().forEach((p) => {
    const touched =
      state.outbox.some((o) => o.prospectId === p.id && o.status === "已发送") ||
      state.whatsappQueue.some((w) => w.prospectId === p.id && w.status === "已发送");
    if (!touched) return;
    markets[p.market] = markets[p.market] || { touched: 0, replied: 0 };
    markets[p.market].touched += 1;
    if (isReplied(p)) markets[p.market].replied += 1;
  });
  const rows = Object.entries(markets).filter(([, v]) => v.touched >= 2);
  if (rows.length < 2) return "";
  const totalTouched = rows.reduce((s, [, v]) => s + v.touched, 0);
  const totalReplied = rows.reduce((s, [, v]) => s + v.replied, 0);
  const avg = totalReplied / totalTouched;
  const best = rows
    .map(([m, v]) => ({ m, rate: v.replied / v.touched, replied: v.replied }))
    .filter((x) => x.replied >= 2 && x.rate >= avg * 1.5)
    .sort((a, b) => b.rate - a.rate)[0];
  return best ? `效果回流：「${best.m}」回复率 ${Math.round(best.rate * 100)}%（均值 ${Math.round(avg * 100)}%），建议下一批向该市场倾斜。` : "";
}

/* ---------- 第 4 步：AI 初轮应答护栏 ---------- */

function isOptOut(text) {
  return /unsubscribe|stop sending|stop emailing|remove me|opt.?out|take me off|do not contact|退订|别再发|不要再发|停止发送|取消订阅/i.test(
    text || ""
  );
}

/* ---------- 持久退订黑名单（按邮箱+域名，清空线索池不丢） ---------- */

function prospectDomain(prospect) {
  const fromEmail = (prospect?.email || "").split("@")[1] || "";
  const fromSite = stripProtocol(prospect?.website || "").replace(/^www\./, "").split("/")[0];
  return (fromEmail || fromSite || "").toLowerCase();
}

function addToBlacklist(prospect, reason = "opt-out") {
  if (!state.blacklist) state.blacklist = [];
  const email = (prospect?.email || "").toLowerCase();
  const domain = prospectDomain(prospect);
  if (!email && !domain) return false;
  const exists = state.blacklist.some((b) => (email && b.email === email) || (domain && b.domain === domain));
  if (exists) return false;
  state.blacklist.push({ email, domain, company: prospect?.company || "", reason, at: new Date().toISOString() });
  return true;
}

function isBlacklisted(prospect) {
  if (!state.blacklist?.length) return false;
  const email = (prospect?.email || "").toLowerCase();
  const domain = prospectDomain(prospect);
  return state.blacklist.some((b) => (email && b.email && b.email === email) || (domain && b.domain && b.domain === domain));
}

// opt-out 统一处理：标记线索 + 进持久黑名单（幂等，两条路径共用）
function markProspectOptOut(prospectId, reason = "客户回信退订") {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect) return;
  const firstTime = !prospect.optOut;
  prospect.optOut = true;
  const added = addToBlacklist(prospect, reason);
  if (firstTime || added) addLog(`⛔ ${prospect.company} 已进持久退订黑名单（同邮箱/域名以后不再触达，重建活动也不丢）`);
}

// 敏感话题：AI 一律不擅自答复，立即转人工。返回中文原因或 null
function sensitiveTopic(text) {
  const t = (text || "").toLowerCase();
  if (/payment term|net ?\d{2,3}|credit term|letter of credit|\bl\/c\b|账期|赊账|月结|信用证|付款方式|结算方式/.test(t))
    return "账期 / 付款条件";
  if (/exclusiv|sole (agent|distributor|agency)|distribution right|独家|总代理|代理权|区域保护/.test(t))
    return "独家 / 代理权";
  if (/discount|better price|lower price|target price|best price|price down|cheaper|砍价|折扣|优惠|降价|再便宜|最低价/.test(t))
    return "价格 / 折扣谈判";
  if (/contract|agreement|合同|协议|条款/.test(t)) return "合同条款";
  return null;
}

// 可自动答复的标准问题意图
const AGENT_STANDARD_INTENTS = ["price", "sample", "moq", "cert", "leadtime", "other"];

// 各品类的常见反问 FAQ（喂给 Claude 作答；不含任何具体价格/账期承诺，敏感项仍留给销售）
// 只写品类通识，不写产业带——用户自己的供应链背书从「管理 → 产品知识库」补
const CATEGORY_KNOWLEDGE = {
  moto: `品类：摩托车配件。常见问答：
- 混柜：可以把不同车型（CG125/150、GN125、CB、Bajaj/TVS 兼容、三轮车/tricycle 动力）和大量 item number 混在一个 20'/40' 柜里，方便试销。
- MOQ：首单灵活，起步可用整柜混合 SKU；具体阶梯由销售确认。
- 认证：CCC、SONCAP（尼日利亚等）、ISO 9001，可提供测试报告与目的国所需文件。
- 覆盖车型：CG125/150、GN125、CB 系列、Bajaj/TVS 兼容、三轮车动力件等快消件。
- 付款方式：常见 T/T 或即期 L/C；具体条款/账期由销售确认。
- 包装：中性/OEM 出口包装，可定制 logo。
- 交期：样品 5-7 天，大货确认后 25-35 天。`,
  auto: `品类：汽车零部件（售后件）。常见问答：
- 覆盖：滤清器、刹车片、悬挂、灯具等售后快消件，覆盖常见车型；可提供 OE 交叉参照。
- 混柜/MOQ：可混不同参照号一个柜，首单灵活；阶梯由销售确认。
- 认证：IATF 16949、E-mark、ISO 9001，可提供测试报告。
- 付款方式：常见 T/T 或即期 L/C；具体条款由销售确认。
- 交期：样品 5-7 天，大货 25-35 天。`,
  electronics: `品类：笔电/消费电子。常见问答：
- 产品：笔电、外设、适配器、IT 配件；支持 ODM/OEM 贴牌（logo、包装、定制）。
- 认证：CE、FCC、RoHS，按目的国准备文件。
- MOQ：现货 SKU 与 ODM 不同，由销售确认。
- 付款方式：常见 T/T 或 L/C；具体条款由销售确认。
- 交期：现货 7-15 天，ODM/定制按项目确认。`,
  machinery: `品类：通用机械/工业装备。常见问答：
- 范围：项目级、按规格匹配的机械与工业设备。
- 支持：备件清单、售后支持、安装/调试指导。
- 认证：CE、ISO 9001，全套出口文件，出口木箱包装。
- MOQ：通常按台/按项目，由销售确认。
- 付款方式：常见 T/T 或 L/C，里程碑条款由销售确认。
- 交期：按设备类型与产能确认。`
};

function autoReplyTemplate(prospect, intentKey) {
  const first = firstName(prospect);
  const product = state.campaign.product;
  const sender = state.campaign.senderName;
  const bodies = {
    price: `Hi ${first}, thanks for your interest in ${product}! Pricing depends on quantity and specifications, so I've flagged this to our sales colleague who will send you a detailed quotation shortly.`,
    sample: `Hi ${first}, happy to help with ${product} samples. I'll have our team prepare the catalog and sample policy; a sales colleague will follow up with the specifics.`,
    moq: `Hi ${first}, our MOQ for ${product} is flexible for a first order. Our sales colleague will confirm the exact tiers and pricing with you.`,
    leadtime: `Hi ${first}, typical lead time for ${product} is 25-35 days after order confirmation, and samples in 5-7 days. Our sales colleague will confirm the exact timing for your quantity.`,
    cert: `Hi ${first}, we can provide the relevant certificates and test reports for ${product}. Our sales colleague will attach the documents your market requires.`,
    other: `Hi ${first}, thanks for your reply. I've shared your message with our sales colleague, who will follow up with the details.`
  };
  // 品类专属答复（覆盖通用版；不承诺具体价格/账期）
  const catBodies = {
    moto: {
      moq: `Hi ${first}, MOQ is flexible for a first order — we can mix different models (CG125/150, GN125, CB, Bajaj/TVS-compatible, tricycle) and many item numbers in one 20'/40' container so you can test demand. Our sales colleague will confirm the exact tiers.`,
      cert: `Hi ${first}, we provide CCC, SONCAP and ISO 9001 plus test reports, and prepare the documents your market requires (e.g. SONCAP for Nigeria). Our sales colleague will attach what you need.`,
      leadtime: `Hi ${first}, samples take about 5-7 days and bulk 25-35 days after order confirmation. Our sales colleague will confirm timing for your model list and quantity.`,
      sample: `Hi ${first}, happy to help — I'll have our team prepare a fast-moving-parts catalog and sample policy covering your common models; a sales colleague will follow up with specifics.`
    },
    auto: {
      moq: `Hi ${first}, MOQ is flexible and we can mix different references in one container. Our sales colleague will confirm the exact tiers for your model coverage.`,
      cert: `Hi ${first}, we provide IATF 16949, E-mark and ISO 9001 with test reports, and can supply an OE cross-reference. Our sales colleague will attach the documents your market requires.`,
      leadtime: `Hi ${first}, samples take about 5-7 days and bulk 25-35 days after confirmation. Our sales colleague will confirm timing for your quantity.`,
      sample: `Hi ${first}, happy to help — our team will prepare a catalog of best-selling references with an OE cross-reference; a sales colleague will follow up with the specifics.`
    },
    electronics: {
      moq: `Hi ${first}, MOQ depends on whether it's a stock SKU or an ODM/private-label order. Our sales colleague will confirm the exact tiers for your configuration.`,
      cert: `Hi ${first}, our products are CE / FCC / RoHS ready and we prepare the documents your destination requires. Our sales colleague will attach the certificates you need.`,
      leadtime: `Hi ${first}, stock items ship in about 7-15 days; ODM/custom orders are confirmed per project. Our sales colleague will confirm the timing.`,
      sample: `Hi ${first}, happy to help — our team will prepare a product list with specs (and ODM options if you carry a private label); a sales colleague will follow up.`
    },
    machinery: {
      moq: `Hi ${first}, orders are typically per unit or per project. If you share the equipment type and capacity, our sales colleague will confirm the details.`,
      cert: `Hi ${first}, we provide CE and ISO 9001 with full export documents and proper export crating. Our sales colleague will attach the documents your project requires.`,
      leadtime: `Hi ${first}, lead time depends on equipment type and capacity. Share your specs and our sales colleague will confirm the timing and commissioning support.`,
      sample: `Hi ${first}, for equipment we prepare a spec sheet, spare-parts list and after-sales terms rather than a physical sample; a sales colleague will follow up with these.`
    }
  };
  const cat = catBodies[prospect.presetKey || state.campaign.presetKey] || {};
  const body = cat[intentKey] || bodies[intentKey] || bodies.other;
  return `${body}\n\nBest regards,\n${sender} (AI assistant)`;
}

async function generateAutoReply(prospect, customerText, intentKey) {
  if (aiEnabled()) {
    try {
      const system =
        "你是外贸售前 AI 助手，只负责答复标准售前问题。严格护栏：绝对不承诺任何具体价格、折扣、账期/付款条件或独家代理——这些必须留给销售同事。回复中要明确告知客户详细报价/条款将由销售同事跟进。基于提供的产品知识库作答。回复为英文、简洁、专业，含称呼与 AI 助手署名。";
      const categoryFaq = CATEGORY_KNOWLEDGE[prospect.presetKey || state.campaign.presetKey] || "";
      const userFaq = state.campaign.knowledgeBase || "";
      const combinedFaq = [categoryFaq, userFaq].filter(Boolean).join("\n\n") || "（未提供，用通用话术）";
      const user = `产品: ${state.campaign.product}
卖点: ${state.campaign.valueProps}
认证: ${state.campaign.certifications}
产品知识库/FAQ: ${combinedFaq}
署名: ${state.campaign.senderName}

客户来信: ${customerText}`;
      const text = await callAI(system, user, null, 700);
      if (text) return text.trim();
    } catch (error) {
      addLog(`Claude 自动应答失败，改用模板：${error.message}`);
    }
  }
  return autoReplyTemplate(prospect, intentKey);
}

function sendAutoReply(prospect, channel, text) {
  const item =
    channel === "whatsapp"
      ? {
          id: makeId("waq"),
          prospectId: prospect.id,
          company: prospect.company,
          phone: prospect.phone,
          label: "AI 初轮应答",
          message: text,
          dueDate: dateOffset(0),
          createdAt: new Date().toISOString(),
          status: "已发送",
          sentAt: new Date().toISOString(),
          delivered: true,
          step: `自动应答-${state.whatsappQueue.length}`,
          reply: true,
          autoReply: true,
          url: buildWhatsappUrl(prospect, text)
        }
      : {
          id: makeId("outbox"),
          prospectId: prospect.id,
          company: prospect.company,
          email: prospect.email,
          label: "AI 初轮应答",
          subject: `Re: ${state.campaign.product}`,
          body: text,
          dueDate: dateOffset(0),
          createdAt: new Date().toISOString(),
          status: "已发送",
          sentAt: new Date().toISOString(),
          delivered: true,
          step: `自动应答-${state.outbox.length}`,
          reply: true,
          autoReply: true
        };
  if (channel === "whatsapp") state.whatsappQueue.push(item);
  else state.outbox.push(item);
}

// 客户回复入站后的初轮处理：opt-out / 敏感转人工 / 标准自动答复
async function handleInboundAutoRespond(prospectId) {
  if (!state.agent?.autoRespond) return;
  const prospect = state.prospects.find((p) => p.id === prospectId);
  const message = [...state.inbound].reverse().find((m) => m.prospectId === prospectId);
  if (!prospect || !message || message.autoAction) return;

  const text = message.body;

  // 护栏 1：opt-out 即时生效（并进持久黑名单）
  if (isOptOut(text)) {
    markProspectOptOut(prospectId);
    const cancelled = cancelSequenceOnReply(prospectId);
    message.autoAction = { type: "optout" };
    addLog(`⛔ 客户 opt-out：${prospect.company} 已加入黑名单，停止全部触达（取消 ${cancelled} 条待发）`);
    saveState();
    render();
    return;
  }

  // 护栏 2：敏感话题一律转人工
  const sensitive = sensitiveTopic(text);
  if (sensitive) {
    message.autoAction = { type: "escalated", reason: sensitive };
    addLog(`🙋 敏感话题「${sensitive}」：AI 不擅自答复，已转人工接管：${prospect.company}`);
    saveState();
    render();
    return;
  }

  // 护栏 3：识别到高风险，AI 不擅自答复，立即转人工
  const risks = conversationRisks(prospectId);
  const highRisk = risks.find((r) => r.level === "high");
  if (highRisk) {
    message.autoAction = { type: "escalated", reason: `高风险·${highRisk.category}` };
    addLog(`⚠️ 高风险「${highRisk.category}」：AI 不擅自答复，已转人工接管：${prospect.company}`);
    saveState();
    render();
    return;
  }

  // 标准问题：自动答复（明确告知详细报价由销售跟进）
  const stored = getStoredAI(prospectId);
  const intentKey = stored ? stored.intent : classifyIntent(text).key;
  if (!AGENT_STANDARD_INTENTS.includes(intentKey)) {
    message.autoAction = { type: "escalated", reason: "需人工判断" };
    addLog(`🙋 无法确定为标准问题，转人工：${prospect.company}`);
    saveState();
    render();
    return;
  }

  const channel = message.channel || "email";
  if (channel === "email" && !prospect.email) return;
  if (channel === "whatsapp" && !prospect.phone) return;

  const reply = await generateAutoReply(prospect, text, intentKey);

  // 试运行闸门：未确认"直发"前，AI 应答一律存草稿等人工审批——信任是挣来的，不是默认的
  if (!state.agent.autoRespondLive) {
    if (channel === "whatsapp") {
      state.whatsappQueue.push({
        id: makeId("waq"),
        prospectId: prospect.id,
        company: prospect.company,
        phone: prospect.phone,
        label: "AI 应答草稿",
        message: reply,
        dueDate: dateOffset(0),
        createdAt: new Date().toISOString(),
        status: "待人工确认",
        step: `AI应答草稿-${state.whatsappQueue.length}`,
        reply: true,
        autoReply: true,
        url: buildWhatsappUrl(prospect, reply)
      });
    } else {
      state.outbox.push({
        id: makeId("outbox"),
        prospectId: prospect.id,
        company: prospect.company,
        email: prospect.email,
        label: "AI 应答草稿",
        subject: `Re: ${state.campaign.product}`,
        body: reply,
        dueDate: dateOffset(0),
        createdAt: new Date().toISOString(),
        status: "待审批",
        step: `AI应答草稿-${state.outbox.length}`,
        reply: true,
        autoReply: true
      });
    }
    message.autoAction = { type: "drafted", intent: intentKey };
    addLog(`📝 试运行模式：AI 已为 ${prospect.company} 起草应答（${intentKey}），去「队列」审批后发送；答得稳了可在 Agent 面板切换为直发`);
    saveState();
    render();
    return;
  }

  sendAutoReply(prospect, channel, reply);
  message.autoAction = { type: "replied", intent: intentKey };
  addLog(`🤖 AI 初轮自动应答（${channel === "whatsapp" ? "WhatsApp" : "邮件"}·${intentKey}）：${prospect.company}`);
  saveState();
  render();
}

function renderAgentTaskCard() {
  const card = elements.agentTaskCard;
  const task = state.agent.task;
  if (!task) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const parsed = task.parsed;
  const sourceTag = task.source === "claude" ? "Claude 解析" : "本地规则解析";

  if (task.status !== "draft") {
    const modeLabel = { review: "逐条审批", spot: "批量审批", auto: "批量审批" }[task.approvalMode] || "逐条审批";
    const rec = agentRecurring();
    const intervalOptions = [
      ["daily", "每天"],
      ["weekly", "每周"],
      ["monthly", "每月"]
    ]
      .map(([v, l]) => `<option value="${v}" ${rec.interval === v ? "selected" : ""}>${l}</option>`)
      .join("");
    const cycleStatus = rec.enabled
      ? `已执行 ${rec.cyclesRun || 0} 轮 · ${rec.lastRunAt ? `上次 ${new Date(rec.lastRunAt).toLocaleDateString("zh-CN")}` : "尚未执行"}${agentCycleDue() ? " · 本周期待执行" : ""}`
      : "未开启";
    card.innerHTML = `
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Task running</p>
          <h2>任务运行中</h2>
        </div>
        <span class="status-pill">${modeLabel} · ${task.startedAt}</span>
      </div>
      <p class="ai-summary">${escapeHtml(parsed.summary || task.prompt)}</p>
      <div class="conversation-meta">
        <span class="badge">${escapeHtml(parsed.product)}</span>
        ${parsed.markets.map((m) => `<span class="tag">${escapeHtml(m)}</span>`).join("")}
        <span class="tag">日上限 ${parsed.daily_limit}</span>
        ${parsed.use_email ? `<span class="channel-badge email">邮件</span>` : ""}
        ${parsed.use_whatsapp ? `<span class="channel-badge whatsapp">WhatsApp</span>` : ""}
      </div>
      <div class="agent-recurring">
        <label class="toggle-row"><input id="agentRecurEnabled" type="checkbox" ${rec.enabled ? "checked" : ""} /><span>周期自动补量</span></label>
        <label class="inline-field"><span>频率</span><select id="agentRecurInterval">${intervalOptions}</select></label>
        <label class="inline-field"><span>每轮线索数</span><input id="agentRecurPer" type="number" min="1" max="200" value="${rec.perCycle}" /></label>
        <label class="toggle-row" title="开启后每到周期用 Claude 联网找真实客户（需配置 AI 引擎），否则用演示生成器/采集 Webhook"><input id="agentRecurWebSearch" type="checkbox" ${rec.useWebSearch ? "checked" : ""} /><span>联网找真实客户</span></label>
        <button class="ghost-button" id="agentRunCycleNow" type="button"><svg><use href="#icon-play" /></svg><span>立即补充一批</span></button>
        <span class="webhook-status ${rec.enabled ? "ok" : ""}">${cycleStatus}</span>
      </div>
      <p class="connector-hint">周期补量：开启后自动驾驶每到周期自动补充新线索走一遍漏斗（浏览器演示用生成器模拟；真实部署走搜索采集 Webhook + 外部 cron 调度）。</p>
    `;
    return;
  }

  const typeOptions = [
    ["importer distributor", "进口商 / 经销商"],
    ["retailer chain buyer", "零售连锁 / 采购"],
    ["brand private label", "品牌商 / 贴牌"],
    ["wholesaler", "批发商"],
    ["contractor project buyer", "工程商 / 项目采购"]
  ]
    .map(([v, l]) => `<option value="${v}" ${parsed.customer_type === v ? "selected" : ""}>${l}</option>`)
    .join("");

  card.innerHTML = `
    <div class="panel-heading">
      <div>
        <p class="eyebrow">Step 2 · 任务卡片</p>
        <h2>确认解析结果后启动</h2>
      </div>
      <span class="tag">${sourceTag}</span>
    </div>
    <p class="ai-summary">${escapeHtml(parsed.summary || task.prompt)}</p>
    <div class="form-grid">
      <label><span>产品 / 行业</span><input id="agentFProduct" value="${escapeHtml(parsed.product)}" /></label>
      <label><span>目标市场（逗号分隔）</span><input id="agentFMarkets" value="${escapeHtml(parsed.markets.join(", "))}" /></label>
      <label><span>客户类型</span><select id="agentFType">${typeOptions}</select></label>
      <label><span>每日触达上限</span><input id="agentFLimit" type="number" min="1" max="300" value="${parsed.daily_limit}" /></label>
    </div>
    <label><span>搜索关键词（AI 已扩展同义词）</span><input id="agentFKeywords" value="${escapeHtml(parsed.keywords.join(", "))}" /></label>
    <div class="form-grid">
      <label><span>规模条件</span><input value="${escapeHtml(parsed.size_note || "未指定")}" disabled /></label>
      <label><span>排除条件</span><input value="${escapeHtml(parsed.exclusion_note || "CRM 已有客户自动去重")}" disabled /></label>
    </div>
    <div class="agent-mode-row">
      <div class="agent-channels">
        <label class="toggle-row"><input id="agentFEmail" type="checkbox" ${parsed.use_email ? "checked" : ""} /><span>邮件触达</span></label>
        <label class="toggle-row"><input id="agentFWa" type="checkbox" ${parsed.use_whatsapp ? "checked" : ""} /><span>WhatsApp 接力</span></label>
      </div>
      <div class="segmented" role="group" aria-label="审批模式">
        <button class="segment ${task.approvalMode === "review" ? "is-active" : ""}" data-approval-mode="review" type="button" title="逐个查看并发送（推荐冷启动）">逐条审批</button>
        <button class="segment ${task.approvalMode === "spot" ? "is-active" : ""}" data-approval-mode="spot" type="button" title="一次审查一批后批量通过并发送首触">批量审批</button>
      </div>
    </div>
    <p class="connector-hint">发送始终需人工审批：Agent 自动找客户、补全联系方式、验证评分并生成触达方案，你审批通过后才发出。</p>
    <div class="button-row">
      <button class="primary-button" data-agent-action="confirm" type="button"><svg><use href="#icon-rocket" /></svg><span>确认并启动</span></button>
      <button class="ghost-button" data-agent-action="discard" type="button">重新解析</button>
    </div>
  `;
}

function renderAgentSteps() {
  const task = state.agent.task;
  const approvals = state.agent.approvals;
  const { hot } = agentHandoffData();
  const sent = state.outbox.filter((o) => o.status === "已发送").length;
  const approvedCount = approvals.filter((a) => a.status === "approved").length;
  const steps = [
    ["任务解析", !!task, task ? (task.source === "claude" ? "Claude" : "本地规则") : "待下达"],
    ["自动寻客", (task?.funnel.raw || 0) > 0, task ? `${task.funnel.raw} 条原始线索` : "—"],
    ["触达审批", approvals.length > 0 && !approvals.some((a) => a.status === "pending"), `${approvedCount}/${approvals.length} 已批准`],
    ["自动开发", sent > 0, `${sent} 次已发送`],
    ["意向移交", hot.length > 0, `${hot.length} 个热意向`]
  ];
  elements.agentSteps.innerHTML = steps
    .map(
      ([name, done, hint], index) => `
        <div class="workflow-step ${done ? "" : "is-waiting"}">
          <span class="step-index">${index + 1}</span>
          <div><strong>${name}</strong><span>${hint}</span></div>
          <span class="status-pill">${done ? "完成" : "等待"}</span>
        </div>
      `
    )
    .join("");
}

function renderAgentFunnel() {
  const task = state.agent.task;
  if (!task || !task.funnel.raw) {
    elements.agentFunnel.innerHTML = `<div class="empty-state">启动任务并导入线索后，这里展示 抓取→匹配→验证→评分 漏斗</div>`;
    elements.agentFunnelHint.textContent = "";
    return;
  }
  const f = task.funnel;
  const rows = [
    ["原始抓取", f.raw],
    ["画像匹配", f.matched],
    ["验证通过", f.verified],
    ["去重后", f.deduped],
    ["高分入围", f.scored]
  ];
  const top = Math.max(1, f.raw);
  elements.agentFunnel.innerHTML = rows
    .map(
      ([label, count]) => `
        <div class="funnel-row">
          <span>${label}</span>
          <div class="funnel-bar"><span style="width:${Math.max(3, Math.round((count / top) * 100))}%"></span></div>
          <span class="funnel-figure"><strong>${count}</strong></span>
        </div>
      `
    )
    .join("");
  elements.agentFunnelHint.textContent = `按「验证通过的有效线索」计量：${f.raw} 条原始 → ${f.scored} 条高分入围（评分阈值动态，日上限 ${task.parsed.daily_limit}）`;
}

function renderAgentApprovals() {
  const task = state.agent.task;
  const approvals = state.agent.approvals;
  const pending = approvals.filter((a) => a.status === "pending");
  elements.agentApprovalPanel.hidden = !task || approvals.length === 0;
  elements.agentApproveAll.hidden = pending.length === 0;
  if (elements.agentApprovalPanel.hidden) {
    elements.agentApprovalList.innerHTML = "";
    return;
  }

  elements.agentApprovalList.innerHTML = approvals
    .map((approval) => {
      const prospect = state.prospects.find((p) => p.id === approval.prospectId);
      if (!prospect) return "";
      const score = computeLeadScore(prospect);
      const email = buildEmailSequence(state.campaign, prospect)[0];
      const wa = buildWhatsappSequence(state.campaign, prospect)[0];
      const topFactors = score.factors.filter((fa) => fa.points > 0).slice(0, 3).map((fa) => fa.label).join(" · ");
      const statusBadge =
        approval.status === "approved"
          ? `<span class="status-pill">已批准发送</span>`
          : approval.status === "skipped"
            ? `<span class="tag">已跳过</span>`
            : `<span class="due-tag unplanned">待审批</span>`;
      const actions =
        approval.status === "pending"
          ? `<div class="ai-actions">
              <button class="primary-button" data-agent-approve="${approval.id}" type="button"><svg><use href="#icon-check" /></svg><span>通过并发送</span></button>
              <button class="ghost-button" data-agent-skip="${approval.id}" type="button">跳过</button>
            </div>`
          : "";
      return `
        <article class="agent-approval-card">
          <div class="crm-card-top">
            <strong>${escapeHtml(prospect.company)}</strong>
            <span><span class="prob-grade grade-${score.grade}">${score.grade}</span><span class="score">${score.probability}%</span></span>
          </div>
          <div class="crm-card-meta">
            <span>${escapeHtml(prospect.market)} · ${escapeHtml(prospect.contactName)} · ${escapeHtml(prospect.email || "")}</span>
          </div>
          <p class="approval-why">为什么值得开发：${escapeHtml(topFactors || "画像匹配")}</p>
          <div class="approval-previews">
            <div class="approval-preview"><span class="channel-badge email">邮件首触</span><strong>${escapeHtml(email?.subject || "")}</strong><p>${escapeHtml((email?.body || "").slice(0, 150))}…</p></div>
            ${task.parsed.use_whatsapp && prospect.phone ? `<div class="approval-preview"><span class="channel-badge whatsapp">WhatsApp</span><p>${escapeHtml((wa?.message || "").slice(0, 130))}…</p></div>` : ""}
          </div>
          ${statusBadge}
          ${actions}
        </article>
      `;
    })
    .join("");
}

function renderAgentHandoff() {
  const { hot, warm, rejected, silent } = agentHandoffData();
  const insight = computeAgentInsight();
  const hotHtml = hot.length
    ? hot
        .map(({ c, label, summary }) => {
          const risks = conversationRisks(c.prospectId);
          const riskBadge = risks.length
            ? `<span class="intent-tag ${riskLevelTone(highestRiskLevel(risks))}">⚠️ ${risks.length} 项风险</span>`
            : "";
          const riskLine = risks.length
            ? `<p class="approval-why risk-line">风险：${risks.map((r) => escapeHtml(r.category)).join("、")}——${escapeHtml(risks[0].action)}</p>`
            : "";
          return `
            <article class="agent-hot-card">
              <div class="crm-card-top">
                <strong>🔥 ${escapeHtml(c.company)}</strong>
                <span class="agent-hot-badges"><span class="intent-tag red">${escapeHtml(label)}</span>${riskBadge}</span>
              </div>
              <p class="approval-why">${escapeHtml(summary || summarizeConversation(c))}</p>
              ${riskLine}
              <div class="ai-actions">
                <button class="primary-button" data-agent-takeover="${c.prospectId}" type="button"><svg><use href="#icon-inbox" /></svg><span>接管会话</span></button>
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="empty-state">暂无热意向。客户回复询价/要样/问交期或触发风险时会出现在这里并推送接管</div>`;
  const warmHtml = warm.length
    ? warm.map(({ c, label }) => `<span class="tag">🌤 ${escapeHtml(c.company)} · ${escapeHtml(label)}</span>`).join("")
    : `<span class="tag">暂无</span>`;

  elements.agentHandoff.innerHTML = `
    <div class="handoff-tier"><p class="eyebrow">🔥 热意向 · 立即接管</p>${hotHtml}</div>
    <div class="handoff-tier"><p class="eyebrow">🌤 温 · 进入培育（回复但未询价）</p><div class="conversation-meta">${warmHtml}</div></div>
    <div class="handoff-tier"><p class="eyebrow">❄️ 冷</p><div class="conversation-meta"><span class="tag">已读不回 ${silent} 家（30 天后换角度再触达）</span><span class="tag">明确拒绝 ${rejected.length} 家（进黑名单）</span></div></div>
    ${insight ? `<div class="impact-lift">${escapeHtml(insight)}</div>` : ""}
  `;
}

function renderAgentDevelop() {
  elements.agentAutoRespond.checked = !!state.agent.autoRespond;
  if (elements.agentRespondLive) elements.agentRespondLive.checked = !!state.agent.autoRespondLive;
  if (document.activeElement !== elements.agentKnowledgeBase) {
    elements.agentKnowledgeBase.value = state.campaign.knowledgeBase || "";
  }

  const actions = state.inbound
    .filter((m) => m.autoAction)
    .slice(-8)
    .reverse();
  if (!actions.length) {
    elements.agentAutoLog.innerHTML = state.agent.autoRespond
      ? `<div class="empty-state">已开启。客户回复标准问题时自动应答，敏感话题转人工——动作会留痕在这里</div>`
      : "";
    return;
  }
  elements.agentAutoLog.innerHTML = `
    <p class="eyebrow">初轮应答留痕</p>
    ${actions
      .map((m) => {
        const meta =
          m.autoAction.type === "replied"
            ? `<span class="channel-badge whatsapp">已自动答复</span><span class="tag">${escapeHtml(m.autoAction.intent || "")}</span>`
            : m.autoAction.type === "escalated"
              ? `<span class="intent-tag red">转人工</span><span class="tag">${escapeHtml(m.autoAction.reason || "")}</span>`
              : `<span class="intent-tag red">opt-out 黑名单</span>`;
        return `<div class="auto-log-row"><strong>${escapeHtml(m.company)}</strong>${meta}<span class="tl-meta">${escapeHtml(m.time)}</span></div>`;
      })
      .join("")}
  `;
}

function renderAgent() {
  if (!elements.agentTaskCard) return;
  elements.agentEngineTag.textContent = aiEnabled() ? `Claude 解析 · ${state.settings.aiModel}` : "本地规则解析";
  renderAgentTaskCard();
  renderAgentSteps();
  renderAgentFunnel();
  renderAgentApprovals();
  renderAgentDevelop();
  renderAgentHandoff();
}

function normalizeRemoteProspects(items) {
  return items.map((item, index) => ({
    id: item.id || makeId("prospect"),
    company: item.company || item.name || `Imported Prospect ${index + 1}`,
    market: item.market || normalizeMarkets(state.campaign.markets)[0],
    source: item.source || "Webhook",
    website: stripProtocol(item.website || item.domain || ""),
    contactName: item.contactName || item.contact || "待补全",
    role: item.role || "Sourcing Manager",
    email: item.email || "",
    emailStatus: item.email ? "待验证" : "待查找",
    phone: item.phone || item.whatsapp || "",
    phoneStatus: item.phone || item.whatsapp ? "待人工确认" : "待查找",
    status: item.email ? "已丰富" : "新发现",
    score: Number(item.score) || 72,
    confidence: Number(item.confidence) || 60,
    buyingSignal: item.buyingSignal || `${state.campaign.product} potential buyer`,
    companySize: item.companySize || "未知",
    searchQuery: item.searchQuery || ""
  }));
}

function inCooldown(prospect) {
  const days = state.management.rules.cooldownDays || 0;
  if (!days || !prospect.lastQueuedAt) return false;
  return Date.now() - new Date(prospect.lastQueuedAt).getTime() < days * 86400000;
}

function queueTopProspects() {
  const limit = Math.min(state.campaign.dailyLimit, state.management.rules.emailDailyLimit, 10);
  const candidates = [...activeProspects()]
    .map((item) => ({ item, lead: computeLeadScore(item) }))
    .filter(
      ({ item, lead }) =>
        item.email &&
        item.status !== "已入队" &&
        item.status !== "已回复" &&
        lead.probability >= state.management.rules.scoreThreshold &&
        !inCooldown(item)
    )
    .sort((a, b) => b.lead.probability - a.lead.probability)
    .slice(0, limit);

  candidates.forEach(({ item }) => queueProspect(item, false));
  if (candidates.length) addLog(`${candidates.length} 个高分潜客已加入待审批发信队列`);
}

// 一键起量：联网找客户 → 批量补全 → 质量分入队 → 生成待审批邮件，停在批量审批
async function runOneClickPipeline() {
  if (!requireCampaignBrief("一键起量")) return;
  runBegin("一键起量", "准备中…");
  readCampaignFromForm();
  const useAI = aiEnabled();
  // 步骤进度同时打在按钮上和顶部状态条上，不用去日志里翻
  const stepText = (t) => {
    const s = elements.oneClickPipeline?.querySelector("span");
    if (s) s.textContent = t;
    runStep(t);
  };

  // ⓪ 填了具体产品但还没细化过 → 先自动细化定位，让后面每一步都围绕这个具体产品
  if (useAI && state.campaign.focusProduct && (state.campaign.productTerms || []).length <= 1) {
    stepText("⓪ 细化产品定位…");
    addLog(`一键起量 ⓪：先细化「${state.campaign.focusProduct}」的产品定位…`);
    renderLogs();
    await refineProductFocus();
  }
  // 人工闸门：AI 细化出的英文术语先让你确认一次（定位错整条链全歪）；同一产品确认过就不再问
  if (
    state.campaign.focusProduct &&
    (state.campaign.productTerms || []).length > 1 &&
    state.campaign.focusConfirmed !== state.campaign.focusProduct
  ) {
    const terms = state.campaign.productTerms;
    const prof = state.campaign.productProfile || {};
    const segLine = prof.segments?.length ? `\n买家段：${prof.segments.map((s) => s.name).join("、")}` : "";
    const exLine = prof.excludeTerms?.length ? `\n排除非买家：${prof.excludeTerms.join("、")}` : "";
    const ok = window.confirm(
      `AI 定位结果，请确认后继续起量：\n\n产品术语：${state.campaign.product}\n同义词：${terms.slice(1).join("、") || "无"}\nHS 编码：${state.campaign.hsCode || "—"}\n目标买家：${state.campaign.buyerHint || "—"}${segLine}${exLine}\n\n（搜索按买家段+用途撒网，质量分按产品契合度打分）\n\n【确定】= 用这个定位找客户\n【取消】= 停止起量，先手动修改「具体产品聚焦」或产品字段`
    );
    if (!ok) {
      addLog("已取消起量：请修改「具体产品聚焦」后重试（术语不对会导致整批找错客户）");
      runAbort("你取消了定位确认——改好「具体产品聚焦」再起量", { label: "去改产品定位", view: "dashboard" });
      saveState();
      render();
      return;
    }
    state.campaign.focusConfirmed = state.campaign.focusProduct;
  }

  // ① 找客户
  stepText("①/④ 联网找客户…");
  addLog("一键起量 ①/④：正在找客户…");
  renderLogs();
  let found = 0;
  takeLeadFailure(); // 清掉上一轮遗留的失败原因，免得这轮报错报串
  // 第一档：Claude 内置联网搜索
  if (useAI && aiWebSearchCapable()) {
    found = await webSearchProspects({ count: 15 });
  }
  // 第二档：SerpAPI 直连 / 搜索 Webhook。
  // Claude 联网这条路很容易断（中转站基本不转发服务端联网工具、服务商不是 Claude），
  // 而 SerpAPI 走的是独立接口、限制不到它——有就该用，不该让整条流水线卡死。
  if (!found && remoteSearchReady()) {
    stepText("①/④ 改用搜索接口找客户…");
    state.searchPlan = generateSearchPlan(state.campaign);
    const remote = await trySearchWebhook();
    if (remote?.length) {
      const admitted = admitProspects(remote, "搜索采集");
      state.prospects = [...admitted, ...state.prospects];
      agentOnProspectsImported(admitted);
      found = admitted.length;
      addLog(`一键起量：改用搜索接口找到 ${found} 家公司`);
    } else {
      // 搜索接口自己会把具体原因写进日志，这里只负责把「该去哪」补上
      noteLeadFailure("搜索接口这一轮没返回可用公司（换更具体的搜索式再试）", {
        label: "去调搜索式",
        view: "discovery"
      });
    }
  }
  // 第三档：一个真实来源都没配，才铺演示数据让新手跑通全流程。
  // 配了真实来源却失败时不能悄悄换成假数据——那会让人误以为找到了真客户。
  if (!found && !aiWebSearchCapable() && !remoteSearchReady()) {
    const generated = generateProspects(state.campaign, 15, `Kick${state.prospects.length}`);
    const seen = new Set(state.prospects.map((p) => p.website || p.company.toLowerCase()));
    const fresh = generated.filter((g) => {
      const key = g.website || g.company.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const admitted = admitProspects(fresh, "一键起量");
    state.prospects = [...admitted, ...state.prospects];
    agentOnProspectsImported(admitted);
    found = admitted.length;
    addLog(
      `一键起量：还没配任何真实找客来源（Claude 联网 / SerpAPI 直连），已用演示数据铺 ${found} 家线索跑通流程——这些是假公司，别当真客户发`
    );
  }
  if (!found && !activeProspects().length) {
    // 归零的真实原因由找客户环节记下来，不要一律甩「去配置 Claude」——用户可能早就配好了
    const failure = takeLeadFailure();
    const reason = failure?.reason || "这一轮没找到任何新公司";
    addLog(`一键起量中止：${reason}。可改用「潜客」页粘贴导入真实搜索结果`);
    runAbort(reason, failure?.action || { label: "去粘贴导入线索", view: "discovery" }, "一键起量");
    saveState();
    render();
    return;
  }

  // ② 批量补全联系方式 + 验证邮箱
  stepText("②/④ 补全联系方式…");
  addLog("一键起量 ②/④：批量补全联系方式…");
  renderLogs();
  await bulkEnrichContacts((done, total) => stepText(`②/④ 补全联系方式 ${done}/${total}…`));
  replaceProspectsById(verifyProspectList(activeProspects(), state.campaign));

  // ③ 生成待审批：给有联系方式、未退订、未入队的线索按质量分排序排首触（冷启动取质量最高的一批）
  stepText("③/④ 生成待审批邮件…");
  addLog("一键起量 ③/④：按质量分排序生成待审批邮件…");
  renderLogs();
  const cap = Math.min(state.campaign.dailyLimit || 20, 25);
  const candidates = activeProspects()
    .filter((p) => !p.optOut && !["已入队", "已回复"].includes(p.status) && emailLooksValid(p.email))
    .sort((a, b) => computeLeadScore(b).probability - computeLeadScore(a).probability)
    .slice(0, cap);
  candidates.forEach((p) => queueProspect(p, false));
  const queued = candidates.length;

  // ④ 停在批量审批
  if (queued > 0) {
    const candidateIds = new Set(candidates.map((p) => p.id));
    const queuedItems = state.outbox.filter((item) => candidateIds.has(item.prospectId) && ["待审批", "待发送"].includes(item.status));
    const sendable = queuedItems.filter((item) => preflightOutboxItem(item).ok).length;
    if (!sendable && queuedItems.length) {
      navigateTo("prospects");
      if (elements.verifyFilter) elements.verifyFilter.value = "guessed";
      addLog(`一键起量 ④/④：已生成 ${queued} 封草稿，但邮箱都还没真实验证。先在潜客页点「批量验证」，通过后再审批发送`);
      runDone(`${queued} 封草稿已生成，但邮箱都还没验证过，验证通过才能发`, { label: "去批量验证", view: "prospects" });
    } else {
      navigateTo("automation");
      addLog(`一键起量 ④/④：已生成 ${queued} 封待审批邮件，请在此逐封预检后「批量审批发送」（发送始终等你过目）`);
      runDone(`${queued} 封邮件待审批（还没发出去，等你逐封过目）`, { label: "去审批发送", view: "automation" });
    }
  } else {
    navigateTo("prospects");
    addLog("一键起量 ④/④：线索已入池，但都还缺可用邮箱；请先『批量补全联系方式』或接入邮箱查找 Webhook 后再入队");
    runDone("线索已入池，但都还没有可用邮箱，补全联系方式后才能入队", { label: "去补全联系方式", view: "prospects" });
  }
  saveState();
  render();
}

// 质量分 A/B 级、可入队（未退订/未入队/未回复/不在冷却）的优质客户
function isQualityQueueable(p) {
  if (p.optOut) return false;
  // AI 判定不对口的（信息平台、目录站、同行等）不进批量入队与自动驾驶。
  // 用户仍可在潜客详情里单独入队——判断权在人，但默认不替他做这个决定。
  if (p.offTarget) return false;
  if (["已入队", "已回复"].includes(p.status)) return false;
  if (inCooldown(p)) return false;
  return ["A", "B"].includes(computeLeadScore(p).grade);
}

// 一键把优质客户（质量分 A/B 级）批量加入触达队列——首触待人工审批发送
function queueQualityLeads() {
  const eligible = activeProspects().filter(isQualityQueueable);
  if (!eligible.length) {
    addLog("暂无 A/B 级优质客户可入队（可先『批量补全联系方式』提升质量分，或先触达积累互动信号）");
    saveState();
    render();
    return 0;
  }
  // 高分优先入队
  const ordered = [...eligible].sort((a, b) => computeLeadScore(b).probability - computeLeadScore(a).probability);
  let gradeA = 0;
  ordered.forEach((p) => {
    if (computeLeadScore(p).grade === "A") gradeA += 1;
    queueProspect(p, false);
  });
  addLog(`已把 ${ordered.length} 家优质客户加入触达队列（A 级 ${gradeA} · B 级 ${ordered.length - gradeA}），首封待你在「队列/邮件」审批发送`);
  saveState();
  render();
  return ordered.length;
}

// 该跟进的客户：已发过至少一封、超过跟进间隔仍未回复、未退订、当前没有待发邮件
function dueFollowupProspects() {
  const followupDays = state.management?.rules?.followupDays || 3;
  return activeProspects().filter((p) => {
    if (p.optOut) return false;
    if (p.status === "已回复" || axReplied(p)) return false;
    const mine = state.outbox.filter((o) => o.prospectId === p.id);
    const sent = mine.filter((o) => o.status === "已发送");
    if (!sent.length) return false; // 还没发过首封，交给一键起量/入队
    if (mine.some((o) => ["待发送", "待审批"].includes(o.status))) return false; // 已有待发的后续
    const lastSentMs = Math.max(...sent.map((o) => toTime(o.sentAt || o.createdAt)));
    if (daysSinceMs(lastSentMs) < followupDays) return false;
    // 序列里还有没发过的后续邮件
    const seq = buildEmailSequence(state.campaign, p);
    return seq.some((e) => !mine.some((o) => (o.step || o.label) === e.label));
  });
}

// 一键批量跟进：给到期未回复的客户排下一封跟进邮件（待审批发送）
function queueDueFollowups() {
  const due = dueFollowupProspects();
  if (!due.length) {
    addLog("暂无到期该跟进的客户（需已发过首封、超过跟进间隔且仍未回复）");
    saveState();
    render();
    return 0;
  }
  const today = dateOffset(0);
  const companies = [];
  due.forEach((p) => {
    const mine = state.outbox.filter((o) => o.prospectId === p.id);
    const seq = buildEmailSequence(state.campaign, p);
    const next = seq.find((e) => !mine.some((o) => (o.step || o.label) === e.label));
    if (!next) return;
    state.outbox.push({
      id: makeId("outbox"),
      prospectId: p.id,
      company: p.company,
      email: p.email,
      label: next.label,
      subject: next.subject,
      body: next.body,
      dueDate: today,
      createdAt: new Date().toISOString(),
      status: "待审批",
      step: next.label
    });
    companies.push(p.company);
  });
  addLog(
    `已为 ${companies.length} 位到期未回复客户排下一封跟进（待你审批发送）：${companies.slice(0, 3).join("、")}${companies.length > 3 ? " 等" : ""}`
  );
  navigateTo("automation");
  saveState();
  render();
  return companies.length;
}

function queueTopWhatsappProspects() {
  const limit = Math.min(state.campaign.dailyLimit, state.management.rules.whatsappDailyLimit, 8);
  const candidates = [...activeProspects()]
    .map((item) => ({ item, lead: computeLeadScore(item) }))
    .filter(
      ({ item, lead }) =>
        item.phone &&
        item.status !== "已回复" &&
        lead.probability >= state.management.rules.scoreThreshold &&
        !inCooldown(item) &&
        !state.whatsappQueue.some((queued) => queued.prospectId === item.id)
    )
    .sort((a, b) => b.lead.probability - a.lead.probability)
    .slice(0, limit);

  candidates.forEach(({ item }) => queueWhatsappProspect(item, false));
  if (candidates.length) addLog(`${candidates.length} 个高分潜客加入 WhatsApp 待确认队列`);
}

function queueProspect(prospect, includeFullSequence = true) {
  if (prospect.optOut || isBlacklisted(prospect)) return;
  if (!prospect.email) {
    prospect = verifyProspectList(enrichProspectList([prospect], state.campaign), state.campaign)[0];
    state.prospects = state.prospects.map((item) => (item.id === prospect.id ? prospect : item));
  }

  const sequence = buildEmailSequence(state.campaign, prospect);
  const items = includeFullSequence ? sequence : sequence.slice(0, 1);
  items.forEach((email) => {
    const exists = state.outbox.some((item) => item.prospectId === prospect.id && item.step === email.label);
    if (exists) return;
    state.outbox.push({
      id: makeId("outbox"),
      prospectId: prospect.id,
      company: prospect.company,
      email: prospect.email,
      label: email.label,
      subject: email.subject,
      subjectVariant: email.subjectVariant || null, // 只有首封有，用于主题行 A/B 统计
      body: email.body,
      dueDate: dateOffset(email.dayOffset),
      status: "待审批",
      step: email.label
    });
  });

  state.prospects = state.prospects.map((item) =>
    item.id === prospect.id ? { ...item, status: "已入队", lastQueuedAt: new Date().toISOString() } : item
  );

  // 协同模式：邮件排好的同时，把"提醒查收邮件"的 WhatsApp 一并排上（晚 N 天）。
  // 仍过市场判定与冷发确认；客户从任一渠道回复，两边都会停。
  queueParallelWhatsapp(prospect, sequence[0]);
}

// 协同并行的 WhatsApp：只在协同模式、有号码、且该市场适合 WhatsApp 时排一条
function queueParallelWhatsapp(prospect, firstEmail) {
  if (state.relay?.mode !== "parallel" || !firstEmail) return;
  if (!prospect.phone || prospect.optOut || isBlacklisted(prospect)) return;
  if (!whatsappFitsMarket(prospect.market)) return;
  if (isTrialLocked(prospect)) return;
  const exists = state.whatsappQueue.some((item) => item.prospectId === prospect.id && item.step === "邮件跟进");
  if (exists) return;

  const msg = buildWhatsappEmailAssist(state.campaign, prospect, firstEmail.subject, dateOffset(0));
  state.whatsappQueue.push({
    id: makeId("wa"),
    prospectId: prospect.id,
    company: prospect.company,
    phone: prospect.phone,
    label: msg.label,
    step: msg.label,
    stage: msg.stage,
    message: msg.message,
    dueDate: dateOffset(msg.dayOffset),
    // 协同这条永远要人工确认：它是冷发，且和邮件叠加，风险比单发高
    status: "待人工确认",
    createdAt: new Date().toISOString()
  });
}

// 同一市场只提示一次，别把运行日志刷满
const mkdWaMarketNoticed = new Set();

// force：用户在潜客详情里手动点的，允许越过市场判定（他比表更懂这单客户）；
// 自动路径（一键起量、Agent、自动驾驶）一律不 force，免得给美国客户发 WhatsApp。
function queueWhatsappProspect(prospect, includeFullSequence = true, force = false) {
  if (prospect.optOut || isBlacklisted(prospect)) return;
  if (!force && !whatsappFitsMarket(prospect.market)) {
    const conf = marketChannel(prospect.market);
    if (!mkdWaMarketNoticed.has(prospect.market)) {
      mkdWaMarketNoticed.add(prospect.market);
      addLog(`${prospect.market} 未自动排 WhatsApp：${conf.note}。该市场建议走${conf.primary}。`, { toast: false });
    }
    return;
  }
  if (!prospect.phone) {
    prospect = verifyProspectList(enrichProspectList([prospect], state.campaign), state.campaign)[0];
    state.prospects = state.prospects.map((item) => (item.id === prospect.id ? prospect : item));
  }

  const sequence = buildWhatsappSequence(state.campaign, prospect);
  const items = includeFullSequence ? sequence : sequence.slice(0, 1);
  const status = state.management.rules.requireWhatsappApproval ? "待人工确认" : "已审批";
  items.forEach((message) => {
    const exists = state.whatsappQueue.some(
      (item) => item.prospectId === prospect.id && item.step === message.label
    );
    if (exists) return;
    state.whatsappQueue.push({
      id: makeId("waq"),
      prospectId: prospect.id,
      company: prospect.company,
      phone: prospect.phone,
      label: message.label,
      message: message.message,
      dueDate: dateOffset(message.dayOffset),
      status,
      step: message.label,
      url: buildWhatsappUrl(prospect, message.message)
    });
  });
  state.prospects = state.prospects.map((item) =>
    item.id === prospect.id ? { ...item, lastQueuedAt: new Date().toISOString() } : item
  );
}

function scheduleFollowupTasks(showLog = true) {
  const prospects = activeProspects().filter((item) => item.email);
  let created = 0;
  prospects.forEach((prospect) => {
    [
      ["二次跟进", 3],
      ["发送样品/案例", 7],
      ["最后触达", 14]
    ].forEach(([type, offset]) => {
      const exists = state.tasks.some((task) => task.prospectId === prospect.id && task.type === type);
      if (exists) return;
      state.tasks.push({
        id: makeId("task"),
        prospectId: prospect.id,
        company: prospect.company,
        title: `${type}：${prospect.company}`,
        dueDate: dateOffset(offset),
        type
      });
      created += 1;
    });
  });
  if (showLog) addLog(`生成 ${created} 个跟进任务`);
}

function deliverEmail(item) {
  item.status = "已发送";
  item.sentAt = new Date().toISOString();
  const h = hashInt(item.prospectId + item.step);
  item.delivered = h % 100 < 95;
  const prospect = state.prospects.find((p) => p.id === item.prospectId);
  item.opened = item.delivered && (h >> 3) % 100 < Math.min(88, 38 + Math.round((prospect?.score || 60) * 0.5));
  advanceDealStage(item.prospectId, "已触达");
}

async function simulateSendNext() {
  const ready = activeOutboxItems().filter((item) => item.status === "待发送");
  const blocked = ready.filter((item) => !preflightOutboxItem(item).ok);
  const next = ready.find((item) => preflightOutboxItem(item).ok);
  if (!next) {
    addLog(
      blocked.length
        ? `没有可发送邮件：${blocked.length} 封已批准邮件被预检拦截，请先修复联系方式或退订状态`
        : "没有已批准待发送邮件；未审批邮件请先在队列中勾选后点「批量审批发送」"
    );
    return;
  }
  if (remainingDailyQuota() < 1) {
    addLog(`发送安全阀：今日邮件额度已用完（已发 ${sentTodayCount()} 封），明天再发或在「管理 → 规则」调整日限`);
    return;
  }
  const r = await deliverEmailBatch([next], { quiet: true });
  addLog(
    r.sent
      ? `${r.simulated ? "已模拟发送" : "已发出"}：${next.company} · ${next.label}`
      : `${next.company} · ${next.label} 发送失败，保留待发送：${r.error || "未知错误"}`
  );
}

function emailLooksValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((email || "").trim());
}

// 邮箱是否"来路可信"：按出处判断，不看模拟验证状态。
// 可信：真实源(webhook)验证 / 客户回过信 / 导入原始邮箱 / 联网深挖标 verified / 非候选生成（直接从导入或联网结果带来）。
// 不可信（要警告）：规则或 AI 按域名模式猜出来的候选邮箱（firstname.lastname / info / sales / guessed 等）。
function emailLooksVerified(prospect, email) {
  if (!prospect) return false;
  if (prospect.contactSource === "webhook") return true;
  if (prospect.status === "已回复") return true;
  const target = email || prospect.email;
  const cand = (prospect.emailCandidates || []).find((c) => c.email === target);
  if (cand) return /verified|导入原始邮箱/.test(cand.pattern || "");
  // 没有候选记录：邮箱是导入/联网抓来的原始地址，非模式猜测
  return !!target;
}

// 发送预检：返回 { blockers:[], warnings:[], ok }。blockers 阻止发送，warnings 仅提示
// 垃圾词预检：高信号、低误报——避开外贸常用词，只揪真正拉低到达率的表达/排版
function spamFlags(subject, body) {
  const text = `${subject || ""} ${body || ""}`;
  const flags = [];
  const patterns = [
    [/\bguarante?ed?\b/i, "guarantee"],
    [/\bact now\b/i, "act now"],
    [/\bclick here\b/i, "click here"],
    [/\bbuy now\b/i, "buy now"],
    [/\brisk[-\s]?free\b/i, "risk-free"],
    [/\blimited[-\s]time\b/i, "limited time"],
    [/\bcredit card\b/i, "credit card"],
    [/\bwinner\b/i, "winner"],
    [/\bcongratulations\b/i, "congratulations"],
    [/100%\s*(free|guarantee)/i, "100% free/guarantee"],
    [/\$\$\$|\$\d{4,}/, "$$$"]
  ];
  patterns.forEach(([re, label]) => {
    if (re.test(text)) flags.push(label);
  });
  if (/!{2,}/.test(text)) flags.push("连续感叹号");
  // 全大写词（排除外贸/认证常用缩写，避免误报）
  const CAPS_OK = /^(FOB|CIF|CFR|EXW|MOQ|OEM|ODM|SONCAP|IATF|ISO|USD|EUR|CBM|HS|CE|FCC|CCC|LCL|FCL|PI|LC|TT|RFQ|OK)$/;
  const capsWords = (text.match(/\b[A-Z]{4,}\b/g) || []).filter((w) => !CAPS_OK.test(w));
  if (capsWords.length >= 2) flags.push("多个全大写词");
  return flags;
}

function preflightOutboxItem(item) {
  const prospect = state.prospects.find((p) => p.id === item.prospectId);
  const blockers = [];
  const warnings = [];
  if (prospect?.optOut) blockers.push("客户已退订");
  if (isBlacklisted(prospect || { email: item.email })) blockers.push("在退订黑名单");
  if (!emailLooksValid(item.email)) blockers.push("邮箱缺失/格式无效");
  else if (prospect && !emailLooksVerified(prospect, item.email)) warnings.push("邮箱为推测未验证（退信伤发信域名，建议先验证）");
  const sensitive = sensitiveTopic(`${item.subject || ""} ${item.body || ""}`);
  if (sensitive) warnings.push(`含敏感话题：${sensitive}`);
  const spam = spamFlags(item.subject, item.body);
  if (spam.length) warnings.push(`易进垃圾箱（${spam.slice(0, 3).join("、")}${spam.length > 3 ? "…" : ""}），建议改写`);
  const dup = state.outbox.some(
    (o) =>
      o.id !== item.id &&
      o.prospectId === item.prospectId &&
      o.status === "已发送" &&
      (o.step === item.step || o.subject === item.subject)
  );
  if (dup) warnings.push("疑似重复触达（同客户同类邮件已发送）");
  return { blockers, warnings, ok: blockers.length === 0 };
}

function preflightBadge(item) {
  const pf = preflightOutboxItem(item);
  if (pf.blockers.length) return `<span class="pf-badge pf-block" title="${escapeHtml(pf.blockers.join("；"))}">⛔ ${escapeHtml(pf.blockers[0])}</span>`;
  if (pf.warnings.length) return `<span class="pf-badge pf-warn" title="${escapeHtml(pf.warnings.join("；"))}">⚠ ${escapeHtml(pf.warnings[0])}</span>`;
  return `<span class="pf-badge pf-ok">✓ 可发送</span>`;
}

/* ---------- 发送安全阀：发送时强制日限 + 预热提示（保护发信域名信誉） ---------- */

function sentTodayCount() {
  const today = dateOffset(0);
  return state.outbox.filter((o) => o.status === "已发送" && (o.sentAt || "").slice(0, 10) === today).length;
}

function remainingDailyQuota() {
  const limit = Math.min(
    state.management?.rules?.emailDailyLimit || 80,
    state.campaign?.dailyLimit || 300
  );
  return Math.max(0, limit - sentTodayCount());
}

// 对将要发送的列表应用日限；超出的部分保留待发并提示。返回可发的子集
function applyDailyQuota(list, quiet = false) {
  const remaining = remainingDailyQuota();
  if (list.length <= remaining) return list;
  const allowed = list.slice(0, remaining);
  const held = list.length - allowed.length;
  addLog(
    `发送安全阀：今日邮件额度剩 ${remaining} 封（已发 ${sentTodayCount()}），本批 ${list.length} 封只放行 ${allowed.length}，其余 ${held} 封保留明天再发（保护发信域名，避免进垃圾箱）`,
    { toast: !quiet }
  );
  return allowed;
}

// 新域名预热提示：历史总发送量还很小时，单日大批量最伤域名信誉
function warmupHint(batchSize) {
  const totalSent = state.outbox.filter((o) => o.status === "已发送").length;
  if (batchSize > 20 && totalSent < 200) {
    addLog("📮 预热提示：新发信域名前 1-2 周建议每天 ≤20 封并逐步加量，直接大批量发送容易被判定为垃圾邮件");
  }
}

// 发送指定的一批发信队列条目（审批即发送，忽略排期日期）；复用 Webhook/本地
async function sendOutboxItems(items) {
  const candidates = items.filter((i) => i.status === "待发送" || i.status === "待审批");
  const blocked = candidates.filter((item) => !preflightOutboxItem(item).ok);
  let toSend = candidates.filter((item) => preflightOutboxItem(item).ok);
  if (blocked.length) addLog(`发送预检拦截 ${blocked.length} 封邮件，请先修复后再发`);
  toSend = applyDailyQuota(toSend);
  if (!toSend.length) return 0;
  warmupHint(toSend.length);
  const r = await deliverEmailBatch(toSend, { quiet: true });
  return r.sent;
}

// 批量审批发送：对勾选的待发/待审批邮件跑发送预检，放行的立即发送，拦截的保留并提示
async function batchApproveSend() {
  const checkedIds = [...elements.outboxList.querySelectorAll("input[data-outbox-id]:checked")].map((c) => c.dataset.outboxId);
  if (!checkedIds.length) {
    addLog("请先勾选要审批发送的邮件（可点「全选待审/待发」）");
    return 0;
  }
  const items = activeOutboxItems().filter((o) => checkedIds.includes(o.id));
  const sendable = [];
  const blocked = [];
  items.forEach((it) => {
    if (preflightOutboxItem(it).ok) sendable.push(it);
    else blocked.push(it);
  });
  if (!sendable.length) {
    addLog(`勾选的 ${items.length} 封都被发送预检拦截（缺邮箱/退订），请先修复联系方式`);
    saveState();
    render();
    return 0;
  }
  const sent = await sendOutboxItems(sendable);
  addLog(`批量审批发送 ${sent} 封${blocked.length ? `，预检拦截 ${blocked.length} 封（缺邮箱/退订，保留待处理）` : ""}`);
  saveState();
  render();
  return sent;
}

async function sendDueEmails(quiet = false) {
  const today = dateOffset(0);
  let due = activeOutboxItems().filter((item) => item.status === "待发送" && item.dueDate <= today);
  if (!due.length) {
    if (!quiet) addLog("今天没有已批准且到期的邮件；未审批邮件请用「批量审批发送」放行");
    return 0;
  }
  const blocked = due.filter((item) => !preflightOutboxItem(item).ok);
  due = due.filter((item) => preflightOutboxItem(item).ok);
  if (blocked.length && !quiet) addLog(`发送预检拦截 ${blocked.length} 封已批准到期邮件，请先修复后再发`);
  if (!due.length) return 0;
  due = applyDailyQuota(due, quiet);
  if (!due.length) return 0;
  warmupHint(due.length);

  const r = await deliverEmailBatch(due, { quiet });
  return r.sent;
}

function deliverApprovedWhatsapp(quiet = false) {
  const today = dateOffset(0);
  const approved = activeWhatsappQueueItems().filter((item) => item.status === "已审批" && item.dueDate <= today);
  approved.forEach((item) => {
    item.status = "已发送";
    item.sentAt = new Date().toISOString();
    const h = hashInt(item.prospectId + item.step);
    item.delivered = h % 100 < 98;
    const prospect = state.prospects.find((p) => p.id === item.prospectId);
    item.read = item.delivered && (h >> 3) % 100 < Math.min(88, 50 + Math.round((prospect?.score || 60) * 0.5));
    advanceDealStage(item.prospectId, "已触达");
  });
  if (approved.length && !quiet) addLog(`发送 ${approved.length} 条已审批 WhatsApp（本地模拟）`);
  return approved.length;
}

function getSelectedProspect() {
  const prospects = activeProspects();
  return prospects.find((item) => item.id === state.selectedProspectId) || prospects[0] || null;
}

function normalizeMarkets(value) {
  return value
    .split(/[,，;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function suffixesForType(type) {
  if (type.includes("retailer")) return ["Retail Group", "Home Stores", "Category Buyers", "Trading"];
  if (type.includes("brand")) return ["Brands", "Private Label", "Consumer Goods", "Design Co"];
  if (type.includes("wholesaler")) return ["Wholesale", "Trade Supply", "Distribution", "Market Supply"];
  if (type.includes("contractor")) return ["Projects", "Build Supply", "Contracting", "Materials"];
  return ["Imports", "Distribution", "Trading", "Supply", "Wholesale"];
}

function rolesForType(type) {
  if (type.includes("retailer")) return ["Category Manager", "Buying Manager", "Merchandising Manager"];
  if (type.includes("brand")) return ["Product Manager", "Sourcing Lead", "Supply Chain Manager"];
  if (type.includes("contractor")) return ["Project Buyer", "Procurement Manager", "Purchasing Director"];
  return ["Sourcing Manager", "Purchasing Manager", "Import Manager"];
}

function scoreProspect(source, market, index) {
  const sourceScore = {
    "Customs Data": 84,
    LinkedIn: 78,
    Google: 75,
    Marketplace: 72,
    "B2B Directory": 70,
    "Industry Association": 76
  };
  // 这里原来还加了 `市场名长度 % 11` 和 `序号 % 6`。那两项和线索质量毫无关系——
  // 同一家公司只因为市场名多几个字符就凭空多 7 分，是把噪音包装成分数。
  // 分数会进质量分、会决定排序、会显示给用户看，不能有这种假精度。
  // 只保留真正有信号的那一项：来源渠道本身的可信度。
  // 未知来源（粘贴导入、Webhook 自定义源等）给中性底分，避免算出 NaN 毁掉整条线索。
  return sourceScore[source] ?? 68;
}

function getProductNoun(product) {
  const words = product.toLowerCase().split(/\s+/).filter(Boolean);
  return words.slice(-2).join(" ") || product;
}

function makeDomain(company, market) {
  const tld = tldForMarket(market);
  return `${slugify(company)}.${tld}`;
}

function tldForMarket(market) {
  const value = market.toLowerCase();
  if (value.includes("germany")) return "de";
  if (value.includes("united arab") || value.includes("uae") || value.includes("dubai")) return "ae";
  if (value.includes("brazil")) return "com.br";
  if (value.includes("france")) return "fr";
  if (value.includes("italy")) return "it";
  if (value.includes("spain")) return "es";
  if (value.includes("canada")) return "ca";
  if (value.includes("australia")) return "com.au";
  return "com";
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function buildWhatsappUrl(prospect, message) {
  const phone = normalizePhone(prospect.phone);
  const text = encodeURIComponent(message);
  return phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
}

function stripProtocol(value) {
  return String(value).replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function capitalize(value) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatEmail(item) {
  return `Subject: ${item.subject}

${item.body}`;
}

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function timestamp() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function addLog(message, options = {}) {
  state.logs.unshift({ id: makeId("log"), time: timestamp(), message });
  state.logs = state.logs.slice(0, 80);
  if (options.toast !== false) showToast(message);
}

function showToast(message) {
  if (!elements.toastStack) return;
  const tone = /失败|错误|无法|没有|不重复/.test(message)
    ? "warn"
    : /自动驾驶|AI |AI意图|AI 意图/.test(message)
      ? "auto"
      : "info";
  const node = document.createElement("div");
  node.className = `toast ${tone}`;
  node.textContent = message;
  elements.toastStack.appendChild(node);
  while (elements.toastStack.children.length > 3) elements.toastStack.firstChild.remove();
  setTimeout(() => {
    node.classList.add("hide");
    setTimeout(() => node.remove(), 320);
  }, 3600);
}

// 从当前控制台配置构造/更新一个完整活动快照
function campaignFromCurrentConfig(existing) {
  return {
    id: existing?.id || makeId("campaign"),
    name: existing?.name || `${state.campaign.product} · ${normalizeMarkets(state.campaign.markets).slice(0, 2).join(", ")}`,
    product: state.campaign.product,
    markets: state.campaign.markets,
    customerType: state.campaign.customerType,
    valueProps: state.campaign.valueProps,
    certifications: state.campaign.certifications,
    owner: state.campaign.senderName,
    companyName: state.campaign.companyName,
    originCity: state.campaign.originCity || "",
    dailyLimit: state.campaign.dailyLimit,
    presetKey: state.campaign.presetKey || null,
    focusProduct: state.campaign.focusProduct || "",
    productTerms: state.campaign.productTerms || [],
    hsCode: state.campaign.hsCode || "",
    buyerHint: state.campaign.buyerHint || "",
    productProfile: state.campaign.productProfile || null,
    productDescription: state.campaign.productDescription || "",
    focusConfirmed: state.campaign.focusConfirmed || "",
    createdAt: existing?.createdAt || dateOffset(0)
  };
}

function saveCurrentCampaignSnapshot() {
  const existing = getActiveManagedCampaign();
  const snapshot = campaignFromCurrentConfig(existing);
  const exists = state.management.campaigns.some((campaign) => campaign.id === snapshot.id);
  state.management.campaigns = exists
    ? state.management.campaigns.map((campaign) => (campaign.id === snapshot.id ? snapshot : campaign))
    : [snapshot, ...state.management.campaigns];
  state.activeCampaignId = snapshot.id;
  addLog(`活动已保存：${snapshot.name}`);
}

function createManagedCampaign() {
  readCampaignFromForm();
  // 先把当前配置存回原活动，再开一个新活动（沿用当前配置作为起点，用户再改）
  saveCurrentCampaignSnapshot();
  const campaign = { ...campaignFromCurrentConfig(null), name: `新活动 · ${dateOffset(0)}` };
  state.management.campaigns.unshift(campaign);
  state.activeCampaignId = campaign.id;
  addLog(`已新建活动「${campaign.name}」——改控制台配置即属于它，新找到的线索归它名下`);
}

// 切换活动：整套配置恢复到控制台（不再只换产品，避免卖点/品类串味）
function activateManagedCampaign(id) {
  saveCurrentCampaignSnapshot(); // 先存回旧活动，改动不丢
  const c = state.management.campaigns.find((x) => x.id === id);
  if (!c) return;
  state.activeCampaignId = id;
  state.campaign = {
    ...state.campaign,
    product: c.product,
    markets: c.markets,
    customerType: c.customerType || state.campaign.customerType,
    valueProps: c.valueProps ?? state.campaign.valueProps,
    certifications: c.certifications ?? state.campaign.certifications,
    senderName: c.owner ?? state.campaign.senderName,
    companyName: c.companyName ?? state.campaign.companyName,
    originCity: c.originCity ?? state.campaign.originCity ?? "",
    dailyLimit: c.dailyLimit || state.campaign.dailyLimit,
    presetKey: c.presetKey || null,
    focusProduct: c.focusProduct || "",
    productTerms: c.productTerms || [],
    hsCode: c.hsCode || "",
    buyerHint: c.buyerHint || "",
    productProfile: c.productProfile || null,
    productDescription: c.productDescription || "",
    focusConfirmed: c.focusConfirmed || ""
  };
  state.searchPlan = generateSearchPlan(state.campaign);
  state.selectedProspectId = null;
  state.selectedConversationId = null;
  state.sequence = [];
  state.whatsappSequence = [];
  bindCampaignForm();
  addLog(`已切换到活动「${c.name}」，整套配置已恢复到控制台`);
}

function deleteManagedCampaign(id) {
  if (state.management.campaigns.length <= 1) {
    addLog("至少保留一个活动，无法删除最后一个");
    return;
  }
  const target = state.management.campaigns.find((c) => c.id === id);
  if (!target) return;
  const leadCount = state.prospects.filter((p) => (p.campaignId || null) === id).length;
  if (!window.confirm(`删除活动「${target.name}」？它名下 ${leadCount} 条线索会转到其它活动，线索本身不删除。`)) return;
  state.management.campaigns = state.management.campaigns.filter((c) => c.id !== id);
  const fallbackId = state.management.campaigns[0].id;
  state.prospects = state.prospects.map((p) => ((p.campaignId || null) === id ? { ...p, campaignId: fallbackId } : p));
  if (state.activeCampaignId === id) activateManagedCampaign(fallbackId);
  addLog(`已删除活动「${target.name}」，${leadCount} 条线索已转移`);
}

function renameManagedCampaign(id) {
  const c = state.management.campaigns.find((x) => x.id === id);
  if (!c) return;
  const next = window.prompt("重命名活动：", c.name);
  if (next == null) return;
  const name = next.trim();
  if (name) {
    c.name = name;
    addLog(`活动已重命名为「${name}」`);
  }
}

async function runPendingManagementJobs() {
  const notes = [];

  // job-search：webhook 模式真实采集，本地模式提示
  if (remoteSearchReady()) {
    const got = await trySearchWebhook();
    if (got?.length) {
      const admitted = admitProspects(got, "采集任务");
      state.prospects = [...admitted, ...state.prospects];
      notes.push(`采集 ${admitted.length} 个潜客`);
    }
    setJobDone("job-search");
  } else {
    setJob("job-search", { status: "本地模式", progress: 100, nextRun: "接入搜索 Webhook 后自动采集" });
  }

  // job-enrich + job-verify：真实补全验证新线索
  const raw = activeProspects().filter((p) => ["新发现", "待审核"].includes(p.status));
  if (raw.length) {
    const processed = verifyProspectList(enrichProspectList(raw, state.campaign), state.campaign);
    replaceProspectsById(processed);
    notes.push(`补全验证 ${processed.length} 条线索`);
  }
  setJobDone("job-enrich");
  setJobDone("job-verify");

  // job-sequence：确保当前选中潜客的话术已生成
  ensureSelection();
  setJobDone("job-sequence");

  // job-queue：高分入队（遵守全部规则）
  const before = state.outbox.length + state.whatsappQueue.length;
  queueTopProspects();
  queueTopWhatsappProspects();
  const queued = state.outbox.length + state.whatsappQueue.length - before;
  if (queued) notes.push(`入队 ${queued} 条触达`);
  setJobDone("job-queue");

  // job-crm：webhook 模式真实同步
  if (state.settings.mode === "webhook" && webhookUrl("crm")) {
    const result = await callWebhook("crm", { prospects: crmProspectsPayload() });
    setJob("job-crm", {
      status: result.ok ? "已完成" : "失败",
      progress: result.ok ? 100 : 0,
      nextRun: result.ok ? "每 6 小时" : "检查 CRM Webhook"
    });
    if (result.ok) notes.push(`CRM 同步 ${activeProspects().length} 个客户`);
  } else {
    setJob("job-crm", { status: "待配置", progress: 0, nextRun: "配置 CRM Webhook 后" });
  }

  addLog(notes.length ? `任务中心执行：${notes.join("；")}` : "任务中心执行完成：暂无新增待处理数据");
  saveState();
  render();
}

function resetManagementJobs() {
  state.management.jobs = createManagementState(state.campaign).jobs;
  addLog("自动化任务中心已重置");
}

function approveAllManagementItems() {
  // Agent 待审批卡本身的按钮语义是"通过并发送"；普通邮件只批准为待发送，不暗中派发
  const pendingAgent = (state.agent?.approvals || []).filter((a) => a.status === "pending");
  let approvedEmails = 0;
  state.outbox.forEach((item) => {
    if (item.status === "待审批") {
      item.status = "待发送";
      approvedEmails += 1;
    }
  });
  const approvedWhatsapp = state.whatsappQueue.filter((item) => item.status === "待人工确认").length;
  state.whatsappQueue = state.whatsappQueue.map((item) =>
    item.status === "待人工确认" ? { ...item, status: "已审批" } : item
  );
  const parts = [];
  if (pendingAgent.length) parts.push(`${pendingAgent.length} 张 Agent 触达卡通过并发送`);
  if (approvedEmails) parts.push(`${approvedEmails} 封邮件已批准为待发送`);
  if (approvedWhatsapp) parts.push(`${approvedWhatsapp} 条 WhatsApp 已审批待到期发送`);
  addLog(parts.length ? `审批中心已全部通过（${parts.join("、")}）` : "审批中心：暂无待审批事项");

  // Agent 卡审批（async，逐张放行并发送首触）
  (async () => {
    for (const a of pendingAgent) await agentApprove(a, true);
    saveState();
    render();
  })();
}

function saveManagementRules() {
  state.management.rules = {
    emailDailyLimit: clamp(Number(elements.ruleEmailLimit.value) || 80, 1, 500),
    whatsappDailyLimit: clamp(Number(elements.ruleWhatsappLimit.value) || 30, 1, 200),
    scoreThreshold: clamp(Number(elements.ruleScoreThreshold.value) || 70, 0, 100),
    cooldownDays: clamp(Number(elements.ruleCooldownDays.value) || 7, 1, 60),
    requireWhatsappApproval: elements.ruleRequireApproval.checked
  };
  addLog("自动化规则已保存");
}

function exportManagement() {
  const payload = {
    management: state.management,
    activeCampaignId: state.activeCampaignId,
    pipeline: state.prospects,
    outbox: state.outbox,
    whatsappQueue: state.whatsappQueue,
    logs: state.logs
  };
  download(`management-${dateOffset(0)}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function exportJson() {
  state.ui = { ...(state.ui || {}), lastBackupAt: new Date().toISOString() };
  saveState();
  download(`foreign-trade-automation-${dateOffset(0)}.json`, JSON.stringify(backupSnapshot(), null, 2), "application/json");
  addLog("已导出全量备份（含线索/队列/黑名单/配置）。API Key 已抹掉，可以放心发给客服；换机恢复后到「设置」重填一次即可");
}

// 数据瘦身：整封邮件正文是 localStorage 的主要占用。把 30 天前发出、且客户未回复的
// 已发邮件正文归档清空（仅留主题/状态/日期，分析统计不受影响），把 5MB 天花板往后推。
function slimmableOutbox() {
  const cutoff = Date.now() - 30 * 86400000;
  const repliedIds = new Set(state.inbound.map((m) => m.prospectId));
  return state.outbox.filter(
    (o) =>
      o.status === "已发送" &&
      !o.slimmed &&
      (o.body || "").length > 40 &&
      o.sentAt &&
      new Date(o.sentAt).getTime() < cutoff &&
      !repliedIds.has(o.prospectId)
  );
}

function slimOldData() {
  const items = slimmableOutbox();
  if (!items.length) {
    addLog("暂无可瘦身的邮件（只归档 30 天前发出、且客户未回复的已发邮件正文）");
    render();
    return;
  }
  let saved = 0;
  items.forEach((o) => {
    saved += (o.body || "").length;
    o.body = "";
    o.slimmed = true;
  });
  addLog(`已瘦身 ${items.length} 封老邮件（正文归档，仅留主题/状态/日期），约省 ${Math.max(1, Math.round(saved / 1024))} KB；分析统计不受影响。`);
  saveState();
  render();
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsText(file);
  });
}

async function importBackupFile(file) {
  if (!file) return;
  try {
    const text = await readFileAsText(file);
    const parsed = JSON.parse(text);
    if (!parsed?.campaign) throw new Error("不是有效的系统备份 JSON");
    const prospectCount = Array.isArray(parsed.prospects) ? parsed.prospects.length : 0;
    const outboxCount = Array.isArray(parsed.outbox) ? parsed.outbox.length : 0;
    const ok = window.confirm(
      `将恢复备份「${file.name}」并覆盖当前浏览器数据。\n\n备份包含：${prospectCount} 条线索、${outboxCount} 封邮件队列。\n\n继续导入？`
    );
    if (!ok) return;
    const restored = normalizeStoredState(parsed);
    restored.ui = { ...(restored.ui || {}), lastBackupAt: new Date().toISOString() };
    restored.logs = [
      { id: makeId("log"), time: timestamp(), message: `已从备份恢复：${file.name}` },
      ...(restored.logs || [])
    ].slice(0, 80);
    state = restored;
    bindCampaignForm();
    bindSettingsForm();
    bindManagementForm();
    bindInboxForm();
    saveState();
    render();
  } catch (error) {
    addLog(`导入备份失败：${error.message}`);
    saveState();
    render();
  }
}

function exportQueries() {
  const rows = state.searchPlan.map((item) => ({
    channel: item.channel,
    market: item.market,
    priority: item.priority,
    intent: item.intent,
    query: item.query,
    nextAction: item.nextAction,
    url: item.url
  }));
  download(`search-plan-${dateOffset(0)}.csv`, toCsv(rows), "text/csv;charset=utf-8");
}

function exportProspects() {
  // 摊平成可读列：候选邮箱和人工核实留痕是对象/数组，直接进 CSV 会变成 [object Object]。
  // F3 要求"人工核实的线索带永久标记且导出可见"，所以这两列必须显式给出。
  const rows = activeProspects().map((p) => ({
    ...p,
    sendEligibility: verificationBadgeText(emailVerificationState(p, p.email)),
    manualVerifiedBy: p.manualVerified?.by || "",
    manualVerifiedAt: p.manualVerified?.at || "",
    manualVerifiedEmail: p.manualVerified?.email || "",
    manualVerified: undefined,
    emailCandidates: (p.emailCandidates || [])
      .map((c) => `${c.email}(${c.confidence}%${c.pattern ? " " + c.pattern : ""})`)
      .join(" | ")
  }));
  download(`prospects-${dateOffset(0)}.csv`, toCsv(rows), "text/csv;charset=utf-8");
}

function exportOutbox() {
  download(`outbox-${dateOffset(0)}.csv`, toCsv(activeOutboxItems()), "text/csv;charset=utf-8");
}

function exportWhatsappQueue() {
  download(`whatsapp-queue-${dateOffset(0)}.csv`, toCsv(activeWhatsappQueueItems()), "text/csv;charset=utf-8");
}

function toCsv(rows) {
  if (!rows.length) return "";
  // \u53D6\u6240\u6709\u884C\u5B57\u6BB5\u7684\u5E76\u96C6\uFF0C\u4E0D\u80FD\u53EA\u770B\u7B2C\u4E00\u884C\u2014\u2014\u7B2C\u4E00\u6761\u7EBF\u7D22\u6CA1\u88AB\u4EBA\u5DE5\u6838\u5B9E\u8FC7\uFF0C
  // \u6574\u5217 manualVerified \u5C31\u4F1A\u4ECE\u8868\u5934\u6D88\u5931\uFF0C\u540E\u9762\u6838\u5B9E\u8FC7\u7684\u7EBF\u7D22\u7559\u75D5\u4E5F\u8DDF\u7740\u4E22\u3002
  const headers = [];
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (row[key] !== undefined && !headers.includes(key)) headers.push(key);
    });
  });
  const body = rows.map((row) => headers.map((header) => csvCell(row[header])).join(","));
  return `\uFEFF${headers.join(",")}\n${body.join("\n")}`;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒或非安全上下文，降级到 execCommand
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-999px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function makeId(prefix) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateModeButtons() {
  const mode = state.settings.mode;
  elements.localMode.classList.toggle("is-active", mode === "local");
  elements.webhookMode.classList.toggle("is-active", mode === "webhook");
  if (elements.directMode) elements.directMode.classList.toggle("is-active", mode === "direct");
  if (elements.modeHint) {
    elements.modeHint.innerHTML =
      mode === "direct"
        ? `直连：应用直接用你的企业邮箱收发信，只需填一组 SMTP 和一组 IMAP，<b>不用装 n8n</b>。找客户/补邮箱仍可另配 Webhook（两者能混用）。`
        : mode === "webhook"
          ? `Webhook：所有动作交给你自建的 n8n/Make 等自动化平台。适合要对接自有系统或非标数据源的场景，配置成本高。`
          : `本地模拟：邮件不会真的发出去，全部数据是模拟的。用来先把流程走通，别把这里的"已发送"当真。`;
  }
}

function navigateTo(view) {
  elements.navTabs.forEach((item) => item.classList.toggle("is-active", item.dataset.view === view));
  elements.views.forEach((item) => item.classList.toggle("is-active", item.id === `${view}View`));
  // 切换到某视图时才渲染它——它在隐藏期间没有跟随 render() 更新
  render();
  // 管理页有十几个面板，「审批中心」排在中间。带着导航红点点进来的人是来处理待审批的，
  // 直接滚到那儿，别让他自己翻。
  if (view === "management" && realApprovals().some((item) => item.count > 0)) {
    setTimeout(() => elements.approvalCenter?.scrollIntoView({ block: "center", behavior: "smooth" }), 40);
  }
}

elements.navTabs.forEach((tab) => {
  tab.addEventListener("click", () => navigateTo(tab.dataset.view));
});

function openProjectManagement() {
  navigateTo("management");
  setTimeout(() => elements.campaignManager?.scrollIntoView({ block: "start", behavior: "smooth" }), 40);
}

function createProjectFromSidebar() {
  createManagedCampaign();
  bindCampaignForm();
  navigateTo("dashboard");
  elements.campaignForm?.scrollIntoView({ block: "start", behavior: "smooth" });
  saveState();
  render();
}

elements.sidebarProjectList?.addEventListener("click", (event) => {
  const campaignId = event.target.closest("[data-sidebar-campaign]")?.dataset.sidebarCampaign;
  const manage = event.target.closest("[data-sidebar-project-manage]");
  if (manage) {
    openProjectManagement();
    return;
  }
  if (!campaignId || campaignId === state.activeCampaignId) return;
  activateManagedCampaign(campaignId);
  saveState();
  render();
});

elements.sidebarProjectNew?.addEventListener("click", createProjectFromSidebar);
elements.sidebarProjectManage?.addEventListener("click", openProjectManagement);

// 全局委托：空状态引导按钮 / 新手清单 的跳转与动作
document.addEventListener("click", (event) => {
  const gotoTarget = event.target.closest("[data-goto]");
  if (gotoTarget) {
    navigateTo(gotoTarget.dataset.goto);
    return;
  }
  const nextTarget = event.target.closest("[data-next-action]");
  if (nextTarget) {
    const action = nextTarget.dataset.nextAction;
    if (action === "focus-campaign") {
      navigateTo("dashboard");
      elements.campaignForm?.scrollIntoView({ block: "start", behavior: "smooth" });
      const brief = campaignBriefStatus();
      const target = brief.missing[0]?.field === "markets" ? elements.marketsInput : elements.productInput;
      target?.focus({ preventScroll: true });
    } else if (action === "generate-plan") {
      elements.generatePlan?.click();
    } else if (action === "enrich-prospects") {
      navigateTo("prospects");
      if (elements.bulkEnrichContacts) {
        runAsyncButton(elements.bulkEnrichContacts, "批量补全中…", () => bulkEnrichContacts());
      }
    } else if (action === "verify-prospects") {
      navigateTo("prospects");
      if (elements.verifyFilter) elements.verifyFilter.value = "guessed";
      elements.verifyProspects?.click();
    }
    return;
  }
  // 今日待办：一键批量跟进 / 一键拉取回复
  const todoTarget = event.target.closest("[data-todo]");
  if (todoTarget) {
    const kind = todoTarget.dataset.todo;
    if (kind === "followup") queueDueFollowups();
    else if (kind === "pull") runAsyncButton(todoTarget, "拉取中…", () => pullInboundReplies());
    else if (kind === "pullstatus") runAsyncButton(todoTarget, "同步中…", () => pullDeliveryStatus());
    else if (kind === "backup") exportJson();
    return;
  }
  // 数据与备份：一键瘦身老邮件
  const safetyTarget = event.target.closest("[data-safety]");
  if (safetyTarget) {
    if (safetyTarget.dataset.safety === "slim") slimOldData();
    return;
  }
  // 优先联系名单：点一行 → 选中该客户并跳到对应视图（有回信去收件箱，否则去潜客详情）
  const priTarget = event.target.closest("[data-priority]");
  if (priTarget) {
    const id = priTarget.dataset.priority;
    state.selectedProspectId = id;
    const selected = getSelectedProspect();
    if (selected) {
      state.sequence = buildEmailSequence(state.campaign, selected);
      state.whatsappSequence = buildWhatsappSequence(state.campaign, selected);
    }
    navigateTo(state.inbound.some((m) => m.prospectId === id) ? "inbox" : "prospects");
    saveState();
    return;
  }
  if (event.target.closest("[data-checklist-dismiss]")) {
    state.ui = { ...(state.ui || {}), checklistDismissed: true };
    saveState();
    renderChecklist();
    return;
  }
  const action = event.target.closest("[data-checklist-action]");
  if (action?.dataset.checklistAction === "autopilot" && !state.autopilot?.enabled) setAutopilot(true);
});

elements.campaignForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!requireCampaignBrief("生成开发计划")) return;
  readCampaignFromForm();
  state.searchPlan = generateSearchPlan(state.campaign);
  state.prospects = [];
  state.selectedProspectId = state.prospects[0]?.id || null;
  state.sequence = buildEmailSequence(state.campaign, getSelectedProspect());
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  state.outbox = [];
  state.whatsappQueue = [];
  state.tasks = [];
  state.inbound = [];
  state.selectedConversationId = null;
  // 生成新的开发计划会清空线索池，同步结束进行中的 Agent 任务，避免悬挂审批指向已删除客户
  state.agent = { task: null, approvals: [], autoRespond: state.agent?.autoRespond || false };
  addLog(`生成开发计划：${state.campaign.product}，等待导入真实搜索结果`);
  saveState();
  render();
});

if (elements.oneClickPipeline) {
  elements.oneClickPipeline.addEventListener("click", () => {
    if (!requireCampaignBrief("一键起量")) return;
    runAsyncButton(elements.oneClickPipeline, "起量中…", () => runOneClickPipeline());
  });
}

if (elements.categoryPresets) {
  elements.categoryPresets.addEventListener("click", (event) => {
    const key = event.target.closest("[data-preset]")?.dataset.preset;
    if (key) applyCampaignPreset(key);
  });
}

if (elements.refineFocus) {
  elements.refineFocus.addEventListener("click", () => {
    runAsyncButton(elements.refineFocus, "细化中…", () => refineProductFocus());
  });
}

elements.resetDemo.addEventListener("click", () => {
  state = createDemoState();
  bindCampaignForm();
  bindSettingsForm();
  bindManagementForm();
  bindInboxForm();
  applyTheme();
  saveState();
  render();
});

elements.runAutomationTop.addEventListener("click", () => {
  if (!requireCampaignBrief("准备获客队列")) return;
  runAsyncButton(elements.runAutomationTop, "准备中…", () => runAutomation());
});

// 状态条：跳到该去的页面 / 手动收起
elements.runStatusAction?.addEventListener("click", () => {
  const view = runTracker.action?.view;
  runDismiss();
  if (view) navigateTo(view);
});
elements.runStatusClose?.addEventListener("click", runDismiss);

elements.exportJson.addEventListener("click", exportJson);
if (elements.backupNow) elements.backupNow.addEventListener("click", exportJson);
if (elements.importBackup) {
  elements.importBackup.addEventListener("click", () => elements.importBackupFile?.click());
}
if (elements.importBackupFile) {
  elements.importBackupFile.addEventListener("change", async () => {
    const file = elements.importBackupFile.files?.[0];
    await importBackupFile(file);
    elements.importBackupFile.value = "";
  });
}

elements.copyQueries.addEventListener("click", async () => {
  await copyText(state.searchPlan.map((item) => item.query).join("\n"));
  addLog("已复制搜索式");
  saveState();
  renderLogs();
});

elements.runDiscovery.addEventListener("click", () => {
  if (!requireCampaignBrief("生成搜索式")) return;
  readCampaignFromForm();
  state.searchPlan = generateSearchPlan(state.campaign);
  addLog(`生成 ${state.searchPlan.length} 条搜索式`);
  saveState();
  render();
});

// 异步按钮包装：防重复点击 + 临时文案 + 统一异常兜底
async function runAsyncButton(btn, busyText, task) {
  if (!btn || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  const span = btn.querySelector("span");
  const original = span?.textContent;
  if (span) span.textContent = busyText;
  btn.disabled = true;
  try {
    await task();
  } catch (error) {
    addLog(`操作失败：${error.message}`);
    // 任务半路抛错时状态条还停在「进行中」，会一直转下去，这里收尾
    if (runIsActive()) runFail(error.message);
    saveState();
    render();
  } finally {
    btn.dataset.busy = "0";
    btn.disabled = false;
    if (span && original) span.textContent = original;
  }
}

if (elements.webSearchFind) {
  elements.webSearchFind.addEventListener("click", () => {
    if (!requireCampaignBrief("联网找客户")) return;
    readCampaignFromForm();
    runAsyncButton(elements.webSearchFind, "联网搜索中…", () => webSearchProspects({ count: 10 }));
  });
}

if (elements.reverseCompetitor) {
  elements.reverseCompetitor.addEventListener("click", () => {
    if (!requireCampaignBrief("竞品渠道反查")) return;
    readCampaignFromForm();
    runAsyncButton(elements.reverseCompetitor, "反查中…", () => reverseCompetitorChannel(elements.competitorUrl?.value || ""));
  });
}

if (elements.bulkEnrichContacts) {
  elements.bulkEnrichContacts.addEventListener("click", () => {
    runAsyncButton(elements.bulkEnrichContacts, "批量补全中…", () => bulkEnrichContacts());
  });
}

if (elements.bulkResolveWebsites) {
  elements.bulkResolveWebsites.addEventListener("click", () => {
    runAsyncButton(elements.bulkResolveWebsites, "解析官网中…", () => bulkResolveWebsites());
  });
}

elements.createProspects.addEventListener("click", () => {
  if (!requireCampaignBrief("解析线索")) return;
  readCampaignFromForm();
  if (!state.searchPlan.length) state.searchPlan = generateSearchPlan(state.campaign);
  const raw = elements.searchResultsInput.value;
  const imported = importSearchResultsText(raw, state.campaign);
  if (!imported.length) {
    // 「空输入框」和「贴了但挖不出东西」是两回事，下一步动作完全不同，要分开讲
    if (!raw.trim()) {
      addLog("输入框是空的：先把搜索结果粘贴进下面的大框，再点「解析为线索」");
      runAbort("输入框是空的，先粘贴内容再解析", null, "解析线索");
    } else {
      // 同样是 0 条，原因可能完全不同（粘的是搜索式 / 全平台站 / 池里早有 / 压根没域名），
      // 讲清楚是哪一种，用户才知道下一步该干什么
      const why = explainImportFailure(raw);
      addLog(why.reason);
      pushOp("粘贴导入", "解析出 0 条", `${why.reason} | 统计 ${JSON.stringify(lastImportStats)} | 前 80 字：${raw.slice(0, 80)}`);
      runAbort(why.reason, why.action, "解析线索");
    }
    saveState();
    render();
    return;
  }
  const admitted = admitProspects(imported, "粘贴导入");
  state.prospects = [...admitted, ...state.prospects];
  state.selectedProspectId = state.prospects[0]?.id || null;
  state.sequence = buildEmailSequence(state.campaign, getSelectedProspect());
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  agentOnProspectsImported(admitted);
  addLog(`导入 ${admitted.length} 个真实搜索结果线索`);
  const withEmail = admitted.filter((p) => p.email).length;
  runDone(
    `导入 ${admitted.length} 家公司，其中 ${withEmail} 家带邮箱${withEmail < admitted.length ? "；其余需要补全联系方式" : ""}`,
    { label: "去看线索", view: "prospects" }
  );
  saveState();
  render();
  // 自动驾驶开启时：导入即自动补全→验证→入队，无需手动逐步点击
  if (state.autopilot?.enabled) autopilotTick();
});

elements.importSearchResults.addEventListener("click", () => {
  elements.createProspects.click();
});

elements.loadImportExample.addEventListener("click", () => {
  elements.searchResultsInput.value = [
    "Example Imports Inc. https://exampleimports.com sourcing@exampleimports.com +1 555 0100",
    "Nordic Home Retail, https://nordichome.example, category@nordichome.example",
    "LinkedIn Company Page https://www.linkedin.com/company/example-trading Procurement Manager"
  ].join("\n");
  addLog("已填入搜索结果导入示例");
  saveState();
  renderLogs();
});

if (elements.loadCustomsExample) {
  elements.loadCustomsExample.addEventListener("click", () => {
    elements.searchResultsInput.value = customsExampleCsv();
    addLog("已填入海关提单 CSV 样例——点「解析为线索」会按买家聚合并算出进口条数；这类数据没有官网，导入后先点潜客队列的「批量解析官网」");
    saveState();
    renderLogs();
  });
}

elements.queryFilter.addEventListener("input", debounce(renderQueries));
elements.exportQueries.addEventListener("click", exportQueries);

elements.prospectFilter.addEventListener("input", debounce(renderProspects));
elements.statusFilter.addEventListener("change", renderProspects);
if (elements.gradeFilter) elements.gradeFilter.addEventListener("change", renderProspects);
if (elements.prospectSort) elements.prospectSort.addEventListener("change", renderProspects);
if (elements.queueQualityLeads) {
  elements.queueQualityLeads.addEventListener("click", () => queueQualityLeads());
}

elements.enrichProspects.addEventListener("click", () => {
  replaceProspectsById(enrichProspectList(activeProspects(), state.campaign));
  addLog("潜客资料补全完成");
  saveState();
  render();
});

elements.verifyProspects.addEventListener("click", () => {
  replaceProspectsById(verifyProspectList(activeProspects(), state.campaign));
  addLog("邮箱验证完成");
  saveState();
  render();
});

elements.buildWhatsappProspects.addEventListener("click", () => {
  replaceProspectsById(verifyProspectList(enrichProspectList(activeProspects(), state.campaign), state.campaign));
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  addLog("WhatsApp 联系方式与话术已生成");
  saveState();
  render();
});

elements.exportProspects.addEventListener("click", exportProspects);

elements.prospectTable.addEventListener("click", (event) => {
  const row = event.target.closest("[data-prospect-id]");
  if (!row) return;
  state.selectedProspectId = row.dataset.prospectId;
  state.sequence = buildEmailSequence(state.campaign, getSelectedProspect());
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  saveState();
  render();
});

elements.topProspects.addEventListener("click", (event) => {
  const row = event.target.closest("[data-prospect-id]");
  if (!row) return;
  state.selectedProspectId = row.dataset.prospectId;
  state.sequence = buildEmailSequence(state.campaign, getSelectedProspect());
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  saveState();
  render();
});

elements.prospectDetail.addEventListener("click", (event) => {
  // 点候选邮箱设为主邮箱
  const setEmail = event.target.closest("[data-set-email]")?.dataset.setEmail;
  if (setEmail) {
    const sel = getSelectedProspect();
    if (sel) {
      state.prospects = state.prospects.map((p) => (p.id === sel.id ? { ...p, email: setEmail, emailStatus: "待验证" } : p));
      addLog(`已设为主邮箱：${setEmail}`);
      saveState();
      render();
    }
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  const prospect = getSelectedProspect();
  if (!action || !prospect) return;

  if (action === "find-contact") {
    addLog(`正在为 ${prospect.company} 找联系人…`);
    renderLogs();
    enrichContactAI(prospect.id);
    return;
  }

  if (action === "deep-dig-contact") {
    Promise.resolve(deepDigContact(prospect.id)).catch((error) => {
      addLog(`官网深挖失败：${error.message}`);
      saveState();
      render();
    });
    return;
  }

  if (action === "find-lookalike") {
    addLog(`以 ${prospect.company} 为样本，扩展相似客户…`);
    renderLogs();
    Promise.resolve(findLookalike(prospect.id))
      .then((n) => {
        if (n > 0) addLog(`扩展出 ${n} 家相似公司，已进线索池`);
        else addLog("没有找到新的相似公司（可能都已在池中）");
        saveState();
        render();
      })
      .catch((error) => {
        addLog(`找相似客户失败：${error.message}`);
        saveState();
        render();
      });
    return;
  }

  if (action === "write-email") {
    state.sequence = buildEmailSequence(state.campaign, prospect);
    addLog(`已为 ${prospect.company} 生成邮件序列`);
  }

  if (action === "approve-prospect") {
    state.prospects = state.prospects.map((item) =>
      item.id === prospect.id ? { ...item, status: "已审核", confidence: Math.max(item.confidence, 80) } : item
    );
    addLog(`线索已审核通过：${prospect.company}`);
  }

  if (action === "open-whatsapp") {
    const enriched = prospect.phone
      ? prospect
      : verifyProspectList(enrichProspectList([prospect], state.campaign), state.campaign)[0];
    state.prospects = state.prospects.map((item) => (item.id === enriched.id ? enriched : item));
    const message = buildWhatsappSequence(state.campaign, enriched)[0]?.message || "";
    window.open(buildWhatsappUrl(enriched, message), "_blank", "noopener,noreferrer");
    addLog(`已打开 ${enriched.company} 的 WhatsApp 聊天`);
  }

  if (action === "queue-selected") {
    queueProspect(prospect, true);
    addLog(`${prospect.company} 已加入完整邮件序列`);
  }

  if (action === "queue-whatsapp") {
    queueWhatsappProspect(prospect, true, true);
    addLog(`${prospect.company} 已加入 WhatsApp 队列`);
  }

  saveState();
  render();
});

elements.emailProspectSelect.addEventListener("change", () => {
  state.selectedProspectId = elements.emailProspectSelect.value;
  state.sequence = buildEmailSequence(state.campaign, getSelectedProspect());
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  saveState();
  render();
});

elements.regenerateEmail.addEventListener("click", () => {
  state.sequence = buildEmailSequence(state.campaign, getSelectedProspect());
  addLog("邮件序列已重写");
  saveState();
  render();
});

elements.queueSequence.addEventListener("click", () => {
  const prospect = getSelectedProspect();
  if (!prospect) return;
  queueProspect(prospect, true);
  addLog(`${prospect.company} 已加入发信队列`);
  saveState();
  render();
});

elements.sequenceGrid.addEventListener("click", async (event) => {
  const id = event.target.closest("[data-copy]")?.dataset.copy;
  if (!id) return;
  const email = state.sequence.find((item) => item.id === id);
  if (!email) return;
  await copyText(formatEmail(email));
  addLog(`已复制：${email.label}`);
  saveState();
  renderLogs();
});

elements.whatsappProspectSelect.addEventListener("change", () => {
  state.selectedProspectId = elements.whatsappProspectSelect.value;
  state.sequence = buildEmailSequence(state.campaign, getSelectedProspect());
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  saveState();
  render();
});

elements.regenerateWhatsapp.addEventListener("click", () => {
  state.whatsappSequence = buildWhatsappSequence(state.campaign, getSelectedProspect());
  addLog("WhatsApp 话术已重写");
  saveState();
  render();
});

elements.queueWhatsapp.addEventListener("click", () => {
  const prospect = getSelectedProspect();
  if (!prospect) return;
  queueWhatsappProspect(prospect, true, true);
  addLog(`${prospect.company} 已加入 WhatsApp 队列`);
  saveState();
  render();
});

elements.whatsappSequenceGrid.addEventListener("click", async (event) => {
  const id = event.target.closest("[data-copy-whatsapp]")?.dataset.copyWhatsapp;
  if (!id) return;
  const message = state.whatsappSequence.find((item) => item.id === id);
  if (!message) return;
  await copyText(message.message);
  addLog(`已复制 WhatsApp：${message.label}`);
  saveState();
  renderLogs();
});

elements.simulateSend.addEventListener("click", async () => {
  await simulateSendNext();
  saveState();
  render();
});

elements.scheduleFollowups.addEventListener("click", () => {
  scheduleFollowupTasks(true);
  saveState();
  render();
});

if (elements.queueFollowups) {
  elements.queueFollowups.addEventListener("click", () => queueDueFollowups());
}

if (elements.analyticsInsight) {
  elements.analyticsInsight.addEventListener("click", (event) => {
    if (event.target.closest("#insightFollowup")) queueDueFollowups();
  });
}

elements.exportOutbox.addEventListener("click", exportOutbox);
elements.exportWhatsappQueue.addEventListener("click", exportWhatsappQueue);

elements.saveCampaignSnapshot.addEventListener("click", () => {
  saveCurrentCampaignSnapshot();
  saveState();
  render();
});

elements.newManagedCampaign.addEventListener("click", () => {
  createManagedCampaign();
  saveState();
  render();
});

elements.runManagementJobs.addEventListener("click", () => {
  runPendingManagementJobs();
});

elements.resetJobs.addEventListener("click", () => {
  resetManagementJobs();
  saveState();
  render();
});

elements.approveAll.addEventListener("click", () => {
  approveAllManagementItems();
  saveState();
  render();
});

elements.saveRules.addEventListener("click", () => {
  saveManagementRules();
  saveState();
  render();
});

elements.exportManagement.addEventListener("click", exportManagement);

elements.runRelay.addEventListener("click", runCrossChannelRelay);

const pullRepliesBtn = $("#pullReplies");
if (pullRepliesBtn) {
  pullRepliesBtn.addEventListener("click", () => runAsyncButton(pullRepliesBtn, "拉取中…", () => pullInboundReplies()));
}

elements.markAllRead.addEventListener("click", () => {
  const activeIds = activeProspectIdSet();
  state.inbound = state.inbound.map((item) => (activeIds.has(item.prospectId) ? { ...item, read: true } : item));
  addLog("收件箱已全部标记已读");
  saveState();
  render();
});

[elements.relayEmailToWa, elements.relayWaToEmail, elements.relayEmailDays, elements.relayWaDays].forEach(
  (input) => {
    input.addEventListener("change", () => {
      readInboxRulesFromForm();
      saveState();
      renderInbox();
    });
  }
);

[elements.relayModeRelay, elements.relayModeParallel].forEach((button) => {
  if (!button) return;
  button.addEventListener("click", () => {
    state.relay.mode = button.dataset.relayMode;
    addLog(
      state.relay.mode === "parallel"
        ? "已切换为协同模式：之后入队的客户会同时排邮件与「提醒查收邮件」的 WhatsApp（仅限适合 WhatsApp 的市场，每条仍需人工确认）"
        : "已切换为接力模式：只发邮件，超时未回才转 WhatsApp"
    );
    saveState();
    renderInbox();
    renderLogs();
  });
});

elements.conversationFilter.addEventListener("input", debounce(renderInbox));
elements.conversationStatusFilter.addEventListener("change", renderInbox);

elements.conversationList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-conversation-id]");
  if (!row) return;
  state.selectedConversationId = row.dataset.conversationId;
  markConversationRead(state.selectedConversationId);
  saveState();
  renderInbox();
});

elements.scheduleFollowupsCrm.addEventListener("click", () => {
  scheduleFollowupTasks(true);
  saveState();
  render();
});

elements.exportCrm.addEventListener("click", exportCrm);

elements.simulateCallbacks.addEventListener("click", simulateChannelCallbacks);
elements.exportAnalytics.addEventListener("click", exportAnalytics);

document.querySelectorAll(".test-webhook").forEach((button) => {
  button.addEventListener("click", () => testWebhook(button.dataset.webhook));
});

elements.dispatchWebhooks.addEventListener("click", dispatchPending);

elements.autopilotToggle.addEventListener("click", () => {
  setAutopilot(!state.autopilot?.enabled);
});

elements.sendDueBtn.addEventListener("click", async () => {
  await sendDueEmails();
  saveState();
  render();
});

// 发信队列：批量审批发送 + 全选（事件委托，控件随 renderOutbox 重绘）
elements.outboxList.addEventListener("click", (event) => {
  if (event.target.closest("#batchApproveSend")) {
    batchApproveSend();
  }
});
elements.outboxList.addEventListener("change", (event) => {
  if (event.target.id === "outboxSelectAll") {
    const checked = event.target.checked;
    elements.outboxList.querySelectorAll("input[data-outbox-id]").forEach((box) => {
      box.checked = checked;
    });
  }
});

elements.themeToggle.addEventListener("click", toggleTheme);
elements.openPaletteBtn.addEventListener("click", openPalette);

elements.aiWriteEmail.addEventListener("click", generateSequenceAI);
elements.testAiEngine.addEventListener("click", testAiEngineConnection);

/* ---------- AI Agent 事件 ---------- */

elements.agentParse.addEventListener("click", () =>
  runAsyncButton(elements.agentParse, "解析中…", () => parseAgentTask())
);

elements.agentTaskCard.addEventListener("click", (event) => {
  const task = state.agent.task;
  if (!task) return;
  const modeBtn = event.target.closest("[data-approval-mode]");
  if (modeBtn) {
    task.approvalMode = modeBtn.dataset.approvalMode;
    elements.agentTaskCard
      .querySelectorAll("[data-approval-mode]")
      .forEach((b) => b.classList.toggle("is-active", b === modeBtn));
    saveState();
    return;
  }
  const action = event.target.closest("[data-agent-action]")?.dataset.agentAction;
  if (action === "confirm") confirmAgentTask();
  else if (action === "discard") {
    state.agent.task = null;
    state.agent.approvals = [];
    saveState();
    render();
  }
});

elements.agentTaskCard.addEventListener("change", (event) => {
  const rec = agentRecurring();
  if (!rec) return;
  if (event.target.id === "agentRecurEnabled") {
    rec.enabled = event.target.checked;
    addLog(rec.enabled ? "周期自动补量已开启（需配合自动驾驶或点「立即补充」）" : "周期自动补量已关闭");
    saveState();
    render();
  } else if (event.target.id === "agentRecurInterval") {
    rec.interval = event.target.value;
    saveState();
  } else if (event.target.id === "agentRecurPer") {
    rec.perCycle = clamp(Number(event.target.value) || 20, 1, 200);
    saveState();
  } else if (event.target.id === "agentRecurWebSearch") {
    rec.useWebSearch = event.target.checked;
    if (rec.useWebSearch && !aiEnabled()) addLog("已勾选联网找客户，但尚未配置 Claude API（设置 → AI 引擎），周期到点会先降级到生成器/采集 Webhook");
    else addLog(rec.useWebSearch ? "周期补量将用 Claude 联网找真实客户" : "周期补量改用生成器/采集 Webhook");
    saveState();
    render();
  }
});

elements.agentTaskCard.addEventListener("click", (event) => {
  if (event.target.closest("#agentRunCycleNow")) agentRunCycle(true);
});

elements.agentApprovalList.addEventListener("click", async (event) => {
  const approveId = event.target.closest("[data-agent-approve]")?.dataset.agentApprove;
  const skipId = event.target.closest("[data-agent-skip]")?.dataset.agentSkip;
  if (!approveId && !skipId) return;
  const approval = state.agent.approvals.find((a) => a.id === (approveId || skipId));
  if (!approval) return;
  if (approveId) {
    await agentApprove(approval);
  } else {
    approval.status = "skipped";
    addLog("已跳过该客户");
    if (!state.agent.approvals.some((a) => a.status === "pending")) state.agent.task.status = "outreach";
  }
  saveState();
  render();
});

elements.agentApproveAll.addEventListener("click", async () => {
  const pending = state.agent.approvals.filter((a) => a.status === "pending");
  for (const approval of pending) {
    await agentApprove(approval, true);
  }
  addLog(`Agent 批量审批处理完成：${pending.length} 个触达方案已过审，预检失败项会保留待处理`);
  saveState();
  render();
});

elements.agentHandoff.addEventListener("click", (event) => {
  const id = event.target.closest("[data-agent-takeover]")?.dataset.agentTakeover;
  if (!id) return;
  state.selectedConversationId = id;
  markConversationRead(id);
  saveState();
  render();
  navigateTo("inbox");
});

elements.agentDemoData.addEventListener("click", () => {
  const task = state.agent.task;
  if (!task || task.status === "draft") {
    addLog("请先解析并确认任务卡片，再体验演示数据");
    return;
  }
  const targetCount = clamp(task.parsed?.daily_limit || 16, 1, 50);
  const generated = generateProspects(state.campaign, targetCount);
  const seen = new Set(state.prospects.map((p) => p.website || p.company.toLowerCase()));
  const fresh = generated.filter((p) => {
    const key = p.website || p.company.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const admitted = admitProspects(fresh, "演示采集");
  state.prospects = [...admitted, ...state.prospects];
  agentOnProspectsImported(admitted);
  addLog(`演示采集：注入 ${admitted.length} 家模拟企业（真实使用请通过搜索导入或采集 Webhook）`);
  saveState();
  render();
});

elements.agentReset.addEventListener("click", () => {
  if (!state.agent.task) return;
  state.agent.task = null;
  state.agent.approvals = [];
  addLog("Agent 任务已结束（已导入的线索与会话全部保留）");
  saveState();
  render();
});

if (elements.agentRespondLive) {
  elements.agentRespondLive.addEventListener("change", () => {
    state.agent.autoRespondLive = elements.agentRespondLive.checked;
    addLog(
      state.agent.autoRespondLive
        ? "AI 应答已切换为【直发】：标准问题回复不再等审批（敏感话题仍转人工）"
        : "AI 应答已切回【试运行】：应答先进队列等你审批"
    );
    saveState();
    render();
  });
}

elements.agentAutoRespond.addEventListener("change", () => {
  state.agent.autoRespond = elements.agentAutoRespond.checked;
  addLog(
    state.agent.autoRespond
      ? "AI 初轮自动应答已开启（试运行：应答先进队列等你审批；敏感话题仍转人工，opt-out 即时生效）"
      : "AI 初轮自动应答已关闭"
  );
  saveState();
  render();
});

elements.agentSaveKb.addEventListener("click", () => {
  state.campaign.knowledgeBase = elements.agentKnowledgeBase.value.trim();
  addLog("产品知识库已保存，将用于 AI 初轮应答与深度写信");
  saveState();
  renderLogs();
});

[elements.aiLocalMode, elements.aiCloudMode].forEach((button) => {
  if (!button) return;
  button.addEventListener("click", () => {
    readSettingsFromForm();
    state.settings.aiEngine = button.dataset.aiEngine; // local | cloud
    applyAiProviderToForm();
    saveState();
    updateAiEngineButtons();
    addLog(
      state.settings.aiEngine === "cloud"
        ? aiEnabled()
          ? `AI 引擎已切换为云端大模型（${aiProviderConf().label}）`
          : `AI 引擎已切换为云端大模型（${aiProviderConf().label}）——请填 API Key 并点「测试连接」`
        : "AI 引擎已切换为本地规则"
    );
    renderLogs();
  });
});

// 服务商切换：重置模型为该服务商默认、刷新地址提示/自定义 Base URL 显隐
elements.aiProviderSelect?.addEventListener("change", () => {
  readSettingsFromForm();
  const conf = aiProviderConf();
  // 换服务商后原模型名多半不适用，若非自定义则回落到该商默认模型
  if (aiProviderId() !== "custom" && !aiModelCatalog().includes(state.settings.aiModel)) {
    state.settings.aiModel = aiModelCatalog()[0] || "";
  }
  applyAiProviderToForm();
  saveState();
  updateAiEngineButtons();
  addLog(`已选择 AI 服务商：${conf.label}`);
  renderLogs();
});

elements.aiBaseUrlInput?.addEventListener("change", () => {
  readSettingsFromForm();
  saveState();
  // 填/清中转地址会改变「这份清单全不全」的答案，说明文案要跟着变
  renderAiModelNote();
});

// 选到「自定义模型名…」时展开手填框；其余情况直接落库
elements.aiModelSelect?.addEventListener("change", () => {
  applyAiModelCustomRow();
  readSettingsFromForm();
  saveState();
  updateAiEngineButtons();
});

elements.aiModelCustomInput?.addEventListener("change", () => {
  readSettingsFromForm();
  saveState();
  updateAiEngineButtons();
});

elements.aiModelFetch?.addEventListener("click", () => fetchAiModels());

// ---------- 每周战报 ----------
elements.weeklyReportBtn?.addEventListener("click", () => openWeeklyReport());
elements.reportOverlay?.addEventListener("click", (event) => {
  if (event.target === elements.reportOverlay) {
    elements.reportOverlay.hidden = true;
    return;
  }
  const action = event.target.closest("[data-report-action]");
  if (!action) return;
  if (action.dataset.reportAction === "close") elements.reportOverlay.hidden = true;
  else if (action.dataset.reportAction === "copy") copyWeeklyReport(action);
});

// ---------- 产品库 + 报价单 ----------
elements.openQuoteBuilder?.addEventListener("click", () => openQuoteBuilder());

elements.customsPanel?.addEventListener("click", (event) => {
  const act = event.target.closest("[data-customs]")?.dataset.customs;
  if (act === "search") runCustomsShipperQuery();
  else if (act === "admit") admitCustomsBuyers();
  else if (act === "clear") {
    mkdModal({
      title: "清空本地提单库？",
      body: `<p>会删掉所有已导入的原始提单记录。<strong>线索池里的客户不受影响</strong>，但按供应商反查将失去数据基础，要重新导入 CSV。</p>`,
      actions: [
        { label: "取消", kind: "ghost", autofocus: true },
        {
          label: "清空",
          kind: "danger",
          onClick: async () => {
            await mkdBridge().customsClear();
            customsQueryResult = null;
            addLog("本地提单库已清空");
            renderCustomsPanel();
            renderLogs();
          }
        }
      ]
    });
  }
});

elements.customsPanel?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.id === "customsShipperInput") {
    event.preventDefault();
    runCustomsShipperQuery();
  }
});

elements.mailConfig?.addEventListener("click", (event) => {
  const test = event.target.closest("[data-mail-test]");
  if (test) {
    testMailConn(test.dataset.mailTest);
    return;
  }
  const act = event.target.closest("[data-mail-action]")?.dataset.mailAction;
  if (act === "save") saveMailConfig();
  else if (act === "clear") {
    mkdBridge()
      ?.mailClear()
      .then((res) => {
        MKD_MAIL = res.summary;
        renderMailConfig();
        addLog("已清除保存的收发信凭据");
        renderLogs();
      });
  }
});

elements.backgroundOptions?.addEventListener("change", (event) => {
  const box = event.target.closest("[data-bg]");
  if (box) setBackgroundPref(box.dataset.bg, box.checked);
});

elements.quoteManager?.addEventListener("click", (event) => {
  const open = event.target.closest("[data-quote-open]");
  if (!open) return;
  const quote = state.quotes.find((q) => q.id === open.dataset.quoteOpen);
  if (quote) showQuoteDoc(quote);
});

elements.productManager?.addEventListener("click", (event) => {
  if (event.target.closest('[data-product-action="add"]')) {
    addProductFromForm();
    return;
  }
  const del = event.target.closest("[data-product-del]");
  if (del) {
    const id = del.dataset.productDel;
    const p = state.products.find((x) => x.id === id);
    state.products = state.products.filter((x) => x.id !== id);
    addLog(`已删除产品：${p ? p.model : id}`);
    saveState();
    renderProducts();
  }
});

elements.quoteOverlay?.addEventListener("click", (event) => {
  if (event.target === elements.quoteOverlay) {
    elements.quoteOverlay.hidden = true;
    return;
  }
  const action = event.target.closest("[data-quote-action]");
  if (!action) return;
  const kind = action.dataset.quoteAction;
  if (kind === "close") elements.quoteOverlay.hidden = true;
  else if (kind === "add-line") addCustomQuoteLine();
  else if (kind === "generate") generateQuote();
  else if (kind === "print") window.print();
  else if (kind === "send") queueQuoteEmail(action.dataset.quoteId);
  else if (kind === "copy") copyQuoteText(action.dataset.quoteId, action);
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (elements.paletteOverlay.hidden) openPalette();
    else closePalette();
    return;
  }
  if (!elements.paletteOverlay.hidden) {
    if (event.key === "Escape") {
      closePalette();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      paletteIndex = Math.min(paletteIndex + 1, Math.max(0, paletteItemsCache.length - 1));
      renderPalette();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      paletteIndex = Math.max(paletteIndex - 1, 0);
      renderPalette();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPaletteItem(paletteIndex);
    }
    return;
  }
  if (event.key === "Escape" && !elements.crmDrawerOverlay.hidden) closeCrmDrawer();
});

elements.paletteInput.addEventListener("input", () => {
  paletteIndex = 0;
  renderPalette();
});

elements.paletteResults.addEventListener("click", (event) => {
  const item = event.target.closest("[data-palette-index]");
  if (item) runPaletteItem(Number(item.dataset.paletteIndex));
});

elements.paletteOverlay.addEventListener("click", (event) => {
  if (event.target === elements.paletteOverlay) closePalette();
});

elements.analyticsRange.addEventListener("click", (event) => {
  const segment = event.target.closest("[data-range]");
  if (!segment) return;
  state.ui = { ...(state.ui || {}), analyticsRange: segment.dataset.range };
  saveState();
  renderAnalytics();
});

elements.crmBoard.addEventListener("click", (event) => {
  if (Date.now() - crmLastDragAt < 300) return;
  const card = event.target.closest(".crm-card[data-prospect-id]");
  if (card) openCrmDrawer(card.dataset.prospectId);
});

elements.crmDrawerOverlay.addEventListener("click", (event) => {
  if (event.target === elements.crmDrawerOverlay) {
    closeCrmDrawer();
    return;
  }
  if (event.target.closest("[data-drawer-close]")) {
    closeCrmDrawer();
    return;
  }
  const gotoBtn = event.target.closest("[data-drawer-goto]");
  if (gotoBtn && crmDrawerProspectId) {
    state.selectedProspectId = crmDrawerProspectId;
    state.selectedConversationId = crmDrawerProspectId;
    saveState();
    render();
    navigateTo(gotoBtn.dataset.drawerGoto);
    closeCrmDrawer();
  }
});

elements.crmDrawerOverlay.addEventListener("change", (event) => {
  const prospect = state.prospects.find((p) => p.id === crmDrawerProspectId);
  if (!prospect) return;
  if (event.target.id === "drawerStage") {
    prospect.dealStage = event.target.value;
    addLog(`商机推进：${prospect.company} → ${prospect.dealStage}`);
    saveState();
    render();
    renderCrmDrawer();
  } else if (event.target.id === "drawerValue") {
    prospect.dealValue = Math.max(0, Number(event.target.value) || 0);
    saveState();
    render();
    renderCrmDrawer();
  }
});

// 用时间戳抑制拖拽后的误触 click（布尔标志在 drop 重渲染后可能因 dragend 无法冒泡而卡死）
let crmLastDragAt = 0;

elements.crmBoard.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-prospect-id]");
  if (!card) return;
  crmLastDragAt = Date.now();
  event.dataTransfer.setData("text/plain", card.dataset.prospectId);
  event.dataTransfer.effectAllowed = "move";
  card.classList.add("dragging");
});

elements.crmBoard.addEventListener("dragend", (event) => {
  crmLastDragAt = Date.now();
  event.target.closest("[data-prospect-id]")?.classList.remove("dragging");
});

elements.crmBoard.addEventListener("dragover", (event) => {
  const column = event.target.closest("[data-stage]");
  if (!column) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  column.classList.add("drag-over");
});

elements.crmBoard.addEventListener("dragleave", (event) => {
  const column = event.target.closest("[data-stage]");
  if (column && !column.contains(event.relatedTarget)) column.classList.remove("drag-over");
});

elements.crmBoard.addEventListener("drop", (event) => {
  crmLastDragAt = Date.now();
  const column = event.target.closest("[data-stage]");
  if (!column) return;
  event.preventDefault();
  column.classList.remove("drag-over");
  const prospectId = event.dataTransfer.getData("text/plain");
  const stage = column.dataset.stage;
  const prospect = state.prospects.find((item) => item.id === prospectId);
  if (!prospect || prospect.dealStage === stage) return;
  prospect.dealStage = stage;
  if (stage === "已回复" && prospect.status !== "已回复") prospect.status = "已回复";
  addLog(`商机推进：${prospect.company} → ${stage}`);
  saveState();
  render();
});

elements.inboxLayout.addEventListener("input", (event) => {
  if (event.target.id === "quickReplyText") {
    quickReplyDrafts[state.selectedConversationId] = event.target.value;
  }
});

elements.inboxLayout.addEventListener("keydown", (event) => {
  if (event.target.id === "quickReplyText" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    const channel =
      document.querySelector(".quick-reply [data-reply-channel].is-active")?.dataset.replyChannel || "email";
    sendQuickReply(state.selectedConversationId, channel, event.target.value);
  }
});

elements.inboxLayout.addEventListener("click", async (event) => {
  const channelBtn = event.target.closest("[data-reply-channel]");
  if (channelBtn) {
    quickReplyChannels[state.selectedConversationId] = channelBtn.dataset.replyChannel;
    renderInbox();
    return;
  }
  const action = event.target.closest("[data-inbox-action]")?.dataset.inboxAction;
  if (!action) return;
  const prospectId = state.selectedConversationId;
  const prospect = state.prospects.find((item) => item.id === prospectId);

  if (action === "send-quick-reply") {
    const textEl = document.querySelector("#quickReplyText");
    const channel =
      document.querySelector(".quick-reply [data-reply-channel].is-active")?.dataset.replyChannel || "email";
    sendQuickReply(prospectId, channel, textEl?.value || "");
    return;
  }

  if (action === "ai-analyze") {
    addLog("Claude 分析中…");
    renderLogs();
    enrichInboundWithAI(prospectId, true);
    return;
  }

  if (action === "copy-suggestion") {
    const suggestion = getSuggestionForConversation(prospectId);
    if (suggestion) {
      await copyText(suggestion.text);
      addLog(`已复制 AI 建议回复：${suggestion.conversation.company}`);
      saveState();
      renderLogs();
    }
    return;
  }

  if (action === "simulate-reply") {
    simulateInboundReply(prospectId);
  } else if (action === "adopt-suggestion") {
    adoptSuggestedReply(prospectId);
  } else if (action === "relay-wa" && prospect) {
    if (!createRelayWhatsapp(prospect)) addLog("无法生成 WhatsApp 接力：缺少号码或已存在");
  } else if (action === "relay-email" && prospect) {
    if (!createRelayEmail(prospect)) addLog("无法生成邮件接力：缺少邮箱或已存在");
  } else if (action === "mark-read") {
    markConversationRead(prospectId);
    addLog("会话已标记已读");
  }

  saveState();
  render();
});

elements.campaignManager.addEventListener("click", (event) => {
  const renameId = event.target.closest("[data-campaign-rename]")?.dataset.campaignRename;
  const deleteId = event.target.closest("[data-campaign-delete]")?.dataset.campaignDelete;
  const openId = event.target.closest("[data-campaign-id]")?.dataset.campaignId;
  if (renameId) renameManagedCampaign(renameId);
  else if (deleteId) deleteManagedCampaign(deleteId);
  else if (openId) {
    if (openId === state.activeCampaignId) return; // 已是当前活动
    activateManagedCampaign(openId);
  } else return;
  saveState();
  render();
});

[elements.localMode, elements.directMode, elements.webhookMode].forEach((button) => {
  if (!button) return;
  button.addEventListener("click", () => {
    state.settings.mode = button.dataset.mode;
    updateModeButtons();
    renderStatus();
    saveState();
  });
});

elements.saveSettings.addEventListener("click", () => {
  readSettingsFromForm();
  addLog("自动化接口设置已保存");
  saveState();
  render();
});

// 刷新页面后恢复自动驾驶
if (state.autopilot?.enabled) startAutopilotTimer();

// 双标签页保护：另一个标签页改了数据 → 本页的内存状态已过期，继续操作会互相覆盖
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  if (document.getElementById("multiTabWarn")) return;
  const tip = document.createElement("div");
  tip.id = "multiTabWarn";
  tip.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:9999;padding:12px 16px;background:#b42318;color:#fff;font-size:14px;text-align:center;font-weight:700;";
  tip.textContent = "检测到系统在另一个标签页被修改——请只保留一个标签页操作，并刷新本页（继续在本页操作会互相覆盖数据）";
  document.body.appendChild(tip);
});

// 备份提醒：有真实数据且超过 7 天没备份 → 开屏提醒导出
(() => {
  if (!state.prospects.length) return;
  const last = state.ui?.lastBackupAt ? new Date(state.ui.lastBackupAt).getTime() : 0;
  if (Date.now() - last > 7 * 86400000) {
    setTimeout(() => {
      addLog(`📦 已超过 ${last ? Math.floor((Date.now() - last) / 86400000) + " 天" : "很久"}没备份：数据存在浏览器里，清缓存会丢。点右上角「导出全部数据」备份一份（含黑名单）`);
    }, 1500);
  }
})();

// ---------- 首次欢迎向导：新用户一进来给两条明路（先看演示 / 直接开始）----------
function closeWelcome() {
  if (elements.welcomeOverlay) elements.welcomeOverlay.hidden = true;
  state.ui = { ...(state.ui || {}), welcomeSeen: true };
  saveState();
}
function startPersonalCampaign() {
  state.campaign = {
    ...state.campaign,
    product: "",
    markets: "",
    customerType: "importer distributor",
    valueProps: "",
    certifications: "",
    senderName: "",
    companyName: "",
    originCity: "",
    focusProduct: "",
    productTerms: [],
    productProfile: null,
    buyerHint: "",
    hsCode: "",
    productDescription: "",
    focusConfirmed: ""
  };
  state.searchPlan = [];
  state.prospects = [];
  state.selectedProspectId = null;
  state.sequence = [];
  state.whatsappSequence = [];
  state.outbox = [];
  state.whatsappQueue = [];
  state.tasks = [];
  state.inbound = [];
  state.selectedConversationId = null;
  state.agent = { task: null, approvals: [], autoRespond: state.agent?.autoRespond || false };
  if (state.management?.campaigns?.length) {
    state.management.campaigns = state.management.campaigns.map((campaign) =>
      campaign.id === state.activeCampaignId
        ? {
            ...campaign,
            name: "我的第一个开发活动",
            product: "",
            markets: "",
            customerType: "importer distributor",
            valueProps: "",
            certifications: "",
            owner: "",
            companyName: "",
            originCity: "",
            dailyLimit: state.campaign.dailyLimit || 30,
            presetKey: null
          }
        : campaign
    );
  }
  state.ui = { ...(state.ui || {}), starterTemplate: false, personalStarted: true };
  bindCampaignForm();
}
if (elements.welcomeLater) elements.welcomeLater.addEventListener("click", closeWelcome);
if (elements.welcomeStart) {
  elements.welcomeStart.addEventListener("click", () => {
    closeWelcome();
    startPersonalCampaign();
    navigateTo("dashboard");
    elements.campaignForm?.scrollIntoView({ block: "start", behavior: "auto" });
    elements.productInput?.focus({ preventScroll: true });
    addLog("已进入空白开发活动：先填产品和目标市场，再生成获客计划");
    saveState();
    render();
  });
}
if (elements.welcomeDemo) {
  elements.welcomeDemo.addEventListener("click", () => {
    closeWelcome();
    state.ui = { ...(state.ui || {}), starterTemplate: false, demoStarted: true };
    // 表单为空时填一组示例（摩配打美国/尼日利亚），让演示更真实
    if (elements.productInput && !elements.productInput.value.trim()) {
      elements.productInput.value = "motorcycle parts (CG125/GN125)";
      if (elements.marketsInput) elements.marketsInput.value = "United States, Nigeria";
      if (elements.valuePropsInput && !elements.valuePropsInput.value.trim()) {
        elements.valuePropsInput.value = "OEM-level quality, container mixing, SONCAP certification";
      }
    }
    navigateTo("dashboard");
    window.scrollTo({ top: 0, behavior: "auto" });
    // 复用「一键起量」：未配 AI 时会用演示数据铺线索并跑通到发信队列
    if (elements.oneClickPipeline) {
      runAsyncButton(elements.oneClickPipeline, "起量中…", () => runOneClickPipeline());
    }
  });
}
// 点背景空白处也可关闭
if (elements.welcomeOverlay) {
  elements.welcomeOverlay.addEventListener("click", (event) => {
    if (event.target === elements.welcomeOverlay) closeWelcome();
  });
}

// 首次渲染（放在文件末尾，确保 render 依赖的所有模块级 const 已初始化）
render();
if (stateNeedsInitialSave) {
  saveState();
  stateNeedsInitialSave = false;
}

// 全新用户（没看过向导、也还没有线索）→ 弹欢迎向导
if (!state.ui?.welcomeSeen && !state.prospects.length && elements.welcomeOverlay) {
  elements.welcomeOverlay.hidden = false;
}

/* ============================================================================
 * 觅客舵 · 商业化基建（F1–F9）
 *
 * 本文件排在最后，此时 state / elements / render 全部就绪，可以直接绑 DOM。
 * 对既有业务函数的增强一律用"包一层"的方式（保留原函数再重新赋值），
 * 不散落改动到 01–07，方便后续对照上游版本。
 * ==========================================================================*/

/* ---------- 通用弹窗（B6 规范：480 表单 / 640 内容型；Esc 关闭；危险弹窗焦点在取消） ---------- */

let mkdModalStack = [];

function mkdModal({ title, body, actions = [], width = 480, danger = false, dismissible = true, onClose }) {
  const overlay = document.createElement("div");
  overlay.className = "mkd-overlay";
  overlay.innerHTML = `
    <div class="mkd-dialog${danger ? " is-danger" : ""}" role="dialog" aria-modal="true" style="width:${width}px">
      <div class="mkd-dialog-head"><h3>${title}</h3></div>
      <div class="mkd-dialog-body">${body}</div>
      <div class="mkd-dialog-foot"></div>
    </div>`;
  const foot = overlay.querySelector(".mkd-dialog-foot");
  const close = () => {
    overlay.remove();
    mkdModalStack = mkdModalStack.filter((m) => m !== overlay);
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === "Escape" && dismissible && mkdModalStack[mkdModalStack.length - 1] === overlay) close();
  };

  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      (action.kind === "primary" ? "primary-button" : action.kind === "danger" ? "ghost-button danger-button" : "ghost-button") +
      (action.large ? " is-lg" : ""); // B6：40px 档只用于激活与购买场景
    button.innerHTML = `<span>${action.label}</span>`;
    button.addEventListener("click", () => {
      if (action.keepOpen) action.onClick?.(overlay, close);
      else {
        close();
        action.onClick?.(overlay);
      }
    });
    if (action.autofocus) setTimeout(() => button.focus(), 30);
    foot.appendChild(button);
  });

  if (dismissible && !danger) {
    // B6：危险确认弹窗不许点遮罩关掉——误点关掉和误点确认一样糟
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
  }

  // F 部分走查：弹窗焦点圈定。Tab 不能跑到弹窗外面去
  overlay.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusables = [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.disabled && el.offsetParent !== null
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  mkdModalStack.push(overlay);
  return { overlay, close };
}

/* ============================================================================
 * F1 激活码系统
 * ==========================================================================*/

let activationFailCount = 0;

function openActivation() {
  const bridge = mkdBridge();
  if (!bridge) {
    mkdModal({
      title: "激活需要在桌面版进行",
      body: `<p>你现在是用浏览器直接打开页面的，浏览器读不到本机机器码，没法激活。</p>
             <p>用桌面版（安装后的「${BRAND.name}」快捷方式）打开，激活入口在同一个位置。两边数据不互通，请以桌面版为准。</p>`,
      actions: [{ label: "知道了", kind: "primary", autofocus: true }]
    });
    return;
  }

  const machine = MKD_MACHINE?.code || "读取中…";
  const { overlay } = mkdModal({
    title: `激活${BRAND.name}`,
    width: 480,
    body: `
      <label class="mkd-field">
        <span>本机机器码</span>
        <div class="mkd-machine">
          <code id="mkdMachineCode">${escapeHtml(machine)}</code>
          <button class="ghost-button" type="button" id="mkdCopyMachine"><span>复制</span></button>
        </div>
      </label>
      <p class="mkd-hint">把机器码发给客服，换取你的激活码。一个激活码可绑定两台设备。</p>
      <label class="mkd-field">
        <span>激活码</span>
        <textarea id="mkdCodeInput" rows="3" spellcheck="false" placeholder="XXXXXXXX-XXXXXXXX-…（共 14 段，直接粘贴即可，空格和换行会自动清理）"></textarea>
      </label>
      <p class="mkd-error" id="mkdActivateError" hidden></p>
      <div id="mkdSupportCard" hidden class="mkd-support">
        <strong>连续 3 次没通过，直接找人</strong>
        <p>客服微信：<code>${BRAND.supportWechat}</code>（把机器码和报错截图一起发过来，通常 10 分钟内解决）</p>
      </div>`,
    actions: [
      { label: "稍后", kind: "ghost", large: true },
      {
        label: "激活",
        kind: "primary",
        large: true,
        keepOpen: true,
        onClick: async (root, doClose) => {
          const input = root.querySelector("#mkdCodeInput");
          const errorEl = root.querySelector("#mkdActivateError");
          const result = await bridge.activate(input.value);
          if (result.ok) {
            MKD_LICENSE = result.license;
            activationFailCount = 0;
            doClose();
            showActivationSuccess();
            return;
          }
          activationFailCount += 1;
          errorEl.hidden = false;
          errorEl.textContent =
            result.reason === "format"
              ? "激活码格式不对：应为 14 段、每段 8 位的字母数字。注意 O 与 0、I 与 1 抄混，建议直接从客服消息里复制粘贴。"
              : result.reason === "write"
                ? "验证通过但写入失败：可能是安装目录权限不足。用管理员身份重开一次，或联系客服。"
                : "激活码与本机不匹配：请核对是不是用这台电脑的机器码申请的。换过电脑要重新申请，旧码会作废。";
          if (activationFailCount >= 3) root.querySelector("#mkdSupportCard").hidden = false;
          pushOp("激活", "验证失败", result.reason);
        }
      }
    ]
  });

  overlay.querySelector("#mkdCopyMachine")?.addEventListener("click", async (event) => {
    await copyText(MKD_MACHINE?.code || "");
    event.currentTarget.querySelector("span").textContent = "已复制";
  });
  // 粘贴即清洗，避免用户看到一坨带换行的码而怀疑贴错了
  overlay.querySelector("#mkdCodeInput")?.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = (event.clipboardData || window.clipboardData).getData("text");
    event.target.value = String(text || "").replace(/\s+/g, "");
  });
  setTimeout(() => overlay.querySelector("#mkdCodeInput")?.focus(), 40);
}

function showActivationSuccess() {
  const splash = document.createElement("div");
  splash.className = "mkd-splash";
  splash.innerHTML = `
    <div class="mkd-splash-inner">
      <svg viewBox="0 0 24 24" class="mkd-anchor"><path d="M12 7v13"/><circle cx="12" cy="5" r="2"/><path d="M5 12h14"/><path d="M5 12a7 7 0 0 0 14 0"/></svg>
      <strong>激活成功 · 感谢支持独立开发</strong>
      <span>${editionLabel()} · 签发于 ${MKD_LICENSE.issuedAt}</span>
    </div>`;
  document.body.appendChild(splash);
  setTimeout(() => {
    splash.remove();
    addLog("试用期数据已完整保留，线索池上限已解除");
    pushOp("激活", "激活成功", MKD_LICENSE.tier);
    renderCommerceChrome();
    render();
  }, 800);
}

/* ============================================================================
 * F2 试用模式
 * ==========================================================================*/

// 第 21 条的墙。三个按钮：查看价格 / 输入激活码 / 先删几条腾位置——
// 第三个按钮是给用户的台阶，被墙时的敌意主要来自"无路可走"。
let trialWallOpen = false;

function openTrialWall({ rejected = 0, source = "" } = {}) {
  if (trialWallOpen) return;
  trialWallOpen = true;
  mkdModal({
    title: `试用版可联系 ${TRIAL_LEAD_CAP} 条线索`,
    width: 640,
    onClose: () => {
      trialWallOpen = false;
    },
    body: `
      <p>你找到的线索<strong>一条都没丢</strong>，池子里 ${state.prospects.length} 条全在，资料随时能看、能导出。
         试用版能补全并联系其中最早入池的 ${TRIAL_LEAD_CAP} 条。</p>
      ${rejected ? `<p class="mkd-hint">本次${source ? `从${source}` : ""}有 <strong>${rejected}</strong> 条进入锁定状态。</p>` : ""}
      <ul class="mkd-list">
        <li>可联系的名额算<strong>存量</strong>不是累计——删掉几条用不上的，锁定的会自动补位。</li>
        <li>激活后<strong>全部即时解锁</strong>，试用期跑出来的数据原样继承。</li>
        <li>功能一个都没锁，你可以完整跑通一遍再决定。</li>
      </ul>`,
    actions: [
      { label: "先删几条腾位置", onClick: () => navigateTo("prospects") },
      { label: "查看价格", large: true, onClick: () => openSalesPage() },
      { label: "输入激活码", kind: "primary", large: true, onClick: () => openActivation(), autofocus: true }
    ]
  });
}

function openSalesPage() {
  const bridge = mkdBridge();
  if (bridge) bridge.openExternal(BRAND.salesUrl);
  else window.open(BRAND.salesUrl, "_blank");
}

/* ---------- 顶栏活动切换器（D 部分：顶栏第一格） ---------- */

function isStarterCampaign() {
  return !!state.ui?.starterTemplate && !state.ui?.demoStarted && !state.ui?.personalStarted;
}

function activeCampaignName() {
  if (isStarterCampaign()) return "未配置开发活动";
  const list = state.management?.campaigns || [];
  return list.find((c) => c.id === state.activeCampaignId)?.name || state.campaign.product || "未命名活动";
}

function renderCampaignSwitch() {
  if (!elements.campaignSwitchName) return;
  elements.campaignSwitchName.textContent = activeCampaignName();
}

function openCampaignMenu() {
  const anchor = elements.campaignSwitch;
  if (!anchor || document.getElementById("mkdCampaignMenu")) return;
  const list = state.management?.campaigns || [];
  const menu = document.createElement("div");
  menu.id = "mkdCampaignMenu";
  menu.className = "mkd-menu";
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${rect.left}px`;
  menu.innerHTML = `
    ${list
      .map((c) => {
        const leads = state.prospects.filter((p) => p.campaignId === c.id).length;
        return `<button class="mkd-menu-item ${c.id === state.activeCampaignId ? "is-current" : ""}" data-campaign="${c.id}" type="button">
          <span class="mm-name">${escapeHtml(c.name)}</span>
          <span class="mm-meta">${leads} 条线索</span>
        </button>`;
      })
      .join("")}
    <div class="mkd-menu-sep"></div>
    <button class="mkd-menu-item" data-campaign-new="1" type="button"><span class="mm-name">＋ 新建开发活动</span></button>`;
  document.body.appendChild(menu);

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onOutside, true);
  };
  const onOutside = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  };
  document.addEventListener("mousedown", onOutside, true);

  menu.addEventListener("click", (event) => {
    const id = event.target.closest("[data-campaign]")?.dataset.campaign;
    const isNew = event.target.closest("[data-campaign-new]");
    close();
    if (isNew) {
      elements.newManagedCampaign?.click();
      navigateTo("management");
    } else if (id && id !== state.activeCampaignId) {
      activateManagedCampaign(id);
      saveState();
      render();
      addLog(`已切换到活动：${activeCampaignName()}`);
    }
  });
}

/* ---------- D1 本活动漏斗速览：线索 → 验证 → 触达 → 回复 → 询盘 ---------- */

// 来源徽章（B3）：真实验证绿描边 / AI 推测琥珀描边 / 规则推测灰描边。
// 琥珀那档永远与"未验证不可发"成对出现，所以描边色和 ⛔ 徽章是同一套语义。
function sourceBadge(source) {
  const key = source === "webhook" ? "real" : source === "claude-web" ? "real" : source === "claude" ? "ai" : "rule";
  return `<span class="src-badge is-${key}">${escapeHtml(contactSourceLabel(source))}</span>`;
}

function renderCampaignFunnel() {
  const host = document.getElementById("campaignFunnel");
  if (!host) return;
  const cid = state.activeCampaignId;
  const mine = state.prospects.filter((p) => !cid || !p.campaignId || p.campaignId === cid);
  const ids = new Set(mine.map((p) => p.id));

  const verified = mine.filter((p) => p.email && emailVerificationState(p, p.email) !== "guessed").length;
  const reached = new Set([
    ...state.outbox.filter((o) => o.status === "已发送" && ids.has(o.prospectId)).map((o) => o.prospectId),
    ...state.whatsappQueue.filter((w) => w.status === "已发送" && ids.has(w.prospectId)).map((w) => w.prospectId)
  ]).size;
  const replied = new Set(state.inbound.filter((m) => ids.has(m.prospectId)).map((m) => m.prospectId)).size;
  const inquiry = mine.filter((p) => ["询盘", "报价", "成交"].includes(p.dealStage)).length;

  const steps = [
    { key: "leads", label: "线索", n: mine.length, goto: "prospects", hint: "进池的目标客户" },
    { key: "verified", label: "验证", n: verified, goto: "prospects", hint: "邮箱可发信" },
    { key: "reached", label: "触达", n: reached, goto: "automation", hint: "真实发出过" },
    { key: "replied", label: "回复", n: replied, goto: "inbox", hint: "客户回过信" },
    { key: "inquiry", label: "询盘", n: inquiry, goto: "crm", hint: "进入商机管道" }
  ];

  const rate = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

  host.innerHTML = `
    <div class="panel-heading">
      <div>
        <p class="eyebrow">Funnel</p>
        <h2>本活动漏斗速览</h2>
      </div>
      <span class="funnel-scope">${escapeHtml(activeCampaignName())}</span>
    </div>
    <div class="funnel-row">
      ${steps
        .map(
          (s, i) => `
        ${i ? `<span class="funnel-arrow" title="上一环节转化率">${rate(s.n, steps[i - 1].n)}</span>` : ""}
        <button class="funnel-cell" data-goto="${s.goto}" type="button" title="${s.hint}">
          <span class="fc-num">${s.n}</span>
          <span class="fc-label">${s.label}</span>
        </button>`
        )
        .join("")}
    </div>`;
}

/* ---------- F6：发一封测试邮件给自己（课程第 2 章的自发自收硬指标） ---------- */

const SELF_TEST_ID = "prospect-self-test";

function openSelfTest() {
  const saved = state.ui?.selfTestEmail || "";
  const { overlay } = mkdModal({
    title: "先发一封给自己",
    width: 640,
    body: `
      <p>这一步是整条链路的体检：信真从你配的 SMTP 发出去了，也真回到了你的收件箱——发信基建才算通。</p>
      <p class="mkd-hint">课程第 2 章把它列为硬指标（自发自收闭环截图）。没跑通就往下发真实客户，等于蒙着眼睛开火。</p>
      <label class="mkd-field">
        <span>你自己的收信邮箱</span>
        <input id="mkdSelfTestEmail" type="email" value="${escapeHtml(saved)}" placeholder="填一个你能立刻打开看的邮箱，比如 QQ / Gmail" />
      </label>
      <p class="mkd-error" id="mkdSelfTestError" hidden></p>
      ${
        state.ui?.selfTestSentAt
          ? `<p class="mkd-hint">上次已发送：${new Date(state.ui.selfTestSentAt).toLocaleString("zh-CN", { hour12: false })}</p>`
          : ""
      }`,
    actions: [
      { label: "取消", kind: "ghost" },
      {
        label: "发送测试邮件",
        kind: "primary",
        autofocus: true,
        keepOpen: true,
        onClick: async (root, close) => {
          const email = root.querySelector("#mkdSelfTestEmail").value.trim();
          const errorEl = root.querySelector("#mkdSelfTestError");
          if (!emailLooksValid(email)) {
            errorEl.hidden = false;
            errorEl.textContent = "这个地址看着不像邮箱。填一个你能立刻打开查看的地址，比如 name@qq.com。";
            return;
          }
          close();
          await sendSelfTestEmail(email);
        }
      }
    ]
  });
  void overlay;
}

async function sendSelfTestEmail(email) {
  // 自测线索标 webhook 来源：这个地址是你自己填的，本来就是"已验证"，不该被 F3 拦
  const existing = state.prospects.find((p) => p.id === SELF_TEST_ID);
  const record = {
    id: SELF_TEST_ID,
    company: "（自测）我自己",
    market: "自测",
    source: "自发自收",
    website: (email.split("@")[1] || "").toLowerCase(),
    contactName: state.campaign.senderName || "本人",
    role: "自测收件人",
    email,
    emailStatus: "已验证",
    contactSource: "webhook",
    phone: "",
    phoneStatus: "待查找",
    status: "已丰富",
    score: 0,
    confidence: 100,
    buyingSignal: "发信基建自测",
    companySize: "—",
    searchQuery: "self-test",
    campaignId: state.activeCampaignId,
    selfTest: true
  };
  state.prospects = existing
    ? state.prospects.map((p) => (p.id === SELF_TEST_ID ? { ...p, ...record } : p))
    : [record, ...state.prospects]; // 自测线索不占试用额度，直接入池

  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  const item = {
    id: makeId("outbox"),
    prospectId: SELF_TEST_ID,
    company: record.company,
    email,
    label: "发信基建自测",
    subject: `${BRAND.name} 发信自测 · ${stamp}`,
    body: `This is a deliverability self-test sent from ${BRAND.name}.

如果你在收件箱（不是垃圾箱）看到这封信，说明：
1) SMTP 配置正确，信真的发出去了；
2) 你的发信域名当前能进收件箱。

接下来请照课程第 2 章做两件事：
- 把这封信的原始邮件头存一份，确认 SPF / DKIM / DMARC 三项都是 pass；
- 去 mail-tester 点 com 再测一次，8 分以上才开始发真实客户。

如果这封信进了垃圾箱，先别发客户——回去修 DNS 记录。

${UNSUBSCRIBE_LINE}`,
    dueDate: dateOffset(0),
    createdAt: new Date().toISOString(),
    status: "待发送",
    step: `self-test-${Date.now()}`,
    selfTest: true
  };
  state.outbox.push(item);

  const sent = await sendOutboxItems([item]);
  if (sent) {
    state.ui = { ...(state.ui || {}), selfTestEmail: email, selfTestSentAt: new Date().toISOString() };
    addLog(
      state.settings.mode === "webhook"
        ? `自测邮件已通过发信 Webhook 发往 ${maskEmail(email)}——去收件箱看有没有收到，进垃圾箱说明 DNS 还没配好`
        : `本地模拟模式：自测邮件只是模拟发送，没有真的出去。切到「设置 → 运行模式 → Webhook」并配好发信 Webhook 才能真正跑通自发自收`
    );
  } else {
    addLog("自测邮件没能发出——看看发信 Webhook 是否配好、今日额度是否还有剩余");
  }
  pushOp("引导", "发送自测邮件", sent ? "成功" : "失败");
  saveState();
  render();
}

/* ============================================================================
 * D2 潜客队列：筛选 / 多选 / 批量条 / 详情抽屉 / 待验证提示条
 * ==========================================================================*/

// B6：每个列表页的空态都要有插图 + 一句话 + 主按钮，禁止白屏
function emptyState(icon, title, desc, actions = []) {
  return `
    <div class="empty-state mkd-empty">
      <span class="mkd-empty-art"><svg><use href="#icon-${icon}" /></svg></span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(desc)}</p>
      <div class="mkd-empty-actions">
        ${actions
          .map(
            (a) =>
              `<button class="${a.primary ? "primary-button" : "ghost-button"}" ${
                a.goto ? `data-goto="${a.goto}"` : `data-empty-action="${a.action}"`
              } type="button"><span>${escapeHtml(a.label)}</span></button>`
          )
          .join("")}
      </div>
    </div>`;
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-empty-action]");
  if (!target) return;
  event.preventDefault();
  const action = target.dataset.emptyAction;
  if (action === "one-click") {
    navigateTo("dashboard");
    window.scrollTo({ top: 0, behavior: "auto" });
    if (!requireCampaignBrief("一键起量")) return;
    runAsyncButton(elements.oneClickPipeline, "起量中…", () => runOneClickPipeline());
    return;
  }
  if (action === "verify-blocked") {
    const blockedIds = new Set(
      activeOutboxItems()
        .filter((item) => ["待审批", "待发送"].includes(item.status) && !preflightOutboxItem(item).ok)
        .map((item) => item.prospectId)
    );
    const targets = activeProspects().filter((prospect) => blockedIds.has(prospect.id));
    if (!targets.length) return;
    const verified = verifyProspectList(targets, state.campaign);
    replaceProspectsById(verified);
    addLog(`已对 ${targets.length} 条阻断线索执行本地邮箱验证；真实验证请在设置接入邮箱查找/验证 Webhook`);
    saveState();
    navigateTo("prospects");
    if (elements.verifyFilter) elements.verifyFilter.value = "guessed";
    render();
  }
});

const mkdSelectedProspects = new Set();

function isProspectSelected(id) {
  return mkdSelectedProspects.has(id);
}

function visibleProspectIds() {
  return [...(elements.prospectTable?.querySelectorAll("[data-prospect-check]") || [])].map((c) => c.dataset.prospectCheck);
}

// 市场筛选的选项随线索池变化，重建时保留当前选择
function syncMarketFilterOptions() {
  const select = elements.marketFilter;
  if (!select) return;
  const markets = [...new Set(activeProspects().map((p) => p.market).filter(Boolean))].sort();
  const signature = markets.join("|");
  if (select.dataset.signature === signature) return;
  const current = select.value;
  select.dataset.signature = signature;
  select.innerHTML =
    `<option value="all">全部市场</option>` +
    markets.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
  select.value = markets.includes(current) ? current : "all";
}

// 待验证置顶提示条（与 F3 联动）：有多少条堵在验证上，一键只看它们或直接批量验证
function renderVerifyBanner() {
  const host = elements.prospectVerifyBanner;
  if (!host) return;
  const n = pendingVerifyCount();
  const filtering = elements.verifyFilter?.value === "guessed";
  if (!n) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `
    <div class="verify-banner">
      <span class="vb-icon">⛔</span>
      <span class="vb-text"><strong>${n} 条线索现在发不出去</strong>——邮箱是 AI 或规则推测的，没验证过。向未验证邮箱发信会推高退信率，损害你的发信域名信誉。</span>
      ${filtering ? "" : `<button class="ghost-button" data-verify-banner="filter" type="button"><span>只看这些</span></button>`}
      <button class="primary-button" data-verify-banner="verify" type="button"><span>批量验证</span></button>
    </div>`;
}

// 底部批量操作条：选中 n 条时从底部滑入
function renderProspectBulkBar() {
  const bar = elements.prospectBulkBar;
  if (!bar) return;
  // 已经不在池子里的选中项要清掉，否则计数会虚高
  const alive = activeProspectIdSet();
  [...mkdSelectedProspects].forEach((id) => {
    if (!alive.has(id)) mkdSelectedProspects.delete(id);
  });
  const n = mkdSelectedProspects.size;
  if (!n) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  const picked = activeProspects().filter((p) => mkdSelectedProspects.has(p.id));
  const blocked = picked.filter((p) => !p.email || emailVerificationState(p, p.email) === "guessed").length;
  bar.hidden = false;
  bar.innerHTML = `
    <span class="bb-count">已选 <b>${n}</b> 条</span>
    ${blocked ? `<span class="bb-warn">其中 ${blocked} 条未验证，入队后发不出去</span>` : ""}
    <span class="bb-spacer"></span>
    <button class="ghost-button" data-bulk="enrich" type="button"><span>批量补全联系方式</span></button>
    <button class="ghost-button" data-bulk="verify" type="button"><span>批量验证邮箱</span></button>
    <button class="primary-button" data-bulk="queue" type="button"><span>一键入队（${n}）</span></button>
    <button class="ghost-button" data-bulk="clear" type="button"><span>取消选择</span></button>`;
}

function toggleProspectSelection(id, on) {
  if (on) mkdSelectedProspects.add(id);
  else mkdSelectedProspects.delete(id);
  renderProspectBulkBar();
}

/* ---------- 详情抽屉 ---------- */

function openProspectDrawer(id) {
  if (id) state.selectedProspectId = id;
  renderProspectDetail();
  if (elements.prospectDrawerOverlay) elements.prospectDrawerOverlay.hidden = false;
  pushOp("潜客", "打开详情抽屉");
}

function closeProspectDrawer() {
  if (elements.prospectDrawerOverlay) elements.prospectDrawerOverlay.hidden = true;
}

// 质量分徽章点击 → 因子明细抽屉（B6）
function openGradeDrawer(id) {
  const prospect = state.prospects.find((p) => p.id === id);
  if (!prospect) return;
  const lead = computeLeadScore(prospect);
  mkdModal({
    title: `质量分 ${lead.grade} · ${lead.probability} 分是怎么算出来的`,
    width: 640,
    body: `
      <p>${escapeHtml(prospect.company)} —— 分数由下面这些因子加权得到，不是玄学。</p>
      <table class="mkd-table">
        <thead><tr><th>因子</th><th style="text-align:right">加减分</th></tr></thead>
        <tbody>
          ${(lead.factors || [])
            .map(
              (f) =>
                `<tr><td>${escapeHtml(f.label || f.reason || String(f))}</td><td style="text-align:right;color:${
                  (f.score ?? 0) >= 0 ? "var(--green)" : "var(--red)"
                }">${(f.score ?? 0) >= 0 ? "+" : ""}${f.score ?? ""}</td></tr>`
            )
            .join("") || `<tr><td colspan="2">这条线索还没有可解释的因子——先补全联系方式和采购信号。</td></tr>`}
        </tbody>
      </table>
      <p class="mkd-hint">A ≥80 ｜ B 65-79 ｜ C 50-64 ｜ D &lt;50。分数只排序不决策，最终发不发还是你点。</p>`,
    actions: [
      { label: "打开完整详情", onClick: () => openProspectDrawer(id) },
      { label: "关闭", kind: "primary", autofocus: true }
    ]
  });
}

/* ---------- D4：会话意向胶囊（B3 唯一使用全圆角胶囊的地方） ---------- */

// 🔥热=橙（询价/要样，立即接管）｜ 🌤温=蓝（回过信但没询价）｜ ❄️冷=灰（没回过）
function intentPill(conversation) {
  if (!conversation?.replied) return `<span class="ptag cold">❄️ 冷</span>`;
  const intent = typeof getConversationIntent === "function" ? getConversationIntent(conversation) : null;
  const hot = intent && ["price", "sample", "moq", "leadtime"].includes(intent.key);
  return hot ? `<span class="ptag hot">🔥 热</span>` : `<span class="ptag warm">🌤 温</span>`;
}

// 首个买家回复：记下是哪一条，渲染时脉冲一次，然后清掉（只演一次）
const __mkdBaseIngestInbound = ingestInboundMessage;
ingestInboundMessage = function (prospectId, channel, body, at) {
  const firstEver = !state.inbound.length && !state.ui?.firstReplyCelebrated;
  const result = __mkdBaseIngestInbound(prospectId, channel, body, at);
  if (firstEver) {
    state.ui = { ...(state.ui || {}), firstReplyCelebrated: true };
    mkdPulseConversationId = prospectId;
    setTimeout(() => {
      mkdPulseConversationId = null;
    }, 1200);
    addLog(`🎉 第一个买家回复到了：${state.prospects.find((p) => p.id === prospectId)?.company || ""}——去收件箱看意图识别和回复建议`);
  }
  return result;
};

/* ============================================================================
 * 第四轮：设置页锚点 / 骨架屏 / 长任务进度 / 撤销 Toast / 弹窗焦点圈定
 * ==========================================================================*/

/* ---------- D7 设置页左锚点导航 ---------- */

function bindSettingsAnchors() {
  const nav = document.getElementById("settingsNav");
  const body = document.querySelector("#settingsView .settings-body");
  if (!nav || !body || nav.dataset.bound) return;
  nav.dataset.bound = "1";

  nav.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-anchor]");
    if (!btn) return;
    document.getElementById(`anchor-${btn.dataset.anchor}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // 滚到哪一段，左边就高亮哪一条
  const mark = () => {
    const anchors = [...nav.querySelectorAll("[data-anchor]")];
    let current = anchors[0];
    anchors.forEach((a) => {
      const el = document.getElementById(`anchor-${a.dataset.anchor}`);
      if (el && el.getBoundingClientRect().top <= 140) current = a;
    });
    anchors.forEach((a) => a.classList.toggle("is-active", a === current));
  };
  window.addEventListener("scroll", () => {
    if (getActiveView() === "settings") mark();
  });
  mark();
}

/* ---------- B6 骨架屏：列表在算的时候先占位，不要闪白 ---------- */

function skeletonRows(n = 3) {
  return `<div class="mkd-skeleton">${Array.from({ length: n }, () => `<span class="sk-row"></span>`).join("")}</div>`;
}

/* ---------- B6 长任务：顶部细进度条 + 右下角可折叠日志（一键起量的"表演时刻"） ---------- */

let mkdTaskLogLines = [];

function taskProgressStart(title) {
  mkdTaskLogLines = [];
  let bar = document.getElementById("mkdProgress");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "mkdProgress";
    bar.className = "mkd-progress";
    bar.innerHTML = `<span class="mp-fill"></span>`;
    document.body.appendChild(bar);
  }
  bar.classList.add("is-on");
  let panel = document.getElementById("mkdTaskLog");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "mkdTaskLog";
    panel.className = "mkd-tasklog";
    panel.innerHTML = `
      <div class="tl-head"><strong id="mkdTaskLogTitle"></strong><button class="tl-toggle" data-tasklog-toggle type="button">收起</button></div>
      <div class="tl-lines" id="mkdTaskLogLines"></div>`;
    panel.addEventListener("click", (event) => {
      if (event.target.closest("[data-tasklog-toggle]")) {
        panel.classList.toggle("is-collapsed");
        panel.querySelector("[data-tasklog-toggle]").textContent = panel.classList.contains("is-collapsed") ? "展开" : "收起";
      }
    });
    document.body.appendChild(panel);
  }
  panel.classList.add("is-on");
  panel.querySelector("#mkdTaskLogTitle").textContent = title;
  panel.querySelector("#mkdTaskLogLines").innerHTML = "";
}

function taskProgressStep(pct, line) {
  const fill = document.querySelector("#mkdProgress .mp-fill");
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (!line) return;
  mkdTaskLogLines.push(line);
  const host = document.getElementById("mkdTaskLogLines");
  if (host) {
    host.insertAdjacentHTML("beforeend", `<p>${escapeHtml(line)}</p>`);
    host.scrollTop = host.scrollHeight;
  }
}

function taskProgressEnd(finalLine) {
  if (finalLine) taskProgressStep(100, finalLine);
  const bar = document.getElementById("mkdProgress");
  const panel = document.getElementById("mkdTaskLog");
  setTimeout(() => {
    bar?.classList.remove("is-on");
    const fill = bar?.querySelector(".mp-fill");
    if (fill) fill.style.width = "0%";
  }, 400);
  setTimeout(() => panel?.classList.remove("is-on"), 6000);
}

/* ---------- B6 带撤销的 Toast，停留 6 秒 ---------- */

function toastWithUndo(message, onUndo) {
  const host = elements.toastStack;
  if (!host) return;
  const node = document.createElement("div");
  node.className = "toast info has-undo";
  node.innerHTML = `<span>${escapeHtml(message)}</span><button type="button" class="toast-undo">撤销</button>`;
  const close = () => {
    node.classList.add("hide");
    setTimeout(() => node.remove(), 320);
  };
  node.querySelector(".toast-undo").addEventListener("click", () => {
    close();
    onUndo?.();
  });
  host.appendChild(node);
  setTimeout(close, 6000);
}

/* ---------- 顶栏试用角标 ---------- */

function renderTrialBadge() {
  const host = document.querySelector(".topbar-actions");
  if (!host) return;
  let badge = document.getElementById("mkdEditionBadge");
  if (!badge) {
    badge = document.createElement("button");
    badge.id = "mkdEditionBadge";
    badge.type = "button";
    badge.className = "mkd-edition-badge";
    badge.addEventListener("click", () => (isTrial() ? openActivation() : openAbout()));
    host.prepend(badge);
  }
  if (isTrial()) {
    const used = state.prospects.length;
    const locked = trialLockedCount();
    badge.classList.add("is-trial");
    badge.classList.remove("is-paid");
    badge.textContent = locked
      ? `试用版 · 可联系 ${TRIAL_LEAD_CAP}/${used} 🔒${locked}`
      : `试用版 · 线索 ${used}/${TRIAL_LEAD_CAP}`;
    badge.title = locked
      ? `点击输入激活码。线索池 ${used} 条全部保留，试用版可联系其中 ${TRIAL_LEAD_CAP} 条，${locked} 条锁定中——激活后即时解锁。`
      : "点击输入激活码。试用版可联系 20 条线索，其他功能不限。";
  } else {
    badge.classList.remove("is-trial");
    badge.classList.add("is-paid");
    badge.textContent = editionLabel();
    badge.title = `已激活 · 签发 ${MKD_LICENSE.issuedAt} · 更新服务至 ${MKD_LICENSE.updateUntil}`;
  }
}

/* ---------- 后台常驻开关（桌面版专有） ----------
   真值在主进程（要落盘并调 setLoginItemSettings），这里只做镜像。
   首次渲染异步取一次就缓存，避免每次进设置页都打一次 IPC。 */
let mkdBgPrefs = null;

function renderBackgroundOptions() {
  const host = elements.backgroundOptions;
  if (!host) return;
  const bridge = mkdBridge();
  if (!bridge?.backgroundPrefs) {
    host.innerHTML = `<p class="connector-hint">浏览器轻量模式没有系统托盘，也设不了开机自启——这两项只在桌面版可用。</p>`;
    return;
  }
  if (!mkdBgPrefs) {
    host.innerHTML = `<p class="connector-hint">读取中…</p>`;
    bridge
      .backgroundPrefs()
      .then((p) => {
        mkdBgPrefs = p || { keepRunning: false, openAtLogin: false };
        renderBackgroundOptions();
      })
      .catch(() => {
        host.innerHTML = `<p class="connector-hint">读取后台设置失败，不影响其它功能。</p>`;
      });
    return;
  }
  const keep = mkdBgPrefs.keepRunning;
  host.innerHTML = `
    <label class="toggle-row">
      <input type="checkbox" data-bg="keepRunning" ${keep ? "checked" : ""} />
      <span><b>关闭窗口后继续在后台运行</b> —— 收进系统托盘，自动驾驶继续工作。托盘图标右键可「完全退出」。</span>
    </label>
    <label class="toggle-row">
      <input type="checkbox" data-bg="openAtLogin" ${mkdBgPrefs.openAtLogin ? "checked" : ""} ${keep ? "" : "disabled"} />
      <span><b>开机自动启动</b> —— 静默起在托盘，不弹窗。${keep ? "" : "（需先开启上一项）"}</span>
    </label>`;
}

function setBackgroundPref(key, value) {
  const bridge = mkdBridge();
  if (!bridge?.setBackgroundPrefs) return;
  const next = { ...(mkdBgPrefs || {}), [key]: value };
  bridge.setBackgroundPrefs(next).then((applied) => {
    mkdBgPrefs = applied;
    renderBackgroundOptions();
    addLog(
      applied.keepRunning
        ? `后台常驻已开启${applied.openAtLogin ? "，并已设为开机自启" : ""}——关窗后自动驾驶继续跑`
        : "后台常驻已关闭——关掉窗口自动驾驶就停"
    );
    renderLogs();
  });
}

/* ---------- 收发信凭据（直连模式） ----------
   密码只在主进程，界面里永远显示为空。留空保存＝不改密码，
   否则用户每调一次端口都要重新翻一遍授权码。 */
function renderMailConfig() {
  const host = elements.mailConfig;
  if (!host) return;
  const bridge = mkdBridge();
  if (!bridge?.mailSummary) {
    host.innerHTML = `<p class="connector-hint">浏览器轻量模式下不能直连收发信（SMTP/IMAP 是裸 TCP，浏览器做不到）。请用桌面版，或改用 Webhook 模式。</p>`;
    return;
  }
  const m = MKD_MAIL || {};
  // Gmail / Outlook 已强制 OAuth2，普通"授权码 + SMTP"这条路基本走不通了。
  // 与其让用户反复试错到怀疑软件坏了，不如在他填完主机的那一刻就说清楚。
  const oauthOnly = (host) => /gmail|googlemail|outlook|hotmail|live\.com|office365|microsoft/i.test(host || "");
  const warn = oauthOnly(m.smtp?.host) || oauthOnly(m.imap?.host);
  const block = (kind, title, conf, portHint) => `
    <div class="mail-block">
      <div class="mail-block-head">
        <strong>${title}</strong>
        <span class="pf-badge ${conf.configured ? "pf-ok" : "pf-warn"}">${conf.configured ? "已配置" : "未配置"}</span>
      </div>
      <div class="mail-grid">
        <label><span>服务器</span><input data-mail="${kind}.host" value="${escapeHtml(conf.host || "")}" placeholder="如 smtp.exmail.qq.com" /></label>
        <label><span>端口</span><input data-mail="${kind}.port" type="number" value="${conf.port || ""}" placeholder="${portHint}" /></label>
        <label><span>账号（完整邮箱）</span><input data-mail="${kind}.user" value="${escapeHtml(conf.user || "")}" placeholder="you@yourcompany.com" /></label>
        <label><span>客户端授权码${conf.configured ? "（留空＝不修改）" : ""}</span><input data-mail="${kind}.pass" type="password" autocomplete="off" placeholder="${conf.configured ? "已保存，留空即不改" : "企业邮箱后台生成的授权码"}" /></label>
        <label class="toggle-row"><input data-mail="${kind}.secure" type="checkbox" ${conf.secure !== false ? "checked" : ""} /><span>SSL/TLS 直连（465、993 勾上；587 取消勾选走 STARTTLS）</span></label>
      </div>
      <div class="connector-foot">
        <button class="ghost-button" data-mail-test="${kind}" type="button"><span>测试连接</span></button>
        <span class="webhook-status" data-mail-status="${kind}">未测试</span>
      </div>
    </div>`;

  host.innerHTML = `
    ${
      warn
        ? `<p class="connector-hint mkd-lock-note">⚠️ 检测到你填的是 <b>Gmail / Outlook</b>。这两家已强制 OAuth2，普通「授权码 + SMTP/IMAP」大概率连不上。
             建议改用企业邮箱（腾讯企业邮 / 网易企业邮 / 阿里企业邮等，都支持客户端授权码）——用自有域名发信本来也比 Gmail 更专业、送达率更好。
             一定要用 Gmail 的话，只能走「Webhook 模式」，在 n8n 侧用 Google 的 OAuth 凭据发。</p>`
        : ""
    }
    ${block("smtp", "发信 SMTP", m.smtp || {}, "465")}
    ${block("imap", "收信 IMAP", m.imap || {}, "993")}
    <div class="connector-foot">
      <button class="primary-button" data-mail-action="save" type="button"><span>保存收发信设置</span></button>
      <button class="ghost-button danger-button" data-mail-action="clear" type="button"><span>清除已保存的凭据</span></button>
    </div>`;
}

function collectMailForm() {
  const read = (key) => elements.mailConfig?.querySelector(`[data-mail="${key}"]`);
  const one = (kind) => ({
    host: read(`${kind}.host`)?.value.trim() || "",
    port: Number(read(`${kind}.port`)?.value) || 0,
    user: read(`${kind}.user`)?.value.trim() || "",
    pass: read(`${kind}.pass`)?.value || "", // 留空＝不改，主进程侧处理
    secure: !!read(`${kind}.secure`)?.checked
  });
  return { smtp: one("smtp"), imap: one("imap") };
}

async function saveMailConfig() {
  const bridge = mkdBridge();
  if (!bridge?.mailSave) return;
  const res = await bridge.mailSave(collectMailForm());
  if (!res?.ok) {
    addLog(`收发信设置保存失败：${res?.error || "未知错误"}`);
    renderLogs();
    return;
  }
  MKD_MAIL = res.summary;
  renderMailConfig();
  addLog(
    MKD_MAIL.smtp.configured
      ? `收发信设置已保存（密码已加密存本机）。发信 ${MKD_MAIL.smtp.configured ? "✓" : "✗"} · 收信 ${MKD_MAIL.imap.configured ? "✓" : "✗"}——建议各点一次「测试连接」`
      : "收发信设置已保存"
  );
  renderLogs();
}

async function testMailConn(kind) {
  const bridge = mkdBridge();
  const el = elements.mailConfig?.querySelector(`[data-mail-status="${kind}"]`);
  if (!bridge || !el) return;
  el.className = "webhook-status";
  el.textContent = "测试中…";
  const start = Date.now();
  const res = kind === "smtp" ? await bridge.smtpTest() : await bridge.imapTest();
  if (res?.ok) {
    el.className = "webhook-status ok";
    el.textContent = `正常 · ${Date.now() - start}ms${typeof res.count === "number" ? ` · 收件箱 ${res.count} 封` : ""}`;
    addLog(`${kind === "smtp" ? "SMTP 发信" : "IMAP 收信"}连接成功`);
  } else {
    el.className = "webhook-status fail";
    el.textContent = "失败";
    addLog(`${kind === "smtp" ? "SMTP 发信" : "IMAP 收信"}连接失败：${res?.error || "未知错误"}`);
  }
  renderLogs();
}

/* ---------- AI 引擎区锁定态（不隐藏，让用户知道正式版有什么） ---------- */

function renderAiLock() {
  const panel = document.querySelector(".ai-engine-panel");
  if (!panel) return;
  panel.classList.toggle("is-locked", isTrial());
  const cloudBtn = elements.aiCloudMode;
  [
    elements.aiApiKeyInput,
    elements.aiProviderSelect,
    elements.aiModelSelect,
    elements.aiModelCustomInput,
    elements.aiModelFetch,
    elements.aiBaseUrlInput,
    cloudBtn
  ].forEach((el) => {
    if (!el) return;
    el.disabled = isTrial();
    if (isTrial()) el.title = "正式版可接入 Claude 等大模型，试用版使用本地规则引擎";
    else el.removeAttribute("title");
  });
  let note = panel.querySelector(".mkd-lock-note");
  if (isTrial() && !note) {
    note = document.createElement("p");
    note.className = "mkd-lock-note";
    note.innerHTML = "🔒 正式版可接入 Claude 等大模型，试用版使用本地规则引擎。激活后即时解锁，不用重启。";
    panel.appendChild(note);
  } else if (!isTrial() && note) {
    note.remove();
  }
}

/* ============================================================================
 * F3 未验证邮箱强制拦截 —— sendGuard
 * ==========================================================================*/

// 唯一判定入口：入队与发送两个环节都调它，保证不存在绕过路径。
// 返回 { ok, reason, fixable }
function sendGuard(prospect, email) {
  if (!prospect) return { ok: true };
  // 试用版锁定线索：进得来池、看得见资料，但联系不了（墙立在"联系"这一步）
  if (isTrialLocked(prospect)) {
    return {
      ok: false,
      reason: `试用版可联系 ${TRIAL_LEAD_CAP} 条，这条已超出`,
      detail: `线索池里的 ${state.prospects.length} 条全部保留，其中最早入池的 ${TRIAL_LEAD_CAP} 条可正常补全和发信。激活后全部解锁，一条不丢。`,
      fixable: false,
      trial: true
    };
  }
  const verify = emailVerificationState(prospect, email);
  if (verify === "guessed") {
    return {
      ok: false,
      reason: "邮箱未经验证",
      detail:
        "该邮箱由 AI 或规则推测生成。向未验证邮箱发信会推高退信率，严重损害发信域名信誉（可能导致你所有邮件都进垃圾箱）。",
      fixable: true
    };
  }
  return { ok: true };
}

function pendingVerifyCount() {
  return activeProspects().filter((p) => p.email && emailVerificationState(p, p.email) === "guessed").length;
}

// 潜客列表里的一枚小徽章：这条现在能不能发出去（状态即信息）
function verifyPill(prospect) {
  // 不对口优先于一切：这条线索根本不该发，验证状态是多余信息
  if (prospect?.offTarget) return `<span class="mkd-verify-badge is-offtarget">AI 判定不对口</span>`;
  if (!prospect?.email) return `<span class="mkd-verify-badge is-guessed">缺邮箱</span>`;
  const key = emailVerificationState(prospect, prospect.email);
  if (key === "verified") return `<span class="mkd-verify-badge is-verified">✓ 已验证</span>`;
  if (key === "manual") return `<span class="mkd-verify-badge is-manual">人工核实</span>`;
  return `<span class="mkd-verify-badge is-guessed">⛔ 待验证</span>`;
}

// 潜客详情里的"这条能不能发"一行：状态徽章 + 修复入口（F3 的用户侧出口）
function renderSendEligibility(prospect) {
  // AI 说不对口就把话说完：为什么不对口、建议怎么处理，而不是继续展示一堆猜的联系方式
  if (prospect?.offTarget) {
    return `<div class="offtarget-callout">
        <strong>⛔ AI 判定这家不对口${typeof prospect.fitScore === "number" ? `（匹配度 ${prospect.fitScore}%）` : ""}</strong>
        <p>${escapeHtml(prospect.fitNote || "不是采购/进口/分销我方产品的角色")}</p>
        <p class="mkd-hint">所以没有为它推测联系人和邮箱——在"完全不对口"旁边摆一个编出来的人名，只会害你发错人。批量入队和自动驾驶都会跳过它。</p>
        <div class="ot-actions">
          <button class="ghost-button danger-button" data-mkd-drop="${prospect.id}" type="button"><span>移出线索池</span></button>
          <button class="ghost-button" data-mkd-keep="${prospect.id}" type="button"><span>我确认对口，恢复</span></button>
        </div>
      </div>`;
  }
  if (!prospect?.email) {
    return `<span class="mkd-verify-badge is-guessed">缺邮箱</span> 先点「AI 找联系人」补全`;
  }
  const key = emailVerificationState(prospect, prospect.email);
  if (key === "verified") return `<span class="mkd-verify-badge is-verified">✓ 已验证 · 可发送</span>`;
  if (key === "manual") {
    const at = prospect.manualVerified?.at ? new Date(prospect.manualVerified.at).toLocaleString("zh-CN", { hour12: false }) : "";
    return `<span class="mkd-verify-badge is-manual">人工核实 · 可发送</span> <small>${escapeHtml(prospect.manualVerified?.by || "")} ${escapeHtml(at)}</small>`;
  }
  return `<span class="mkd-verify-badge is-guessed">⛔ 推测未验证 · 发不出去</span>
    <button class="ghost-button" data-mkd-manual-verify="${prospect.id}" type="button"><span>标记已人工核实</span></button>`;
}

// ⛔ 徽章点开的原因面板：把"为什么不能发"和"怎么修"放在同一块里
function openBlockPanel(outboxId) {
  const item = state.outbox.find((o) => o.id === outboxId);
  if (!item) return;
  const prospect = state.prospects.find((p) => p.id === item.prospectId);
  const pf = preflightOutboxItem(item);
  const guard = sendGuard(prospect, item.email);
  const pending = pendingVerifyCount();

  mkdModal({
    title: "⛔ 无法发送",
    width: 640,
    body: `
      <p class="mkd-block-reason">${pf.blockers.map((b) => escapeHtml(b)).join("；") || "预检未通过"}</p>
      ${guard.ok ? "" : `<p>${escapeHtml(guard.detail)}</p>`}
      <p class="mkd-hint">这条拦截在保护你的发信域名信誉——域名一旦被判定为垃圾发送者，连给老客户发报价单都会进垃圾箱。</p>
      <div class="mkd-kv"><span>公司</span><strong>${escapeHtml(item.company || "")}</strong></div>
      <div class="mkd-kv"><span>邮箱</span><strong>${escapeHtml(item.email || "（缺失）")}</strong></div>
      <div class="mkd-kv"><span>来源</span><strong>${escapeHtml(contactSourceLabel(prospect?.contactSource))}</strong></div>`,
    actions: [
      {
        label: `批量验证全部待验证（${pending}）`,
        onClick: () => {
          navigateTo("prospects");
          elements.verifyProspects?.click();
        }
      },
      {
        label: "我确认无误，标记人工核实",
        kind: "danger",
        onClick: () => prospect && confirmManualVerify(prospect.id)
      },
      {
        label: "立即验证这条",
        kind: "primary",
        autofocus: true,
        onClick: () => {
          if (!prospect) return;
          state.selectedProspectId = prospect.id;
          navigateTo("prospects");
          enrichContactAI(prospect.id);
        }
      }
    ]
  });
}

// 人工核实：危险样式二次确认 + 永久留痕（导出里也看得到）
function confirmManualVerify(prospectId) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect) return;
  mkdModal({
    title: "标记为人工核实？",
    danger: true,
    body: `
      <p>你即将把 <strong>${escapeHtml(prospect.email || "")}</strong>（${escapeHtml(prospect.company || "")}）标记为已人工核实，之后它可以进发送队列。</p>
      <p>此操作会留痕（记录时间与操作），并写进数据导出。如果这个邮箱其实不存在，退信的后果由你承担。</p>
      <p class="mkd-hint">只有当你在对方官网、名片或既往往来邮件里亲眼见过这个地址时，才该点确认。</p>`,
    actions: [
      { label: "取消", kind: "ghost", autofocus: true },
      {
        label: "确认，我核实过这个邮箱",
        kind: "danger",
        onClick: () => {
          prospect.manualVerified = {
            email: prospect.email,
            at: new Date().toISOString(),
            by: state.campaign.senderName || "本机操作者"
          };
          addLog(`已标记人工核实：${prospect.company} · ${prospect.email}（留痕 ${timestamp()}）`);
          pushOp("潜客", "标记人工核实", prospect.company);
          saveState();
          render();
        }
      }
    ]
  });
}

/* ============================================================================
 * F4 诊断日志与错误兜底
 * ==========================================================================*/

let fatalShown = false;

function showFatalError(message) {
  if (fatalShown) return;
  fatalShown = true;
  const page = document.createElement("div");
  page.className = "mkd-fatal";
  page.innerHTML = `
    <div class="mkd-fatal-card">
      <h2>${BRAND.name}遇到了一个问题，你的数据是安全的。</h2>
      <p>数据存在本机的独立位置，和这次报错无关，重启后会原样还在。</p>
      <p class="mkd-fatal-detail">${escapeHtml(String(message || "").slice(0, 300))}</p>
      <div class="mkd-fatal-actions">
        <button class="ghost-button" type="button" data-fatal="export"><span>导出诊断日志</span></button>
        <button class="primary-button" type="button" data-fatal="reload"><span>重新启动</span></button>
      </div>
      <p class="mkd-hint">把诊断日志发给客服（微信 ${BRAND.supportWechat}），48 小时内会给你答复或补丁。日志里的邮箱和电话已经打码，不含任何邮件正文。</p>
    </div>`;
  page.addEventListener("click", (event) => {
    const act = event.target.closest("[data-fatal]")?.dataset.fatal;
    if (act === "export") exportDiagnostics();
    else if (act === "reload") window.location.reload();
  });
  document.body.appendChild(page);
}

async function buildDiagnostics() {
  const bridge = mkdBridge();
  const counts = {
    prospects: state.prospects.length,
    outbox: state.outbox.length,
    whatsappQueue: state.whatsappQueue.length,
    inbound: state.inbound.length,
    tasks: state.tasks.length,
    blacklist: state.blacklist?.length || 0,
    products: state.products?.length || 0,
    quotes: state.quotes?.length || 0,
    campaigns: state.management?.campaigns?.length || 0,
    logs: state.logs.length
  };
  let mainLog = "";
  if (bridge) {
    try {
      mainLog = await bridge.mainErrorLog();
    } catch {
      mainLog = "（读取主进程日志失败）";
    }
  }
  return [
    `${BRAND.name} 诊断日志`,
    `生成时间：${new Date().toISOString()}`,
    `应用版本：${BRAND.version}${MKD_APP_INFO ? `（Electron ${MKD_APP_INFO.electron}）` : "（浏览器模式）"}`,
    `系统：${MKD_APP_INFO?.platform || navigator.userAgent}`,
    `界面版本戳：${window.__APP_V}`,
    `授权：${editionLabel()}${MKD_LICENSE.activated ? ` · 签发 ${MKD_LICENSE.issuedAt} · 更新至 ${MKD_LICENSE.updateUntil}` : ""}`,
    `运行模式：${state.settings.mode} ｜ AI 引擎：${state.settings.aiEngine}（${state.settings.aiProvider}）`,
    `Webhook 已配置：${Object.keys(WEBHOOK_CONNECTORS).filter((k) => (state.settings[WEBHOOK_CONNECTORS[k].urlKey] || "").trim()).join(", ") || "无"}`,
    `本地存储占用：${storageUsage().kb} KB`,
    "",
    "— 数据表条数 —",
    ...Object.entries(counts).map(([k, v]) => `${k}: ${v}`),
    "",
    `— 最近 ${MKD_OPS.length} 条操作（已脱敏）—`,
    ...MKD_OPS.map((o) => `${o.t} [${o.m}] ${o.a}${o.r ? ` → ${o.r}` : ""}`),
    "",
    "— 错误堆栈 —",
    ...(MKD_ERRORS.length
      ? MKD_ERRORS.map((e) => `${e.t} [${e.scope}] ${e.message}\n${e.stack}`)
      : ["（无）"]),
    "",
    "— 主进程日志 —",
    mainLog || "（无）",
    "",
    "说明：邮箱已按 a***@d***.com 打码、电话只保留国家码与末两位、不含任何邮件正文。"
  ].join("\n");
}

async function exportDiagnostics() {
  let text = await buildDiagnostics();
  if (text.length > 1_800_000) text = text.slice(0, 1_800_000) + "\n…（已截断，保证文件小于 2MB）";
  const name = `mikeduo-diagnostics-${dateOffset(0)}.log`;
  const bridge = mkdBridge();
  if (bridge) {
    const result = await bridge.saveText(name, text);
    if (result.ok) addLog(`诊断日志已保存到 ${result.file}`);
  } else {
    download(name, text, "text/plain");
    addLog("诊断日志已导出（邮箱与电话已打码，不含邮件正文）");
  }
}

/* ============================================================================
 * F5 自动更新
 * ==========================================================================*/

function renderUpdateDot(version) {
  let dot = document.getElementById("mkdUpdateDot");
  if (!dot) {
    dot = document.createElement("button");
    dot.id = "mkdUpdateDot";
    dot.type = "button";
    dot.className = "mkd-update-dot";
    dot.innerHTML = "<span></span>有新版本";
    dot.addEventListener("click", () => {
      mkdModal({
        title: `新版本 ${version} 已下载`,
        body: "<p>重启后生效。现在重启，还是等你手头这批信发完？</p>",
        actions: [
          { label: "稍后重启", kind: "ghost" },
          { label: "现在重启", kind: "primary", autofocus: true, onClick: () => mkdBridge()?.quitAndInstall() }
        ]
      });
    });
    document.querySelector(".topbar-actions")?.prepend(dot);
  }
}

async function checkUpdate({ silent = true } = {}) {
  const bridge = mkdBridge();
  if (!bridge) return;
  const result = await bridge.checkUpdate();
  if (result.expired) {
    const message = `更新服务已于 ${result.updateUntil} 到期。已安装的版本可以继续用，不受影响；想继续收到新版本，续订更新费 ¥199/年。`;
    if (silent) addLog(`📮 ${message}`);
    else
      mkdModal({
        title: "更新服务已到期",
        body: `<p>${message}</p><p class="mkd-hint">续订找客服微信 ${BRAND.supportWechat}。买断的版本永久可用，这一条只影响"能不能收到新版本"。</p>`,
        actions: [{ label: "知道了", kind: "primary", autofocus: true }]
      });
    return;
  }
  if (silent) return;
  if (!result.ok) addLog("检查更新失败（多半是没网或更新源没配好），不影响使用");
  else if (!result.version || result.version === BRAND.version) addLog(`已是最新版本 ${BRAND.version}`);
  else addLog(`发现新版本 ${result.version}，正在后台下载，下好会提示你重启`);
}

// 更新后首启：展示更新日志
function maybeShowChangelog() {
  const seen = state.ui?.changelogSeenVersion;
  if (seen === BRAND.version) return;
  if (!seen) {
    // 首次安装不弹更新日志，别打扰新用户
    state.ui = { ...(state.ui || {}), changelogSeenVersion: BRAND.version };
    saveState();
    return;
  }
  state.ui = { ...(state.ui || {}), changelogSeenVersion: BRAND.version };
  saveState();
  mkdModal({
    title: `已更新到 ${BRAND.version}`,
    width: 640,
    body: `<p>你的数据没有任何变化，线索、队列、配置都还在原处。</p>
           <p class="mkd-hint">本次改了什么写在发布说明里；有问题找客服微信 ${BRAND.supportWechat}。</p>`,
    actions: [{ label: "开始用", kind: "primary", autofocus: true }]
  });
}

/* ============================================================================
 * F6 新手引导（与课程 5 步同构）
 * ==========================================================================*/

// 写成函数而不是模块级常量：07 末尾的首次 render() 会经 VIEW_RENDERERS 调到
// renderChecklist，那时 08 的 const 还在 TDZ 里，读一下就整页崩。
function onboardingSteps() {
  return [
  {
    key: "focus",
    title: "填产品定位",
    what: "填你要卖的具体产品、目标市场和客户类型",
    why: "先把方向定准，后面的找客户、写信和评分才不会跑偏",
    done: "控制台里出现你的产品和市场，而不是演示模板",
    goto: "dashboard",
    check: () => !!(state.campaign.product || "").trim() && !state.ui?.starterTemplate
  },
  {
    key: "leads",
    title: "灌线索进池",
    what: "用「一键起量」跑本地演示，或去搜索页粘贴真实搜索结果",
    why: "先看到客户列表，才知道质量分、补全和验证在解决什么",
    done: "潜客队列出现线索，并能看到 A/B/C/D 质量分",
    goto: "prospects",
    check: () => state.prospects.length > 0
  },
  {
    key: "send",
    title: "发出第一批信",
    what: "先处理邮箱验证阻断，再把可发送邮件逐封审批",
    why: "邮箱没验证就发会伤域名，系统拦住是在保护后续送达率",
    done: "队列里至少有一封通过预检，或已经发出自测邮件",
    goto: "automation",
    check: () => state.outbox.some((o) => o.status === "已发送" || preflightOutboxItem(o).ok)
  },
  {
    key: "reply",
    title: "处理第一条回复",
    what: "点「拉取回复」，在收件箱看意图识别与回复建议，采用后回过去",
    why: "回复处理决定询盘转化，AI 出草稿、价格账期你自己拍板",
    done: "收件箱有会话，CRM 里有一条推进记录",
    goto: "inbox",
    check: () => state.inbound.length > 0
  },
  {
    key: "infra",
    title: "接真实服务",
    what: "准备真实跑量时，再填 AI 引擎和 Webhook，逐个点「测试连接」",
    why: "本地演示能先理解流程；真实找客户、验邮箱、发信、收回信才需要这些接口",
    done: "设置页每个关键 Webhook 后面挂着绿色状态码",
    goto: "settings",
    check: () =>
      !!(state.settings.sendWebhook || state.settings.searchWebhook) ||
      Object.values(state.settings.webhookStatus || {}).some((s) => s?.ok)
  }
  ];
}

function onboardingState() {
  const manual = state.ui?.onboardingDone || {};
  return onboardingSteps().map((step) => ({ ...step, ok: manual[step.key] || step.check() }));
}

// 覆盖 05 里的旧版清单：五步与课程同构，进度持久化，每步一句话说清做什么/为什么/做完看到什么
function renderChecklist() {
  const host = elements.onboardingChecklist;
  if (!host) return;
  if (state.ui?.checklistDismissed) {
    host.innerHTML = "";
    return;
  }
  const steps = onboardingState();
  const doneCount = steps.filter((s) => s.ok).length;
  const currentIndex = steps.findIndex((s) => !s.ok);
  const focusIndex = state.ui?.onboardingFocus ?? currentIndex;
  const step = steps[focusIndex] || steps[currentIndex] || steps[0];
  const collapsed = !!state.ui?.onboardingCollapsed;

  // 横向步骤条：一行看完进度，只展开当前这步的说明（D1「步骤条固定于控制台顶部可折叠」）
  host.innerHTML = `
    <div class="panel mkd-onboarding ${collapsed ? "is-collapsed" : ""}">
      <div class="ob-head">
        <strong>上手五步</strong>
        <span class="ob-progress">${doneCount}/${steps.length}</span>
        <div class="ob-track">
          ${steps
            .map(
              (s, i) => `
            <button class="ob-node ${s.ok ? "is-done" : i === currentIndex ? "is-current" : ""} ${i === focusIndex ? "is-focus" : ""}"
                    data-onboard-focus="${i}" type="button" title="${escapeHtml(s.title)}">
              <span class="ob-dot">${s.ok ? "✓" : i + 1}</span>
              <span class="ob-name">${escapeHtml(s.title)}</span>
            </button>`
            )
            .join("")}
        </div>
        <button class="ob-link" data-onboard-collapse="1" type="button">${collapsed ? "展开" : "收起"}</button>
        <button class="ob-link" data-checklist-dismiss type="button">不再显示</button>
      </div>
      ${
        collapsed || !step
          ? ""
          : `<div class="ob-body">
               <dl class="ob-facts">
                 <div><dt>做什么</dt><dd>${escapeHtml(step.what)}</dd></div>
                 <div><dt>为什么</dt><dd>${escapeHtml(step.why)}</dd></div>
                 <div><dt>做完你会看到</dt><dd>${escapeHtml(step.done)}</dd></div>
               </dl>
               <div class="ob-actions">
                 ${
                   step.key === "send"
                     ? `<button class="primary-button" data-onboard-selftest="1" type="button"><span>${
                         state.ui?.selfTestSentAt ? "再发一封给自己" : "先发一封给自己"
                       }</span></button>
                        <button class="ghost-button" data-goto="${step.goto}" type="button"><span>去发信队列</span></button>`
                     : `<button class="primary-button" data-goto="${step.goto}" type="button"><span>去这一步</span></button>`
                 }
                 <button class="ghost-button" data-onboard-done="${step.key}" type="button"><span>${step.ok ? "已完成" : "我做完了"}</span></button>
                 <button class="ghost-button" data-onboard-course="${step.key}" type="button"><span>配套课程</span></button>
               </div>
             </div>`
      }
    </div>`;
}

function restartOnboarding() {
  state.ui = { ...(state.ui || {}), checklistDismissed: false, onboardingDone: {} };
  saveState();
  navigateTo("dashboard");
  render();
  addLog("新手引导已重新打开");
}

/* ============================================================================
 * F7 数据自动备份
 * ==========================================================================*/

async function runDailyBackup() {
  const bridge = mkdBridge();
  if (!bridge) return;
  const today = dateOffset(0);
  if (state.ui?.lastAutoBackupDate === today) return;
  if (!state.prospects.length && !state.outbox.length) return; // 空库不占备份份额
  try {
    const result = await bridge.backupWrite(backupJson(), "");
    state.ui = { ...(state.ui || {}), lastAutoBackupDate: today, lastAutoBackupAt: result.at, lastBackupAt: result.at };
    saveState();
    pushOp("备份", "每日自动备份", result.file);
  } catch (error) {
    addLog(`自动备份失败：${error.message}。数据没丢，但请手动点一次「立即备份」。`);
  }
}

async function openRestoreDialog() {
  const bridge = mkdBridge();
  if (!bridge) {
    elements.importBackupFile?.click();
    return;
  }
  const list = await bridge.backupList();
  if (!list.length) {
    mkdModal({
      title: "还没有自动备份",
      body: "<p>自动备份从有数据后的第一次启动开始生成，每天一份，滚动保留 14 份。你也可以随时点「立即备份」手动导出一份。</p>",
      actions: [{ label: "知道了", kind: "primary", autofocus: true }]
    });
    return;
  }
  mkdModal({
    title: "从自动备份恢复",
    width: 640,
    body: `
      <p class="mkd-hint">覆盖前会自动把当前数据再备份一份，选错了还能退回来。</p>
      <div class="mkd-backup-list">
        ${list
          .map(
            (b) => `<label class="mkd-backup-row">
              <input type="radio" name="mkdBackup" value="${escapeHtml(b.file)}" />
              <span><strong>${b.at.slice(0, 10)}</strong> ${b.at.slice(11, 16)} · ${Math.round(b.size / 1024)} KB</span>
            </label>`
          )
          .join("")}
      </div>`,
    actions: [
      { label: "取消", kind: "ghost", autofocus: true },
      {
        label: "预览并恢复",
        kind: "danger",
        keepOpen: true,
        onClick: async (root, close) => {
          const picked = root.querySelector('input[name="mkdBackup"]:checked')?.value;
          if (!picked) return;
          close();
          previewAndRestore(picked);
        }
      }
    ]
  });
}

async function previewAndRestore(file) {
  const bridge = mkdBridge();
  let parsed;
  try {
    parsed = JSON.parse(await bridge.backupRead(file));
  } catch (error) {
    addLog(`备份文件读不出来（可能已损坏）：${error.message}`);
    return;
  }
  const scale = [
    ["线索", parsed.prospects?.length || 0, state.prospects.length],
    ["发信队列", parsed.outbox?.length || 0, state.outbox.length],
    ["WhatsApp 队列", parsed.whatsappQueue?.length || 0, state.whatsappQueue.length],
    ["回复", parsed.inbound?.length || 0, state.inbound.length],
    ["黑名单", parsed.blacklist?.length || 0, state.blacklist?.length || 0]
  ];
  mkdModal({
    title: "确认覆盖当前数据？",
    width: 640,
    danger: true,
    body: `
      <p>备份文件：<code>${escapeHtml(file)}</code></p>
      <table class="mkd-table">
        <thead><tr><th>数据</th><th>备份里</th><th>当前</th></tr></thead>
        <tbody>${scale.map(([k, a, b]) => `<tr><td>${k}</td><td>${a}</td><td>${b}</td></tr>`).join("")}</tbody>
      </table>
      <p class="mkd-hint">恢复会整体覆盖当前数据。覆盖前系统自动把现在的数据另存一份备份，标记 before-restore。</p>`,
    actions: [
      { label: "取消", kind: "ghost", autofocus: true },
      {
        label: "覆盖并恢复",
        kind: "danger",
        onClick: async () => {
          await bridge.backupWrite(backupJson(), "before-restore");
          addLog("已恢复备份，正在重新载入…");
          // 先把内存里待写的改动全部落盘并清掉防抖计时器，再覆盖。
          // 否则 saveState 的防抖可能在覆盖之后才触发，把刚恢复的数据又写回旧的。
          flushState();
          // 备份里的 Key 已被抹掉，恢复时保住本机现有的，免得恢复一次就要重配一遍
          const restored = {
            ...parsed,
            settings: { ...(parsed.settings || {}) }
          };
          BACKUP_REDACTED_KEYS.forEach((k) => {
            if (!restored.settings[k] && state.settings?.[k]) restored.settings[k] = state.settings[k];
          });
          localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
          window.location.reload();
        }
      }
    ]
  });
}

/* ============================================================================
 * F8 合规与限流
 * ==========================================================================*/

// 建活动时的一次性 GDPR 提示（陈述事实，不恐吓）
function maybeGdprNotice() {
  if (!campaignHitsEu(state.campaign)) return;
  if (state.ui?.gdprNoticeShown) return;
  const { overlay } = mkdModal({
    title: "这个活动打的是欧盟/英国市场",
    width: 640,
    body: `
      <p>这些市场适用 GDPR 与 PECR：给企业联系人发商业开发信本身是允许的，但有三条硬要求。</p>
      <ul class="mkd-list">
        <li>每封信必须给出可用的退订方式——${BRAND.name}已在模板里强制注入，删掉会被预检 ⛔ 拦下。</li>
        <li>对方要求停止后必须立即停：回复 unsubscribe 会自动进黑名单，全部待发同步取消。</li>
        <li>只给业务相关的企业地址发，不要发个人邮箱（personal@ / gmail 等私人域）。</li>
      </ul>
      <p class="mkd-hint">合规责任在使用者一侧，具体判断以你所在地和目标市场的法律为准。</p>
      <label class="mkd-check"><input type="checkbox" id="mkdGdprMute" checked /> <span>以后不再提示</span></label>`,
    actions: [
      {
        label: "明白了",
        kind: "primary",
        autofocus: true,
        onClick: (root) => {
          if (root.querySelector("#mkdGdprMute")?.checked) {
            state.ui = { ...(state.ui || {}), gdprNoticeShown: true };
            saveState();
          }
        }
      }
    ]
  });
  void overlay;
}

/* ---------- 起航航程条（B7 签名元素） ---------- */

function renderVoyageBar() {
  const view = document.getElementById("automationView");
  if (!view) return;
  let bar = document.getElementById("mkdVoyage");
  if (!inWarmup()) {
    bar?.remove();
    renderWarmupAnchor();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "mkdVoyage";
    bar.className = "mkd-voyage";
    view.insertBefore(bar, view.firstChild);
  }
  const day = Math.min(WARMUP_DAYS, Math.max(1, warmupDayIndex()));
  const sent = sentTodayCount();
  const cap = Math.min(WARMUP_DAILY_CAP, state.management?.rules?.emailDailyLimit || WARMUP_DAILY_CAP);
  const pct = ((day - 0.5) / WARMUP_DAYS) * 100;
  bar.innerHTML = `
    <div class="voyage-line">
      <div class="voyage-track">
        ${Array.from({ length: WARMUP_DAYS }, (_, i) => `<i class="${i + 1 <= day ? "past" : ""}"></i>`).join("")}
        <div class="voyage-ship" style="left:${pct}%">
          <svg viewBox="0 0 24 24"><path d="M3 17h18l-2 4H5l-2-4Z"/><path d="M6 17V9l6-5 6 5v8"/></svg>
          <span>D${day}</span>
        </div>
      </div>
    </div>
    <div class="voyage-meta">
      <strong>新域名预热航程 D${day}/${WARMUP_DAYS}</strong>
      <span>今日限额 ${sent}/${cap} 封</span>
      <em>前 14 天软件硬顶 ${WARMUP_DAILY_CAP} 封/天。新域名在收信服务器眼里是"查无此人"，第一天就大批量发等于陌生人见面借钱——直接拉黑。</em>
    </div>`;
}

function renderWarmupAnchor() {
  const host = document.querySelector(".topbar-actions");
  if (!host || document.getElementById("mkdWarmupAnchor")) return;
  if (!state.outbox.some((o) => o.sentAt)) return; // 还没发过信就不显示"预热完成"
  const anchor = document.createElement("span");
  anchor.id = "mkdWarmupAnchor";
  anchor.className = "mkd-anchor-badge";
  anchor.title = "域名预热完成，日限已回到你自己设定的值";
  anchor.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 7v13"/><circle cx="12" cy="5" r="2"/><path d="M5 12h14"/><path d="M5 12a7 7 0 0 0 14 0"/></svg>`;
  host.prepend(anchor);
}

/* ---------- WhatsApp 冷发风险确认（每次都弹，不可关闭） ---------- */

function hasEmailContact(prospectId) {
  return state.outbox.some((o) => o.prospectId === prospectId && o.status === "已发送");
}

function confirmColdWhatsapp(coldItems, onConfirm) {
  const names = [...new Set(coldItems.map((i) => i.company))].slice(0, 6);
  mkdModal({
    title: "这些是冷发 WhatsApp",
    width: 640,
    danger: true,
    dismissible: false,
    body: `
      <p>下面 ${coldItems.length} 条要发给<strong>还没有过邮件往来</strong>的号码：${names.map((n) => escapeHtml(n)).join("、")}${coldItems.length > names.length ? " 等" : ""}。</p>
      <p>陌生号码直接收到商业消息，被举报的概率很高；WhatsApp 对新号冷发的封号处理很快，而且号码封了很难申诉回来。</p>
      <p class="mkd-hint">推荐的用法是接力：先发邮件建立上下文，对方回过信或看过你的邮件后，再用 WhatsApp 跟进。</p>`,
    actions: [
      { label: "取消，我先发邮件", kind: "ghost", autofocus: true },
      { label: `明白风险，仍然发这 ${coldItems.length} 条`, kind: "danger", onClick: onConfirm }
    ]
  });
}

/* ============================================================================
 * F9 关于页 / 许可与免责声明
 * ==========================================================================*/

const LICENSE_AGREEMENT = `「觅客舵」软件许可与免责声明（v1.0）

1. 授权范围：本软件按"买断制"授予个人非独占使用许可，一个激活码限绑定两台设备，禁止转售、出租、拆解或对激活机制实施逆向工程。
2. 更新服务：自激活码签发之日起 12 个月内免费提供软件更新；期满后更新服务需另行付费续订，已安装版本可继续使用不受影响。
3. 工具属性：本软件是获客流程管理工具，自身不抓取任何网站数据、不内置任何买家数据库、不提供任何发信或数据服务。查找与验证通过用户自行配置的第三方服务完成；发信与收信使用用户自行提供的邮箱账户（内置 SMTP/IMAP 直连）或用户自行配置的第三方服务，发件身份、发送内容与发送行为均由用户决定并经用户逐条审批后触发。
4. 合规责任：用户须自行遵守目标市场的电子邮件营销与数据保护法规（包括但不限于 GDPR、CAN-SPAM）及所用第三方服务（邮箱服务商、WhatsApp、数据服务商等）的服务条款；因用户使用行为引发的账号封禁、投诉、法律责任由用户自行承担。
5. AI 内容：软件中由 AI 生成的联系人推测、邮件草稿、评分与建议仅供参考，可能存在错误；用户应在发送与决策前自行核实。
6. 数据存储：用户数据仅存储于用户本地设备，开发者无法访问；数据备份为用户自身责任，软件提供的自动备份功能不构成数据安全承诺。
7. 效果声明：本软件及配套课程不对任何商业成果（包括回复率、询盘量、成交额）作出承诺或保证。
8. 责任限额：因使用本软件产生的任何直接或间接损失，开发者承担的责任总额以用户实际支付的软件费用为上限。
9. 退款：激活前 7 日内可无理由退款；激活码一经使用不予退款。课程与服务的退款规则以购买页公示为准。
10. 条款变更：条款如有更新将随软件版本发布，继续使用视为接受。`;

function openAgreement() {
  mkdModal({
    title: "软件许可与免责声明",
    width: 640,
    body: `<pre class="mkd-agreement">${escapeHtml(LICENSE_AGREEMENT)}</pre>`,
    actions: [{ label: "关闭", kind: "primary", autofocus: true }]
  });
}

// 首次启动必须勾选。不勾不给进——这是免责的前提。
// 首启会有三样东西想同时冒出来（协议 / 欢迎向导 / GDPR 提示），叠在一起就是一堵墙，
// 所以这里接管顺序：先协议，同意后才放行欢迎向导，GDPR 留到用户真的建欧盟活动时再说。
function ensureAgreement(onDone) {
  if (state.ui?.agreementAcceptedAt) {
    onDone?.();
    return;
  }
  if (elements.welcomeOverlay) elements.welcomeOverlay.hidden = true;
  mkdModal({
    title: `欢迎使用${BRAND.name}`,
    width: 640,
    dismissible: false,
    body: `
      <p>${BRAND.name}是装在你自己电脑上的获客工作台：数据不出本机，AI 负责找客户、写信、评分、认意图，发不发永远是你点最后一下。</p>
      <pre class="mkd-agreement">${escapeHtml(LICENSE_AGREEMENT)}</pre>
      <label class="mkd-check"><input type="checkbox" id="mkdAgreeBox" /> <span>我已阅读并同意《软件许可与免责声明》，并理解本软件不承诺任何商业成果。</span></label>`,
    actions: [
      {
        label: "同意并开始",
        kind: "primary",
        keepOpen: true,
        onClick: (root, close) => {
          if (!root.querySelector("#mkdAgreeBox").checked) {
            root.querySelector(".mkd-check").classList.add("shake");
            setTimeout(() => root.querySelector(".mkd-check")?.classList.remove("shake"), 400);
            return;
          }
          state.ui = { ...(state.ui || {}), agreementAcceptedAt: new Date().toISOString() };
          saveState();
          close();
          onDone?.();
        }
      }
    ]
  });
}

function openAbout() {
  const rows = [
    ["版本", `${BRAND.version}${MKD_APP_INFO ? "" : "（浏览器模式）"}`],
    ["授权状态", MKD_LICENSE.activated ? `已激活 · ${editionLabel()}` : "试用版（线索池上限 20 条）"],
    ["机器码", MKD_MACHINE?.code || "（浏览器模式读不到）"],
    ["签发日", MKD_LICENSE.issuedAt || "—"],
    ["更新服务到期", MKD_LICENSE.updateUntil ? `${MKD_LICENSE.updateUntil}${MKD_LICENSE.updateExpired ? "（已到期，可续订 ¥199/年）" : ""}` : "—"],
    ["数据位置", MKD_APP_INFO?.userData || "浏览器 localStorage"],
    ["客服微信", BRAND.supportWechat]
  ];
  mkdModal({
    title: `关于${BRAND.name}`,
    width: 640,
    body: `
      <div class="mkd-about-brand"><span class="mkd-logo"><svg><use href="#icon-mkd-mark" /></svg></span><div><strong>${BRAND.name} ${BRAND.en}</strong><small>${BRAND.tagline}</small></div></div>
      ${rows.map(([k, v]) => `<div class="mkd-kv"><span>${k}</span><strong>${escapeHtml(String(v))}</strong></div>`).join("")}`,
    actions: [
      { label: "许可与免责声明", onClick: () => openAgreement() },
      { label: "检查更新", onClick: () => checkUpdate({ silent: false }) },
      ...(MKD_LICENSE.activated ? [] : [{ label: "输入激活码", kind: "primary", onClick: () => openActivation() }]),
      { label: "关闭", kind: MKD_LICENSE.activated ? "primary" : "ghost", autofocus: true }
    ]
  });
}

/* ============================================================================
 * 设置页新增区块（关于 / 诊断 / 备份恢复）
 * ==========================================================================*/

function mountSettingsPanels() {
  const view = document.querySelector("#settingsView .settings-body") || document.getElementById("settingsView");
  if (!view || document.querySelector("[data-mkd-settings-panel]")) return;
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.id = "anchor-license";
  panel.innerHTML = `
    <div class="panel-heading">
      <div><p class="eyebrow">License &amp; support</p><h2>授权、备份与诊断</h2></div>
      <button class="ghost-button" data-mkd="about" type="button"><span>关于${BRAND.name}</span></button>
    </div>
    <div class="mkd-settings-grid">
      <div class="mkd-kv"><span>授权状态</span><strong id="mkdLicenseLine"></strong></div>
      <div class="mkd-kv"><span>本机机器码</span><strong id="mkdMachineLine"></strong></div>
      <div class="mkd-kv"><span>最近自动备份</span><strong id="mkdBackupLine"></strong></div>
    </div>
    <div class="mkd-settings-actions">
      <button class="ghost-button" data-mkd="activate" type="button"><span>输入激活码</span></button>
      <button class="ghost-button" data-mkd="restore" type="button"><span>从自动备份恢复</span></button>
      <button class="ghost-button" data-mkd="open-backups" type="button"><span>打开备份目录</span></button>
      <button class="ghost-button" data-mkd="diagnostics" type="button"><span>导出诊断日志</span></button>
      <button class="ghost-button" data-mkd="agreement" type="button"><span>许可与免责声明</span></button>
    </div>
    <p class="connector-hint">每天首次启动会自动把全部数据导出到备份目录，滚动保留 14 份。诊断日志里的邮箱和电话已打码，不含邮件正文，可以放心发给客服。</p>`;
  panel.dataset.mkdSettingsPanel = "1";
  view.appendChild(panel);
  panel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-mkd]")?.dataset.mkd;
    if (!action) return;
    if (action === "about") openAbout();
    else if (action === "activate") openActivation();
    else if (action === "restore") openRestoreDialog();
    else if (action === "open-backups") mkdBridge()?.openPath("backups");
    else if (action === "diagnostics") exportDiagnostics();
    else if (action === "agreement") openAgreement();
  });
}

function renderSettingsPanels() {
  const licenseLine = document.getElementById("mkdLicenseLine");
  if (!licenseLine) return;
  licenseLine.textContent = MKD_LICENSE.activated
    ? `${editionLabel()} · 签发 ${MKD_LICENSE.issuedAt} · 更新服务至 ${MKD_LICENSE.updateUntil}${MKD_LICENSE.updateExpired ? "（已到期）" : ""}`
    : `试用版 · 线索池 ${state.prospects.length}/${TRIAL_LEAD_CAP}`;
  document.getElementById("mkdMachineLine").textContent = MKD_MACHINE?.code || "（浏览器模式读不到，激活请用桌面版）";
  const at = state.ui?.lastAutoBackupAt;
  document.getElementById("mkdBackupLine").textContent = at
    ? new Date(at).toLocaleString("zh-CN", { hour12: false })
    : mkdBridge()
      ? "还没有（有数据后的首次启动会自动生成）"
      : "浏览器模式不支持自动备份，请手动导出 JSON";
}

/* ============================================================================
 * 增强既有函数（保留原实现再包一层）
 * ==========================================================================*/

// —— F2：试用版禁用云端大模型 ——
const __mkdBaseAiEnabled = aiEnabled;
aiEnabled = function () {
  return !isTrial() && __mkdBaseAiEnabled();
};

// —— F2：导出加试用水印 ——
const __mkdBaseDownload = download;
download = function (filename, content, type) {
  let out = content;
  if (isTrial()) {
    // 按扩展名优先判断：部分导出没传 type
    if (/\.json$/i.test(filename) || /json/i.test(type || "")) {
      try {
        const data = JSON.parse(content);
        out = JSON.stringify({ edition: "trial", editionNote: `${BRAND.name}试用版导出，激活后无水印`, ...data }, null, 2);
      } catch {
        out = content;
      }
    } else if (content.startsWith("﻿")) {
      // CSV 带 UTF-8 BOM，水印要插在 BOM 之后。插到 BOM 前面 Excel 就认不出编码，中文全乱码。
      out = `﻿# ${BRAND.name}试用版导出（激活后无此行）\n${content.slice(1)}`;
    } else {
      out = `# ${BRAND.name}试用版导出（激活后无此行）\n${content}`;
    }
  }
  return __mkdBaseDownload(filename, out, type);
};

// —— F3：未验证邮箱进入阻断级 ——
const __mkdBasePreflight = preflightOutboxItem;
preflightOutboxItem = function (item) {
  const result = __mkdBasePreflight(item);
  const prospect = state.prospects.find((p) => p.id === item.prospectId);
  // 原实现把"推测未验证"放在 warnings，这里升级为 blockers（口碑保命，不做成可关闭）
  result.warnings = result.warnings.filter((w) => !/推测未验证/.test(w));
  const guard = sendGuard(prospect, item.email);
  if (!guard.ok && !result.blockers.includes(guard.reason)) result.blockers.push(guard.reason);
  // F8：欧盟市场的信必须带退订元素，模板级注入被删掉就拦下
  if (campaignHitsEu(state.campaign) && !item.reply && !hasUnsubscribeElement(item.body)) {
    result.blockers.push("欧盟市场邮件缺退订说明");
  }
  result.ok = result.blockers.length === 0;
  return result;
};

// —— F3：⛔ 徽章改为可点击，点开原因与修复入口 ——
const __mkdBasePreflightBadge = preflightBadge;
preflightBadge = function (item) {
  const html = __mkdBasePreflightBadge(item);
  if (!html.includes("pf-block")) return html;
  return html.replace('class="pf-badge pf-block"', `class="pf-badge pf-block is-clickable" data-mkd-block="${item.id}"`);
};

// —— F3：入队环节的拦截口径 ——
//
// 拦的是"进入待发送"，不是"进入队列"。草稿照样生成并留在【待审批】里带着 ⛔ 徽章——
// 用户要看得见被堵在哪、点开徽章就能修（D3 的预检汇总条本来就有"⛔ N 阻断"这一格）。
// 真正的闸门在 preflightOutboxItem：批量审批、到期发送、自动驾驶、Webhook 派发全都过它，
// 所以这些邮件永远走不到"待发送/已发送"。
const __mkdBaseQueueProspect = queueProspect;
queueProspect = function (prospect, includeFullSequence = true) {
  const guard = sendGuard(prospect, prospect?.email);
  // 试用锁定线索：连草稿都不生成——生成几百条永远发不出去的草稿只会把队列淹掉
  if (guard.trial) {
    if (!mkdQueueBlockNoticed.has(prospect.id)) {
      mkdQueueBlockNoticed.add(prospect.id);
      addLog(`🔒 ${prospect.company} 超出试用版可联系的 ${TRIAL_LEAD_CAP} 条，未入队。激活后解锁，资料已保留。`, { toast: false });
    }
    openTrialWall({ source: "入队" });
    return;
  }
  if (!guard.ok && !mkdQueueBlockNoticed.has(prospect.id)) {
    mkdQueueBlockNoticed.add(prospect.id);
    addLog(`⛔ ${prospect.company} 的草稿已生成，但发不出去：${guard.reason}。先跑一次邮箱验证，或在潜客详情标记「已人工核实」。`, {
      toast: false
    });
  }
  return __mkdBaseQueueProspect(prospect, includeFullSequence);
};
const mkdQueueBlockNoticed = new Set();

// —— F8：预热期日限硬顶 ——
const __mkdBaseRemainingQuota = remainingDailyQuota;
remainingDailyQuota = function () {
  const base = __mkdBaseRemainingQuota();
  if (!inWarmup()) return base;
  return Math.max(0, Math.min(base, WARMUP_DAILY_CAP - sentTodayCount()));
};

// —— F8：WhatsApp 冷发每次弹风险确认 ——
const __mkdBaseDeliverWhatsapp = deliverApprovedWhatsapp;
deliverApprovedWhatsapp = function (quiet = false) {
  const today = dateOffset(0);
  const due = state.whatsappQueue.filter((item) => item.status === "已审批" && item.dueDate <= today);
  const cold = due.filter((item) => !item.coldConfirmed && !hasEmailContact(item.prospectId));
  if (cold.length) {
    // 先把非冷发的送出去，冷发的等确认——不让一次确认卡住整批
    cold.forEach((item) => (item.status = "待人工确认"));
    const sent = __mkdBaseDeliverWhatsapp(quiet);
    confirmColdWhatsapp(cold, () => {
      cold.forEach((item) => {
        item.status = "已审批";
        item.coldConfirmed = true;
      });
      __mkdBaseDeliverWhatsapp(quiet);
      saveState();
      render();
    });
    return sent;
  }
  return __mkdBaseDeliverWhatsapp(quiet);
};

// —— 入池闸门统一并入日志；长任务进行中时同步喂给右下角日志面板 ——
const __mkdBaseAddLog = addLog;
addLog = function (message, options = {}) {
  pushOp("日志", message);
  if (document.getElementById("mkdTaskLog")?.classList.contains("is-on")) taskProgressStep(null, message);
  return __mkdBaseAddLog(message, options);
};

// —— B6：一键起量是产品的"表演时刻"，给顶部细进度条 + 右下角滚动日志 ——
const __mkdBasePipeline = runOneClickPipeline;
runOneClickPipeline = async function () {
  taskProgressStart("一键起量进行中");
  // 四个阶段的进度靠时间推进：真实步骤边界在 07 里，这里只做视觉反馈，不改业务时序
  let pct = 4;
  const timer = setInterval(() => {
    pct = Math.min(94, pct + 2);
    taskProgressStep(pct);
  }, 700);
  try {
    return await __mkdBasePipeline();
  } finally {
    clearInterval(timer);
    taskProgressEnd(
      getActiveView() === "prospects"
        ? "一键起量结束——先完成邮箱验证，通过后再审批发送"
        : "一键起量结束——去发信队列逐封过预检，发送始终等你点最后一下"
    );
  }
};

// —— B6：移入黑名单这类"删了会心慌"的动作给 6 秒撤销窗口 ——
const __mkdBaseMarkOptOut = typeof markProspectOptOut === "function" ? markProspectOptOut : null;
if (__mkdBaseMarkOptOut) {
  markProspectOptOut = function (prospectId) {
    const before = JSON.parse(JSON.stringify({ blacklist: state.blacklist || [], prospect: state.prospects.find((p) => p.id === prospectId) || null }));
    const result = __mkdBaseMarkOptOut(prospectId);
    toastWithUndo(`已移入退订黑名单：${before.prospect?.company || ""}`, () => {
      state.blacklist = before.blacklist;
      if (before.prospect) state.prospects = state.prospects.map((p) => (p.id === prospectId ? before.prospect : p));
      addLog(`已撤销退订标记：${before.prospect?.company || ""}`);
      saveState();
      render();
    });
    return result;
  };
}

/* ---------- 统一 chrome 渲染，挂到 render 之后 ---------- */

function renderCommerceChrome() {
  renderCampaignSwitch();
  renderTrialBadge();
  renderAiLock();
  renderVoyageBar();
  renderSettingsPanels();
  renderCampaignFunnel();
  annotateDisabled();
  document.title = `${BRAND.name}${isTrial() ? "（试用版）" : ""} · ${activeCampaignName()}`;
}

const __mkdBaseRender = render;
render = function () {
  __mkdBaseRender();
  renderCommerceChrome();
};

/* ============================================================================
 * 事件绑定与初始化
 * ==========================================================================*/

// ⛔ 徽章与人工核实按钮：用**捕获阶段**委托。这两个按钮长在发信队列行、潜客详情里，
// 那些容器自己也有 click 处理器；冒泡阶段接会被容器先吃掉，捕获阶段才拦得住。
document.addEventListener(
  "click",
  (event) => {
    const block = event.target.closest("[data-mkd-block]");
    if (block) {
      event.preventDefault();
      event.stopPropagation();
      openBlockPanel(block.dataset.mkdBlock);
      return;
    }
    const mark = event.target.closest("[data-mkd-manual-verify]");
    if (mark) {
      event.preventDefault();
      event.stopPropagation();
      confirmManualVerify(mark.dataset.mkdManualVerify);
      return;
    }
    // 不对口的线索：一键移出（6 秒内可撤销），或者你不同意 AI 的判断就恢复
    const drop = event.target.closest("[data-mkd-drop]");
    if (drop) {
      event.preventDefault();
      event.stopPropagation();
      const gone = state.prospects.find((p) => p.id === drop.dataset.mkdDrop);
      state.prospects = state.prospects.filter((p) => p.id !== drop.dataset.mkdDrop);
      closeProspectDrawer();
      saveState();
      render();
      toastWithUndo(`已移出线索池：${gone?.company || ""}`, () => {
        if (gone) state.prospects = [gone, ...state.prospects];
        saveState();
        render();
      });
      return;
    }
    const keep = event.target.closest("[data-mkd-keep]");
    if (keep) {
      event.preventDefault();
      event.stopPropagation();
      const p = state.prospects.find((x) => x.id === keep.dataset.mkdKeep);
      if (p) {
        p.offTarget = false;
        if (p.status === "不对口") p.status = "已丰富";
        addLog(`已恢复 ${p.company}：按你的判断当对口客户处理（联系方式仍要补全并验证才能发信）`);
        saveState();
        render();
      }
    }
  },
  true
);

document.addEventListener("click", (event) => {
  const preview = event.target.closest("[data-outbox-preview]");
  if (preview) {
    const id = preview.dataset.outboxPreview;
    state.ui = { ...(state.ui || {}), outboxPreviewId: state.ui?.outboxPreviewId === id ? null : id };
    saveState();
    renderOutbox();
    return;
  }
  const seg = event.target.closest("[data-outbox-filter]");
  if (seg) {
    state.ui = { ...(state.ui || {}), outboxFilter: seg.dataset.outboxFilter };
    saveState();
    renderOutbox();
    return;
  }
  const focus = event.target.closest("[data-onboard-focus]");
  if (focus) {
    state.ui = { ...(state.ui || {}), onboardingFocus: Number(focus.dataset.onboardFocus), onboardingCollapsed: false };
    saveState();
    renderChecklist();
    return;
  }
  if (event.target.closest("[data-onboard-selftest]")) {
    openSelfTest();
    return;
  }
  const collapse = event.target.closest("[data-onboard-collapse]");
  if (collapse) {
    state.ui = { ...(state.ui || {}), onboardingCollapsed: !state.ui?.onboardingCollapsed };
    saveState();
    renderChecklist();
    return;
  }
  const done = event.target.closest("[data-onboard-done]");
  if (done) {
    const key = done.dataset.onboardDone;
    state.ui = {
      ...(state.ui || {}),
      onboardingDone: { ...(state.ui?.onboardingDone || {}), [key]: true },
      onboardingFocus: null // 打完勾自动跳到下一步
    };
    saveState();
    renderChecklist();
    return;
  }
  const course = event.target.closest("[data-onboard-course]");
  if (course) {
    mkdModal({
      title: "配套课程",
      width: 640,
      body: `<p>《AI 外贸获客实战营：从零到第一个询盘》按这五步同构编排，每章一个硬指标。</p>
             <p>VIP版及以上可看完整课程；基础版可以先看课程介绍。</p>
             <p class="mkd-hint">购买或咨询：客服微信 ${BRAND.supportWechat}</p>`,
      actions: [
        { label: "关闭", kind: "ghost" },
        { label: "查看课程介绍", kind: "primary", autofocus: true, onClick: () => openSalesPage() }
      ]
    });
  }
});

// 导航记进操作日志，售后排查最需要的就是"他点了什么"；
// 切到大列表页时先铺骨架屏，别让用户看到一闪的白
elements.navTabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    pushOp("导航", tab.dataset.view);
    const host =
      tab.dataset.view === "prospects" ? elements.prospectTable : tab.dataset.view === "automation" ? elements.outboxList : null;
    if (host && !host.children.length) host.innerHTML = skeletonRows(4);
  })
);

// 禁用控件统一带 tooltip：说清"为什么不能点"是本产品最重要的微文案场景
function annotateDisabled() {
  document.querySelectorAll("button:disabled, input:disabled, select:disabled").forEach((el) => {
    if (el.title) return;
    el.title = el.closest(".ai-engine-panel")
      ? "正式版可接入 Claude 等大模型，试用版使用本地规则引擎"
      : el.closest(".pf-segments")
        ? "这一档现在没有邮件"
        : "当前条件下不可用";
  });
}

elements.campaignSwitch?.addEventListener("click", openCampaignMenu);

/* ---------- 设置页：保存不该要求滚回顶部 ---------- */

// 底部常驻保存条按的就是顶部那颗按钮，保存逻辑只有一处，两边不会跑偏
document.getElementById("saveSettingsBottom")?.addEventListener("click", () => elements.saveSettings?.click());

// Ctrl/Cmd+S 在设置页直接保存；其它页不拦截，交还浏览器
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== "s") return;
  if (getActiveView() !== "settings") return;
  event.preventDefault();
  elements.saveSettings?.click();
});

// 改过东西就把保存条点亮，否则用户不知道自己动过什么、该不该保存
function markSettingsDirty(dirty) {
  const bar = document.getElementById("settingsSaveBar");
  const hint = document.getElementById("settingsSaveHint");
  if (!bar || !hint) return;
  bar.classList.toggle("is-dirty", dirty);
  hint.textContent = dirty ? "有改动还没保存" : "改完记得保存 · 也可以按 Ctrl+S";
}
["input", "change"].forEach((evt) =>
  document.getElementById("settingsView")?.addEventListener(evt, (event) => {
    if (!event.target.closest(".settings-savebar")) markSettingsDirty(true);
  })
);
elements.saveSettings?.addEventListener("click", () => markSettingsDirty(false));

/* ---------- 运行状态条：终态不该跟着你逛遍全站 ----------
   条子挂在顶栏下方、独立于视图，好处是长任务跑着时切到哪都看得见——这个要保留。
   但「已完成/失败/中止」是终态：你在控制台已经看过原因了，它没理由再跟到 CRM、
   收件箱、设置页去占一整条。所以：跑着的时候全局常驻，一旦你主动切视图，
   终态就自动收起（成功本来就有 10 秒自动消失）。 */
const __mkdBaseNavigateTo = navigateTo;
navigateTo = function (view) {
  const bar = elements.runStatusBar;
  if (bar && !bar.hidden && typeof runIsActive === "function" && !runIsActive()) runDismiss();
  return __mkdBaseNavigateTo(view);
};

/* ---------- D2 交互：多选 / 行内操作 / 抽屉 / 筛选 / 批量条 ---------- */

// 捕获阶段：勾选框和行内按钮不能触发"选中该行并重渲染"
elements.prospectTable?.addEventListener(
  "click",
  (event) => {
    const box = event.target.closest("[data-prospect-check]");
    if (box) {
      event.stopPropagation();
      toggleProspectSelection(box.dataset.prospectCheck, box.checked);
      return;
    }
    if (event.target.id === "prospectSelectAll") {
      event.stopPropagation();
      const ids = visibleProspectIds();
      const on = event.target.checked;
      ids.forEach((id) => (on ? mkdSelectedProspects.add(id) : mkdSelectedProspects.delete(id)));
      elements.prospectTable.querySelectorAll("[data-prospect-check]").forEach((c) => (c.checked = on));
      renderProspectBulkBar();
      return;
    }
    const grade = event.target.closest("[data-grade-detail]");
    if (grade) {
      event.stopPropagation();
      event.preventDefault();
      openGradeDrawer(grade.dataset.gradeDetail);
      return;
    }
    const queueBtn = event.target.closest("[data-prospect-queue]");
    if (queueBtn) {
      event.stopPropagation();
      event.preventDefault();
      const p = state.prospects.find((x) => x.id === queueBtn.dataset.prospectQueue);
      if (p) {
        queueProspect(p, true);
        addLog(`已把 ${p.company} 加入发信队列（首触仍待你审批发送）`);
        saveState();
        render();
      }
      return;
    }
    const openBtn = event.target.closest("[data-prospect-open]");
    if (openBtn) {
      event.stopPropagation();
      event.preventDefault();
      openProspectDrawer(openBtn.dataset.prospectOpen);
      return;
    }
    const viewQueueBtn = event.target.closest("[data-prospect-view-queue]");
    if (viewQueueBtn) {
      event.stopPropagation();
      event.preventDefault();
      navigateTo("automation");
    }
  },
  true
);

// 行本体点击（07 的处理器已把 selectedProspectId 改好并重渲染）→ 开抽屉
elements.prospectTable?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-prospect-id]");
  if (row) openProspectDrawer(row.dataset.prospectId);
});

elements.prospectTable?.addEventListener("keydown", (event) => {
  const row = event.target.closest("[data-prospect-id]");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openProspectDrawer(row.dataset.prospectId);
  }
});

elements.prospectDrawerOverlay?.addEventListener("click", (event) => {
  if (event.target === elements.prospectDrawerOverlay || event.target.closest("[data-prospect-drawer-close]")) closeProspectDrawer();
});

// 质量分分段控件 → 同步到隐藏的 gradeFilter，既有筛选逻辑一行不用改
elements.gradeSegments?.addEventListener("click", (event) => {
  const seg = event.target.closest("[data-grade]");
  if (!seg) return;
  elements.gradeSegments.querySelectorAll(".segment").forEach((b) => b.classList.toggle("is-active", b === seg));
  if (elements.gradeFilter) elements.gradeFilter.value = seg.dataset.grade;
  renderProspects();
});

[elements.sourceFilter, elements.verifyFilter, elements.marketFilter].forEach((el) =>
  el?.addEventListener("change", () => renderProspects())
);

elements.prospectVerifyBanner?.addEventListener("click", (event) => {
  const act = event.target.closest("[data-verify-banner]")?.dataset.verifyBanner;
  if (act === "filter") {
    if (elements.verifyFilter) elements.verifyFilter.value = "guessed";
    renderProspects();
  } else if (act === "verify") {
    elements.verifyProspects?.click();
  }
});

elements.prospectBulkBar?.addEventListener("click", async (event) => {
  const act = event.target.closest("[data-bulk]")?.dataset.bulk;
  if (!act) return;
  const picked = activeProspects().filter((p) => mkdSelectedProspects.has(p.id));
  if (act === "clear") {
    mkdSelectedProspects.clear();
    renderProspects();
    return;
  }
  if (act === "queue") {
    let n = 0;
    picked.forEach((p) => {
      const before = state.outbox.length;
      queueProspect(p, true);
      if (state.outbox.length > before) n += 1;
    });
    addLog(`已把 ${n} 条线索加入发信队列（发送仍需你逐批审批）`);
  } else if (act === "verify") {
    replaceProspectsById(verifyProspectList(picked, state.campaign));
    addLog(`已对 ${picked.length} 条线索跑邮箱验证——真实源验证要在「设置」配好邮箱查找/验证 Webhook 才生效`);
  } else if (act === "enrich") {
    addLog(`开始批量补全 ${picked.length} 条线索的联系方式…`);
    for (const p of picked) await enrichContactAI(p.id, true);
    addLog(`批量补全完成：${picked.length} 条`);
  }
  mkdSelectedProspects.clear();
  saveState();
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.prospectDrawerOverlay && !elements.prospectDrawerOverlay.hidden) closeProspectDrawer();
});

// 建/改活动后如果目标市场落到欧盟，提示一次 GDPR（延后一拍，等表单值写回 state）
elements.campaignForm?.addEventListener("submit", () => setTimeout(maybeGdprNotice, 120));
elements.newManagedCampaign?.addEventListener("click", () => setTimeout(maybeGdprNotice, 120));

async function initCommerce() {
  const bridge = mkdBridge();
  if (bridge) {
    try {
      MKD_APP_INFO = await bridge.appInfo();
      BRAND.version = MKD_APP_INFO.version;
      BRAND.salesUrl = MKD_APP_INFO.salesUrl || BRAND.salesUrl;
      MKD_MACHINE = await bridge.machineCode();
      MKD_LICENSE = await bridge.licenseStatus();
      if (bridge.mailSummary) MKD_MAIL = await bridge.mailSummary();
    } catch (error) {
      pushError("初始化", error.message, error.stack);
    }
    bridge.onMainError((payload) => showFatalError(`${payload.scope}：${payload.message}`));
    bridge.onUpdateReady((info) => renderUpdateDot(info.version));
    bridge.onOpenAbout(() => openAbout());
    bridge.onExportDiagnostics(() => exportDiagnostics());
    bridge.onRestartOnboarding(() => restartOnboarding());
  }

  mountSettingsPanels();
  bindSettingsAnchors();
  renderCommerceChrome();
  render();

  ensureAgreement(() => {
    // 同意协议之后才轮到欢迎向导（全新用户、还没有线索时才弹）
    if (!state.ui?.welcomeSeen && !state.prospects.length && elements.welcomeOverlay) {
      elements.welcomeOverlay.hidden = false;
    }
    maybeShowChangelog();
  });
  await runDailyBackup();
  // 更新检查放在最后且静默：网络慢也不该拖住界面
  setTimeout(() => checkUpdate({ silent: true }), 4000);
  pushOp("启动", `${editionLabel()} 启动完成`, `线索 ${state.prospects.length} 条`);
}

initCommerce();

// 官网抓取 / 邮箱验证 / 域名护航（渲染层）
//
// 这个模块排在 08 之后，所以可以继续用「包一层」的方式改上游行为。
//
// 三件事，共同的原则是一条：**只搬运事实，不生产事实**。
//   1) 官网抓取——把企业自己写在 contact 页上的邮箱抄下来，留出处链接
//   2) 邮箱验证——问对方服务器这个地址存不存在，测不出就说测不出
//   3) 域名护航——把我们一直在做但用户看不见的保护，翻译成看得见的数字
//
// 为什么官网抓取排在 Hunter 前面：它免费、不要 key、结果是企业主动公示的
// 一手信息。用户装完软件不配任何东西就能拿到真实联系人——这是"十分钟发出
// 第一封"的前提。

function netReady() {
  const b = mkdBridge();
  return !!(b && typeof b.siteHarvest === "function");
}

/* ============================ 官网抓取联系方式 ============================ */

// 把抓到的结果落成线索字段。抓不到就是抓不到，不补任何东西。
function applyHarvest(prospectId, harvest) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect || !harvest || !harvest.ok) return false;

  const emails = harvest.emails || [];
  if (!emails.length && !harvest.phones?.length && !Object.keys(harvest.social || {}).length) return false;

  const candidates = emails.map((e) => ({
    email: e.email,
    // 走 F3 的"已验证"口径：这是官网公示的地址，不是猜的
    pattern: "官网公示",
    confidence: e.how === "mailto" ? 92 : e.how === "obfuscated" ? 86 : 80,
    source_url: e.sourceUrl,
    how: e.how,
    sameDomain: e.sameDomain
  }));

  state.prospects = state.prospects.map((p) => {
    if (p.id !== prospectId) return p;
    const next = { ...p };
    if (candidates.length) {
      next.email = candidates[0].email;
      next.emailCandidates = candidates;
      next.contactSource = "website";
      next.contactSourceUrl = candidates[0].source_url;
      if (next.status === "待查联系人") next.status = "待联系";
    }
    if (harvest.phones?.length && !next.phone) next.phone = harvest.phones[0];
    if (harvest.social && Object.keys(harvest.social).length) {
      next.social = { ...(next.social || {}), ...harvest.social };
      if (harvest.social.linkedin && !next.linkedin) next.linkedin = harvest.social.linkedin;
    }
    next.harvestedAt = new Date().toISOString();
    next.harvestPages = (harvest.visited || []).length;
    return next;
  });
  return candidates.length > 0;
}

// 抓一家公司的官网。返回 "website" | "none" | "skip"
async function harvestProspectSite(prospectId, quiet = false) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect) return "skip";
  if (!prospect.website) {
    if (!quiet) addLog(`${prospect.company} 没有官网地址，抓不了——先用「批量解析官网」补域名`);
    return "skip";
  }
  if (!netReady()) {
    if (!quiet) addLog("官网抓取只有桌面版能用（浏览器直开受同源策略限制，抓不了外站）");
    return "skip";
  }

  const res = await window.mkd.siteHarvest(prospect.website, 4);
  if (!res || !res.ok) {
    if (!quiet) addLog(`打不开 ${prospect.website}：${res?.reason || "未知原因"}`);
    return "none";
  }
  const got = applyHarvest(prospectId, res);
  if (!quiet) {
    const pages = (res.visited || []).length;
    if (got) {
      const p2 = state.prospects.find((p) => p.id === prospectId);
      addLog(
        `官网抓到真实联系方式：${prospect.company} → ${p2.email}（抓了 ${pages} 页，出处 ${p2.contactSourceUrl}）。` +
          `这是企业自己公示的地址，不是推测。`
      );
    } else {
      addLog(`${prospect.company} 官网抓了 ${pages} 页，没有公示邮箱${res.blockedByRobots ? `（${res.blockedByRobots} 页被 robots.txt 拒绝）` : ""}`);
    }
  }
  return got ? "website" : "none";
}

// 批量抓。给进度、可中止、不并发轰炸（主进程那层已限流到 3）
async function batchHarvestSites(ids) {
  const targets = (ids || [])
    .map((id) => state.prospects.find((p) => p.id === id))
    .filter((p) => p && p.website && !p.email);
  if (!targets.length) {
    addLog("没有需要抓的线索（要有官网、且还没有邮箱）");
    return;
  }
  if (!netReady()) {
    addLog("官网抓取只有桌面版能用");
    return;
  }

  runBegin("抓官网联系方式", `准备抓 ${targets.length} 家公司`);
  let hit = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (!runIsActive()) break; // 用户中止
    runStep(`${i + 1}/${targets.length} · ${targets[i].company}`);
    const r = await harvestProspectSite(targets[i].id, true);
    if (r === "website") hit += 1;
  }
  saveState();
  render();
  const rate = Math.round((hit / targets.length) * 100);
  runDone(
    `抓到 ${hit}/${targets.length} 家（${rate}%）`,
    hit ? "全部来自企业官网公示，可点开出处核对" : "这批公司官网上都没有公示邮箱"
  );
  addLog(`官网抓取完成：${targets.length} 家里拿到 ${hit} 家真实邮箱（${rate}%），零编造`);
}

/* ============================== 邮箱存在性验证 ============================== */

const PROBE_STATUS_TEXT = {
  valid: "对方服务器确认存在",
  invalid: "对方服务器说这个地址不存在",
  "catch-all": "对方收所有地址，测不出",
  unknown: "测不出"
};

async function probeProspectEmail(prospectId, quiet = false) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect || !prospect.email) return null;
  if (!netReady()) {
    if (!quiet) addLog("邮箱存在性验证只有桌面版能用");
    return null;
  }

  const fromDomain = (state.settings.senderEmail || "").split("@")[1] || "example.com";
  const res = await window.mkd.verifyEmail(prospect.email, { fromDomain });
  if (!res) return null;

  state.prospects = state.prospects.map((p) =>
    p.id === prospectId ? { ...p, emailProbe: { ...res, at: new Date().toISOString() } } : p
  );

  if (!quiet) {
    addLog(
      `邮箱探测 ${prospect.email}：${PROBE_STATUS_TEXT[res.status] || res.status}——${res.reason}` +
        (res.status === "invalid" ? "。建议别发，发了就是一次退信。" : "")
    );
  }
  return res;
}

async function batchProbeEmails(ids) {
  const targets = (ids || [])
    .map((id) => state.prospects.find((p) => p.id === id))
    .filter((p) => p && p.email && !p.emailProbe);
  if (!targets.length) {
    addLog("没有需要探测的邮箱（要有邮箱、且还没探测过）");
    return;
  }

  runBegin("验证邮箱是否真实存在", `准备探测 ${targets.length} 个地址`);
  const tally = { valid: 0, invalid: 0, "catch-all": 0, unknown: 0 };
  for (let i = 0; i < targets.length; i += 1) {
    if (!runIsActive()) break; // 用户中止
    runStep(`${i + 1}/${targets.length} · ${maskEmail(targets[i].email)}`);
    const r = await probeProspectEmail(targets[i].id, true);
    if (r) tally[r.status] = (tally[r.status] || 0) + 1;
  }
  saveState();
  render();

  const parts = [];
  if (tally.valid) parts.push(`${tally.valid} 个确认存在`);
  if (tally.invalid) parts.push(`${tally.invalid} 个不存在`);
  if (tally["catch-all"]) parts.push(`${tally["catch-all"]} 个对方收全部地址`);
  if (tally.unknown) parts.push(`${tally.unknown} 个测不出`);
  runDone(parts.join(" · ") || "没有结论", tally.invalid ? `${tally.invalid} 个发出去就是退信，建议先删掉` : "");
  addLog(`邮箱探测完成：${parts.join("、")}`);
}

/* ================================ 域名护航 ================================ */

// 我们一直在拦、在限速、在挡不合规的信，但这些全是隐形的——用户只感觉到
// "这软件老不让我发"。这里把它翻译成看得见的数字和一句人话。
function escortStats() {
  const out = state.outbox || [];
  const sent = out.filter((o) => o.status === "已发送");
  const bounced = sent.filter((o) => o.bounced).length;
  const blocked = out.filter((o) => o.status === "待发送" && !preflightOutboxItem(o).ok).length;

  const guessedHeld = (state.prospects || []).filter(
    (p) => p.email && emailVerificationState(p, p.email) === "guessed"
  ).length;

  const probedBad = (state.prospects || []).filter((p) => p.emailProbe?.status === "invalid").length;

  const bounceRate = sent.length ? (bounced / sent.length) * 100 : null;
  const day = Math.min(WARMUP_DAYS, Math.max(1, warmupDayIndex()));
  const today = dateOffset(0);
  const sentToday = sent.filter((o) => (o.sentAt || "").slice(0, 10) === today).length;
  const warm = inWarmup()
    ? { day, remaining: Math.max(0, WARMUP_DAILY_CAP - sentToday), cap: WARMUP_DAILY_CAP }
    : null;

  return {
    blocked,
    guessedHeld,
    probedBad,
    sentTotal: sent.length,
    bounced,
    bounceRate,
    warm,
    // 拦下来的每一封，都是一次没有发生的退信
    savedBounces: guessedHeld + probedBad
  };
}

function escortPanelHtml() {
  const s = escortStats();
  const rateText = s.bounceRate === null ? "—" : `${s.bounceRate.toFixed(1)}%`;
  const rateLevel = s.bounceRate === null ? "" : s.bounceRate <= 2 ? "good" : s.bounceRate <= 5 ? "warn" : "bad";

  const tiles = [
    {
      k: "已拦下",
      v: s.savedBounces,
      u: "封",
      hint: s.savedBounces
        ? `${s.guessedHeld} 个来源存疑 + ${s.probedBad} 个探测确认不存在。这些如果发出去，就是 ${s.savedBounces} 次退信。`
        : "目前没有存疑地址被拦下"
    },
    {
      k: "你的退信率",
      v: rateText,
      u: "",
      level: rateLevel,
      hint:
        s.bounceRate === null
          ? "还没发出过邮件"
          : `${s.bounced}/${s.sentTotal} 退回。行业普遍在 5% 上下，超过 5% 邮件服务商就开始降权，超过 10% 有封号风险。`
    },
    {
      k: "域名预热",
      v: s.warm ? `第 ${s.warm.day}` : "已完成",
      u: s.warm ? ` / ${WARMUP_DAYS} 天` : "",
      hint: s.warm
        ? `今天还能发 ${s.warm.remaining} 封（上限 ${s.warm.cap}）。新域名前 ${WARMUP_DAYS} 天压着发，是为了让邮件服务商把你认成正常用户，而不是刚上线就群发的机器。`
        : "预热期已过，日发上限按你自己的设置走"
    }
  ];

  return `
    <div class="escort-panel">
      <div class="escort-head">
        <span class="escort-title">发信护航</span>
        <span class="escort-sub">这些是软件替你挡掉的事，挡住了你就不会知道它发生过</span>
      </div>
      <div class="escort-tiles">
        ${tiles
          .map(
            (t) => `
          <div class="escort-tile${t.level ? ` is-${t.level}` : ""}">
            <div class="escort-k">${escapeHtml(t.k)}</div>
            <div class="escort-v">${escapeHtml(String(t.v))}<span>${escapeHtml(t.u)}</span></div>
            <p class="escort-hint">${escapeHtml(t.hint)}</p>
          </div>`
          )
          .join("")}
      </div>
      <div class="escort-foot">
        <button type="button" class="btn-ghost" data-mkd-domain-check>体检发信域名（SPF / DKIM / DMARC）</button>
        <span class="escort-foot-note">很多人这三项一项都没配，配好之后送达率会有肉眼可见的变化</span>
      </div>
      <div id="domainHealthBox" class="domain-health-box"></div>
    </div>`;
}

/* ---------------------------- 域名体检 ---------------------------- */

const HEALTH_LEVEL_TEXT = { ok: "正常", warn: "建议改", bad: "必须修", unknown: "查不准" };

function renderDomainHealth(result) {
  const box = document.getElementById("domainHealthBox");
  if (!box) return;
  if (!result) {
    box.innerHTML = "";
    return;
  }
  if (!result.ok) {
    box.innerHTML = `<p class="health-error">体检失败：${escapeHtml(result.reason || "未知原因")}</p>`;
    return;
  }

  box.innerHTML = `
    <div class="health-head">
      <span class="health-grade health-${result.grade.toLowerCase()}">${escapeHtml(result.grade)}</span>
      <div>
        <strong>${escapeHtml(result.domain)}</strong>
        <span class="health-summary">${escapeHtml(result.summary)}</span>
      </div>
    </div>
    <ul class="health-list">
      ${result.checks
        .map(
          (c) => `
        <li class="health-item is-${c.level}">
          <span class="health-tag">${escapeHtml(HEALTH_LEVEL_TEXT[c.level] || c.level)}</span>
          <div class="health-body">
            <strong>${escapeHtml(c.title)}</strong>
            <p>${escapeHtml(c.detail)}</p>
            ${c.fix ? `<p class="health-fix"><span>怎么改</span>${escapeHtml(c.fix)}</p>` : ""}
          </div>
        </li>`
        )
        .join("")}
    </ul>`;
}

async function runDomainCheck() {
  const box = document.getElementById("domainHealthBox");
  const sender = state.settings.senderEmail || "";
  const domain = sender.split("@")[1] || "";
  if (!domain) {
    if (box) box.innerHTML = `<p class="health-error">先在「设置 → 发信」填上发件邮箱，才知道要体检哪个域名。</p>`;
    return;
  }
  if (!netReady()) {
    if (box) box.innerHTML = `<p class="health-error">域名体检只有桌面版能用（浏览器里发不了 DNS 查询）。</p>`;
    return;
  }
  if (box) box.innerHTML = `<p class="health-loading">正在查 ${escapeHtml(domain)} 的 DNS 记录…</p>`;
  const result = await window.mkd.domainHealth(domain);
  renderDomainHealth(result);
  if (result?.ok) {
    addLog(`域名体检 ${result.domain}：${result.grade} 级 · ${result.summary}`);
  }
}

/* ============================== 挂到现有流程上 ============================== */

// 联系人补全：官网抓取插到最前面。免费、真实、不要 key——
// 用户装完不配任何东西就能拿到联系人，这是"十分钟发出第一封"的前提。
if (typeof enrichContactAI === "function") {
  const __enrichBase = enrichContactAI;
  enrichContactAI = async function (prospectId, quiet = false) {
    const prospect = state.prospects.find((p) => p.id === prospectId);
    if (prospect && prospect.website && !prospect.email && netReady()) {
      const got = await harvestProspectSite(prospectId, quiet);
      if (got === "website") {
        saveState();
        render();
        return "website";
      }
    }
    return __enrichBase(prospectId, quiet);
  };
}

// 来源标签认识新来源
if (typeof contactSourceLabel === "function") {
  const __labelBase = contactSourceLabel;
  contactSourceLabel = function (source) {
    if (source === "website") return "官网公示";
    return __labelBase(source);
  };
}

// 事件委托（捕获阶段——容器上的处理器会吃掉冒泡）
document.addEventListener(
  "click",
  (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;

    if (t.closest("[data-mkd-domain-check]")) {
      e.preventDefault();
      e.stopPropagation();
      runDomainCheck();
      return;
    }

    const harvestOne = t.closest("[data-mkd-harvest]");
    if (harvestOne) {
      e.preventDefault();
      e.stopPropagation();
      harvestProspectSite(harvestOne.getAttribute("data-mkd-harvest")).then(() => {
        saveState();
        render();
      });
      return;
    }

    const probeOne = t.closest("[data-mkd-probe]");
    if (probeOne) {
      e.preventDefault();
      e.stopPropagation();
      probeProspectEmail(probeOne.getAttribute("data-mkd-probe")).then(() => {
        saveState();
        render();
      });
      return;
    }

    if (t.closest("[data-mkd-harvest-batch]")) {
      e.preventDefault();
      e.stopPropagation();
      batchHarvestSites((state.prospects || []).map((p) => p.id));
      return;
    }

    if (t.closest("[data-mkd-probe-batch]")) {
      e.preventDefault();
      e.stopPropagation();
      batchProbeEmails((state.prospects || []).map((p) => p.id));
    }
  },
  true
);

/* ------------------------- 挂载到界面 ------------------------- */

// 护航面板挂在发信队列页——用户在这里决定发不发，护航信息就该在这里
function mountEscortPanel() {
  const view = document.getElementById("automationView");
  if (!view) return;
  let box = document.getElementById("mkdEscort");
  if (!box) {
    box = document.createElement("div");
    box.id = "mkdEscort";
    // 排在起航航程条之后：航程条讲"你走到第几天"，护航讲"替你挡了什么"
    const voyage = document.getElementById("mkdVoyage");
    if (voyage && voyage.nextSibling) view.insertBefore(box, voyage.nextSibling);
    else view.insertBefore(box, view.firstChild);
  }
  // 体检结果是异步填进去的，重渲染时别把它冲掉
  const keep = document.getElementById("domainHealthBox")?.innerHTML || "";
  box.innerHTML = escortPanelHtml();
  if (keep) {
    const slot = document.getElementById("domainHealthBox");
    if (slot) slot.innerHTML = keep;
  }
}

// 潜客页顶部加两个批量按钮
function mountProspectNetActions() {
  const view = document.getElementById("prospectsView");
  if (!view || document.getElementById("mkdNetActions")) return;
  const header = view.querySelector(".section-header .topbar-actions, .section-header");
  if (!header) return;
  const wrap = document.createElement("span");
  wrap.id = "mkdNetActions";
  wrap.className = "mkd-net-actions";
  wrap.innerHTML = `
    <button type="button" class="btn-ghost" data-mkd-harvest-batch title="打开每家公司的官网，把 contact 页上公示的邮箱抄下来。不猜、不拼、留出处。">
      抓官网联系方式
    </button>
    <button type="button" class="btn-ghost" data-mkd-probe-batch title="连对方邮件服务器问这个地址存不存在，走到 RCPT 就停，不发信、不打扰任何人。">
      验证邮箱真伪
    </button>`;
  header.appendChild(wrap);
}

const __netBaseRender = render;
render = function () {
  __netBaseRender();
  try {
    mountEscortPanel();
    mountProspectNetActions();
  } catch (error) {
    console.error("[netprobe] 挂载失败", error);
  }
};

/* ==================== ⑦ 开发信引用官网上的真实事实 ==================== */

// 竞品靠海关记录做个性化（"你 3 月进口过 X"），但那只对有海关记录的公司有效。
// 官网人人都有，而且引用对方官网上的**具体**产品/业务描述，比引用一条采购记录
// 更难被识破为模板。
//
// 红线不变：只摘录官网原话，不概括、不推断、不润色成"我们研究了贵司业务"。
// 每次引用都记下用了哪条事实、出处是哪个 URL，用户点开就能核对。

function pickFact(prospect) {
  const facts = prospect?.siteFacts || [];
  if (!facts.length) return null;
  // 描述 > 小标题 > 标题：描述是企业自己写的一句话介绍，最适合引用
  const order = { 描述: 0, 小标题: 1, 标题: 2 };
  return [...facts].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))[0];
}

// 生成一句引用。刻意写得克制——夸张的"我深入研究了贵司"反而假。
function factOpener(prospect) {
  const fact = pickFact(prospect);
  if (!fact) return null;
  const quote = fact.text.length > 160 ? `${fact.text.slice(0, 157)}...` : fact.text;
  return {
    line: `I read on your website that "${quote}"`,
    fact
  };
}

if (typeof buildEmailSequence === "function") {
  const __seqBase = buildEmailSequence;
  buildEmailSequence = function (campaign, prospect) {
    const seq = __seqBase(campaign, prospect);
    const opener = factOpener(prospect);
    if (!opener || !seq.length) return seq;

    // 只改首封：后续跟进再重复引用同一句就显得刻意了
    const first = seq[0];
    const lines = String(first.body || "").split("\n");
    // 插在称呼之后、正文之前
    const at = lines.findIndex((l) => /^(Dear|Hi|Hello)/i.test(l.trim()));
    const insertAt = at >= 0 ? at + 1 : 0;
    lines.splice(insertAt, 0, "", `${opener.line}, which is exactly why I am reaching out.`);
    first.body = lines.join("\n");
    first.factUsed = { text: opener.fact.text, sourceUrl: opener.fact.sourceUrl };
    return seq;
  };
}

// 抓官网时把事实一起存下来
if (typeof applyHarvest === "function") {
  const __applyBase = applyHarvest;
  applyHarvest = function (prospectId, harvest) {
    const got = __applyBase(prospectId, harvest);
    if (harvest?.facts?.length) {
      state.prospects = state.prospects.map((p) => (p.id === prospectId ? { ...p, siteFacts: harvest.facts } : p));
      return true; // 就算没抓到邮箱，抓到事实也算有收获
    }
    return got;
  };
}

/* ==================== ⑥ 打开追踪：次数 + 自有域名 ==================== */

// 竞品的追踪像素挂在**他们自己的**域名上——等于把你所有客户的打开时间、
// IP、设备全交给服务商。我们让你把像素挂到自己的域名上，追踪数据同样不出你手。
//
// 说清楚一件事：没有配追踪端点就是**没有打开数据**。我们不会拿"预计打开率"
// 之类的估算糊弄你——那又是一种编造。
function trackingBase() {
  return (state.settings?.trackingBase || "").trim();
}

function trackingPixelFor(outboxId) {
  const base = trackingBase();
  if (!base) return "";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}e=${encodeURIComponent(outboxId)}`;
}

function trackingReady() {
  return !!trackingBase();
}

// 打开次数的累加做在 02-inbox-relay 的中继事件处理里（那段是内联的，
// 不是具名函数，包不了一层）。这里只负责读。

function prospectOpenCount(prospectId) {
  return (state.outbox || [])
    .filter((o) => o.prospectId === prospectId && o.status === "已发送")
    .reduce((n, o) => n + (o.openCount || (o.opened ? 1 : 0)), 0);
}

/* ==================== ⑤ 行为驱动的跟进 ==================== */

// 固定 7-14-30-60 天的节奏对所有人一视同仁，但"打开了 5 次没回"和
// "一次都没打开"显然该走不同的路。这里按真实行为分支。
//
// 每条分支都只依赖**观测到的事实**（发了几封、打开几次、退信没有、
// 有没有自动回复），不含任何"AI 判断他有意向"。

const FOLLOWUP_BRANCHES = [
  {
    key: "replied",
    title: "已回复",
    when: (c) => c.replied,
    advice: "对方已经回信了——后续序列已自动停掉，接下来手动跟。",
    action: "stop"
  },
  {
    key: "bounced",
    title: "退信",
    when: (c) => c.bounced,
    advice: "这个地址退信了，继续发只会伤域名信誉。已停掉并建议拉黑该地址。",
    action: "stop"
  },
  {
    key: "ooo",
    title: "自动回复（休假/离职）",
    when: (c) => c.ooo,
    advice: "收到的是自动回复，人不在。暂停 7 天再续，或按自动回复里给的备用联系人改投。",
    action: "defer"
  },
  {
    key: "hot",
    title: "打开 ≥3 次但没回",
    when: (c) => c.opens >= 3 && !c.replied,
    advice: "意向最强的一档：他反复在看，只是还没动笔。换成「给具体价格/规格表」这类降低回复成本的内容，别再发泛泛介绍。",
    action: "escalate"
  },
  {
    key: "warm",
    title: "打开过 1-2 次",
    when: (c) => c.opens >= 1 && !c.replied,
    advice: "信送到了、也看了。按原节奏继续，下一封给点新东西（工厂视频、同类客户案例）。",
    action: "continue"
  },
  {
    key: "unknown",
    title: "没有打开数据",
    when: (c) => !c.tracking && c.opens === 0,
    advice:
      "还没配追踪端点，所以拿不到打开数据——注意这是「测不到」，不是「对方没打开」。只能按固定节奏跟进；配好追踪之后这里会按真实行为分支。",
    action: "continue"
  },
  {
    // 必须要求 tracking：没配追踪时 opens 恒为 0，不加这个条件会把**所有人**
    // 判成"没打开"并自动暂停序列。测不到不等于没打开——这是两回事。
    key: "cold",
    title: "发了 ≥3 封一次没打开",
    when: (c) => c.tracking && c.sent >= 3 && c.opens === 0,
    advice:
      "连续没打开，多半是主题行没吸引力、或者根本进了垃圾箱。建议先换主题行重发一次；再没反应就暂停这条，别把额度耗在这里——这也是在保护你的域名信誉。",
    action: "pause"
  },
  {
    key: "early",
    title: "刚发出，等回音",
    when: () => true,
    advice: "才发出去不久，先按节奏等。",
    action: "continue"
  }
];

function followupContext(prospectId) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  const items = (state.outbox || []).filter((o) => o.prospectId === prospectId);
  const sent = items.filter((o) => o.status === "已发送");
  return {
    replied: prospect?.status === "已回复",
    bounced: sent.some((o) => o.bounced),
    ooo: !!prospect?.autoReply,
    opens: prospectOpenCount(prospectId),
    sent: sent.length,
    // 「有没有打开数据」而不是「有没有配像素」——用户接的中继/ESP 本来就会
    // 报回 opened 事件，那也是真实数据
    tracking: trackingReady() || sent.some((o) => o.openCount || o.opened)
  };
}

function followupBranch(prospectId) {
  const ctx = followupContext(prospectId);
  const hit = FOLLOWUP_BRANCHES.find((b) => b.when(ctx)) || FOLLOWUP_BRANCHES[FOLLOWUP_BRANCHES.length - 1];
  return { ...hit, ctx };
}

// 连续没打开就自动暂停——既提效果，也是护航策略的延伸：
// 一直往一个不看你信的地址发，对送达率是纯负担。
function autoPauseColdSequences() {
  let paused = 0;
  (state.prospects || []).forEach((p) => {
    const b = followupBranch(p.id);
    if (b.action !== "pause" || p.sequencePaused) return;
    p.sequencePaused = true;
    p.sequencePausedReason = b.title;
    (state.outbox || [])
      .filter((o) => o.prospectId === p.id && o.status === "待发送")
      .forEach((o) => {
        o.status = "已暂停";
        o.pausedReason = "连续未打开，自动暂停以保护域名信誉";
      });
    paused += 1;
  });
  if (paused) {
    addLog(`自动暂停 ${paused} 条连续未打开的跟进序列——一直发给不看信的地址，只会拖累送达率。可在潜客详情里手动恢复。`);
    saveState();
  }
  return paused;
}

/* ==================== ④ 十分钟发出第一封 ==================== */

// 这是我们输得最惨的一环：竞品注册完输个 HS 编码就出结果，我们要用户
// 配 key、定位、自己去搜、粘回来、配 SMTP、还要熬 14 天预热。
// 试用只有 20 条线索，用户很可能在发出第一封之前就把耐心耗光了。
//
// 这个向导把"到第一封信发出"这条路上的每一步都摊开，每步都能看到
// 「还差什么」和「点这里做」，并且明确标出哪些是**现在就能跳过的**。

function firstSendSteps() {
  const camp = state.campaign || {};
  const hasProduct = !!(camp.product || "").trim();
  // 目标市场和产品一样是硬前置：第 2 步的 requireCampaignBrief 两个都要。
  // 以前第 1 步只问产品就打勾，用户粘完整页搜索结果才被「缺目标市场」挡回来。
  const hasMarkets = !!(camp.markets || "").trim();
  const hasLeads = (state.prospects || []).length > 0;
  const withEmail = (state.prospects || []).filter((p) => p.email).length;
  const mailReady = !!(state.settings?.senderEmail || "").trim();
  const everSent = (state.outbox || []).some((o) => o.sentAt);

  return [
    {
      key: "product",
      title: hasProduct ? "说清卖到哪儿去" : "说清你卖什么",
      done: hasProduct && hasMarkets,
      need: hasProduct
        ? "产品有了，还缺目标市场——不填的话下一步解析线索会被直接挡回来"
        : "填一个具体产品（越具体越好，「无人机植保喷头」比「农业机械」强得多）",
      how: "填完就存，不用跳去别的页面",
      goto: "focus",
      // 就地做：一个输入框 + 保存。产品填完自动换成目标市场，两个都齐了才打勾。
      inline: hasProduct
        ? {
            kind: "text",
            field: "markets",
            placeholder: "例如：美国、加拿大、德国",
            value: (camp.markets || "").trim(),
            submit: "保存目标市场"
          }
        : {
            kind: "text",
            field: "product",
            placeholder: "例如：无人机植保喷头",
            value: (camp.focusProduct || camp.product || "").trim(),
            submit: "保存产品"
          },
      skippable: false
    },
    {
      key: "leads",
      title: "弄到一批公司",
      done: hasLeads,
      need: "线索池里一家公司都还没有",
      how: "在 Google 搜「产品 + importer/distributor + 国家」，整页 Ctrl+A 复制，粘到下面直接解析——不需要任何 API key",
      goto: "prospects",
      // 就地做：粘贴框 + 解析（这一步最容易卡住，跳过去还要自己找输入框）
      inline: {
        kind: "textarea",
        field: "leads",
        placeholder: "把 Google 搜索结果整页粘贴到这里，界面文字会自动滤掉，只留真实公司",
        submit: "解析为线索"
      },
      skippable: false
    },
    {
      key: "contacts",
      title: "拿到真实联系方式",
      done: withEmail > 0,
      need: "还没有任何一条线索有邮箱",
      how: netReady()
        ? "直接读企业官网 contact 页上公示的邮箱：不要 key、不花钱、也不编造"
        : "桌面版可以直接抓官网；浏览器模式下需要配 Hunter 或邮箱查找 Webhook",
      goto: "prospects",
      // 就地做：一个按钮跑批量抓取（浏览器模式下抓不了，退回跳转）
      inline: netReady() ? { kind: "action", field: "harvest", submit: "抓官网联系方式" } : null,
      skippable: false
    },
    {
      key: "mail",
      title: "配好发件邮箱",
      done: mailReady,
      need: "还没填发件邮箱",
      // 密码类配置不在这里做第二套表单：设置页那套有完整的 SMTP/IMAP 和测试连接，
      // 复制一份出来既容易走样，也多一个填授权码的地方。这里只保证跳过去正好落在发信那一段。
      how: "「设置 → 发信」填邮箱和授权码（注意是授权码，不是登录密码）。填完点「测试连接」，失败会直接告诉你该改什么",
      goto: "settings",
      anchor: "mail",
      inline: null,
      skippable: false
    },
    {
      key: "send",
      title: "先发一封给自己",
      done: everSent,
      need: "还没发出过任何邮件",
      how: "发给自己不占预热额度、也不受日限。收到之后看它进的是收件箱还是垃圾箱——这一步能提前发现 90% 的送达问题",
      goto: "automation",
      // 就地做：直接开自测弹窗，不用先跳到自动化页再找入口
      inline: { kind: "action", field: "selftest", submit: "发一封给自己" },
      skippable: false
    }
  ];
}

/* 每一步的就地操作区。
   原来每步只给一个「去这里做」，把人丢到另一个页面上自己找输入框——
   卡在哪一步就在哪一步做完，少一次跳转就少一次走丢。
   跳转按钮始终保留：有人就是想去那个页面看全貌。 */
function firstSendInlineHtml(step) {
  const goLabel = step.inline ? "打开对应页面" : "去这里做";
  const goto = escapeHtml(step.goto);
  const anchor = step.anchor ? ` data-mkd-anchor="${escapeHtml(step.anchor)}"` : "";
  const go = `<button type="button" class="btn-ghost firstsend-go" data-mkd-goto="${goto}"${anchor}>${goLabel}</button>`;
  const box = step.inline;
  if (!box) return go;

  const field = escapeHtml(box.field);
  const run = `<button type="button" class="btn-primary firstsend-run" data-mkd-step-run="${field}">${escapeHtml(box.submit)}</button>`;

  if (box.kind === "action") {
    return `<div class="firstsend-actions">${run}${go}</div>`;
  }
  const input =
    box.kind === "textarea"
      ? `<textarea class="firstsend-input" data-mkd-step-input="${field}" rows="4" placeholder="${escapeHtml(box.placeholder || "")}"></textarea>`
      : `<input class="firstsend-input" data-mkd-step-input="${field}" type="text" value="${escapeHtml(box.value || "")}" placeholder="${escapeHtml(box.placeholder || "")}" />`;
  return `<div class="firstsend-inline">${input}<div class="firstsend-actions">${run}${go}</div></div>`;
}

// 就地执行某一步。返回一句结果说明，交给状态条统一呈现。
async function runFirstSendStep(field, value) {
  if (field === "product") {
    const text = (value || "").trim();
    if (!text) return { ok: false, msg: "先填一个具体产品再保存" };
    state.campaign.focusProduct = text;
    if (!(state.campaign.product || "").trim() || state.ui?.starterTemplate) state.campaign.product = text;
    if (state.ui?.starterTemplate) state.ui = { ...state.ui, starterTemplate: false };
    bindCampaignForm();
    autoNameCampaign(); // 向导不走 readCampaignFromForm，得自己触发一次改名
    saveState();
    return { ok: true, msg: `已锁定产品「${text}」，接着填目标市场` };
  }

  if (field === "markets") {
    const text = (value || "").trim();
    if (!text) return { ok: false, msg: "先填一个目标市场再保存" };
    state.campaign.markets = text;
    bindCampaignForm();
    autoNameCampaign(); // 向导不走 readCampaignFromForm，得自己触发一次改名
    saveState();
    return { ok: true, msg: `已锁定目标市场「${text}」，可以去找客户了` };
  }

  if (field === "leads") {
    const text = (value || "").trim();
    if (!text) return { ok: false, msg: "先把搜索结果粘贴进来" };
    if (!requireCampaignBrief("解析线索")) return { ok: false, msg: "" };
    if (!state.searchPlan.length) state.searchPlan = generateSearchPlan(state.campaign);
    const imported = importSearchResultsText(text, state.campaign);
    if (!imported.length) {
      return { ok: false, msg: "这段文字里没解析出公司——确认复制的是搜索结果页，而不是只有几个标题" };
    }
    const admitted = admitProspects(imported, "搜索结果导入");
    state.prospects = [...admitted, ...state.prospects];
    agentOnProspectsImported(admitted);
    const withMail = admitted.filter((p) => p.email).length;
    saveState();
    return { ok: true, msg: `导入 ${admitted.length} 家公司${withMail ? `，其中 ${withMail} 家带邮箱` : "，下一步补全联系方式"}` };
  }

  if (field === "harvest") {
    const targets = activeProspects().filter((p) => p.website && !p.email);
    if (!targets.length) return { ok: false, msg: "没有可抓的线索：要有官网、且还没有邮箱" };
    await batchHarvestSites(targets.map((p) => p.id));
    return { ok: true, msg: "" }; // batchHarvestSites 自己会报进度和结果
  }

  if (field === "selftest") {
    openSelfTest();
    return { ok: true, msg: "" };
  }
  return { ok: false, msg: "" };
}

function firstSendPanelHtml() {
  const steps = firstSendSteps();
  const doneN = steps.filter((s) => s.done).length;
  if (doneN === steps.length) return "";

  const current = steps.find((s) => !s.done);
  return `
    <div class="firstsend-panel">
      <div class="firstsend-head">
        <span class="firstsend-title">发出第一封信</span>
        <span class="firstsend-count">${doneN} / ${steps.length}</span>
        <span class="firstsend-sub">正常情况下十分钟能走完。卡在哪一步，这里会直接告诉你该点什么。</span>
      </div>
      <ol class="firstsend-list">
        ${steps
          .map(
            (s, i) => `
          <li class="firstsend-item${s.done ? " is-done" : s === current ? " is-current" : ""}">
            <span class="firstsend-num">${s.done ? "✓" : i + 1}</span>
            <div class="firstsend-body">
              <strong>${escapeHtml(s.title)}</strong>
              ${
                s.done
                  ? ""
                  : `<p class="firstsend-need">${escapeHtml(s.need)}</p>
                     <p class="firstsend-how">${escapeHtml(s.how)}</p>
                     ${firstSendInlineHtml(s)}`
              }
            </div>
          </li>`
          )
          .join("")}
      </ol>
    </div>`;
}

function mountFirstSendPanel() {
  const view = document.getElementById("dashboardView") || document.getElementById("consoleView");
  if (!view) return;
  const html = firstSendPanelHtml();
  let box = document.getElementById("mkdFirstSend");
  if (!html) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "mkdFirstSend";
    view.insertBefore(box, view.firstChild);
  }
  box.innerHTML = html;
}

/* ==================== 跟进分支展示 ==================== */

function followupBadgeHtml(prospectId) {
  const b = followupBranch(prospectId);
  const tone =
    b.action === "stop" ? "stop" : b.action === "escalate" ? "hot" : b.action === "pause" ? "cold" : "neutral";
  return `<span class="followup-badge is-${tone}" title="${escapeHtml(b.advice)}">${escapeHtml(b.title)}${
    b.ctx.tracking && b.ctx.opens ? ` · 打开 ${b.ctx.opens} 次` : ""
  }</span>`;
}

/* ==================== 事件与挂载 ==================== */

document.addEventListener(
  "click",
  (e) => {
    const go = e.target instanceof Element ? e.target.closest("[data-mkd-goto]") : null;
    if (!go) return;
    e.preventDefault();
    e.stopPropagation();
    navigateTo(go.getAttribute("data-mkd-goto"));
    // 设置页有十几段，带锚点的直接落到那一段，别让人自己翻
    const anchor = go.getAttribute("data-mkd-anchor");
    if (anchor) {
      setTimeout(() => document.getElementById(`anchor-${anchor}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  },
  true
);

// 五步清单里的就地执行
document.addEventListener(
  "click",
  (e) => {
    const btn = e.target instanceof Element ? e.target.closest("[data-mkd-step-run]") : null;
    if (!btn || btn.dataset.busy === "1") return;
    e.preventDefault();
    e.stopPropagation();
    const field = btn.getAttribute("data-mkd-step-run");
    const panel = btn.closest(".firstsend-item") || document;
    const input = panel.querySelector(`[data-mkd-step-input="${field}"]`);
    const value = input ? input.value : "";
    const label = btn.textContent;

    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.textContent = "处理中…";
    let ok = false;
    Promise.resolve(runFirstSendStep(field, value))
      .then((res) => {
        ok = !!res?.ok;
        if (res?.msg) {
          addLog(res.msg);
          if (res.ok) runDone(res.msg);
          else runAbort(res.msg, null, "上手五步");
        }
      })
      .catch((error) => {
        addLog(`这一步没跑成：${error.message}`);
        runFail(error.message);
      })
      .finally(() => {
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.textContent = label;
        render(); // 重渲染面板：做完的那步会自动打勾并收起
        // 没跑成就把用户填的东西放回去。textarea 重渲染后一律是空的，
        // 而这里装的往往是整页 Google 搜索结果——丢了就得回去重新复制一遍。
        if (!ok && value) {
          const back = document.querySelector(`[data-mkd-step-input="${field}"]`);
          if (back && !back.value) back.value = value;
        }
        renderLogs();
      });
  },
  true
);

const __netBaseRender2 = render;
render = function () {
  __netBaseRender2();
  try {
    mountFirstSendPanel();
  } catch (error) {
    console.error("[netprobe] 首封向导挂载失败", error);
  }
};

/* ==================== ⑧ 定位闭环校准 ==================== */

// 我们的产品定位（HS + 同义词 + 买家段 + 排除词）已经比竞品细一档，但它是
// 单向的：AI 产出定位 → 拿去搜 → 完事。没有人告诉定位"你搜回来的东西对不对"。
//
// 这里补上回路：从最近入池的公司里抽几家，让用户点「对口 / 不对口」。
// 不对口的，把它的行业特征词喂回 excludeTerms，下次搜索式自动避开。
//
// 注意这不是"AI 学习"——就是把用户的明确判断记下来并用上。不猜用户想什么。

function calibrationSample(n = 5) {
  const pool = (state.prospects || []).filter((p) => !p.calibrated && !p.offTarget && p.company);
  return pool.slice(-n).reverse();
}

// 最容易踩的坑：把用户**自己的产品词**加进排除词。用户卖无人机配件，
// 标了一家无人机工厂为不对口，如果 "drone" 进了排除词，下次搜索式会把所有
// 无人机相关公司全排掉——等于亲手废掉他的搜索。先把用户自己的产品词、
// 同义词、买家段词全部保护起来，一个都不许进排除词。
function protectedTerms() {
  const camp = state.campaign || {};
  const profile = camp.productProfile || {};
  const bag = [
    camp.product,
    camp.productDescription,
    profile.englishTerm,
    ...(camp.productTerms || []),
    ...(profile.synonyms || []),
    ...(profile.keywords || []),
    ...(profile.buyerTypes || []),
    ...(profile.fitSignals || [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return new Set([...bag.matchAll(/\b[a-z]{3,18}\b/g)].map((m) => m[0]));
}

// 从一家不对口的公司身上提取"以后要避开什么"
function offTargetSignals(prospect) {
  const words = new Set();
  const src = `${prospect.company || ""} ${prospect.profile || ""} ${(prospect.siteFacts || [])
    .map((f) => f.text)
    .join(" ")}`;
  const keep = protectedTerms();
  // 只取英文实词，长度 4-18，去掉太通用的
  const STOP = /^(the|and|for|with|from|that|this|your|our|we|are|is|company|limited|ltd|inc|llc|trading|group|international|global|services|solutions|industry|industrial|about|home|contact|products|welcome)$/i;
  for (const m of src.matchAll(/\b[a-z]{4,18}\b/gi)) {
    const w = m[0].toLowerCase();
    if (STOP.test(w)) continue;
    if (keep.has(w)) continue; // 用户自己的产品词，一个都不许进排除词
    words.add(w);
    if (words.size >= 6) break;
  }
  return [...words];
}

function calibrateProspect(prospectId, fit) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect) return;
  prospect.calibrated = fit ? "fit" : "off";

  if (!fit) {
    prospect.offTarget = true;
    prospect.fitNote = "你手动标记为不对口";
    const profile = (state.campaign.productProfile = state.campaign.productProfile || {});
    const ex = new Set(profile.excludeTerms || []);
    const before = ex.size;
    offTargetSignals(prospect).forEach((w) => ex.add(w));
    profile.excludeTerms = [...ex];
    const added = ex.size - before;
    addLog(
      `已把「${prospect.company}」标为不对口${
        added ? `，并从它身上提取了 ${added} 个特征词加进排除词——下次生成搜索式会自动避开这类公司` : ""
      }`
    );
  } else {
    addLog(`已确认「${prospect.company}」对口。这类公司的特征会保留在定位里。`);
  }
  saveState();
  render();
}

function calibrationPanelHtml() {
  const sample = calibrationSample(5);
  if (sample.length < 3) return ""; // 太少不值得打扰用户
  const done = (state.prospects || []).filter((p) => p.calibrated).length;

  return `
    <div class="calib-panel">
      <div class="calib-head">
        <span class="calib-title">这些是你要找的客户吗？</span>
        <span class="calib-sub">
          搜回来的东西对不对，只有你知道。标几个「不对口」，它们的特征词会自动进排除词，
          下次搜索式就会避开这一类——定位越用越准。${done ? `已校准 ${done} 家。` : ""}
        </span>
      </div>
      <ul class="calib-list">
        ${sample
          .map(
            (p) => `
          <li class="calib-item">
            <div class="calib-info">
              <strong>${escapeHtml(p.company)}</strong>
              ${p.website ? `<span class="calib-site">${escapeHtml(p.website)}</span>` : ""}
              ${p.profile ? `<p>${escapeHtml(String(p.profile).slice(0, 90))}</p>` : ""}
            </div>
            <div class="calib-actions">
              <button type="button" class="btn-ghost calib-yes" data-mkd-calib-fit="${escapeHtml(p.id)}">对口</button>
              <button type="button" class="btn-ghost calib-no" data-mkd-calib-off="${escapeHtml(p.id)}">不对口</button>
            </div>
          </li>`
          )
          .join("")}
      </ul>
    </div>`;
}

function mountCalibrationPanel() {
  const view = document.getElementById("prospectsView");
  if (!view) return;
  const html = calibrationPanelHtml();
  let box = document.getElementById("mkdCalib");
  if (!html) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "mkdCalib";
    view.insertBefore(box, view.firstChild);
  }
  box.innerHTML = html;
}

/* ==================== ⑥ 追踪端点设置 ==================== */

// 把追踪端点做成设置项，并且**明确写清楚不配就是没有打开数据**——
// 竞品在这里会给你一个"预估打开率"，那是编的。
function mountTrackingSetting() {
  const view = document.getElementById("settingsView");
  if (!view || document.getElementById("mkdTrackingCard")) return;
  const card = document.createElement("section");
  card.id = "mkdTrackingCard";
  card.className = "card mkd-tracking-card";
  card.innerHTML = `
    <h3>邮件打开追踪（可选）</h3>
    <p class="tracking-why">
      填一个你自己的追踪端点，我们会在邮件里插入指向<strong>你自己域名</strong>的 1×1 像素。
      别家软件的像素挂在他们的服务器上——等于把你所有客户的打开时间和 IP 交给服务商。
      这里的追踪数据同样不经过我们。
    </p>
    <label>
      <span>追踪端点 URL</span>
      <input id="mkdTrackingBase" type="url" placeholder="https://你的域名/t.gif" />
    </label>
    <p class="tracking-note">
      不填就是<strong>没有打开数据</strong>。我们不会给你一个「预估打开率」——那是编的。
      没有数据时，跟进按固定节奏走，界面上会明确标注「测不到，不是没打开」。
    </p>`;
  view.appendChild(card);
  const input = card.querySelector("#mkdTrackingBase");
  input.value = state.settings?.trackingBase || "";
  input.addEventListener("change", () => {
    state.settings.trackingBase = input.value.trim();
    saveState();
    addLog(input.value.trim() ? `邮件打开追踪已启用，像素指向 ${input.value.trim()}` : "已关闭邮件打开追踪");
    render();
  });
}

/* ==================== 事件与挂载 ==================== */

document.addEventListener(
  "click",
  (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const fit = t.closest("[data-mkd-calib-fit]");
    if (fit) {
      e.preventDefault();
      e.stopPropagation();
      calibrateProspect(fit.getAttribute("data-mkd-calib-fit"), true);
      return;
    }
    const off = t.closest("[data-mkd-calib-off]");
    if (off) {
      e.preventDefault();
      e.stopPropagation();
      calibrateProspect(off.getAttribute("data-mkd-calib-off"), false);
    }
  },
  true
);

const __netBaseRender3 = render;
render = function () {
  __netBaseRender3();
  try {
    mountCalibrationPanel();
    mountTrackingSetting();
  } catch (error) {
    console.error("[netprobe] 校准/追踪挂载失败", error);
  }
};

/* ==================== 把上面几件事真正接进流程 ==================== */

// 追踪像素注入。没接这一步的话，"打开追踪"就只是个设置项而已——
// 像素 URL 生成了却从没进过邮件，等于假功能。
function withTrackingPixel(item) {
  const url = trackingPixelFor(item.id);
  if (!url) return item.body;
  // 纯文本正文也能挂：nodemailer 会把 body 当 text，这里追加一行 HTML 注释式像素，
  // 由主进程按 html 发送时生效；不支持 HTML 的场景下这行不显示也不影响阅读。
  return `${item.body}\n\n<img src="${url}" width="1" height="1" alt="" style="display:none" />`;
}

if (typeof deliverEmailBatch === "function") {
  const __deliverBase = deliverEmailBatch;
  deliverEmailBatch = async function (items, opts) {
    if (trackingReady()) {
      items.forEach((i) => {
        if (!i.__pixelApplied) {
          i.body = withTrackingPixel(i);
          i.__pixelApplied = true;
        }
      });
    }
    const res = await __deliverBase(items, opts);
    // 发完顺手做一次冷序列自动暂停：一直发给不看信的地址纯粹拖累送达率
    try {
      autoPauseColdSequences();
    } catch (error) {
      console.error("[netprobe] 自动暂停失败", error);
    }
    return res;
  };
}

// 跟进分支徽章挂到潜客表格的行上（09 排在最后，DOM 已经渲染好了）
function mountFollowupBadges() {
  const table = document.getElementById("prospectTable");
  if (!table) return;
  table.querySelectorAll("tr[data-prospect-id]").forEach((tr) => {
    const id = tr.getAttribute("data-prospect-id");
    if (!id || tr.querySelector(".followup-badge")) return;
    const items = (state.outbox || []).filter((o) => o.prospectId === id && o.status === "已发送");
    if (!items.length) return; // 没发过信就没有"跟进状态"可言
    const cell = tr.querySelector("td:nth-child(3)") || tr.querySelector("td");
    if (cell) cell.insertAdjacentHTML("beforeend", ` ${followupBadgeHtml(id)}`);
  });
}

const __netBaseRender4 = render;
render = function () {
  __netBaseRender4();
  try {
    mountFollowupBadges();
  } catch (error) {
    console.error("[netprobe] 跟进徽章挂载失败", error);
  }
};

// 首屏补渲染：07 末尾那次 render() 跑的时候，本文件还没被拼进来，上面四层包装
// 挂的六个面板（陪跑、潜客网络动作、发出第一封信、定位校准、追踪设置、跟进徽章）
// 一个都不会出现，要等用户随手点一下触发重渲染才冒出来。新用户第一眼恰恰最需要
// 「发出第一封信」，所以这里必须自己再渲染一次。
render();
