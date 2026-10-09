// 填寫頁的「就地儲存」用背景請求（XHR）送出，會帶 X-Requested-With: fetch。
// 這類請求出錯時要回 JSON（讓畫面在該列顯示原因），一般表單送出（含沒有 JavaScript 的退路）則維持原本的錯誤頁。
function isAjax(req) {
  return req.get('x-requested-with') === 'fetch';
}

function sendError(req, res, status, title, message) {
  if (isAjax(req)) return res.status(status).json({ ok: false, error: message });
  return res.status(status).render('error', { title, message });
}

module.exports = { isAjax, sendError };
