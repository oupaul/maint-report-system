const crypto = require('crypto');
const config = require('../config');

// 寄信密碼 / M365 Client Secret 這類機密存資料庫前先加密（AES-256-GCM）。金鑰由 SESSION_SECRET
// 衍生（SESSION_SECRET 本來就只放在權限 600 的 session.env，不在資料庫、不在備份檔裡），所以
// 「只拿到資料庫或備份檔」的人解不開這些機密。
// 注意：SESSION_SECRET 一旦更換，已儲存的機密就無法解密，需要在「Email 通知」頁重新輸入——
// 本機開發沒設 SESSION_SECRET 時每次啟動都會換一組，所以開發環境重啟後要重新輸入。
const PREFIX = 'v1:';

function key() {
  return Buffer.from(
    crypto.hkdfSync('sha256', config.SESSION_SECRET, 'maint-report-system', 'mail-secrets', 32)
  );
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

// 解不開（金鑰變了、資料被改過）回傳 null，不 throw——呼叫端會當作「需要重新輸入」處理
function decrypt(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { encrypt, decrypt };
