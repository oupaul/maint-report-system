// 資產列表：可選欄位（記在瀏覽器）、固定名稱／編輯欄、名稱連結與容量趨勢標籤、分組展開收合、批次操作（設定客戶、刪除）。
module.exports = {
  name: '資產列表（欄位、固定欄、分組、批次操作）',
  needs: ['browser'],
  async run(t) {
    const cA = t.mkCustomer('甲公司', { taxId: '12345678' }), cB = t.mkCustomer('乙公司');
    const erp = t.mkAsset('ERP-DB01', { category: 'server', customerId: cA });
    t.mkAsset('SVR-02', { category: 'server', customerId: cB });
    const nas = t.mkAsset('NAS-01', { category: 'nas', customerId: cB });
    const pcs = [1, 2, 3].map(i => t.mkAsset(`PC-00${i}`, { category: 'pc', customerId: i === 1 ? cA : null }));
    // ERP-DB01 有磁碟區資料 → 名稱旁會有「容量趨勢」標籤
    const b = t.mkBatch({ title: '趨勢用批次', by: t.uid('admin'), assets: 1, photos: false });
    t.q("INSERT INTO inspection_item_volumes (inspection_item_id, name, used_gb, total_gb, sort_order) VALUES (?, 'C:', 100, 500, 0)", b.itemIds[0]);
    t.q('UPDATE inspection_batch_assets SET asset_id = ? WHERE batch_id = ?', erp, b.bid);
    t.q('UPDATE inspection_items SET asset_id = ? WHERE id = ?', erp, b.itemIds[0]);

    const p = await t.login('admin', t.PASSWORD, { width: 900, height: 900 });
    const vis = () => p.$$eval('.asset-table thead th', a => a.filter(x => !x.hidden).map(x => x.textContent.replace(/\s+/g, ' ').trim()));
    await t.go(p, '/assets?group=1&per=100');
    await p.evaluate(() => localStorage.clear());
    await t.go(p, '/assets?group=1&per=100');

    // ---- 欄位選擇 ----
    let h = await vis();
    t.ok(h.join('|') === '|名稱|客戶|位置|IP / MAC|狀態|', `預設欄位：勾選、名稱、客戶、位置、IP／MAC、狀態、操作（${h.join('｜')}）`);
    t.ok(await p.$eval('#col-chooser', e => !e.hidden), '「顯示欄位」選單在有 JavaScript 時出現');
    t.ok(await p.$$eval('[data-col-toggle]', a => a.length) >= 9, '選單列出可選的欄位');
    await p.click('#col-chooser summary'); await p.click('[data-col-toggle="serial"]'); await p.click('[data-col-toggle="tags"]');
    h = await vis();
    t.ok(h.some(x => x === '序號') && h.some(x => x === '標籤'), '勾選後顯示序號與標籤欄');
    const nvis = h.length;
    t.ok((await p.$$eval('.group-row td', a => a.map(x => x.colSpan))).every(c => c === nvis), `分組標題列的 colspan 跟著可見欄數（${nvis}）`);
    await t.go(p, '/assets?group=1&per=100');
    h = await vis();
    t.ok(h.some(x => x === '序號') && h.some(x => x === '標籤'), '欄位選擇在重新整理後仍然記得');
    await p.click('#col-chooser summary'); await p.click('#col-reset');
    h = await vis();
    t.ok(!h.some(x => x === '序號') && h.includes('客戶'), '「恢復預設」還原');

    // ---- 名稱連結、容量趨勢、編輯欄 ----
    const nm = await p.$eval('.asset-table tbody tr[data-g] .col-name a.asset-name', a => [a.textContent, a.getAttribute('href')]);
    t.ok(/^\/assets\/\d+\/edit$/.test(nm[1]), `名稱連到編輯頁（${nm.join(' ')}）`);
    const trend = await p.$$eval('.trend-chip', a => a.map(x => x.getAttribute('href')));
    t.ok(trend.length === 1 && trend[0] === `/capacity/assets/${erp}`, `容量型設備的名稱旁有「容量趨勢」標籤（${trend.join()}）`);
    t.ok(await p.$$eval('.col-actions .btn', a => a.length > 0 && a.every(x => /\/edit$/.test(x.getAttribute('href')))), '有編輯按鈕欄');

    // ---- 固定欄位：視窗窄、所有欄位全開、橫向捲到最右 ----
    await p.evaluate(() => localStorage.setItem('assetList.columns', JSON.stringify([...document.querySelectorAll('[data-col-toggle]')].map(x => x.dataset.colToggle))));
    await t.go(p, '/assets?group=1&per=100');
    const pos = await p.evaluate(() => ({ n: getComputedStyle(document.querySelector('.col-name')).position, a: getComputedStyle(document.querySelector('.col-actions')).position, wide: (() => { const w = document.querySelector('.table-wrap'); return w.scrollWidth > w.clientWidth; })() }));
    t.ok(pos.n === 'sticky' && pos.a === 'sticky' && pos.wide, '名稱欄與編輯欄是 sticky；全部欄位打開時表格比視窗寬');
    await p.evaluate(() => { document.querySelector('.table-wrap').scrollLeft = 99999; }); await t.sleep(200);
    const r1 = await p.evaluate(() => { const w = document.querySelector('.table-wrap').getBoundingClientRect(); const e = document.querySelector('tr[data-g] .col-actions .btn').getBoundingClientRect(); return { wr: w.right, wl: w.left, er: e.right, el: e.left }; });
    t.ok(r1.er <= r1.wr + 1 && r1.el >= r1.wl, '橫向捲到最右：編輯按鈕仍在可視範圍內');
    await p.evaluate(() => { document.querySelector('.table-wrap').scrollLeft = 300; }); await t.sleep(200);
    const r2 = await p.evaluate(() => { const w = document.querySelector('.table-wrap').getBoundingClientRect(); const n = document.querySelector('tr[data-g] .col-name').getBoundingClientRect(); const g = document.querySelector('.group-toggle').getBoundingClientRect(); return { nl: n.left, wl: w.left, gl: g.left }; });
    t.ok(r2.nl <= r2.wl + 61 && r2.nl >= r2.wl - 1, '往右捲時名稱欄固定在左邊');
    t.ok(r2.gl >= r2.wl - 1 && r2.gl < r2.wl + 120, '分組標題的展開按鈕在捲動時仍看得到');
    await p.evaluate(() => localStorage.removeItem('assetList.columns'));

    // ---- 分組 ----
    await t.go(p, '/assets?group=1&per=100');
    t.ok(await p.$eval('#groups-collapse', e => !e.hidden), '有「全部展開／全部收合」');
    await p.click('#groups-collapse'); await t.sleep(100);
    t.ok(await p.$$eval('tr[data-g]', a => a.every(x => x.hidden)), '全部收合：每個設備列都隱藏');
    await t.go(p, '/assets?group=1&per=100');
    t.ok(await p.$$eval('tr[data-g]', a => a.every(x => x.hidden)), '收合狀態在重新整理後仍然記得');
    await p.click('.group-toggle'); await t.sleep(100);
    const grp = await p.$eval('.group-row', r => r.dataset.group);
    const open = await p.$$eval('tr[data-g]', a => a.filter(x => !x.hidden).length);
    t.ok(open > 0 && open === await p.$$eval(`tr[data-g="${grp}"]`, a => a.length), '可以單獨展開某一組');
    await p.click('#groups-expand'); await t.sleep(100);
    t.ok(await p.$$eval('tr[data-g]', a => a.every(x => !x.hidden)), '全部展開：每一列都顯示');
    await p.evaluate(() => localStorage.clear());
    await t.go(p, '/assets?group=0&per=50');
    h = await vis();
    t.ok(h.some(x => x.startsWith('類別')), '平面列表預設顯示「類別」欄');
    t.ok(await p.$('#groups-collapse') === null, '平面模式沒有展開／收合按鈕');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('.asset-table thead a.sort-link[title="依名稱排序"]')]);
    t.ok(/sort=name/.test(p.url()), '標題排序連結仍可用');

    // ---- 批次操作：設定客戶 ----
    await t.go(p, '/assets?per=50');
    t.ok(await p.$('#bulk-customer') !== null && await p.$('#bulk-delete') !== null, '有客戶時：批次操作列同時有「設定客戶」與「刪除」');
    t.ok(await p.$eval('#bulk-apply', e => e.disabled) && await p.$eval('#bulk-delete', e => e.disabled), '沒勾選時兩個按鈕都停用');
    const [x1, x2] = [pcs[1], pcs[2]];
    await p.click(`input.row-check[value="${x1}"]`); await p.click(`input.row-check[value="${x2}"]`);
    t.ok(await p.$eval('#bulk-count', e => e.textContent) === '2' && await p.$eval('#bulk-del-count', e => e.textContent) === '2' && !await p.$eval('#bulk-apply', e => e.disabled), '兩個計數都是 2，「套用」可按');
    await p.evaluate((id) => { const s = document.querySelector('#bulk-customer'); s.value = String(id); s.dispatchEvent(new Event('change', { bubbles: true })); }, cA);
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('#bulk-apply')]);
    t.ok(/ok=customer&n=2/.test(p.url()) && t.count('assets', 'customer_id = ? AND id IN (?, ?)', cA, x1, x2) === 2, `套用（經過客戶確認視窗）：兩台都設為甲公司（${p.url().split('?')[1]}）`);
    await t.go(p, '/assets?per=50');
    await p.click('#bulk-all');
    t.ok(!await p.$eval('#bulk-apply', e => e.disabled) && await p.$eval('#bulk-delete', e => e.disabled), '「目前篩選條件下的全部」讓套用可按，但刪除仍要勾選（刪除只作用在勾選的列）');
    await p.click('#bulk-all'); await p.click('#select-all');
    const n = await p.$$eval('.row-check', a => a.length);
    t.ok(await p.$eval('#bulk-del-count', e => e.textContent) === String(n) && !await p.$eval('#bulk-delete', e => e.disabled), `全選本頁勾起每一列（${n}）並啟用刪除`);
    p.removeAllListeners('dialog'); p.on('dialog', d => d.dismiss());
    const before = t.count('assets', '1=1');
    await p.click('#bulk-delete'); await t.sleep(600);
    t.ok(t.count('assets', '1=1') === before && /\/assets/.test(p.url()), '在確認視窗按取消：什麼都不會送出');

    // ---- 沒有資產建檔權限的人：沒有勾選欄與編輯欄，名稱不是連結，容量趨勢標籤還在 ----
    const wang = await t.login('wang');
    await t.go(wang, '/assets?q=ERP&group=1');
    t.ok(await wang.$('.col-sel') === null && await wang.$('.col-actions') === null, '一般技術人員：沒有勾選與編輯欄');
    t.ok(await wang.$('.asset-table tbody .col-name a.asset-name') === null && (await wang.$$('.trend-chip')).length > 0, '名稱是純文字，容量趨勢標籤仍在');
  },
};
