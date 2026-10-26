// 批次 PDF 報告：涵蓋多家客戶時可選客戶輸出、每家客戶各一份（ZIP）、附錄原圖頁。
// 重點：部分報告「不可出現未選客戶的名稱或設備」；無效的客戶參數回 400（不可退回成輸出全部）。
const fs = require('fs');
const path = require('path');
const { readZip } = require('../lib/zip');

module.exports = {
  name: 'PDF 報告：選客戶、ZIP、附錄原圖頁',
  needs: ['browser', 'poppler'],
  async run(t) {
    const ctx = await t.mkReportBatch();
    // 再加一台「未指定客戶」的設備，湊成三組；並讓幾個項目是警告（顯示異常數）
    const pc = t.mkAsset('PC-未指定', { category: 'pc' });
    t.q('INSERT INTO inspection_batch_assets (batch_id, asset_id) VALUES (?, ?)', ctx.bid, pc);
    t.q("INSERT INTO inspection_items (batch_id, asset_id, checklist_item_id, status, recorded_at) VALUES (?, ?, ?, 'normal', ?)", ctx.bid, pc, t.checklistIds('pc', 1)[0], t.NOW);
    t.q("UPDATE inspection_items SET status = 'warning' WHERE id IN (?, ?, ?)", ctx.items[0], ctx.items[3], ctx.items[4]);
    const admin = await t.login('admin');
    const pdf = async (url, name) => { const r = await t.download(admin, url); const f = t.tmpFile(name, r.buf); return { ...r, file: f, text: r.status === 200 && /pdf/.test(r.type) ? t.pdfText(f) : '' }; };

    // ---- 介面 ----
    await t.go(admin, `/batches/${ctx.bid}`);
    t.ok(await admin.$('#report-picker') !== null, '涵蓋多組客戶的批次顯示「選擇客戶…」');
    const items = await admin.$$eval('.report-picker__item', a => a.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
    t.ok(items.length === 3 && items.some(x => /甲公司.*12345678.*1 台・1 項異常／警告/.test(x)) && items.some(x => /乙公司.*1 台・2 項異常／警告/.test(x)) && /未指定客戶.*1 台/.test(items[2]), `客戶清單含統編、台數、異常數，「未指定客戶」排最後（${items.join('｜')}）`);
    t.ok(await admin.$$eval('.report-picker__item input', a => a.every(x => x.checked)), '預設全部勾選');
    await admin.click('#report-picker summary'); await admin.click('#report-pick-none');
    t.ok(await admin.$eval('#report-pdf-btn', e => e.disabled) && await admin.$eval('#report-zip-btn', e => e.disabled), '全不選時兩個下載鈕都停用');
    await admin.click('#report-pick-all');
    t.ok(!await admin.$eval('#report-pdf-btn', e => e.disabled), '全選後恢復');

    // ---- 完整報告 ----
    const full = await pdf(`/batches/${ctx.bid}/report.pdf`, 'full.pdf');
    t.ok(full.status === 200 && /batch-\d+-report\.pdf/.test(full.disp) && /no-store/.test(full.cache), '完整報告：200、檔名單純、不可被快取');
    t.ok(['ERP-DB01', 'NAS-01', 'PC-未指定', '甲公司', '乙公司'].every(x => full.text.includes(x)) && !/僅含上列客戶/.test(full.text), '完整報告含所有設備與客戶，沒有「僅含部分客戶」註記');
    const allSel = await pdf(`/batches/${ctx.bid}/report.pdf?customer=${ctx.cA}&customer=${ctx.cB}&customer=none`, 'allsel.pdf');
    t.ok(!/僅含上列客戶/.test(allSel.text), '三組全選＝完整報告（沒有部分報告註記）');

    // ---- 只選一家 ----
    const one = await pdf(`/batches/${ctx.bid}/report.pdf?customer=${ctx.cA}`, 'one.pdf');
    t.ok(one.status === 200 && /filename\*=UTF-8''batch-\d+-%E7%94%B2%E5%85%AC%E5%8F%B8-report\.pdf/.test(one.disp) && /filename="batch-\d+-partial-report\.pdf"/.test(one.disp), `只選一家：檔名含客戶名稱（UTF-8）並有 ASCII 後備：${one.disp}`);
    t.ok(one.text.includes('ERP-DB01') && !one.text.includes('NAS-01') && !one.text.includes('PC-未指定'), '只含該客戶的設備');
    t.ok(/客戶：甲公司（統一編號 12345678）/.test(one.text) && !/乙公司/.test(one.text) && /僅含上列客戶的設備/.test(one.text), '封面：只寫被選的客戶＋統編＋「不是完整內容」註記，完全不提另一家');
    t.ok(/簽核|工程師|主管/.test(one.text), '部分報告仍保留簽核區');

    // ---- 兩組含「未指定客戶」／只選未指定 ----
    const two = await pdf(`/batches/${ctx.bid}/report.pdf?customer=${ctx.cB}&customer=none`, 'two.pdf');
    t.ok(!two.text.includes('ERP-DB01') && two.text.includes('NAS-01') && two.text.includes('PC-未指定') && /客戶：乙公司（含未指定客戶的設備）/.test(two.text)
      && /多家客戶/.test(decodeURIComponent((two.disp.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || '')), '選兩組（含未指定）：封面用詞與「多家客戶」檔名');
    const none = await pdf(`/batches/${ctx.bid}/report.pdf?customer=none`, 'none.pdf');
    t.ok(/客戶：未指定客戶/.test(none.text) && none.text.includes('PC-未指定') && !none.text.includes('ERP-DB01'), '只選「未指定客戶」');

    // ---- 無效選取 ----
    t.ok((await t.download(admin, `/batches/${ctx.bid}/report.pdf?customer=99999`)).status === 400, '不存在的客戶編號 → 400（不是輸出空白或全部）');
    t.ok((await t.download(admin, `/batches/${ctx.bid}/report.pdf?customer=%27%20OR%201%3D1`)).status === 400, '惡意字串被忽略 → 400');
    t.ok((await t.download(admin, `/batches/${ctx.bid}/report.pdf?customer=${ctx.cA}&customer=99999`)).status === 200, '有效的和無效的並存時，只用有效的');
    t.ok((await t.download(admin, '/batches/999999/report.pdf')).status === 404, '不存在的批次 404');
    const wang = await t.login('wang');
    t.ok((await t.download(wang, `/batches/${ctx.bid}/report.pdf?customer=${ctx.cA}`)).status === 200, '任何登入的人都能下載依客戶選取的報告');

    // ---- ZIP：每家客戶各一份 ----
    const z = await t.download(admin, `/batches/${ctx.bid}/reports.zip`);
    t.ok(z.status === 200 && /zip/.test(z.type) && /attachment/.test(z.disp) && /no-store/.test(z.cache), 'ZIP：200、application/zip、附件、不可被快取');
    const entries = readZip(z.buf);
    const names = entries.map(e => e.name).sort();
    t.ok(names.length === 3 && names.includes(`batch-${ctx.bid}-甲公司.pdf`) && names.includes(`batch-${ctx.bid}-乙公司.pdf`) && names.includes(`batch-${ctx.bid}-未指定客戶.pdf`), `每組客戶一份、檔名是中文（${names.join('、')}）`);
    const za = t.pdfText(t.tmpFile('za.pdf', entries.find(e => e.name.includes('甲公司')).data)), zb = t.pdfText(t.tmpFile('zb.pdf', entries.find(e => e.name.includes('乙公司')).data));
    t.ok(za.includes('ERP-DB01') && !za.includes('NAS-01') && zb.includes('NAS-01') && !zb.includes('ERP-DB01') && !zb.includes('甲公司'), 'ZIP 裡每份只含自己那家客戶');
    t.ok(readZip((await t.download(admin, `/batches/${ctx.bid}/reports.zip?customer=${ctx.cA}&customer=${ctx.cB}`)).buf).length === 2, 'ZIP 遵照選取（選兩家就兩份）');
    t.ok((await t.download(admin, `/batches/${ctx.bid}/reports.zip?customer=99999`)).status === 400, 'ZIP 沒有任何有效客戶 → 400');

    // ---- 附錄原圖頁 ----
    const base = t.pdfPages(full.file);
    const app = await pdf(`/batches/${ctx.bid}/report.pdf?appendix=1`, 'app.pdf');
    t.ok(t.pdfPages(app.file) === base + 5, `附錄每張照片多一頁（${base} → ${t.pdfPages(app.file)}）`);
    t.ok(!/附錄：截圖原圖/.test(full.text), '沒勾附錄時不會有附錄');
    t.ok(/附錄：截圖原圖（每張一頁，共 5 張）/.test(app.text) && /ERP-DB01・.*截圖 1/.test(app.text) && /NAS-01・.*截圖 2 \/ 2/.test(app.text), '附錄標題與每張的說明（設備・項目・第幾張／共幾張）');
    const AI = t.pdfImages(app.file).filter(i => i.page > base);
    t.ok(AI.length === 5 && AI.filter(i => i.w >= 2000).every(i => i.ppi >= 400), `附錄的大圖整頁放大，至少 400 ppi（${AI.map(i => i.ppi).join(',')}）`);
    const aA = await pdf(`/batches/${ctx.bid}/report.pdf?customer=${ctx.cA}&appendix=1`, 'aA.pdf');
    t.ok(/共 3 張/.test(aA.text) && !/NAS-01/.test(aA.text), '依客戶選取的報告：附錄只有該客戶的 3 張，沒有另一家的任何東西');
    const aB = await pdf(`/batches/${ctx.bid}/report.pdf?customer=${ctx.cB}&appendix=1`, 'aB.pdf');
    t.ok(/共 2 張/.test(aB.text) && !/ERP-DB01/.test(aB.text), '另一家：附錄只有 2 張');
    const zApp = readZip((await t.download(admin, `/batches/${ctx.bid}/reports.zip?appendix=1`)).buf);
    t.ok(zApp.length === 3 && zApp.filter(e => /附錄：截圖原圖/.test(t.pdfText(t.tmpFile('zz.pdf', e.data)))).length === 2, 'ZIP 也支援附錄（有照片的兩家各有附錄，沒照片的那份沒有）');

    // ---- 附錄選項（介面）----
    await t.go(admin, `/batches/${ctx.bid}`);
    t.ok(await admin.$('#report-appendix') !== null, '有截圖的批次顯示「附錄原圖頁」選項');
    const href0 = await admin.$eval('#report-main-link', a => a.getAttribute('href'));
    await admin.click('#report-appendix');
    t.ok(await admin.$eval('#report-main-link', a => a.getAttribute('href')) === `${href0}?appendix=1`, '勾選後下載連結多了 ?appendix=1');
    t.ok(await admin.$eval('#report-appendix-field', e => !e.disabled), '選客戶的表單也帶 appendix=1');
    t.ok((await admin.$eval('#report-picker-form', f => [...new FormData(f).entries()].filter(e => e[0] === 'appendix'))).length === 1, '表單送出時包含 appendix=1');
    await admin.click('#report-appendix');
    t.ok(await admin.$eval('#report-main-link', a => a.getAttribute('href')) === href0 && await admin.$eval('#report-appendix-field', e => e.disabled), '取消勾選就恢復成單純連結');

    // ---- 只有一家客戶：沒有選單，ZIP 就是一份完整報告 ----
    t.q('UPDATE assets SET customer_id = ? WHERE id IN (?, ?)', ctx.cA, ctx.a2, pc);
    await t.go(admin, `/batches/${ctx.bid}`);
    t.ok(await admin.$('#report-picker') === null, '只涵蓋一家客戶：不顯示選客戶選單');
    const sz = readZip((await t.download(admin, `/batches/${ctx.bid}/reports.zip`)).buf);
    t.ok(sz.length === 1 && !/僅含上列客戶/.test(t.pdfText(t.tmpFile('sz.pdf', sz[0].data))), '只有一家客戶時，ZIP 是一份完整報告（沒有部分報告註記）');
  },
};
