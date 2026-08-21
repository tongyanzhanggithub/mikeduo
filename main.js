// 觅客舵 · Electron 主进程
//
// 职责：开窗加载本地页面 + 提供渲染层拿不到的能力（机器码、safeStorage 加密落盘、
// userData 目录读写、自动更新、原生对话框）。所有能力通过 preload 的 window.mkd 暴露，
// 渲染层不开 nodeIntegration。
const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain, safeStorage, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const { getMachineCode } = require("./electron/machine-code");
const license = require("./electron/license");
const mailer = require("./electron/mailer");
const customs = require("./electron/customs");
const netprobe = require("./electron/netprobe");
const screening = require("./electron/screening");
const hscode = require("./electron/hscode");
const tenders = require("./electron/tenders");
const updateFeed = require("./electron/update-feed");

const APP_NAME = "觅客舵";
const SALES_URL = "https://example.com/mikeduo"; // 销售页：发货前替换为真实地址
const UPDATE_GRACE_DAYS = 365;

app.setAppUserModelId("com.mikeduo.app");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow = null;
let machine = null;
let licenseInfo = null; // null = 试用
let mailCreds = {}; // SMTP/IMAP 凭据，只在主进程内存与加密文件里，绝不下发渲染层

/* ---------- 后台常驻：让自动驾驶不必开着窗口 ----------
   自动驾驶跑在渲染层的定时器里，所以窗口必须存在——但可以不可见。
   关窗改成隐藏到托盘，配合开机自启和 --minimized，开机后它就在后台跑，
   任务栏里看不见。真正退出走托盘菜单或菜单栏「退出」。
   注意 quitting 这个闸门：没有它，托盘退出会被 close 拦截而永远退不掉。 */
const BG_PREF_FILE = () => path.join(app.getPath("userData"), "background.json");
let bgPrefs = { keepRunning: false, openAtLogin: false };
let tray = null;
let quitting = false;
const startedMinimized = process.argv.includes("--minimized");

function loadBgPrefs() {
  try {
    const raw = fs.readFileSync(BG_PREF_FILE(), "utf8");
    const parsed = JSON.parse(raw);
    // hintShown 也要还原：漏掉它，"仍在后台运行"的气泡每次重启后都会再弹一次
    bgPrefs = { keepRunning: !!parsed.keepRunning, openAtLogin: !!parsed.openAtLogin, hintShown: !!parsed.hintShown };
  } catch {
    /* 没有配置文件或读坏了：用默认值（都关），绝不因此启动失败 */
  }
}

function saveBgPrefs() {
  try {
    fs.writeFileSync(BG_PREF_FILE(), JSON.stringify(bgPrefs));
  } catch (error) {
    writeMainError("saveBgPrefs", error);
  }
}

function applyLoginItem() {
  // 开机自启带 --minimized：静默起在托盘，不弹窗打扰
  try {
    app.setLoginItemSettings({ openAtLogin: bgPrefs.openAtLogin, args: ["--minimized"] });
  } catch (error) {
    writeMainError("setLoginItemSettings", error);
  }
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function refreshTray() {
  if (!bgPrefs.keepRunning) {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    return;
  }
  if (!tray) {
    try {
      tray = new Tray(path.join(__dirname, "icon.ico"));
    } catch (error) {
      writeMainError("createTray", error);
      return; // 托盘建不出来不影响主流程
    }
    tray.on("double-click", showMainWindow);
  }
  tray.setToolTip(`${APP_NAME} · 后台运行中`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `打开${APP_NAME}`, click: showMainWindow },
      { type: "separator" },
      {
        label: "完全退出（自动驾驶随之停止）",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

/* ---------- 主进程错误兜底：不静默死掉，写盘 + 告知渲染层 ---------- */

function logsDir() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMainError(scope, error) {
  try {
    const line = `[${new Date().toISOString()}] ${scope}: ${error?.stack || error}\n`;
    fs.appendFileSync(path.join(logsDir(), "main-error.log"), line);
  } catch {
    /* 连日志都写不了就只能放弃，绝不因此再抛一次 */
  }
}

process.on("uncaughtException", (error) => {
  writeMainError("uncaughtException", error);
  mainWindow?.webContents.send("mkd:main-error", { scope: "主进程", message: String(error?.message || error) });
});
process.on("unhandledRejection", (reason) => {
  writeMainError("unhandledRejection", reason);
});

/* ---------- 窗口 ---------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1150, // 1366 宽屏减去 216 侧栏，保证不出横向滚动
    minHeight: 700,
    title: APP_NAME,
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#10161C" : "#F3F5F7",
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // 本地单机应用，加载的是随包内置的本地文件；放宽同源限制，
      // 确保大模型 API 与用户自己的 Webhook 调用不被浏览器 CORS 拦截。
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  // 开机自启时窗口不弹出来（--minimized）：页面照常加载，自动驾驶照常跑，只是不可见
  mainWindow.once("ready-to-show", () => {
    if (!(startedMinimized && bgPrefs.keepRunning)) mainWindow.show();
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // 关窗 = 隐藏到托盘（开了后台常驻时）。首次隐藏给一个气泡，否则用户以为程序没关掉
  mainWindow.on("close", (event) => {
    if (quitting || !bgPrefs.keepRunning) return;
    event.preventDefault();
    mainWindow.hide();
    if (tray && !bgPrefs.hintShown) {
      bgPrefs.hintShown = true;
      saveBgPrefs();
      try {
        tray.displayBalloon({
          title: `${APP_NAME}仍在后台运行`,
          content: "自动驾驶继续工作。双击托盘图标回到窗口，或右键选「完全退出」。"
        });
      } catch {
        /* 部分 Windows 版本不支持气泡，忽略即可 */
      }
    }
  });

  // 页面加载失败（文件缺失/被杀软删了）——不能白屏，给一页能自救的说明
  mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    if (code === -3) return; // 用户主动中断，不算错误
    writeMainError("did-fail-load", new Error(`${code} ${desc}`));
    mainWindow.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<meta charset="utf-8"><body style="font:14px/1.7 'Microsoft YaHei UI',sans-serif;background:#F3F5F7;color:#1A2733;padding:48px">
        <h2 style="margin:0 0 8px">${APP_NAME}没能加载界面文件，你的数据是安全的。</h2>
        <p>数据存在本机独立位置，与界面文件无关。常见原因是杀毒软件误删了安装目录里的文件。</p>
        <p>处理办法：把安装目录加入杀毒软件白名单后重新安装即可，数据会原样还在。</p>
        <p style="color:#5B6B7A">错误：${code} ${desc}</p></body>`)
    );
  });

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    writeMainError("render-process-gone", new Error(details.reason));
  });

  // 外部链接一律交给系统浏览器，别在应用窗口里"走丢"
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith("data:")) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          { label: "打开数据存放位置", click: () => shell.openPath(app.getPath("userData")) },
          { label: "打开备份目录", click: () => shell.openPath(backupDir()) },
          { type: "separator" },
          { role: "quit", label: "退出" }
        ]
      },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "刷新" },
          { role: "forceReload", label: "强制刷新" },
          { role: "toggleDevTools", label: "开发者工具" },
          { type: "separator" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" }
        ]
      },
      {
        label: "帮助",
        submenu: [
          { label: "激活 / 关于", click: () => mainWindow?.webContents.send("mkd:open-about") },
          { label: "导出诊断日志", click: () => mainWindow?.webContents.send("mkd:export-diagnostics") },
          { label: "重新打开新手引导", click: () => mainWindow?.webContents.send("mkd:restart-onboarding") }
        ]
      }
    ])
  );
}

/* ---------- 备份目录（F7） ---------- */

function backupDir() {
  const dir = path.join(app.getPath("userData"), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------- 激活状态（F1） ---------- */

function updateExpiry(issuedAt) {
  if (!issuedAt) return null;
  return new Date(new Date(issuedAt).getTime() + UPDATE_GRACE_DAYS * 86400000).toISOString().slice(0, 10);
}

/* 开发模式解锁：调业务的时候不该被授权挡住。
   试用版把 aiEnabled() 硬改成恒 false，AI 那半条链根本跑不起来，
   而发码要私钥、私钥又只在签发那台机器上——为了调个业务不该走这一圈。

   只在未打包时生效（app.isPackaged === false）。装到客户机上的是打包版，
   这段代码走不到，所以客户设什么环境变量都没用。 */
const DEV_TIER_LABELS = { basic: "基础版", pro: "VIP版", coach: "陪跑版" };

function devTierOverride() {
  if (app.isPackaged) return null;
  const tier = String(process.env.MKD_DEV_TIER || "").trim().toLowerCase();
  if (!tier) return null;
  if (!DEV_TIER_LABELS[tier]) {
    console.warn(`[MKD] MKD_DEV_TIER="${tier}" 不是 basic|pro|coach，已忽略`);
    return null;
  }
  return tier;
}

function licensePayload() {
  const devTier = devTierOverride();
  if (devTier && !licenseInfo) {
    const issuedAt = new Date().toISOString().slice(0, 10);
    console.log(`[MKD] 开发模式：以 ${DEV_TIER_LABELS[devTier]} 运行（未打包才生效，打包版无此通道）`);
    return {
      activated: true,
      tier: devTier,
      tierLabel: `${DEV_TIER_LABELS[devTier]}（开发模式）`,
      issuedAt,
      activatedAt: new Date().toISOString(),
      code: "DEV-MODE",
      updateUntil: updateExpiry(issuedAt),
      updateExpired: false
    };
  }
  if (!licenseInfo) {
    return { activated: false, tier: null, tierLabel: null, issuedAt: null, updateUntil: null, updateExpired: false };
  }
  const updateUntil = updateExpiry(licenseInfo.issuedAt);
  return {
    activated: true,
    tier: licenseInfo.tier,
    tierLabel: licenseInfo.tierLabel,
    issuedAt: licenseInfo.issuedAt,
    activatedAt: licenseInfo.activatedAt || null,
    code: licenseInfo.code,
    updateUntil,
    updateExpired: !!updateUntil && Date.now() > new Date(updateUntil).getTime()
  };
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle("mkd:app-info", () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${process.arch} ${require("node:os").release()}`,
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    backupDir: backupDir(),
    salesUrl: SALES_URL
  }));

  ipcMain.handle("mkd:machine-code", async () => {
    machine = machine || (await getMachineCode());
    return { code: machine.code, weak: machine.weak };
  });

  ipcMain.handle("mkd:license-status", () => licensePayload());

  ipcMain.handle("mkd:activate", async (_e, rawCode) => {
    machine = machine || (await getMachineCode());
    const result = license.verifyCode(rawCode, machine.raw);
    if (!result.ok) return { ok: false, reason: result.reason };
    licenseInfo = { ...result, activatedAt: new Date().toISOString() };
    try {
      license.saveLicense(app, safeStorage, { code: result.code, activatedAt: licenseInfo.activatedAt });
    } catch (error) {
      writeMainError("saveLicense", error);
      return { ok: false, reason: "write" };
    }
    return { ok: true, license: licensePayload() };
  });

  ipcMain.handle("mkd:open-external", (_e, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle("mkd:open-path", (_e, which) => {
    shell.openPath(which === "backups" ? backupDir() : app.getPath("userData"));
  });

  /* --- 备份 --- */
  ipcMain.handle("mkd:backup-write", (_e, { json, tag }) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(backupDir(), `mkd-backup-${stamp}${tag ? `-${tag}` : ""}.json`);
    fs.writeFileSync(file, json, "utf8");
    // 滚动保留最近 14 份
    const files = fs
      .readdirSync(backupDir())
      .filter((f) => f.startsWith("mkd-backup-") && f.endsWith(".json"))
      .sort();
    files.slice(0, Math.max(0, files.length - 14)).forEach((f) => {
      try {
        fs.rmSync(path.join(backupDir(), f), { force: true });
      } catch {
        /* 删不掉旧备份不影响本次备份成功 */
      }
    });
    return { file, at: new Date().toISOString() };
  });

  ipcMain.handle("mkd:backup-list", () =>
    fs
      .readdirSync(backupDir())
      .filter((f) => f.startsWith("mkd-backup-") && f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => {
        const stat = fs.statSync(path.join(backupDir(), f));
        return { file: f, size: stat.size, at: stat.mtime.toISOString() };
      })
  );

  ipcMain.handle("mkd:backup-read", (_e, file) => {
    const safe = path.basename(String(file)); // 只允许读备份目录内的文件名
    return fs.readFileSync(path.join(backupDir(), safe), "utf8");
  });

  /* --- 诊断日志 --- */
  ipcMain.handle("mkd:save-text", async (_e, { defaultName, content }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "保存文件",
      defaultPath: path.join(app.getPath("downloads"), defaultName),
      filters: [{ name: "文本/JSON", extensions: ["txt", "json", "log"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    fs.writeFileSync(result.filePath, content, "utf8");
    return { ok: true, file: result.filePath };
  });

  ipcMain.handle("mkd:main-error-log", () => {
    const file = path.join(logsDir(), "main-error.log");
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8").slice(-20000); // 只取尾部，诊断包要小于 2MB
  });

  /* --- 自动更新（F5） --- */
  ipcMain.handle("mkd:check-update", async () => {
    const status = licensePayload();
    if (status.activated && status.updateExpired) {
      return { ok: false, expired: true, updateUntil: status.updateUntil };
    }
    // 发布仓库还没配好就一次请求都不发——理由见 electron/update-feed.js
    if (!updateFeed.updateFeedReady(process.resourcesPath)) return { ok: false, reason: "更新源未配置" };
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.autoDownload = true;
      autoUpdater.removeAllListeners("update-downloaded");
      autoUpdater.on("update-downloaded", (info) => {
        mainWindow?.webContents.send("mkd:update-ready", { version: info.version, notes: info.releaseNotes });
      });
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version || null };
    } catch (error) {
      // 未配置更新源 / 无网络 / 开发模式：静默失败，绝不影响使用
      return { ok: false, reason: String(error?.message || error) };
    }
  });

  /* --- 内置收发信（SMTP / IMAP 直连，免自建 n8n） ---
     凭据全程留在主进程：渲染层只能读到摘要（主机/账号/配没配），
     密码既不进 state 也不进备份 JSON，导出备份发给客服也不会泄露。 */
  ipcMain.handle("mkd:mail-summary", () => mailer.summary(mailCreds));

  ipcMain.handle("mkd:mail-save", (_e, next) => {
    const merge = (old = {}, incoming = {}) => ({
      host: (incoming.host ?? old.host ?? "").trim(),
      port: Number(incoming.port ?? old.port) || 0,
      user: (incoming.user ?? old.user ?? "").trim(),
      // 密码留空表示"不改"，避免用户每次调端口都要重输授权码
      pass: incoming.pass ? incoming.pass : old.pass || "",
      secure: incoming.secure ?? old.secure ?? true
    });
    mailCreds = {
      smtp: next?.smtp ? merge(mailCreds.smtp, next.smtp) : mailCreds.smtp,
      imap: next?.imap ? merge(mailCreds.imap, next.imap) : mailCreds.imap
    };
    try {
      mailer.saveCreds(app, safeStorage, mailCreds);
    } catch (error) {
      writeMainError("saveMailCreds", error);
      return { ok: false, error: "凭据写盘失败，请检查数据目录权限" };
    }
    return { ok: true, summary: mailer.summary(mailCreds) };
  });

  ipcMain.handle("mkd:mail-clear", () => {
    mailCreds = {};
    mailer.clearCreds(app);
    return { ok: true, summary: mailer.summary(mailCreds) };
  });

  ipcMain.handle("mkd:smtp-test", () => {
    if (!mailCreds.smtp?.host) return { ok: false, error: "还没填写 SMTP 服务器" };
    return mailer.testSmtp(mailCreds.smtp);
  });

  ipcMain.handle("mkd:imap-test", () => {
    if (!mailCreds.imap?.host) return { ok: false, error: "还没填写 IMAP 服务器" };
    return mailer.testImap(mailCreds.imap);
  });

  ipcMain.handle("mkd:smtp-send", async (_e, payload) => {
    if (!mailCreds.smtp?.host) return { ok: false, error: "还没配置 SMTP" };
    const emails = Array.isArray(payload?.emails) ? payload.emails : [];
    if (!emails.length) return { ok: true, results: [] };
    try {
      const results = await mailer.sendMails(mailCreds.smtp, payload?.fromName, emails);
      return { ok: true, results };
    } catch (error) {
      writeMainError("smtpSend", error);
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("mkd:imap-fetch", async (_e, payload) => {
    if (!mailCreds.imap?.host) return { ok: false, error: "还没配置 IMAP" };
    return mailer.fetchInbound(mailCreds.imap, payload?.since, payload?.limit);
  });

  /* --- 网络探测：抓官网 / 查 DNS / 验邮箱 ---
     渲染层受同源策略限制抓不了外站，DNS 与 SMTP 更是只有主进程才有。
     并发刻意压到 3：我们是从用户自己的 IP 出发的，把人家网站抓出问题
     或者让用户 IP 被拉黑，损失的是用户。宁可慢一点。 */
  const netQueue = { running: 0, waiting: [] };
  function throttled(fn) {
    return new Promise((resolve) => {
      const run = async () => {
        netQueue.running += 1;
        try {
          resolve(await fn());
        } catch (error) {
          writeMainError("netprobe", error);
          resolve({ ok: false, reason: String(error?.message || error) });
        } finally {
          netQueue.running -= 1;
          const next = netQueue.waiting.shift();
          if (next) next();
        }
      };
      if (netQueue.running < 3) run();
      else netQueue.waiting.push(run);
    });
  }

  ipcMain.handle("mkd:site-harvest", (_e, payload) =>
    throttled(() => netprobe.harvestSite(payload?.website, { maxPages: payload?.maxPages }))
  );

  ipcMain.handle("mkd:domain-health", (_e, domain) => throttled(() => netprobe.domainHealth(domain)));

  ipcMain.handle("mkd:verify-email", (_e, payload) =>
    throttled(async () => {
      const r = await netprobe.verifyEmail(payload?.email, { mxOnly: payload?.mxOnly, fromDomain: payload?.fromDomain });
      // 顺带把「我们的 IP 被公共黑名单拦了」这件事带回去，
      // 让渲染层只提醒用户一次，而不是每个地址都重复同一句
      return { ...r, blockedNotice: netprobe.probeBlockedNotice() };
    })
  );

  ipcMain.handle("mkd:fetch-page", (_e, url) => throttled(() => netprobe.fetchPage(url)));

  /* --- 磁盘上的构建版本 ---
     开发时的真实痛点：改完 src/*.js 跑了 build，但**开着的那个窗口还是旧的**——
     它在启动那一刻就把 app.js 读进内存了，之后磁盘怎么变都与它无关。

     index.html 里的缓存哨兵抓不到这种情况：页面和脚本是同一时刻一起加载的，
     二者自洽，哨兵只能发现"页面新脚本旧"，发现不了"两个都旧"。
     所以由主进程去读磁盘上的真实版本戳，交给渲染层自己比对。

     打包版永远返回 null：安装目录里的文件不会变，查了也是白查。 */
  //  版本戳不在文件开头（实测在 ~10.4KB 处，前面是全局错误捕获那一段），
  //  所以必须读全文——只读前几 KB 会永远返回 null，检测静默失效。
  //  按 mtime+size 做缓存：窗口每次获得焦点都会问一次，没必要反复读 650KB。
  let buildStampCache = { key: "", stamp: null };
  /* --- 合规筛查（本地名单，不联网） ---
     OFAC + 别名 + UFLPA + BIS-DPL 共 4 万个主体，随包发货 452 KB。
     首次调用时解压载入并建索引，之后常驻内存。 */
  ipcMain.handle("mkd:screen-entity", (_e, name) => {
    try {
      return screening.screen(name);
    } catch (error) {
      writeMainError("screening", error);
      // 名单读不出来时必须明说，绝不能静默返回"没命中"——
      // 那会让用户以为查过了，实际根本没查。
      return { ok: false, reason: String(error?.message || error) };
    }
  });

  ipcMain.handle("mkd:screening-stats", () => {
    try {
      return screening.stats();
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
  });

  /* --- HS 编码目录（本地，不联网） ---
     AI 报出来的 HS 码从来没被校验过。模型给一个不存在的码，用户拿去查海关数据、
     填报关单、跟客户对话，一路错到底而且没有一环会告诉他错了。 */
  ipcMain.handle("mkd:hs-lookup", (_e, code) => {
    try {
      return hscode.lookup(code);
    } catch (error) {
      writeMainError("hscode", error);
      return { ok: false, reason: String(error?.message || error) };
    }
  });

  ipcMain.handle("mkd:hs-search", (_e, payload) => {
    try {
      return hscode.search(payload?.keyword, payload?.limit);
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
  });

  /* --- 公共部门货物采购官（本地，不联网） ---
     独立线索源，刻意不混进主线索池：画像与进口商完全不同。 */
  ipcMain.handle("mkd:tenders-search", (_e, payload) => {
    try {
      return tenders.search(payload || {});
    } catch (error) {
      writeMainError("tenders", error);
      return { ok: false, reason: String(error?.message || error) };
    }
  });

  ipcMain.handle("mkd:tenders-countries", () => {
    try {
      return tenders.countries();
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
  });

  // 打开随包附带的文档（追踪端点搭建指南等）。限定在 docs/ 下且只认文件名，
  // 不接受路径分隔符——避免被拼出 ../ 之类的东西。
  ipcMain.handle("mkd:open-doc", (_e, name) => {
    const safe = String(name || "").replace(/[\/]/g, "");
    if (!safe || !safe.endsWith(".md")) return { ok: false };
    const file = path.join(__dirname, "docs", safe);
    if (!fs.existsSync(file)) return { ok: false, reason: "文档不在安装目录里" };
    shell.openPath(file);
    return { ok: true };
  });

  ipcMain.handle("mkd:build-stamp", () => {
    if (app.isPackaged) return null;
    try {
      const file = path.join(__dirname, "app.js");
      const st = fs.statSync(file);
      const key = `${st.mtimeMs}:${st.size}`;
      if (buildStampCache.key === key) return buildStampCache.stamp;
      const m = /__APP_V\s*=\s*"([a-f0-9]+)"/.exec(fs.readFileSync(file, "utf8"));
      buildStampCache = { key, stamp: m ? m[1] : null };
      return buildStampCache.stamp;
    } catch {
      return null; // 读不到就当没这回事，绝不因此打扰用户
    }
  });

  ipcMain.handle("mkd:netprobe-reset", () => {
    netprobe.resetProbeState();
    return { ok: true };
  });

  /* --- 本地海关提单库 ---
     原始提单不进 localStorage（5MB 上限扛不住），单独存 userData/customs.jsonl。
     只提供查询，不提供整库导出——数据商条款普遍允许自用、禁止再分发。 */
  ipcMain.handle("mkd:customs-append", (_e, records) => {
    try {
      return { ok: true, ...customs.append(app, records) };
    } catch (error) {
      writeMainError("customsAppend", error);
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("mkd:customs-stats", () => {
    try {
      return { ok: true, ...customs.stats(app) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("mkd:customs-by-shipper", (_e, payload) => {
    try {
      return customs.findByShipper(app, payload?.query, payload?.limit);
    } catch (error) {
      writeMainError("customsQuery", error);
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("mkd:customs-clear", () => customs.clear(app));

  /* --- 后台常驻 --- */
  ipcMain.handle("mkd:background-prefs", () => ({ ...bgPrefs, supported: process.platform === "win32" }));

  ipcMain.handle("mkd:set-background-prefs", (_e, next) => {
    bgPrefs = {
      ...bgPrefs,
      keepRunning: !!next?.keepRunning,
      // 不常驻就没有"开机自启"的意义：起来一个马上被关掉的窗口只会打扰人
      openAtLogin: !!next?.keepRunning && !!next?.openAtLogin
    };
    saveBgPrefs();
    applyLoginItem();
    refreshTray();
    return { ...bgPrefs, supported: process.platform === "win32" };
  });

  ipcMain.handle("mkd:quit-and-install", () => {
    try {
      require("electron-updater").autoUpdater.quitAndInstall();
    } catch (error) {
      writeMainError("quitAndInstall", error);
    }
  });
}

app.whenReady().then(async () => {
  machine = await getMachineCode();
  licenseInfo = license.loadLicense(app, safeStorage, machine.raw);
  mailCreds = mailer.loadCreds(app, safeStorage);
  loadBgPrefs();
  registerIpc();
  buildMenu();
  refreshTray();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 用户又点了一次快捷方式：把已在后台的窗口叫出来（而不是白开一个进程）
app.on("second-instance", () => showMainWindow());

app.on("before-quit", () => {
  quitting = true; // 菜单栏「退出」/系统关机：放行 close，不再隐藏到托盘
});

app.on("window-all-closed", () => {
  // 开了后台常驻就不退——窗口只是隐藏了，自动驾驶还在跑
  if (bgPrefs.keepRunning && !quitting) return;
  if (process.platform !== "darwin") app.quit();
});
