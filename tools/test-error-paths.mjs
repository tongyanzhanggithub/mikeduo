// 错误路径回归
//
//   node tools/test-error-paths.mjs
//
// 别的套件测的都是"东西好用的时候对不对"。这一套测的是**东西坏掉的时候**：
// 数据集文件丢了、AI 返回一堆乱码、备份文件损坏、网站打不开、localStorage 花了。
//
// 判据只有一条，也是这个产品的立身之本：
//
//     失败绝不能被伪装成结论。
//
// 「名单读不出来」必须说成"没查成"，不能说成"不在名单上"；
// 「网站打不开」必须说成"没查成"，不能说成"对方没公示联系方式"。
// 这类 bug 不会崩、不会报错、测试也全绿——它只是让用户拿着一个
// 根本没执行过的检查去做决定。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { createRequire } from "node:module";
import { createAppSandbox } from "./app-sandbox.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const fails = [];
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fails.push(`${name}：${error.message}`);
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
};
const asyncCheck = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fails.push(`${name}：${error.message}`);
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log("错误路径 回归");

/* ================= ① 本地数据集读不出来 =================
   打包漏了 data/、文件损坏、磁盘故障——三个数据集都要**明确失败**，
   绝不能返回一个"查了、没结果"的空壳。合规名单尤其致命：
   用户看到"不在名单上"就发货了。 */

console.log("\n① 数据集损坏时必须明确失败，不能返回空结果");

/* 在 vm 里加载 electron 模块，只把 fs 换成假的，其余（zlib / path / dataset-age）
   全用真货。

   第一版这里把 zlib 和 path 也一起假造了，而且只认 require("fs")——但模块写的是
   require("node:fs")，于是三个依赖全部拿到空对象，模块每次都因为"桩缺东西"抛异常，
   测试就一直是绿的。**测的是桩，不是产品代码。**
   下面 loadsWithGoodData 那条就是防这个的：喂正确数据必须能跑通，
   否则说明这套加载方式本身是坏的，上面那些"抛错了✓"一个都不算数。 */
const nodeRequire = createRequire(import.meta.url);

function loadElectronModule(relPath, fakeFile) {
  const source = readFileSync(join(root, relPath), "utf8");
  const fakeFs = {
    readFileSync: () => {
      if (fakeFile === null) {
        const e = new Error("ENOENT: no such file or directory");
        e.code = "ENOENT";
        throw e;
      }
      return fakeFile;
    },
    existsSync: () => fakeFile !== null,
    statSync: () => ({ mtime: new Date(), size: fakeFile ? fakeFile.length : 0 })
  };
  const sandbox = {
    require: (name) => {
      if (name === "fs" || name === "node:fs") return fakeFs;
      if (name.startsWith(".")) return nodeRequire(join(root, dirname(relPath), name));
      return nodeRequire(name);
    },
    module: { exports: {} },
    __dirname: join(root, dirname(relPath)),
    console,
    Buffer,
    Date,
    Math,
    JSON,
    Map,
    Set,
    process
  };
  sandbox.exports = sandbox.module.exports;
  const ctx0 = createContext(sandbox);
  runInContext(source, ctx0, { filename: relPath });
  return ctx0.module.exports;
}

// 用真实的 data/ 文件内容喂进去，确认这套加载方式本身是通的
check("加载方式自检：喂正确数据时模块能正常工作（否则下面全是假绿）", () => {
  const good = readFileSync(join(root, "data", "screening.json.gz"));
  const mod = loadElectronModule("electron/screening.js", good);
  const out = mod.screen("ACME TRADING LLC");
  assert(out && out.ok === true, `喂正确数据却没跑通：${JSON.stringify(out)}`);
  assert(typeof out.count === "number" && out.count > 1000, `名单条数不对：${out.count}`);
});

for (const [label, rel, entry, arg] of [
  ["合规名单", "electron/screening.js", "screen", "ACME TRADING LLC"],
  ["HS 编码目录", "electron/hscode.js", null, null],
  ["采购官库", "electron/tenders.js", null, null]
]) {
  check(`${label}：文件不存在 → 抛错，不返回空结果`, () => {
    const mod = loadElectronModule(rel, null);
    const fn = entry ? mod[entry] : mod[Object.keys(mod).find((k) => typeof mod[k] === "function")];
    assert(typeof fn === "function", `${rel} 没有可调用的入口`);
    let threw = false;
    let result;
    try {
      result = fn(arg);
    } catch {
      threw = true;
    }
    assert(threw, `文件不存在却没抛错，返回了 ${JSON.stringify(result)}——上层会把它当成"查过了"`);
  });

  check(`${label}：文件损坏（不是 gzip）→ 抛错`, () => {
    const mod = loadElectronModule(rel, Buffer.from("这不是 gzip 内容"));
    const fn = entry ? mod[entry] : mod[Object.keys(mod).find((k) => typeof mod[k] === "function")];
    let threw = false;
    try {
      fn(arg);
    } catch {
      threw = true;
    }
    assert(threw, "损坏的文件没有让它失败");
  });
}

/* ================= ② 主进程的 IPC 包装必须把失败传出去 ================= */

console.log("\n② 主进程 IPC：数据集报错时返回 ok:false，而不是空结果");

check("main.js 里三个数据集的 handler 都 catch 并返回 ok:false", () => {
  const main = readFileSync(join(root, "main.js"), "utf8");
  for (const channel of ["mkd:screen-entity", "mkd:hs-lookup", "mkd:tenders-search"]) {
    const i = main.indexOf(channel);
    if (i < 0) continue; // 通道名可能改过，交给走查工具的 IPC 三方检查
    const block = main.slice(i, i + 900);
    assert(/catch/.test(block), `${channel} 没有 catch——数据集报错会直接把调用打断，界面上什么都看不到`);
    assert(/ok:\s*false/.test(block), `${channel} 的 catch 没有返回 ok:false，渲染层分不出"没查成"和"没命中"`);
  }
});

/* ================= ③ 批量操作：失败必须出现在汇总里 =================
   这是最容易漏的一层。单条调用往往处理得很好（会记一条"没查过"的日志），
   但批量调用为了不刷屏会传 quiet=true 把日志压掉，然后照常报
   "查了 N 家、0 命中"——单条正确，批量说谎。 */

console.log("\n③ 批量操作：底层全失败时，汇总不能说成'都没问题'");

const ctx = createAppSandbox();
const app = ctx.__app;

function resetState(prospects) {
  Object.assign(app.state, {
    prospects,
    outbox: [],
    inbound: [],
    whatsappQueue: [],
    logs: [],
    blacklist: []
  });
}
const logText = () => (app.state.logs || []).map((l) => l.message).join(" || ");

const THREE = () => [
  { id: "a", company: "Acme Trading LLC", market: "United States", status: "新线索", email: "a@a.com", website: "https://a.com" },
  { id: "b", company: "Global Nozzle Co", market: "Germany", status: "新线索", email: "", website: "https://b.com" },
  { id: "c", company: "Desert Drone FZE", market: "UAE", status: "新线索", email: "", website: "https://c.com" }
];

await asyncCheck("合规筛查：名单读不出来时，不能报'都不在名单上'", async () => {
  resetState(THREE());
  ctx.window.mkd = { screenEntity: async () => ({ ok: false, reason: "ENOENT: data/screening.json.gz 不存在" }) };
  await ctx.batchScreenProspects(["a", "b", "c"]);
  const text = logText();

  assert(text.length > 0, "一条日志都没有——用户完全不知道发生了什么");
  assert(
    !/都不在名单上/.test(text) && !/精确命中 0 家、疑似 0 家/.test(text),
    `把"没查成"报成了"没命中"：${text}`
  );
  assert(/没有查过|没查成|读取失败/.test(text), `没有说清楚这批公司其实没查过：${text}`);
  // 更硬的一条：绝不能给没查成的线索写上 screening 字段，
  // 否则界面上会显示成"已筛查、未命中"
  assert(
    app.state.prospects.every((p) => !p.screening),
    "给没查成的线索写了 screening 字段，界面会显示成已筛查"
  );
});

await asyncCheck("合规筛查：一半失败时，汇总要说清查成了几家", async () => {
  resetState(THREE());
  let n = 0;
  ctx.window.mkd = {
    screenEntity: async () => {
      n += 1;
      return n === 1 ? { ok: true, hit: false, builtAt: "2026-08-01", count: 40030 } : { ok: false, reason: "读盘失败" };
    }
  };
  await ctx.batchScreenProspects(["a", "b", "c"]);
  const text = logText();
  assert(/2 家/.test(text), `没有报出失败家数：${text}`);
  assert(/没有查过|没查成/.test(text), `没有说清楚哪些没查过：${text}`);
});

await asyncCheck("官网抓取：站点打不开时，不能报'对方没公示联系方式'", async () => {
  resetState(THREE());
  ctx.window.mkd = { siteHarvest: async () => ({ ok: false, reason: "ETIMEDOUT" }) };
  await ctx.batchHarvestSites(["a", "b", "c"]);
  const text = logText();
  assert(text.length > 0, "一条日志都没有");
  assert(
    !/既没有公示邮箱，也没有号码/.test(text),
    `把"打不开"报成了"对方没公示"：${text}`
  );
  assert(/打不开|没有查成|没查成/.test(text), `没有说清楚是我们没查成：${text}`);
});

/* ================= ④ 外部输入损坏 ================= */

console.log("\n④ 损坏的输入不能让程序崩、也不能被当成有效数据");

check("AI 返回的不是 JSON → 抽取器返回 null，不抛不编", () => {
  const bad = ["", "抱歉，我无法完成这个请求。", "{ 这不是 JSON", "[1,2,", "null", "<html>502 Bad Gateway</html>"];
  for (const text of bad) {
    let out;
    let threw = false;
    try {
      out = ctx.extractJsonObject(text);
    } catch {
      threw = true;
    }
    assert(!threw, `extractJsonObject 在输入 ${JSON.stringify(text.slice(0, 20))} 时抛异常了`);
    assert(out === null || typeof out === "object", `返回了意料之外的值：${JSON.stringify(out)}`);
  }
});

check("AI 把 JSON 包在解释文字/代码围栏里 → 仍能抽出来", () => {
  const wrapped = '好的，结果如下：\n```json\n{"company":"Acme"}\n```\n希望有帮助。';
  const out = ctx.extractJsonObject(wrapped);
  assert(out && out.company === "Acme", `围栏包裹的 JSON 没抽出来：${JSON.stringify(out)}`);
});

check("AI 返回的数组被截断 → 能救几条算几条，救不出就返回 null", () => {
  const fn = ctx.extractJsonArray || ctx.extractProspectArray;
  if (typeof fn !== "function") return; // 函数名变了就跳过，由走查工具的死代码检查兜底
  const truncated = '[{"company":"Acme","website":"acme.com"},{"company":"Beta","webs';
  const out = fn(truncated);
  assert(out === null || Array.isArray(out), `返回了非数组非 null：${JSON.stringify(out)}`);
  if (Array.isArray(out)) assert(out.every((x) => x && typeof x === "object"), "救出来的元素不是对象");
});

check("备份文件损坏 → normalizeStoredState 不崩，且不产出半个 state", () => {
  const bad = [null, undefined, {}, { campaign: null }, { prospects: "不是数组" }, { prospects: [null, 1, "x"] }];
  for (const input of bad) {
    let out;
    let threw = false;
    try {
      out = ctx.normalizeStoredState(input);
    } catch {
      threw = true;
    }
    assert(!threw, `normalizeStoredState 在 ${JSON.stringify(input)} 上抛异常了`);
    assert(out && typeof out === "object", "没有返回可用的 state");
    assert(Array.isArray(out.prospects), `prospects 不是数组：${JSON.stringify(out.prospects)}`);
    assert(Array.isArray(out.outbox), "outbox 不是数组");
    assert(out.campaign && typeof out.campaign === "object", "campaign 缺失");
  }
});

check("localStorage 里的存档花了 → 回落到全新 state，不是白屏", () => {
  const store = new Map();
  const key = Object.keys(ctx).includes("STORAGE_KEY") ? ctx.STORAGE_KEY : "foreign-trade-automation-v2";
  for (const junk of ["{坏掉的 JSON", "", "null", "[]", '{"prospects":123}']) {
    store.set(key, junk);
    ctx.window.localStorage.getItem = (k) => (store.has(k) ? store.get(k) : null);
    let out;
    let threw = false;
    try {
      out = ctx.loadState ? ctx.loadState() : ctx.normalizeStoredState(JSON.parse(junk || "null"));
    } catch (error) {
      // JSON.parse 在测试侧抛不算产品问题，只有 loadState 自己抛才算
      if (ctx.loadState) threw = true;
    }
    assert(!threw, `存档内容 ${JSON.stringify(junk)} 让 loadState 抛异常了——用户会看到白屏`);
    if (out) assert(Array.isArray(out.prospects), "回落出来的 state 不可用");
  }
});

/* ================= ⑤ 打包完整性 =================
   上面①测的是"文件坏了会不会明确失败"，这里测"文件到底会不会被打进包里"。
   data/ 漏进 build.files 是这个项目真实发生过的事故。 */

console.log("\n⑤ 打包必须带上数据集（漏过一次）");

check("package.json 的 build.files 覆盖 data/ 和 docs/", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = (pkg.build?.files || []).join(" ");
  assert(/(^|\s|")data\//.test(files) || /data\*\*/.test(files), `build.files 没带 data/：${files}`);
  assert(/(^|\s|")docs\//.test(files) || /docs\*\*/.test(files), `build.files 没带 docs/：${files}`);
});

check("三个数据集文件确实存在且能解压", () => {
  for (const name of ["screening.json.gz", "hscodes.json.gz", "tenders.json.gz"]) {
    const file = join(root, "data", name);
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      throw new Error(`${name} 不存在——打出来的包会在合规筛查/HS 校验时直接报错`);
    }
    assert(buf.length > 1024, `${name} 只有 ${buf.length} 字节，像是生成失败的空壳`);
    assert(buf[0] === 0x1f && buf[1] === 0x8b, `${name} 不是 gzip（魔数不对）`);
  }
});

/* ================= 收尾 ================= */

console.log("");
if (fails.length) {
  console.log(`${fails.length} 项失败：`);
  fails.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
console.log(`${passed} 项全部通过`);
