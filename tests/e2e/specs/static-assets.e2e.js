// 靜態檔（CSS／JS）網址帶內容版本碼，避免瀏覽器／CDN 留著舊版（曾經 JS 是新的、CSS 是舊的，畫面整個壞掉）。
// 另外確認「view 裡的 assetUrl 輔助函式沒有被頁面的區域變數蓋掉」（曾經因為編輯設備頁有叫 asset 的變數而整頁 500）。
const fs = require('fs');
const path = require('path');

module.exports = {
  name: '靜態檔版本碼',
  needs: ['browser'],
  async run(t) {
    const ctx = await t.mkReportBatch();
    const html = await (await fetch(`${t.base}/login`)).text();
    const tags = [...html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+)"/g)].map(m => m[1]);
    t.ok(tags.length > 0 && tags.every(x => /\?v=[0-9a-f]{10}$/.test(x)), `登入頁：每個 css/js 網址都帶 ?v=<10 碼內容雜湊>（${tags.length} 個）`);
    const css = tags.find(x => x.includes('app.css'));
    const withV = await fetch(`${t.base}${css}`);
    t.ok(withV.status === 200 && /immutable/.test(withV.headers.get('cache-control')) && /max-age=31536000/.test(withV.headers.get('cache-control')), `帶版本碼：長期快取（${withV.headers.get('cache-control')}）`);
    const noV = await fetch(`${t.base}${css.split('?')[0]}`);
    t.ok(noV.status === 200 && noV.headers.get('cache-control') === 'no-cache', `沒帶版本碼：一律重新驗證（${noV.headers.get('cache-control')}）`);
    t.ok((await fetch(`${t.base}/js/不存在.js?v=1`)).status === 404, '不存在的檔案仍回 404');

    const admin = await t.login('admin');
    const pages = ['/assets', '/assets/new', `/assets/${ctx.a1}/edit`, `/capacity/assets/${ctx.a1}`, `/batches/${ctx.bid}`, `/batches/${ctx.bid}/entry`, '/batches/new',
      '/admin/customers', '/admin/fields', '/issues', '/capacity', '/quotes', '/users/new'];
    for (const u of pages) {
      const r = await admin.goto(`${t.base}${u}`, { waitUntil: 'networkidle0' });
      const list = await admin.$$eval('script[src],link[rel=stylesheet]', a => a.map(x => x.getAttribute('src') || x.getAttribute('href')).filter(x => /^\/(js|css)\//.test(x)));
      t.ok((r.status() === 200 || r.status() === 304) && list.length > 0 && list.every(x => /\?v=[0-9a-f]{10}$/.test(x)), `${u}：頁面正常，${list.length} 個本地 css/js 都有版本碼`);
    }

    // 版本碼會隨檔案內容改變，而且執行中的伺服器用的版本和磁碟上一致
    const { computeVersion } = t.require('src/utils/assetVersion');
    const f = path.join(t.root, 'src/public/js/confirm.js');
    const orig = fs.readFileSync(f);
    const v1 = computeVersion();
    fs.writeFileSync(f, Buffer.concat([orig, Buffer.from('\n// x')]));
    const v2 = computeVersion();
    fs.writeFileSync(f, orig);
    t.ok(v1 !== v2 && v1 === computeVersion(), `版本碼隨檔案內容改變、還原後回來（${v1} → ${v2} → ${v1}）`);
    t.ok(tags[0].endsWith(`v=${v1}`), '執行中的伺服器使用的版本碼與磁碟上的檔案一致');
  },
};
