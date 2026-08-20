// 网络探测（主进程）：抓官网、查 DNS、验邮箱是否真实存在
//
// 为什么这些必须在主进程做：渲染层受同源策略限制，抓不了别人家的官网；
// 更关键的是 DNS 查询和 SMTP 握手需要 node 的 dns/net 模块，浏览器根本没有。
//
// 为什么这件事"本地应用"比云端 SaaS 更有优势——这点被严重低估了：
// 邮箱存在性探测（RCPT）和官网抓取，如果由云端服务集中发起，几万用户共用
// 几个出口 IP，很快就会被目标邮件服务器和 CDN 拉黑，所以云端产品要么不做、
// 要么只能买第三方接口。我们从用户自己的机器、自己的 IP 出发，一天几百次
// 的量完全在正常范围内，反而做得成。
//
// 全模块零第三方依赖，只用 node 内置。
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns").promises;

// 抓页面时表明身份。伪装成浏览器能提高抓取成功率，但那是不诚实的做法，
// 也让对方站长无法屏蔽我们——留一个可识别的 UA 和说明页是基本礼貌。
const UA = "MikeduoBot/1.0 (+https://github.com/tongyanzhanggithub/mikeduo; contact-page lookup)";

const FETCH_TIMEOUT = 12000;
const MAX_BYTES = 1.5 * 1024 * 1024; // 官网首页再大也不该超过这个数，超了多半是下载链接
const MAX_REDIRECTS = 4;

// ---------------------------------------------------------------- HTTP 抓取

function requestOnce(url, redirectsLeft) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, reason: "网址格式不对", url });
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      resolve({ ok: false, reason: "只支持 http/https", url });
      return;
    }

    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      target,
      {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en,zh-CN;q=0.8"
        },
        timeout: FETCH_TIMEOUT,
        // 自签/过期证书在中小企业官网上很常见。抓公开页面读联系方式，
        // 证书有没有问题不影响这件事本身的安全性（我们不发送任何凭据）。
        rejectUnauthorized: false
      },
      (res) => {
        const code = res.statusCode || 0;

        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            resolve({ ok: false, reason: "跳转次数过多", url });
            return;
          }
          const next = new URL(res.headers.location, target).toString();
          resolve(requestOnce(next, redirectsLeft - 1));
          return;
        }

        if (code !== 200) {
          res.resume();
          resolve({ ok: false, reason: `HTTP ${code}`, url: target.toString(), status: code });
          return;
        }

        const type = String(res.headers["content-type"] || "");
        if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
          res.resume();
          resolve({ ok: false, reason: `不是网页（${type.split(";")[0]}）`, url: target.toString() });
          return;
        }

        let size = 0;
        const chunks = [];
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          resolve({
            ok: true,
            url: target.toString(),
            html: Buffer.concat(chunks).toString("utf8"),
            bytes: size
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "超时", url });
    });
    req.on("error", (e) => {
      // 原始错误码要一起带出去。译成中文的 reason 是给人看的，
      // 但「域名根本解析不到」和「对方站慢/拦爬虫」在程序里必须分得开：
      // 前者能断定这个域名是假的，后者只是这次没抓着，不能据此判死。
      resolve({ ok: false, reason: friendlyNetError(e), code: (e && e.code) || "", url });
    });
    req.end();
  });
}

// 把 node 的错误码翻译成用户能看懂、并且知道该怎么办的话
function friendlyNetError(e) {
  const code = e && e.code;
  if (code === "ENOTFOUND") return "域名解析不到（网站可能已经关了）";
  if (code === "ECONNREFUSED") return "对方拒绝连接";
  if (code === "ETIMEDOUT" || code === "ECONNRESET") return "连接超时或被重置";
  if (code === "EPROTO" || code === "ERR_TLS_CERT_ALTNAME_INVALID") return "HTTPS 握手失败";
  return (e && e.message) || "网络错误";
}

function fetchPage(url) {
  return requestOnce(url, MAX_REDIRECTS);
}

// ------------------------------------------------------------- robots.txt

// 按域名缓存，一次任务里同一个站只取一次
const robotsCache = new Map();

async function robotsDisallows(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const res = await fetchPage(`${origin}/robots.txt`).catch(() => null);
  let rules = [];
  if (res && res.ok && res.html && res.html.length < 200000) {
    // 只认 * 段和点名我们的段；其它 UA 的规则与我们无关
    let active = false;
    for (const rawLine of res.html.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
      if (!m) continue;
      const field = m[1].toLowerCase();
      const value = m[2].trim();
      if (field === "user-agent") {
        active = value === "*" || /mikeduo/i.test(value);
      } else if (active && field === "disallow" && value) {
        rules.push(value);
      }
    }
  }
  robotsCache.set(origin, rules);
  return rules;
}

function robotsAllows(rules, pathname) {
  // 前缀匹配，够用。整站封禁（Disallow: /）会被正确识别。
  return !rules.some((rule) => pathname.startsWith(rule));
}

// -------------------------------------------------------- 联系方式提取

// 这些邮箱不是客户的联系方式：图片占位、示例、以及建站商自己的地址
const JUNK_EMAIL =
  /^(example|test|your|name|email|user|someone|no-?reply|noreply|donotreply|postmaster|abuse|webmaster|hostmaster|admin@localhost|sentry|wordpress|wix|squarespace|godaddy|domain)/i;
const JUNK_EMAIL_DOMAIN = /(example\.(com|org|net)|yourdomain|domain\.com|email\.com|sentry\.io|wixpress|godaddy|w3\.org|schema\.org)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js)$/i;

// 通用信箱排序：采购相关的最有用，info 最泛
const MAILBOX_RANK = [
  /^(purchas|procure|buying|buyer|sourcing|import)/i,
  /^(sales|business|bd|commercial|trade|export)/i,
  /^(contact|enquir|inquir|hello|hi)$/i,
  /^(info|office|mail|general|admin)/i
];

function rankEmail(email) {
  const local = email.split("@")[0];
  for (let i = 0; i < MAILBOX_RANK.length; i += 1) {
    if (MAILBOX_RANK[i].test(local)) return i;
  }
  return MAILBOX_RANK.length; // 个人名字信箱排最后：可能是真人，但不一定对口
}

function extractEmails(html, sourceUrl) {
  const found = new Map();

  const push = (raw, how) => {
    const email = String(raw || "")
      .trim()
      .replace(/^mailto:/i, "")
      .split("?")[0]
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(email)) return;
    if (IMAGE_EXT.test(email)) return;
    const [local, domain] = email.split("@");
    if (JUNK_EMAIL.test(local)) return;
    if (JUNK_EMAIL_DOMAIN.test(domain)) return;
    if (found.has(email)) return;
    found.set(email, { email, sourceUrl, how, rank: rankEmail(email) });
  };

  // mailto: 最可靠——是站长明确写出来给人联系的
  for (const m of html.matchAll(/mailto:([^"'>\s<)]+)/gi)) push(m[1], "mailto");

  // 正文明文邮箱
  for (const m of html.matchAll(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}\b/gi)) push(m[0], "text");

  // 防爬虫的常见写法：name [at] domain [dot] com
  for (const m of html.matchAll(
    /\b([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\s+at\s+)\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*([a-z]{2,24})\b/gi
  )) {
    push(`${m[1]}@${m[2]}.${m[3]}`, "obfuscated");
  }

  return [...found.values()].sort((a, b) => a.rank - b.rank);
}

// 只认 tel: 和 phone 的话，外贸网站上最常见的几种写法全会漏：
// "WhatsApp: +86 138..."、"Mob: ..."、"Cell: ..."、"M: ..."。外贸客户尤其
// 爱把 WhatsApp 号单独列出来，漏掉它等于把最容易触达的渠道丢了。
const PHONE_LABEL = "tel|telephone|phone|mobile|mob|cell|whats\\s?app|wa|contact";

function extractPhones(html) {
  const out = new Set();
  const add = (raw) => {
    const digits = String(raw).replace(/[^\d+]/g, "");
    // 7 位是最短的可拨号码；20 位以上基本是把订单号错当电话
    const n = digits.replace(/\D/g, "").length;
    if (n >= 7 && n <= 15) out.add(digits);
  };
  for (const m of html.matchAll(
    new RegExp(`(?:tel:|(?:${PHONE_LABEL})[^0-9+]{0,12})(\\+?[\\d][\\d\\s().-]{6,20}\\d)`, "gi")
  )) {
    add(m[1]);
  }
  return [...out].slice(0, 5);
}

// wa.me/8613800138000 与 api.whatsapp.com/send?phone=... 里的数字**就是**
// WhatsApp 号本身，比任何标签旁边的号码都可靠——单独抽出来，别只当社媒链接存着。
function extractWhatsappPhone(html) {
  const m = /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?phone=)(\+?\d{7,15})/i.exec(html);
  if (!m) return "";
  const digits = m[1].replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 7 ? (digits.startsWith("+") ? digits : `+${digits}`) : "";
}

function extractSocial(html, baseUrl) {
  const out = {};
  const grab = (re, key) => {
    const m = re.exec(html);
    if (m && !out[key]) out[key] = m[0].startsWith("http") ? m[0] : `https://${m[0]}`;
  };
  grab(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_%-]+/i, "linkedin");
  grab(/(?:https?:\/\/)?(?:www\.)?facebook\.com\/[A-Za-z0-9._-]{3,}/i, "facebook");
  grab(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/[A-Za-z0-9._]{3,}/i, "instagram");
  grab(/(?:https?:\/\/)?(?:www\.)?twitter\.com\/[A-Za-z0-9_]{3,}/i, "twitter");
  grab(/(?:https?:\/\/)?wa\.me\/\d{7,15}/i, "whatsapp");
  // 站内相对路径会被上面的正则漏掉，这里不强求——社媒链接基本都是绝对地址
  void baseUrl;
  return out;
}

// 抓正文里能用来写开发信的**具体事实**。
//
// 为什么这件事有战略意义：竞品靠海关记录做个性化（"你 3 月进口过 X"），
// 但那只对有海关记录的公司有效。官网人人都有——而且引用对方官网上的
// 具体产品和新闻，比引用一条采购记录更难被识破为模板。
//
// 同样的红线：只摘录，不概括、不推断。每条都带出处 URL，用户点开就能核对。
function extractFacts(html, sourceUrl) {
  const facts = [];
  const clean = (s) =>
    String(s || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

  const add = (kind, text) => {
    const t = clean(text);
    if (t.length < 12 || t.length > 300) return;
    if (facts.some((f) => f.text === t)) return;
    facts.push({ kind, text: t, sourceUrl });
  };

  // 站点自我描述：这两个字段是企业自己写的一句话介绍，最适合开头引用
  const metaDesc = /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']{20,300})["']/i.exec(html);
  if (metaDesc) add("描述", metaDesc[1]);
  const ogDesc = /<meta[^>]+property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']{20,300})["']/i.exec(html);
  if (ogDesc) add("描述", ogDesc[1]);

  const title = /<title[^>]*>([^<]{4,140})<\/title>/i.exec(html);
  if (title) add("标题", title[1]);

  // 小标题往往就是产品线/业务范围
  for (const m of html.matchAll(/<h[123][^>]*>([\s\S]{4,140}?)<\/h[123]>/gi)) {
    if (facts.filter((f) => f.kind === "小标题").length >= 6) break;
    const t = clean(m[1]);
    if (/^(home|about|contact|menu|search|login|首页|关于|联系)$/i.test(t)) continue;
    add("小标题", t);
  }

  return facts.slice(0, 10);
}

// 判断这一页是不是「JS 渲染出来的空壳」。
//
// 为什么必须判：我们只取 HTML 不执行 JS。用 React/Vue/Next/Wix 做的官网，
// 联系方式是浏览器跑完脚本才出现的，我们抓到的是一个空 div。
// 而现在的提示是「抓了 N 页，没有公示邮箱」——**用户会以为是对方没写，
// 其实是我们抓不到**。这违反了项目一直坚持的「测不出就说测不出」。
//
// 判据分两类：框架特征（准）、以及正文占比过低（兜底）。
const SPA_MARKERS = [
  { re: /<div[^>]+id=["'](root|app|__next|__nuxt|q-app)["'][^>]*>\s*<\/div>/i, name: "空的挂载容器" },
  { re: /__NEXT_DATA__/, name: "Next.js" },
  { re: /window\.__NUXT__/, name: "Nuxt" },
  { re: /window\.__INITIAL_STATE__/, name: "前端状态注入" },
  { re: /ng-version=|<app-root/i, name: "Angular" },
  { re: /data-reactroot|react(-dom)?\.production/i, name: "React" },
  { re: /static\.parastorage\.com|_wixCssModules|wixstatic/i, name: "Wix" },
  { re: /cdn\.shopify\.com|Shopify\.shop/i, name: "Shopify" },
  { re: /squarespace\.com\/universal|Static\.SQUARESPACE_CONTEXT/i, name: "Squarespace" }
];

function visibleTextLength(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function detectRenderMode(html) {
  const src = String(html || "");
  const hits = SPA_MARKERS.filter((m) => m.re.test(src)).map((m) => m.name);
  const textLen = visibleTextLength(src);
  // 这里刻意用字符类而不是词边界：用脚本生成代码时，词边界的转义序列极易
  // 在中转中被解释成控制字符，正则从此永远匹配不上、也不报错。已栽过两次。
  const scripts = (src.match(/<script[\s>]/gi) || []).length;

  // 框架特征 + 正文很少 → 基本可以断定是空壳
  if (hits.length && textLen < 600) return { mode: "spa", why: hits.slice(0, 2).join(" / "), textLen };
  // 没有框架特征，但正文极少而脚本很多 → 也当成疑似
  if (textLen < 250 && scripts >= 3) return { mode: "spa", why: `正文只有 ${textLen} 字、却有 ${scripts} 段脚本`, textLen };
  // 有框架特征但正文够多：说明是服务端渲染过的，照常抓
  if (hits.length) return { mode: "static", why: `${hits[0]}（已服务端渲染）`, textLen };
  return { mode: "static", why: "", textLen };
}

// 从页面里挑出最可能有联系方式的内链
const CONTACT_HINT =
  /(contact|about|impressum|kontakt|contacto|contatti|nous-contacter|team|company|imprint|legal|support|reach-us|get-in-touch|联系|关于)/i;

function contactLinks(html, baseUrl) {
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ");
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (!CONTACT_HINT.test(href) && !CONTACT_HINT.test(text)) continue;
    let abs;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      continue;
    }
    // 只跟自己站内的链接：跳到 facebook 的 "contact us" 没有意义
    if (abs.hostname.replace(/^www\./, "") !== new URL(baseUrl).hostname.replace(/^www\./, "")) continue;
    if (IMAGE_EXT.test(abs.pathname)) continue;
    abs.hash = "";
    if (!out.has(abs.toString())) out.set(abs.toString(), abs);
  }
  return [...out.values()].slice(0, 4);
}

// 抓一个公司官网，尽力找出真实联系方式。
// 绝不猜、绝不拼——找不到就是找不到，返回空数组。
/* 首页抓不到时，判断这到底是「域名不存在」还是「只是这次没抓着」。
   调用方（入池体检）拿 ENOTFOUND 当作把线索判死的依据，所以这里的口径
   必须严：错判一家真公司出局，比放进来一家假的代价大得多。

   ① visited 为空 —— 请求压根没发出去（robots.txt 整站封禁），
      这不是域名的问题，绝不能报 ENOTFOUND。
   ② https 失败会退到 http 再试一次，两条记录都在 visited 里。
      只要任何一次拿到过 ENOTFOUND 以外的结果，就说明域名解析得到，
      只是这次没抓着（超时、403、拦爬虫、证书问题）。 */
function resolveFailCode(visited) {
  if (!visited.length) return "";
  if (visited.every((v) => v.code === "ENOTFOUND")) return "ENOTFOUND";
  return visited[visited.length - 1].code || "";
}

async function harvestSite(website, opts = {}) {
  const maxPages = Math.max(1, Math.min(6, opts.maxPages || 4));
  const raw = String(website || "").trim();
  if (!raw) return { ok: false, reason: "没有网址" };

  const base = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    return { ok: false, reason: "网址格式不对" };
  }

  const rules = await robotsDisallows(origin);
  const visited = [];
  const emails = new Map();
  const phones = new Set();
  const facts = [];
  let social = {};
  let whatsappPhone = "";
  let blockedByRobots = 0;
  // 首页的渲染模式最有代表性（内页常常本来就短），decided 保证只认第一次
  let render = { mode: "static", why: "", textLen: 0, decided: false };

  const visit = async (url) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (!robotsAllows(rules, u.pathname)) {
      blockedByRobots += 1;
      return null;
    }
    const res = await fetchPage(u.toString());
    visited.push({ url: u.toString(), ok: res.ok, reason: res.reason || "", code: res.code || "" });
    if (!res.ok) return null;
    extractEmails(res.html, res.url).forEach((e) => {
      if (!emails.has(e.email)) emails.set(e.email, e);
    });
    extractPhones(res.html).forEach((p) => phones.add(p));
    if (!whatsappPhone) whatsappPhone = extractWhatsappPhone(res.html);
    social = { ...extractSocial(res.html, res.url), ...social };
    extractFacts(res.html, res.url).forEach((f) => {
      if (facts.length < 14 && !facts.some((x) => x.text === f.text)) facts.push(f);
    });
    return res;
  };

  // 首页失败时退到 http：不少中小企业站还没上 https
  let home = await visit(base);
  if (!home && base.startsWith("https://")) {
    home = await visit(base.replace(/^https:/, "http:"));
  }
  if (!home) {
    return {
      ok: false,
      reason: visited.length ? visited[visited.length - 1].reason || "打不开" : "打不开",
      code: resolveFailCode(visited),
      visited,
      blockedByRobots
    };
  }

  for (const link of contactLinks(home.html, home.url)) {
    if (visited.length >= maxPages) break;
    await visit(link.toString());
  }

  // 首页没有 contact 链接时，试几个约定俗成的路径
  if (emails.size === 0 && visited.length < maxPages) {
    for (const guessPath of ["/contact", "/contact-us", "/about", "/about-us"]) {
      if (visited.length >= maxPages) break;
      if (visited.some((v) => v.url.endsWith(guessPath))) continue;
      await visit(`${origin}${guessPath}`);
      if (emails.size) break;
    }
  }

  const list = [...emails.values()].sort((a, b) => a.rank - b.rank);
  const siteDomain = new URL(home.url).hostname.replace(/^www\./, "");

  return {
    ok: true,
    site: home.url,
    // 同域邮箱优先——第三方托管的邮箱（gmail 等）也保留，但排后面
    emails: list
      .map((e) => ({ ...e, sameDomain: e.email.split("@")[1] === siteDomain }))
      .sort((a, b) => Number(b.sameDomain) - Number(a.sameDomain) || a.rank - b.rank),
    // wa.me 里的号码排在最前：它是对方自己挂出来的 WhatsApp 入口，能直接聊
    phones: [...new Set([whatsappPhone, ...phones].filter(Boolean))],
    whatsappPhone,
    social,
    facts,
    // 这一页是不是 JS 渲染出来的空壳。抓不到东西时，这个字段决定我们该说
    // 「对方没公示」还是「我们抓不到」——两句话对用户的意义完全不同。
    renderMode: render.mode,
    renderWhy: render.why,
    visited,
    blockedByRobots
  };
}

// ------------------------------------------------------------------- DNS

// 为什么不能只信系统 DNS —— 这是实测出来的坑，不是理论担心：
//
//   查 github.com 的 TXT      系统默认 8 条(无 SPF) / 8.8.8.8 22 条(有 SPF)
//                             1.1.1.1 22 条(有 SPF) / 223.5.5.5 17 条(无 SPF)
//
// 国内 DNS 普遍返回残缺的 TXT。如果据此告诉一个「已经配了 SPF」的用户
// "你没有 SPF，去加一条"，他加上第二条之后——按 RFC 7208，多条 SPF 直接
// 判为 permerror，等于没配。**我们会亲手把他的送达率搞坏。**
//
// 所以：并行问多个解析器取并集（污染只会抹掉记录，不会凭空造出合法 SPF），
// 并且记录"有没有问到过可信解析器"。问不到就老实说查不准，绝不说"没有"。
const PUBLIC_RESOLVERS = ["8.8.8.8", "1.1.1.1", "9.9.9.9"];

async function txtFrom(server, name) {
  const { Resolver } = require("node:dns").promises;
  const r = new Resolver({ timeout: 4000, tries: 1 });
  if (server) r.setServers([server]);
  try {
    return { ok: true, records: (await r.resolveTxt(name)).map((parts) => parts.join("")) };
  } catch (e) {
    // NODATA/NOTFOUND 是"确实没有这条记录"，属于可信的否定答案
    const definite = e && (e.code === "ENODATA" || e.code === "ENOTFOUND");
    return { ok: definite, records: [], code: e && e.code };
  }
}

// 返回 { records, trusted } —— trusted 为假时，"没找到"不可当成"没有"
async function txtChecked(name) {
  const answers = await Promise.all([txtFrom(null, name), ...PUBLIC_RESOLVERS.map((s) => txtFrom(s, name))]);
  const trusted = answers.slice(1).some((a) => a.ok);
  const set = new Set();
  answers.forEach((a) => a.records.forEach((r) => set.add(r)));
  return { records: [...set], trusted };
}

async function txt(name) {
  return (await txtChecked(name)).records;
}

// 常见 DKIM selector。DKIM 的 selector 无法枚举，只能试——
// 试不到不代表没配，所以结论里要说清楚这一点，不能报"没有 DKIM"。
const DKIM_SELECTORS = [
  "default", "google", "selector1", "selector2", "k1", "k2", "mail",
  "dkim", "s1", "s2", "zoho", "mandrill", "mailjet", "sendgrid",
  "everlytickey1", "smtp", "key1", "mx"
];

// 给一个发信域名做体检。很多 SOHO 根本没配 SPF/DKIM/DMARC，
// 配好之后送达率能有肉眼可见的提升——这是立竿见影的价值。
async function domainHealth(domain) {
  const d = String(domain || "").trim().toLowerCase().replace(/^@/, "").replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) {
    return { ok: false, reason: "域名格式不对" };
  }

  const [mx, root, dmarcTxt] = await Promise.all([
    dns.resolveMx(d).catch(() => []),
    txtChecked(d),
    txtChecked(`_dmarc.${d}`)
  ]);

  const spfRecords = root.records.filter((r) => /^v=spf1/i.test(r.trim()));
  const dmarcRecord = dmarcTxt.records.find((r) => /^v=DMARC1/i.test(r.trim())) || "";

  const dkimHits = [];
  await Promise.all(
    DKIM_SELECTORS.map(async (sel) => {
      const recs = await txt(`${sel}._domainkey.${d}`);
      if (recs.some((r) => /v=DKIM1|p=/i.test(r))) dkimHits.push(sel);
    })
  );

  // DNS 不可信时的统一措辞：宁可说"查不准"，也不能让用户去加一条重复的 SPF
  const unreliable = (what, extra) => ({
    level: "unknown",
    title: `${what} 查不准`,
    detail: `问不到可信的公共 DNS（8.8.8.8 / 1.1.1.1 / 9.9.9.9 都没答上来），只有本机 DNS 的结果。国内网络下本机 DNS 常返回残缺的 TXT 记录，据此下结论会出错。${extra || ""}`,
    fix: "换个网络再测一次；或者去域名服务商后台直接看一眼 TXT 记录。"
  });

  const checks = [];

  // —— MX ——
  checks.push(
    mx.length
      ? { key: "mx", level: "ok", title: "MX 记录正常", detail: `收信服务器 ${mx.length} 台：${mx.map((r) => r.exchange).slice(0, 3).join("、")}` }
      : { key: "mx", level: "bad", title: "查不到 MX 记录", detail: "这个域名收不了信。客户回复会退回去，你永远收不到。", fix: "去域名服务商后台加 MX 记录，指向你的邮箱服务商。" }
  );

  // —— SPF ——
  if (!spfRecords.length && !root.trusted) {
    checks.push({ key: "spf", ...unreliable("SPF", "这一项尤其危险：如果你其实已经配了 SPF，我们却让你再加一条，两条 SPF 会直接判为无效。") });
  } else if (!spfRecords.length) {
    checks.push({
      key: "spf",
      level: "bad",
      title: "没有 SPF 记录",
      detail: "收件方无法确认这封信是不是真从你的域名发出的，进垃圾箱的概率大幅上升。这是最常见也最影响送达率的一项。",
      fix: `加一条 TXT 记录：主机名 @，值 v=spf1 include:你的邮箱服务商 ~all（例：腾讯企业邮 include:spf.mail.qq.com）`
    });
  } else if (spfRecords.length > 1) {
    checks.push({
      key: "spf",
      level: "bad",
      title: `有 ${spfRecords.length} 条 SPF 记录（只能有 1 条）`,
      detail: "多条 SPF 按标准是无效的，等于没配。多半是换邮箱服务商时旧的没删。",
      fix: "合并成一条，把多个 include 写在同一条记录里。"
    });
  } else {
    const spf = spfRecords[0];
    const all = /([-~?+])all\b/i.exec(spf);
    const lookups = (spf.match(/\b(include|a|mx|ptr|exists|redirect):?/gi) || []).length;
    let level = "ok";
    let detail = `记录：${spf}`;
    let fix = "";
    if (all && all[1] === "+") {
      level = "bad";
      detail += "。结尾是 +all，等于允许任何人冒用你的域名发信——比不配还糟。";
      fix = "把 +all 改成 ~all。";
    } else if (!all) {
      level = "warn";
      detail += "。结尾没有 all 机制，不同收件方处理不一致。";
      fix = "在结尾加 ~all。";
    }
    if (lookups > 10) {
      level = level === "bad" ? "bad" : "warn";
      detail += `。DNS 查询数约 ${lookups} 次，超过标准上限 10 次会被判为 permerror。`;
      fix = (fix ? fix + " " : "") + "减少 include，或用服务商提供的 SPF 展平功能。";
    }
    checks.push({ key: "spf", level, title: level === "ok" ? "SPF 配置正常" : "SPF 有问题", detail, fix });
  }

  // —— DKIM ——
  checks.push(
    dkimHits.length
      ? { key: "dkim", level: "ok", title: "DKIM 已配置", detail: `探测到 selector：${dkimHits.join("、")}` }
      : {
          key: "dkim",
          level: "warn",
          title: "没探测到 DKIM",
          detail: `DKIM 的 selector 名字无法枚举，我们试了 ${DKIM_SELECTORS.length} 个常见的都没命中。**这不一定代表你没配**——如果你的服务商用了自定义 selector，就属于正常。`,
          fix: "去邮箱服务商后台确认 DKIM 是否开启；没开就开一下，对送达率有实打实的帮助。"
        }
  );

  // —— DMARC ——
  if (!dmarcRecord && !dmarcTxt.trusted) {
    checks.push({ key: "dmarc", ...unreliable("DMARC") });
  } else if (!dmarcRecord) {
    checks.push({
      key: "dmarc",
      level: "warn",
      title: "没有 DMARC 记录",
      detail: "别人可以冒用你的域名发钓鱼邮件，而你收不到任何报告。Gmail 和 Yahoo 现在对批量发信方强制要求 DMARC。",
      fix: "加 TXT 记录：主机名 _dmarc，值 v=DMARC1; p=none; rua=mailto:你的邮箱。先用 p=none 观察，别一上来就 reject。"
    });
  } else {
    const policy = (/[;\s]p=([a-z]+)/i.exec(dmarcRecord) || [])[1] || "";
    checks.push({
      key: "dmarc",
      level: "ok",
      title: `DMARC 已配置（p=${policy || "?"}）`,
      detail: `记录：${dmarcRecord}`,
      fix: policy === "none" ? "观察一段时间没问题后，可以逐步收紧到 quarantine。" : ""
    });
  }

  const bad = checks.filter((c) => c.level === "bad").length;
  const warn = checks.filter((c) => c.level === "warn").length;
  const unknownN = checks.filter((c) => c.level === "unknown").length;

  // 查不准的项不扣分也不加分——把"没查到"算成"不合格"就是另一种编造
  const scorable = checks.length - unknownN;
  const score = scorable ? Math.max(0, Math.round(((scorable - bad - warn * 0.4) / scorable) * 100)) : null;

  return {
    ok: true,
    domain: d,
    dnsTrusted: root.trusted,
    score,
    grade: score === null ? "?" : score >= 90 ? "A" : score >= 75 ? "B" : score >= 55 ? "C" : "D",
    checks,
    summary: unknownN && !bad && !warn
      ? `${unknownN} 项查不准（换个网络再试）`
      : bad
      ? `${bad} 项必须修${unknownN ? `，${unknownN} 项查不准` : ""}`
      : warn
      ? `${warn} 项建议改进${unknownN ? `，${unknownN} 项查不准` : ""}`
      : "全部正常"
  };
}

// ------------------------------------------------- 邮箱存在性探测（RCPT）

// 很多家用/办公宽带封了出站 25 端口。封了就是探测不了，这时候必须
// 老实说"探测不了"，绝不能把探测失败当成"地址无效"——那会误杀真客户。
let port25Blocked = null;

function smtpDialog(host, probes, fromDomain) {
  return new Promise((resolve) => {
    const results = {};
    let stage = 0;
    let buffer = "";
    let settled = false;

    const socket = net.createConnection({ host, port: 25, timeout: 10000 });

    const done = (payload) => {
      if (settled) return;
      settled = true;
      try {
        socket.write("QUIT\r\n");
      } catch {}
      socket.destroy();
      resolve(payload);
    };

    socket.on("timeout", () => done({ ok: false, reason: "timeout", results }));
    socket.on("error", (e) => done({ ok: false, reason: e.code || "error", results }));

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // SMTP 多行响应：最后一行是「代码空格」，中间是「代码减号」
      const lines = buffer.split(/\r?\n/);
      const last = lines.filter(Boolean).pop() || "";
      if (!/^\d{3} /.test(last)) return;
      const code = parseInt(last.slice(0, 3), 10);
      buffer = "";

      if (stage === 0) {
        if (code !== 220) return done({ ok: false, reason: `greeting ${code}`, results });
        socket.write(`EHLO ${fromDomain}\r\n`);
        stage = 1;
      } else if (stage === 1) {
        if (code !== 250) return done({ ok: false, reason: `ehlo ${code}`, results });
        socket.write(`MAIL FROM:<probe@${fromDomain}>\r\n`);
        stage = 2;
      } else if (stage === 2) {
        if (code !== 250) return done({ ok: false, reason: `mailfrom ${code}`, results });
        socket.write(`RCPT TO:<${probes[0]}>\r\n`);
        stage = 3;
      } else {
        const idx = stage - 3;
        results[probes[idx]] = code;
        if (idx + 1 < probes.length) {
          socket.write(`RCPT TO:<${probes[idx + 1]}>\r\n`);
          stage += 1;
        } else {
          done({ ok: true, results });
        }
      }
    });
  });
}

// 判断一个邮箱地址在对方服务器上是否真实存在。
//
// 做法：连对方 MX 的 25 端口，走到 RCPT TO 就停，不发信、不打扰任何人。
// 同时探一个随机地址——如果随机地址也说"存在"，那这个域名是 catch-all，
// 任何地址都会被接受，这时候必须诚实地报"测不出"，而不是报"有效"。
async function verifyEmail(email, opts = {}) {
  const addr = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(addr)) {
    return { email: addr, status: "invalid", reason: "地址格式不对" };
  }
  const domain = addr.split("@")[1];

  let mx = [];
  try {
    mx = await dns.resolveMx(domain);
  } catch {
    return { email: addr, status: "invalid", reason: "这个域名没有 MX 记录，收不了信" };
  }
  if (!mx.length) return { email: addr, status: "invalid", reason: "这个域名没有 MX 记录，收不了信" };

  if (opts.mxOnly) {
    return { email: addr, status: "unknown", reason: "域名可以收信；未做深度探测", mx: mx[0].exchange };
  }

  if (port25Blocked) {
    return { email: addr, status: "unknown", reason: "本机 25 端口出站被网络封锁，无法深度探测", mx: mx[0].exchange };
  }

  const host = mx.sort((a, b) => a.priority - b.priority)[0].exchange;
  const random = `mkd-probe-${Math.random().toString(36).slice(2, 12)}@${domain}`;
  const fromDomain = opts.fromDomain || "example.com";

  const res = await smtpDialog(host, [addr, random], fromDomain);

  if (!res.ok) {
    if (res.reason === "ECONNREFUSED" || res.reason === "timeout" || res.reason === "ETIMEDOUT") {
      port25Blocked = true;
      return {
        email: addr,
        status: "unknown",
        reason: "连不上对方 25 端口（多半是你的网络封了出站 25，家用宽带很常见）",
        mx: host
      };
    }
    return { email: addr, status: "unknown", reason: `探测中断（${res.reason}）`, mx: host };
  }

  const code = res.results[addr];
  const randomCode = res.results[random];

  if (randomCode >= 200 && randomCode < 300) {
    return {
      email: addr,
      status: "catch-all",
      reason: "对方域名接受任何地址（catch-all），这个地址存不存在测不出来",
      mx: host
    };
  }
  if (code >= 200 && code < 300) {
    return { email: addr, status: "valid", reason: "对方服务器确认这个地址存在", mx: host };
  }
  if (code >= 500 && code < 600) {
    return { email: addr, status: "invalid", reason: `对方服务器拒收这个地址（${code}）`, mx: host };
  }
  return { email: addr, status: "unknown", reason: `对方服务器暂时未给出结论（${code}）`, mx: host };
}

function resetProbeState() {
  port25Blocked = null;
  robotsCache.clear();
}

module.exports = {
  fetchPage,
  harvestSite,
  domainHealth,
  verifyEmail,
  resetProbeState,
  // 导出给单测用
  _internals: {
    extractEmails,
    extractPhones,
    extractWhatsappPhone,
    extractSocial,
    extractFacts,
    contactLinks,
    rankEmail,
    robotsAllows,
    resolveFailCode,
    detectRenderMode,
    visibleTextLength
  }
};
