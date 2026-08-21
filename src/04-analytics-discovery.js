/* ---------- 数据分析看板 ---------- */

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 100) : 0;
}

function hashInt(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

/* 「这条线索有没有来过信 / 发过邮件 / 发过 WhatsApp」是全场问得最多的三个问题，
   而问的次数跟线索数成正比 —— 每问一次就 some() 扫一遍对应的表，就是平方级。
   实测 isReplied 在一次渲染里被调 3465 次，每次扫一遍全部来信。
   归成 id 集合，渲染期备一份；不在渲染中时 renderMemo 会退回现算，行为不变。 */
function activeInboundIdSet() {
  return renderMemo("activeInboundIdSet", () => new Set(activeInboundItems().map((m) => m.prospectId)));
}

function activeOutboxIdSet() {
  return renderMemo("activeOutboxIdSet", () => new Set(activeOutboxItems().map((o) => o.prospectId)));
}

function activeWhatsappIdSet() {
  return renderMemo("activeWhatsappIdSet", () => new Set(activeWhatsappQueueItems().map((w) => w.prospectId)));
}

// 按线索归拢来信，供 replyChannels 取渠道用
function inboundByProspect() {
  return renderMemo("inboundByProspect", () => {
    const map = new Map();
    for (const m of activeInboundItems()) {
      const list = map.get(m.prospectId);
      if (list) list.push(m);
      else map.set(m.prospectId, [m]);
    }
    return map;
  });
}

function isReplied(prospect) {
  return (
    activeInboundIdSet().has(prospect.id) ||
    prospect.status === "已回复" ||
    stageIndex(prospect.dealStage || "线索") >= stageIndex("已回复")
  );
}

function replyChannels(prospect) {
  const fromInbound = [...new Set((inboundByProspect().get(prospect.id) || []).map((m) => m.channel))];
  if (fromInbound.length) return fromInbound;
  if (!isReplied(prospect)) return [];
  if (activeOutboxIdSet().has(prospect.id)) return ["email"];
  if (activeWhatsappIdSet().has(prospect.id)) return ["whatsapp"];
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

// 同样按渲染期备忘：分析页里这三个会在遍历线索的循环体里被反复调用。
// 时间范围来自界面上的选择器，一次渲染中不会变，所以备忘是安全的。
function axOutbox() {
  return renderMemo("axOutbox", () =>
    activeOutboxItems().filter((o) => inAnalyticsRange(toTime(o.sentAt || o.createdAt || o.dueDate)))
  );
}

function axWa() {
  return renderMemo("axWa", () =>
    activeWhatsappQueueItems().filter((w) => inAnalyticsRange(toTime(w.sentAt || w.createdAt || w.dueDate)))
  );
}

function axInbound() {
  return renderMemo("axInbound", () => activeInboundItems().filter((m) => inAnalyticsRange(toTime(m.at || m.time))));
}

// 分析口径下「被触达过」的线索 id（邮件或 WhatsApp 任一）。
// 分析页洞察和市场表现都要按市场分组统计触达数，原本各自
// list.filter(p => outbox.some(...)) 逐条扫队列 → 平方级。
function axTouchedIdSet() {
  return renderMemo("axTouchedIds", () => {
    const set = new Set();
    for (const o of axOutbox()) set.add(o.prospectId);
    for (const w of axWa()) set.add(w.prospectId);
    return set;
  });
}

function axReplied(prospect) {
  if (!analyticsRangeMs()) return isReplied(prospect);
  // 原本每条线索都 some() 扫一遍 axInbound（而 axInbound 自己又要过一遍全池）→ 平方级
  return renderMemo("axRepliedIds", () => new Set(axInbound().map((m) => m.prospectId))).has(prospect.id);
}

// 漏斗算法只此一份。分析页按当前活动算，管理页的跨活动总览按每个活动各算一遍
// 再汇总——两处必须是同一套口径，否则「总览说这个活动 8 个询盘、点进去分析页
// 说 6 个」这种事迟早发生，而且没人查得出是哪边错。
//
// prospects 传什么范围就算什么范围；rangeMs 为 null 表示不限时间。
function funnelFor(prospects, rangeMs) {
  const now = Date.now();
  const inRange = (ts) => !rangeMs || (ts >= now - rangeMs && ts <= now + 86400000);
  const ids = new Set(prospects.map((p) => p.id));

  const outbox = (state.outbox || []).filter(
    (o) => ids.has(o.prospectId) && inRange(toTime(o.sentAt || o.createdAt || o.dueDate))
  );
  const wa = (state.whatsappQueue || []).filter(
    (w) => ids.has(w.prospectId) && inRange(toTime(w.sentAt || w.createdAt || w.dueDate))
  );
  const inbound = (state.inbound || []).filter((m) => ids.has(m.prospectId) && inRange(toTime(m.at || m.time)));

  // 先把「谁被触达过 / 谁送达了 / 谁打开了 / 谁回过信」归成 id 集合，各扫一遍队列即可。
  // 原本是五个 prospects.filter(p => outbox.some(...))，每条线索都要扫一遍整个队列 →
  // O(线索 × 队列)。分析页、渠道对比、来源效果、转化协助全都调这一份漏斗，
  // 所以这一处平方级会同时拖慢一整片。实测 4000 条时分析页要 576ms。
  const reachedIds = new Set();
  const deliveredIds = new Set();
  const openedIds = new Set();
  const repliedIds = new Set();
  for (const o of outbox) {
    reachedIds.add(o.prospectId);
    if (o.delivered) deliveredIds.add(o.prospectId);
    if (o.opened) openedIds.add(o.prospectId);
  }
  for (const w of wa) {
    reachedIds.add(w.prospectId);
    if (w.delivered) deliveredIds.add(w.prospectId);
    if (w.read) openedIds.add(w.prospectId); // WhatsApp 的"打开"是已读
  }
  for (const m of inbound) repliedIds.add(m.prospectId);

  // 限了时间窗就只认窗口内真的来过信；不限时间才用客户身上的"已回复"标记。
  // 否则选「近 7 天」会把三个月前回过信的客户算进本周回复率。
  const repliedOf = (p) =>
    rangeMs
      ? repliedIds.has(p.id)
      : repliedIds.has(p.id) ||
        p.status === "已回复" ||
        stageIndex(p.dealStage || "线索") >= stageIndex("已回复");

  const reached = prospects.filter((p) => reachedIds.has(p.id));
  const delivered = reached.filter((p) => deliveredIds.has(p.id));
  const opened = reached.filter((p) => openedIds.has(p.id));
  const replied = reached.filter(repliedOf);
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

function computeFunnel() {
  // 分析页、洞察、渠道对比、来源效果…各自都要一份，同一次渲染里是同一个结果
  return renderMemo("computeFunnel", () => funnelFor(activeProspects(), analyticsRangeMs()));
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
  renderSourceEffect();
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
  const touched = axTouchedIdSet();
  const marketStats = markets
    .map((market) => {
      const list = prospects.filter((p) => p.market === market);
      const reached = list.filter((p) => touched.has(p.id)).length;
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

/* ---------- 获客来源效果：哪条搜索式在白跑 ----------

   每条线索身上一直记着它是从哪儿来的（searchQuery / source），但从来没人
   把它和"后来回没回信"对起来。于是用户永远不知道八条搜索式里哪两条在白跑，
   只能凭感觉继续全跑一遍。这一屏就是把这两头接上。

   全部本地计算，不花一分钱接口费——数据早就在那儿了。 */

// 触达数低于这个不给回复率：冷开发信的回复率本来就是个位数，
// 发了 5 封没人回是完全正常的噪音，报一个「0%」只会误导用户砍掉好渠道。
const EFFECT_MIN_SAMPLE = 10;
// 到这个量还挂零，才值得说一句"这条该换了"
const EFFECT_DEAD_SAMPLE = 20;

function sourceEffectRows(prospects, rangeMs) {
  /* searchQuery 这个字段在不同来源下含义并不一样：
       SerpAPI / 搜索式导入 —— 存的是真正的搜索表达式，多条线索共用一条
       Claude 联网 / 粘贴导入 —— 存的是"这条线索为什么疑似客户"，每条都不同
     后者按原样分组会退化成"一行一条线索"，没有任何统计意义。
     所以只有被两条以上线索共用的字符串才当搜索式单独成行，其余按来源渠道归并。 */
  const shared = new Map();
  prospects.forEach((p) => {
    const q = (p.searchQuery || "").trim();
    if (q) shared.set(q, (shared.get(q) || 0) + 1);
  });

  const groups = new Map();
  prospects.forEach((p) => {
    const q = (p.searchQuery || "").trim();
    const isQuery = !!q && shared.get(q) >= 2;
    const label = isQuery ? q : p.source || "未标来源";
    const key = `${isQuery ? "q" : "c"}:${label}`;
    if (!groups.has(key)) groups.set(key, { kind: isQuery ? "query" : "channel", label, items: [] });
    groups.get(key).items.push(p);
  });

  return [...groups.values()]
    .map((g) => ({ kind: g.kind, label: g.label, f: funnelFor(g.items, rangeMs) }))
    .sort((a, b) => b.f.replied - a.f.replied || b.f.reached - a.f.reached || b.f.total - a.f.total);
}

function renderSourceEffect() {
  const host = elements.sourceEffect;
  if (!host) return;

  const rows = sourceEffectRows(activeProspects(), analyticsRangeMs());
  if (!rows.length) {
    host.innerHTML = `<div class="empty-state">还没有线索——先去「获客」跑一轮搜索或粘贴导入</div>`;
    return;
  }

  const body = rows
    .map((r) => {
      const { reached, replied, total, inquiry } = r.f;
      const enough = reached >= EFFECT_MIN_SAMPLE;
      const dead = reached >= EFFECT_DEAD_SAMPLE && replied === 0;
      // 比率一律包在 span 里：.market-row 的右对齐规则只认 span，
      // 裸 <strong> 会在这一列里左飘，跟上下行对不齐。
      const rate = enough
        ? `<span class="${dead ? "effect-dead" : ""}">${pct(replied, reached)}%</span>`
        : `<span class="effect-thin" title="触达不足 ${EFFECT_MIN_SAMPLE} 条，样本太小，算出来的回复率没有参考价值">样本不足</span>`;
      return `
        <div class="market-row effect-row">
          <span class="effect-label" title="${escapeHtml(r.label)}">
            <span class="tag">${r.kind === "query" ? "搜索式" : "渠道"}</span>
            ${escapeHtml(r.label.length > 64 ? `${r.label.slice(0, 64)}…` : r.label)}
            ${dead ? '<span class="tag tag-dead">白跑</span>' : ""}
          </span>
          <span>${total}</span><span>${reached}</span><span>${replied}</span>${rate}<span>${inquiry}</span>
        </div>`;
    })
    .join("");

  const deadCount = rows.filter((r) => r.f.reached >= EFFECT_DEAD_SAMPLE && r.f.replied === 0).length;
  host.innerHTML = `
    <div class="market-row effect-row header">
      <span>来源 / 搜索式</span><span>线索</span><span>触达</span><span>回复</span><span>回复率</span><span>询盘</span>
    </div>
    ${body}
    <p class="connector-hint">${
      deadCount
        ? `有 <strong>${deadCount}</strong> 条已经触达 ${EFFECT_DEAD_SAMPLE} 家以上、一个回复都没有——这些位置可以腾出来换别的搜索式或渠道。`
        : `触达满 ${EFFECT_MIN_SAMPLE} 家才给回复率：冷开发信的回复率本来就是个位数，样本太小时的「0%」是噪音不是信号。`
    }</p>`;
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

  const touched = axTouchedIdSet();
  const rows = markets
    .map((market) => {
      const list = prospects.filter((p) => p.market === market);
      const reached = list.filter((p) => touched.has(p.id)).length;
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

function overviewRangeMs() {
  const range = state.ui?.overviewRange || "all";
  if (range === "7d") return 7 * 86400000;
  if (range === "30d") return 30 * 86400000;
  return null;
}

// 跨活动总览：分析页按活动分是对的（不同产品市场的回复率混算没意义），
// 但「这三个月所有活动一共出了多少询盘」「哪个活动最值得继续投时间」
// 分析页答不了。放在管理页而不是分析页，就是为了不动分析页的按活动口径。
function renderCampaignOverview() {
  const host = elements.campaignOverview;
  if (!host) return;

  const active = state.ui?.overviewRange || "all";
  // 刷新后段选择器要跟着存下来的值走，否则重开永远高亮"全部"
  elements.overviewRange?.querySelectorAll("[data-overview-range]").forEach((s) => {
    s.classList.toggle("is-active", s.dataset.overviewRange === active);
  });

  const rangeMs = overviewRangeMs();
  const rangeLabel = { "7d": "近 7 天", "30d": "近 30 天" }[active] || "全部时间";
  const campaigns = state.management?.campaigns || [];

  const rows = campaigns
    .map((c) => {
      const leads = (state.prospects || []).filter((p) => (p.campaignId || null) === c.id);
      return { campaign: c, f: funnelFor(leads, rangeMs) };
    })
    // 询盘是北极星，其次看回复；两个都为 0 的活动排最后但仍然显示，
    // 「跑了没出货」本身就是要看见的信息
    .sort((a, b) => b.f.inquiry - a.f.inquiry || b.f.replied - a.f.replied || b.f.total - a.f.total);

  // 汇总不是把各活动的比率平均——那会让只发了 2 封的小活动和发了 200 封的
  // 大活动等权。分子分母各自相加，再算总比率。
  const sum = rows.reduce(
    (acc, r) => {
      Object.keys(acc).forEach((k) => {
        acc[k] += r.f[k];
      });
      return acc;
    },
    { total: 0, contactable: 0, reached: 0, delivered: 0, opened: 0, replied: 0, inquiry: 0 }
  );

  const orphan = (state.prospects || []).filter(
    (p) => p.campaignId && !campaigns.some((c) => c.id === p.campaignId)
  ).length;

  const cell = (v) => `<span>${v}</span>`;
  const body = rows
    .map(({ campaign, f }) => {
      const live = campaign.id === state.activeCampaignId;
      return `
        <div class="management-row overview-row ${live ? "is-selected" : ""}">
          <button class="campaign-open" data-campaign-id="${campaign.id}" type="button" title="切换到该活动">
            <span class="company-name">${escapeHtml(campaign.name)} ${live ? '<span class="tag tag-live">当前</span>' : ""}</span>
            <span class="company-meta">${escapeHtml(campaign.markets || "未填市场")}</span>
          </button>
          ${cell(f.total)}${cell(f.reached)}${cell(f.replied)}
          ${cell(`${pct(f.replied, f.reached)}%`)}
          <span class="overview-star">${f.inquiry}</span>
        </div>`;
    })
    .join("");

  host.innerHTML = `
    <div class="management-row header overview-head">
      <span>活动</span><span>线索</span><span>已触达</span><span>回复</span><span>回复率</span><span>询盘</span>
    </div>
    ${body || `<div class="empty-state">还没有活动</div>`}
    <div class="management-row overview-row is-total">
      <span class="company-name">合计 · ${campaigns.length} 个活动 · ${rangeLabel}</span>
      ${cell(sum.total)}${cell(sum.reached)}${cell(sum.replied)}
      ${cell(`${pct(sum.replied, sum.reached)}%`)}
      <span class="overview-star">${sum.inquiry}</span>
    </div>
    <p class="scope-note">
      口径与分析页完全一致（同一个 funnelFor），区别只是这里把所有活动加在一起。
      合计的回复率是分子分母各自相加后再算的，不是各活动比率的平均——否则只发过
      两封的小活动会和发过两百封的大活动等权。
      ${orphan ? `另有 ${orphan} 条线索属于已删除的活动，不计入本表。` : ""}
    </p>`;
}

function renderManagement() {
  refreshManagementDerivedData();
  renderManagementKpis();
  renderCampaignOverview();
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
        searchQuery: query,
        // 这批公司名和域名都是拼出来的，不存在。打上标记，让入池体检跳过它们——
        // 否则一次演示采集会对着十几个根本不存在的域名发请求，然后把它们全判成死站。
        simulated: true
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
      // 反查这条路上，"现在跟谁买"就是用户自己输进去的那个竞争对手，本来就知道
      currentSuppliers: [titleCaseCompany(r.query)].filter(Boolean),
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
    const g = groups.get(key) || { name: raw, count: 0, hs: new Set(), shippers: new Map(), latest: "", country: "", desc: "" };
    g.count += 1;
    // 同一家公司在提单里常有多种写法，取最短的那个（长的多半带 C/O 货代后缀）
    if (raw.length < g.name.length) g.name = raw;
    if (iHs >= 0 && r[iHs]) g.hs.add(String(r[iHs]).replace(/\D/g, "").slice(0, 6));
    if (iShipper >= 0 && r[iShipper]) {
      /* 供应商名字以前被扔掉了，只留了个数量。可它是这条线索上最值钱的一个事实——
         「我看到你们一直在从 X 进这个品类」是冷开发信里唯一让对方没法当群发处理的开场。
         按归一化 key 归并（同一家在提单里写法五花八门），展示名取最短的那个，
         并记下频次，好分辨主力供应商和偶尔下过一单的。 */
      const skey = companyDedupeKey(r[iShipper]);
      const sname = cleanConsigneeName(r[iShipper]);
      if (skey && sname) {
        const prev = g.shippers.get(skey);
        g.shippers.set(skey, {
          name: prev && prev.name.length <= sname.length ? prev.name : sname,
          count: (prev ? prev.count : 0) + 1
        });
      }
    }
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
      // 供货多的排前面：写信时该点名的是主力供应商，不是偶尔下过一单的那家
      const suppliers = [...g.shippers.values()]
        .sort((a, b) => b.count - a.count)
        .map((x) => titleCaseCompany(x.name))
        .filter(Boolean);
      const signal = [
        `有 ${g.count} 条进口记录`,
        g.latest ? `最近 ${g.latest}` : "",
        hs.length ? `HS ${hs.slice(0, 2).join("/")}` : "",
        suppliers.length
          ? `现供应商 ${suppliers.slice(0, 2).join("、")}${suppliers.length > 2 ? ` 等 ${suppliers.length} 家` : ""}`
          : ""
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
        // 写信要用：对方现在在跟谁买
        currentSuppliers: suppliers.slice(0, 5),
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
  const looksLikeQuery = /-site:|\bOR\b\s*"|["“][^"”]+["”]\s*(OR|AND)\s/i.test(text) || /^-\w+(\s+-\w+){2,}/m.test(text);
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
