// 从 trade_dataset.sqlite 抽出 HS 目录 → data/hscodes.json.gz
//
//   node tools/build-hscodes.mjs [sqlite路径]
//
// 为什么要它：AI 细化定位会产出一个 HS 编码，但我们从来没校验过——
// 模型报一个不存在的码，用户拿去查海关数据、填报关单，一路错到底。
// 有了本地目录就能当场判真伪，并把它在目录里的位置摊开给用户看。
//
// 只留 revision='HS'：实测 H6 是它的子集（H6 独有 0 条，交集里描述完全一致），
// 两套都带只会让同一个码出现两遍。
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
const dump = join(tmpdir(), "mkd-hs-dump.json").split(String.fromCharCode(92)).join("/");

const py = `
import sqlite3, json, io
c = sqlite3.connect("file:${src}?mode=ro", uri=True).cursor()
rows = []
for code, digits, parent, desc, unit in c.execute(
    "SELECT code, digits, parent, descripcion, standardunitabbr FROM hs_codes "
    "WHERE revision='HS' AND code IS NOT NULL AND code!='TOTAL'"):
    rows.append({"c": code, "d": int(digits or 0), "p": parent or "", "t": desc or "", "u": unit or ""})
io.open(r"${dump}", "w", encoding="utf-8").write(json.dumps(rows, ensure_ascii=False))
`;

execFileSync("python", ["-c", py], { stdio: ["ignore", "inherit", "inherit"] });
const rows = JSON.parse(readFileSync(dump, "utf8"));
rmSync(dump, { force: true });

// 描述里的前导横杠是原始数据表示层级用的（"- -  Pure-bred..."），
// 层级我们已经有 parent 链了，横杠对用户只是噪声。
const clean = (t) =>
  String(t || "")
    .replace(/^[\s\-–—:]+/, "")
    .replace(/\s*:--\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();

const out = {
  builtAt: new Date().toISOString().slice(0, 10),
  source: "trade_dataset.sqlite · hs_codes（revision=HS）",
  count: rows.length,
  caveats: [
    "这是 HS 国际六位目录。各国在六位之后自行扩展（中国 8 位、美国 10 位），报关以目的国税则为准。",
    "HS 每 5 年修订一次，商品归类以海关最终认定为准——这里只能告诉你这个码存不存在、是什么。"
  ],
  rows: rows.map((r) => ({ c: r.c, d: r.d, p: r.p, t: clean(r.t), u: r.u === "n/a" ? "" : r.u }))
};

mkdirSync(join(root, "data"), { recursive: true });
const json = JSON.stringify(out);
const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
writeFileSync(join(root, "data", "hscodes.json.gz"), gz);

const byDigits = out.rows.reduce((m, r) => ((m[r.d] = (m[r.d] || 0) + 1), m), {});
console.log(`HS 目录 ${out.count.toLocaleString()} 条：` + Object.entries(byDigits).map(([d, n]) => `${d}位 ${n}`).join(" · "));
console.log(`data/hscodes.json.gz  ${(gz.length / 1024).toFixed(0)} KB（未压缩 ${(json.length / 1024).toFixed(0)} KB）`);
