// 在 Node 里把整个 app.js 跑起来的共享沙箱
//
//   import { createAppSandbox } from "./app-sandbox.mjs";
//   const ctx = createAppSandbox();          // 抛异常表示桩缺了某个浏览器 API
//   ctx.__app.state / ctx.__app.elements / ctx.renderProspects() ...
//
// bench-scale.mjs（性能基准）和 test-error-paths.mjs（错误路径）都用它。
// 抽出来是因为两份各自维护的桩一定会漂移——一边补了 API 另一边没补，
// 表现是其中一个莫名其妙加载失败，而且很难看出是桩的问题还是产品代码的问题。
//
// 桩的目标不是仿真浏览器，只要让 app.js 能整个加载起来、渲染函数能跑完。
// innerHTML 当普通属性存着：拼字符串的开销和产出是真的，排版不算。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createAppSandbox({ quiet = true } = {}) {
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
      parentNode: null,
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      // showToast 会 firstChild.remove() 裁剪队列，缺了它会抛
      get firstChild() { return this.children[0] || null; },
      get lastChild() { return this.children[this.children.length - 1] || null; },
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
      // remove() 必须真的从父节点摘掉：showToast 里
      // `while (children.length > 3) firstChild.remove()` 靠它收敛，
      // 空实现会死循环（第一版就是这么挂住的）。
      remove() {
        const p = this.parentNode;
        if (!p) return;
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
        this.parentNode = null;
      },
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
    console: quiet ? { log() {}, warn() {}, error() {}, info() {} } : console,
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
      `globalThis.__app = {
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
    // 不在这里 process.exit：调用方各有各的报错格式，让它自己决定怎么呈现。
    const err = new Error("app.js 在 DOM 桩下加载失败：" + String(loadError.message));
    err.stack = loadError.stack;
    err.isSandboxLoadError = true; // 桩缺 API，不是产品代码的问题
    throw err;
  }

  return ctx;
}

// 界面上筛选下拉的默认值是 "all"，桩里是空串。不摆正的话筛选会把整池滤空，
// 于是量到 / 测到的都是空态——这个坑在两个套件里各踩过一次。
export function applyDefaultFilters(ctx) {
  const el = ctx.__app.elements;
  const set = (name, v) => {
    if (el?.[name]) el[name].value = v;
  };
  set("prospectFilter", "");
  ["statusFilter", "gradeFilter", "sourceFilter", "verifyFilter", "marketFilter"].forEach((k) => set(k, "all"));
  set("prospectSort", "quality");
}
