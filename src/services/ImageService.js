const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// 長邊上限（寬、高都不超過這個值）：手機截圖／相機照片動輒 4000px 以上、好幾 MB，
// 巡檢截圖只要看得清楚文字即可。縮小 + WebP 壓縮通常能把檔案壓到原本的 20~40%。
const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 82;

// 檔案根本不是能解碼的圖片（毀損、上傳到一半、副檔名/類型是假的）：回給使用者一個看得懂的訊息，
// 不要讓不明內容以「圖片」的名義存進系統。
class UnsupportedImageError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

/**
 * 處理上傳的截圖：轉成 WebP（依 EXIF 轉正、限制長邊、壓縮）。
 * - 檔案能解碼、但轉 WebP 這一步失敗（很少見）：退回存原始檔案，不讓使用者的截圖丟掉。
 * - 檔案根本無法解碼：丟出 UnsupportedImageError（userFacing），由呼叫端顯示訊息。
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
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
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
    console.warn(`[ImageService] sharp 轉檔失敗: ${err.message}`);

    let metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch (metaErr) {
      throw new UnsupportedImageError('圖片檔案無法處理，請確認檔案沒有毀損，或改用 JPG / PNG 格式重新上傳');
    }

    const ext = MIME_TO_EXT[mimetype] || 'bin';
    const finalPath = `${destPath}.${ext}`;
    fs.writeFileSync(finalPath, buffer);
    return { path: finalPath, width: metadata.width || null, height: metadata.height || null, format: ext };
  }
}

module.exports = { processScreenshot, UnsupportedImageError };
