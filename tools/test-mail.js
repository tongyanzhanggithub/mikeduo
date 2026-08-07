// 内置收发信的集成自测：在真 Electron 下验证凭据加密、摘要脱敏、错误分型
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mkd-mail-"));
app.setPath("userData", sandbox);

const mailer = require(path.join(__dirname, "..", "electron", "mailer.js"));

let passed = 0;
const fail = [];
function ok(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok ${name}${extra ? `\n     ${extra}` : ""}`);
  } else {
    fail.push(name);
    console.log(`  ✗ ${name}`);
  }
}

app.whenReady().then(async () => {
  console.log(`\n内置收发信集成自测（沙箱 userData: ${sandbox}）`);

  const creds = {
    smtp: { host: "smtp.exmail.qq.com", port: 465, user: "me@corp.com", pass: "SECRET-AUTH-CODE", secure: true },
    imap: { host: "imap.exmail.qq.com", port: 993, user: "me@corp.com", pass: "SECRET-AUTH-CODE", secure: true }
  };

  mailer.saveCreds(app, safeStorage, creds);
  const file = path.join(sandbox, "mail.dat");
  ok("凭据写盘成功", fs.existsSync(file));

  const raw = fs.readFileSync(file);
  ok(
    "落盘文件里检索不到明文授权码",
    !raw.toString("utf8").includes("SECRET-AUTH-CODE") && !raw.toString("latin1").includes("SECRET-AUTH-CODE"),
    `safeStorage 可用=${safeStorage.isEncryptionAvailable()}`
  );

  const back = mailer.loadCreds(app, safeStorage);
  ok("加密写盘后能原样读回", back.smtp.pass === "SECRET-AUTH-CODE" && back.imap.host === "imap.exmail.qq.com");

  const sum = mailer.summary(back);
  ok(
    "给渲染层的摘要不含密码",
    !JSON.stringify(sum).includes("SECRET-AUTH-CODE") && sum.smtp.configured === true && sum.imap.configured === true,
    JSON.stringify(sum.smtp)
  );

  fs.writeFileSync(file, Buffer.from("garbage-not-encrypted"));
  const broken = mailer.loadCreds(app, safeStorage);
  ok("凭据文件损坏 → 静默回退未配置，不抛错", Object.keys(broken).length === 0);

  const emptySum = mailer.summary(broken);
  ok("未配置时 configured 为 false", emptySum.smtp.configured === false && emptySum.imap.configured === false);

  // 错误分型：连一个必然拒绝的本地端口
  const res = await mailer.testSmtp({ host: "127.0.0.1", port: 1, user: "a@b.com", pass: "x", secure: false });
  ok("连不上时返回可读的中文原因而不是原始堆栈", res.ok === false && /端口|连接|超时|找不到/.test(res.error), res.error);

  const imapRes = await mailer.testImap({ host: "no-such-host.invalid", port: 993, user: "a@b.com", pass: "x" });
  ok("IMAP 主机不存在 → 指出地址拼错", imapRes.ok === false && /找不到该主机|连接|超时/.test(imapRes.error), imapRes.error);

  /* ---- 退信判别：认不出来的话，一封 MAILER-DAEMON 会被当成客户回信自动建档 ---- */

  ok(
    "MAILER-DAEMON 发来的算退信",
    mailer.looksLikeBounce("MAILER-DAEMON@mx.example.com", "Returned mail", "")
  );
  ok("按主题识别退信（英文）", mailer.looksLikeBounce("noc@corp.com", "Undeliverable: Quotation Q-001", ""));
  ok("按主题识别退信（中文）", mailer.looksLikeBounce("noc@corp.com", "退信通知", ""));
  ok(
    "标准 DSN 头识别退信",
    mailer.looksLikeBounce("x@y.com", "报告", 'Content-Type: multipart/report; report-type=delivery-status;')
  );
  ok("休假自动回复不当客户回信", mailer.looksLikeBounce("ana@buyer.com", "Out of office", "Auto-Submitted: auto-replied"));
  ok(
    "真实客户回信不被误判",
    !mailer.looksLikeBounce("ana@acme-import.de", "Re: Quotation Q-20260804-01", "Auto-Submitted: no"),
    "这条误判的代价最大——把真客户的回信丢掉"
  );

  const dsn = `Your message could not be delivered.

Final-Recipient: rfc822; einkauf@no-such-domain.de
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 User unknown`;
  ok("从 DSN 里抽出失败地址", mailer.extractBouncedAddress(dsn, "me@corp.com") === "einkauf@no-such-domain.de", mailer.extractBouncedAddress(dsn, "me@corp.com"));
  ok("5.x.x 判为硬退信", mailer.isHardBounce(dsn) === true);

  const soft = `Delivery delayed

Final-Recipient: rfc822; ana@buyer.com
Status: 4.2.2
Diagnostic-Code: smtp; 452 Mailbox full`;
  ok("4.x.x 判为软退信（不该拉黑）", mailer.isHardBounce(soft) === false);
  ok("软退信同样能抽出地址", mailer.extractBouncedAddress(soft, "me@corp.com") === "ana@buyer.com");
  ok(
    "抽地址时排除自己的地址",
    mailer.extractBouncedAddress("delivery failed for me@corp.com and klaus@buyer.de", "me@corp.com") === "klaus@buyer.de"
  );

  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(fail.length ? `\n${fail.length} 项失败：${fail.join("、")}` : `\n${passed} 项全部通过`);
  app.exit(fail.length ? 1 : 0);
});
