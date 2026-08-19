// 发版前检查：内置数据集是不是该重建了
//
//   node tools/check-data-age.mjs
//
// 退出码：0 = 都还新鲜；1 = 有数据超过告警线（发版前必须先重建）
//
// 为什么单独一个脚本而不是塞进测试套件：普通测试不该因为"今天是某个日子"
// 而失败。但发版是个明确的时间点，在那一刻检查陈旧度正合适。
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ageOf, THRESHOLDS } = createRequire(import.meta.url)(join(root, "electron", "dataset-age.js"));

const FILES = {
  screening: "screening.json.gz",
  hscodes: "hscodes.json.gz",
  tenders: "tenders.json.gz"
};
const REBUILD = {
  screening: "node tools/build-screening.mjs",
  hscodes: "node tools/build-hscodes.mjs",
  tenders: "node tools/build-tenders.mjs"
};

console.log("内置数据集陈旧度检查\n");

let worst = "ok";
for (const [kind, file] of Object.entries(FILES)) {
  let builtAt = "";
  try {
    builtAt = JSON.parse(gunzipSync(readFileSync(join(root, "data", file))).toString("utf8")).builtAt;
  } catch (error) {
    console.log(`  ✗ ${kind}: 读不出来（${error.message}）`);
    worst = "alert";
    continue;
  }
  const a = ageOf(kind, builtAt);
  const t = THRESHOLDS[kind];
  const mark = a.level === "ok" ? "✓" : a.level === "warn" ? "!" : "✗";
  console.log(`  ${mark} ${a.label.padEnd(14)} 构建于 ${builtAt}（${a.days} 天前，提示线 ${t.warn} / 告警线 ${t.alert}）`);
  if (a.level !== "ok") {
    console.log(`      ${a.text}`);
    console.log(`      重建：${REBUILD[kind]}`);
  }
  if (a.level === "alert" || (a.level === "warn" && worst === "ok")) worst = a.level;
  if (a.level === "unknown" && worst === "ok") worst = "warn";
}

console.log("");
if (worst === "alert") {
  console.log("有数据已过告警线——发版前必须先重建，否则装机用户拿到的就是过期名单。");
  process.exit(1);
}
if (worst === "warn") {
  console.log("有数据接近陈旧，建议顺手重建一次再发版。");
  process.exit(0);
}
console.log("三份数据都还新鲜，可以发版。");
