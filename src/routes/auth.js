const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const User = require('../models/User');
const AuthService = require('../services/AuthService');
const M365AuthService = require('../services/M365AuthService');
const LoginRateLimit = require('../middleware/loginRateLimit');
const { establishSession } = require('../utils/session');

// 帳號不存在時也跑一次 argon2 驗證（對一個不可能符合的雜湊），讓「帳號不存在」跟
// 「密碼錯誤」回應時間差不多，避免從回應速度猜出哪些帳號存在。
const dummyHashPromise = AuthService.hashPassword(crypto.randomBytes(16).toString('hex'));

router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

router.post('/login', async (req, res, next) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      return res.status(400).render('login', { error: '請輸入帳號與密碼' });
    }

    if (LoginRateLimit.isBlocked(req, username)) {
      return res.status(429).render('login', { error: '登入失敗次數過多，請 15 分鐘後再試' });
    }

    const user = User.findByUsername(username);
    const hash = user ? user.password_hash : await dummyHashPromise;
    const ok = await AuthService.verifyPassword(hash, password);

    if (!user || !user.is_active || !ok) {
      LoginRateLimit.recordFailure(req, username);
      return res.status(401).render('login', { error: '帳號或密碼錯誤' });
    }

    LoginRateLimit.recordSuccess(req, username);
    await establishSession(req, user);
    res.redirect(user.must_change_password ? '/account/password' : '/');
  } catch (err) {
    next(err);
  }
});

// M365（Azure AD / Entra ID）SSO：Azure 端登錄為 SPA，瀏覽器端的 MSAL.js 做 Authorization Code
// + PKCE 登入（不需要 Client Secret），拿到 ID token 後 POST 到 /auth/m365/token，由伺服器驗證。
// 帳號仍由管理員在「使用者管理」預先建立並設定 m365_email，找不到對應帳號就拒絕登入，
// 不會自動建立新帳號。
router.get('/auth/m365/callback', (req, res) => {
  if (!M365AuthService.isEnabled()) {
    return res.status(404).render('error', { title: '找不到頁面', message: '找不到頁面' });
  }
  // Microsoft 導回來時授權碼放在網址 # 後面，不會送到伺服器，由頁面上的 MSAL.js 接手處理
  console.log(`[M365 SSO] callback 頁面被載入（來源 IP ${req.ip}、https=${req.secure}）`);
  res.render('m365-callback', { m365: M365AuthService.getPublicConfig() });
});

router.post('/auth/m365/token', async (req, res) => {
  if (!M365AuthService.isEnabled()) {
    return res.status(404).json({ error: '尚未啟用 Microsoft 365 登入' });
  }

  // 跟密碼登入共用限流（以來源 IP 計算失敗次數），避免有人拿偽造的 token 一直試
  if (LoginRateLimit.isBlocked(req, '__m365__')) {
    return res.status(429).json({ error: '登入失敗次數過多，請 15 分鐘後再試' });
  }

  console.log(`[M365 SSO] 收到瀏覽器送來的 ID token（來源 IP ${req.ip}）`);
  const idToken = req.body && req.body.idToken;
  if (typeof idToken !== 'string' || !idToken) {
    return res.status(400).json({ error: '登入驗證失敗，請重新嘗試' });
  }

  let profile;
  try {
    profile = await M365AuthService.verifyIdToken(idToken);
  } catch (err) {
    console.error('[M365 SSO] ID token 驗證失敗:', err.message);
    LoginRateLimit.recordFailure(req, '__m365__');
    return res.status(401).json({ error: 'Microsoft 登入驗證失敗，請重新嘗試' });
  }

  if (!profile.email) {
    return res.status(401).json({ error: '無法從 Microsoft 帳號取得 email，請聯絡管理員' });
  }

  const user = User.findByM365Email(profile.email);
  if (!user || !user.is_active) {
    console.warn(`[M365 SSO] 拒絕登入：${profile.email} 沒有對應的啟用帳號`);
    LoginRateLimit.recordFailure(req, '__m365__');
    return res.status(403).json({
      error: `此 Microsoft 帳號（${profile.email}）尚未被加入系統，請聯絡管理員在「使用者管理」新增`,
    });
  }

  try {
    await establishSession(req, user, { viaSso: true });
    console.log(`[M365 SSO] 登入成功：${user.username}（${profile.email}）`);
    res.json({ redirect: '/' });
  } catch (err) {
    console.error('[M365 SSO] 建立 session 失敗:', err);
    res.status(500).json({ error: '登入失敗，請稍後再試' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
