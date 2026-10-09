// 使用者自己存的預設簽名（user_signatures：一人一筆，PNG 存 BLOB）。只有本人能取用。
const sharp = require('sharp');
const db = require('./db');
const { nowTaipei } = require('../utils/time');

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

const UserSignature = {
  // 目前版本（更新時間字串，網址加上它讓瀏覽器在簽名更換後拿新圖）；沒存過回傳 null
  version(userId) {
    const row = db.prepare('SELECT updated_at FROM user_signatures WHERE user_id = ?').get(userId);
    return row ? row.updated_at : null;
  },

  get(userId) {
    return db.prepare('SELECT image, updated_at FROM user_signatures WHERE user_id = ?').get(userId);
  },

  // 存簽名：不信任來源，一律用 sharp 實際解碼、縮到畫布大小以內再重新編碼成 PNG（順便去掉內嵌資料）。
  // 解碼失敗（不是真的 PNG）會丟出錯誤，呼叫端決定怎麼處理。
  async saveFromPng(userId, buffer) {
    if (!buffer || buffer.length === 0 || buffer.length > MAX_INPUT_BYTES) throw new Error('簽名圖檔大小不正確');
    const normalized = await sharp(buffer, { limitInputPixels: 4_000_000 })
      .resize({ width: 600, height: 300, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    db.prepare(
      `INSERT INTO user_signatures (user_id, image, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at`
    ).run(userId, normalized, nowTaipei());
  },

  remove(userId) {
    return db.prepare('DELETE FROM user_signatures WHERE user_id = ?').run(userId).changes > 0;
  },
};

module.exports = UserSignature;
