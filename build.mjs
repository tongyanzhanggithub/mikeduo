// 构建脚本：把 src/ 下的模块按文件名顺序拼成单文件 app.js，并自动打「版本戳」防缓存。
//
// 为什么用拼接而不是 ES 模块 / 多个 <script>：
//   整个应用共享一个全局作用域，很多顶层代码（如 VIEW_RENDERERS、初始化调用）
//   依赖“同一脚本内函数声明整体提升”。拆成多个 <script> 会打断跨文件提升导致报错；
//   ES 模块又要给每个函数加 export/import，改动巨大。直接按顺序拼接可保持原有运行语义。
//
// 版本戳：以 app.js 内容算一个 8 位哈希 V，同步写入三处，保证浏览器每次都能拿到最新版：
//   ① app.js 里的 window.__APP_V = "V"
//   ② index.html 的 app.js?v=V / styles.css?v=V
//   ③ index.html 的缓存哨兵 window.__APP_V !== "V"
//
// 用法：改完 src/*.js 后运行 `node build.mjs`（或 `npm run build`）。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, "src");

const files = readdirSync(srcDir)
  .filter((f) => f.endsWith(".js"))
  .sort(); // 00-、01- 前缀保证顺序

const parts = files.map((f) => readFileSync(join(srcDir, f), "utf8"));
// 用换行拼接：切分时边界正好落在模块之间的行边界上，join("\n") 可精确还原
const joined = parts.join("\n");

// 先把版本行归一化再算哈希，保证哈希只随“真实代码”变化（不被版本号本身影响）
const VER_RE = /window\.__APP_V\s*=\s*"[^"]*";/;
const normalized = joined.replace(VER_RE, 'window.__APP_V = "__V__";');
// Include CSS in the cache key so visual-only changes refresh reliably.
const styles = readFileSync(join(root, "styles.css"), "utf8");

// 算哈希前统一行尾。git 在 Windows 上 checkout 会把 LF 换成 CRLF，
// 同一份代码在两台机器上会算出不同的版本戳，导致 app.js / index.html
// 一构建就变脏、永远和仓库对不上。换机开发时这个问题每次都会撞上。
const eol = (s) => s.replace(/\r\n/g, "\n");

const versionHash = createHash("sha1");
versionHash.update(eol(normalized));
versionHash.update("\n/* styles.css */\n");
versionHash.update(eol(styles));
versionHash.update("\n/* brand assets */\n");
// SVG 是文本，同样要归一化行尾：.gitattributes 里没给 *.svg 定死 eol，
// autocrlf=true 的机器 checkout 出来是 CRLF、别的机器是 LF，
// 按原始字节喂进哈希就会两台机器算出不同版本戳（正是这次撞上的）。
["logo-mark.svg", "logo-lockup.svg"].forEach((file) => {
  versionHash.update(eol(readFileSync(join(root, file), "utf8")));
});
// PNG 是二进制，git 不会动它，按原样喂
versionHash.update(readFileSync(join(root, "favicon.png")));
const version = versionHash.digest("hex").slice(0, 8);
const out = normalized.replace('window.__APP_V = "__V__";', `window.__APP_V = "${version}";`);
writeFileSync(join(root, "app.js"), out);

// 把版本戳同步进 index.html（资源查询串 + 缓存哨兵）
const indexPath = join(root, "index.html");
let html = readFileSync(indexPath, "utf8");
html = html
  .replace(/app\.js\?v=[^"']*/g, `app.js?v=${version}`)
  .replace(/styles\.css\?v=[^"']*/g, `styles.css?v=${version}`)
  .replace(/favicon\.png(?:\?v=[^"']*)?/g, `favicon.png?v=${version}`)
  .replace(/window\.__APP_V !== "[^"]*"/g, `window.__APP_V !== "${version}"`);
writeFileSync(indexPath, html);

console.log(`已从 ${files.length} 个模块生成 app.js（${out.length} 字节），版本戳 v=${version}`);
files.forEach((f) => console.log("  - src/" + f));
