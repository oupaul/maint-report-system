// CSV 讀寫（RFC 4180）：引號欄位、跳脫的雙引號、欄位內換行、CRLF/LF、UTF-8 BOM 都處理。
// 不引入套件：需求單純，自己寫比較好控制行為（尤其是編碼偵測與匯出的防公式注入）。

// 解碼上傳的 CSV：優先 UTF-8（含 BOM）；不是合法 UTF-8 時改用 Big5——繁體中文版 Excel 的「CSV (逗號分隔)」
// 另存出來就是 Big5（ANSI），不處理的話中文會變亂碼。回傳 { text, encoding }
function decodeCsv(buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: text.replace(/^﻿/, ''), encoding: 'UTF-8' };
  } catch (e) {
    try {
      return { text: new TextDecoder('big5').decode(buffer).replace(/^﻿/, ''), encoding: 'Big5' };
    } catch (e2) {
      const err = new Error('無法辨識檔案編碼，請用 Excel「另存新檔 → CSV UTF-8（逗號分隔）」再上傳');
      err.userFacing = true;
      throw err;
    }
  }
}

// 猜分隔符號：看第一行（引號外）逗號、分號、Tab 哪個最多。Excel 在部分地區設定下會存成分號
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  let inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ',';
}

// 解析成二維陣列（欄位都是字串）。maxRows／maxCols 防止惡意或誤傳的超大檔案
function parseCsv(text, { maxRows = 20000, maxCols = 100 } = {}) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    if (row.length > maxCols) { const e = new Error(`欄位太多（超過 ${maxCols} 欄），請確認檔案格式`); e.userFacing = true; throw e; }
    rows.push(row);
    row = [];
    if (rows.length > maxRows) { const e = new Error(`資料列太多（超過 ${maxRows} 列）`); e.userFacing = true; throw e; }
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === '\r') { pushRow(); i += text[i + 1] === '\n' ? 2 : 1; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

// 匯出用：儲存格開頭是 = + - @ Tab CR 時前面補一個單引號，避免用 Excel 開啟時被當成公式執行（CSV injection）。
// 匯入時 stripFormulaGuard 會把這個單引號拿掉，所以「匯出 → 編輯 → 匯入」不會改到資料。
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stripFormulaGuard(value) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

function toCsv(rows) {
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { decodeCsv, parseCsv, csvCell, stripFormulaGuard, toCsv, detectDelimiter };
