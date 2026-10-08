const msal = require('@azure/msal-node');
const config = require('../config');

// 只需要能識別登入者是誰（email/姓名），不需要代表使用者呼叫 Graph API 存取
// 其他資料，所以只要求最小的 openid/profile/email 系列 scope。
const SCOPES = ['user.read'];

// 公開用戶端（Public Client）+ PKCE：不使用 Client Secret。每次登入產生一組一次性的
// code_verifier（只存在該使用者的 session），授權碼被攔截也無法在沒有 verifier 的情況下換成 token。
// Azure 端需開啟「Allow public client flows」，見 README「Microsoft 365 SSO」。
let pca = null;
const cryptoProvider = new msal.CryptoProvider();
if (config.M365_ENABLED) {
  pca = new msal.PublicClientApplication({
    auth: {
      clientId: config.M365_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${config.M365_TENANT_ID}`,
    },
  });
}

function isEnabled() {
  return !!pca;
}

// 回傳 { url, codeVerifier }：呼叫端要把 codeVerifier 存進 session，callback 時再帶回來。
async function getAuthCodeUrl(state) {
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const url = await pca.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.M365_REDIRECT_URI,
    state,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
  });
  return { url, codeVerifier: verifier };
}

async function acquireTokenByCode(code, codeVerifier) {
  const result = await pca.acquireTokenByCode({
    code,
    codeVerifier,
    scopes: SCOPES,
    redirectUri: config.M365_REDIRECT_URI,
  });

  // Azure AD 的 ID token 依帳號類型可能把登入用的 email 放在 preferred_username
  // 或 email claim，兩個都試，避免某些租戶設定下其中一個是空的。
  const claims = result.idTokenClaims || {};
  const email = claims.preferred_username || claims.email || null;
  const name = claims.name || email;

  return { email, name, claims };
}

module.exports = { isEnabled, getAuthCodeUrl, acquireTokenByCode };
