const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * 處理上傳的截圖：優先轉成 WebP（縮圖 + 壓縮），失敗時退回存原始檔案。
 * 絕不 throw — 呼叫端（路由）必須在失敗情況下仍能成功儲存 inspection_item，
 * 只是沒有可靠的寬高資訊。
 *
 * @param {Buffer} buffer 上傳檔案的原始 buffer
 * @param {string} mimetype 上傳檔案的 mimetype
 * @param {string} destPath 不含副檔名的目標路徑（例如 uploads/3/42）
 * @returns {Promise<{path: string, width: number|null, height: number|null, format: string}>}
 */
async function processScreenshot(buffer, mimetype, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    const finalPath = `${destPath}.webp`;
    fs.writeFileSync(finalPath, data);

    return {
      path: finalPath,
      width: info.width || null,
      height: info.height || null,
      format: 'webp',
    };
  } catch (err) {
    console.warn(`[ImageService] sharp 轉檔失敗，改存原始檔案: ${err.message}`);

    const ext = MIME_TO_EXT[mimetype] || 'bin';
    const finalPath = `${destPath}.${ext}`;
    fs.writeFileSync(finalPath, buffer);

    let width = null;
    let height = null;
    try {
      const metadata = await sharp(buffer).metadata();
      width = metadata.width || null;
      height = metadata.height || null;
    } catch (metaErr) {
      // best-effort，讀取失敗就留 null，不影響上層流程
    }

    return { path: finalPath, width, height, format: ext };
  }
}

module.exports = { processScreenshot };
