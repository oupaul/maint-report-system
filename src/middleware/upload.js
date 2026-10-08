const multer = require('multer');

const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// iPhone 拍照預設是 HEIC/HEIF。伺服器上的 sharp/libvips 通常沒有編入 HEVC 解碼器（授權/專利因素），
// 收了也無法轉檔；與其跑到轉檔那步才失敗，不如一開始就給使用者知道怎麼解決的訊息。
const HEIC_MIMETYPES = ['image/heic', 'image/heif'];

// multer（busboy）把檔名當 latin1 解碼，中文檔名會變成亂碼，要還原成原本的 UTF-8
function decodeFilename(name) {
  return Buffer.from(String(name || ''), 'latin1').toString('utf8');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter(req, file, cb) {
    if (HEIC_MIMETYPES.includes(file.mimetype)) {
      const heicErr = new Error('不支援 HEIC/HEIF 格式（iPhone 拍照預設格式）。請到手機「設定 → 相機 → 格式」改成「最相容」，或先把照片轉存成 JPEG 再上傳');
      heicErr.userFacing = true;
      return cb(heicErr);
    }
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      return cb(null, true);
    }
    const err = new Error('不支援的圖片格式，僅接受 JPEG / PNG / WebP / GIF');
    err.userFacing = true;
    cb(err);
  },
});

module.exports = upload;
module.exports.decodeFilename = decodeFilename;
