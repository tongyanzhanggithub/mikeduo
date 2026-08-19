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
    // wa.me 的号码优先——那是对方挂出来的 WhatsApp 入口，拿到就能直接聊。
    const phone = harvest.whatsappPhone || harvest.phones?.[0] || "";
    if (phone && !next.phone) {
      next.phone = phone;
      // 以前这里只写 phone、不动 phoneStatus，它就一直停在"待查找"。
      // 而「有 WhatsApp」的判定是 `phone && phoneStatus !== "待查找"`，
      // 结果号码明明抓到了、存进去了，界面上却永远显示待查找。
      next.phoneStatus = "待人工确认";
      next.phoneSource = harvest.whatsappPhone ? "官网 WhatsApp 入口" : "官网公示";
      next.phoneSourceUrl = harvest.site || next.contactSourceUrl || "";
    }
    if (harvest.social && Object.keys(harvest.social).length) {
      next.social = { ...(next.social || {}), ...harvest.social };
      if (harvest.social.linkedin && !next.linkedin) next.linkedin = harvest.social.linkedin;
    }
    next.harvestedAt = new Date().toISOString();
    next.harvestPages = (harvest.visited || []).length;
    return next;
  });
  // 只抓到电话/WhatsApp 也算有收获。以前这里只看邮箱，于是号码已经存进去了，
  // 日志却报「没有公示邮箱」，用户以为白跑一趟。
  return candidates.length > 0 || !!(harvest.whatsappPhone || harvest.phones?.length);
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
      // 分开报邮箱和号码：只抓到号码时，以前会被当成"什么都没抓到"
      const parts = [];
      if (p2.email) parts.push(`邮箱 ${p2.email}`);
      if (p2.phone) parts.push(`${res.whatsappPhone ? "WhatsApp" : "电话"} ${p2.phone}`);
      addLog(
        `官网抓到真实联系方式：${prospect.company} → ${parts.join("、")}（抓了 ${pages} 页，出处 ${
          p2.contactSourceUrl || p2.phoneSourceUrl || res.site
        }）。这是企业自己公示的，不是推测。`
      );
    } else {
      addLog(
        `${prospect.company} 官网抓了 ${pages} 页，没有公示邮箱或号码${
          res.blockedByRobots ? `（${res.blockedByRobots} 页被 robots.txt 拒绝）` : ""
        }`
      );
    }
  }
  return got ? "website" : "none";
}

// 批量抓。给进度、可中止、不并发轰炸（主进程那层已限流到 3）
async function batchHarvestSites(ids) {
  // 以前这里是 `!p.email`：只要线索已经有邮箱就整条跳过，于是它的电话和
  // WhatsApp 永远不会被查。而粘贴导入本来就常常带出邮箱——最该补号码的那批，
  // 恰恰一条都没被抓过。改成邮箱或号码缺任意一个就值得跑一趟。
  const targets = (ids || [])
    .map((id) => state.prospects.find((p) => p.id === id))
    .filter((p) => p && p.website && (!p.email || !p.phone));
  if (!targets.length) {
    addLog("没有需要抓的线索（要有官网，且邮箱或 WhatsApp 号至少缺一个）");
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
    hit ? "全部来自企业官网公示，可点开出处核对" : "这批公司官网上既没有公示邮箱，也没有号码"
  );
  addLog(`官网抓取完成：${targets.length} 家里拿到 ${hit} 家真实联系方式（邮箱或 WhatsApp 号，${rate}%），零编造`);
}

/* ================================ 入池体检 ================================

   以前线索进池只过三道筛子：域名不是平台站、不在退订名单、没重复。
   也就是说——市场研究报告站、同行工厂、行业媒体、招投标平台，跟真正的
   进口商是以完全相同的身份进池的。

   而唯一判断「这家到底买不买我的东西」的 fit_score，只在「官网深挖联系人」
   里产生，那是一条线索一次联网调用。最贵的筛子装在了最后一环：等你花钱把
   整池挖了一遍，才知道其中一半根本不是客户。

   入池体检把这道筛子挪到入口，并且改成批量：

     第一步  抓官网（免费、不要 key）。顺手把企业公示的邮箱和 WhatsApp 号
             取回来，同时把它官网上的自述（标题/简介/小标题）留作判断材料。
             域名解析不到的直接判死——搜索摘要和 AI 都会给出根本不存在的站。
     第二步  一次 AI 调用判一批。依据是这家公司自己官网上写的话，而不是
             Google 摘要里那一行。判不对口的走既有的 offTarget 通道，
             自动被批量入队和自动驾驶跳过（见 isQualityQueueable）。

   成本方向是反的：以前每条一次调用，现在每 VET_BATCH_SIZE 条一次。 */

// 一次自动体检最多处理多少条。一次粘贴导入两百家时，不该让用户对着两百次
// 官网抓取干等——超出的留给「批量抓官网」按钮手动补。
const VET_MAX_PER_PASS = 60;
// 一批塞多少家给 AI。太多会被 max_tokens 截断，太少就失去了批量的意义。
const VET_BATCH_SIZE = 20;
// 体检抓几页。比手动深挖的 4 页少：这一步要的是「这家干什么的」，
// 首页加一个 contact 页就够，翻倍的页数换不来多少判断力。
const VET_HARVEST_PAGES = 2;

let vetPending = [];
let vetRunning = false;

function patchProspect(id, patch) {
  state.prospects = state.prospects.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

// 入池闸门的出口。同步返回：admitProspects 的调用方拿到返回值之后才会把线索
// 塞进 state.prospects，所以真正的活儿必须推到下一个事件循环再干，
// 否则这里按 id 一条都找不到。
function queueVet(ids) {
  const fresh = (ids || []).filter(Boolean);
  if (!fresh.length) return;
  const room = Math.max(0, VET_MAX_PER_PASS - vetPending.length);
  if (fresh.length > room) {
    addLog(`本批有 ${fresh.length - room} 条没做入池体检（一次最多自动检 ${VET_MAX_PER_PASS} 条）——想补检就点「批量抓官网」`);
  }
  vetPending.push(...fresh.slice(0, room));
  if (vetRunning || !vetPending.length) return;
  vetRunning = true;
  setTimeout(() => {
    runVetPass().finally(() => {
      vetRunning = false;
    });
  }, 0);
}

// 排空队列。体检期间又有新线索入池（自动驾驶、周期补量）会被这个循环接住。
async function runVetPass() {
  while (vetPending.length) {
    const ids = vetPending.splice(0, vetPending.length);
    // eslint-disable-next-line no-await-in-loop
    await vetLeads(ids);
  }
}

// 第一步：抓一家的官网。返回 { dead, facts }
async function vetHarvestOne(prospect) {
  if (!prospect.website) return { dead: false, facts: [] };
  let res = null;
  try {
    res = await window.mkd.siteHarvest(prospect.website, VET_HARVEST_PAGES);
  } catch {
    return { dead: false, facts: [] }; // 桥断了不算这个域名的错
  }
  const at = new Date().toISOString();

  if (res && res.ok) {
    applyHarvest(prospect.id, res); // 邮箱/WhatsApp 顺手就落了，不额外花钱
    patchProspect(prospect.id, { siteChecked: at, siteNote: "" });
    return { dead: false, facts: (res.facts || []).map((f) => f.text).filter(Boolean).slice(0, 6) };
  }

  // 只有「域名解析不到」才判死。超时、403、拦爬虫、证书问题都只说明这次没抓着；
  // 据此把一家真公司踢出池子，代价比放进来一家假的大得多。
  if (res && res.code === "ENOTFOUND") {
    patchProspect(prospect.id, {
      offTarget: true,
      offTargetReason: "dead",
      fitScore: 0,
      fitNote: `官网 ${prospect.website} 解析不到，这个域名不存在`,
      siteChecked: at,
      status: ["已回复", "已入队"].includes(prospect.status) ? prospect.status : "不对口"
    });
    return { dead: true, facts: [] };
  }

  patchProspect(prospect.id, { siteChecked: at, siteNote: res?.reason || "打不开" });
  return { dead: false, facts: [] };
}

// 第二步：一次 AI 调用判一批。返回判为不对口的条数。
async function vetFitBatch(rows) {
  const system = [
    "你是外贸找客的入池审核员。给你一批候选公司，判断每一家是不是「会采购/进口/分销我方产品」的买家。",
    "判断依据只能是我给你的官网自述（这家公司自己网站上的标题、简介、小标题）和搜索摘要。不要联网，不要凭公司名猜。",
    "只输出一个 JSON 数组，不要额外文字。每个元素 {i, fit, why}：",
    "  i   = 我给的编号（数字）",
    "  fit = 0-100 的对口程度（数字）",
    "  why = 一句中文理由，25 字以内",
    "硬规则：",
    "① 这些一律给 30 以下：B2B 平台与目录站、行业媒体与资讯站、市场研究报告站、招投标公告平台、",
    "   同行制造商（跟我方做同样产品的工厂）、物流货代、展会主办方、政府与协会官网本身、求职招聘站。",
    "② 官网自述里看不出跟这个品类有任何关系的，给 40 以下——别往好里猜。",
    "③ 材料不足以判断的给 50，并在 why 里写明「资料不足」。不确定时不许给高分。"
  ].join("\n");

  const user = [
    `我方产品：${state.campaign.product}`,
    `我要找的客户类型：${state.campaign.customerType}`,
    "",
    "候选公司："
  ]
    .concat(
      rows.map(
        (r, k) =>
          `[${k}] ${r.company}｜官网 ${r.website || "无"}｜市场 ${r.market || "未知"}\n` +
          `     搜索摘要：${(r.signal || "无").slice(0, 150)}\n` +
          `     官网自述：${r.facts.length ? r.facts.join(" / ").slice(0, 400) : "（没抓到）"}`
      )
    )
    .join("\n");

  const arr = extractJsonArray(await callAI(system, user, null, 2000));
  if (!Array.isArray(arr)) return 0;

  let off = 0;
  arr.forEach((item) => {
    const row = rows[Number(item?.i)];
    const fit = Number(item?.fit);
    if (!row || !Number.isFinite(fit)) return;
    const cur = state.prospects.find((p) => p.id === row.id);
    if (!cur) return;
    const why = String(item.why || "").slice(0, 60);
    if (fit < FIT_OFF_TARGET) {
      off += 1;
      patchProspect(row.id, {
        offTarget: true,
        offTargetReason: "fit",
        fitScore: fit,
        fitNote: why || "不是采购/进口/分销我方产品的角色",
        status: ["已回复", "已入队"].includes(cur.status) ? cur.status : "不对口"
      });
    } else {
      patchProspect(row.id, { offTarget: false, offTargetReason: "", fitScore: fit, fitNote: why });
    }
  });
  return off;
}

async function vetLeads(ids) {
  const targets = ids
    .map((id) => state.prospects.find((p) => p.id === id))
    // simulated：演示数据的域名是拼出来的，抓它等于对着不存在的站发请求，
    // 然后把整批演示线索判成死站。selfTest：自测线索不是客户。
    // offTarget：已经判过的不重判（用户手动「确认对口，恢复」过的更不能推翻）。
    .filter((p) => p && !p.simulated && !p.selfTest && !p.offTarget);
  if (!targets.length) return;

  const canHarvest = netReady();
  const canJudge = aiEnabled() && !!(state.campaign?.product || "").trim();
  if (!canHarvest && !canJudge) return; // 两条腿都没有就别报噪音

  addLog(`入池体检：${targets.length} 家新线索排队核对中…`);
  renderLogs();

  const rows = [];
  let dead = 0;
  for (const p of targets) {
    let facts = [];
    if (canHarvest) {
      // eslint-disable-next-line no-await-in-loop
      const got = await vetHarvestOne(p);
      if (got.dead) {
        dead += 1;
        continue; // 域名都不存在，不必再花 AI 的钱判它对不对口
      }
      facts = got.facts;
    }
    const cur = state.prospects.find((x) => x.id === p.id) || p;
    rows.push({
      id: p.id,
      company: cur.company,
      website: cur.website || "",
      market: cur.market || "",
      signal: cur.buyingSignal || "",
      facts
    });
  }

  let off = 0;
  if (canJudge) {
    for (let i = 0; i < rows.length; i += VET_BATCH_SIZE) {
      try {
        // eslint-disable-next-line no-await-in-loop
        off += await vetFitBatch(rows.slice(i, i + VET_BATCH_SIZE));
      } catch (error) {
        addLog(`入池体检的对口判定失败：${error.message}（线索已入池，可稍后用「AI 找联系人」逐条判）`);
        break;
      }
    }
  }

  saveState();
  render();

  const parts = [];
  if (dead) parts.push(`${dead} 家域名不存在`);
  if (off) parts.push(`${off} 家不对口`);
  const kept = targets.length - dead - off;
  addLog(
    parts.length
      ? `入池体检完成：${targets.length} 家里拦下 ${parts.join("、")}，${kept} 家留在池子里。被拦的不进批量入队和自动驾驶，你不同意可在潜客详情里恢复。`
      : `入池体检完成：${targets.length} 家全部通过${canJudge ? "" : "（未配 AI 引擎，只做了官网核对）"}`
  );
}

/* ========================= 把网页读给任意模型听 =========================

   有几个功能本来写死了只能用 Claude，因为它们要"打开一个网页"，而当时唯一
   的办法是 Anthropic 的服务端联网工具。可桌面版自己就有抓取能力
   （webSecurity:false，没有跨域限制）——页面我们自己取回来，正文交给用户
   配的那家模型就行，模型只需要读，不需要会上网。

   这样做还更准：模型拿到的是真实 HTML 里的 href，不是搜索摘要转述的内容。 */

// 正文 + 站外链接。经销商页上那些指向外部的链接本身就是经销商的官网——
// 只把标签剥了当纯文本，等于把最硬的那部分信息直接扔掉。
//
// 用 DOMParser 而不是正则剥标签：真实网页的 HTML 常常不规范（标签没闭合、
// 属性值里带 > 和引号），正则一碰就散。DOMParser 解析出来的是一份「惰性文档」
// ——不执行脚本、不加载图片、不发任何请求，只是把这段字符串按浏览器的容错
// 规则解析成一棵树。顺带 &nbsp; &middot; 这些实体也由它按标准解码，
// 不用自己维护一张实体表。
function pageTextForAI(html, baseUrl) {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }

  let doc;
  try {
    doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  } catch {
    return { text: "", links: [], internalLinks: [] };
  }
  doc.querySelectorAll("script, style, noscript, svg, iframe, template").forEach((n) => n.remove());

  // 站外链接和站内链接各有各的用处：
  //   links         —— 经销商反查要的，外链就是经销商自己的官网域名
  //   internalLinks —— 深挖联系人要的，About / Team / Contact 都在站内
  const links = [];
  const internalLinks = [];
  const seen = new Set();
  const seenPath = new Set();
  doc.querySelectorAll("a[href]").forEach((a) => {
    let u;
    try {
      u = new URL(a.getAttribute("href"), baseUrl);
    } catch {
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    const h = u.hostname.replace(/^www\./, "");
    if (!h) return;
    const label = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);

    if (h === host || h.endsWith(`.${host}`)) {
      if (internalLinks.length >= 60) return;
      u.hash = "";
      if (seenPath.has(u.pathname)) return;
      seenPath.add(u.pathname);
      internalLinks.push({ url: u.toString(), path: u.pathname, label });
      return;
    }
    if (links.length >= 120) return;
    if (NON_COMPANY_DOMAIN.test(h)) return; // 平台站/社媒/建站商不是经销商
    if (seen.has(h)) return;
    seen.add(h);
    links.push({ host: h, label });
  });

  // textContent 不管元素边界，相邻块级元素的文字会直接粘在一起——
  // 「<h3>Nordwind Agrar GmbH</h3><p>Hamburg」会读成「Nordwind Agrar GmbHHamburg」，
  // 模型据此抽出来的公司名就是错的。先给每个块级元素补一个换行再取文本。
  doc.querySelectorAll("br, p, div, li, tr, td, th, section, article, h1, h2, h3, h4, h5, h6, a").forEach((el) => {
    el.after(doc.createTextNode("\n"));
  });

  const text = (doc.body ? doc.body.textContent || "" : "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: text.slice(0, 12000), links, internalLinks };
}

// 抓一个页面并整理成模型能读的样子。桌面版专用（浏览器直开会被同源策略拦）。
async function fetchPageForAI(url) {
  const b = mkdBridge();
  // noBridge 要和"抓了但没抓着"分开：前者是"换桌面版就能用"，后者是对方站的问题，
  // 给的建议完全不同。混成一句会让桌面版用户被告知去用桌面版。
  if (!b || typeof b.fetchPage !== "function") return { ok: false, noBridge: true, reason: "浏览器直开抓不了外站" };
  let res = null;
  try {
    res = await b.fetchPage(url);
  } catch (error) {
    return { ok: false, reason: error.message || "抓取失败" };
  }
  if (!res || !res.ok) return { ok: false, reason: res?.reason || "打不开" };
  return { ok: true, url: res.url || url, ...pageTextForAI(res.html || "", res.url || url) };
}

/* 公司官网上最可能写着采购决策人姓名和职位的页面。
   带上主要外贸市场的本地写法——德语 impressum / 西语 nosotros / 法语 qui-sommes
   这些在欧洲中小企业站上比英文 about 还常见，只认英文会大面积漏掉。 */
const DEEP_PAGE_HINT =
  /about|team|leadership|management|our-story|who-we-are|staff|people|company|contact|impressum|kontakt|ueber-uns|nosotros|empresa|equipo|contacto|qui-sommes|a-propos|chi-siamo|azienda|contatti|sobre|quem-somos/i;

// 把一家公司的官网读成"几页文字"，交给任意模型去找决策人。
// 先抓首页，再从首页的站内链接里挑出 About / Team / Contact 这类页继续抓。
async function sitePagesForAI(website, maxPages = 4) {
  const raw = String(website || "").trim();
  if (!raw) return { ok: false, reason: "没有官网域名" };
  const home = await fetchPageForAI(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!home.ok) return home;

  const pages = [{ url: home.url, text: home.text }];
  const picked = (home.internalLinks || [])
    .filter((l) => DEEP_PAGE_HINT.test(l.path) || DEEP_PAGE_HINT.test(l.label))
    .slice(0, Math.max(0, maxPages - 1));

  for (const l of picked) {
    // eslint-disable-next-line no-await-in-loop
    const p = await fetchPageForAI(l.url);
    if (p.ok && p.text) pages.push({ url: p.url, text: p.text });
  }
  return { ok: true, pages };
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

/* ==================== 开发时：源码已重建但窗口还是旧的 ==================== */

// 真实踩过的坑：改完 src/*.js、跑了 build，但**开着的那个窗口还是旧的**——
// 它在启动那一刻就把 app.js 读进内存了，之后磁盘怎么变都与它无关。
// 于是对着旧界面查一个已经修好的问题，怎么查都查不通。
//
// index.html 里的缓存哨兵抓不到这种情况：页面和脚本是同一时刻一起加载的，
// 二者自洽。哨兵只能发现「页面新脚本旧」，发现不了「两个都旧」。
//
// 只在开发时生效：打包版的 buildStamp() 恒返回 null，装机用户永远看不到。

let staleBannerShown = false;

async function checkBuildFreshness() {
  const b = mkdBridge();
  if (!b || typeof b.buildStamp !== "function" || staleBannerShown) return;
  const onDisk = await b.buildStamp().catch(() => null);
  if (!onDisk || onDisk === window.__APP_V) return;

  staleBannerShown = true;
  const bar = document.createElement("div");
  bar.className = "mkd-stale-build";
  bar.innerHTML = `
    <span>源码已重新构建（磁盘 <code>${escapeHtml(onDisk)}</code> ≠ 窗口 <code>${escapeHtml(
    String(window.__APP_V || "?")
  )}</code>）。你现在看到的还是旧界面。</span>
    <button type="button" data-mkd-reload>刷新生效</button>
    <button type="button" class="ghost" data-mkd-stale-dismiss>知道了</button>`;
  document.body.appendChild(bar);
}

document.addEventListener(
  "click",
  (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-mkd-reload]")) {
      e.preventDefault();
      e.stopPropagation();
      location.reload();
      return;
    }
    if (t.closest("[data-mkd-stale-dismiss]")) {
      e.preventDefault();
      e.stopPropagation();
      document.querySelector(".mkd-stale-build")?.remove();
    }
  },
  true
);

// 切去编辑器改完代码、再切回来，正是该提醒的那一刻
window.addEventListener("focus", checkBuildFreshness);
// 启动时也查一次：有可能是先 build 再点的启动器，但窗口复用了旧进程
setTimeout(checkBuildFreshness, 1500);

/* ==================== 合规筛查：OFAC / UFLPA / BIS ==================== */

// 名单在主进程（4 万个主体，随包发货 452 KB，不联网）。查询要走 IPC 因而是异步的，
// 但 preflightOutboxItem 是同步的、还会被队列每一行反复调用——所以照 emailProbe
// 的做法：结果落在线索上，预检只读不查。
//
// 这块的红线和别处一样：**测不出就说测不出**。名单读不出来时绝不能静默返回
// "没命中"——那会让用户以为查过了，实际根本没查，而这次是法律风险。

function screeningReady() {
  const b = mkdBridge();
  return !!(b && typeof b.screenEntity === "function");
}

async function screenProspect(prospectId, quiet = false) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect || !prospect.company) return null;
  if (!screeningReady()) {
    if (!quiet) addLog("合规筛查只有桌面版能用（名单在主进程里）");
    return null;
  }

  const res = await window.mkd.screenEntity(prospect.company);
  if (!res || res.ok === false) {
    if (!quiet) addLog(`合规名单读取失败，${prospect.company} **没有查过**：${res?.reason || "未知原因"}`);
    return null;
  }

  state.prospects = state.prospects.map((p) =>
    p.id === prospectId
      ? {
          ...p,
          screening: {
            at: new Date().toISOString(),
            listBuiltAt: res.builtAt,
            hit: !!res.hit,
            match: res.match || "",
            level: res.level || "",
            matchedName: res.matchedName || "",
            hits: res.hits || [],
            candidates: res.candidates || []
          }
        }
      : p
  );

  if (!quiet && res.hit) {
    const what =
      res.match === "exact"
        ? `与名单主体「${res.matchedName}」归一化后完全一致`
        : `与 ${res.candidates.length} 个名单主体名称相近（疑似，需人工确认）`;
    addLog(`⚠️ 合规筛查命中：${prospect.company} ${what}。名单截至 ${res.builtAt}，重大交易前请到官方站点复核。`);
  }
  return res;
}

async function batchScreenProspects(ids) {
  const targets = (ids || [])
    .map((id) => state.prospects.find((p) => p.id === id))
    .filter((p) => p && p.company && !p.screening);
  if (!targets.length) {
    addLog("没有需要筛查的线索（要有公司名、且还没查过）");
    return;
  }
  if (!screeningReady()) {
    addLog("合规筛查只有桌面版能用");
    return;
  }

  runBegin("合规筛查", `准备查 ${targets.length} 家公司`);
  let exact = 0;
  let partial = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (!runIsActive()) break;
    runStep(`${i + 1}/${targets.length} · ${targets[i].company}`);
    const r = await screenProspect(targets[i].id, true);
    if (r?.hit) (r.match === "exact" ? (exact += 1) : (partial += 1));
  }
  saveState();
  render();
  runDone(
    exact || partial ? `命中 ${exact} 家、疑似 ${partial} 家` : `${targets.length} 家都不在名单上`,
    exact ? "命中的已在发信队列里拦下，点开看命中哪条法律线" : ""
  );
  addLog(`合规筛查完成：查了 ${targets.length} 家，精确命中 ${exact} 家、疑似 ${partial} 家`);
}

// 误报一定会发生（同名、近名）。给一个留痕的推翻入口，和 F3 的人工核实同构。
function overrideScreening(prospectId, reason) {
  const prospect = state.prospects.find((p) => p.id === prospectId);
  if (!prospect) return;
  prospect.screeningOverride = {
    at: new Date().toISOString(),
    by: state.campaign?.senderName || "本机操作者",
    reason: reason || "已人工确认不是同一主体"
  };
  addLog(
    `已人工推翻 ${prospect.company} 的合规命中（理由：${prospect.screeningOverride.reason}）。` +
      `此操作永久留痕，导出可见——合规责任在操作者。`
  );
  saveState();
  render();
}

// 预检读取：只看已存下来的结果，不发起查询
function screeningVerdict(prospect) {
  const s = prospect?.screening;
  if (!s || !s.hit) return null;
  if (prospect.screeningOverride) return { level: "overridden", text: "合规命中已人工推翻（留痕可查）" };
  if (s.match === "exact") {
    const blocking = (s.hits || []).filter((h) => h.level === "block");
    if (blocking.length) {
      return {
        level: "block",
        text: `合规命中：${blocking.map((h) => h.label).join("、")}（名单主体「${s.matchedName}」）`
      };
    }
    // 只有证券投资限制这类：不是贸易禁令，提示但不拦
    return { level: "info", text: `名单命中但不影响商品贸易：${(s.hits || []).map((h) => h.label).join("、")}` };
  }
  return { level: "warn", text: `名称与 ${(s.candidates || []).length} 个受限主体相近，建议人工确认是否同一家` };
}

if (typeof preflightOutboxItem === "function") {
  const __preflightBase = preflightOutboxItem;
  preflightOutboxItem = function (item) {
    const res = __preflightBase(item);
    const prospect = state.prospects.find((p) => p.id === item.prospectId);
    const v = screeningVerdict(prospect);
    if (!v) return res;
    if (v.level === "block") res.blockers.push(v.text);
    else if (v.level !== "overridden") res.warnings.push(v.text);
    return { ...res, ok: res.blockers.length === 0 };
  };
}

// 入池体检时顺带筛一遍：合规问题越早发现越好，别等到要发信才拦
if (typeof queueVet === "function") {
  const __vetBase = queueVet;
  queueVet = function (ids) {
    const out = __vetBase(ids);
    if (screeningReady()) {
      Promise.resolve()
        .then(() => batchScreenProspects(ids))
        .catch((e) => console.error("[screening] 入池筛查失败", e));
    }
    return out;
  };
}

/* ---------------------------- 合规筛查 UI ---------------------------- */

const SCREEN_LEVEL_TEXT = { block: "必须停", warn: "待确认", info: "可放行", overridden: "已推翻" };

function screeningPanelHtml(prospect) {
  const s = prospect?.screening;
  if (!s || !s.hit) return "";
  const v = screeningVerdict(prospect);
  const rows =
    s.match === "exact"
      ? (s.hits || []).map(
          (h) => `
        <li class="screen-hit is-${h.level}">
          <span class="screen-tag">${escapeHtml(SCREEN_LEVEL_TEXT[h.level] || h.level)}</span>
          <div>
            <strong>${escapeHtml(h.label)}${h.program ? `　<code>${escapeHtml(h.program)}</code>` : ""}</strong>
            <p>${escapeHtml(h.means)}</p>
          </div>
        </li>`
        )
      : (s.candidates || []).map(
          (c) => `
        <li class="screen-hit is-warn">
          <span class="screen-tag">名称相近</span>
          <div>
            <strong>${escapeHtml(c.name)}</strong>
            <p>${escapeHtml((c.hits || []).map((h) => h.label).join("、"))}</p>
          </div>
        </li>`
        );

  return `
    <div class="screen-panel is-${v ? v.level : "info"}">
      <div class="screen-head">
        <strong>合规筛查${s.match === "exact" ? "命中" : "疑似命中"}</strong>
        <span>${escapeHtml(
          s.match === "exact" ? `归一化后与名单主体「${s.matchedName}」一致` : `与 ${(s.candidates || []).length} 个受限主体名称相近`
        )}</span>
      </div>
      <ul class="screen-list">${rows.join("")}</ul>
      <p class="screen-caveat">
        名单截至 ${escapeHtml(s.listBuiltAt || "未知")}，是快照不是实时查询。
        OFAC / BIS / UFLPA 持续变动，<strong>重大交易前请到官方站点复核</strong>。
      </p>
      ${
        prospect.screeningOverride
          ? `<p class="screen-override">已由 ${escapeHtml(prospect.screeningOverride.by)} 于 ${escapeHtml(
              prospect.screeningOverride.at.slice(0, 10)
            )} 人工推翻：${escapeHtml(prospect.screeningOverride.reason)}</p>`
          : `<button type="button" class="btn-ghost screen-override-btn" data-mkd-screen-override="${escapeHtml(prospect.id)}">
               我已确认不是同一家（留痕）
             </button>`
      }
    </div>`;
}

// 潜客页顶部再加一个批量按钮
if (typeof mountProspectNetActions === "function") {
  const __actionsBase = mountProspectNetActions;
  mountProspectNetActions = function () {
    __actionsBase();
    const wrap = document.getElementById("mkdNetActions");
    if (!wrap || wrap.querySelector("[data-mkd-screen-batch]")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-ghost";
    btn.setAttribute("data-mkd-screen-batch", "");
    btn.title = "对照 OFAC / UFLPA / BIS 名单查一遍（本地名单，不联网）。命中的会在发信队列里被拦下。";
    btn.textContent = "合规筛查";
    wrap.appendChild(btn);
  };
}

document.addEventListener(
  "click",
  (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-mkd-screen-batch]")) {
      e.preventDefault();
      e.stopPropagation();
      batchScreenProspects((state.prospects || []).map((p) => p.id));
      return;
    }
    const ov = t.closest("[data-mkd-screen-override]");
    if (ov) {
      e.preventDefault();
      e.stopPropagation();
      const id = ov.getAttribute("data-mkd-screen-override");
      const p = state.prospects.find((x) => x.id === id);
      mkdModal({
        title: "人工推翻合规命中",
        width: 560,
        danger: true,
        body: `
          <p>你正在推翻对「<strong>${escapeHtml(p?.company || "")}</strong>」的合规命中。</p>
          <p class="muted">同名、近名的误报确实存在。但如果确实是同一主体，与其交易的法律责任由你承担。
          此操作永久留痕，数据导出中可见。</p>
          <label><span>推翻理由（必填）</span>
            <input id="mkdScreenReason" type="text" placeholder="例：同名不同家，已核对注册地与业务范围" /></label>`,
        confirmText: "确认推翻",
        onConfirm: () => {
          const reason = (document.getElementById("mkdScreenReason")?.value || "").trim();
          if (!reason) return false; // 不填理由不让过
          overrideScreening(id, reason);
          return true;
        }
      });
    }
  },
  true
);

/* ==================== HS 编码校验 ==================== */

// 「AI 细化定位」会产出一个 HS 编码写进活动配置，但从来没人校验过它是否真实存在。
// 这和我们花大力气清掉的「编造联系人」是同一类问题：**把模型的输出当事实用**。
// 模型报一个不存在的码，用户拿去查海关数据、填报关单、跟客户对话，一路错到底，
// 而且没有任何一环会告诉他错了。
//
// 目录 8,261 条随包发货（158 KB），不联网。

function hsReady() {
  const b = mkdBridge();
  return !!(b && typeof b.hsLookup === "function");
}

async function verifyCampaignHs(quiet = false) {
  const code = (state.campaign?.hsCode || "").trim();
  if (!code) return null;
  if (!hsReady()) return null;

  const r = await window.mkd.hsLookup(code);
  if (!r || r.ok === false) {
    if (!quiet) addLog(`HS 目录读取失败，${code} **没有校验过**：${r?.reason || "未知原因"}`);
    return null;
  }

  state.campaign.hsCheck = {
    at: new Date().toISOString(),
    listBuiltAt: r.builtAt,
    queried: code,
    valid: !!r.valid,
    code: r.code || "",
    text: r.text || "",
    level: r.level || "",
    specificEnough: !!r.specificEnough,
    unit: r.unit || "",
    path: r.path || [],
    reason: r.reason || "",
    fallback: r.fallback || null,
    siblings: r.siblings || []
  };

  if (!quiet) {
    if (r.valid) {
      addLog(
        `HS ${r.code} 校验通过：${r.text}（${r.level}）。目录层级 ${r.path.map((p) => p.code).join(" → ")}` +
          (r.specificEnough ? "" : "。注意这只到" + r.level + "，报关要用到六位子目，还需要再细一级")
      );
    } else {
      addLog(`⚠️ AI 报的 HS「${code}」在目录里查不到：${r.reason}`);
    }
  }
  saveState();
  render();
  return r;
}

function hsPanelHtml() {
  const c = state.campaign?.hsCheck;
  if (!c) return "";
  const tone = c.valid ? (c.specificEnough ? "ok" : "warn") : "bad";
  const pathHtml = (c.path || [])
    .map((p) => `<span class="hs-node"><code>${escapeHtml(p.code)}</code>${escapeHtml(p.text.slice(0, 46))}</span>`)
    .join('<span class="hs-arrow">→</span>');

  return `
    <div class="hs-panel is-${tone}">
      <div class="hs-head">
        <span class="hs-badge">${c.valid ? (c.specificEnough ? "HS 有效" : "HS 有效但不够细") : "HS 查不到"}</span>
        <strong>${escapeHtml(c.queried)}</strong>
        ${c.valid ? `<span class="hs-text">${escapeHtml(c.text)}</span>` : ""}
      </div>
      ${c.valid ? `<div class="hs-path">${pathHtml}</div>` : `<p class="hs-reason">${escapeHtml(c.reason)}</p>`}
      ${
        !c.valid && c.fallback
          ? `<p class="hs-fallback">最近的有效上级：<code>${escapeHtml(c.fallback.code)}</code> ${escapeHtml(
              c.fallback.text.slice(0, 60)
            )}</p>`
          : ""
      }
      ${
        (c.siblings || []).length
          ? `<div class="hs-siblings"><span>同级可选：</span>${c.siblings
              .slice(0, 8)
              .map((s) => `<button type="button" data-mkd-hs-pick="${escapeHtml(s.code)}"><code>${escapeHtml(s.code)}</code>${escapeHtml(s.text.slice(0, 34))}</button>`)
              .join("")}</div>`
          : ""
      }
      <p class="hs-caveat">
        HS 国际六位目录（截至 ${escapeHtml(c.listBuiltAt || "?")}）。各国在六位之后自行扩展（中国 8 位、美国 10 位），
        <strong>报关以目的国税则和海关最终认定为准</strong>——这里只能告诉你这个码存不存在、是什么。
      </p>
      <div class="hs-actions">
        <input id="mkdHsSearch" type="text" placeholder="按英文关键词找码，如 unmanned aircraft / spray" />
        <button type="button" class="btn-ghost" data-mkd-hs-search>搜目录</button>
      </div>
      <div id="mkdHsResults" class="hs-results"></div>
    </div>`;
}

async function runHsSearch() {
  const box = document.getElementById("mkdHsResults");
  const kw = (document.getElementById("mkdHsSearch")?.value || "").trim();
  if (!box) return;
  if (kw.length < 2) {
    box.innerHTML = `<p class="hs-hint">输入至少两个字符</p>`;
    return;
  }
  box.innerHTML = `<p class="hs-hint">搜索中…</p>`;
  const r = await window.mkd.hsSearch(kw, 20);
  if (!r?.ok) {
    box.innerHTML = `<p class="hs-hint">搜索失败：${escapeHtml(r?.reason || "未知")}</p>`;
    return;
  }
  if (!r.rows.length) {
    box.innerHTML = `<p class="hs-hint">${escapeHtml(r.hint)}</p>`;
    return;
  }
  box.innerHTML = r.rows
    .map(
      (x) =>
        `<button type="button" class="hs-result" data-mkd-hs-pick="${escapeHtml(x.code)}">
           <code>${escapeHtml(x.code)}</code><span>${escapeHtml(x.text)}</span>
         </button>`
    )
    .join("");
}

function pickHsCode(code) {
  state.campaign.hsCode = code;
  addLog(`HS 编码改为 ${code}（你从目录里选的，不是模型给的）`);
  saveState();
  verifyCampaignHs(true).then(() => render());
}

// 细化定位跑完后自动校验一次
if (typeof refineProductFocus === "function") {
  const __refineBase = refineProductFocus;
  refineProductFocus = async function (...args) {
    const out = await __refineBase(...args);
    try {
      await verifyCampaignHs(false);
    } catch (error) {
      console.error("[hs] 校验失败", error);
    }
    return out;
  };
}

function mountHsPanel() {
  // 「AI 细化定位」这个按钮实际长在控制台首页（dashboardView），不是想当然的 focusView
  // ——项目里没有 focusView 这个 id。挂到按钮所在的卡片下面，紧挨着产生它的动作。
  const trigger = [...document.querySelectorAll("#dashboardView button")].find((b) =>
    /细化定位/.test(b.textContent || "")
  );
  const view = trigger ? trigger.closest("section, .card, form") || document.getElementById("dashboardView")
                       : document.getElementById("dashboardView");
  if (!view) return;
  const html = hsPanelHtml();
  let box = document.getElementById("mkdHsBox");
  if (!html) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "mkdHsBox";
    view.appendChild(box);
  }
  // 搜索结果是异步填的，重渲染别冲掉
  const keep = document.getElementById("mkdHsResults")?.innerHTML || "";
  const kw = document.getElementById("mkdHsSearch")?.value || "";
  box.innerHTML = html;
  if (keep) {
    const slot = document.getElementById("mkdHsResults");
    if (slot) slot.innerHTML = keep;
  }
  if (kw) {
    const input = document.getElementById("mkdHsSearch");
    if (input) input.value = kw;
  }
}

document.addEventListener(
  "click",
  (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-mkd-hs-search]")) {
      e.preventDefault();
      e.stopPropagation();
      runHsSearch();
      return;
    }
    const pick = t.closest("[data-mkd-hs-pick]");
    if (pick) {
      e.preventDefault();
      e.stopPropagation();
      pickHsCode(pick.getAttribute("data-mkd-hs-pick"));
    }
  },
  true
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target && e.target.id === "mkdHsSearch") {
    e.preventDefault();
    runHsSearch();
  }
});

const __netBaseRender5 = render;
render = function () {
  __netBaseRender5();
  try {
    mountHsPanel();
  } catch (error) {
    console.error("[hs] 面板挂载失败", error);
  }
};

/* ==================== 公共部门货物采购官（独立线索源） ==================== */

// 刻意不混进主线索池。画像完全不同：发展中国家公共部门与国际组织，
// 品类杂、单子偏小、采购流程也不同。混进去用户会拿给进口商写的开发信模板
// 去发采购官，口径完全不对。
//
// 更重要的是**不能包装成"最新标讯"**：GO 类公告没有截止日字段，全库只有
// 231 条截止日未过。它是联系人库，界面上就得这么说。

let tendersState = { country: "", keyword: "", activeSince: "2025-01-01", rows: [], meta: null, loading: false };

function tendersReady() {
  const b = mkdBridge();
  return !!(b && typeof b.tendersSearch === "function");
}

async function runTendersSearch() {
  if (!tendersReady()) return;
  tendersState.loading = true;
  renderTendersPanel();
  const r = await window.mkd.tendersSearch({
    country: tendersState.country,
    keyword: tendersState.keyword,
    activeSince: tendersState.activeSince,
    limit: 60
  });
  tendersState.loading = false;
  if (!r?.ok) {
    tendersState.rows = [];
    addLog(`采购官库读取失败：${r?.reason || "未知原因"}`);
  } else {
    tendersState.rows = r.rows;
    tendersState.meta = { builtAt: r.builtAt, dataThrough: r.dataThrough, count: r.count, caveats: r.caveats };
  }
  renderTendersPanel();
}

// 导入到主线索池：明确标来源，联系方式算「真实源」——这些是官方公开发布的
// 公务联系方式，比官网抓取还硬。但仍要留出处，和别处一个标准。
function importTenderContacts(emails) {
  const picked = tendersState.rows.filter((r) => emails.includes(r.email));
  if (!picked.length) return;

  const list = picked.map((r) => ({
    id: makeId("prospect"),
    company: r.org || r.name || r.email.split("@")[1],
    contactName: r.name || "",
    email: r.email,
    phone: r.phone || "",
    website: "",
    market: r.country || "",
    status: "待联系",
    source: "公共部门采购公告",
    contactSource: "webhook", // 官方公开发布的公务联系方式，走「真实源」口径
    contactSourceUrl: "",
    emailCandidates: [{ email: r.email, pattern: "verified", confidence: 95, source_url: "世行采购公告（公开发布）" }],
    profile: r.buys?.length ? `采购过：${r.buys.join("；").slice(0, 200)}` : "",
    tenderMeta: { lastNotice: r.lastNotice, noticeCount: r.noticeCount, dataThrough: tendersState.meta?.dataThrough }
  }));

  const admitted = admitProspects(list, "公共部门采购官");
  state.prospects = [...admitted, ...state.prospects];
  saveState();
  render();
  addLog(
    `已导入 ${admitted.length} 位公共部门采购官到线索池。注意他们的画像和进口商不同——` +
      `品类杂、单子偏小、走公开采购流程，开发信要另写一套，别套用给分销商的模板。`
  );
}

function tendersPanelHtml() {
  const m = tendersState.meta;
  const rows = tendersState.rows;
  return `
    <div class="tender-panel">
      <div class="tender-head">
        <div>
          <span class="tender-title">公共部门货物采购官</span>
          <span class="tender-sub">
            世行融资项目的公开采购公告里留的公务联系人${m ? `，共 ${m.count.toLocaleString()} 位` : ""}。
            <strong>这是联系人库，不是招标机会</strong>——公告本身多数已过期，但人和机构还在。
          </span>
        </div>
      </div>
      <div class="tender-filters">
        <input id="mkdTenderCountry" type="text" placeholder="国家（如 India / Kenya，留空=全部）" value="${escapeHtml(
          tendersState.country
        )}" />
        <input id="mkdTenderKw" type="text" placeholder="买过什么 / 机构名关键词（如 laptop、pump）" value="${escapeHtml(
          tendersState.keyword
        )}" />
        <label class="tender-since">
          <input type="checkbox" id="mkdTenderActive" ${tendersState.activeSince ? "checked" : ""} />
          <span>只看 2025 年后仍在发采购公告的</span>
        </label>
        <button type="button" class="btn-ghost" data-mkd-tender-search>查询</button>
      </div>
      ${
        tendersState.loading
          ? `<p class="tender-hint">查询中…</p>`
          : rows.length
          ? `<div class="tender-bulk">
               <label><input type="checkbox" id="mkdTenderAll" /> <span>全选本页 ${rows.length} 位</span></label>
               <button type="button" class="btn-ghost" data-mkd-tender-import>导入选中到线索池</button>
             </div>
             <ul class="tender-list">
               ${rows
                 .map(
                   (r) => `
                 <li class="tender-item">
                   <input type="checkbox" class="tender-pick" data-email="${escapeHtml(r.email)}" />
                   <div class="tender-info">
                     <strong>${escapeHtml(r.name || "（未署名）")}</strong>
                     <span class="tender-org">${escapeHtml(r.org || "")}</span>
                     <div class="tender-meta">
                       <code>${escapeHtml(r.email)}</code>
                       ${r.phone ? `<span>${escapeHtml(r.phone)}</span>` : ""}
                       ${r.country ? `<span>${escapeHtml(r.country)}</span>` : ""}
                       <span class="tender-last">最近公告 ${escapeHtml(r.lastNotice || "?")} · 共 ${r.noticeCount} 条</span>
                     </div>
                     ${r.buys?.length ? `<p class="tender-buys">采购过：${escapeHtml(r.buys.join("；").slice(0, 150))}</p>` : ""}
                   </div>
                 </li>`
                 )
                 .join("")}
             </ul>`
          : `<p class="tender-hint">点「查询」看结果。可以先不填条件，直接看最近还在采购的那批。</p>`
      }
      ${
        m
          ? `<div class="tender-caveats">
               <p><strong>数据截至 ${escapeHtml(m.dataThrough || "?")}</strong>（构建于 ${escapeHtml(m.builtAt)}）</p>
               ${m.caveats.map((c) => `<p>· ${escapeHtml(c)}</p>`).join("")}
             </div>`
          : ""
      }
    </div>`;
}

function renderTendersPanel() {
  const box = document.getElementById("mkdTenderBox");
  if (!box) return;
  const focus = document.activeElement?.id;
  box.innerHTML = tendersPanelHtml();
  if (focus) document.getElementById(focus)?.focus();
}

function mountTendersPanel() {
  const view = document.getElementById("discoveryView");
  if (!view || !tendersReady()) return;
  let box = document.getElementById("mkdTenderBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "mkdTenderBox";
    view.appendChild(box);
    box.innerHTML = tendersPanelHtml();
  }
}

document.addEventListener(
  "click",
  (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-mkd-tender-search]")) {
      e.preventDefault();
      e.stopPropagation();
      tendersState.country = (document.getElementById("mkdTenderCountry")?.value || "").trim();
      tendersState.keyword = (document.getElementById("mkdTenderKw")?.value || "").trim();
      tendersState.activeSince = document.getElementById("mkdTenderActive")?.checked ? "2025-01-01" : "";
      runTendersSearch();
      return;
    }
    if (t.id === "mkdTenderAll") {
      document.querySelectorAll(".tender-pick").forEach((c) => (c.checked = t.checked));
      return;
    }
    if (t.closest("[data-mkd-tender-import]")) {
      e.preventDefault();
      e.stopPropagation();
      const picked = [...document.querySelectorAll(".tender-pick:checked")].map((c) => c.dataset.email);
      if (!picked.length) {
        addLog("先勾选要导入的采购官");
        return;
      }
      importTenderContacts(picked);
    }
  },
  true
);

const __netBaseRender6 = render;
render = function () {
  __netBaseRender6();
  try {
    mountTendersPanel();
  } catch (error) {
    console.error("[tenders] 面板挂载失败", error);
  }
};
