// 内置收发信（主进程）——SMTP 直发 + IMAP 拉取，不再必须自建 n8n
//
// 为什么放主进程：SMTP/IMAP 是裸 TCP + TLS，浏览器里做不到；也只有这里能用
// safeStorage 加密存凭据。渲染层永远拿不到明文密码，它只知道"配没配"。
//
// 凭据落在 userData/mail.dat，用 Electron safeStorage 加密（与 license.dat 同一套做法）。
// 文件损坏/换机读不出时静默回退"未配置"，绝不抛错崩溃。
const fs = require("node:fs");
const path = require("node:path");

function credPath(app) {
  return path.join(app.getPath("userData"), "mail.dat");
}

function saveCreds(app, safeStorage, creds) {
  const json = JSON.stringify(creds);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(`plain:${json}`, "utf8");
  fs.writeFileSync(credPath(app), buf, { mode: 0o600 });
}

function loadCreds(app, safeStorage) {
  try {
    const file = credPath(app);
    if (!fs.existsSync(file)) return {};
    const buf = fs.readFileSync(file);
    const json =
      buf.subarray(0, 6).toString("utf8") === "plain:" ? buf.subarray(6).toString("utf8") : safeStorage.decryptString(buf);
    return JSON.parse(json) || {};
  } catch {
    return {};
  }
}

function clearCreds(app) {
  try {
    fs.rmSync(credPath(app), { force: true });
  } catch {
    /* 删不掉不影响使用，下次覆盖写即可 */
  }
}

// 渲染层能看到的安全摘要：只有主机/账号/配没配，绝不含密码
function summary(creds) {
  const s = creds.smtp || {};
  const i = creds.imap || {};
  return {
    smtp: { host: s.host || "", port: s.port || 465, user: s.user || "", secure: s.secure !== false, configured: !!(s.host && s.user && s.pass) },
    imap: { host: i.host || "", port: i.port || 993, user: i.user || "", secure: i.secure !== false, configured: !!(i.host && i.user && i.pass) }
  };
}

/* ---------- 错误分型 ----------
   90% 的配置失败是"填了登录密码而不是客户端授权码"。原始报错是
   "535 Error: authentication failed"，用户看了完全不知道该改什么，
   所以这里把常见错误翻译成"你该做什么"。 */
function explain(error, kind) {
  const raw = String(error?.message || error || "");
  // nodemailer 把底层错误包成 ESOCKET/ECONNECTION，真正的 errno 只出现在 message 里，
  // 所以两处都要看——只看 error.code 会让 ECONNREFUSED 漏成原始英文串扔给用户。
  const hay = `${error?.code || ""} ${raw}`;
  const lower = hay.toLowerCase();
  if (/535|auth|credential|login denied|invalid user|password/i.test(raw)) {
    return `认证失败：多半是密码填成了邮箱登录密码。${kind === "imap" ? "IMAP" : "SMTP"} 要填企业邮箱后台生成的「客户端授权码」，不是你登录网页版的那个密码。`;
  }
  if (/etimedout|timeout|timed out/i.test(lower)) {
    return "连接超时：检查主机地址和端口，或本机防火墙/杀毒软件是否拦了外发连接。";
  }
  if (/econnrefused/i.test(lower)) return "连接被拒绝：端口多半填错了（SMTP 常见 465/587，IMAP 常见 993）。";
  if (/enotfound|getaddrinfo|eai_again/i.test(lower)) return "找不到该主机：服务器地址拼错了，或本机 DNS 解析不了。";
  if (/econnreset|epipe/i.test(lower)) return "连接被对方中断：多半是端口与加密方式不匹配（465/993 要勾 SSL，587 要取消勾选走 STARTTLS）。";
  if (/certificate|self.signed|tls|ssl/i.test(lower)) return `TLS 证书校验失败：确认端口与加密方式匹配（465/993 用 SSL，587 用 STARTTLS）。原始信息：${raw}`;
  return raw || "未知错误";
}

/* ---------- SMTP ---------- */

function transportOf(smtp) {
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 465,
    secure: smtp.secure !== false, // 465 直接 TLS；587 传 false 走 STARTTLS
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000
  });
}

async function testSmtp(smtp) {
  try {
    const tx = transportOf(smtp);
    await tx.verify();
    tx.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: explain(error, "smtp") };
  }
}

// 逐封发送并逐封返回结果——一封失败不能影响其余的，
// 而且调用方要能精确知道是哪几封没出去（队列状态要据此回写）。
async function sendMails(smtp, fromName, emails) {
  const tx = transportOf(smtp);
  const results = [];
  try {
    for (const mail of emails) {
      try {
        const info = await tx.sendMail({
          from: fromName ? { name: fromName, address: smtp.user } : smtp.user,
          to: mail.email,
          subject: mail.subject,
          text: mail.body,
          replyTo: smtp.replyTo || undefined
        });
        results.push({ id: mail.id, ok: true, messageId: info.messageId });
      } catch (error) {
        results.push({ id: mail.id, ok: false, error: explain(error, "smtp") });
      }
    }
  } finally {
    tx.close();
  }
  return results;
}

/* ---------- IMAP ---------- */

async function withImap(imap, fn) {
  const { ImapFlow } = require("imapflow");
  const client = new ImapFlow({
    host: imap.host,
    port: Number(imap.port) || 993,
    secure: imap.secure !== false,
    auth: { user: imap.user, pass: imap.pass },
    logger: false, // 默认会往 stdout 打全量协议日志，含邮件内容——必须关掉
    emitLogs: false
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      /* 断开失败无所谓，连接会自行超时回收 */
    }
  }
}

async function testImap(imap) {
  try {
    const count = await withImap(imap, async (client) => {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      return box.exists;
    });
    return { ok: true, count };
  } catch (error) {
    return { ok: false, error: explain(error, "imap") };
  }
}

/* ---------- 退信识别 ----------
   收件箱里不只有客户回信，还有退信。不认出来的话，一封 MAILER-DAEMON 会被
   当成"客户主动回信"自动建档、推进商机、甚至触发 AI 自动应答去回复退信服务器；
   而真正的坏地址留在池里继续发，正好砸掉"保护发信域名信誉"这条核心承诺。 */
const BOUNCE_FROM = /(mailer-daemon|postmaster|no-?reply|mail-?delivery|delivery-?subsystem|bounce)/i;
const BOUNCE_SUBJECT =
  /(undeliverable|undelivered|delivery status notification|delivery failure|failure notice|returned mail|mail delivery failed|delivery has failed|无法投递|退信|投递失败)/i;

function looksLikeBounce(from, subject, headers) {
  if (BOUNCE_FROM.test(from || "")) return true;
  if (BOUNCE_SUBJECT.test(subject || "")) return true;
  const h = String(headers || "");
  // 标准 DSN：multipart/report; report-type=delivery-status
  if (/report-type=["']?delivery-status/i.test(h)) return true;
  // 自动回复类（含休假自动回复）带 Auto-Submitted，也不该当客户回信。
  // 注意不能写成 /^auto-submitted:\s*(?!no)/ —— \s* 贪婪匹配后前瞻失败会回溯到
  // 匹配零个空格，于是拿空格去比 "no" 反而通过，把 "Auto-Submitted: no"
  // （明确声明这不是自动回复）误判成自动回复，真客户的回信会被静默丢掉。
  const auto = h.match(/^auto-submitted:[ \t]*([^\r\n]*)/im);
  if (auto && !/^no\b/i.test(auto[1].trim())) return true;
  return false;
}

// 从退信正文里挖出那个发不到的地址。DSN 里是 Final-Recipient/Original-Recipient，
// 人类可读部分通常也会把地址原样列出来。
function extractBouncedAddress(text, ownAddress) {
  const body = String(text || "");
  const dsn = body.match(/(?:final|original)-recipient:\s*(?:rfc822;)?\s*([^\s<>,;]+@[^\s<>,;]+)/i);
  if (dsn) return dsn[1].toLowerCase().replace(/[.>,;]+$/, "");
  const all = body.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  const own = String(ownAddress || "").toLowerCase();
  // 排除自己的地址和退信服务器自己的地址
  const hit = all.map((a) => a.toLowerCase()).find((a) => a !== own && !BOUNCE_FROM.test(a));
  return hit ? hit.replace(/[.>,;]+$/, "") : "";
}

// 5.x.x 是永久失败（地址不存在），4.x.x 是临时失败（对方满了/暂时不可达）。
// 只有永久失败才该拉黑——临时失败拉黑会误伤正常客户。
function isHardBounce(text) {
  const m = String(text || "").match(/\bstatus:\s*([245])\.\d+\.\d+/i);
  if (m) return m[1] === "5";
  return /\b5\d{2}\b[^\n]{0,80}(does not exist|no such user|unknown user|user unknown|mailbox unavailable|invalid recipient|address rejected)/i.test(
    String(text || "")
  );
}

// 拉取 since 之后的新邮件。只取信封与纯文本正文，附件一律不下载
// （用不上，而且几百封带附件会把内存和磁盘打爆）。
async function fetchInbound(imap, sinceIso, limit = 50) {
  try {
    const since = sinceIso ? new Date(sinceIso) : new Date(Date.now() - 7 * 86400000);
    const collected = await withImap(imap, async (client) => {
      await client.mailboxOpen("INBOX", { readOnly: true });
      const out = [];
      // 取两个 body part：标准 DSN 的第 2 部分（message/delivery-status）里才有
      // Final-Recipient 与 Status，只看第 1 部分挖不出失败地址与硬软退信
      const opts = { envelope: true, source: false, bodyParts: ["1", "2"], headers: ["content-type", "auto-submitted", "return-path"] };
      for await (const msg of client.fetch({ since }, opts)) {
        const env = msg.envelope || {};
        const from = env.from?.[0] || {};
        const text = ["1", "2"]
          .map((p) => msg.bodyParts?.get(p))
          .filter(Boolean)
          .map((b) => b.toString("utf8"))
          .join("\n");
        out.push({
          uid: msg.uid,
          from: from.address || "",
          fromName: from.name || "",
          subject: env.subject || "",
          at: (env.date || new Date()).toISOString(),
          headers: msg.headers ? msg.headers.toString("utf8") : "",
          body: text.slice(0, 20000) // 正文截断：入库只做意图识别与摘要，不需要全文
        });
      }
      // 服务端不保证顺序，按时间取最近的 limit 封
      return out.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
    });

    // 退信与自动回复不能混进"客户回信"，否则会被自动建档成商机
    const messages = [];
    const bounces = [];
    collected.forEach((m) => {
      if (looksLikeBounce(m.from, m.subject, m.headers)) {
        const address = extractBouncedAddress(m.body, imap.user);
        // 挖不出失败地址的退信也不能当回信——宁可丢掉也不能污染线索池
        if (address) bounces.push({ email: address, hard: isHardBounce(m.body), subject: m.subject, at: m.at });
        return;
      }
      delete m.headers; // 头部只用于判别，别带进渲染层
      messages.push(m);
    });
    return { ok: true, messages, bounces };
  } catch (error) {
    return { ok: false, error: explain(error, "imap") };
  }
}

module.exports = {
  saveCreds,
  loadCreds,
  clearCreds,
  summary,
  testSmtp,
  sendMails,
  testImap,
  fetchInbound,
  // 导出供单测直接验：退信判别是保护发信域名的第一道关，值得单独测
  looksLikeBounce,
  extractBouncedAddress,
  isHardBounce
};
