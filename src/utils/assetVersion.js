// 靜態檔（public/css、public/js）的版本碼：內容雜湊，啟動時算一次。
// 網頁引用時加上 ?v=<版本碼>（view 裡用 assetUrl('/js/x.js')），檔案一改網址就變，
// 瀏覽器、Cloudflare 等 CDN 不會再拿到舊版（曾經發生：JS 是新的、CSS 是舊的，畫面壞掉）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function computeVersion() {
  const h = crypto.createHash('sha1');
  for (const dir of ['css', 'js']) {
    const full = path.join(PUBLIC_DIR, dir);
    let files = [];
    try { files = fs.readdirSync(full).filter(f => /\.(css|js)$/.test(f)).sort(); } catch (e) { /* 目錄不存在就略過 */ }
    for (const f of files) {
      h.update(dir + '/' + f + '\0');
      h.update(fs.readFileSync(path.join(full, f)));
    }
  }
  return h.digest('hex').slice(0, 10);
}

const VERSION = computeVersion();

// 只給站內絕對路徑加版本碼（已經帶 ? 的、外部網址都原樣回傳）
function asset(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.includes('?')) return url;
  return `${url}?v=${VERSION}`;
}

module.exports = { asset, VERSION, computeVersion };
