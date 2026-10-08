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

// 預設不信任任何 X-Forwarded-* 標頭：服務直接對外（例如 http://主機IP:3000）時，
// 信任它們等於讓來訪者自己填 IP（登入限流會被繞過）。如果前面確實有一層反向代理
// （nginx、Cloudflare...），部署時設 TRUST_PROXY=1（代理層數）才會讀取真實來源 IP，
// 並讓 session cookie 在 HTTPS 下自動加上 Secure。
function parseTrustProxy(raw) {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw; // 例如 "loopback" 或 CIDR，交給 express 解析
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// M365（Azure AD / Entra ID）SSO 是選用功能：三個環境變數都設定了才啟用。
// 不使用 Client Secret：Azure 端登錄為 SPA，瀏覽器端 MSAL.js 做授權碼 + PKCE，伺服器只驗證 ID token
// （見 services/M365AuthService.js）。舊的 m365.env 若還留著 M365_CLIENT_SECRET 會被直接忽略，建議刪除。
// 沒設定的話登入頁就只顯示原本的帳號密碼表單，不會報錯。
const M365_CLIENT_ID = process.env.M365_CLIENT_ID || null;
const M365_TENANT_ID = process.env.M365_TENANT_ID || null;
const M365_REDIRECT_URI = process.env.M365_REDIRECT_URI || null;
const M365_ENABLED = !!(M365_CLIENT_ID && M365_TENANT_ID && M365_REDIRECT_URI);

module.exports = {
  PROJECT_ROOT,
  PORT,
  NODE_ENV,
  SESSION_SECRET: sessionSecret,
  TRUST_PROXY,
  DATA_DIR: path.join(PROJECT_ROOT, 'data'),
  DB_PATH: path.join(PROJECT_ROOT, 'data', 'maint_report.db'),
  UPLOADS_DIR: path.join(PROJECT_ROOT, 'uploads'),
  M365_CLIENT_ID,
  M365_TENANT_ID,
  M365_REDIRECT_URI,
  M365_ENABLED,
};
