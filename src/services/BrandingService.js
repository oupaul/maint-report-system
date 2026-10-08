const sharp = require('sharp');
const db = require('../models/db');
const { nowTaipei } = require('../utils/time');

// 預設圖示：橘色（系統主色）圓角方塊 + 白色勾選，跟介面色調一致。用 SVG 在伺服器端轉成 PNG，
// 不需要另外放圖檔。這個 SVG 是系統內建、不是使用者上傳的，所以沒有不明 SVG 的安全顧慮
// （使用者上傳的圖片只接受點陣圖格式，不接受 SVG）。
const DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="56" fill="#F97316"/>
  <path d="M68 132l42 42 78-90" fill="none" stroke="#fff" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const SIZES = { icon_32: 32, icon_180: 180, icon_256: 256 };
const MAX_INPUT_PIXELS = 50 * 1000 * 1000; // 防止超大圖吃光記憶體

class InvalidIconError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

let defaultCache = null;
let versionCache = null;

async function renderSquare(input, size) {
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    // contain：整張圖完整保留、不裁切 logo，空白處補透明
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function defaultIcons() {
  if (!defaultCache) {
    defaultCache = {};
    for (const [key, size] of Object.entries(SIZES)) {
      defaultCache[key] = await renderSquare(Buffer.from(DEFAULT_SVG), size);
    }
  }
  return defaultCache;
}

function row() {
  return db.prepare('SELECT * FROM branding WHERE id = 1').get();
}

function isCustom() {
  const r = row();
  return !!(r && r.icon_32);
}

// 加在圖示網址後面的版本字串：換了圖示網址就變，瀏覽器不會繼續用舊的快取
function version() {
  if (versionCache === null) {
    const r = row();
    versionCache = r && r.icon_32 && r.updated_at ? r.updated_at.replace(/\D/g, '') : 'default';
  }
  return versionCache;
}

async function getIcon(key) {
  const r = row();
  if (r && r[key]) return r[key];
  return (await defaultIcons())[key];
}

// ICO 容器可以直接包 PNG（Vista 之後的標準做法）：產生真正的 .ico 給 /favicon.ico，
// 不用依賴瀏覽器對「副檔名 ico、內容 png」的寬容處理。
function wrapIco(png32) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(1, 4);      // image count
  header.writeUInt8(32, 6);        // width
  header.writeUInt8(32, 7);        // height
  header.writeUInt8(0, 8);         // palette
  header.writeUInt8(0, 9);         // reserved
  header.writeUInt16LE(1, 10);     // color planes
  header.writeUInt16LE(32, 12);    // bits per pixel
  header.writeUInt32LE(png32.length, 14);
  header.writeUInt32LE(22, 18);    // data offset
  return Buffer.concat([header, png32]);
}

async function setFromUpload(buffer, originalName) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (e) {
    throw new InvalidIconError('圖片檔案無法處理，請確認檔案沒有毀損，或改用 PNG 格式重新上傳');
  }
  if (!meta.width || !meta.height) throw new InvalidIconError('無法讀取圖片尺寸');
  if (Math.min(meta.width, meta.height) < 32) {
    throw new InvalidIconError('圖片太小（短邊需至少 32 像素），建議使用 256×256 以上的正方形 PNG');
  }

  const out = {};
  try {
    for (const [key, size] of Object.entries(SIZES)) out[key] = await renderSquare(buffer, size);
  } catch (e) {
    throw new InvalidIconError('圖片檔案無法處理，請確認檔案沒有毀損，或改用 PNG 格式重新上傳');
  }

  db.prepare(
    'UPDATE branding SET icon_32 = ?, icon_180 = ?, icon_256 = ?, original_name = ?, updated_at = ? WHERE id = 1'
  ).run(out.icon_32, out.icon_180, out.icon_256, String(originalName || '').slice(0, 200) || null, nowTaipei());
  versionCache = null;
  return { width: meta.width, height: meta.height };
}

function reset() {
  db.prepare('UPDATE branding SET icon_32 = NULL, icon_180 = NULL, icon_256 = NULL, original_name = NULL, updated_at = NULL WHERE id = 1').run();
  versionCache = null;
}

function info() {
  const r = row();
  return { custom: !!(r && r.icon_32), originalName: r ? r.original_name : null, updatedAt: r ? r.updated_at : null };
}

module.exports = { InvalidIconError, getIcon, wrapIco, setFromUpload, reset, isCustom, info, version };
