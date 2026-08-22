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
      addLog(`${aiShortName()} 自动应答失败，改用模板：${error.message}`);
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
  const sourceTag = task.source === "claude" ? `${aiShortName()} 解析` : "本地规则解析";

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
    ["任务解析", !!task, task ? (task.source === "claude" ? aiShortName() : "本地规则") : "待下达"],
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
  elements.agentEngineTag.textContent = aiEnabled() ? `${aiShortName()} 解析 · ${state.settings.aiModel}` : "本地规则解析";
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
    const mine = outboxFor(p.id); // 原本每条线索都扫一遍整个队列 → 平方级
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
  // 队列每一行渲染都会调这里，原本 find 扫全线索池；加上 08/09 两层包装各自再查一次，
  // 就是每封信扫三遍全池 → 平方级。prospectById 在渲染期是 O(1)，其余时候行为不变。
  const prospect = prospectById(item.prospectId);
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
  // 同理：原本扫全发信队列，现在只看这条线索名下已发出的那几封
  const dup = sentOutboxFor(item.prospectId).some(
    (o) => o.id !== item.id && (o.step === item.step || o.subject === item.subject)
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
  // 从 state 读而不是数 DOM：列表分页后，没渲染出来的那些也照样算数
  if (!mkdSelectedOutbox.size) {
    addLog("请先勾选要审批发送的邮件（可点「全选待审/待发」）");
    return 0;
  }
  const items = activeOutboxItems().filter((o) => mkdSelectedOutbox.has(o.id));
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
  // 全选：按**全部待审/待发**算，不是数当前页渲染出来的复选框。
  // 列表分页后这两者不再等价，数 DOM 会让"全选"悄悄缩水成"全选本页"。
  if (event.target.id === "outboxSelectAll") {
    const on = event.target.checked;
    mkdActionableOutboxIds.forEach((id) => (on ? mkdSelectedOutbox.add(id) : mkdSelectedOutbox.delete(id)));
    elements.outboxList.querySelectorAll("input[data-outbox-id]").forEach((box) => (box.checked = on));
    syncOutboxSelectionUi();
    return;
  }
  const box = event.target.closest("input[data-outbox-id]");
  if (box) {
    if (box.checked) mkdSelectedOutbox.add(box.dataset.outboxId);
    else mkdSelectedOutbox.delete(box.dataset.outboxId);
    syncOutboxSelectionUi();
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

// 总览的时间窗单独存一份，不跟分析页共用：在管理页看「近 30 天全部活动」
// 不该顺手把分析页也切成近 30 天。
elements.overviewRange?.addEventListener("click", (event) => {
  const segment = event.target.closest("[data-overview-range]");
  if (!segment) return;
  state.ui = { ...(state.ui || {}), overviewRange: segment.dataset.overviewRange };
  elements.overviewRange.querySelectorAll("[data-overview-range]").forEach((s) => {
    s.classList.toggle("is-active", s === segment);
  });
  saveState();
  renderCampaignOverview();
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
    addLog(`${aiShortName()} 分析中…`);
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
