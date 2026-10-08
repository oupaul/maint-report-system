const crypto = require('crypto');

// 排除容易看錯的字元（0/O、1/l/I），因為初始密碼會印在終端機畫面上讓人手抄或複製
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const MIN_LENGTH = 10;
const COMMON_PASSWORDS = new Set([
  'admin123', 'admin1234', 'password', 'password1', 'password123', '12345678',
  '123456789', '1234567890', 'qwerty123', 'abc12345', 'iloveyou1', 'maint123',
]);

// crypto.randomInt 是無偏差的亂數（不會像 `byte % 長度` 那樣讓部分字元機率偏高）
function generateRandomPassword(length = 16) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return out;
}

// 回傳錯誤訊息字串；通過則回傳 null
function validatePasswordStrength(password, { username } = {}) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `密碼長度至少 ${MIN_LENGTH} 個字元`;
  }
  if (password.length > 128) {
    return '密碼長度不可超過 128 個字元';
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return '這個密碼太常見，請換一個';
  }
  if (username && password.toLowerCase().includes(String(username).toLowerCase())) {
    return '密碼不可包含帳號名稱';
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return '密碼需同時包含英文字母與數字';
  }
  return null;
}

module.exports = { generateRandomPassword, validatePasswordStrength, MIN_LENGTH };
