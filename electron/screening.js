// 合规筛查（主进程）：发信前查对方在不在制裁/实体名单上
//
// 名单来自 data/screening.json.gz（OFAC + 别名 + UFLPA + BIS-DPL，40,030 个主体），
// 由 tools/build-screening.mjs 从原始数据集抽取。随包发货，全程不联网。
//
// ── 为什么不能用 = 精确匹配 ──────────────────────────────────
// 数据方点名的头号坑：`CHINA SPACESAT CO., LTD.` 是名单主体，用户那边写成
// `CHINA SPACESAT CO. LTD.`（少一个逗号）精确匹配就失效。漏判有法律后果。
// 所以必须先归一化：转大写、去标点、去掉 CO/LTD/GMBH/S.A.C. 这类法律形式后缀，
// 再比对。
//
// ── 但也不能过度匹配 ─────────────────────────────────────────
// 反向的错同样要命：把正常客户误判成被制裁，用户会不敢做生意，而且很快就不
// 信任这个功能了。所以分两档——归一化后完全相等才「命中」，包含关系只作
// 「疑似」提示，且要求足够长、词数足够多，避免 "MOBILE" 撞上 "CHINA MOBILE"。
//
// ── 三条法律线不可合并成「被制裁」 ───────────────────────────
// 后果完全不同，必须分别说明。见 REGIME_MEANING。
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

let DB = null; // { builtAt, count, caveats, exact: Map, list: [] }

// 法律形式后缀：这些词不携带区分度，去掉才能让「写不写 LTD、有没有逗号」不影响比对。
//
// 刻意**不包含** TRADING / INTERNATIONAL / GROUP / HOLDING / IMPORT / EXPORT ——
// 那些是名字的组成部分，剥掉会把 "ACME TRADING" 和 "ACME HOLDINGS" 一起压成
// "ACME"，然后双双撞上名单里的 "ACME"。误报和漏报一样有害：用户会不敢做正常
// 生意，很快就不信任这个功能了。
const LEGAL_FORMS = [
  "CO", "COMPANY", "CORP", "CORPORATION", "INC", "INCORPORATED", "LTD", "LIMITED",
  "LLC", "LLP", "LP", "PLC", "PTE", "PTY", "GMBH", "MBH", "AG", "SA", "SAS", "SARL",
  "SRL", "SPA", "BV", "NV", "AB", "AS", "OY", "KFT", "OOO", "OAO", "PAO", "ZAO",
  "JSC", "OJSC", "CJSC", "PJSC", "SAC", "SAA", "EIRL", "SDN", "BHD", "TBK",
  "KK", "GK", "YK", "FZE", "FZC", "FZCO", "FZ", "DMCC", "WLL", "EST"
];
// 用集合过滤 token，不用正则——归一化后已经是单空格分词，直接比对更直白，
// 也躲开了一个真踩过的坑：写成 new RegExp("\b(...)") 时，如果只剩一个反斜杠，
// JS 会把它当成退格符 U+0008，正则里根本没有词边界，这条规则就静默失效了。
const LEGAL_SET = new Set(LEGAL_FORMS);

// 中日韩没有词边界，\b 用不上，只能按后缀直接切
const CJK_SUFFIX_RE = /(股份有限公司|有限责任公司|有限公司|集团有限公司|集团|公司|株式会社|有限会社)$/;

// 归一化：大写 → 去标点 → 去法律形式 → 压空格
// 中日韩字符保留（中文公司名不能被当标点抹掉）
function normalize(name) {
  let s = String(name || "")
    .toUpperCase()
    .replace(/[.,'"`‘’“”\-–—_/\()[\]{}&+·|:;!?*#@~^=<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.split(" ").filter((t) => t && !LEGAL_SET.has(t)).join(" ");
  // 中文后缀可能连着写，反复剥到剥不动为止（"XX集团有限公司"）
  let prev;
  do {
    prev = s;
    s = s.replace(CJK_SUFFIX_RE, "").trim();
  } while (s !== prev && s);
  return s;
}

function load() {
  if (DB) return DB;
  // 固定按本模块位置解析：data/ 就在 electron/ 隔壁。
  // 打包后同样成立（asar 内相对结构不变），但 package.json 的 build.files 必须带上 data/。
  const file = path.join(__dirname, "..", "data", "screening.json.gz");
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  const exact = new Map();
  raw.rows.forEach((row) => {
    const key = normalize(row.n);
    if (!key) return;
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key).push(row);
  });
  DB = {
    builtAt: raw.builtAt,
    count: raw.count,
    caveats: raw.caveats || [],
    source: raw.source,
    exact,
    // 疑似匹配要扫全表，预先算好归一化名，避免每次查询重算 4 万次
    list: raw.rows.map((row) => ({ row, key: normalize(row.n) })).filter((x) => x.key)
  };
  return DB;
}

// 三条法律线的实际含义。合并成一句「被制裁」是错的——后果差别很大。
const REGIME_MEANING = {
  OFAC: {
    label: "OFAC 特别指定国民名单（SDN）",
    means: "资金走美国渠道（美元清算、美资银行）时受限。与其交易可能触发美国次级制裁。",
    level: "block"
  },
  "OFAC-alias": {
    label: "OFAC 名单主体的别名",
    means: "这个名字是某个 OFAC 名单主体的曾用名或别称，实际受限主体是同一家。",
    level: "block"
  },
  UFLPA: {
    label: "UFLPA 涉疆实体清单",
    means: "货物运抵美国口岸即被 CBP 扣留，需自证不涉强迫劳动才能放行——举证责任在你方。",
    level: "block"
  },
  "BIS-DPL": {
    label: "BIS 被拒绝人员名单（DPL）",
    means: "向其供应含美国成分的货物或技术即构成违规，转口和再出口同样适用。",
    level: "block"
  }
};

// OFAC 里这一类只限制美国人买卖其证券，不是贸易禁令。
// 中国移动、中海油都在里面——把它标成「禁止交易」是明确的误报。
const SECURITIES_ONLY = /CMIC|EO13959|EO\s*13959|NS-CMIC/i;

function describeHit(hit) {
  const base = REGIME_MEANING[hit.r] || { label: hit.r, means: "属于受限名单，交易前请核实。", level: "block" };
  if (SECURITIES_ONLY.test(hit.d || "")) {
    return {
      regime: hit.r,
      program: hit.d,
      label: `${base.label}（证券投资限制类）`,
      means:
        "这一类只限制美国人买卖其证券，不是贸易禁令——正常商品买卖不受此条约束。" +
        "中国移动、中海油等均属此类。仍建议留档说明。",
      level: "info"
    };
  }
  return { regime: hit.r, program: hit.d, label: base.label, means: base.means, level: base.level };
}

// 疑似匹配的门槛：太短或只有一个词的名字不参与包含判断，
// 否则 "MOBILE" 会撞上 "CHINA MOBILE"，"OCEAN" 撞上一堆。
const MIN_PARTIAL_LEN = 8;
const MIN_PARTIAL_WORDS = 2;

function screen(name) {
  const db = load();
  const key = normalize(name);
  const meta = { builtAt: db.builtAt, count: db.count, caveats: db.caveats };
  if (!key) return { ok: true, hit: false, ...meta };

  // 一档：归一化后完全相等
  const exact = db.exact.get(key);
  if (exact && exact.length) {
    const hits = exact.flatMap((row) => row.hits.map(describeHit));
    return {
      ok: true,
      hit: true,
      match: "exact",
      matchedName: exact[0].n,
      queried: name,
      hits,
      level: hits.some((h) => h.level === "block") ? "block" : "info",
      ...meta
    };
  }

  // 二档：包含关系（只作提示，不阻断）
  const words = key.split(" ").filter(Boolean);
  if (key.length < MIN_PARTIAL_LEN || words.length < MIN_PARTIAL_WORDS) return { ok: true, hit: false, ...meta };

  const near = [];
  for (const item of db.list) {
    if (item.key === key) continue;
    if (item.key.length < MIN_PARTIAL_LEN) continue;
    if (item.key.includes(key) || key.includes(item.key)) {
      near.push(item.row);
      if (near.length >= 5) break;
    }
  }
  if (!near.length) return { ok: true, hit: false, ...meta };

  return {
    ok: true,
    hit: true,
    match: "partial",
    queried: name,
    candidates: near.map((row) => ({ name: row.n, hits: row.hits.map(describeHit) })),
    level: "warn",
    ...meta
  };
}

function stats() {
  const db = load();
  return { ok: true, builtAt: db.builtAt, count: db.count, source: db.source, caveats: db.caveats };
}

module.exports = { screen, stats, normalize, _internals: { describeHit, SECURITIES_ONLY, LEGAL_SET } };
