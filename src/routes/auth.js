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

// M365（Azure AD / Entra ID）SSO：帳號仍由管理員在「使用者管理」預先建立並
// 設定 m365_email，這裡只負責「確認這是哪個 M365 使用者」，找不到對應帳號
// 就拒絕登入，不會自動建立新帳號。
router.get('/auth/m365/login', async (req, res) => {
  if (!M365AuthService.isEnabled()) {
    return res.status(404).render('error', { title: '找不到頁面', message: '找不到頁面' });
  }

  // state 存進 session，callback 時比對，防止 CSRF（避免有人偽造 callback 請求
  // 幫別人登入自己準備好的帳號）；PKCE 的 code_verifier 同樣只放在這個 session 裡。
  const state = crypto.randomBytes(16).toString('hex');
  req.session.m365State = state;

  try {
    const { url, codeVerifier } = await M365AuthService.getAuthCodeUrl(state);
    req.session.m365CodeVerifier = codeVerifier;
    res.redirect(url);
  } catch (err) {
    console.error('[M365 SSO] 產生登入連結失敗:', err);
    res.status(500).render('login', { error: 'Microsoft 365 登入設定有誤，請聯絡系統管理員' });
  }
});

router.get('/auth/m365/callback', async (req, res, next) => {
  if (!M365AuthService.isEnabled()) {
    return res.status(404).render('error', { title: '找不到頁面', message: '找不到頁面' });
  }

  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.status(401).render('login', {
      error: `Microsoft 登入失敗：${errorDescription || error}`,
    });
  }

  if (!code || !state || state !== req.session.m365State) {
    return res.status(400).render('login', { error: '登入驗證失敗，請重新嘗試' });
  }
  const codeVerifier = req.session.m365CodeVerifier;
  delete req.session.m365State;
  delete req.session.m365CodeVerifier;
  if (!codeVerifier) {
    return res.status(400).render('login', { error: '登入驗證失敗，請重新嘗試' });
  }

  let profile;
  try {
    profile = await M365AuthService.acquireTokenByCode(code, codeVerifier);
  } catch (err) {
    console.error('[M365 SSO] 交換 token 失敗:', err);
    return res.status(500).render('login', { error: 'Microsoft 365 登入失敗，請稍後再試或聯絡管理員' });
  }

  if (!profile.email) {
    return res.status(401).render('login', { error: '無法從 Microsoft 帳號取得 email，請聯絡管理員' });
  }

  const user = User.findByM365Email(profile.email);
  if (!user || !user.is_active) {
    return res.status(403).render('login', {
      error: `此 Microsoft 帳號（${profile.email}）尚未被加入系統，請聯絡管理員在「使用者管理」新增`,
    });
  }

  try {
    await establishSession(req, user, { viaSso: true });
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
