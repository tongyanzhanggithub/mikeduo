// 代码库系统性走查
//
//   node tools/audit.mjs
//
// 查的都是**静默失效**类的问题——不报错、看着对、就是不工作：
//   ① 同名函数被定义多次（拼接构建里后者覆盖前者，没有任何提示）
//   ② 「包一层」包错了名字（typeof 判断为假，整层静默跳过）
//   ③ 定义了却从没被调用的函数（功能做了一半的典型信号）
//   ④ elements.xxx 指向不存在的 DOM id
//   ⑤ data-mkd-* 属性与处理器不配对
//   ⑥ IPC 三方（preload / main / 渲染层）对不上
//   ⑦ 线索字段写了没人读
//
// 首次跑出来的四个真问题，都属于"功能做了一半"：
//   · screeningPanelHtml 写好了从没挂载 —— 合规命中详情永远看不到
//   · sequencePausedReason 只写不读 —— 序列悄悄停了，用户不知道为什么
//   · renderCommerceChrome 没有 try —— 它一抛错，后面九个面板全不渲染
//   · 电话出处只写不读 —— 邮箱能溯源、电话不能，口径不一致
//
// 退出码：发现问题为 1，干净为 0。
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 控制字符一律用 fromCharCode：这个项目已经被转义序列坑过六次，
// 其中一次就是写这个走查工具的时候。
const NL = String.fromCharCode(10);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const all = readdirSync(srcDir).filter((f) => f.endsWith(".js")).sort()
  .map((f) => ({ f, t: readFileSync(join(srcDir, f), "utf8") }));
const whole = all.map((x) => x.t).join(NL);

// 不用正则数出现次数：前后字符不能是标识符字符。
// 用正则要拼转义，而这个项目已经被转义序列坑过五次。
const WORD = /[A-Za-z0-9_$]/;
function count(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    if (!WORD.test(hay[i - 1] || " ") && !WORD.test(hay[i + needle.length] || " ")) n += 1;
    i = hay.indexOf(needle, i + 1);
  }
  return n;
}

let problems = 0;
const section = (title) => console.log(NL + "=".repeat(66) + NL + title + NL + "=".repeat(66));
const bad = (msg) => { console.log("  ✗ " + msg); problems += 1; };
const ok = (msg) => console.log("  ✓ " + msg);

/* ---------------------------------------------------------------- */
const defs = new Map();
all.forEach(({ f, t }) => {
  for (const m of t.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    if (!defs.has(m[1])) defs.set(m[1], []);
    defs.get(m[1]).push(f);
  }
});

section("① 同名函数被定义多次");
let n1 = 0;
for (const [name, fs] of defs) if (fs.length > 1) { bad(`${name} 定义于 ${fs.join(" , ")}`); n1 += 1; }
if (!n1) ok(`${defs.size} 个函数，无重名`);

section("② 「包一层」的目标是否存在");
let n2 = 0;
all.forEach(({ f, t }) => {
  for (const m of t.matchAll(/if\s*\(typeof\s+([A-Za-z_$][\w$]*)\s*===\s*"function"\)/g)) {
    if (!defs.has(m[1])) { bad(`${f}: 包装 ${m[1]}，但没有这个函数`); n2 += 1; }
  }
});
if (!n2) ok("全部命中真实目标");

section("③ 定义了却从没被调用的函数");
let n3 = 0;
for (const [name, fs] of defs) if (count(whole, name) <= 1) { bad(`${name} (${fs[0]})`); n3 += 1; }
if (!n3) ok("无死代码");

section("④ elements.xxx 指向的 DOM id");
const ids = new Set([...readFileSync(join(root, "index.html"), "utf8").matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
let n4 = 0;
for (const m of (all.find((x) => x.f === "00-core.js") || { t: "" }).t.matchAll(/^\s*([\w$]+):\s*\$\("#([^"]+)"\)/gm)) {
  if (!ids.has(m[2])) { bad(`elements.${m[1]} → #${m[2]} 不存在`); n4 += 1; }
}
if (!n4) ok("全部存在");

section("⑤ IPC 三方是否对得上");
const preload = readFileSync(join(root, "preload.js"), "utf8");
const mainjs = readFileSync(join(root, "main.js"), "utf8");
const exposed = new Set([...preload.matchAll(/invoke\("([^"]+)"/g)].map((m) => m[1]));
const handled = new Set([...mainjs.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((m) => m[1]));
let n5 = 0;
for (const c of exposed) if (!handled.has(c)) { bad(`preload 调用 ${c}，main 没有 handler`); n5 += 1; }
for (const c of handled) if (!exposed.has(c)) { bad(`main 注册 ${c}，preload 没暴露`); n5 += 1; }
if (!n5) ok(`${exposed.size} 个通道两侧一致`);

section("⑥ 线索字段写了没人读（功能做一半的信号）");
const written = new Set();
for (const m of whole.matchAll(/(?:next|prospect|p2?)\.([a-z][A-Za-z0-9]{3,})\s*=[^=]/g)) written.add(m[1]);
const halfDone = [...written].filter((f) => count(whole, f) <= 1);
if (!halfDone.length) ok("无");
halfDone.forEach((f) => bad(`.${f} 只被写入，从没被读取`));

/* ---------------------------------------------------------------- */
section("⑦ 源码里的控制字符（转义序列被吃掉的痕迹）");

// 这一条是被自己坑出来的：/\b/ 之类的转义在经过代码生成时会变成
// 控制字符 U+0008，正则从此永远匹配不上、也不报错。本项目栽过六次，
// 其中一次就是写这个走查工具本身。
const CTRL_DIRS = [["src", srcDir], ["electron", join(root, "electron")], ["tools", join(root, "tools")]];
let n7 = 0;
for (const [label, dir] of CTRL_DIRS) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js") || x.endsWith(".mjs"))) {
    const txt = readFileSync(join(dir, f), "utf8");
    txt.split(NL).forEach((line, idx) => {
      for (const ch of line) {
        const c = ch.charCodeAt(0);
        if (c < 9 || (c > 13 && c < 32)) {
          bad(`${label}/${f}:${idx + 1} 出现控制字符 0x${c.toString(16)}`);
          n7 += 1;
          return;
        }
      }
    });
  }
}
if (!n7) ok("无");

section("⑧ admitProspects 之后必须同步写回 state.prospects");

// 这是个真不变量，而且很容易被后来的人破坏：
// admitProspects 内部会触发入池体检（抓官网核实公司是否存在 + 合规筛查），
// 那段是 fire-and-forget 的微任务。它依赖调用方在**同一个同步块里**把线索
// 写进 state.prospects——中间插一个 await，微任务就会先跑，
// 那时线索还不在池子里，体检什么都找不到，而且不报任何错。
let n8 = 0;
for (const { f, t } of all) {
  const lines = t.split(NL);
  lines.forEach((l, i) => {
    if (!l.includes("admitProspects(") || l.includes("function admitProspects")) return;
    const after = lines.slice(i, i + 6).join(NL);
    const assignAt = after.indexOf("state.prospects");
    if (assignAt === -1) return; // 没写回：可能是别的用法，交给人看
    if (after.slice(0, assignAt).includes("await ")) {
      bad(`${f}:${i + 1} admitProspects 与写回之间夹了 await，入池体检会落空`);
      n8 += 1;
    }
  });
}
if (!n8) ok("全部同步写回");

section("⑨ 主进程会抛的 IPC × 渲染层不接");

/* 危险的是**组合**，不是单独一边：

   ipcMain.handle 里做裸的文件 / 对话框 I/O（磁盘满、权限、杀软锁文件都会抛），
   而渲染层那边 `await bridge.xxx()` 又没有 try/catch —— 抛出去被全局
   unhandledrejection 兜住只记进诊断日志，界面上**什么都不发生**。
   用户点了按钮，没反应，也没有任何解释。

   真实撞到的三处：
     · backup-write  —— 恢复备份前那份"保险备份"写不成，恢复静默中止，
                        而弹窗上明写着"覆盖前会自动另存一份"，用户以为已经恢复了
     · save-text     —— 导出诊断包失败，失败信息记进了……没导出成的那个诊断日志
     · backup-list   —— 备份目录读不出来，界面显示"还没有自动备份"（备份明明在）

   网络类的处理器全都包在 throttled() 里、异常统一兜成 { ok:false }，所以不在此列。 */

const mainSrc = readFileSync(join(root, "main.js"), "utf8");
const preloadSrc = readFileSync(join(root, "preload.js"), "utf8");

// 通道名 → 渲染层方法名
const channelToMethod = new Map();
for (const m of preloadSrc.matchAll(/(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*"([^"]+)"/g)) {
  channelToMethod.set(m[2], m[1]);
}

// main.js 里每个 handler 的正文
const mainLines = mainSrc.split(NL);
const handlerStarts = [];
mainLines.forEach((l, i) => {
  const m = l.match(/ipcMain\.handle\(\s*"([^"]+)"/);
  if (m) handlerStarts.push({ i, channel: m[1] });
});

const RISKY_IO = /(^|[^\w.])fs\.(write|read|readdir|stat|unlink|rm|append|copy|rename)\w*Sync|(^|[^\w.])dialog\.show/m;
const throwing = new Set();
handlerStarts.forEach((h, k) => {
  const end = k + 1 < handlerStarts.length ? handlerStarts[k + 1].i : mainLines.length;
  /* 逐行判 try 深度，而不是"body 里有没有 try"。

     第一版就是后者，结果在**最要紧的那个**上漏报：mkd:backup-write 的正文里确实有
     一个 try，但它只包着"滚动删除旧备份"那几行，真正关键的 fs.writeFileSync
     在它外面。粗判会把整个处理器当成安全的。 */
  let depth = 0;
  for (let i = h.i; i < end; i += 1) {
    const line = mainLines[i];
    const st = line.trim();
    if (/(^|[^\w])try[\s{]/.test(st)) depth += 1;
    if (depth > 0 && /^\}/.test(st) && !/catch|finally/.test(st)) {
      // try/catch 结束（catch/finally 行不算收尾）
    }
    if (/^\}\s*(catch|finally)/.test(st)) depth = Math.max(0, depth - 1);
    if (depth === 0 && RISKY_IO.test(line)) {
      throwing.add(h.channel);
      break;
    }
  }
});

// 渲染层：await bridge.x() / window.mkd.x() 在不在 try 里
const rendererUnguarded = new Map(); // method -> [位置]
for (const { f, t } of all) {
  const lines = t.split(NL);
  const tryStack = [];
  lines.forEach((l, i) => {
    const st = l.trim();
    const ind = l.length - l.trimStart().length;
    if (/^try\s*\{/.test(st)) tryStack.push(ind);
    if (/^\}\s*catch/.test(st)) tryStack.pop();
    const m = l.match(/await\s+(?:bridge|window\.mkd|mkd)\??\.(\w+)\s*\(/);
    if (!m) return;
    if (tryStack.length || l.includes(".catch(")) return;
    if (!rendererUnguarded.has(m[1])) rendererUnguarded.set(m[1], []);
    rendererUnguarded.get(m[1]).push(`${f}:${i + 1}`);
  });
}

let n9 = 0;
for (const channel of throwing) {
  const method = channelToMethod.get(channel);
  if (!method) continue;
  const spots = rendererUnguarded.get(method);
  if (!spots) continue;
  spots.forEach((where) => {
    bad(`${where} ${method}() 没有 try/catch，而主进程 ${channel} 会抛（裸的文件/对话框 I/O）——失败时界面上什么都不会发生`);
    n9 += 1;
  });
}
if (!n9) ok(`会抛的通道 ${throwing.size} 个，渲染层都接住了`);

console.log("");
if (problems) {
  console.log(`发现 ${problems} 处。多数是"静默失效"——不报错，所以只能靠这种扫描发现。`);
  process.exit(1);
}
console.log("走查通过，没有发现静默失效类问题。");
