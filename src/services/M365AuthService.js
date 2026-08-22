const msal = require('@azure/msal-node');
const config = require('../config');

// 只需要能識別登入者是誰（email/姓名），不需要代表使用者呼叫 Graph API 存取
// 其他資料，所以只要求最小的 openid/profile/email 系列 scope。
const SCOPES = ['user.read'];

let cca = null;
if (config.M365_ENABLED) {
  cca = new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.M365_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${config.M365_TENANT_ID}`,
      clientSecret: config.M365_CLIENT_SECRET,
    },
  });
}

function isEnabled() {
  return !!cca;
}

function getAuthCodeUrl(state) {
  return cca.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.M365_REDIRECT_URI,
    state,
  });
}

async function acquireTokenByCode(code) {
  const result = await cca.acquireTokenByCode({
    code,
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
