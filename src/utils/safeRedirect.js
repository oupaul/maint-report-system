// 登入後要回到「原本想去的頁面」（例如從通知信點連結進來）。這個值來自使用者可控的網址，
// 只接受站內路徑——必須是單一 / 開頭，不能是 //（協定相對網址）、反斜線、含協定或換行，避免被拿來做開放式轉址。
function safeReturnPath(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n\t]/.test(value)) return null;
  if (/^\/(login|logout|auth)(\/|\?|$)/.test(value)) return null;
  return value;
}

module.exports = { safeReturnPath };
