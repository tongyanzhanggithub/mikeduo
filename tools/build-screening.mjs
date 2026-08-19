// 从 trade_dataset.sqlite 抽出合规筛查名单 → data/screening.json.gz
//
//   node tools/build-screening.mjs [sqlite路径]
//
// 为什么要抽而不是直接带原库：原库 395 MB，随包发货不现实；而筛查真正需要的
// 只有「名字 + 属于哪条法律线 + 项目代号」三列，抽出来 gzip 后 0.4 MB。
//
// 为什么落成文件而不是运行时查 sqlite：用户机器上没有那个库。这份名单要随包走。
//
// 更新节奏：OFAC/BIS/UFLPA 都是持续变动的名单。这个文件带 builtAt，
// 应用里会显示"名单截至 X 日"——过期的合规数据比没有更危险，必须让用户看见。
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2] || "D:/project/海关数据/exports/trade_dataset.sqlite";

// node 没有内置 sqlite 驱动，也不想为一个构建脚本引依赖 —— 用 python 转一道。
// 这个脚本只在我们这边跑，用户不需要有 python。
const require = createRequire(import.meta.url);
const { execFileSync } = require("node:child_process");

const srcPosix = src.split(String.fromCharCode(92)).join("/");
// 不走 stdout：Windows 上 python 的标准输出是 GBK，名单里有   之类字符会直接崩。
// 让它按 UTF-8 写文件，我们再读回来。
const dump = join(tmpdir(), "mkd-screening-dump.json").split(String.fromCharCode(92)).join("/");

const py = `
import sqlite3, json, sys
c = sqlite3.connect("file:${srcPosix}?mode=ro", uri=True).cursor()
rows = [{"n": r[0], "r": r[1], "d": r[2] or ""} for r in
        c.execute("SELECT listed_name, regime, detail FROM v_screening WHERE listed_name IS NOT NULL AND TRIM(listed_name)!=''")]
import io
io.open(r"${dump}", "w", encoding="utf-8").write(json.dumps(rows, ensure_ascii=False))
`;

execFileSync("python", ["-c", py], { stdio: ["ignore", "inherit", "inherit"] });
const rows = JSON.parse(readFileSync(dump, "utf8"));
rmSync(dump, { force: true });

// 同一个名字可能同时出现在多条线上（例如 OFAC 又 UFLPA）——合并成一条，
// 保留全部命中的线，因为三条线的后果不同，不能只留一条。
const merged = new Map();
for (const { n, r, d } of rows) {
  const name = String(n).trim();
  const key = name.toUpperCase();
  if (!merged.has(key)) merged.set(key, { n: name, hits: [] });
  const e = merged.get(key);
  if (!e.hits.some((h) => h.r === r && h.d === d)) e.hits.push({ r, d });
}

const out = {
  builtAt: new Date().toISOString().slice(0, 10),
  source: "trade_dataset.sqlite · v_screening（OFAC + 别名 + UFLPA + BIS-DPL）",
  count: merged.size,
  // 展示结果时必须一并显示的限制说明——数据方明确要求，我们照做
  caveats: [
    "名单是快照，不是实时查询。OFAC/BIS/UFLPA 持续变动，重大交易前请到官方站点复核。",
    "精确匹配会漏判：CHINA SPACESAT CO., LTD. 写成 CO. LTD.（少个逗号）就对不上，所以这里用归一化后比对。",
    "UFLPA 同一实体会被列在多个法条章节下，已按名称去重。",
    "三条法律线含义不同，不可一律当成「被制裁」——命中哪条，后果完全不同。"
  ],
  rows: [...merged.values()]
};

mkdirSync(join(root, "data"), { recursive: true });
const json = JSON.stringify(out);
const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
writeFileSync(join(root, "data", "screening.json.gz"), gz);

console.log(`原始 ${rows.length.toLocaleString()} 行 → 去重合并 ${merged.size.toLocaleString()} 个主体`);
console.log(`data/screening.json.gz  ${(gz.length / 1024).toFixed(0)} KB（未压缩 ${(json.length / 1024 / 1024).toFixed(1)} MB）`);
