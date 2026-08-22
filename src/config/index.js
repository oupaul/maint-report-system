const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[安全警告] SESSION_SECRET 未設定！本次使用臨時隨機金鑰，重啟後所有 session 將失效。正式部署請確認 deploy.sh 已設定此環境變數。');
}

// M365（Azure AD / Entra ID）SSO 是選用功能：四個環境變數都設定了才啟用，
// 沒設定的話登入頁就只顯示原本的帳號密碼表單，不會報錯。
const M365_CLIENT_ID = process.env.M365_CLIENT_ID || null;
const M365_CLIENT_SECRET = process.env.M365_CLIENT_SECRET || null;
const M365_TENANT_ID = process.env.M365_TENANT_ID || null;
const M365_REDIRECT_URI = process.env.M365_REDIRECT_URI || null;
const M365_ENABLED = !!(M365_CLIENT_ID && M365_CLIENT_SECRET && M365_TENANT_ID && M365_REDIRECT_URI);

module.exports = {
  PROJECT_ROOT,
  PORT,
  NODE_ENV,
  SESSION_SECRET: sessionSecret,
  DATA_DIR: path.join(PROJECT_ROOT, 'data'),
  DB_PATH: path.join(PROJECT_ROOT, 'data', 'maint_report.db'),
  UPLOADS_DIR: path.join(PROJECT_ROOT, 'uploads'),
  M365_CLIENT_ID,
  M365_CLIENT_SECRET,
  M365_TENANT_ID,
  M365_REDIRECT_URI,
  M365_ENABLED,
};
