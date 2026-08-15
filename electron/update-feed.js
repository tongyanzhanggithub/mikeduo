/* 更新源闸门：发布仓库还没配好之前，一次更新检查都不许发出去。

   package.json 里 publish.owner 目前仍是 REPLACE_ME 占位符，electron-builder
   会把它原样写进安装包的 app-update.yml。实测装完启动就能看到：
     GET https://github.com/REPLACE_ME/mikeduo-release/releases.atom → 404

   两个问题，第二个才是要命的：
     ① 一个卖点是「本地买断、数据不出机器」的产品，这个请求本身就不该存在；
     ② REPLACE_ME 是个谁都能注册的 GitHub 账号名。一旦被人抢注，它立刻成为
        所有已安装机器的更新源——electron-updater 会从那儿下载并安装新版本，
        等于把安装通道拱手让人。

   所以判定方向是不对称的：占位符、空值、读不到文件，一律当「没配好」。
   等真配好发布仓库、把 owner 改成实际账号，这个闸门自己就打开了。 */

const fs = require("node:fs");
const path = require("node:path");

// 只锚定开头，避免误伤 mytodolist 这种正常账号名
const OWNER_PLACEHOLDER = /^(REPLACE_ME|YOUR[_-]|CHANGE[_-]?ME|TODO|XXX)/i;

function ownerFromYml(yml) {
  return (/^owner:\s*(.+)$/m.exec(String(yml || ""))?.[1] || "").trim().replace(/^["']|["']$/g, "");
}

function feedReady(yml) {
  const owner = ownerFromYml(yml);
  return !!owner && !OWNER_PLACEHOLDER.test(owner);
}

// resourcesPath 为空（开发模式）或文件不存在时返回 false——开发模式本来也不该查更新
function updateFeedReady(resourcesPath) {
  try {
    return feedReady(fs.readFileSync(path.join(resourcesPath, "app-update.yml"), "utf8"));
  } catch {
    return false;
  }
}

module.exports = { updateFeedReady, _internals: { ownerFromYml, feedReady } };
