// 客戶：統一編號（8 碼、不可重複）、客戶 CSV 匯出／匯入（先預覽、確認才寫入；ID 優先，其次統編，再來名稱）。
// 規則：欄位存在但空白＝清空、整欄不存在＝不動；匯入不會刪除客戶；「客戶ID」是系統流水號，不是統編。
const path = require('path');

module.exports = {
  name: '客戶（統編、CSV 匯出匯入）',
  needs: ['browser'],
  async run(t) {
    const admin = await t.login('admin');
    const sum = () => admin.$eval('.import-summary', e => e.textContent.replace(/\s+/g, ' ').trim());
    const card = () => admin.$eval('.card', e => e.textContent.replace(/\s+/g, ' '));
    const submit = (sel) => Promise.all([admin.waitForNavigation({ waitUntil: 'networkidle0' }), admin.click(sel)]);
    const upload = async (name, content) => {
      const f = t.tmpFile(name, content);
      await t.go(admin, '/admin/customers/import');
      await (await admin.$('input[type=file]')).uploadFile(f);
      await submit('button[type=submit].btn--primary');
    };
    const confirm = () => submit('form[action="/admin/customers/import/confirm"] button[type=submit]');
    const csvOf = async (u) => { const r = await t.download(admin, u); return r.buf.toString('utf8').replace(/^\ufeff/, '').trim().split(/\r?\n/).map(l => l.split(',')); };

    // ===== 統一編號（表單）=====
    const add = async (name, tax) => {
      await t.go(admin, '/admin/customers');
      await admin.$eval('#name', e => { e.value = ''; }); await admin.$eval('#tax_id', e => { e.value = ''; });
      await admin.type('#name', name);
      if (tax) await admin.evaluate((v) => { const e = document.querySelector('#tax_id'); e.removeAttribute('pattern'); e.removeAttribute('maxlength'); e.value = v; }, tax);
      await submit('form[action="/admin/customers"] button[type=submit]');
    };
    const err = () => admin.$eval('.form-error', e => e.textContent);
    await add('甲公司', '12345678');
    t.ok(t.q("SELECT tax_id AS t FROM customers WHERE name = '甲公司'")[0].t === '12345678', '可以新增帶統一編號的客戶');
    await add('乙公司', '');
    t.ok(t.q("SELECT tax_id AS t FROM customers WHERE name = '乙公司'")[0].t === null, '統一編號是選填（沒填存 NULL）');
    await add('丙公司', '1234567');
    t.ok(/8 碼數字/.test(await err()) && !t.q("SELECT 1 FROM customers WHERE name = '丙公司'").length, '7 碼被拒絕');
    await add('丙公司', 'ABCD1234');
    t.ok(/8 碼數字/.test(await err()), '含英文字母被拒絕');
    await add('丙公司', '12345678');
    t.ok(/已經是客戶「甲公司」/.test(await err()) && !t.q("SELECT 1 FROM customers WHERE name = '丙公司'").length, '重複的統編被拒絕，並說明是哪一家');
    await add('丙公司', '１２３４５６７９');
    t.ok(t.q("SELECT tax_id AS t FROM customers WHERE name = '丙公司'")[0].t === '12345679', '全形數字自動轉半形');
    await t.go(admin, '/admin/customers');
    t.ok(await admin.$$eval('th', a => a.some(x => x.textContent === '統一編號')) && await admin.$$eval('td', a => a.some(x => x.textContent === '12345678')), '客戶列表有「統一編號」欄');
    const aId = t.q("SELECT id FROM customers WHERE name = '甲公司'")[0].id;
    await t.go(admin, `/admin/customers?edit=${aId}`);
    t.ok(await admin.$eval('#tax_id', e => e.value) === '12345678', '編輯表單帶入統編');
    t.ok(await admin.$$eval('.page-actions a', a => ['匯出 CSV', '匯入 CSV', '下載空白範本'].every(x => a.some(y => y.textContent.trim() === x))), '客戶頁有匯出、匯入、下載空白範本');

    // ===== CSV 匯出／範本 =====
    const exp = await csvOf('/admin/customers/export.csv');
    t.ok(exp[0].join() === '客戶ID,客戶名稱,統一編號,簡稱／代碼,備註,狀態,設備數' && exp.find(r => r[1] === '甲公司')[2] === '12345678', '匯出有「統一編號」欄，欄位順序正確');
    const tpl = await t.download(admin, '/admin/customers/import-template.csv');
    t.ok(tpl.buf.toString('utf8').replace(/^\ufeff/, '').trim() === '客戶ID,客戶名稱,統一編號,簡稱／代碼,備註,狀態', '空白範本的表頭含統一編號');
    // 匯出 → 原樣匯入 ＝ 全部無變更
    await upload('rt.csv', '\ufeff' + exp.map(r => r.join(',')).join('\r\n') + '\r\n');
    t.ok(/無變更 3/.test(await sum()) && /新增 0/.test(await sum()) && /更新 0/.test(await sum()) && !(await admin.$('form[action="/admin/customers/import/confirm"]')), '匯出後原樣匯入：全部無變更、沒有東西需要確認');
    // 常見錯誤：把統編放進「客戶ID」欄
    await upload('wrongcol.csv', '客戶ID,客戶名稱\r\n28830371,雅比斯\r\n09479382,寶楠\r\n');
    t.ok(/錯誤（將略過）2/.test(await sum()) && /看起來像統一編號/.test(await card()), '統編放在「客戶ID」欄：整列報錯，並提示改用「統一編號」欄');

    // ===== 匯入：新增／更新／錯誤列（沒有統編欄的舊格式）=====
    const cB = t.q("SELECT id FROM customers WHERE name = '乙公司'")[0].id;
    await upload('main.csv', '\ufeff' + ['客戶ID,客戶名稱,簡稱／代碼,備註,狀態,設備數',
      ',新客戶X,X,新增的客戶,停用,99',
      ',a 公司,AA,,,',                          // 名稱對應（不分大小寫）→ 更新簡稱、備註留空＝清空
      `${cB},乙公司（改名）,,,啟用,`,            // 依 ID 更新並改名
      ',,Z,沒有名稱,,',
      ',新客戶X,X2,重複列,,',
      '9999,不存在的ID,,,,',
      'abc,壞ID,,,,',
      ',狀態亂填,,,不知道,',
      `,${'長'.repeat(41)},,,,`,
      ',含<>的名稱,,,,',
      `${aId},甲公司,,,,`,
      ''].join('\r\n'));
    // 注意：甲公司的名稱是「甲公司」，檔案裡的「a 公司」對不到任何人 → 會新增；這裡主要驗證各種錯誤列
    const s = await sum(); const prev = await card();
    t.ok(/新增 2/.test(s) && /更新 1/.test(s) && /錯誤（將略過）7/.test(s), `預覽：新增 2、更新 1、錯誤 7（${s}）`);
    t.ok(/客戶名稱：乙公司 → 乙公司（改名）/.test(prev), '有 ID 可以順便改名');
    t.ok(/客戶名稱不能空白/.test(prev) && /已經有同名/.test(prev) && /找不到客戶ID 9999/.test(prev) && /不是數字/.test(prev) && /看不懂/.test(prev) && /不能超過 40/.test(prev) && /不允許的字元/.test(prev), '各種錯誤列：空名稱、檔案內重複、不存在的 ID、非數字 ID、狀態亂填、太長、含不允許字元');
    t.ok(t.count('customers', '1=1') === 3, '預覽不會寫入任何資料');
    await confirm();
    t.ok(/新增 2/.test(await admin.$eval('.form-success', e => e.textContent)), '確認匯入後顯示結果');
    const x = t.q("SELECT * FROM customers WHERE name = '新客戶X'")[0];
    t.ok(x && x.code === 'X' && x.notes === '新增的客戶' && x.is_active === 0, '新增的客戶：簡稱、備註、狀態（停用）都正確');
    t.ok(t.q('SELECT name FROM customers WHERE id = ?', cB)[0].name === '乙公司（改名）', '依 ID 改名成功');

    // ===== 匯入：統一編號 =====
    await upload('tax.csv', ['客戶名稱,統一編號,簡稱／代碼',
      '雅比斯國際創意策略股份有限公司,28830371,雅比斯',
      '寶楠生技股份有限公司,9479382,',          // Excel 吃掉前導 0 → 補回 8 碼
      '甲公司（改名）,12345678,',                // 統編對到甲公司 → 改名
      '乙公司（改名）,12345678,',                // 名稱是乙、統編是甲 → 衝突
      '另一家,28830371,',                        // 檔案內統編重複
      '丙公司,99999999,',                        // 名稱對到丙，統編換新的
      '壞統編,1234,',
      ''].join('\r\n'));
    const s2 = await sum(); const c2 = await card();
    t.ok(/新增 2/.test(s2) && /更新 2/.test(s2) && /錯誤（將略過）3/.test(s2), `預覽：新增 2、更新 2、錯誤 3（${s2}）`);
    t.ok(/客戶名稱：甲公司 → 甲公司（改名）/.test(c2), '統編對得到 → 視為同一家，改名');
    t.ok(/統一編號 12345678 是客戶「甲公司」的，但名稱「乙公司（改名）」是另一個客戶/.test(c2), '統編與名稱對到不同客戶 → 報錯，不亂猜');
    t.ok(/已經用了同一個統一編號/.test(c2) && /8 碼數字/.test(c2), '檔案內統編重複、格式錯誤都被擋下');
    t.ok(/統一編號：12345679 → 99999999/.test(c2), '名稱對到的客戶會更新統編');
    await confirm();
    t.ok(t.q("SELECT tax_id AS t FROM customers WHERE name = '寶楠生技股份有限公司'")[0].t === '09479382', '7 碼統編建立時補成 8 碼（09479382）');
    t.ok(t.q("SELECT name FROM customers WHERE tax_id = '12345678'")[0].name === '甲公司（改名）' && t.q("SELECT tax_id AS t FROM customers WHERE name = '丙公司'")[0].t === '99999999', '確認後各項更新都生效');
    await upload('absent.csv', '客戶名稱,備註\r\n甲公司（改名）,x\r\n');
    t.ok(/更新 1/.test(await sum()), '沒有統編欄的檔案可以預覽');
    await confirm();
    t.ok(t.q("SELECT tax_id AS t FROM customers WHERE name = '甲公司（改名）'")[0].t === '12345678', '整欄不存在＝統編不動');
    await upload('clear.csv', '客戶名稱,統一編號\r\n甲公司（改名）,\r\n');
    t.ok(/清空/.test(await admin.$eval('.form-warning', e => e.textContent)), '欄位存在但空白＝清空，預覽會警告');
    await confirm();
    t.ok(t.q("SELECT tax_id AS t FROM customers WHERE name = '甲公司（改名）'")[0].t === null, '空白的統編儲存格確實清空');
    await upload('taxonly.csv', '統一編號,備註\r\n28830371,以統編更新\r\n');
    t.ok(/更新 1/.test(await sum()), '只有統編沒有名稱欄的檔案，也能用統編對應');
    await confirm();
    t.ok(t.q("SELECT notes AS n FROM customers WHERE tax_id = '28830371'")[0].n === '以統編更新', '依統編更新成功');
    t.ok(t.q('SELECT COUNT(*) AS n FROM (SELECT tax_id FROM customers WHERE tax_id IS NOT NULL GROUP BY tax_id HAVING COUNT(*) > 1)')[0].n === 0, '資料庫裡沒有重複的統編');

    // ===== 檔案層級錯誤、過期、編碼 =====
    await upload('c-nohdr.csv', 'foo,bar\r\n1,2\r\n');
    t.ok(/找不到「客戶名稱」、「統一編號」或「客戶ID」/.test(await admin.$eval('.form-error', e => e.textContent)), '沒有名稱／統編／ID 欄 → 檔案層級錯誤');
    await upload('c-dup.csv', '客戶名稱,客戶名稱\r\na,b\r\n');
    t.ok(/重複出現/.test(await admin.$eval('.form-error', e => e.textContent)), '表頭重複 → 檔案層級錯誤');
    await upload('c-empty.csv', '客戶名稱\r\n');
    t.ok(/沒有資料列/.test(await admin.$eval('.form-error', e => e.textContent)), '只有表頭 → 檔案層級錯誤');
    const dc = await admin.evaluate(async () => {
      const tok = document.querySelector('input[name=_csrf]') ? document.querySelector('input[name=_csrf]').value : '';
      const r = await fetch('/admin/customers/import/confirm', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + tok + '&token=deadbeef' });
      return { s: r.status, t: await r.text() };
    });
    t.ok(dc.s === 400 && /預覽已經過期/.test(dc.t), '不認得的確認碼 → 400「預覽已經過期」');
    // Big5（舊版 Excel「CSV（逗號分隔）」）：「客戶名稱,簡稱／代碼 / 大五碼客戶,Z5」
    await upload('c-big5.csv', Buffer.from('abc8a4e1a657bad92cc2b2bad9a1fea54ebd580d0aa46aa4adbd58abc8a4e12c5a350d0a', 'hex'));
    t.ok(/Big5/.test(await admin.$eval('.card .form-hint', e => e.textContent)) && /新增 1/.test(await sum()), 'Big5 編碼的檔案可以讀');
    await confirm();
    t.ok(t.q("SELECT code AS c FROM customers WHERE name = '大五碼客戶'")[0].c === 'Z5', 'Big5 內容匯入後中文正確');

    // ===== 權限 =====
    const wang = await t.login('wang');
    t.ok((await wang.goto(`${t.base}/admin/customers/import`)).status() === 403 && (await wang.goto(`${t.base}/admin/customers/export.csv`)).status() === 403, '沒有資產建檔權限的技術人員：403');
    const grp = t.q('SELECT id FROM permission_groups ORDER BY id LIMIT 1')[0].id;
    t.q('UPDATE users SET group_id = ? WHERE username = ?', grp, 'lin');
    const lin = await t.login('lin');
    t.ok((await lin.goto(`${t.base}/admin/customers/import`)).status() === 200, '有「管理資產建檔」權限的群組成員可以匯入');

    // ===== 報價單上的客戶統編 =====
    const { visibleAssetLines } = t.require('src/services/QuotePdfService');
    t.ok(visibleAssetLines({ customerName: 'X', customerTaxId: '28830371' }, {})[0] === '客戶：X（統編 28830371）', '報價請求的客戶行會帶統編');
  },
};
