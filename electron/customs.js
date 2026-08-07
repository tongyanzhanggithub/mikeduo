// 本地海关提单库（主进程）
//
// 为什么不放 state/localStorage：那里只有 5MB，几万条提单必爆，而且会把整个
// state 的读写都拖慢。这里用 userData/customs.jsonl 单独存，线索池保持轻量。
//
// 为什么是 JSON Lines 而不是 SQLite：零依赖、可追加、坏了一行不毁全库、
// 用户能直接拿文本编辑器看。几十万条以内的顺序扫描完全够用。
//
// 这个库只服务本机查询。刻意不提供"导出整库"——多数数据商的条款允许订阅者
// 自用但禁止再分发，做了导出就等于给再分发提供了通道。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function dbPath(app) {
  return path.join(app.getPath("userData"), "customs.jsonl");
}

// 与渲染层 companyDedupeKey 同口径：去法务后缀、只留字母数字与中日韩
const LEGAL_SUFFIX =
  /\b(co|inc|ltd|llc|lda|ltda|gmbh|sa|sas|srl|bv|nv|plc|pte|pty|corp|corporation|company|limited|import|export|trading)\b/g;

function dedupeKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^a-z0-9一-龥]+/g, " ")
    .trim();
}

// 一条提单的身份：同一份数据重复导入不该翻倍，增量数据要能并进来
function recordId(r) {
  return crypto
    .createHash("sha1")
    .update([dedupeKey(r.consignee), dedupeKey(r.shipper), r.date || "", r.hs || "", (r.desc || "").slice(0, 60)].join("|"))
    .digest("hex")
    .slice(0, 16);
}

function readAll(app) {
  const file = dbPath(app);
  if (!fs.existsSync(file)) return [];
  const out = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 单行坏了就跳过这一行，不让一处损坏毁掉整库
    }
  }
  return out;
}

// 追加导入。返回 { added, skipped, total }——skipped 是重复记录，
// 用户重复导同一份文件时要能看到"这次没有新东西"而不是默默无事发生。
function append(app, records) {
  const incoming = Array.isArray(records) ? records : [];
  if (!incoming.length) return { added: 0, skipped: 0, total: readAll(app).length };

  const existing = readAll(app);
  const seen = new Set(existing.map((r) => r.id));
  const fresh = [];
  let skipped = 0;
  incoming.forEach((r) => {
    const consignee = String(r.consignee || "").trim();
    if (!consignee) return;
    const rec = {
      consignee,
      shipper: String(r.shipper || "").trim(),
      country: String(r.country || "").trim(),
      date: String(r.date || "").trim(),
      hs: String(r.hs || "").trim(),
      desc: String(r.desc || "").slice(0, 200).trim()
    };
    rec.id = recordId(rec);
    if (seen.has(rec.id)) {
      skipped += 1;
      return;
    }
    seen.add(rec.id);
    rec.at = new Date().toISOString().slice(0, 10); // 入库日，用来说明"这批是什么时候导的"
    fresh.push(rec);
  });

  if (fresh.length) {
    fs.appendFileSync(dbPath(app), fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  return { added: fresh.length, skipped, total: existing.length + fresh.length };
}

function stats(app) {
  const all = readAll(app);
  const consignees = new Set();
  const shippers = new Set();
  let latest = "";
  all.forEach((r) => {
    if (r.consignee) consignees.add(dedupeKey(r.consignee));
    if (r.shipper) shippers.add(dedupeKey(r.shipper));
    if (r.date && r.date > latest) latest = r.date;
  });
  return { records: all.length, buyers: consignees.size, suppliers: shippers.size, latest };
}

// 按供应商反查：给一个（部分）供应商名，列出从它进货的买家。
// 提单数据独有的能力——竞品官网上的经销商页是宣传，这里是交易记录。
function findByShipper(app, query, limit = 100) {
  const q = dedupeKey(query);
  if (!q) return { ok: false, error: "请输入供应商名称" };
  const all = readAll(app);
  const groups = new Map();
  const matchedShippers = new Set();

  all.forEach((r) => {
    const sk = dedupeKey(r.shipper);
    if (!sk || !sk.includes(q)) return;
    matchedShippers.add(r.shipper);
    const key = dedupeKey(r.consignee);
    if (!key) return;
    const g = groups.get(key) || {
      company: r.consignee,
      count: 0,
      latest: "",
      countries: new Set(),
      hs: new Set(),
      shippers: new Set()
    };
    g.count += 1;
    // 同一家公司在提单里常有多种写法，取最短的（长的多半带 C/O 货代后缀）
    if (r.consignee && r.consignee.length < g.company.length) g.company = r.consignee;
    if (r.date && r.date > g.latest) g.latest = r.date;
    if (r.country) g.countries.add(r.country);
    if (r.hs) g.hs.add(r.hs);
    if (r.shipper) g.shippers.add(r.shipper);
    groups.set(key, g);
  });

  const buyers = [...groups.values()]
    .map((g) => ({
      company: g.company,
      count: g.count,
      latest: g.latest,
      country: [...g.countries][0] || "",
      hs: [...g.hs].slice(0, 3),
      shippers: [...g.shippers].slice(0, 3)
    }))
    // 进货多的排前面：同样是竞品客户，买得多的那家更值得先打
    .sort((a, b) => b.count - a.count || (b.latest > a.latest ? 1 : -1))
    .slice(0, limit);

  return { ok: true, buyers, matchedShippers: [...matchedShippers].slice(0, 8), scanned: all.length };
}

function clear(app) {
  try {
    fs.rmSync(dbPath(app), { force: true });
  } catch {
    /* 删不掉不影响使用 */
  }
  return { ok: true };
}

module.exports = { append, stats, findByShipper, clear, dedupeKey, recordId, readAll, dbPath };
