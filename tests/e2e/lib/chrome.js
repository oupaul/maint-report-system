// 找本機的 Chrome／Chromium（puppeteer-core 不會自己下載瀏覽器）。可用環境變數 CHROME_PATH 指定。
const fs = require('fs');
const { execFileSync } = require('child_process');

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch (e) { /* 找下一個 */ }
  }
  return null;
}

// 有沒有某個命令列工具（pdftotext、pdfimages、pdfinfo 來自 poppler；沒有就略過需要它們的檢查）
function hasTool(name) {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

module.exports = { findChrome, hasTool };
