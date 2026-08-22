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
      </ul>
      <p class="mkd-hint"><strong>这几样试用期不限次数</strong>，随便用：
         官网抓联系方式 · 邮箱真伪验证 · 发信域名体检 · 合规筛查 · HS 编码校验 · 采购官库检索。
         它们都在本机跑、不花接口费，我们没有理由限制你先把价值看清楚。</p>`,
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
  // site-read 与 claude-web 同档：都是从真实网页文字里读出来的，且每个邮箱都留了出处
  const key = source === "webhook" || isWebReadSource(source) ? "real" : source === "claude" ? "ai" : "rule";
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

/* 换活动、恢复备份、重置演示数据——这几件事会把线索池整批换掉。
   分页计数器和勾选是模块级状态，不跟着 state 走，所以要显式归零：
   否则会带着上一批的"已展开 800 行"和一堆对不上号的勾选进入新数据。
   （勾选虽然每次渲染都会剔除失效项，但显式清掉更符合用户预期。） */
function resetListPaging() {
  mkdProspectShown = PROSPECT_PAGE_SIZE;
  mkdProspectFilterSig = null;
  mkdFilteredProspectIds = [];
  mkdOutboxShown = OUTBOX_PAGE_SIZE;
  mkdOutboxFilterSig = null;
  mkdActionableOutboxIds = [];
  mkdConversationShown = CONVERSATION_PAGE_SIZE;
  mkdConversationFilterSig = null;
  mkdSelectedProspects.clear();
  mkdSelectedOutbox.clear();
}

function isProspectSelected(id) {
  return mkdSelectedProspects.has(id);
}

// 「全选当前筛选结果」的口径是**全部筛选结果**，不是当前渲染出来的那一页。
// 潜客表分页后如果继续数 DOM 里的复选框，全选会悄悄缩水成"全选本页"，
// 而用户看到的文案没变——这种静默的语义漂移比慢更糟。
function visibleProspectIds() {
  return [...mkdFilteredProspectIds];
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
  if (prospect?.offTarget) {
    // 域名压根解析不到是「事实」，不是 AI 的判断。两者混着说会让用户
    // 以为可以推翻它——而假域名是推翻不了的，往那儿发信只会退信。
    const label = prospect.offTargetReason === "dead" ? "官网不存在" : "AI 判定不对口";
    return `<span class="mkd-verify-badge is-offtarget">${label}</span>`;
  }
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
    const dead = prospect.offTargetReason === "dead";
    return `<div class="offtarget-callout">
        <strong>⛔ ${
          dead
            ? "这家公司的官网不存在"
            : `AI 判定这家不对口${typeof prospect.fitScore === "number" ? `（匹配度 ${prospect.fitScore}%）` : ""}`
        }</strong>
        <p>${escapeHtml(prospect.fitNote || "不是采购/进口/分销我方产品的角色")}</p>
        <p class="mkd-hint">${
          dead
            ? "域名解析不到，说明这个网址是搜索结果或 AI 给出的假地址。往这种域名发信必退，退信多了会连累你自己的发信域名。批量入队和自动驾驶都会跳过它。"
            : '所以没有为它推测联系人和邮箱——在"完全不对口"旁边摆一个编出来的人名，只会害你发错人。批量入队和自动驾驶都会跳过它。'
        }</p>
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
  // 走索引而不是 find 扫全池：这一层和底层、以及 09 里那一层，各自都要查同一条线索，
  // 三次全表扫描 × 队列每一行 = 平方级。prospectById 在渲染期是 O(1)，其余时候行为不变。
  const prospect = prospectById(item.prospectId);
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
  // 单独 try：renderCommerceChrome 一旦抛错，会顺着调用链把后续所有
  // 挂载层一起带走（它们的 try 只包着自己的 mount 调用，包不住这里）。
  // 而那种失败是静默的——界面只是少了几块，不报任何错。
  try {
    renderCommerceChrome();
  } catch (error) {
    console.error("[mkd] 商业化外壳渲染失败", error);
  }
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
        // 理由也要一起清掉，否则徽章会继续按 dead 显示「官网不存在」——
        // 用户明明已经手动推翻了这条判断。
        p.offTargetReason = "";
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
