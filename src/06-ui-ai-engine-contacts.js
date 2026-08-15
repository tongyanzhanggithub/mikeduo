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
// 日志里报的是「谁在干活」，必须是用户自己选的那家。以前一律写死「Claude」，
// 用户配了 DeepSeek 也照样看到「Claude 正在细化定位」，会以为设置没生效。
// label 太长（"通义千问 Qwen（阿里）"），截到第一个空格或括号之前当简称。
// 注意：只有走 callAI 的通用能力才该用它；联网找客户走 callClaudeWebSearch，
// 那是 Anthropic 独有的服务端工具，那些提示里的「Claude」是事实，不要替换。
function aiShortName() {
  const label = aiProviderConf().label || "AI";
  return label.split(/[\s（(]/)[0] || label;
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
    addLog(`${aiShortName()} 分析完成（${result.intent_label} · 置信度 ${result.confidence}%${riskNote}）：${message.company}`);
    saveState();
    render();
  } catch (error) {
    addLog(`${aiShortName()} 分析失败，已用本地规则兜底：${error.message}`);
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

/* 竞品渠道反查：从竞品 Where-to-buy / 经销商列表页抽出他家所有经销商作为线索。

   这是全站信号最硬的免费通道——挂在竞品经销商页上的公司，是被这个品牌
   认证过的、正在分销这个品类的渠道商，强度仅次于海关提单，而且每个市场
   都能用、一分钱数据费都不花。

   以前它写死了只能走 Claude 的服务端联网工具，于是用 DeepSeek 等其他模型的
   用户根本用不了这条路。但这里要的只是"读一个已知网址"，不是"上网搜索"：
   桌面版自己就能把页面抓回来，模型只需要读。现在默认走这条，任何模型都行。 */
async function reverseCompetitorChannel(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    addLog("请先粘贴一个完整的竞品经销商/Where-to-buy 页面链接（http/https 开头）");
    return 0;
  }
  if (!aiEnabled()) {
    showAiSetup("竞品渠道反查需要先配置 AI 引擎：填入 API Key 后点「测试连接」");
    return 0;
  }
  const markets = normalizeMarkets(state.campaign.markets);

  const page = await fetchPageForAI(target);
  if (page.ok) {
    addLog(`${aiShortName()} 正在从页面里抽经销商：${target}…`);
    renderLogs();
    const system = [
      "你是外贸找客助手。我已经把一个经销商定位/Where-to-buy/dealer locator/授权分销商页面抓下来了，",
      "下面给你它的正文和页面上所有指向站外的链接。任务：抽出这个页面列出的所有经销商/分销商/零售商公司。",
      "只输出一个 JSON 数组，不要额外文字，每个元素含 {company, website, market, note}：",
      "  website 只要主域名（页面链接里给了就用，没给就留空，不要编）",
      "  note 为一句中文，例如「X 品牌授权经销商」",
      "硬规则：",
      "① 只写页面上真实出现的公司。一家都没有就返回空数组 []，不要拿这个品牌的名气去编几家出来。",
      "② 排除品牌方自己、平台站、社媒、目录站，以及建站商/物流商这类页脚里的无关链接。",
      "③ 站外链接列表里那些明显是导航或赞助的（隐私政策、cookie 服务商等）不要当经销商。"
    ].join("\n");
    const user = [
      `我方产品: ${state.campaign.product}`,
      `目标市场: ${markets.join(", ") || "不限"}`,
      `页面地址: ${page.url}`,
      "",
      "【页面上的站外链接】",
      page.links.length ? page.links.map((l) => `${l.host}${l.label ? ` —— ${l.label}` : ""}`).join("\n") : "（没有站外链接）",
      "",
      "【页面正文】",
      page.text || "（正文为空）"
    ].join("\n");
    try {
      const n = ingestFoundText(await callAI(system, user, null, 8000), markets[0] || "United States", "竞品渠道反查");
      if (n === 0) {
        addLog("这个页面没抽到新经销商——常见原因是经销商藏在地图控件里由 JS 动态加载，抓回来的 HTML 是空壳。换一个纯列表式的页面（多数品牌有「Dealer List」或按国家分页的版本）再试。");
      }
      return n;
    } catch (error) {
      addLog(`竞品渠道反查失败：${error.message}${aiTestFailHint(error)}`);
      return 0;
    }
  }

  // 抓不到页面（浏览器直开、或对方拦爬虫）时，才退回 Claude 的服务端联网工具
  if (aiWebSearchCapable()) {
    addLog(`本地抓不到这个页面（${page.reason}），改用 Claude 联网反查：${target}…`);
    renderLogs();
    const system =
      "你是外贸找客助手，可联网搜索。任务：打开给定的经销商定位/Where-to-buy/dealer locator/authorized distributor/stockist 页面，抽取该页面列出的所有经销商/分销商/零售商公司。只输出一个 JSON 数组，不要额外文字，每个元素含 {company, website, market, note}（note 为一句中文，如“X 品牌授权经销商”）。排除品牌方本身与平台/目录站。找不到页面就用网络搜索该品牌的经销商。";
    const user = `竞品经销商页面: ${target}
我方产品: ${state.campaign.product}
目标市场: ${markets.join(", ") || "不限"}`;
    try {
      const n = ingestFoundText(await callClaudeWebSearch(system, user, 8000), markets[0] || "United States", "竞品渠道反查");
      if (n === 0) addLog("竞品反查未抽到新经销商（可能页面无列表或都已在库）");
      return n;
    } catch (error) {
      addLog(`竞品渠道反查失败：${error.message}`);
      return 0;
    }
  }

  addLog(
    page.noBridge
      ? "浏览器直开受同源策略限制，抓不了外站——这个功能要在桌面版用"
      : `抓不到这个页面（${page.reason}）——对方站可能拦爬虫或要求登录。换一个能直接打开的纯列表式经销商页，或者把页面上的公司名手工粘到「粘贴导入」`
  );
  return 0;
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
    showAiSetup("深度写信需要先配置 AI 引擎：填入 API Key 后点击「测试连接」");
    return;
  }
  addLog(`${aiShortName()} 正在为 ${prospect.company} 深度写信…`);
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
    addLog(`${aiShortName()} 已生成 ${state.sequence.length} 封深度个性化开发信：${prospect.company}`);
    saveState();
    render();
  } catch (error) {
    addLog(`${aiShortName()} 写信失败：${error.message}`);
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
    elements.agentEngineTag.textContent = `${aiShortName()} 解析中…`;
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
      addLog(`${aiShortName()} 解析失败，已用本地规则：${error.message}`);
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
  addLog(`任务解析完成（${source === "claude" ? aiShortName() : "本地规则"}）：请在任务卡片中确认后启动`);
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
