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
    elements.focusHint.textContent = `已按原文聚焦「${c.focusProduct}」——配好 AI 引擎后点「AI 细化定位」可自动翻译成行业术语并扩展同义词`;
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
    addLog(`已按原文聚焦「${raw}」（还没配 AI 引擎，无法翻译/扩展同义词；去「设置 → AI 引擎」配一个）`);
    saveState();
    render();
    return;
  }
  addLog(`${aiShortName()} 正在细化定位「${raw}」…`);
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
    // 下拉里没有匹配项时 .value 是空串，直接存下去会让 aiProviderId() 兜底成
    // anthropic——用户明明选了 DeepSeek，却被悄悄换回 Claude。空值一律保留原设置。
    // （aiModel 早先踩过同样的坑，readAiModelFromForm() 就是这么兜的。）
    aiProvider: (elements.aiProviderSelect?.value || "").trim() || state.settings.aiProvider || "anthropic",
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
  if (typeof renderStorageAlert === "function") renderStorageAlert();
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

/* 同一时刻只允许一个批量任务。

   runTracker 是单个全局变量，第二个任务 runBegin 会把它覆盖掉，
   于是第一个任务下一轮 `runIsActive()` 就变成 false、静默截断——
   实测：筛查跑到第 2 家时点了「抓官网」，筛查就停了，但仍然报"查了 10 家"。 */
function runBusy(what) {
  if (!runIsActive()) return false;
  if (typeof addLog === "function") {
    addLog(`「${runTracker.name}」还在跑（${runTracker.step || "进行中"}），先等它跑完再${what}——两个任务一起跑会互相打断`);
  }
  return true;
}

// 批量任务被中途打断时的统一说法。done 是**真正跑完的条数**，不是目标条数。
function runInterruptedNote(label, done, total) {
  const missed = total - done;
  return (
    `${label}中途停了：${total} 条里只跑完 ${done} 条，剩下 ${missed} 条**没有执行**。` +
    `已跑完的部分保留，重新点一次会接着处理没跑的。`
  );
}

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

/* 状态条上那个 × 一直同时是"隐藏提示"和"中止任务"两件事，而它只长得像前者。

   三个批量循环都靠 `if (!runIsActive()) break` 判断是否继续，而 runDismiss
   会把状态置为 idle——于是用户以为自己只是关掉一条提示，实际把跑了一半的
   批量任务掐断了，而汇总还照常报"查了 N 家"（N 是目标数，不是实际完成数）。
   合规筛查里这意味着：用户被告知 10 家都查过了，实际只查了 3 家。

   现在拆成两个：跑着的时候点 × 是**明确的中止**（会记一条日志、汇总里也会说明），
   没跑的时候才是单纯隐藏。按钮的 title 跟着状态变，别让人猜。 */
function runCancel() {
  if (runTracker.status !== "running") return runDismiss();
  runEnd("aborted", "已中止（点了状态条上的 ×）");
  if (typeof addLog === "function") addLog(`已中止「${runTracker.name}」——已完成的部分保留，没跑到的没有执行`);
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
  // 跑着的时候这个 × 是"中止"，不是"隐藏"——写在 title 上，别让人点了才知道
  if (elements.runStatusClose) {
    const running = runTracker.status === "running";
    elements.runStatusClose.title = running ? "中止这个任务" : "关闭";
    elements.runStatusClose.setAttribute("aria-label", running ? "中止这个任务" : "关闭状态条");
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

/* 潜客表分页。

   一次性把整池塞进 DOM 会卡在**排版**上，不是 JS 上：实测 2000 条线索
   渲染出 3.4 万个 DOM 节点、2.2MB HTML，其中拼字符串 164ms、写 innerHTML 51ms，
   而浏览器强制排版要 540ms。这部分优化 JS 没有用，只能不生成这么多节点。

   只渲染前 PROSPECT_PAGE_SIZE 行，其余按需展开。

   要紧的是**全选的口径不能跟着变**：它一直是"全部筛选结果"，不是"当前这一页"。
   所以完整的筛选结果 id 记在 mkdFilteredProspectIds 上，
   visibleProspectIds() 读它而不是数 DOM 里有几个复选框。 */
const PROSPECT_PAGE_SIZE = 200;
let mkdProspectShown = PROSPECT_PAGE_SIZE;
let mkdProspectFilterSig = null;
let mkdFilteredProspectIds = [];

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

  // 筛选条件一变就回到第一页，否则换个筛选还停在"已展开 800 行"的状态
  const filterSig = [filter, status, gradeWanted, sortBy, sourceWanted, verifyWanted, marketWanted].join("|");
  if (filterSig !== mkdProspectFilterSig) {
    mkdProspectFilterSig = filterSig;
    mkdProspectShown = PROSPECT_PAGE_SIZE;
  }
  // 全选的口径 = 全部筛选结果（不受分页影响）
  mkdFilteredProspectIds = rows.map(({ item }) => item.id);

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
      .slice(0, mkdProspectShown)
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
    ${
      rows.length > mkdProspectShown
        ? `<div class="prospect-more">
             <span>已显示 ${mkdProspectShown} / ${rows.length} 条（筛选、排序、全选、批量操作都按全部 ${rows.length} 条算）</span>
             <button class="ghost-button" data-prospect-more="1" type="button">再显示 ${Math.min(PROSPECT_PAGE_SIZE, rows.length - mkdProspectShown)} 条</button>
             ${rows.length - mkdProspectShown > PROSPECT_PAGE_SIZE ? `<button class="text-button" data-prospect-more="all" type="button">全部展开（会变慢）</button>` : ""}
           </div>`
        : ""
    }
  `;
  renderProspectBulkBar();
}

/* 展开更多行。

   「全部展开」= 展开到**当前这批结果**，不是无穷大。原先设成 MAX_SAFE_INTEGER，
   于是点一次之后这个状态就永久黏住了：后面再导入 5000 条会一次性全渲染
   （实测 2150ms、8.5 万个 DOM 节点），分页保护被一次点击悄悄废掉，
   用户既看不出来也没法撤销。展开到当前数量之后，新进来的线索会重新
   出现「显示更多」，不会失控。

   抽成具名函数是为了能被 bench-scale.mjs 直接调用验证这条不变量——
   埋在 click 回调里就只能靠人工点。 */
function expandProspectList(mode) {
  mkdProspectShown =
    mode === "all" ? Math.max(PROSPECT_PAGE_SIZE, mkdFilteredProspectIds.length) : mkdProspectShown + PROSPECT_PAGE_SIZE;
  renderProspects();
}

document.addEventListener("click", (event) => {
  const more = event.target.closest("[data-prospect-more]");
  if (!more) return;
  event.stopPropagation();
  expandProspectList(more.dataset.prospectMore);
});


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

/* 发信队列的勾选状态。

   原先只存在 DOM 的复选框上，有两个后果：

   一是**每次 render() 都会静默清空勾选**——重建 innerHTML 时复选框是全新的、
   没有 checked。用户勾好十几封，后台自动驾驶跑一轮触发重渲，勾选就没了，
   而界面上没有任何提示，人会以为还勾着。

   二是列表没法分页——一分页，「全选待审/待发 (N)」就只选当前这一页，
   而那个 N 还是全量的数字。

   搬进 state 后两个问题一起解决：勾选跨重渲存活，全选按 mkdActionableOutboxIds
   （全部待审/待发）算，而不是数 DOM 里有几个框。 */
const mkdSelectedOutbox = new Set();
let mkdActionableOutboxIds = [];

const OUTBOX_PAGE_SIZE = 200;
let mkdOutboxShown = OUTBOX_PAGE_SIZE;
let mkdOutboxFilterSig = null;

// 勾选变化后就地更新受影响的那两处，不整轮重渲——重渲会把列表滚动位置带回顶部
function syncOutboxSelectionUi() {
  const total = mkdActionableOutboxIds.length;
  const n = mkdSelectedOutbox.size;
  const all = document.getElementById("outboxSelectAll");
  if (all) {
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total; // 选了一部分，别显示成"全选了"
  }
  const btn = document.getElementById("batchApproveSend");
  if (btn) {
    const span = btn.querySelector("span");
    if (span) span.textContent = n ? `批准并发送（已选 ${n}）` : "批准并发送（先勾选）";
    btn.disabled = n === 0;
  }
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
    // 队列空了（换活动/全发完）也要把勾选清干净，否则留着上一批的 id，
    // 「已选 N」会显示一个界面上根本没有的数字
    mkdActionableOutboxIds = [];
    mkdSelectedOutbox.clear();
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
  // 全选的口径 = 全部待审/待发，不受分页影响
  mkdActionableOutboxIds = actionable.map((i) => i.id);
  // 已经不在待审/待发里的（发出去了、被删了）要从勾选里剔掉，否则计数会虚高
  const actionableSet = new Set(mkdActionableOutboxIds);
  [...mkdSelectedOutbox].forEach((id) => {
    if (!actionableSet.has(id)) mkdSelectedOutbox.delete(id);
  });
  const selectedN = mkdSelectedOutbox.size;

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
        <label class="outbox-check-all"><input type="checkbox" id="outboxSelectAll" ${selectedN && selectedN === actionable.length ? "checked" : ""} /><span>全选待审/待发 (${actionable.length})</span></label>
        <div class="pf-segments">
          ${seg("ok", "✓", "无提示", tally.ok, "is-ok")}
          ${seg("warn", "⚠", "有提示", tally.warn, "is-warn")}
          ${seg("block", "⛔", "被拦住", tally.block, "is-block")}
          ${filter !== "all" ? `<button class="pf-seg is-clear" data-outbox-filter="all" type="button">显示全部</button>` : ""}
        </div>
        ${
          blockedOnly
            ? `<button class="primary-button" data-empty-action="verify-blocked" type="button"><svg><use href="#icon-check" /></svg><span>批量验证邮箱（${tally.block}）</span></button>`
            : `<button class="primary-button" id="batchApproveSend" type="button" ${selectedN ? "" : "disabled"}><svg><use href="#icon-check" /></svg><span>${selectedN ? `批准并发送（已选 ${selectedN}）` : "批准并发送（先勾选）"}</span></button>`
        }
      </div>`
    : "";

  /* 队列分页。

     勾选已经在 state 里、全选按 mkdActionableOutboxIds 算，所以整体分页是安全的：
     没渲染出来的条目照样能被全选、能被批量发送。
     （上一版只能封顶不带复选框的已处理条目，5000 条时队列还要 469ms。） */
  if (filter !== mkdOutboxFilterSig) {
    mkdOutboxFilterSig = filter; // 换档位回到第一页，别停在"已展开 800 条"
    mkdOutboxShown = OUTBOX_PAGE_SIZE;
  }
  const visibleItems = items.slice(0, mkdOutboxShown);
  const hiddenN = items.length - visibleItems.length;

  elements.outboxList.innerHTML =
    strip +
    (items.length
      ? visibleItems
          .map((item) => {
            const selectable = ["待审批", "待发送"].includes(item.status);
            // D3：预检徽章放最左，扫一眼就知道堵点在哪；主题过长在这一行直接提示
            const subjectLen = (item.subject || "").length;
            const expanded = state.ui?.outboxPreviewId === item.id;
            return `
        <article class="outbox-item ${selectable ? "selectable" : ""} ${expanded ? "is-open" : ""}">
          <span class="outbox-pf">${selectable ? preflightBadge(item) : `<span class="pf-badge pf-done">已处理</span>`}</span>
          ${selectable ? `<input type="checkbox" data-outbox-id="${item.id}" ${mkdSelectedOutbox.has(item.id) ? "checked" : ""} aria-label="选择${escapeHtml(item.status)}邮件" />` : `<span class="outbox-spacer"></span>`}
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
          .join("") +
        (hiddenN > 0
          ? `<div class="list-more">
               <span>已显示 ${visibleItems.length} / ${items.length} 封（「全选待审/待发」和批量发送按全部 ${mkdActionableOutboxIds.length} 封算，不受这里影响）</span>
               <button class="ghost-button" data-outbox-more="1" type="button">再显示 ${Math.min(OUTBOX_PAGE_SIZE, hiddenN)} 封</button>
             </div>`
          : "")
      : `<div class="empty-state">这一档里暂时没有邮件</div>`);
  syncOutboxSelectionUi();
}

// 展开更多队列条目
document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-outbox-more]")) return;
  event.stopPropagation();
  mkdOutboxShown += OUTBOX_PAGE_SIZE;
  renderOutbox();
});

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
