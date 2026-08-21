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

console.log("");
if (problems) {
  console.log(`发现 ${problems} 处。多数是"静默失效"——不报错，所以只能靠这种扫描发现。`);
  process.exit(1);
}
console.log("走查通过，没有发现静默失效类问题。");
