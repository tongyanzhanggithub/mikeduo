// 生成品牌图标：AI 蓝绿渐变底 + 白色极简 M 航标
//
//   node tools/make-icon.mjs
//
// 产出 icon.ico（16/32/48/256 四档）与 icon.png / favicon.png（256）。
// 纯手写栅格化 + 自带 PNG/ICO 编码器，不引入任何图形依赖——打包机上不必装东西。
// 16px 档只保留粗线 M，保证任务栏和 favicon 里仍然清楚。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BLUE = [0x25, 0x63, 0xeb];
const CYAN = [0x0f, 0x9f, 0x8f];
const WHITE = [0xff, 0xff, 0xff];
const SS = 4; // 每边 4× 超采样做抗锯齿

function mix(a, b, t) {
  return a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
}

function insideRoundRect(x, y, size, radius) {
  const near = (v) => Math.min(v, size - v);
  const dx = near(x);
  const dy = near(y);
  if (dx >= radius || dy >= radius) return dx >= 0 && dy >= 0;
  const ox = radius - dx;
  const oy = radius - dy;
  return ox * ox + oy * oy <= radius * radius;
}

function distToSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const px = ax + t * vx;
  const py = ay + t * vy;
  return Math.hypot(x - px, y - py);
}

function insideAssistantMark(x, y, size) {
  const pts = [
    [size * 0.30, size * 0.70],
    [size * 0.30, size * 0.33],
    [size * 0.50, size * 0.56],
    [size * 0.70, size * 0.33],
    [size * 0.70, size * 0.70]
  ];
  const half = Math.max(size * 0.055, 0.82);
  for (let i = 0; i < pts.length - 1; i += 1) {
    if (distToSegment(x, y, ...pts[i], ...pts[i + 1]) <= half) return true;
  }
  return false;
}

function renderRGBA(size) {
  const radius = size * 0.22;
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bg = 0;
      let mark = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;
          if (!insideRoundRect(x, y, size, radius)) continue;
          bg += 1;
          if (insideAssistantMark(x, y, size)) mark += 1;
        }
      }
      const total = SS * SS;
      const alpha = bg / total;
      const markRatio = bg ? mark / bg : 0;
      const i = (py * size + px) * 4;
      const base = mix(BLUE, CYAN, (px + py) / Math.max(1, size * 2 - 2));
      for (let ch = 0; ch < 3; ch += 1) {
        out[i + ch] = Math.round(base[ch] * (1 - markRatio) + WHITE[ch] * markRatio);
      }
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

/* ---------- 极简 PNG 编码器（真彩 + alpha，滤波器恒为 0） ---------- */

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------- ICO：小尺寸用 BMP(DIB)，256 用 PNG（兼容性最好的组合） ---------- */

function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 两张图叠高
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4; // DIB 自下而上
      xor[dst] = rgba[src + 2]; // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src]; // R
      xor[dst + 3] = rgba[src + 3]; // A
    }
  }
  const andRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, xor, Buffer.alloc(andRow * size)]);
}

function encodeIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  const dirSize = 16 * entries.length;
  let offset = 6 + dirSize;
  const dirs = [];
  const blobs = [];
  entries.forEach(({ size, data }) => {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size;
    dir[1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(data.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += data.length;
    dirs.push(dir);
    blobs.push(data);
  });
  return Buffer.concat([head, ...dirs, ...blobs]);
}

const sizes = [16, 32, 48, 256];
const rendered = new Map(sizes.map((s) => [s, renderRGBA(s)]));

const ico = encodeIco(
  sizes.map((size) => ({
    size,
    data: size === 256 ? encodePng(rendered.get(256), 256) : encodeDib(rendered.get(size), size)
  }))
);
writeFileSync(join(root, "icon.ico"), ico);

const png256 = encodePng(rendered.get(256), 256);
writeFileSync(join(root, "icon.png"), png256);
writeFileSync(join(root, "favicon.png"), encodePng(renderRGBA(64), 64));

console.log(`icon.ico  ${ico.length} 字节（16/32/48/256）  sha256 ${createHash("sha256").update(ico).digest("hex").slice(0, 12)}`);
console.log(`icon.png  ${png256.length} 字节（256）`);
console.log("favicon.png 64px");
