// 从 trade_dataset.sqlite 抽出「公共部门货物采购官」→ data/tenders.json.gz
//
//   node tools/build-tenders.mjs [sqlite路径]
//
// ── 为什么只抽联系人，不抽"招标机会" ────────────────────────────
// 实测：GO（货物）类公告的 submission_deadline_date 全部为空，全库也只有 231 条
// 截止日还没过。当"投标机会"卖是骗人的。
//
// 但同一份数据换个用法就成立：这些采购官和他们的机构还在，而且 2026 年仍有
// 1,584 条货物采购公告——人是活的，公告才是过期的。所以抽出来的是
// **联系人库**，界面上也必须这么说，不能包装成"最新招标信息"。
//
// ── 只留 GO（货物）─────────────────────────────────────────────
// CS（咨询服务）46,526 条、CW（土建）16,083 条，对卖货的人没有意义。
// GO 17,316 条 → 4,433 个去重采购官，这才是能对上话的人。
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { execFileSync } = require("node:child_process");

const src = (process.argv[2] || "D:/project/海关数据/exports/trade_dataset.sqlite")
  .split(String.fromCharCode(92))
  .join("/");
const dump = join(tmpdir(), "mkd-tenders-dump.json").split(String.fromCharCode(92)).join("/");

// noticedate 是 'DD-Mon-YYYY' 文本，SQL 里按字符串比大小会算错
// （'04-Aug-2026' < '31-Oct-2025'），所以日期解析放到 python 里做。
const py = `
import sqlite3, json, io, datetime, collections
MON = {m: i + 1 for i, m in enumerate(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])}
def pd(s):
    try:
        d, m, y = str(s).split('-')
        return datetime.date(int(y), MON[m], int(d)).isoformat()
    except Exception:
        return ''

c = sqlite3.connect("file:${src}?mode=ro", uri=True).cursor()
agg = {}
for name, email, phone, org, ctry, desc, nd, proj in c.execute(
    "SELECT contact_name, contact_email, contact_phone_no, contact_organization, "
    "project_ctry_name, bid_description, noticedate, project_name "
    "FROM wb_procurement WHERE procurement_group='GO' AND contact_email IS NOT NULL AND TRIM(contact_email)!=''"):
    key = str(email).strip().lower()
    if not key or '@' not in key:
        continue
    e = agg.setdefault(key, {"e": key, "n": "", "p": "", "o": "", "c": "", "last": "", "cnt": 0, "buys": []})
    e["cnt"] += 1
    if name and not e["n"]: e["n"] = str(name).strip()
    if phone and not e["p"]: e["p"] = str(phone).strip()
    if org and not e["o"]: e["o"] = str(org).strip()
    if ctry and not e["c"]: e["c"] = str(ctry).strip()
    d = pd(nd)
    if d > e["last"]: e["last"] = d
    t = (desc or proj or "").strip()
    if t and len(t) > 8 and t not in e["buys"] and len(e["buys"]) < 3:
        e["buys"].append(t[:140])

io.open(r"${dump}", "w", encoding="utf-8").write(json.dumps(list(agg.values()), ensure_ascii=False))
`;

execFileSync("python", ["-c", py], { stdio: ["ignore", "inherit", "inherit"] });
const rows = JSON.parse(readFileSync(dump, "utf8"));
rmSync(dump, { force: true });

rows.sort((a, b) => (b.last || "").localeCompare(a.last || "") || b.cnt - a.cnt);

const latest = rows.reduce((m, r) => (r.last > m ? r.last : m), "");
const out = {
  builtAt: new Date().toISOString().slice(0, 10),
  source: "trade_dataset.sqlite · wb_procurement（世行融资项目，procurement_group=GO 货物类）",
  dataThrough: latest,
  count: rows.length,
  caveats: [
    "这是**联系人库**，不是招标机会。GO 类公告没有截止日字段，全库只有 231 条截止日未过——别当成「最新标讯」用。",
    "来源是世行融资项目的公开采购公告，买方是发展中国家公共部门与国际组织，品类杂、单子偏小，和进口商/分销商是两拨人。",
    "官方公布的联系邮箱里约 44% 是个人免费邮箱（gmail 居多）。这是数据方明确点名的一条：**不要按「个人邮箱=不可信」过滤**，那会杀掉大量真实机构联系人。",
    "姓名与邮箱是官方公开发布的公务联系方式。发信仍须遵守目的地的商业邮件法规（欧盟/英国走 GDPR 那套）。"
  ],
  rows
};

mkdirSync(join(root, "data"), { recursive: true });
const json = JSON.stringify(out);
const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
writeFileSync(join(root, "data", "tenders.json.gz"), gz);

const recent = rows.filter((r) => r.last >= "2025-01-01").length;
console.log(`货物采购官 ${rows.length.toLocaleString()} 人（数据截至 ${latest}，其中 2025 年后仍有公告的 ${recent.toLocaleString()} 人）`);
console.log(`data/tenders.json.gz  ${(gz.length / 1024).toFixed(0)} KB（未压缩 ${(json.length / 1024).toFixed(0)} KB）`);
