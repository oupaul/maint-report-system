// 可搜尋下拉（客戶很多時）：點進去不展開、輸入才過濾（名稱／統編／代碼）、▾ 展開全部、清空＝回到「全部」、必填驗證、快速新增列。
// 程式在 src/public/js/combo-select.js；選項 8 個以上才啟用，少的時候維持原生下拉。
module.exports = {
  name: '可搜尋的客戶下拉',
  needs: ['browser'],
  async run(t) {
    const NAMES = ['雅比斯國際', '保音股份', '保技鋁業', '小智研發', '台灣麒麟啤酒', '前茂企業', '以仁國際醫療', '迅捷開發', '寶楠生技', '友泰旅行社', '大於生醫', '必達電子'];
    const cid = {};
    NAMES.forEach((n, i) => { cid[n] = t.mkCustomer(n, { taxId: String(10000000 + i * 1111111), code: i === 3 ? 'XZ' : null }); });
    const mk = (name, customer) => t.mkAsset(name, { customerId: cid[customer] });
    mk('設備一', '保音股份'); mk('設備二', '保音股份'); mk('設備三', '保音股份'); mk('設備四', '保技鋁業');
    const p = await t.login('admin', t.PASSWORD, { width: 1400, height: 900 });
    const opts = () => p.$$eval('.cs__list:not([hidden]) .cs__opt', a => a.map(x => x.textContent));
    const listOpen = async () => await p.$('.cs__list:not([hidden])') !== null;
    const selectAll = () => p.$eval('#asset-filter .cs__input', e => e.select());

    // ---- 資產列表的客戶篩選 ----
    await t.go(p, '/assets?per=50');
    t.ok(await p.$('#asset-filter .cs') !== null && await p.$eval('#asset-filter select[name=customer]', e => e.classList.contains('cs__native')), '客戶篩選被包裝成搜尋框（原生 select 保留、視覺上隱藏）');
    await p.click('#asset-filter .cs__input'); await t.sleep(100);
    t.ok(!await listOpen() && (await opts()).length === 0, '點進空的搜尋框不會展開一長串客戶');
    await p.keyboard.press('ArrowDown'); await t.sleep(60);
    let l = await opts();
    t.ok(l.length === 14 && /^全部客戶/.test(l[0]), `按 ↓ 才列出全部（${l.length} 筆，含「全部客戶」「未指定客戶」）`);
    await p.keyboard.press('Escape'); await t.sleep(60);
    t.ok(!await listOpen(), 'Esc 關閉');
    t.ok(await p.$('#asset-filter .cs__toggle') !== null, '搜尋框右側有 ▾ 按鈕');
    await p.click('#asset-filter .cs__toggle'); await t.sleep(80); l = await opts();
    t.ok(l.length === 14, `點 ▾ 展開完整清單（${l.length}）`);
    t.ok(await p.evaluate(() => document.activeElement.classList.contains('cs__input')), '點 ▾ 後焦點仍在搜尋框');
    await p.click('#asset-filter .cs__toggle'); await t.sleep(80);
    t.ok(!await listOpen(), '再點一次 ▾ 收合');
    await p.click('#asset-filter .cs__toggle'); await t.sleep(80);
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.evaluate(() => {
      const li = [...document.querySelectorAll('.cs__list:not([hidden]) .cs__opt')].find(x => x.textContent.startsWith('保音'));
      li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    })]);
    t.ok(new URL(p.url()).searchParams.get('customer') === String(cid['保音股份']), '從完整清單點選：篩選自動套用');
    await t.go(p, '/assets?per=50');
    await p.click('#asset-filter .cs__input'); await t.sleep(80);
    await p.keyboard.type('保'); await t.sleep(100); l = await opts();
    t.ok(l.length === 2 && l.every(x => x.includes('保')), `輸入「保」只剩符合的客戶：${l.join('｜')}`);
    await p.keyboard.type('技'); await t.sleep(100); l = await opts();
    t.ok(l.length === 1 && /保技鋁業/.test(l[0]), '再輸入一個字繼續縮小');
    await selectAll(); await p.keyboard.type('xyz'); await t.sleep(100);
    t.ok(await p.$eval('.cs__list:not([hidden]) .cs__empty', e => e.textContent) === '沒有符合的項目', '沒有符合時顯示「沒有符合的項目」');
    const tax = t.q('SELECT tax_id AS x FROM customers WHERE name = ?', '小智研發')[0].x;
    await selectAll(); await p.keyboard.type(tax); await t.sleep(100); l = await opts();
    t.ok(l.length === 1 && /小智研發/.test(l[0]), '用統一編號搜尋找得到客戶');
    await selectAll(); await p.keyboard.type('xz'); await t.sleep(100); l = await opts();
    t.ok(l.length === 1 && /小智研發/.test(l[0]), '用簡稱／代碼搜尋（不分大小寫）找得到客戶');
    await selectAll(); await p.keyboard.type('保音'); await t.sleep(100);
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.keyboard.press('Enter')]);
    t.ok(new URL(p.url()).searchParams.get('customer') === String(cid['保音股份']), 'Enter 選取，並自動套用篩選');
    t.ok(await p.$eval('#asset-filter .cs__input', e => e.value) === '保音股份（3）' && await p.$$eval('tbody tr[data-g]', a => a.length) === 3, '重新載入後輸入框顯示所選客戶，列表只剩 3 台');
    await p.click('#asset-filter .cs__input'); await t.sleep(80); await p.keyboard.type('zzz'); await p.keyboard.press('Escape'); await t.sleep(50);
    t.ok(await p.$eval('#asset-filter .cs__input', e => e.value) === '保音股份（3）' && !await listOpen(), 'Esc 放棄輸入、還原原本的選擇');
    await p.click('#asset-filter .cs__input'); await t.sleep(80); await p.keyboard.type('保技'); await t.sleep(80);
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('.cs__list:not([hidden]) .cs__opt')]);
    t.ok(new URL(p.url()).searchParams.get('customer') === String(cid['保技鋁業']), '用滑鼠點選項目也會選取');
    await p.click('#asset-filter .cs__input'); await t.sleep(80); await p.keyboard.type('保'); await t.sleep(80);
    t.ok(await listOpen(), '輸入後會開啟符合的選項');
    await p.mouse.click(5, 5); await t.sleep(100);
    t.ok(!await listOpen() && await p.$eval('#asset-filter .cs__input', e => e.value) === '保技鋁業（1）', '點到外面：關閉並還原所選的客戶');
    await p.click('#asset-filter .cs__input'); await t.sleep(80); await p.keyboard.press('Backspace'); await t.sleep(60);
    t.ok(!await listOpen(), '把文字刪光：不列任何選項');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.keyboard.press('Tab')]);
    t.ok(!new URL(p.url()).searchParams.get('customer') && await p.$eval('#asset-filter .cs__input', e => e.value) === '', '刪光後離開＝全部客戶（篩選移除，輸入框留空）');
    await p.click('#asset-filter .cs__input'); await t.sleep(80); await p.keyboard.press('ArrowDown'); await t.sleep(50);
    t.ok(await p.$$eval('.cs__list:not([hidden]) .cs__opt', a => a.filter(x => x.classList.contains('is-active')).length) === 1, '↓ 移動時只有一個項目被標示');
    await p.keyboard.press('Escape');

    // ---- 批次設定客戶、新增設備（必填）----
    await t.go(p, '/assets?per=50');
    t.ok(await p.$('#bulk-bar .cs') !== null, '批次設定客戶的下拉也可以搜尋');
    await p.click('#bulk-bar .cs__input'); await t.sleep(80); await p.keyboard.type('以仁'); await t.sleep(100); await p.keyboard.press('Enter');
    t.ok(await p.$eval('#bulk-customer', e => e.value) === String(cid['以仁國際醫療']), '搜尋後選取，原生 select 的值跟著改變');
    await t.go(p, '/assets/new');
    t.ok(await p.$('#customer_id-cs') !== null && await p.$('label[for="customer_id-cs"]') !== null, '新增設備的客戶欄可搜尋，label 指到新的輸入框');
    await p.type('#name', '搜尋測試設備');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null), p.click('form[action="/assets"] button[type=submit]')]);
    t.ok(await p.evaluate(() => document.activeElement && document.activeElement.id) === 'customer_id-cs' && !t.q("SELECT 1 FROM assets WHERE name = '搜尋測試設備'").length, '必填的客戶沒選：送不出去，焦點移到搜尋框');
    await p.click('#customer_id-cs'); await t.sleep(80); await p.keyboard.type('寶楠'); await t.sleep(100); await p.keyboard.press('Enter');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('form[action="/assets"] button[type=submit]')]);
    const made = t.q("SELECT customer_id AS c FROM assets WHERE name = '搜尋測試設備'")[0];
    t.ok(made && made.c === cid['寶楠生技'], '用搜尋選的客戶，設備確實建立在那個客戶底下');
    await t.go(p, `/assets/${t.q('SELECT id FROM assets WHERE name = ?', '設備一')[0].id}/edit`);
    t.ok(await p.$eval('#customer_id-cs', e => e.value) === '保音股份', '編輯頁在輸入框顯示目前的客戶');

    // ---- 其他頁面的客戶篩選 ----
    for (const u of ['/batches', '/batches/export']) {
      await t.go(p, u);
      t.ok(await p.$('select[name=customer].cs__native') !== null, `${u} 的客戶篩選也可搜尋`);
    }

    // ---- 建立批次的「快速新增設備」列 ----
    await t.go(p, '/batches/new');
    t.ok(await p.$$eval('#new-asset-rows .cs', a => a.length) === 1, '快速新增：第一列的客戶可搜尋');
    await p.click('#add-asset-row'); await p.click('#add-asset-row');
    t.ok(await p.$$eval('#new-asset-rows .new-asset-row', a => a.length) === 3 && await p.$$eval('#new-asset-rows .new-asset-row', a => a.every(r => r.querySelectorAll('.cs').length === 1 && r.querySelectorAll('select[name=new_asset_customer]').length === 1 && r.querySelectorAll('.cs__input').length === 1)), '新增的每一列只有一個搜尋框（沒有重複的包裝）');
    const rowInput = (i) => `#new-asset-rows .new-asset-row:nth-child(${i}) .cs__input`;
    await p.click(rowInput(1)); await t.sleep(80); await p.keyboard.type('保音'); await t.sleep(80); await p.keyboard.press('Enter');
    await p.click(rowInput(3)); await t.sleep(80); await p.keyboard.type('寶楠'); await t.sleep(80); await p.keyboard.press('Enter');
    const vals = await p.$$eval('#new-asset-rows select[name=new_asset_customer]', a => a.map(x => x.value));
    t.ok(vals[0] === String(cid['保音股份']) && vals[1] === '' && vals[2] === String(cid['寶楠生技']), `各列各自選擇（${vals.join('/')}）`);
    t.ok((await p.$$eval('#new-asset-rows .cs__input', a => a.map(x => x.value))).join('|') === '保音股份||寶楠生技', '各列的輸入框顯示各自的選擇');
    await p.click(rowInput(2)); await t.sleep(80); await p.keyboard.type('小智'); await t.sleep(80);
    t.ok((await opts()).length === 1 && /小智研發/.test((await opts())[0]), '新增出來的列也能搜尋');
    await p.keyboard.press('Escape');
    // 真的送出：原本那列與複製出來的列，客戶都要存進去
    await p.type('input[name=title]', '快速新增搜尋批次'); await p.$eval('input[name=batch_date]', e => { e.value = '2026-10-19'; });
    await p.type('#new-asset-rows .new-asset-row:nth-child(1) input[name=new_asset_name]', 'QA設備一');
    await p.type('#new-asset-rows .new-asset-row:nth-child(3) input[name=new_asset_name]', 'QA設備二');
    await p.click(rowInput(2)); await t.sleep(80); await p.keyboard.press('Backspace');
    await p.evaluate(() => { document.querySelector('#new-asset-rows .new-asset-row:nth-child(2)').remove(); });
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('form[action="/batches/new"] button[type=submit]')]);
    const created = t.q("SELECT name, customer_id AS c FROM assets WHERE name IN ('QA設備一', 'QA設備二') ORDER BY name");
    t.ok(created.length === 2 && created[0].c === cid['保音股份'] && created[1].c === cid['寶楠生技'], '送出批次：原本那列和複製出來的列，搜尋選的客戶都正確存進資料庫');

    // ---- 選項少於 8 個 → 維持原生下拉 ----
    for (const n of NAMES.slice(0, 12)) { if (!['保音股份', '保技鋁業'].includes(n) && !t.count('assets', 'customer_id = ?', cid[n])) t.q('DELETE FROM customers WHERE id = ?', cid[n]); }
    await t.go(p, '/assets?per=50');
    t.ok(await p.$('#asset-filter .cs') === null && await p.$('#asset-filter select[name=customer]:not(.cs__native)') !== null, '選項少於 8 個時維持一般下拉');
  },
};
