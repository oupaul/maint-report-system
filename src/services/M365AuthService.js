const jwt = require('jsonwebtoken');
const { JwksClient } = require('jwks-rsa');
const config = require('../config');

// M365 SSO 的做法跟 expense-platform 相同：Azure 端登錄為「單頁應用程式（SPA）」，由瀏覽器端的
// MSAL.js 做 Authorization Code + PKCE 登入，所以不需要 Client Secret。伺服器只負責驗證瀏覽器
// 送來的 ID token（簽章、發行者、受眾、有效期限），主機上不保管任何 M365 機密。

const ID_TOKEN_MAX_AGE = '10m'; // 只接受剛簽發的 token，縮短被偷走後可重放的時間窗
const usedTokens = new Map(); // uti -> 過期時間（ms）；同一張 ID token 只能換一次登入

let jwksClient = null;
if (config.M365_ENABLED) {
  jwksClient = new JwksClient({
    jwksUri: `https://login.microsoftonline.com/${config.M365_TENANT_ID}/discovery/v2.0/keys`,
    cache: true,
    cacheMaxAge: 24 * 60 * 60 * 1000,
    rateLimit: true,
  });
}

function isEnabled() {
  return !!jwksClient;
}

// 前端登入頁需要的公開設定（Client ID / Tenant ID 本來就會出現在 Microsoft 登入網址裡，不是機密）
function getPublicConfig() {
  return {
    clientId: config.M365_CLIENT_ID,
    tenantId: config.M365_TENANT_ID,
    redirectUri: config.M365_REDIRECT_URI,
  };
}

function getSigningKey(kid) {
  return new Promise((resolve, reject) => {
    jwksClient.getSigningKey(kid, (err, key) => {
      if (err || !key) return reject(err || new Error('找不到對應的簽章金鑰'));
      resolve(key.getPublicKey());
    });
  });
}

function rememberToken(uti, expSeconds) {
  const now = Date.now();
  for (const [id, expiresAt] of usedTokens) {
    if (expiresAt <= now) usedTokens.delete(id);
  }
  usedTokens.set(uti, expSeconds * 1000);
}

// keyResolver 只給測試用（注入本機金鑰，不連 Microsoft）
async function verifyIdToken(idToken, { keyResolver = getSigningKey, tenantId = config.M365_TENANT_ID, clientId = config.M365_CLIENT_ID } = {}) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new Error('ID token 格式不正確');
  }

  const publicKey = await keyResolver(decoded.header.kid);
  const payload = jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    audience: clientId,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    maxAge: ID_TOKEN_MAX_AGE,
  });

  // 發行者網址已經包含租戶 ID，tid 再確認一次（防止設定成網域名稱時 iss 比對被繞過的可能）
  if (payload.tid !== tenantId) {
    throw new Error('租戶不符');
  }

  const uti = payload.uti || payload.jti;
  if (!uti) throw new Error('ID token 缺少唯一識別碼');
  if (usedTokens.has(uti)) throw new Error('ID token 已被使用過');
  rememberToken(uti, payload.exp);

  // email claim 要在 Azure「選用宣告」額外勾選才一定有；preferred_username 是 v2.0 預設帶的登入帳號
  const email = payload.email || payload.preferred_username || null;
  return { email, name: payload.name || email };
}

module.exports = { isEnabled, getPublicConfig, verifyIdToken };
