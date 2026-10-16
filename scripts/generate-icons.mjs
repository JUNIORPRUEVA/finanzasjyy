/**
 * GENERADOR DE ICONOS DE LA PWA
 * -----------------------------
 * Genera los PNG que el manifiesto necesita (192, 512 y el icono de iOS) SIN
 * dependencias externas: se construye el PNG a mano (cabecera IHDR + IDAT
 * comprimido con zlib + IEND). Así el proyecto no arrastra una librería de
 * imagen sólo para tener iconos.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'apps', 'web', 'public');

// Paleta de FINANZA.
const BACKGROUND = [11, 18, 32, 255]; // #0b1220
const FOREGROUND = [52, 211, 153, 255]; // #34d399 (verde «entra dinero»)

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** ¿El píxel (x, y) forma parte de la letra «F»? */
function isForeground(x, y, size) {
  const left = size * 0.3;
  const right = size * 0.72;
  const stemRight = size * 0.42;
  const top = size * 0.22;
  const bottom = size * 0.78;
  const topBarBottom = size * 0.34;
  const midTop = size * 0.45;
  const midBottom = size * 0.57;
  const midRight = size * 0.64;

  const inStem = x >= left && x <= stemRight && y >= top && y <= bottom;
  const inTopBar = x >= left && x <= right && y >= top && y <= topBarBottom;
  const inMidBar = x >= left && x <= midRight && y >= midTop && y <= midBottom;
  return inStem || inTopBar || inMidBar;
}

function buildPng(size) {
  const bytesPerRow = size * 4 + 1;
  const raw = Buffer.alloc(bytesPerRow * size);

  for (let y = 0; y < size; y += 1) {
    raw[y * bytesPerRow] = 0; // filtro: ninguno
    for (let x = 0; x < size; x += 1) {
      const offset = y * bytesPerRow + 1 + x * 4;
      const color = isForeground(x, y, size) ? FOREGROUND : BACKGROUND;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = color[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="FINANZA">
  <rect width="64" height="64" rx="12" fill="#0b1220"/>
  <path d="M19 14h27v8H28v7h15v8H28v13h-9z" fill="#34d399"/>
</svg>
`;

mkdirSync(publicDir, { recursive: true });

for (const [filename, size] of [
  ['pwa-192.png', 192],
  ['pwa-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(resolve(publicDir, filename), buildPng(size));
  console.log(`  [+] ${filename} (${size}x${size})`);
}

writeFileSync(resolve(publicDir, 'favicon.svg'), FAVICON_SVG);
console.log('  [+] favicon.svg');
console.log('Iconos de la PWA generados en apps/web/public');
