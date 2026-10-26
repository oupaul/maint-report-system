// 極小的 ZIP 讀取器：只讀「不壓縮（store）」的檔案——專案自己的 ZipStream 就是這樣寫的（見 src/utils/zipStream.js）。
// 讀中央目錄，回傳 { name, data }[]；檔名用 UTF-8 解碼。順便驗 CRC，所以也等於檢查壓縮檔沒壞。
const { crc32 } = require('../../../src/utils/zipStream');

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到結尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目錄格式錯誤');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (method !== 0) throw new Error(`不支援的壓縮方式 ${method}（${name}）`);
    const lh = localOffset;
    const dataStart = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const data = buf.slice(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`CRC 不符：${name}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { readZip };
