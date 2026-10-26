// 基本巡覽：登入、各主要頁面能開、權限、各種下載。最先跑、最快抓到「整頁壞掉」。
module.exports = {
  name: '基本巡覽與下載',
  needs: ['browser'],
  async run(t) {
    const ctx = await t.mkReportBatch();
    const anon = await fetch(`${t.base}/login`);
    t.ok(anon.status === 200, '登入頁可以開');
    for (const u of ['/', '/assets', '/batches', '/admin/status', `/batches/${ctx.bid}/report.pdf`]) {
      const r = await fetch(`${t.base}${u}`, { redirect: 'manual' });
      t.ok(r.status === 302 && /\/login/.test(r.headers.get('location') || ''), `未登入：${u} 導向登入頁`);
    }
    t.ok((await fetch(`${t.base}/healthz`)).ok, '/healthz 正常（公開、極簡）');

    const admin = await t.login('admin');
    const pages = ['/', '/assets', '/assets/new', '/assets/import', `/assets/${ctx.a1}/edit`, '/batches', '/batches/new', `/batches/${ctx.bid}`, `/batches/${ctx.bid}/entry`,
      '/batches/export', '/issues', '/capacity', '/quotes', '/users', '/users/new', '/admin/customers', '/admin/customers/import', '/admin/categories', '/admin/fields',
      '/admin/groups', '/admin/approval', '/admin/mail', '/admin/announcements', '/admin/quotes', '/admin/status', '/admin/logins', '/admin/audit', '/admin/backups',
      '/admin/branding', '/account/password'];
    const bad = [];
    for (const u of pages) {
      const r = await admin.goto(`${t.base}${u}`, { waitUntil: 'networkidle0' });
      if (r.status() !== 200 && r.status() !== 304) bad.push(`${u}→${r.status()}`);
    }
    t.ok(bad.length === 0, `管理員：${pages.length} 個主要頁面都回 200${bad.length ? '（失敗：' + bad.join('、') + '）' : ''}`);
    const nf = await admin.goto(`${t.base}/batches/999999`, { waitUntil: 'networkidle0' });
    t.ok(nf.status() === 404, '不存在的批次回 404（不是 500）');

    const wang = await t.login('wang');
    const tech = {};
    for (const u of ['/users', '/admin/status', '/admin/logins', '/admin/audit', '/admin/backups', '/assets/new']) tech[u] = (await wang.goto(`${t.base}${u}`)).status();
    t.ok(['/users', '/admin/status', '/admin/logins', '/admin/audit', '/admin/backups'].every(u => tech[u] === 403), `技術人員：管理員專屬頁面都是 403（${JSON.stringify(tech)}）`);
    t.ok(tech['/assets/new'] === 403, '技術人員（沒有資產建檔權限）不能新增資產');
    for (const u of ['/batches', '/assets', '/issues']) t.ok((await wang.goto(`${t.base}${u}`)).status() === 200, `技術人員可以開 ${u}`);

    // 下載
    const dl = async (u) => t.download(admin, u);
    let r = await dl(`/batches/${ctx.bid}/report.pdf`);
    t.ok(r.status === 200 && /pdf/.test(r.type) && r.buf.slice(0, 4).toString() === '%PDF' && /no-store/.test(r.cache), '批次報告 PDF：200、是 PDF、不可被快取');
    r = await dl(`/batches/${ctx.bid}/reports.zip`);
    t.ok(r.status === 200 && /zip/.test(r.type) && r.buf.slice(0, 2).toString() === 'PK', '每家客戶一份 PDF 的 ZIP：200、是 ZIP');
    for (const [u, name] of [['/assets/export.csv', '資產'], ['/batches/export/records.csv', '巡檢紀錄明細'], ['/batches/export/batches.csv', '批次清單'], ['/admin/customers/export.csv', '客戶'], ['/capacity/export.csv', '容量']]) {
      r = await dl(u);
      t.ok(r.status === 200 && /text\/csv/.test(r.type) && r.buf[0] === 0xEF && r.buf[1] === 0xBB, `${name} CSV：200、UTF-8 含 BOM（Excel 開中文不亂碼）`);
    }
    t.ok((await dl('/assets/import-template.csv')).status === 200 && (await dl('/admin/customers/import-template.csv')).status === 200, '匯入範本可下載');
  },
};
