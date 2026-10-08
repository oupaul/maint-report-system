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

  // Microsoft 導回來之後的共同處理：取得 ID token → 交給伺服器驗證 → 成功就進首頁。
  // 登入頁與 /auth/m365/callback 都會呼叫，所以不論 Azure 登錄的 Redirect URI 是網站根目錄、
  // /login 還是 /auth/m365/callback，導回來之後都能完成登入，而不是靜默地停在登入畫面。
  // 回傳 false 代表這次載入不是 Microsoft 導回來的（沒有登入結果可處理）。
  async function completeRedirectLogin(app, csrf, onError) {
    let result;
    try {
      result = await app.handleRedirectPromise();
    } catch (err) {
      onError('Microsoft 登入失敗：' + (err.errorMessage || err.message || err));
      return true;
    }
    if (!result || !result.idToken) return false;
    try {
      const resp = await fetch('/auth/m365/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ idToken: result.idToken }),
      });
      const data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        onError(data.error || 'Microsoft 登入驗證失敗，請重新嘗試。');
        return true;
      }
      // token 與 MSAL 暫存在瀏覽器 sessionStorage 的資料已經用完，清掉
      try { window.sessionStorage.clear(); } catch (e) { /* ignore */ }
      window.location.replace(data.redirect || '/');
    } catch (err) {
      onError('無法連線到伺服器完成登入：' + (err.message || err));
    }
    return true;
  }

  const loginBox = document.getElementById('m365-login');
  if (loginBox) {
    const btn = document.getElementById('m365-login-btn');
    const errBox = document.getElementById('m365-login-error');
    let app = null;
    async function getApp() {
      if (!app) {
        app = newClient(loginBox);
        await app.initialize();
      }
      return app;
    }

    // 如果 Redirect URI 登錄成登入頁本身（或網站根目錄再轉到登入頁），Microsoft 導回來時
    // 登入結果就在這一頁的網址 # 後面，要在這裡接手處理。
    if (window.isSecureContext && /[#&](code|error)=/.test(window.location.hash)) {
      btn.disabled = true;
      getApp().then(function (a) {
        return completeRedirectLogin(a, loginBox.dataset.csrf, function (message) {
          clearStaleInteraction();
          btn.disabled = false;
          showError(errBox, message);
        });
      }).then(function (handled) {
        if (handled === false) btn.disabled = false;
      }).catch(function (err) {
        btn.disabled = false;
        showError(errBox, 'Microsoft 365 登入失敗：' + (err.message || err));
      });
    }

    btn.addEventListener('click', async function () {
      errBox.hidden = true;
      if (!window.isSecureContext) {
        showError(errBox, 'Microsoft 365 登入需要 HTTPS 連線（或 localhost），目前的網址是不安全的 HTTP，請改用 https:// 網址存取。');
        return;
      }
      btn.disabled = true;
      clearStaleInteraction();
      try {
        await (await getApp()).loginRedirect({ scopes: ['openid', 'profile', 'email'] });
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
        const handled = await completeRedirectLogin(app, cb.dataset.csrf, fail);
        if (!handled) fail('沒有收到 Microsoft 的登入結果，請回到登入頁重新嘗試。');
      } catch (err) {
        fail('Microsoft 登入失敗：' + (err.errorMessage || err.message || err));
      }
    })();
  }
})();
