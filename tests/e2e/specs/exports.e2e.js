// 批次清單與巡檢紀錄明細的 CSV 匯出：篩選（日期、客戶、範圍、嚴重度、類別）、欄位、容量磁碟區、公式防護、惡意參數。
module.exports = {
  name: '批次與巡檢紀錄 CSV 匯出',
  needs: ['browser'],
  async run(t) {
    const ctx = await t.mkReportBatch();
    const done = t.mkBatch({ title: '已完成的另一批', by: t.uid('wang'), status: 'completed', assets: 1, photos: false });
    t.q("UPDATE inspection_batches SET batch_date = '2026-09-10' WHERE id = ?", done.bid);
    // 讓資料有變化：警告／異常、公式開頭的備註、一個有磁碟區的項目
    t.q("UPDATE inspection_items SET status = 'warning' WHERE id IN (?, ?)", ctx.items[0], ctx.items[3]);
    t.q("UPDATE inspection_items SET status = 'critical' WHERE id = ?", ctx.items[4]);
    t.q("UPDATE inspection_items SET note = '=SUM(1) 公式測試' WHERE id = ?", ctx.items[1]);
    t.q("INSERT INTO inspection_item_volumes (inspection_item_id, name, used_gb, total_gb, sort_order) VALUES (?, 'C:', 420, 500, 0)", ctx.items[2]);
    t.q("INSERT INTO inspection_item_volumes (inspection_item_id, name, used_gb, total_gb, sort_order) VALUES (?, 'D:', 100, 1000, 1)", ctx.items[2]);
    const admin = await t.login('admin');
    const csv = async (u) => {
      const r = await t.download(admin, u);
      const { parseCsv } = t.require('src/utils/csv');
      return { r, table: r.status === 200 ? parseCsv(r.buf.toString('utf8').replace(/^\ufeff/, '')) : [] };
    };

    await t.go(admin, '/batches');
    t.ok(await admin.$$eval('.page-actions a', a => a.some(x => x.textContent === '匯出' && x.getAttribute('href').startsWith('/batches/export'))), '批次清單有「匯出」按鈕');
    await t.go(admin, '/batches/export');
    t.ok(await admin.$('#export-form') !== null && await admin.$$eval('#customer option', a => a.length) === 4, '匯出頁：篩選表單、客戶選項（全部、未指定、2 家）');
    await t.go(admin, `/batches/${ctx.bid}`);
    t.ok(await admin.$$eval('a', (a, href) => a.some(x => x.textContent.trim() === '匯出本批次紀錄' && x.getAttribute('href') === href), `/batches/export/records.csv?batch=${ctx.bid}`), '批次摘要頁有「匯出本批次紀錄」');

    // ---- 批次清單 ----
    const b = await csv('/batches/export/batches.csv');
    t.ok(b.r.status === 200 && /text\/csv/.test(b.r.type) && /inspection-batches-/.test(b.r.disp) && b.r.buf[0] === 0xEF, 'batches.csv：200、CSV、檔名、BOM');
    const nb = t.count('inspection_batches', '1=1');
    t.ok(b.table.length === nb + 1 && b.table[0].join() === '批次編號,標題,巡檢日期,狀態,涵蓋客戶,設備數,未指定客戶設備數,檢查項目數,警告項目數,異常項目數,建立者,建立時間,完成時間,備註', `表頭與資料列數（${nb} 個批次）`);
    const row = b.table.find(r => r[0] === String(ctx.bid));
    t.ok(row && row[4].split('、').sort().join() === ['乙公司', '甲公司'].sort().join() && row[5] === '2' && row[7] === '6' && row[8] === '2' && row[9] === '1', `批次列：涵蓋客戶、設備數、項目數、警告 2、異常 1（${JSON.stringify(row && row.slice(0, 10))}）`);
    const byCust = await csv(`/batches/export/batches.csv?customer=${ctx.cB}`);
    t.ok(byCust.table.length - 1 === 1 && byCust.table[1][0] === String(ctx.bid), '依客戶篩選批次（只有涵蓋乙公司的）');
    const byDate = await csv('/batches/export/batches.csv?from=2026-09-01&to=2026-09-30');
    t.ok(byDate.table.length - 1 === 1 && byDate.table[1][0] === String(done.bid), '依日期區間篩選');
    const completed = await csv('/batches/export/batches.csv?scope=completed');
    t.ok(completed.table.length - 1 === 1 && completed.table[1][0] === String(done.bid), '範圍＝只含已完成');

    // ---- 巡檢紀錄明細 ----
    const rec = await csv('/batches/export/records.csv');
    const ni = t.count('inspection_items', '1=1');
    const H = rec.table[0]; const col = (n) => H.indexOf(n);
    t.ok(rec.table.length === ni + 1 && H.join() === '批次編號,批次標題,巡檢日期,批次狀態,客戶,資產ID,設備名稱,類別,位置,IP位址,序號,財產編號,檢查項目,狀態,數值,最高使用率(%),磁碟區明細,備註,截圖數,記錄人,記錄時間', `明細：表頭與列數（${ni} 筆）`);
    const cap = rec.table.slice(1).find(r => r[col('磁碟區明細')]);
    t.ok(cap && Number(cap[col('最高使用率(%)')]) === 84 && /C: 已用 .* \/ 總容量 .* GB（/.test(cap[col('磁碟區明細')]) && /D:/.test(cap[col('磁碟區明細')]), `容量型項目：最高使用率（84%）與各磁碟區明細（${cap && cap[col('磁碟區明細')]}）`);
    t.ok(rec.table.slice(1).filter(r => r[col('設備名稱')] === 'ERP-DB01').every(r => r[col('客戶')] === '甲公司'), '客戶欄取自設備所屬客戶');
    t.ok(rec.table.slice(1).some(r => /^'=SUM/.test(r[col('備註')])), '開頭是 = 的備註前面補單引號（防 CSV 公式注入）');
    t.ok(rec.table.slice(1).every(r => ['正常', '警告', '異常'].includes(r[col('狀態')])), '狀態寫成「正常／警告／異常」');
    const ab = await csv('/batches/export/records.csv?severity=abnormal');
    t.ok(ab.table.length - 1 === 3 && ab.table.slice(1).every(r => r[col('狀態')] !== '正常'), '嚴重度＝警告＋異常（3 筆）');
    const cr = await csv('/batches/export/records.csv?severity=critical');
    t.ok(cr.table.length - 1 === 1, '嚴重度＝只要異常（1 筆）');
    const one = await csv(`/batches/export/records.csv?batch=${ctx.bid}`);
    t.ok(one.table.length - 1 === t.count('inspection_items', 'batch_id=?', ctx.bid) && one.table.slice(1).every(r => r[0] === String(ctx.bid)), '只匯出單一批次');
    const cu = await csv(`/batches/export/records.csv?customer=${ctx.cB}`);
    t.ok(cu.table.slice(1).length > 0 && cu.table.slice(1).every(r => r[col('客戶')] === '乙公司'), '依客戶篩選明細');
    const cn = await csv('/batches/export/records.csv?customer=none');
    t.ok(cn.table.slice(1).every(r => r[col('客戶')] === ''), '「未指定客戶」只含沒有客戶的設備');
    const catLabel = t.q("SELECT label FROM asset_categories WHERE code = 'server'")[0].label;
    const cat = await csv('/batches/export/records.csv?category=server');
    t.ok(cat.table.length > 1 && cat.table.slice(1).every(r => r[col('類別')] === catLabel), '依設備類別篩選');
    const dt = await csv('/batches/export/records.csv?from=2026-10-01&to=2026-10-31');
    t.ok(dt.table.length > 1 && dt.table.slice(1).every(r => r[2] >= '2026-10-01' && r[2] <= '2026-10-31'), '依日期區間篩選明細');
    const evil = await csv("/batches/export/records.csv?customer=1%27%20OR%201%3D1&batch=abc&from=%3Cscript%3E&severity=x&category=%27%3B%20drop");
    t.ok(evil.r.status === 200 && evil.table.length === 1, '惡意參數只當成一般值綁定：沒有符合的列、沒有錯誤');
    t.ok(t.count('inspection_items', '1=1') === ni, '資料表完好（沒有被注入）');

    // ---- 權限 ----
    const wang = await t.login('wang');
    t.ok((await t.download(wang, '/batches/export/records.csv')).status === 200, '任何登入的人都可以匯出');
    t.ok((await fetch(`${t.base}/batches/export/records.csv`, { redirect: 'manual' })).status === 302, '未登入導向登入頁');
  },
};
