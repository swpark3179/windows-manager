// Generates a 1024x1024 source PNG (the 4-square WinTamer mark on accent blue).
// Feed it to `tauri icon` to produce the full icon set. Pure Node, no deps.
const fs = require("fs");
const zlib = require("zlib");

const S = 1024;
const data = Buffer.alloc(S * S * 4, 0); // RGBA, transparent

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
}

// Background: accent blue, full bleed.
const A = [0, 103, 192];
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, A[0], A[1], A[2], 255);

// Four squares: TL & BR full white, TR & BL dimmed (white@65% over accent).
const sq = 300, gap = 64, total = sq * 2 + gap;
const ox = (S - total) / 2, oy = (S - total) / 2;
const WF = [255, 255, 255];
const WD = [166, 202, 233];
function fillSq(cx, cy, c) {
  for (let y = 0; y < sq; y++) for (let x = 0; x < sq; x++) set(ox + cx + x, oy + cy + y, c[0], c[1], c[2], 255);
}
fillSq(0, 0, WF);
fillSq(sq + gap, 0, WD);
fillSq(0, sq + gap, WD);
fillSq(sq + gap, sq + gap, WF);

// --- PNG encode ---
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, body])), 0);
  return Buffer.concat([len, t, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  data.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, y * S * 4 + S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);

const out = process.argv[2] || "icon-src.png";
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
