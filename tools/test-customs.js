// 本地提单库集成自测：增量去重、按供应商反查、损坏容错
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mkd-customs-"));
app.setPath("userData", sandbox);

const customs = require(path.join(__dirname, "..", "electron", "customs.js"));

let passed = 0;
const fail = [];
function ok(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok ${name}${extra ? `\n     ${extra}` : ""}`);
  } else {
    fail.push(name);
    console.log(`  ✗ ${name}${extra ? `\n     ${extra}` : ""}`);
  }
}

const rec = (consignee, shipper, date, hs = "870880", desc = "brake pads") => ({
  consignee,
  shipper,
  country: "Brazil",
  date,
  hs,
  desc
});

app.whenReady().then(() => {
  console.log(`\n本地提单库集成自测（沙箱 userData: ${sandbox}）`);

  const batch1 = [
    rec("ACME IMPORTACAO LTDA", "ZONGSHEN INDUSTRIAL GROUP CO LTD", "2026-01-10"),
    rec("ACME IMPORTACAO LTDA", "ZONGSHEN INDUSTRIAL GROUP CO LTD", "2026-02-14"),
    rec("BRASIL MOTO PARTS SA", "ZONGSHEN INDUSTRIAL GROUP CO LTD", "2026-02-20"),
    rec("OUTRO COMERCIO LTDA", "LIFAN MOTORCYCLE CO", "2026-01-05")
  ];
  const r1 = customs.append(app, batch1);
  ok("首次导入全部入库", r1.added === 4 && r1.skipped === 0 && r1.total === 4, JSON.stringify(r1));

  // 同一份文件再导一次：不该翻倍
  const r2 = customs.append(app, batch1);
  ok("重复导入同一份数据不翻倍", r2.added === 0 && r2.skipped === 4 && r2.total === 4, JSON.stringify(r2));

  // 下季度的增量：老记录跳过、新记录并进来
  const r3 = customs.append(app, [...batch1, rec("ACME IMPORTACAO LTDA", "ZONGSHEN INDUSTRIAL GROUP CO LTD", "2026-05-03")]);
  ok("增量数据只并入新记录", r3.added === 1 && r3.skipped === 4 && r3.total === 5, JSON.stringify(r3));

  const s = customs.stats(app);
  ok("统计按去重口径算买家与供应商数", s.records === 5 && s.buyers === 3 && s.suppliers === 2, JSON.stringify(s));
  ok("最近提单日期正确", s.latest === "2026-05-03", s.latest);

  // 反查：部分名称、大小写、法务后缀都不该影响命中
  const q = customs.findByShipper(app, "zongshen");
  ok(
    "按供应商反查只返回该供应商的买家",
    q.ok && q.buyers.length === 2 && q.buyers.every((b) => !/OUTRO/i.test(b.company)),
    q.buyers.map((b) => `${b.company}×${b.count}`).join(" | ")
  );
  ok("买家按提单数排序，买得多的在前", q.buyers[0].count === 3 && q.buyers[1].count === 1);
  ok("带出最近提单日期", q.buyers[0].latest === "2026-05-03", q.buyers[0].latest);

  const q2 = customs.findByShipper(app, "ZONGSHEN INDUSTRIAL GROUP CO., LTD.");
  ok("全称带法务后缀也能命中", q2.ok && q2.buyers.length === 2);

  const q3 = customs.findByShipper(app, "no-such-supplier");
  ok("查不到时返回空列表而不是报错", q3.ok && q3.buyers.length === 0);

  const q4 = customs.findByShipper(app, "  ");
  ok("空查询给出明确提示", q4.ok === false && !!q4.error, q4.error);

  // 损坏容错：坏行不该毁掉整库
  fs.appendFileSync(customs.dbPath(app), "{这不是合法 JSON\n", "utf8");
  const s2 = customs.stats(app);
  ok("单行损坏时跳过该行，其余仍可读", s2.records === 5, JSON.stringify(s2));

  customs.clear(app);
  ok("清空后归零", customs.stats(app).records === 0);

  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(fail.length ? `\n${fail.length} 项失败：${fail.join("、")}` : `\n${passed} 项全部通过`);
  app.exit(fail.length ? 1 : 0);
});
