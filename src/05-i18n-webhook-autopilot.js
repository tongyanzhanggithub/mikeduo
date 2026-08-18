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

/* ---------- 首封信的第一句：我为什么找到你 ----------

   各品类模板的开场都是 "We understand [公司] may source [产品] for the [市场]
   market"。这句话对谁都成立，也就等于什么都没说——一个欧洲分销商的 info@ 每天
   躺着几十封长得一模一样的中国供应商开发信，这句正是它们的共同特征。

   能把信从"群发"里拉出来的只有一件事：开头就说出一个**对方能自己核实**的事实。
   这些事实其实一直握在手里，只是从来没往信里放过——提单条数、他现在在跟谁买、
   我们是在哪个页面上看到他的。

   这里刻意用「结构化字段拼模板」而不是让模型写。模型看到"写个有说服力的开场"
   就会开始编，编出一句 "I noticed your recent expansion in the German market"，
   对方一看就知道是假的，比群发还糟。拼模板只可能说出我们真的知道的东西。

   拿不出硬事实时返回空串，让信回到原来的中性开场。宁可平淡，不可编造——
   跟"绝不编造联系人"是同一条铁律。 */
function evidenceOpener(prospect) {
  if (!prospect) return "";
  const suppliers = (prospect.currentSuppliers || []).filter(Boolean);
  const records = Number(prospect.customsRecords) || 0;
  const goods = String(prospect.customsProduct || "").trim().toLowerCase().slice(0, 60);

  // ① 提单：最硬的事实——他在买、买了多少次、现在跟谁买
  if (records > 0) {
    const what = goods ? `shipments of ${goods}` : "import shipments in this product category";
    const base =
      records >= 2
        ? `Public import records list ${records} ${what} to ${prospect.company}.`
        : `Public import records show a recent shipment of ${goods || "this product category"} to ${prospect.company}.`;
    return suppliers.length
      ? `${base} I understand your current supply for this category comes from ${suppliers.slice(0, 2).join(" and ")}, which is why I am writing to you directly rather than sending a general enquiry.`
      : `${base} That is why I am writing to you directly rather than sending a general enquiry.`;
  }

  // ② 只知道现供应商（按供应商反查那条路）
  if (suppliers.length) {
    return `I understand ${prospect.company} currently sources this product category from ${suppliers.slice(0, 2).join(" and ")}. I am writing because we supply the same category and may be able to act as a second source for you.`;
  }

  // ③ 竞品经销商页：不点品牌名——那是模型写的中文备注，搬进英文信里既不通顺，
  //    也可能是它自己加的戏。只说我们确实做过的事：在经销商名录上看到你。
  if (/竞品/.test(prospect.source || "")) {
    return `I came across ${prospect.company} listed as an authorised distributor for this product category in ${prospect.market}, which is why I am contacting you specifically.`;
  }

  // ④ 官网公示：最弱但仍然真实——地址是从他自己网站上抄的，不是买来的名单
  if (prospect.contactSource === "website" && prospect.contactSourceUrl) {
    return "I found your contact details on your own website, so I hope this message reaches the right person.";
  }

  return "";
}

/* 把开场句插在称呼之后。所有品类模板的正文都以 "Dear X," + 空行 起头，
   按第一个空行切一刀就能统一插入，不必去改十几套模板各自的文案。 */
function withEvidenceOpener(body, prospect) {
  const opener = evidenceOpener(prospect);
  if (!opener) return body;
  /* 有了硬开场，那句 "We understand X may source Y for the Z market" 就必须拿掉。
     刚说完"公开提单显示你进了 12 次货"，紧接着又说"我们了解你可能采购"——
     自己打自己的脸，反而暴露前面那句也是套模板。十几套品类模板里都有这句，
     且各自独占一个段落，所以按段落整段丢掉，比去改每一套模板稳妥。 */
  const paras = String(body)
    .split("\n\n")
    .filter((p) => !/^We understand /.test(p.trim()) || !/ may source /.test(p));
  if (paras.length < 2) return body;
  // 插在称呼之后、正文之前
  paras.splice(1, 0, opener);
  return paras.join("\n\n");
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
  // 只有首封需要「我为什么找到你」——后续跟进再说一遍就啰嗦了
  if (sequence[0]) sequence[0].body = withEvidenceOpener(sequence[0].body, prospect);

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

// 这里原本还有一个 renderChecklist()：它渲染 .checklist-panel 那套五步引导。
// 但 08-commerce.js 里有同名函数，所有模块拼成一个 app.js 之后后者覆盖前者，
// 这一份从来没有执行过——页面上 .checklist-panel 数量恒为 0。已连同它专属的
// .checklist-* / .step-dot / .step-text 样式一并删除，控制台首页的引导以
// 08 的 .ob-* 那套为准。
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
