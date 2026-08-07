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
      ? `<span class="channel-badge whatsapp">${escapeHtml(aiShortName())} · ${escapeHtml(stored.model || "")}</span>`
      : `<span class="tag">本地规则</span>`;
    const analyzeBtn =
      !stored && aiEnabled()
        ? `<button class="ghost-button" data-inbox-action="ai-analyze" type="button"><svg><use href="#icon-zap" /></svg><span>用 ${escapeHtml(aiShortName())} 分析</span></button>`
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
