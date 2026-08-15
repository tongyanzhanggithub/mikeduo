/* 更新源闸门的回归测试。
   这一条守的不是功能而是安装通道：占位符 owner 一旦被人在 GitHub 上抢注，
   它就成了所有已装机器的更新源。所以判定必须是不对称的——拿不准一律当
   「没配好」，宁可不检查更新。 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { updateFeedReady, _internals } = require(join(here, "..", "electron", "update-feed.js"));
const { feedReady, ownerFromYml } = _internals;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("更新源闸门");

check("当前打出来的包就是占位符，必须拦住", () => {
  assert.equal(feedReady("owner: REPLACE_ME\nrepo: mikeduo-release\nprovider: github\n"), false);
});

check("大小写与其它常见占位写法都拦得住", () => {
  ["replace_me", "REPLACE_ME_NOW", "YOUR_ORG", "your-github-name", "CHANGE_ME", "changeme", "TODO", "xxx"].forEach(
    (owner) => assert.equal(feedReady(`owner: ${owner}\n`), false, owner)
  );
});

check("owner 缺失、为空、整份文件读不出来，一律当没配", () => {
  assert.equal(feedReady("repo: mikeduo-release\nprovider: github\n"), false);
  assert.equal(feedReady("owner:\n"), false);
  assert.equal(feedReady("owner:    \n"), false);
  assert.equal(feedReady(""), false);
  assert.equal(feedReady(null), false);
});

check("配成真实账号后闸门自动打开（带不带引号都认）", () => {
  assert.equal(feedReady("owner: aarontong\nrepo: mikeduo-release\n"), true);
  assert.equal(feedReady('owner: "aaron-tong"\n'), true);
  assert.equal(feedReady("owner: 'mikeduo-official'\n"), true);
});

check("只锚定开头，不误伤含 todo/xxx 的正常账号名", () => {
  assert.equal(feedReady("owner: mytodolist\n"), true);
  assert.equal(feedReady("owner: axxxon\n"), true);
});

check("owner 从 yml 里抽得干净（引号与空白都剥掉）", () => {
  assert.equal(ownerFromYml('owner:  "acme"  \n'), "acme");
  assert.equal(ownerFromYml("provider: github\nowner: acme\n"), "acme");
});

check("开发模式下没有 app-update.yml，返回 false 而不是抛错", () => {
  assert.equal(updateFeedReady(join(here, "no-such-dir-really")), false);
  assert.equal(updateFeedReady(""), false);
  assert.equal(updateFeedReady(undefined), false);
});

console.log(`\n${passed} 项全部通过`);
