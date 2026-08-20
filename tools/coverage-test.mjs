// 官网抓取覆盖率实测
//
//   node tools/coverage-test.mjs sites.txt
//
// README 里写的「有官网的公司 ≥60% 能拿到真实邮箱」目前**没有实测支撑**，
// 只测过 3 个站。这个数字撑着「零配置拿到真实联系人」这个卖点——
// 如果实际只有 20-30%，产品叙事就得改。这个脚本就是去把那个数字量出来。
//
// 输入格式随便：每行一个域名、完整 URL、CSV、甚至直接粘 Google 搜索结果都行，
// 脚本自己从文本里扫域名。平台站（领英/脸书/阿里）自动剔除。
//
// 输出：控制台一份统计 + 一份逐站明细 CSV，方便人工抽查是不是真的。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const np = createRequire(import.meta.url)(join(root, "electron", "netprobe.js"));

const input = process.argv[2] || "sites.txt";
const CONCURRENCY = 4;   // 我们是从用户自己的 IP 出发，别把人家网站抓出问题
const MAX_PAGES = 4;

// 控制字符一律用 fromCharCode 表达：这个项目已经被转义序列坑过三次
const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const BOM = String.fromCharCode(65279);

// 平台站不是客户官网，和产品里的口径保持一致
const PLATFORM =
  /(google|linkedin|facebook|instagram|twitter|x\.com|youtube|amazon|alibaba|made-in-china|globalsources|1688|taobao|tmall|jd\.com|ebay|indiamart|tradeindia|europages|kompass|yellowpages|wikipedia|blogspot|wordpress\.com|medium|pinterest|tiktok|whatsapp|telegram)\./i;

function extractDomains(text) {
  const out = new Set();
  for (const m of text.matchAll(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b/gi)) {
    const d = m[0].toLowerCase().replace(/^www\./, "");
    const parts = d.split(".");
    if (parts.length < 2) continue;
    if (!/^[a-z]{2,24}$/.test(parts[parts.length - 1])) continue;
    if (/^(pdf|png|jpe?g|gif|csv|xlsx?|docx?|zip|js|css|html?|json|md|txt)$/i.test(parts[parts.length - 1])) continue;
    if (parts[parts.length - 2].length < 2) continue;
    if (PLATFORM.test(d + ".")) continue;
    out.add(d);
  }
  return [...out];
}

let raw = "";
try {
  raw = readFileSync(resolve(input), "utf8");
} catch {
  console.error(`读不到 ${input}`);
  console.error("");
  console.error("用法：node tools/coverage-test.mjs 你的清单.txt");
  console.error("清单格式随便——每行一个域名、完整 URL、CSV，或者直接粘 Google 搜索结果。");
  process.exit(1);
}

const sites = extractDomains(raw);
if (!sites.length) {
  console.error("这个文件里没扫到任何域名（平台站已剔除）。");
  process.exit(1);
}

console.log(`扫到 ${sites.length} 个域名，开始抓（并发 ${CONCURRENCY}，每站最多 ${MAX_PAGES} 页）\n`);

const results = [];
const queue = sites.slice();
let done = 0;

async function worker() {
  while (queue.length) {
    const site = queue.shift();
    const t0 = Date.now();
    let r;
    try {
      r = await np.harvestSite(site, { maxPages: MAX_PAGES });
    } catch (error) {
      r = { ok: false, reason: `异常：${error.message}` };
    }
    const ms = Date.now() - t0;
    const emails = r.ok ? r.emails || [] : [];
    results.push({
      site,
      ok: !!r.ok,
      reason: r.reason || "",
      render: r.renderMode || "",
      renderWhy: r.renderWhy || "",
      pages: (r.visited || []).length,
      emails: emails.length,
      sameDomainEmails: emails.filter((e) => e.sameDomain).length,
      bestEmail: emails[0]?.email || "",
      how: emails[0]?.how || "",
      phone: (r.phones || [])[0] || "",
      whatsapp: r.whatsappPhone || "",
      linkedin: r.social?.linkedin || "",
      facts: (r.facts || []).length,
      ms
    });
    done += 1;
    const tag = !r.ok ? "打不开" : emails.length ? `${emails.length} 邮箱` : r.renderMode === "spa" ? "空壳站" : "无";
    process.stdout.write(CR + `  ${done}/${sites.length}  ${site.slice(0, 28).padEnd(30)} ${tag.padEnd(10)}`);
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));
process.stdout.write(CR + " ".repeat(74) + CR);

/* ------------------------------ 统计 ------------------------------ */

const n = results.length;
const reachable = results.filter((r) => r.ok);
const spa = reachable.filter((r) => r.render === "spa");
const staticOk = reachable.filter((r) => r.render !== "spa");
const withEmail = reachable.filter((r) => r.emails > 0);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const line = (k, v, extra = "") => console.log(`  ${k.padEnd(30)} ${String(v).padStart(6)}  ${extra}`);

console.log("=".repeat(64));
console.log("官网抓取覆盖率实测");
console.log("=".repeat(64));
line("样本域名", n);
line("能打开", reachable.length, pct(reachable.length, n));
line("  其中静态站", staticOk.length, pct(staticOk.length, reachable.length));
line("  其中动态渲染（抓不到）", spa.length, pct(spa.length, reachable.length));
console.log("");
console.log("  —— 关键数字：README 里写的是 ≥60% ——");
line("拿到邮箱（占能打开的）", withEmail.length, pct(withEmail.length, reachable.length));
line("拿到同域邮箱", reachable.filter((r) => r.sameDomainEmails > 0).length, pct(reachable.filter((r) => r.sameDomainEmails > 0).length, reachable.length));
line("拿到邮箱（占静态站）", staticOk.filter((r) => r.emails > 0).length, pct(staticOk.filter((r) => r.emails > 0).length, staticOk.length));
console.log("");
line("拿到电话", reachable.filter((r) => r.phone).length, pct(reachable.filter((r) => r.phone).length, reachable.length));
line("拿到 WhatsApp", reachable.filter((r) => r.whatsapp).length, pct(reachable.filter((r) => r.whatsapp).length, reachable.length));
line("邮箱或电话至少有一个", reachable.filter((r) => r.emails > 0 || r.phone).length, pct(reachable.filter((r) => r.emails > 0 || r.phone).length, reachable.length));
line("拿到官网事实（写开发信用）", reachable.filter((r) => r.facts > 0).length, pct(reachable.filter((r) => r.facts > 0).length, reachable.length));

console.log("");
console.log("  —— 邮箱来自哪种写法 ——");
const byHow = {};
withEmail.forEach((r) => (byHow[r.how] = (byHow[r.how] || 0) + 1));
Object.entries(byHow).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => line(`  ${k}`, v, pct(v, withEmail.length)));

console.log("");
console.log("  —— 打不开的原因 ——");
const byReason = {};
results.filter((r) => !r.ok).forEach((r) => (byReason[r.reason] = (byReason[r.reason] || 0) + 1));
Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => line(`  ${k.slice(0, 26)}`, v));

const avg = Math.round(results.reduce((s, r) => s + r.ms, 0) / Math.max(n, 1));
console.log("");
line("平均每站耗时", `${(avg / 1000).toFixed(1)}s`);
line("按此速度抓 100 家约需", `${Math.max(1, Math.round((avg * 100) / CONCURRENCY / 1000 / 60))} 分钟`);

/* ---------------------------- 明细 CSV ---------------------------- */

const cols = ["site", "ok", "reason", "render", "renderWhy", "pages", "emails", "sameDomainEmails", "bestEmail", "how", "phone", "whatsapp", "linkedin", "facts", "ms"];
const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csv = BOM + [cols.join(","), ...results.map((r) => cols.map((c) => esc(r[c])).join(","))].join(NL);
const out = join(root, "coverage-result.csv");
writeFileSync(out, csv, "utf8");
console.log("");
console.log(`逐站明细已写入 ${out}`);
console.log("用 Excel 打开抽查几行——这个数字要拿去决定产品叙事，不能自己骗自己。");
