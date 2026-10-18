// Pure JS minimal PNG generator for ATOMX icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(width, height, drawFn) {
  const bytesPerPixel = 4; // RGBA
  const rowSize = 1 + width * bytesPerPixel;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * bytesPerPixel;
      const [r, g, b, a] = drawFn(x, y, width, height);
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(rawData);

  // PNG Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR Chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth: 8
  ihdr[9] = 6; // Color type: 6 (RGBA)
  ihdr[10] = 0; // Compression: 0
  ihdr[11] = 0; // Filter: 0
  ihdr[12] = 0; // Interlace: 0
  const ihdrChunk = createChunk('IHDR', ihdr);

  // IDAT Chunk
  const idatChunk = createChunk('IDAT', deflated);

  // IEND Chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[i] = c >>> 0;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function createChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(4 + 4 + len + 4);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcVal = crc32(typeAndData);
  chunk.writeUInt32BE(crcVal, 8 + len);
  return chunk;
}

// Brand draw function: Minimal luxury rounded badge with geometric 'X' mark
function drawAtomXIcon(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const r = w * 0.45;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Background rounded rect / circular pill
  const bgBlue = [49, 87, 230, 255]; // #3157E6
  const bgDark = [26, 45, 120, 255]; // darker blue gradient
  const white = [255, 255, 255, 255];

  if (dist <= r) {
    // Check if inside the geometric 'X' or atom symbol
    // Normalized coordinates -1 to 1
    const nx = (x - cx) / (r * 0.65);
    const ny = (y - cy) / (r * 0.65);

    // Thick geometric cross / X lines
    const thickness = 0.28;
    const isDiag1 = Math.abs(nx - ny) < thickness && Math.abs(nx + ny) < 1.2;
    const isDiag2 = Math.abs(nx + ny) < thickness && Math.abs(nx - ny) < 1.2;

    if (isDiag1 || isDiag2) {
      return white;
    }

    // Gradient background
    const gradFactor = (y / h);
    return [
      Math.round(bgBlue[0] * (1 - gradFactor * 0.2)),
      Math.round(bgBlue[1] * (1 - gradFactor * 0.2)),
      Math.round(bgBlue[2] * (1 - gradFactor * 0.2)),
      255
    ];
  }

  // Antialiased border
  if (dist < r + 1) {
    const alpha = Math.max(0, Math.min(255, Math.round(255 * (r + 1 - dist))));
    return [bgBlue[0], bgBlue[1], bgBlue[2], alpha];
  }

  return [0, 0, 0, 0]; // Transparent
}

const iconsDir = path.join(__dirname, 'chrome-extension', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 32, 48, 128].forEach(size => {
  const pngBuf = createPng(size, size, drawAtomXIcon);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), pngBuf);
  console.log(`Generated icon${size}.png (${size}x${size})`);
});
