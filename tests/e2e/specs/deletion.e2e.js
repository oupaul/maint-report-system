// 刪除與封存：批次、批次內的設備（含「在巡檢中新增的設備」）、設備（含批次刪除）、使用者、系統通知、稽核紀錄。
// 規則見 src/services/DeletionService.js 開頭的說明。
const fs = require('fs');
const path = require('path');
const argon2 = require('argon2');

const enc = encodeURIComponent;

module.exports = {
  name: '刪除、移出與封存',
  needs: ['browser'],
  async run(t) {
    const ADMIN = t.uid('admin'), WANG = t.uid('wang'), LIN = t.uid('lin');
    const NOW = t.NOW;
    const audit = (action) => t.q('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC', action);
    const count = (tb, w, ...a) => t.count(tb, w, ...a);
    const adm = await t.login('admin'), wang = await t.login('wang'), lin = await t.login('lin');
    const go = (p, u) => t.go(p, u), post = (p, u, b) => t.post(p, u, b);
    const custA = t.mkCustomer('甲公司');

    // ===== 1. 批次刪除 =====
    const b1 = t.mkBatch({ title: '刪除測試A', by: WANG, signature: true });
    await go(wang, `/batches/${b1.bid}`);
    t.ok(await wang.$('#batch-manage form[action$="/delete"]') !== null, '建立者在草稿批次看得到刪除表單');
    await go(lin, `/batches/${b1.bid}`);
    t.ok(await lin.$('#batch-manage') === null, '其他技術人員看不到任何管理區塊');
    let r = await post(lin, `/batches/${b1.bid}/delete`, 'confirm_title=' + enc(b1.title));
    t.ok(r.status === 403 && count('inspection_batches', 'id=?', b1.bid) === 1, '其他技術人員不能刪（403，批次還在）');
    await go(wang, `/batches/${b1.bid}`);
    r = await post(wang, `/batches/${b1.bid}/delete`, 'confirm_title=' + enc('隨便打'));
    t.ok(r.status === 400 && /完全相同/.test(r.text) && count('inspection_batches', 'id=?', b1.bid) === 1, '確認標題打錯：拒絕');
    r = await post(wang, `/batches/${b1.bid}/delete`, '');
    t.ok(r.status === 400 && count('inspection_batches', 'id=?', b1.bid) === 1, '沒填確認標題：拒絕');
    r = await post(wang, `/batches/${b1.bid}/delete`, 'confirm_title=' + enc(b1.title));
    t.ok(r.status === 200 && /\/batches\?ok=deleted/.test(r.url) && /已刪除批次/.test(r.text), '建立者輸入正確標題 → 刪除並回到清單顯示訊息');
    t.ok(count('inspection_batches', 'id=?', b1.bid) === 0 && count('inspection_items', 'batch_id=?', b1.bid) === 0 && count('inspection_batch_assets', 'batch_id=?', b1.bid) === 0
      && count('batch_signatures', 'batch_id=?', b1.bid) === 0 && count('notifications', 'batch_id=?', b1.bid) === 0 && count('inspection_item_photos', 'path LIKE ?', b1.dir + '%') === 0,
    '所有資料列都刪乾淨（批次、檢查項目、設備連結、簽名、通知、截圖）');
    t.ok(b1.files.every(f => !fs.existsSync(f)) && !fs.existsSync(b1.dir), '截圖、簽名檔與批次資料夾也從磁碟消失');
    t.ok(count('assets', 'id=?', b1.aids[0]) === 1, '批次裡的設備本身不會被刪');
    const a1 = audit('batch.delete')[0];
    t.ok(a1 && a1.username === 'wang' && a1.target_label === b1.title && /設備 2 台/.test(a1.detail), `寫入稽核紀錄（${a1 && a1.detail}）`);
    const b2 = t.mkBatch({ title: '刪除測試B', by: WANG });
    await go(adm, `/batches/${b2.bid}`);
    await post(adm, `/batches/${b2.bid}/delete`, 'confirm_title=' + enc(b2.title));
    t.ok(count('inspection_batches', 'id=?', b2.bid) === 0, '管理員可以刪別人的草稿');

    const bc = t.mkBatch({ title: '已完成批次', by: WANG, status: 'completed' });
    await go(wang, `/batches/${bc.bid}`);
    t.ok(await wang.$('#batch-manage form[action$="/delete"]') === null && /不能刪除這個批次/.test(await wang.$eval('#batch-manage', e => e.textContent)), '已完成的批次：沒有刪除表單，顯示原因');
    r = await post(wang, `/batches/${bc.bid}/delete`, 'confirm_title=' + enc(bc.title));
    t.ok(r.status === 409 && count('inspection_batches', 'id=?', bc.bid) === 1, '已完成的批次不能刪（409）');
    for (const ap of ['pending', 'returned', 'approved']) {
      const bb = t.mkBatch({ title: '送審過-' + ap, by: WANG, approval: ap });
      await go(wang, `/batches/${bb.bid}`);
      r = await post(wang, `/batches/${bb.bid}/delete`, 'confirm_title=' + enc(bb.title));
      t.ok(r.status === 409 && count('inspection_batches', 'id=?', bb.bid) === 1, `簽核狀態 ${ap} 的批次不能刪`);
    }
    const bq = t.mkBatch({ title: '有報價', by: WANG });
    t.q("INSERT INTO quote_requests (asset_id, asset_snapshot, source_batch_id, urgency, status, requested_by, requested_at, updated_at) VALUES (?, '{}', ?, 'normal', 'sent', ?, ?, ?)", bq.aids[0], bq.bid, WANG, NOW, NOW);
    await go(wang, `/batches/${bq.bid}`);
    r = await post(wang, `/batches/${bq.bid}/delete`, 'confirm_title=' + enc(bq.title));
    t.ok(r.status === 409 && /報價/.test(r.text) && count('inspection_batches', 'id=?', bq.bid) === 1, '被報價請求引用的批次不能刪');

    // ===== 2. 批次內移出設備 =====
    const m1 = t.mkBatch({ title: '移出測試', by: WANG, assets: 3 });
    await go(wang, `/batches/${m1.bid}/entry`);
    t.ok((await wang.$$('form[action$="/remove"]')).length === 3, '填寫頁：建立者在每台設備旁都有移出按鈕（3 台）');
    await go(lin, `/batches/${m1.bid}/entry`);
    t.ok((await lin.$$('form[action$="/remove"]')).length === 0, '其他技術人員看不到移出按鈕');
    await go(wang, `/batches/${m1.bid}/entry`);
    const msg = await wang.$eval(`form[action$="/assets/${m1.aids[0]}/remove"]`, f => f.dataset.confirm);
    t.ok(/2 筆檢查紀錄/.test(msg) && /永久刪除/.test(msg), '確認訊息寫明會刪掉幾筆檢查紀錄');
    r = await post(lin, `/batches/${m1.bid}/assets/${m1.aids[0]}/remove`);
    t.ok(r.status === 403 && count('inspection_batch_assets', 'batch_id=?', m1.bid) === 3, '其他技術人員不能移出（403）');
    await go(wang, `/batches/${m1.bid}/entry`);
    const first = t.q('SELECT p.path FROM inspection_item_photos p JOIN inspection_items i ON i.id = p.inspection_item_id WHERE i.batch_id = ? AND i.asset_id = ?', m1.bid, m1.aids[0]).map(x => x.path);
    r = await post(wang, `/batches/${m1.bid}/assets/${m1.aids[0]}/remove`);
    t.ok(r.status === 200 && /ok=removed/.test(r.url) && /已把設備移出/.test(r.text) && count('inspection_batch_assets', 'batch_id=? AND asset_id=?', m1.bid, m1.aids[0]) === 0
      && count('inspection_items', 'batch_id=? AND asset_id=?', m1.bid, m1.aids[0]) === 0, '移出設備：刪除連結與它在這個批次的檢查項目');
    t.ok(first.length === 2 && first.every(f => !fs.existsSync(f)) && count('inspection_items', 'batch_id=?', m1.bid) === 4 && count('assets', 'id=?', m1.aids[0]) === 1, '它的截圖被刪、其他設備的紀錄不動、設備本身還在');
    t.ok(audit('batch.remove_asset').length === 1, '稽核紀錄有一筆移出');
    await go(wang, `/batches/${m1.bid}/entry`);
    await post(wang, `/batches/${m1.bid}/assets/${m1.aids[1]}/remove`);
    await go(wang, `/batches/${m1.bid}/entry`);
    t.ok((await wang.$$('form[action$="/remove"]')).length === 0, '剩一台時移出按鈕消失');
    r = await post(wang, `/batches/${m1.bid}/assets/${m1.aids[2]}/remove`);
    t.ok(r.status === 400 && /至少要保留/.test(r.text) && count('inspection_batch_assets', 'batch_id=?', m1.bid) === 1, '最後一台不能移出');
    const m2 = t.mkBatch({ title: '移出-已送審', by: WANG, assets: 2, approval: 'pending' });
    await go(wang, `/batches/${m2.bid}`);
    r = await post(wang, `/batches/${m2.bid}/assets/${m2.aids[0]}/remove`);
    t.ok(r.status >= 400 && count('inspection_batch_assets', 'batch_id=?', m2.bid) === 2, '鎖定中（審核中）的批次不能移出');
    const m3 = t.mkBatch({ title: '移出-有報價', by: WANG, assets: 2 });
    const qid = t.q("INSERT INTO quote_requests (asset_id, asset_snapshot, source_batch_id, urgency, status, requested_by, requested_at, updated_at) VALUES (?, '{}', ?, 'normal', 'sent', ?, ?, ?)", m3.aids[0], m3.bid, WANG, NOW, NOW).lastInsertRowid;
    t.q("INSERT INTO quote_request_items (request_id, inspection_item_id, asset_id, checklist_item_id, label, status, batch_id) VALUES (?, ?, ?, (SELECT checklist_item_id FROM inspection_items WHERE id = ?), 'x', 'warning', ?)", qid, m3.itemIds[0], m3.aids[0], m3.itemIds[0], m3.bid);
    await go(wang, `/batches/${m3.bid}`);
    r = await post(wang, `/batches/${m3.bid}/assets/${m3.aids[0]}/remove`);
    t.ok(r.status === 409 && count('inspection_batch_assets', 'batch_id=?', m3.bid) === 2, '在這個批次送過報價請求的設備不能移出');

    // ===== 2b. 在巡檢中新增的設備：移除時設備本身也一併刪除 =====
    const reg = t.mkAsset('登錄冊設備X'); // 從資產管理挑進來的既有設備
    await post(wang, '/batches/new', ['title=' + enc('巡檢新增-批次1'), 'batch_date=2026-10-19',
      'new_asset_name=' + enc('巡檢新增設備1'), 'new_asset_category=server', 'new_asset_customer=' + custA, 'new_asset_location=',
      'new_asset_name=' + enc('巡檢新增設備2'), 'new_asset_category=server', 'new_asset_customer=' + custA, 'new_asset_location=',
      'asset_ids=' + reg].join('&')).catch(() => null);
    await go(wang, '/batches');
    const nb = t.q("SELECT id FROM inspection_batches WHERE title = '巡檢新增-批次1'")[0];
    t.ok(!!nb, '透過表單建立批次，含快速新增的設備');
    const na = t.q("SELECT id, name, created_in_batch_id AS c, created_by AS b FROM assets WHERE name LIKE '巡檢新增設備%' ORDER BY id");
    t.ok(na.length === 2 && na.every(a => a.c === nb.id && a.b === WANG), '快速新增的設備記下來源批次與新增者');
    t.ok(t.q('SELECT created_in_batch_id AS c FROM assets WHERE id = ?', reg)[0].c === null, '從資產管理挑進來的設備沒有來源批次');
    t.ok(count('inspection_batch_assets', 'batch_id=?', nb.id) === 3, '批次有 2 台新增的 + 1 台挑進來的');
    const ci = t.checklistIds('server', 1)[0];
    const mkItemWithPhoto = (aid, bid, tag) => {
      const it = t.q("INSERT INTO inspection_items (batch_id, asset_id, checklist_item_id, status, recorded_at) VALUES (?, ?, ?, 'normal', ?)", bid, aid, ci, NOW).lastInsertRowid;
      const f = path.join(t.root, 'uploads', String(bid), `n-${tag}-${it}.webp`);
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x');
      t.q("INSERT INTO inspection_item_photos (inspection_item_id, path, format, width, height, sort_order, uploaded_at) VALUES (?, ?, 'webp', 10, 10, 0, ?)", it, f, NOW);
      return f;
    };
    const fNew1 = mkItemWithPhoto(na[0].id, nb.id, 'a'); mkItemWithPhoto(reg, nb.id, 'r');
    await go(wang, `/batches/${nb.id}/entry`);
    const labels = await wang.$$eval('form[action$="/remove"]', fs_ => fs_.map(f => ({ a: f.getAttribute('action'), btn: f.querySelector('button').textContent.trim(), msg: f.dataset.confirm })));
    const L = id => labels.find(l => l.a.includes(`/assets/${id}/remove`));
    t.ok(L(na[0].id) && L(na[0].id).btn === '移除這台設備' && /在這次巡檢新增.*設備本身會一併刪除/.test(L(na[0].id).msg), '新增的設備：按鈕是「移除這台設備」，確認訊息說明設備本身會刪除');
    t.ok(L(reg) && L(reg).btn === '移出本次巡檢' && /設備本身不會被刪除/.test(L(reg).msg), '挑進來的設備：維持「移出本次巡檢」，說明設備不會被刪');
    await post(wang, `/batches/${nb.id}/assets/${na[0].id}/remove`);
    t.ok(count('assets', 'id=?', na[0].id) === 0 && count('inspection_items', 'asset_id=?', na[0].id) === 0 && !fs.existsSync(fNew1), '移除新增的設備：設備、紀錄、截圖檔都消失');
    t.ok(count('assets', 'id=?', na[1].id) === 1, '另一台新增的設備不受影響');
    const rmAudit = audit('batch.remove_asset')[0];
    t.ok(rmAudit && /設備本身也一併刪除/.test(rmAudit.detail) && audit('asset.delete').some(a => a.target_label === '巡檢新增設備1'), '稽核紀錄註明設備本身也刪除（另有一筆設備刪除）');
    await go(wang, `/batches/${nb.id}/entry`);
    r = await post(wang, `/batches/${nb.id}/assets/${reg}/remove`);
    t.ok(count('assets', 'id=?', reg) === 1 && count('inspection_batch_assets', 'batch_id=? AND asset_id=?', nb.id, reg) === 0 && /ok=removed($|&)/.test(r.url) && /已把設備移出這個批次/.test(r.text), '挑進來的設備只移出批次，設備還在');
    const ob = t.mkBatch({ title: '巡檢新增-批次2', by: ADMIN, assets: 1, photos: false });
    await go(wang, `/batches/${ob.bid}/entry`);
    await post(wang, `/batches/${ob.bid}/assets`, ['new_asset_name=' + enc('巡檢新增設備3'), 'new_asset_category=server', 'new_asset_customer=' + custA, 'new_asset_location='].join('&'));
    const a3 = t.q("SELECT id, created_by AS b, created_in_batch_id AS c FROM assets WHERE name = '巡檢新增設備3'")[0];
    t.ok(a3 && a3.b === WANG && a3.c === ob.bid && count('inspection_batch_assets', 'batch_id=? AND asset_id=?', ob.bid, a3.id) === 1, '在填寫頁新增的設備也會記下來源批次與新增者');
    await go(wang, `/batches/${ob.bid}/entry`);
    const ids = await wang.$$eval('form[action$="/remove"]', fs_ => fs_.map(f => +/assets\/(\d+)\/remove/.exec(f.getAttribute('action'))[1]));
    t.ok(ids.length === 1 && ids[0] === a3.id, '不是建立者的技術人員：只在「自己新增的」設備旁看得到移除按鈕');
    r = await post(wang, `/batches/${ob.bid}/assets/${ob.aids[0]}/remove`);
    t.ok(r.status === 403 && count('inspection_batch_assets', 'batch_id=? AND asset_id=?', ob.bid, ob.aids[0]) === 1, '...而且伺服器擋下移除別人的設備（403）');
    await go(lin, `/batches/${ob.bid}/entry`);
    t.ok((await lin.$$('form[action$="/remove"]')).length === 0, '第三位技術人員看不到任何移除按鈕');
    r = await post(lin, `/batches/${ob.bid}/assets/${a3.id}/remove`);
    t.ok(r.status === 403 && count('assets', 'id=?', a3.id) === 1, '第三位技術人員也不能移除');
    await go(wang, `/batches/${ob.bid}/entry`);
    r = await post(wang, `/batches/${ob.bid}/assets/${a3.id}/remove`);
    t.ok(count('assets', 'id=?', a3.id) === 0 && count('inspection_batch_assets', 'batch_id=?', ob.bid) === 1 && /ok=removed_deleted/.test(r.url), '新增者本人移除：設備刪除，批次保留建立者的設備');
    const sb = t.mkBatch({ title: '巡檢新增-批次3', by: WANG, assets: 1, photos: false });
    await go(wang, `/batches/${sb.bid}/entry`);
    await post(wang, `/batches/${sb.bid}/assets`, ['new_asset_name=' + enc('巡檢新增設備4'), 'new_asset_category=server', 'new_asset_customer=' + custA, 'new_asset_location='].join('&'));
    const a4 = t.q("SELECT id FROM assets WHERE name = '巡檢新增設備4'")[0].id;
    const other = t.mkBatch({ title: '巡檢新增-批次4', by: WANG, assets: 1, photos: false });
    t.q('INSERT INTO inspection_batch_assets (batch_id, asset_id) VALUES (?, ?)', other.bid, a4);
    await go(wang, `/batches/${sb.bid}/entry`);
    r = await post(wang, `/batches/${sb.bid}/assets/${a4}/remove`);
    t.ok(count('assets', 'id=?', a4) === 1 && count('inspection_batch_assets', 'batch_id=? AND asset_id=?', sb.bid, a4) === 0 && /ok=removed($|&)/.test(r.url), '新增的設備如果別的批次也用到，只移出這個批次、不刪設備');
    const lb = t.mkBatch({ title: '巡檢新增-批次5', by: WANG, assets: 1, photos: false });
    await go(wang, `/batches/${lb.bid}/entry`);
    await post(wang, `/batches/${lb.bid}/assets`, ['new_asset_name=' + enc('巡檢新增設備5'), 'new_asset_category=server', 'new_asset_customer=' + custA, 'new_asset_location='].join('&'));
    const a5 = t.q("SELECT id FROM assets WHERE name = '巡檢新增設備5'")[0].id;
    await go(wang, `/batches/${lb.bid}/entry`);
    await post(wang, `/batches/${lb.bid}/assets/${lb.aids[0]}/remove`);
    await go(wang, `/batches/${lb.bid}/entry`);
    t.ok((await wang.$$('form[action$="/remove"]')).length === 0, '只剩一台：連新增的設備也沒有移除按鈕');
    r = await post(wang, `/batches/${lb.bid}/assets/${a5}/remove`);
    t.ok(r.status === 400 && count('assets', 'id=?', a5) === 1, '最後一台不能移除（要整批不要請用刪除批次）');

    // ===== 3. 設備刪除 =====
    const u1 = t.mkAsset('未使用設備A'), u2 = t.mkAsset('未使用設備B'), used = t.mkBatch({ title: '用過設備批次', by: WANG, assets: 1 }).aids[0];
    const tg = t.q("INSERT INTO asset_tags (name, created_at) VALUES ('只給A用', ?)", NOW).lastInsertRowid;
    t.q('INSERT INTO asset_tag_links (asset_id, tag_id) VALUES (?, ?)', u1, tg);
    const fd = t.q("INSERT INTO asset_field_defs (label, type, sort_order, is_active, created_at) VALUES ('測試欄位', 'text', 99, 1, ?)", NOW).lastInsertRowid;
    t.q("INSERT INTO asset_field_values (asset_id, field_id, value) VALUES (?, ?, 'v')", u1, fd);
    await go(adm, `/assets/${u1}/edit`);
    t.ok(await adm.$(`#asset-delete form[action="/assets/${u1}/delete"]`) !== null, '沒用過的設備：編輯頁有刪除');
    await go(adm, `/assets/${used}/edit`);
    t.ok(await adm.$('#asset-delete form') === null && /已經用過/.test(await adm.$eval('#asset-delete', e => e.textContent)), '用過的設備：沒有刪除表單，顯示原因（只能停用）');
    r = await post(adm, `/assets/${used}/delete`);
    t.ok(r.status === 409 && count('assets', 'id=?', used) === 1, '伺服器拒絕刪除用過的設備（409）');
    await go(wang, '/assets');
    t.ok([403, 302].includes(await wang.evaluate(async (id) => (await fetch('/assets/' + id + '/delete', { method: 'POST' })).status, u1)), '沒有資產建檔權限的技術人員不能刪');
    await go(adm, `/assets/${u1}/edit`);
    r = await post(adm, `/assets/${u1}/delete`);
    t.ok(r.status === 200 && /ok=deleted/.test(r.url) && count('assets', 'id=?', u1) === 0 && count('asset_field_values', 'asset_id=?', u1) === 0 && count('asset_tag_links', 'asset_id=?', u1) === 0, '沒用過的設備刪除，欄位值與標籤連結一併清掉');
    t.ok(count('asset_tags', 'id=?', tg) === 0, '只有這台用的標籤也一併清掉');
    t.ok(audit('asset.delete').some(a => a.target_label === '未使用設備A'), '稽核紀錄有設備刪除');
    const qa = t.mkAsset('有報價設備');
    t.q("INSERT INTO quote_requests (asset_id, asset_snapshot, urgency, status, requested_by, requested_at, updated_at) VALUES (?, '{}', 'normal', 'sent', ?, ?, ?)", qa, WANG, NOW, NOW);
    await go(adm, `/assets/${qa}/edit`);
    r = await post(adm, `/assets/${qa}/delete`);
    t.ok(r.status === 409 && count('assets', 'id=?', qa) === 1, '有報價請求的設備不能刪');
    await go(adm, '/assets?per=200&q=%E6%9C%AA%E4%BD%BF%E7%94%A8');
    t.ok(await adm.$('#bulk-delete') !== null && await adm.$eval('#bulk-delete', b => b.disabled), '批次操作列有「刪除已選」，沒勾選時是停用的');
    t.ok(/自動略過/.test(await adm.$eval('#bulk-delete', b => b.dataset.confirm)), '批次刪除有自己的確認訊息');
    await adm.click(`input.row-check[value="${u2}"]`);
    t.ok(!await adm.$eval('#bulk-delete', b => b.disabled) && await adm.$eval('#bulk-del-count', e => e.textContent) === '1', '勾選後啟用並顯示台數');
    await go(adm, '/assets?per=200');
    r = await post(adm, '/assets/bulk-delete', `ids=${u2}&ids=${used}&ids=${qa}&ids=999999`);
    t.ok(/ok=deleted&n=1&skipped=3/.test(r.url) && count('assets', 'id=?', u2) === 0 && count('assets', 'id=?', used) === 1 && count('assets', 'id=?', qa) === 1, `批次刪除：刪沒用過的、略過用過的／有報價的／不存在的（${r.url.split('?')[1]}）`);
    t.ok(/已刪除 1 台設備；另有 3 台已經用過/.test(r.text), '列表顯示刪了幾台、略過幾台');
    r = await post(adm, '/assets/bulk-delete', '');
    t.ok(r.status === 400, '什麼都沒勾選就批次刪除：400');

    // ===== 4. 使用者刪除 =====
    const hash = await argon2.hash(t.PASSWORD);
    const mkUser = (n, role = 'technician') => t.q("INSERT INTO users (username, password_hash, display_name, role, is_active, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)", n, hash, n + '顯示', role, NOW).lastInsertRowid;
    const tU = mkUser('刪我A'), wU = mkUser('有紀錄B');
    t.q("INSERT INTO notifications (user_id, type, title, message, created_at) VALUES (?, 'system', 't', 'm', ?)", tU, NOW);
    t.q("INSERT INTO login_sessions (user_id, session_key, started_at, last_seen_at) VALUES (?, 'k', ?, ?)", tU, NOW, NOW);
    t.mkBatch({ title: 'B建立的批次', by: wU, assets: 1 });
    await go(adm, `/users/${tU}/edit`);
    t.ok(await adm.$('#user-delete form') !== null, '沒有紀錄的使用者：有刪除表單');
    await go(adm, `/users/${wU}/edit`);
    t.ok(await adm.$('#user-delete form') === null && /工作紀錄/.test(await adm.$eval('#user-delete', e => e.textContent)), '有紀錄的使用者：沒有刪除表單，顯示原因（只能停用）');
    r = await post(adm, `/users/${wU}/delete`);
    t.ok(r.status === 409 && count('users', 'id=?', wU) === 1, '伺服器拒絕刪除有工作紀錄的使用者');
    await go(adm, `/users/${ADMIN}/edit`);
    t.ok(await adm.$('#user-delete form') === null, '不能刪自己（沒有表單）');
    r = await post(adm, `/users/${ADMIN}/delete`);
    t.ok(r.status === 409 && count('users', 'id=?', ADMIN) === 1 && /自己/.test(r.text), '伺服器拒絕刪除自己');
    await go(wang, '/assets');
    t.ok([403, 302].includes(await wang.evaluate(async (id) => (await fetch('/users/' + id + '/delete', { method: 'POST' })).status, tU)), '非管理員不能刪使用者');
    await go(adm, `/users/${tU}/edit`);
    r = await post(adm, `/users/${tU}/delete`);
    t.ok(r.status === 200 && /ok=deleted/.test(r.url) && /已刪除使用者/.test(r.text) && count('users', 'id=?', tU) === 0 && count('notifications', 'user_id=?', tU) === 0 && count('login_sessions', 'user_id=?', tU) === 0, '沒紀錄的使用者刪除，通知與登入紀錄一併清掉');
    t.ok(audit('user.delete').some(a => a.target_label === '刪我A'), '稽核紀錄有使用者刪除');
    const a2 = mkUser('第二管理員', 'admin');
    await go(adm, `/users/${a2}/edit`);
    r = await post(adm, `/users/${a2}/delete`);
    t.ok(r.status === 200 && count('users', 'id=?', a2) === 0, '還有另一位啟用中的管理員時，可以刪除第二位管理員');
    const DeletionService = t.require('src/services/DeletionService');
    t.q("UPDATE users SET is_active = 0 WHERE id = ?", ADMIN); // 暫時讓 admin 停用 → 候選人變成最後一位啟用中的管理員
    const cand = mkUser('唯一管理員候選', 'admin');
    const blocker = DeletionService.userDeleteBlocker(t.q('SELECT * FROM users WHERE id = ?', cand)[0], { id: 999999 });
    t.ok(blocker && /最後一位/.test(blocker.error), '最後一位啟用中的管理員不能刪');
    t.q('UPDATE users SET is_active = 1 WHERE id = ?', ADMIN);

    // ===== 5. 封存 =====
    const ar = t.mkBatch({ title: '封存測試批次', by: WANG, status: 'completed', assets: 1 });
    await go(adm, `/batches/${ar.bid}`);
    t.ok(await adm.$('#batch-manage form[action$="/archive"]') !== null, '管理員在已完成批次看得到「封存」');
    await go(wang, `/batches/${ar.bid}`);
    t.ok(await wang.$('form[action$="/archive"]') === null, '技術人員（即使是建立者）看不到「封存」');
    r = await post(wang, `/batches/${ar.bid}/archive`);
    t.ok(r.status === 403 && !t.q('SELECT archived_at AS a FROM inspection_batches WHERE id = ?', ar.bid)[0].a, '技術人員不能封存（403）');
    const dr = t.mkBatch({ title: '草稿不能封存', by: WANG, assets: 1 });
    await go(adm, `/batches/${dr.bid}`);
    r = await post(adm, `/batches/${dr.bid}/archive`);
    t.ok(r.status === 400 && !t.q('SELECT archived_at AS a FROM inspection_batches WHERE id = ?', dr.bid)[0].a, '草稿不能封存');
    await go(adm, `/batches/${ar.bid}`);
    r = await post(adm, `/batches/${ar.bid}/archive`);
    t.ok(r.status === 200 && /ok=archived/.test(r.url) && /已封存批次/.test(r.text), '管理員封存 → 顯示訊息');
    const titles = async () => adm.$$eval('tbody tr td:first-child', a => a.map(x => x.textContent));
    await go(adm, '/batches');
    t.ok(!(await titles()).some(x => x.includes('封存測試批次')), '封存的批次從一般清單消失');
    t.ok(/已封存的批次（\d+）/.test(await adm.$eval('.card .form-hint', e => e.textContent)), '清單上方有「已封存的批次（N）」連結');
    await go(adm, '/batches?archived=1');
    t.ok((await titles()).some(x => x.includes('封存測試批次') && x.includes('已封存')), '?archived=1 列出它，標示「已封存」');
    await go(adm, '/');
    t.ok(!(await adm.evaluate(() => document.body.innerText)).includes('封存測試批次'), '儀表板也不顯示封存的批次');
    const rs = await adm.goto(`${t.base}/batches/${ar.bid}`, { waitUntil: 'networkidle0' });
    t.ok(rs.status() === 200 && /這個批次已封存/.test(await adm.$eval('.form-warning', e => e.textContent)) && await adm.$('form[action$="/unarchive"]') !== null, '封存的批次仍可用連結查看，頂端有提示與「還原封存」');
    t.ok((await t.download(adm, `/batches/${ar.bid}/report.pdf`)).status === 200, '封存批次的 PDF 報告照常可用');
    r = await post(adm, `/batches/${ar.bid}/delete`, 'confirm_title=' + enc(ar.title));
    t.ok(r.status === 409, '封存（已完成）的批次仍然不能刪除');
    r = await post(wang, `/batches/${ar.bid}/unarchive`);
    t.ok(r.status === 403, '技術人員不能還原封存');
    await go(adm, `/batches/${ar.bid}`);
    r = await post(adm, `/batches/${ar.bid}/unarchive`);
    t.ok(r.status === 200 && /已還原封存/.test(r.text), '管理員還原封存 → 顯示訊息');
    await go(adm, '/batches');
    t.ok((await titles()).some(x => x.includes('封存測試批次')), '還原後回到一般清單');
    t.ok(audit('batch.archive').length === 1 && audit('batch.unarchive').length === 1, '封存與還原都有稽核紀錄');

    // ===== 6. 系統通知 =====
    t.q("INSERT INTO announcements (message, level, target, recipients, emailed, created_by, created_at, expires_at, cancelled_at) VALUES ('已撤回的通知', 'info', 'all', 0, 0, ?, ?, '2099-01-01 00:00:00', ?)", ADMIN, NOW, NOW);
    t.q("INSERT INTO announcements (message, level, target, recipients, emailed, created_by, created_at, expires_at) VALUES ('還在顯示的通知', 'info', 'all', 0, 0, ?, ?, '2099-01-01 00:00:00')", ADMIN, NOW);
    const anC = t.q("SELECT id FROM announcements WHERE message = '已撤回的通知'")[0].id, anA = t.q("SELECT id FROM announcements WHERE message = '還在顯示的通知'")[0].id;
    await go(adm, '/admin/announcements');
    t.ok(await adm.$(`form[action="/admin/announcements/${anC}/delete"]`) !== null && await adm.$(`form[action="/admin/announcements/${anA}/delete"]`) === null, '只有已結束的通知有「刪除」按鈕');
    r = await post(adm, `/admin/announcements/${anA}/delete`);
    t.ok(count('announcements', 'id=?', anA) === 1 && /還在顯示/.test(r.text), '還在顯示的通知不能刪（要先撤回）');
    await go(adm, '/admin/announcements');
    r = await post(adm, `/admin/announcements/${anC}/delete`);
    t.ok(count('announcements', 'id=?', anC) === 0 && /已刪除這則通知/.test(r.text), '已結束的通知可以刪除');

    // ===== 7. 稽核紀錄頁 =====
    await go(adm, '/admin/audit');
    const at = await adm.evaluate(() => document.body.innerText);
    t.ok(/刪除巡檢批次/.test(at) && /刪除設備/.test(at) && /刪除使用者/.test(at) && /封存批次/.test(at), '稽核頁列出上面的動作');
    t.ok(/刪除測試A/.test(at) && /未使用設備A/.test(at), '資料已刪除，稽核頁仍看得到當時的名稱（快照）');
    await go(adm, '/admin/audit?action=user.delete');
    const ft = await adm.$$eval('tbody tr', a => a.map(x => x.innerText));
    t.ok(ft.length >= 1 && ft.every(x => /刪除使用者/.test(x)), '依動作篩選');
    for (const u of ['/admin/audit?days=9999&action=%27%20OR%201%3D1', '/admin/audit?action=zzz']) {
      t.ok((await adm.goto(`${t.base}${u}`, { waitUntil: 'networkidle0' })).status() === 200, `奇怪的參數不會出錯：${u}`);
    }
    t.ok((await wang.goto(`${t.base}/admin/audit`)).status() === 403, '非管理員不能開稽核頁');
    await go(adm, '/');
    t.ok(await adm.$$eval('a', a => a.some(x => x.getAttribute('href') === '/admin/audit')), '管理員選單有「稽核紀錄」');
    const AuditLog = t.require('src/models/AuditLog');
    t.q("INSERT INTO audit_log (at, action, username) VALUES ('2000-01-01 00:00:00', 'batch.delete', 'old')");
    t.ok(AuditLog.prune() >= 1 && !t.q("SELECT 1 FROM audit_log WHERE username = 'old'").length, '超過 180 天的稽核紀錄會被清除');
    const cid = t.mkCustomer('待刪客戶');
    await go(adm, '/admin/customers');
    await post(adm, `/admin/customers/${cid}/delete`);
    t.ok(audit('customer.delete').some(a => a.target_label === '待刪客戶'), '既有的主檔刪除（客戶）也會留下稽核紀錄');
  },
};
