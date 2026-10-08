// 基本的瀏覽器端防護標頭（自己寫，不額外引入 helmet 套件）。
// CSP 不允許任何 inline script——views 裡本來的 onsubmit="return confirm(...)" 已經改成
// data-confirm 屬性搭配 public/js/confirm.js；style 仍允許 inline（views 有不少 style=""
// 屬性，風險遠低於 script）。PDF 報告不套 CSP，避免影響瀏覽器內建 PDF 檢視器。
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  // MSAL.js 在瀏覽器端要直接向 Microsoft 登入端點取得 token（M365 SSO，未啟用時完全用不到）
  "connect-src 'self' https://login.microsoftonline.com",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!req.path.endsWith('.pdf')) {
    res.setHeader('Content-Security-Policy', CSP);
  }
  // 只有確定是 HTTPS（經由 TRUST_PROXY 信任反向代理的 X-Forwarded-Proto，或直接 TLS）才送 HSTS
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
}

module.exports = { securityHeaders };
