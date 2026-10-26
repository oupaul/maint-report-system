// 簽名與簽核規則：
// - 送出前（送審／標記完成）批次必須已有「工程師」簽名
// - 核准前，核准的人必須先簽「主管」欄：本人簽的、而且是輪到這一關之後才簽的（每一關都要重簽）
// - 主管欄的簽名資格：管理員，或目前這一關的簽核人（群組成員也算）；退回不需要簽名
const enc = encodeURIComponent;

module.exports = {
  name: '簽名與簽核規則',
  needs: ['browser'],
  async run(t) {
    const ADMIN = t.uid('admin'), WANG = t.uid('wang'), LIN = t.uid('lin');
    const grp = t.q('SELECT id FROM permission_groups ORDER BY id LIMIT 1')[0].id;
    t.q("INSERT INTO approval_stages (stage_order, label, group_id, is_active) VALUES (2, '部門主管覆核', ?, 1)", grp);
    t.q('UPDATE users SET group_id = ? WHERE id = ?', grp, LIN);
    const setApproval = (enabled, blockSelf = 0) => t.q('UPDATE approval_settings SET enabled = ?, block_self_approval = ? WHERE id = 1', enabled, blockSelf);
    setApproval(1);
    const adm = await t.login('admin'), lin = await t.login('lin'), wang = await t.login('wang');
    const st = (bid) => t.q('SELECT approval_status AS s, status FROM inspection_batches WHERE id = ?', bid)[0];
    const stage = (bid) => (t.q("SELECT stage_label AS l FROM approval_records WHERE batch_id = ? AND status = 'waiting' ORDER BY stage_order LIMIT 1", bid)[0] || {}).l;
    const reset = (bid, approval = 'none') => {
      t.q("UPDATE inspection_batches SET approval_status = ?, status = 'draft', submitted_by = NULL, submitted_at = NULL, completed_at = NULL WHERE id = ?", approval, bid);
      for (const tb of ['approval_records', 'approval_events', 'notifications']) t.q(`DELETE FROM ${tb} WHERE batch_id = ?`, bid);
    };
    const post = (p, u, b) => t.post(p, u, b);
    const mk = (title) => t.mkBatch({ title, by: ADMIN, assets: 1, photos: false, recorders: [ADMIN] });

    // ===== A. 送出前必須有工程師簽名 =====
    const A = mk('簽名測試A');
    await t.go(adm, `/batches/${A.bid}/entry`);
    t.ok(await adm.$$eval('.page-actions a', a => a.some(x => /先到摘要頁簽名/.test(x.textContent) && /#signatures$/.test(x.getAttribute('href')))), '填寫頁：沒簽名時顯示「先到摘要頁簽名」連結');
    t.ok(await adm.$eval(`form[action="/batches/${A.bid}/submit"] button`, b => b.disabled), '填寫頁：沒簽名時「送出」按鈕停用');
    await t.go(adm, `/batches/${A.bid}`);
    t.ok(await adm.$eval(`form[action="/batches/${A.bid}/submit"] button[type=submit]`, b => b.disabled) && /工程師簽名/.test(await adm.$eval('.approval-actions', e => e.textContent)), '摘要頁：送出按鈕停用，並提示要先簽工程師簽名');
    t.ok(await adm.$('section#signatures') !== null, '簽核區塊有 #signatures 錨點（可直接跳過去）');
    let r = await post(adm, `/batches/${A.bid}/submit`);
    t.ok(r.status === 400 && /工程師.*簽名/.test(r.text) && st(A.bid).s === 'none', '伺服器拒絕沒簽名的送出（400），批次不變');
    t.q("INSERT INTO batch_signatures (batch_id, role, user_id, signature_path, signed_at) VALUES (?, 'supervisor', ?, '/tmp/x.png', ?)", A.bid, ADMIN, t.NOW);
    r = await post(adm, `/batches/${A.bid}/submit`);
    t.ok(r.status === 400 && st(A.bid).s === 'none', '只有主管簽名不算數');
    t.signEngineer(A.bid, ADMIN);
    await t.go(adm, `/batches/${A.bid}/entry`);
    t.ok(!(await adm.$$eval('.page-actions a', a => a.some(x => /先到摘要頁簽名/.test(x.textContent)))) && !(await adm.$eval(`form[action="/batches/${A.bid}/submit"] button`, b => b.disabled)), '簽名後：沒有「先簽名」連結，送出按鈕可按');
    // 新增設備失敗後重新顯示的填寫頁（另一條 render 路徑）也要正常
    r = await post(adm, `/batches/${A.bid}/assets`, '');
    t.ok(r.status === 400 && /請至少新增或勾選一項設備/.test(r.text) && !/系統錯誤/.test(r.text) && /送出給主管審核/.test(r.text), '新增設備失敗後重新顯示的填寫頁正常（不是 500），送出按鈕還在');
    await t.go(adm, `/batches/${A.bid}`);
    r = await post(adm, `/batches/${A.bid}/submit`);
    t.ok(r.status === 200 && st(A.bid).s === 'pending' && t.count('approval_records', 'batch_id=?', A.bid) > 0, '已簽名：送出成功，進入審核');
    reset(A.bid, 'returned');
    await t.go(adm, `/batches/${A.bid}/entry`);
    r = await post(adm, `/batches/${A.bid}/submit`);
    t.ok(r.status === 200 && st(A.bid).s === 'pending', '被退回的批次，原本的簽名仍有效，可以重送');

    // 沒有啟用簽核流程：標記為已完成
    setApproval(0);
    const B = mk('簽名測試B');
    await t.go(adm, `/batches/${B.bid}/entry`);
    t.ok(await adm.$eval(`form[action="/batches/${B.bid}/complete"] button`, b => b.disabled), '未啟用簽核：沒簽名時「標記為已完成」停用');
    r = await post(adm, `/batches/${B.bid}/complete`);
    t.ok(r.status === 400 && /簽名/.test(r.text) && st(B.bid).status === 'draft', '伺服器拒絕沒簽名的標記完成');
    t.signEngineer(B.bid, ADMIN);
    await t.go(adm, `/batches/${B.bid}/entry`);
    r = await post(adm, `/batches/${B.bid}/complete`);
    t.ok(st(B.bid).status === 'completed', '簽名後可以標記為已完成');
    setApproval(1);

    // ===== B. 核准前簽核人必須先簽名（本人、輪到這一關之後；每一關都要重簽） =====
    const dataUrl = await t.signatureDataUrl();
    const sigRow = (bid) => t.q("SELECT user_id, signed_at FROM batch_signatures WHERE batch_id = ? AND role = 'supervisor'", bid)[0];
    const C = mk('簽名測試C');
    t.signEngineer(C.bid, ADMIN);
    await t.go(adm, `/batches/${C.bid}`);
    r = await post(adm, `/batches/${C.bid}/submit`);
    t.ok(st(C.bid).s === 'pending' && stage(C.bid) === '主管審核', '送審後等第一關（主管審核）');
    await t.sleep(1200);
    await t.go(adm, `/batches/${C.bid}`);
    t.ok(await adm.$eval(`form[action="/batches/${C.bid}/approve"] button[type=submit]`, b => b.disabled) && /主管欄簽名/.test(await adm.$eval(`form[action="/batches/${C.bid}/approve"]`, e => e.textContent)), '沒有主管簽名：「核准」停用並提示');
    t.ok(!(await adm.$eval('button[formaction$="/return"]', b => b.disabled)), '「退回修改」不需要簽名，仍可按');
    r = await post(adm, `/batches/${C.bid}/approve`);
    t.ok(r.status === 400 && /主管簽名/.test(r.text) && st(C.bid).s === 'pending' && stage(C.bid) === '主管審核', '伺服器拒絕沒簽名的核准（400），仍在第一關');
    t.q("INSERT OR REPLACE INTO batch_signatures (batch_id, role, user_id, signature_path, signed_at) VALUES (?, 'supervisor', ?, '/tmp/x.png', '2000-01-01 00:00:00')", C.bid, ADMIN);
    r = await post(adm, `/batches/${C.bid}/approve`);
    t.ok(r.status === 400 && stage(C.bid) === '主管審核', '送審之前就留著的舊簽名不算');
    t.q("INSERT OR REPLACE INTO batch_signatures (batch_id, role, user_id, signature_path, signed_at) VALUES (?, 'supervisor', ?, '/tmp/x.png', ?)", C.bid, LIN, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '));
    r = await post(adm, `/batches/${C.bid}/approve`);
    t.ok(r.status === 400 && stage(C.bid) === '主管審核', '別人簽的不算');
    r = await post(adm, `/batches/${C.bid}/signatures/supervisor`, 'signature_data=' + enc(dataUrl));
    t.ok(r.status === 200 && sigRow(C.bid).user_id === ADMIN, '管理員透過真正的簽名路由簽主管欄');
    await t.go(adm, `/batches/${C.bid}`);
    t.ok(!(await adm.$eval(`form[action="/batches/${C.bid}/approve"] button[type=submit]`, b => b.disabled)), '簽名後「核准」可按');
    await t.sleep(1200);
    r = await post(adm, `/batches/${C.bid}/approve`);
    t.ok(r.status === 200 && st(C.bid).s === 'pending' && stage(C.bid) === '部門主管覆核', '第一關用剛簽的簽名核准 → 等第二關（部門主管覆核）');
    await t.sleep(1200);
    r = await post(adm, `/batches/${C.bid}/approve`);
    t.ok(r.status === 400 && stage(C.bid) === '部門主管覆核', '第二關：上一關的簽名不能沿用（就算同一個人）');
    await t.go(lin, `/batches/${C.bid}`);
    t.ok(await lin.$('.signature-open-btn[data-dialog="signature-dialog-supervisor"]') !== null, '第二關的簽核人（群組成員、不是管理員）看得到主管簽名按鈕');
    r = await post(lin, `/batches/${C.bid}/signatures/supervisor`, 'signature_data=' + enc(dataUrl));
    t.ok(r.status === 200 && sigRow(C.bid).user_id === LIN, '群組成員簽自己那一關的主管欄');
    await t.go(lin, `/batches/${C.bid}`);
    t.ok(!(await lin.$eval(`form[action="/batches/${C.bid}/approve"] button[type=submit]`, b => b.disabled)), '群組成員簽名後「核准」可按');
    await t.sleep(1200);
    r = await post(lin, `/batches/${C.bid}/approve`);
    t.ok(r.status === 200 && st(C.bid).s === 'approved' && st(C.bid).status === 'completed', '最後一關由群組成員用自己的簽名核准 → 批次完成');

    // 第一關（管理員）期間：群組成員、無關的人都不能簽主管欄
    const D = mk('簽名測試D');
    t.signEngineer(D.bid, ADMIN);
    await t.go(adm, `/batches/${D.bid}`);
    await post(adm, `/batches/${D.bid}/submit`);
    await t.go(lin, `/batches/${D.bid}`);
    t.ok(await lin.$('.signature-open-btn[data-dialog="signature-dialog-supervisor"]') === null, '第一關（只有管理員）期間，群組成員沒有主管簽名按鈕');
    r = await post(lin, `/batches/${D.bid}/signatures/supervisor`, 'signature_data=' + enc(dataUrl));
    t.ok(r.status === 403 && !sigRow(D.bid), '...伺服器也擋（403）');
    await t.go(wang, `/batches/${D.bid}`);
    r = await post(wang, `/batches/${D.bid}/signatures/supervisor`, 'signature_data=' + enc(dataUrl));
    t.ok(r.status === 403, '不相干的技術人員不能簽主管欄（403）');
    await t.sleep(1200);
    r = await post(adm, `/batches/${D.bid}/return`, 'comment=' + enc('請補資料'));
    t.ok(r.status === 200 && st(D.bid).s === 'returned', '退回不需要任何簽名');

    // 沒啟用簽核：只有管理員能簽主管欄（行為不變）
    setApproval(0);
    const E = mk('簽名測試E');
    await t.go(adm, `/batches/${E.bid}`);
    r = await post(adm, `/batches/${E.bid}/signatures/supervisor`, 'signature_data=' + enc(dataUrl));
    t.ok(r.status === 200, '未啟用簽核：管理員仍可簽主管欄');
    await t.go(lin, `/batches/${E.bid}`);
    r = await post(lin, `/batches/${E.bid}/signatures/supervisor`, 'signature_data=' + enc(dataUrl));
    t.ok(r.status === 403, '未啟用簽核：群組成員仍不能簽主管欄');
  },
};
