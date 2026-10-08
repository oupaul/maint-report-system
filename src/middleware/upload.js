const multer = require('multer');

const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter(req, file, cb) {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      return cb(null, true);
    }
    const err = new Error('不支援的圖片格式，僅接受 JPEG / PNG / WebP / GIF');
    err.userFacing = true;
    cb(err);
  },
});

module.exports = upload;
