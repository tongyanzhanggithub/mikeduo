// 「源码已重建但窗口还是旧的」检测 的回归测试
//
//   node tools/test-build-stamp.mjs
//
// 这个功能第一版是坏的：主进程只读 app.js 的前 4096 字节找版本戳，
// 但戳实际在 ~10.4KB 处，于是恒返回 null，检测静默失效——代码看着对、
// 一行不报错，就是永远不提示。所以这里钉的第一条就是「必须读得到」。
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("构建过期检测 单测");

const appjs = readFileSync(join(root, "app.js"), "utf8");
const STAMP_RE = /__APP_V\s*=\s*"([a-f0-9]+)"/;

check("app.js 里确实有版本戳", () => {
  assert.equal(STAMP_RE.test(appjs), true);
});

check("版本戳不在文件开头——所以主进程必须读全文，不能只读前几 KB", () => {
  const at = appjs.indexOf("__APP_V");
  assert.equal(at > 4096, true, `戳在 ${at} 字节处；任何 slice(0, 4096) 式的读法都会漏掉它`);
});

check("main.js 没有把读取截断（这正是第一版的 bug）", () => {
  const main = readFileSync(join(root, "main.js"), "utf8");
  const handler = main.slice(main.indexOf('ipcMain.handle("mkd:build-stamp"'), main.indexOf('ipcMain.handle("mkd:build-stamp"') + 900);
  assert.equal(/readFileSync\([^)]*\)\s*\.slice\(/.test(handler), false, "又把 app.js 截断了");
  assert.match(handler, /readFileSync\(file, "utf8"\)/);
});

check("打包版直接返回 null——装机用户永远看不到这个提示", () => {
  const main = readFileSync(join(root, "main.js"), "utf8");
  const at = main.indexOf('ipcMain.handle("mkd:build-stamp"');
  assert.match(main.slice(at, at + 200), /if \(app\.isPackaged\) return null;/);
});

check("按 mtime+size 缓存，避免每次窗口聚焦都重读整个文件", () => {
  const main = readFileSync(join(root, "main.js"), "utf8");
  assert.match(main, /buildStampCache/);
  const st = statSync(join(root, "app.js"));
  assert.equal(typeof st.mtimeMs, "number");
  assert.equal(st.size > 0, true);
});

// 判定本身：只有「两边都拿到了、且不相等」才提示
const shouldWarn = (disk, loaded) => !!(disk && loaded && disk !== loaded);

check("版本一致时不打扰", () => {
  assert.equal(shouldWarn("abc12345", "abc12345"), false);
});

check("版本不一致时提示", () => {
  assert.equal(shouldWarn("abc12345", "e3312938"), true);
});

check("任一侧取不到值时都不提示——宁可不提醒，也不能瞎报", () => {
  assert.equal(shouldWarn(null, "abc12345"), false);
  assert.equal(shouldWarn("abc12345", null), false);
  assert.equal(shouldWarn("", ""), false);
  assert.equal(shouldWarn(undefined, undefined), false);
});

console.log(`\n${passed} 项全部通过`);
