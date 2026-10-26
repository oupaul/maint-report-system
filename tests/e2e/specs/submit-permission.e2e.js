// 誰可以送出審核（或沒啟用簽核時的標記完成）：只有建立者與在該批次填寫過檢查項目的人。
// 為什麼：簽核人（主管）誤按「送出」會變成「送審人」，因為不能簽核自己送的批次，只好換另一位管理員處理。
module.exports = {
  name: '送審權限（簽核人不能誤送）',
  needs: ['browser'],
  async run(t) {
    const ADMIN = t.uid('admin'), WANG = t.uid('wang'), LIN = t.uid('lin'), OUT = t.uid('outsider');
    t.q('UPDATE approval_settings SET enabled = 1, block_self_approval = 1 WHERE id = 1');
    const adm = await t.login('admin'), wang = await t.login('wang'), lin = await t.login('lin'), out = await t.login('outsider');
    const mk = (title, creator, recorders) => {
      const b = t.mkBatch({ title, by: creator, assets: 1, photos: false, recorders });
      t.q('DELETE FROM notifications WHERE batch_id = ?', b.bid); // mkBatch 自帶一則種子通知，這裡要精確算通知，先清掉
      t.signEngineer(b.bid, creator);
      return b.bid;
    };
    const st = (bid) => t.q('SELECT approval_status AS s, submitted_by AS sb, status FROM inspection_batches WHERE id = ?', bid)[0];
    const notifs = (bid, uid) => t.q('SELECT type FROM notifications WHERE batch_id = ? AND user_id = ? ORDER BY id', bid, uid).map(r => r.type);
    const submitBtn = (p) => p.$('form[action$="/submit"] button[type=submit]');
    const text = (p) => p.evaluate(() => document.body.innerText);

    // ===== S1：王建立、王填寫 =====
    const s1 = mk('送審權限-S1', WANG, [WANG]);
    await t.go(adm, `/batches/${s1}`);
    t.ok(await submitBtn(adm) === null, 'S1：沒參與的簽核人（管理員）在摘要頁看不到送出按鈕');
    t.ok(/這個批次還在填寫中，尚未送審（建立者：王小明）/.test(await text(adm)), 'S1：改看到「還在填寫中，尚未送審（建立者：○○）」');
    await t.go(adm, `/batches/${s1}/entry`);
    t.ok(await adm.$('form[action$="/submit"]') === null && /送出由建立者（王小明）或填寫的人處理/.test(await text(adm)), 'S1：填寫頁對管理員：沒有送出按鈕，改顯示說明');
    await t.go(adm, `/batches/${s1}`);
    let r = await t.post(adm, `/batches/${s1}/submit`);
    t.ok(r.status === 403 && /建立這個批次的人/.test(r.text) && st(s1).s === 'none' && st(s1).sb === null, 'S1：伺服器拒絕管理員的送出（403），批次不變、沒有記下錯誤的送審人');
    await t.go(out, `/batches/${s1}`);
    r = await t.post(out, `/batches/${s1}/submit`);
    t.ok(r.status === 403 && st(s1).s === 'none', 'S1：無關的技術人員同樣被拒');
    await t.go(lin, `/batches/${s1}`);
    r = await t.post(lin, `/batches/${s1}/submit`);
    t.ok(r.status === 403 && st(s1).s === 'none', 'S1：沒填寫過的技術人員被拒');
    await t.go(wang, `/batches/${s1}`);
    t.ok(await wang.$eval('form[action$="/submit"] button[type=submit]', b => b.textContent.trim()) === '完成填寫，送出給主管審核'
      && /你就是「送審人」，不能自己核准/.test(await wang.$eval('form[action$="/submit"]', f => f.dataset.confirm)), 'S1：建立者看到較清楚的按鈕文字，確認視窗說明他會成為送審人');
    await t.go(wang, `/batches/${s1}/entry`);
    t.ok(/完成填寫，送出給主管審核/.test(await text(wang)), 'S1：填寫頁的按鈕用同樣的文字');
    await t.go(wang, `/batches/${s1}`);
    await t.post(wang, `/batches/${s1}/submit`);
    t.ok(st(s1).s === 'pending' && st(s1).sb === WANG, 'S1：建立者送出 → 審核中，送審人是建立者');
    t.ok(notifs(s1, ADMIN).join() === 'submitted' && notifs(s1, WANG).length === 0, 'S1：簽核人收到一次通知；建立者＝送審人，不會多一封');
    await t.go(wang, `/batches/${s1}`);
    t.ok(/你是這個批次的送審人，依照簽核設定不能簽核自己送出的批次.*撤回審核/.test(await text(wang)) && await wang.$('form[action$="/withdraw"]') !== null, 'S1：送審人看到「不能自己簽核，誤按可撤回」的提醒與撤回按鈕');
    await t.go(adm, `/batches/${s1}`);
    t.ok(!/你是這個批次的送審人/.test(await text(adm)), 'S1：簽核人不會看到那則提醒');
    t.q('UPDATE approval_settings SET block_self_approval = 0 WHERE id = 1');
    await t.go(wang, `/batches/${s1}`);
    t.ok(!/你是這個批次的送審人/.test(await text(wang)), 'S1：關掉「不能簽核自己送的」之後，提醒消失（否則會說錯）');
    t.q('UPDATE approval_settings SET block_self_approval = 1 WHERE id = 1');

    // ===== S2：王建立、林填寫、林送出 =====
    const s2 = mk('送審權限-S2', WANG, [LIN]);
    await t.go(lin, `/batches/${s2}`);
    t.ok(await submitBtn(lin) !== null, 'S2：填寫過檢查項目的同事看得到送出按鈕');
    await t.go(wang, `/batches/${s2}`);
    t.ok(await submitBtn(wang) !== null, 'S2：建立者當然也可以送');
    await t.go(lin, `/batches/${s2}`);
    await t.post(lin, `/batches/${s2}/submit`);
    t.ok(st(s2).s === 'pending' && st(s2).sb === LIN, 'S2：填寫的人送出 → 送審人是他');
    t.ok(notifs(s2, ADMIN).join() === 'submitted', 'S2：簽核人收到「待簽核」');
    t.ok(notifs(s2, WANG).join() === 'submitted_by_other', 'S2：批次建立者收到「有人代為送出」的通知');
    const nt = t.q('SELECT title, message FROM notifications WHERE batch_id = ? AND user_id = ?', s2, WANG)[0];
    t.ok(/已代為送出/.test(nt.title) && /林雅婷/.test(nt.message) && /撤回審核/.test(nt.message), `S2：通知寫明是誰送的、並提到可撤回（${nt.title}）`);

    // ===== S3：建立者本身就是簽核人（管理員），林填寫並送出 → 不重複通知 =====
    const s3 = mk('送審權限-S3', ADMIN, [LIN]);
    await t.go(lin, `/batches/${s3}`);
    await t.post(lin, `/batches/${s3}/submit`);
    t.ok(st(s3).s === 'pending' && notifs(s3, ADMIN).join() === 'submitted', 'S3：建立者本身是簽核人時只收到「待簽核」，不重複');

    // ===== S4：沒啟用簽核流程 → 標記為已完成 =====
    t.q('UPDATE approval_settings SET enabled = 0 WHERE id = 1');
    const s4 = mk('送審權限-S4', WANG, [WANG]);
    await t.go(adm, `/batches/${s4}/entry`);
    t.ok(await adm.$('form[action$="/complete"]') === null, 'S4（沒啟用簽核）：沒參與的管理員看不到「標記為已完成」');
    await t.go(adm, `/batches/${s4}`);
    r = await t.post(adm, `/batches/${s4}/complete`);
    t.ok(r.status === 403 && st(s4).status === 'draft', 'S4：伺服器拒絕管理員的標記完成（403）');
    await t.go(out, `/batches/${s4}`);
    r = await t.post(out, `/batches/${s4}/complete`);
    t.ok(r.status === 403 && st(s4).status === 'draft', 'S4：無關的技術人員同樣被拒');
    await t.go(wang, `/batches/${s4}/entry`);
    t.ok(await wang.$('form[action$="/complete"]') !== null, 'S4：建立者看得到標記完成');
    await t.go(wang, `/batches/${s4}`);
    await t.post(wang, `/batches/${s4}/complete`);
    t.ok(st(s4).status === 'completed', 'S4：建立者可以標記完成');

    // ===== S5：管理員自己建立或填寫的批次，自己也能送（管理員不是特例排除）=====
    t.q('UPDATE approval_settings SET enabled = 1 WHERE id = 1');
    const s5 = mk('送審權限-S5', ADMIN, [ADMIN]);
    await t.go(adm, `/batches/${s5}`);
    t.ok(await submitBtn(adm) !== null, 'S5：管理員自己建立或填寫的批次，管理員也能送出');
  },
};
