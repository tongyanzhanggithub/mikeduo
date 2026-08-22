// 规模性能基准：线索池涨到几千条时，界面还转不转得动
//
//   node tools/bench-scale.mjs
//
// 为什么要有这个：所有功能测试都是几条到几十条数据，跑得飞快。
// 但真实用户攒够半年线索是**几千条**，而渲染路径里有好几处
// 「对每条线索扫一遍全表」的写法——小数据量下看不出来，
// 数据一涨就是平方级。这个基准把曲线量出来，让退化无处可藏。
//
// 量的是 **JS 执行耗时**，不含浏览器排版绘制。
// 所以这里的数字是下界：真机上只会更慢，不会更快。
// 真机数字另由浏览器实测补（见 docs/交接与待办.md）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------------- 最小 DOM 桩 ----------------
   目标不是仿真浏览器，而是让 app.js 能整个加载起来并跑通 render()。
   innerHTML 只当普通属性存着——拼字符串的开销是真的，排版的开销不算。 */
function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: "",
    children: [],
    style: {},
    dataset: {},
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    checked: false,
    disabled: false,
    scrollTop: 0,
    offsetWidth: 100,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    insertAdjacentHTML() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    hasAttribute: () => false,
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    blur() {},
    click() {},
    remove() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 })
  };
  return el;
}

const doc = {
  documentElement: makeEl("html"),
  body: makeEl("body"),
  head: makeEl("head"),
  createElement: (t) => makeEl(t),
  createTextNode: () => makeEl("#text"),
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  visibilityState: "visible"
};

const store = new Map();
const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {} }, // 别让启动日志淹没基准输出
  document: doc,
  navigator: { userAgent: "bench", clipboard: { writeText: async () => {} }, onLine: true },
  location: { href: "file:///bench", hash: "", search: "" },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  },
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  fetch: async () => ({ ok: false, status: 0, text: async () => "", json: async () => ({}) }),
  alert() {},
  confirm: () => false,
  prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  scrollTo() {},
  crypto: { getRandomValues: (a) => a, randomUUID: () => "bench-uuid" },
  Date,
  Math,
  JSON,
  Intl,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  performance,
  Blob: class { constructor() {} },
  FileReader: class { readAsText() {} },
  Image: class { constructor() {} },
  Event: class { constructor(t) { this.type = t; } },
  CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
  MutationObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const ctx = createContext(sandbox);

let loadError = null;
try {
  runInContext(readFileSync(join(root, "app.js"), "utf8"), ctx, { filename: "app.js" });
  // app.js 顶层的 let/const 是词法绑定，不会成为 vm 全局对象的属性，
  // 用一段同上下文的尾巴把基准要用的引用导出来
  runInContext(
    // 用 getter 而不是快照：mkdActionableOutboxIds / mkdFilteredProspectIds 每次渲染都会被重新赋值
    `globalThis.__bench = {
       state, elements,
       selectedOutbox: mkdSelectedOutbox,
       OUTBOX_PAGE_SIZE, PROSPECT_PAGE_SIZE, CONVERSATION_PAGE_SIZE,
       get actionableOutboxIds() { return mkdActionableOutboxIds; },
       get filteredProspectIds() { return mkdFilteredProspectIds; }
     };`,
    ctx,
    { filename: "bench-export.js" }
  );
} catch (error) {
  loadError = error;
}
if (loadError) {
  console.log("app.js 在 DOM 桩下加载失败，基准无法运行：");
  console.log("  " + String(loadError.stack).split(String.fromCharCode(10)).slice(0, 6).join(String.fromCharCode(10) + "  "));
  console.log("  （桩缺了某个浏览器 API。补上对应的桩即可，不是产品代码的问题。）");
  process.exit(1);
}

/* ---------------- 造数据 ---------------- */

// 造得像真的：有官网、有邮箱、部分发过信、部分开过信、少量回过信。
// 全是同一种线索会让分支预测和早退把开销掩盖掉，量不出真实形状。
const MARKETS = ["United States", "Germany", "Brazil", "UAE", "Vietnam", "Nigeria"];
function buildState(n) {
  const prospects = [];
  const outbox = [];
  const inbound = [];
  const whatsappQueue = [];
  for (let i = 0; i < n; i += 1) {
    const id = `p-${i}`;
    prospects.push({
      id,
      company: `Global Trading Company ${i} Limited`,
      market: MARKETS[i % MARKETS.length],
      source: "google",
      website: `https://buyer-company-${i}.com`,
      email: `purchasing${i}@buyer-company-${i}.com`,
      emailStatus: i % 3 === 0 ? "格式有效" : "",
      phone: i % 4 === 0 ? "+1 555 0100 200" : "",
      contactName: `Buyer ${i}`,
      contactSource: i % 5 === 0 ? "website" : "local",
      status: i % 11 === 0 ? "已回复" : i % 3 === 0 ? "已入队" : "新线索",
      dealStage: "线索",
      buyingSignal: "importer and distributor of industrial equipment",
      searchQuery: "wholesale importer",
      createdAt: new Date(Date.now() - (n - i) * 60000).toISOString(),
      emailCandidates: [],
      optOut: i % 23 === 0,
      manualVerified: i % 17 === 0 ? { email: `purchasing${i}@buyer-company-${i}.com` } : undefined,
      emailProbe: i % 13 === 0 ? { email: `purchasing${i}@buyer-company-${i}.com`, status: i % 26 === 0 ? "invalid" : "valid" } : undefined
    });
    // 约三分之一进过发信队列，其中一部分已发送、少数被打开。
    // 每 7 条给一个"同客户多封"的情况——不然「疑似重复触达」那条分支
    // 根本不会触发，而 sentOutboxFor 正是改动最大的地方，测不到等于没测。
    if (i % 3 === 0) {
      const sent = i % 6 === 0;
      const mk = (k, step, subject, status) => ({
        id: `o-${i}-${k}`,
        prospectId: id,
        step,
        email: `purchasing${i}@buyer-company-${i}.com`,
        subject,
        body: "Dear Sir or Madam, we manufacture industrial nozzles and would like to introduce our range. Should you prefer not to receive further messages, kindly reply with unsubscribe.",
        status,
        sentAt: status === "已发送" ? new Date().toISOString() : "",
        opened: status === "已发送" && i % 12 === 0
      });
      outbox.push(mk(0, 1, `Quotation request follow-up ${i}`, sent ? "已发送" : "待发送"));
      if (i % 7 === 0) {
        outbox.push(mk(1, 1, `Quotation request follow-up ${i}`, "已发送")); // 同 step 同标题 → 应判重复
        outbox.push(mk(2, 2, `Second follow-up ${i}`, "已发送")); // 不同 step 不同标题 → 不应判重复
      }
    }
    if (i % 11 === 0) inbound.push({ id: `in-${i}`, prospectId: id, body: "Please send your price list." });
    if (i % 9 === 0) whatsappQueue.push({ id: `w-${i}`, prospectId: id, status: "待发送", read: false });
  }
  // 黑名单也放几条，否则 isBlacklisted 永远走 length 为 0 的早退分支
  const blacklist = prospects.filter((_, i) => i % 31 === 0).map((p) => ({ email: p.email, domain: "" }));
  return { prospects, outbox, inbound, whatsappQueue, blacklist };
}

/* ---------------- 计时 ---------------- */

function timeIt(fn, minMs = 120) {
  fn(); // 预热：让 JIT 先跑一遍，否则首次调用的编译开销会算进去
  let runs = 0;
  const t0 = performance.now();
  let elapsed = 0;
  do {
    fn();
    runs += 1;
    elapsed = performance.now() - t0;
  } while (elapsed < minMs && runs < 2000);
  return elapsed / runs;
}

const fmt = (ms) => (ms < 1 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms).toString());

/* ---------------- 正确性闸门 ----------------
   索引只有在**结果和扫表完全一致**时才有意义。快了但算错是灾难，
   所以先逐条比对两条路径的输出，不一致直接退出，不做任何性能测量。 */

{
  const data = buildState(400);
  Object.assign(ctx.__bench.state, data);
  const st = ctx.__bench.state;

  const scoreOf = (p) => JSON.stringify(ctx.computeLeadScore(p));
  const preflightOf = (o) => JSON.stringify(ctx.preflightOutboxItem(o));

  const rawScores = st.prospects.map(scoreOf);
  const rawPreflight = st.outbox.map(preflightOf);
  const idxScores = ctx.withScanIndex(() => st.prospects.map(scoreOf));
  const idxPreflight = ctx.withScanIndex(() => st.outbox.map(preflightOf));

  let bad = 0;
  for (let i = 0; i < rawScores.length; i += 1) {
    if (rawScores[i] !== idxScores[i]) {
      if (bad < 3) console.log(`  ✗ 质量分不一致 ${st.prospects[i].id}:` + String.fromCharCode(10) + `      扫表 ${rawScores[i]}` + String.fromCharCode(10) + `      索引 ${idxScores[i]}`);
      bad += 1;
    }
  }
  for (let i = 0; i < rawPreflight.length; i += 1) {
    if (rawPreflight[i] !== idxPreflight[i]) {
      if (bad < 3) console.log(`  ✗ 预检不一致 ${st.outbox[i].id}:` + String.fromCharCode(10) + `      扫表 ${rawPreflight[i]}` + String.fromCharCode(10) + `      索引 ${idxPreflight[i]}`);
      bad += 1;
    }
  }
  if (bad) {
    console.log(`  索引路径与扫表路径有 ${bad} 处结果不一致 —— 索引写错了，性能不用测了。`);
    process.exit(1);
  }
  console.log(`  ✓ 正确性：${rawScores.length} 条质量分 + ${rawPreflight.length} 封预检，索引与扫表逐条一致`);

  // 闸门自身也要验：如果造的数据压根没触发这些分支，上面那个"一致"是空的。
  // 之前就吃过这个亏——每条线索只有一封队列邮件，重复触达那条永远不触发。
  const joined = rawPreflight.join(" ") + rawScores.join(" ");
  const MUST_HIT = ["疑似重复触达", "客户已退订", "在退订黑名单", "客户已回复", "邮件/消息已打开", "已触达待响应"];
  const missed = MUST_HIT.filter((k) => !joined.includes(k));
  if (missed.length) {
    console.log(`  ✗ 这些分支一次都没触发，比对是空的：${missed.join("、")}`);
    process.exit(1);
  }
  console.log(`  ✓ 分支覆盖：${MUST_HIT.length} 条关键分支均已触发`);

  /* 发信队列：分页不能缩小「全选待审/待发」和批量发送的范围。

     这一条曾经是真的会错——勾选原本只存在 DOM 的复选框上，
     一分页就只能选到当前页；顺带还有个更隐蔽的毛病：每次 render()
     重建 innerHTML，勾好的选择会静默清零。搬进 state 后两条都堵住了，
     这里盯着别再回去。 */
  // 这项要用大一点的数据集：队列必须真的超过一页，否则比对是空的
  Object.assign(ctx.__bench.state, buildState(2000));
  ctx.withScanIndex(() => ctx.renderOutbox());
  const outHtml = String(ctx.__bench.elements?.outboxList?.innerHTML || "");
  const renderedRows = (outHtml.match(/class="outbox-item/g) || []).length;
  const cap = ctx.__bench.OUTBOX_PAGE_SIZE;
  const actionable = st.outbox.filter((o) => ["待审批", "待发送"].includes(o.status));

  if (renderedRows > cap) {
    console.log(`  ✗ 队列渲染了 ${renderedRows} 条，超过上限 ${cap}`);
    process.exit(1);
  }
  if (ctx.__bench.actionableOutboxIds.length !== actionable.length) {
    console.log(`  ✗ 全选口径 ${ctx.__bench.actionableOutboxIds.length} ≠ 全部待审/待发 ${actionable.length}`);
    process.exit(1);
  }
  if (renderedRows >= actionable.length) {
    console.log(`  ✗ 造的数据里队列没超过一页（${actionable.length} 封），这条比对是空的`);
    process.exit(1);
  }
  // 全选后，批量发送解析出来的条目必须包含没渲染出来的那些
  ctx.__bench.selectedOutbox.clear();
  ctx.__bench.actionableOutboxIds.forEach((id) => ctx.__bench.selectedOutbox.add(id));
  const resolved = ctx.activeOutboxItems().filter((o) => ctx.__bench.selectedOutbox.has(o.id));
  // 前缀 data-outbox-id=" 是 16 个字符——切错一位会让"已渲染"集合为空，
  // 于是下面的比对永远成立，守卫变成摆设。所以再核对一次数量对不对。
  const renderedIds = new Set([...outHtml.matchAll(/data-outbox-id="([^"]+)"/g)].map((m) => m[1]));
  if (!renderedIds.size) {
    console.log("  ✗ 从渲染结果里一个队列 id 都没抓到，这条比对是空的");
    process.exit(1);
  }
  const unrendered = resolved.filter((o) => !renderedIds.has(o.id)).length;
  if (resolved.length !== actionable.length || unrendered === 0) {
    console.log(`  ✗ 批量发送只解析出 ${resolved.length}/${actionable.length} 封，其中未渲染的 ${unrendered} 封 —— 分页把范围改小了`);
    process.exit(1);
  }
  ctx.__bench.selectedOutbox.clear();
  console.log(`  ✓ 队列口径：界面 ${renderedRows} 条，全选与批量发送覆盖全部 ${actionable.length} 封（含未渲染的 ${unrendered} 封）`);

  // 渲染结束必须把索引丢干净，否则下一次渲染会读到旧数据
  if (ctx.scanIndex() !== null) {
    console.log("  ✗ 渲染作用域退出后索引没清空 —— 会读到过期数据");
    process.exit(1);
  }
  console.log("  ✓ 生命周期：渲染作用域退出后索引已清空");
  console.log("");
}

const SIZES = [100, 500, 1000, 2000, 5000];
const results = [];

for (const n of SIZES) {
  const data = buildState(n);
  Object.assign(ctx.__bench.state, data);
  // 让筛选器回到「不筛」，量的是最大工作量
  ctx.__bench.state.selectedProspectId = null;

  const row = { n, outbox: data.outbox.length };

  // 桩里 select 的默认值是空串，而真实界面上是 "all"——不摆正的话
  // 筛选会把整池滤空，量到的是空态渲染（很快，但没意义）
  const el = ctx.__bench.elements;
  const setVal = (name, v) => { if (el?.[name]) el[name].value = v; };
  setVal("prospectFilter", "");
  setVal("statusFilter", "all");
  setVal("gradeFilter", "all");
  setVal("sourceFilter", "all");
  setVal("verifyFilter", "all");
  setVal("marketFilter", "all");
  setVal("prospectSort", "quality");

  // 每一项都量两遍：不带索引（即修复前的老路径，也是渲染之外的回退路径）
  // 和带索引（真实渲染时走的路径）。两个数并排摆着，退化了一眼能看出来。
  const scoreAll = () => { for (const p of ctx.__bench.state.prospects) ctx.computeLeadScore(p); };
  const preflightAll = () => { for (const o of ctx.__bench.state.outbox) ctx.preflightOutboxItem(o); };

  row.scoreRaw = timeIt(scoreAll);
  row.score = timeIt(() => ctx.withScanIndex(scoreAll));
  row.preflightRaw = timeIt(preflightAll);
  row.preflight = timeIt(() => ctx.withScanIndex(preflightAll));

  // 潜客页渲染。DOM 桩下很多分支会早退，那样量出来的"很快"是假的，
  // 所以跑完要核对**真的渲染出了行**，没渲染就如实报"未测"。
  const table = el?.prospectTable;
  row.render = null;
  try {
    ctx.withScanIndex(() => ctx.renderProspects());
    const html = String(table?.innerHTML || "");
    const rendered = (html.match(/data-prospect-id=/g) || []).length;
    const cap = ctx.__bench.PROSPECT_PAGE_SIZE;
    const expect = Math.min(n, cap);
    if (rendered !== expect) {
      row.renderNote = `渲染出 ${rendered} 行，应为 ${expect} 行（上限 ${cap}）`;
    } else {
      row.renderRaw = timeIt(() => ctx.renderProspects(), 200);
      row.render = timeIt(() => ctx.withScanIndex(() => ctx.renderProspects()), 200);
      row.rows = rendered;
      // 分页不能改变"全选"的口径：它一直是全部筛选结果，不是当前这一页
      const scope = ctx.visibleProspectIds ? ctx.visibleProspectIds().length : -1;
      if (scope !== n) row.renderNote = `全选口径 ${scope} ≠ 筛选结果 ${n} —— 分页把批量操作的范围改小了`;
    }
  } catch (error) {
    row.renderNote = error.message;
  }

  results.push(row);
  console.log(
    `  ${String(n).padStart(5)} 条线索 / ${String(row.outbox).padStart(4)} 封队列   ` +
      `质量分 ${fmt(row.scoreRaw).padStart(6)} → ${fmt(row.score).padStart(6)}ms   ` +
      `预检 ${fmt(row.preflightRaw).padStart(6)} → ${fmt(row.preflight).padStart(6)}ms   ` +
      `潜客页 ${row.render === null ? "未测" : fmt(row.renderRaw).padStart(6) + " → " + fmt(row.render).padStart(6) + "ms/" + row.rows + "行"}`
  );
  if (row.renderNote) {
    console.log("      ✗ " + row.renderNote);
    process.exitCode = 1;
  }
}

/* ---------------- 判读 ---------------- */

console.log("");

// 线性 vs 平方：数据量翻 5 倍（1000→5000），线性应该慢 5 倍左右，
// 平方会慢 25 倍。用这个比值判断，比盯绝对毫秒数可靠。
function growth(key, label) {
  const a = results.find((r) => r.n === 1000);
  const b = results.find((r) => r.n === 5000);
  if (!a || !b || a[key] == null || b[key] == null) return;
  const ratio = b[key] / a[key];
  // 5 倍数据量：≤8 倍算线性（留出常数项和缓存抖动的余量），≥15 倍明确是平方
  const verdict = ratio >= 15 ? "平方级 ✗" : ratio >= 8 ? "超线性 ⚠" : "线性 ✓";
  console.log(`  ${label}：数据 ×5 → 耗时 ×${ratio.toFixed(1)}   ${verdict}`);
  // 明确的平方级才阻断发版。超线性只告警——机器负载和 GC 抖动能把比值推到 8～10，
  // 拿它当红线会经常误杀；真的退化回逐条扫全表是 ×25 起，15 这条线不会被噪音够到。
  if (ratio >= 15) process.exitCode = 1;
}

growth("score", "质量分计算");
growth("preflight", "发信预检");
growth("render", "整页渲染");
// 左边那一列量的是**直接按名字调 renderProspects()** ——筛选框、排序、分页展开、
// 分析页时间范围走的都是这条路（不经过 render()）。它一度是没有索引的，
// 于是"改完还是卡"，而且卡在用户最常点的地方。现在渲染函数自带索引，这条也必须是线性。
growth("renderRaw", "潜客页直接调用（筛选/排序/分页走这条）");

console.log("");

// 卡顿门槛：一次渲染超过 100ms，用户能明确感到「按一下要等一下」；
// 超过 300ms 是肉眼可见的卡。取 2000 条作为「用了半年的老用户」基准。
const real = results.find((r) => r.n === 2000);
if (real && real.render != null) {
  const ms = real.render;
  if (ms >= 300) console.log(`  ⚠ 2000 条线索时整页渲染 ${fmt(ms)}ms —— 肉眼可见的卡顿，需要优化`);
  else if (ms >= 100) console.log(`  ⚠ 2000 条线索时整页渲染 ${fmt(ms)}ms —— 用户能感到延迟`);
  else console.log(`  ✓ 2000 条线索时整页渲染 ${fmt(ms)}ms —— 无感`);
  console.log("    （只算 JS，不含排版绘制；真机会更慢）");
}
