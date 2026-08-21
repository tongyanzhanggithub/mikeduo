// 觅客舵 · 邮件打开追踪端点（Vercel 版）
//
// 放到项目的 api/track.js，并配一个 Vercel KV（或 Upstash Redis）。
// 访问地址会是 https://你的项目.vercel.app/api/track
//
//   /api/track?e=<id>        像素，返回 1×1 gif 并记一次
//   /api/track?events=1&k=…  软件来拉取的地方
//
// 部署：
//  1. 新建一个空 Node 项目，把这个文件放到 api/track.js
//  2. vercel.com 导入该仓库 → Storage → Create KV → 连到这个项目
//  3. Settings → Environment Variables 加 TOKEN，值自己设一串长密码
//  4. Deploy。建议再绑一个自己的子域名（和发信域名同源，更不容易判垃圾）

import { kv } from "@vercel/kv";

const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export default async function handler(req, res) {
  const { e, events, k } = req.query;

  // 拉取：必须带 token
  if (events) {
    if (!process.env.TOKEN || k !== process.env.TOKEN) return res.status(403).end("forbidden");
    const ids = await kv.smembers("mkd:ids");
    const out = [];
    for (const id of ids || []) {
      const rec = await kv.get(`mkd:${id}`);
      if (!rec) continue;
      for (let i = 0; i < rec.count; i += 1) out.push({ id, event: "opened", at: rec.last });
    }
    return res.status(200).json({ events: out });
  }

  // 像素：不需要 token（邮件客户端请求时带不了）
  const id = String(e || "").slice(0, 64);
  if (id) {
    const rec = (await kv.get(`mkd:${id}`)) || { count: 0, first: null, last: null };
    rec.count += 1;
    rec.last = new Date().toISOString();
    if (!rec.first) rec.first = rec.last;
    await kv.set(`mkd:${id}`, rec, { ex: 60 * 60 * 24 * 90 });
    await kv.sadd("mkd:ids", id);
  }
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  return res.status(200).send(GIF);
}
