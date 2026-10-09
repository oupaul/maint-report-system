const crypto = require('crypto');
const { isAjax } = require('../utils/ajax');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function tokensMatch(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 每個 session 一組 CSRF token，所有非 GET 請求都要帶回來：
// - 一般表單：隱藏欄位 _csrf
// - multipart 表單（上傳截圖）：multer 處理 body 之前這個 middleware 就要驗證，
//   此時 req.body 還是空的，所以那種表單的 action 網址帶 ?_csrf=...
// - 之後若改成 fetch/AJAX：header x-csrf-token
//
// res.locals.csrfToken 用 getter，只有「真的要 render 畫面」才會建立 token（連帶建立
// session）；機器人亂打的 404、已登出的 302 這類請求不會每次都產生一筆 session。
function csrfProtection(req, res, next) {
  Object.defineProperty(res.locals, 'csrfToken', {
    get: () => ensureToken(req),
    enumerable: true,
    configurable: true,
  });

  if (SAFE_METHODS.has(req.method)) return next();

  const sent = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
  if (!tokensMatch(req.session.csrfToken, sent)) {
    if (isAjax(req)) return res.status(403).json({ ok: false, error: '頁面已逾時或重新登入過，請重新整理頁面後再試一次（你輸入的內容請先自行保留）。' });
    return res.status(403).render('error', {
      title: '驗證失敗',
      message: '表單驗證已失效（可能是停留太久或重新開啟了網頁），請回上一頁重新整理後再試一次。',
    });
  }
  next();
}

module.exports = { csrfProtection };
