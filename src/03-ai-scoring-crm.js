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
