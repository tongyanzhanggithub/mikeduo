// HS 编码目录（主进程）：校验 AI 报出来的编码是不是真的存在
//
// 起因：「AI 细化定位」会产出一个 HS 编码并写进活动配置，但我们从来没校验过。
// 模型报一个不存在的码，用户拿它去查海关数据、填报关单、跟客户对话，一路错到底
// 而且没有任何一环会告诉他错了——这和我们花大力气清掉的「编造联系人」是同一类问题：
// **把模型的输出当事实用**。
//
// 目录 8,261 条（HS 国际六位），gzip 158 KB，随包发货，不联网。
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { ageOf } = require("./dataset-age");

let DB = null;

function load() {
  if (DB) return DB;
  const file = path.join(__dirname, "..", "data", "hscodes.json.gz");
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  const byCode = new Map(raw.rows.map((r) => [r.c, r]));
  DB = { builtAt: raw.builtAt, count: raw.count, caveats: raw.caveats, source: raw.source, byCode, rows: raw.rows };
  return DB;
}

// 模型给出的写法五花八门：8479.89 / 8479 89 / 84.79.89 / HS847989。只留数字。
function normalizeCode(input) {
  return String(input || "").replace(/\D/g, "");
}

// 从一个码往上串出 章 → 品目 → 子目
function pathOf(code, byCode) {
  const out = [];
  let cur = byCode.get(code);
  let guard = 0;
  while (cur && guard++ < 8) {
    out.unshift({ code: cur.c, digits: cur.d, text: cur.t });
    if (!cur.p || cur.p === "TOTAL") break;
    cur = byCode.get(cur.p);
  }
  return out;
}

function lookup(input) {
  const db = load();
  const meta = { builtAt: db.builtAt, count: db.count, caveats: db.caveats, age: ageOf("hscodes", db.builtAt) };
  const digits = normalizeCode(input);

  if (!digits) return { ok: true, valid: false, reason: "没填编码", queried: input, ...meta };
  if (digits.length < 2) return { ok: true, valid: false, reason: "编码太短，HS 至少 2 位（章）", queried: input, ...meta };

  // 命中就直接返回
  const hit = db.byCode.get(digits);
  if (hit) {
    return {
      ok: true,
      valid: true,
      code: hit.c,
      digits: hit.d,
      text: hit.t,
      unit: hit.u,
      path: pathOf(hit.c, db.byCode),
      // 六位以下不是最终归类，得说清楚
      level: hit.d === 2 ? "章" : hit.d === 4 ? "品目" : "子目",
      specificEnough: hit.d >= 6,
      children: db.rows.filter((r) => r.p === hit.c).slice(0, 24).map((r) => ({ code: r.c, text: r.t })),
      queried: input,
      ...meta
    };
  }

  // 没命中：可能是各国在六位之后自行扩展的位数（中国 8 位、美国 10 位）
  if (digits.length > 6) {
    const six = digits.slice(0, 6);
    const parent = db.byCode.get(six);
    if (parent) {
      return {
        ok: true,
        valid: false,
        reason: `${digits} 超过 HS 国际六位。前六位 ${six} 是有效子目，后面几位是各国自行扩展的（中国 8 位、美国 10 位），本目录只到六位。`,
        fallback: { code: parent.c, digits: parent.d, text: parent.t, path: pathOf(parent.c, db.byCode) },
        queried: input,
        ...meta
      };
    }
  }

  // 逐级回退，告诉用户最近的有效上级在哪 —— 比单说"无效"有用得多
  for (let len = Math.min(digits.length, 6) - 1; len >= 2; len -= 1) {
    const up = db.byCode.get(digits.slice(0, len));
    if (up) {
      return {
        ok: true,
        valid: false,
        reason: `${digits} 不在 HS 目录里。最近的有效上级是 ${up.c}（${up.t}），说明前 ${len} 位对、后面几位是模型编的。`,
        fallback: { code: up.c, digits: up.d, text: up.t, path: pathOf(up.c, db.byCode) },
        siblings: db.rows.filter((r) => r.p === up.c).slice(0, 12).map((r) => ({ code: r.c, text: r.t })),
        queried: input,
        ...meta
      };
    }
  }

  return { ok: true, valid: false, reason: `${digits} 不在 HS 目录里，连章号都对不上。`, queried: input, ...meta };
}

// 关键词搜索：用户自己找码时用。注意 HS 用的是法条式措辞——
// 搜 "drone" 一条都搜不到，它写作 "unmanned aircraft"。所以搜不到时要给提示。
function search(keyword, limit = 20) {
  const db = load();
  const kw = String(keyword || "").trim().toLowerCase();
  if (kw.length < 2) return { ok: true, rows: [], keyword, builtAt: db.builtAt };
  const rows = [];
  for (const r of db.rows) {
    if (r.t.toLowerCase().includes(kw)) {
      rows.push({ code: r.c, digits: r.d, text: r.t, unit: r.u });
      if (rows.length >= limit) break;
    }
  }
  return {
    ok: true,
    keyword,
    rows,
    // 六位子目才是可用于归类的层级，优先展示
    hint: rows.length
      ? ""
      : "没搜到。HS 用的是法条式措辞，和日常叫法常常不同——例如无人机写作 unmanned aircraft、喷头写作 spray guns。换个更书面的英文词再试。",
    builtAt: db.builtAt
  };
}

function stats() {
  const db = load();
  return { ok: true, builtAt: db.builtAt, count: db.count, source: db.source, caveats: db.caveats, age: ageOf("hscodes", db.builtAt) };
}

module.exports = { lookup, search, stats, normalizeCode };
