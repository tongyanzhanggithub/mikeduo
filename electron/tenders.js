// 公共部门货物采购官（主进程）：一个独立的线索来源
//
// ── 这是什么，不是什么 ────────────────────────────────────────
// **是**：4,433 个真实采购官的姓名/邮箱/电话/所属机构，来自世行融资项目的
//         公开采购公告，附他们买过什么、最近一次公告是什么时候。
// **不是**：招标机会。GO 类公告没有截止日字段，全库只有 231 条截止日未过。
//           界面上必须按"联系人库"说，不能包装成"最新标讯"——那是骗人的。
//
// ── 为什么单独一块，不混进主线索池 ─────────────────────────────
// 画像完全不同：发展中国家公共部门与国际组织，品类杂、单子偏小，采购流程也不同。
// 混进去用户会拿给进口商写的开发信模板去发采购官，口径完全不对。
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

let DB = null;

function load() {
  if (DB) return DB;
  const file = path.join(__dirname, "..", "data", "tenders.json.gz");
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  DB = raw;
  return DB;
}

function meta() {
  const db = load();
  return { builtAt: db.builtAt, dataThrough: db.dataThrough, count: db.count, caveats: db.caveats, source: db.source };
}

function countries() {
  const db = load();
  const m = new Map();
  db.rows.forEach((r) => m.set(r.c || "（未标注）", (m.get(r.c || "（未标注）") || 0) + 1));
  return {
    ok: true,
    rows: [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    ...meta()
  };
}

// 搜索：按国家 + 关键词（关键词命中"买过什么"或机构名）
// activeSince 让用户只看近期还在采购的人——这是这份数据里最有价值的一维。
function search({ country = "", keyword = "", activeSince = "", limit = 60 } = {}) {
  const db = load();
  const kw = String(keyword || "").trim().toLowerCase();
  const ctry = String(country || "").trim().toLowerCase();
  const since = String(activeSince || "").trim();

  // 上限先夹好再进循环：原来是 push 完再判 rows.length >= limit，
  // 传 limit=0 时会先塞进一条才 break，返回 1 条而不是 0 条。
  const cap = Math.max(0, Math.min(500, Number(limit) || 0));
  const rows = [];
  for (const r of db.rows) {
    if (rows.length >= cap) break;
    if (ctry && String(r.c || "").toLowerCase() !== ctry) continue;
    if (since && (r.last || "") < since) continue;
    if (kw) {
      const hay = `${r.o || ""} ${(r.buys || []).join(" ")}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    rows.push({
      email: r.e,
      name: r.n,
      phone: r.p,
      org: r.o,
      country: r.c,
      lastNotice: r.last,
      noticeCount: r.cnt,
      buys: r.buys || []
    });
  }
  // 已按最近活动排过序（构建时排的），这里保持
  return { ok: true, rows, query: { country, keyword, activeSince }, ...meta() };
}

module.exports = { search, countries, stats: () => ({ ok: true, ...meta() }) };
