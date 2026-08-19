// 渲染层与主进程之间唯一的窗口：window.mkd
//
// 只暴露具名方法，不暴露 ipcRenderer 本身。浏览器直开 index.html 时 window.mkd
// 不存在，应用侧一律用 `hasBridge()` 判断后降级（浏览器模式=试用，激活须在桌面版做）。
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (handler) => {
  ipcRenderer.on(channel, (_e, payload) => handler(payload));
};

contextBridge.exposeInMainWorld("mkd", {
  isDesktop: true,

  appInfo: () => ipcRenderer.invoke("mkd:app-info"),
  machineCode: () => ipcRenderer.invoke("mkd:machine-code"),
  licenseStatus: () => ipcRenderer.invoke("mkd:license-status"),
  activate: (code) => ipcRenderer.invoke("mkd:activate", code),

  openExternal: (url) => ipcRenderer.invoke("mkd:open-external", url),
  openPath: (which) => ipcRenderer.invoke("mkd:open-path", which),

  backupWrite: (json, tag) => ipcRenderer.invoke("mkd:backup-write", { json, tag }),
  backupList: () => ipcRenderer.invoke("mkd:backup-list"),
  backupRead: (file) => ipcRenderer.invoke("mkd:backup-read", file),

  saveText: (defaultName, content) => ipcRenderer.invoke("mkd:save-text", { defaultName, content }),
  mainErrorLog: () => ipcRenderer.invoke("mkd:main-error-log"),

  checkUpdate: () => ipcRenderer.invoke("mkd:check-update"),
  quitAndInstall: () => ipcRenderer.invoke("mkd:quit-and-install"),

  backgroundPrefs: () => ipcRenderer.invoke("mkd:background-prefs"),
  setBackgroundPrefs: (prefs) => ipcRenderer.invoke("mkd:set-background-prefs", prefs),

  // 内置收发信：只暴露动作与摘要，密码进得去出不来
  mailSummary: () => ipcRenderer.invoke("mkd:mail-summary"),
  mailSave: (creds) => ipcRenderer.invoke("mkd:mail-save", creds),
  mailClear: () => ipcRenderer.invoke("mkd:mail-clear"),
  smtpTest: () => ipcRenderer.invoke("mkd:smtp-test"),
  imapTest: () => ipcRenderer.invoke("mkd:imap-test"),
  smtpSend: (payload) => ipcRenderer.invoke("mkd:smtp-send", payload),
  imapFetch: (payload) => ipcRenderer.invoke("mkd:imap-fetch", payload),

  // 网络探测：抓官网找真实联系方式、域名健康体检、邮箱存在性验证
  siteHarvest: (website, maxPages) => ipcRenderer.invoke("mkd:site-harvest", { website, maxPages }),
  domainHealth: (domain) => ipcRenderer.invoke("mkd:domain-health", domain),
  verifyEmail: (email, opts) => ipcRenderer.invoke("mkd:verify-email", { email, ...(opts || {}) }),
  fetchPage: (url) => ipcRenderer.invoke("mkd:fetch-page", url),
  netprobeReset: () => ipcRenderer.invoke("mkd:netprobe-reset"),
  buildStamp: () => ipcRenderer.invoke("mkd:build-stamp"),

  // 合规筛查：本地名单，不联网
  screenEntity: (name) => ipcRenderer.invoke("mkd:screen-entity", name),
  screeningStats: () => ipcRenderer.invoke("mkd:screening-stats"),

  // HS 编码目录：校验 AI 报出来的码是不是真的存在
  hsLookup: (code) => ipcRenderer.invoke("mkd:hs-lookup", code),
  hsSearch: (keyword, limit) => ipcRenderer.invoke("mkd:hs-search", { keyword, limit }),

  // 公共部门货物采购官：独立线索源
  tendersSearch: (query) => ipcRenderer.invoke("mkd:tenders-search", query),
  tendersCountries: () => ipcRenderer.invoke("mkd:tenders-countries"),

  // 本地海关提单库：只查不导（整库导出等于给再分发开通道）
  customsAppend: (records) => ipcRenderer.invoke("mkd:customs-append", records),
  customsStats: () => ipcRenderer.invoke("mkd:customs-stats"),
  customsByShipper: (payload) => ipcRenderer.invoke("mkd:customs-by-shipper", payload),
  customsClear: () => ipcRenderer.invoke("mkd:customs-clear"),

  onMainError: on("mkd:main-error"),
  onUpdateReady: on("mkd:update-ready"),
  onOpenAbout: on("mkd:open-about"),
  onExportDiagnostics: on("mkd:export-diagnostics"),
  onRestartOnboarding: on("mkd:restart-onboarding")
});
