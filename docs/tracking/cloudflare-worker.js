// 觅客舵 · 邮件打开追踪端点（Cloudflare Worker 版）
//
// 部署后你会得到一个地址，例如 https://track.你的域名.com
// 把它填进「设置 → 邮件打开追踪」，软件就会在邮件里插入指向它的 1×1 像素。
//
// 两个路径：
//   GET /t.gif?e=<id>   邮件里的像素。被打开时记一次，返回一张 1×1 透明 gif
//   GET /events         软件来拉取的地方，返回累计的打开事件
//
// 数据存在你自己的 Cloudflare KV 里。我们碰不到，也不想碰。
//
// ── 部署（约五分钟）──────────────────────────────────────────
//  1. cloudflare.com 注册（免费额度足够，每天 10 万次请求）
//  2. Workers & Pages → Create → Worker → 把这个文件整个粘进去 → Deploy
//  3. Settings → Variables → KV Namespace Bindings → 新建一个命名空间，
//     变量名填 OPENS
//  4. Settings → Variables → 加一个环境变量 TOKEN，值自己随便设一串长密码
//     （防止别人来拉你的数据）
//  5. Settings → Domains & Routes → 绑一个你自己的子域名，例如 track.你的域名.com
//     ——用自己的域名很重要：像素地址和发信域名同源，收件方更不容易判垃圾
//
// 然后在软件里填：https://track.你的域名.com/t.gif?k=<你设的TOKEN>
// 拉取地址填：    https://track.你的域名.com/events?k=<你设的TOKEN>

const GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 像素：任何人都能访问（收件人打开邮件时由邮件客户端请求，不可能带 token）
    if (url.pathname === "/t.gif") {
      const id = (url.searchParams.get("e") || "").slice(0, 64);
      if (id && env.OPENS) {
        const prev = await env.OPENS.get(id, "json");
        const rec = prev || { id, count: 0, first: null, last: null };
        rec.count += 1;
        rec.last = new Date().toISOString();
        if (!rec.first) rec.first = rec.last;
        // 存 90 天足够——软件是每天来拉的
        await env.OPENS.put(id, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 90 });
      }
      return new Response(GIF, {
        headers: {
          "Content-Type": "image/gif",
          // 不让邮件客户端缓存，否则重复打开只算一次
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache"
        }
      });
    }

    // 拉取：必须带 token，否则任何人都能看你客户的打开记录
    if (url.pathname === "/events") {
      if (!env.TOKEN || url.searchParams.get("k") !== env.TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      const list = await env.OPENS.list({ limit: 1000 });
      const events = [];
      for (const key of list.keys) {
        const rec = await env.OPENS.get(key.name, "json");
        if (!rec) continue;
        // 软件按 id 匹配发件记录。刻意不回传收件人邮箱——
        // 把邮箱明文放进像素 URL 会在邮件源码里泄漏出去。
        for (let i = 0; i < rec.count; i += 1) events.push({ id: rec.id, event: "opened", at: rec.last });
      }
      return new Response(JSON.stringify({ events }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("ok");
  }
};
