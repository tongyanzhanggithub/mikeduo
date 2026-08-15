window.__APP_V = "38";

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
  campaignOverview: $("#campaignOverview"),
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
  overviewRange: $("#overviewRange"),
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
      overviewRange: "all",
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
