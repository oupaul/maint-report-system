// M365 SSO 瀏覽器端（SPA + Authorization Code + PKCE，不需要 Client Secret）。
// 登入頁：按鈕 → msal.loginRedirect 整頁導去 Microsoft。
// /auth/m365/callback 頁：Microsoft 導回來後 handleRedirectPromise 取得 ID token，
// POST 給伺服器驗證（簽章/發行者/受眾/期限都在伺服器端驗，這裡拿到的 token 不被信任）。
(function () {
  function newClient(el) {
    return new msal.PublicClientApplication({
      auth: {
        clientId: el.dataset.clientId,
        authority: 'https://login.microsoftonline.com/' + el.dataset.tenantId,
        redirectUri: el.dataset.redirectUri,
      },
      // redirect 流程會離開頁面再回來，PKCE 驗證碼等暫存資料要放得過這趟導向
      cache: { cacheLocation: 'sessionStorage' },
    });
  }

  // 上次登入如果中途被放棄（關掉分頁、按上一頁、callback 頁沒跑完），MSAL 留在
  // sessionStorage 的「登入進行中」旗標不會被清掉，之後每次重試都會被 MSAL 自己擋下來
  // （interaction_in_progress）。開始新的登入、或這一輪登入失敗時，先把這類旗標清掉，
  // 確保使用者永遠有辦法重新嘗試。
  function clearStaleInteraction() {
    try {
      Object.keys(window.sessionStorage).forEach(function (key) {
        if (key.indexOf('interaction.status') !== -1) window.sessionStorage.removeItem(key);
      });
    } catch (e) { /* sessionStorage 不可用就算了 */ }
  }

  function showError(el, message) {
    el.textContent = message;
    el.hidden = false;
  }

  const loginBox = document.getElementById('m365-login');
  if (loginBox) {
    const btn = document.getElementById('m365-login-btn');
    const errBox = document.getElementById('m365-login-error');
    btn.addEventListener('click', async function () {
      errBox.hidden = true;
      if (!window.isSecureContext) {
        showError(errBox, 'Microsoft 365 登入需要 HTTPS 連線（或 localhost），目前的網址是不安全的 HTTP，請改用 https:// 網址存取。');
        return;
      }
      btn.disabled = true;
      clearStaleInteraction();
      try {
        const app = newClient(loginBox);
        await app.initialize();
        await app.loginRedirect({ scopes: ['openid', 'profile', 'email'] });
      } catch (err) {
        btn.disabled = false;
        showError(errBox, 'Microsoft 365 登入啟動失敗：' + (err.message || err));
      }
    });
  }

  const cb = document.getElementById('m365-callback');
  if (cb) {
    const status = document.getElementById('m365-status');
    const errBox = document.getElementById('m365-callback-error');
    const back = document.getElementById('m365-back');
    function fail(message) {
      clearStaleInteraction();
      status.hidden = true;
      showError(errBox, message);
      back.hidden = false;
    }
    (async function () {
      try {
        const app = newClient(cb);
        await app.initialize();
        const result = await app.handleRedirectPromise();
        if (!result || !result.idToken) {
          fail('沒有收到 Microsoft 的登入結果，請回到登入頁重新嘗試。');
          return;
        }
        const resp = await fetch('/auth/m365/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': cb.dataset.csrf },
          body: JSON.stringify({ idToken: result.idToken }),
        });
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) {
          fail(data.error || 'Microsoft 登入驗證失敗，請重新嘗試。');
          return;
        }
        // token 與 MSAL 暫存在瀏覽器 sessionStorage 的資料已經用完，清掉
        try { window.sessionStorage.clear(); } catch (e) { /* ignore */ }
        window.location.replace(data.redirect || '/');
      } catch (err) {
        fail('Microsoft 登入失敗：' + (err.errorMessage || err.message || err));
      }
    })();
  }
})();
