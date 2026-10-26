// Email 通知：設定頁、測試寄信、站內通知附帶的信、失敗與重寄、信件標頭注入防護、報價請求信（附 PDF）。
// 用 lib/smtp.js 的假 SMTP 伺服器收信，驗證 nodemailer 實際送出的內容（含 UTF-8 主旨、HTML 跳脫、附件）。
// Microsoft 365（Graph）寄信方式需要連到 Microsoft，這裡不測。
const { StubSmtp, leaves } = require('../lib/smtp');
const net = require('net');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; }
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

module.exports = {
  name: 'Email 通知（假 SMTP 收信）',
  needs: ['browser'],
  async run(t) {
    const stub = new StubSmtp();
    await stub.start();
    try {
      await body(t, stub);
    } finally {
      await stub.stop();
    }
  },
};

async function body(t, stub) {
  const ADMIN = t.uid('admin'), WANG = t.uid('wang');
  t.q("UPDATE users SET email = 'admin@example.test' WHERE username = 'admin'");
  t.q("UPDATE users SET email = 'wang@example.test' WHERE username = 'wang'");
  const adm = await t.login('admin');
  const wang = await t.login('wang');
  const notif = (id) => t.q('SELECT email_status AS s, email_error AS e FROM notifications WHERE id = ?', id)[0];
  const lastNotif = () => t.q('SELECT id FROM notifications ORDER BY id DESC LIMIT 1')[0].id;
  const mkNotif = (title, message = '內容') => t.q("INSERT INTO notifications (user_id, batch_id, type, title, message, created_at) VALUES (?, NULL, 'submitted', ?, ?, '2026-10-19 09:00:00')", ADMIN, title, message).lastInsertRowid;
  const msg = (i = stub.messages.length - 1) => stub.messages[i];
  const hdr = (m, n) => m.mime.headers.filter(h => h.name === n).map(h => h.value);
  const body_ = (m, type) => { const p = leaves(m.mime).find(x => x.type === type); return p ? p.text : ''; };

  // ===== 設定頁 =====
  await t.go(adm, '/admin/mail');
  t.ok(await adm.$eval('h1', e => e.textContent.trim()) === 'Email 通知' && await adm.$('form[action="/admin/mail/settings"]') !== null, '管理員看得到 Email 通知設定頁');
  t.ok((await wang.goto(`${t.base}/admin/mail`)).status() === 403, '技術人員不能進設定頁（403）');
  t.ok(t.q('SELECT enabled AS e FROM mail_settings')[0].e === 0, '預設是停用的');

  const save = async (v, { enabled = true } = {}) => {
    await t.go(adm, '/admin/mail');
    for (const [id, val] of Object.entries(v)) await adm.$eval(`#${id}`, (e, x) => { e.value = x; }, String(val));
    await adm.$eval('input[name=enabled]', (e, on) => { e.checked = on; }, enabled);
    await Promise.all([adm.waitForNavigation({ waitUntil: 'networkidle0' }), adm.$eval('form[action="/admin/mail/settings"]', f => { f.noValidate = true; f.requestSubmit(); })]);
    return adm.evaluate(() => document.body.innerText);
  };
  const GOOD = { app_url: 'https://maint.example.test/', smtp_host: '127.0.0.1', smtp_port: stub.port, smtp_user: stub.user, smtp_pass: stub.pass, smtp_from: '巡檢系統 <noreply@example.test>' };
  let txt = await save({ ...GOOD, smtp_host: 'http://bad host' });
  t.ok(/SMTP 主機只能是主機名稱或 IP/.test(txt) && t.q('SELECT smtp_host AS h FROM mail_settings')[0].h === null, '主機填成網址／含空白：被拒絕、不寫入');
  txt = await save({ ...GOOD, smtp_from: 'not-an-email' });
  t.ok(/寄件人格式不正確/.test(txt), '寄件人格式錯誤：被拒絕');
  txt = await save({ ...GOOD, smtp_port: 70000 });
  t.ok(/埠號需介於 1 到 65535/.test(txt), '埠號超出範圍：被拒絕');
  txt = await save({ ...GOOD, app_url: 'javascript:alert(1)' });
  t.ok(/系統網址格式不正確/.test(txt), '系統網址只接受 http(s)://');
  txt = await save({ ...GOOD, smtp_host: '', smtp_pass: '' });
  t.ok(/請填寫 SMTP 主機與寄件人/.test(txt), '啟用時沒填主機：被拒絕');
  txt = await save(GOOD);
  t.ok(/已儲存 Email 設定/.test(txt), '填完整後儲存成功');
  const row = t.q('SELECT * FROM mail_settings')[0];
  t.ok(row.enabled === 1 && row.smtp_host === '127.0.0.1' && row.smtp_port === stub.port && row.app_url === 'https://maint.example.test', '設定寫入資料庫（系統網址去掉結尾斜線）');
  t.ok(row.smtp_pass_enc && row.smtp_pass_enc.startsWith('v1:') && !row.smtp_pass_enc.includes(stub.pass), 'SMTP 密碼加密儲存（資料庫裡看不到明文）');
  const html = await adm.content();
  t.ok(!html.includes(stub.pass) && /已儲存（留空表示不變更）/.test(html), '設定頁不會把密碼送回瀏覽器，只顯示「已儲存」');
  const enc1 = row.smtp_pass_enc;
  await save({ smtp_pass: '' });
  t.ok(t.q('SELECT smtp_pass_enc AS p FROM mail_settings')[0].p === enc1, '密碼欄留空再儲存＝保留原本的密碼');

  // ===== 測試寄信 =====
  await t.go(adm, '/admin/mail');
  let r = await t.post(adm, '/admin/mail/test', 'to=' + encodeURIComponent('admin@example.test'));
  t.ok(/已寄出測試信到 admin@example.test/.test(r.text) && stub.messages.length === 1, '測試寄信：畫面顯示成功，假伺服器收到 1 封');
  let m = msg();
  t.ok(m.auth === stub.user && stub.authAttempts.at(-1).pass === stub.pass, '用設定的帳號密碼登入 SMTP（解密後的密碼正確送出）');
  t.ok(m.rcpts.join() === 'admin@example.test' && m.from === 'noreply@example.test', '收件人與信封寄件人正確');
  t.ok(m.mime.header('subject') === '【維護巡檢報告系統】測試信' && /巡檢系統/.test(m.mime.header('from')) && /noreply@example\.test/.test(m.mime.header('from')), '主旨（UTF-8 編碼後還原）與寄件人顯示名稱正確');
  t.ok(m.mime.type === 'multipart/alternative' && /測試信/.test(body_(m, 'text/plain')) && /<h2[^>]*>測試信<\/h2>/.test(body_(m, 'text/html')), '同時有純文字與 HTML 兩個版本');
  t.ok(body_(m, 'text/html').includes('href="https://maint.example.test"'), 'HTML 信裡的連結用設定的系統網址');
  r = await t.post(adm, '/admin/mail/test', 'to=' + encodeURIComponent('abc'));
  t.ok(/收件人 Email 格式不正確/.test(r.text) && stub.messages.length === 1, '測試收件人格式錯誤：不寄、說明原因');
  t.q('UPDATE mail_settings SET enabled = 0');
  await t.go(adm, '/admin/mail');
  r = await t.post(adm, '/admin/mail/test', 'to=' + encodeURIComponent('admin@example.test'));
  t.ok(/已寄出測試信/.test(r.text) && stub.messages.length === 2, '總開關關閉時，「測試寄信」仍可用（設定填完整就能測）');
  const nid0 = mkNotif('停用中的通知');
  r = await t.post(adm, `/admin/mail/resend/${nid0}`);
  t.ok(notif(nid0).s === 'skipped' && /尚未啟用/.test(notif(nid0).e) && stub.messages.length === 2, '總開關關閉時，通知信不寄（標為「沒寄」並說明原因）');
  t.q('UPDATE mail_settings SET enabled = 1');

  // ===== 通知信：從真實流程觸發（工程師送審 → 通知簽核人）=====
  t.q('UPDATE approval_settings SET enabled = 1, block_self_approval = 1 WHERE id = 1');
  stub.clear();
  const submitBatch = async (title) => {
    const b = t.mkBatch({ title, by: WANG, assets: 1, photos: false });
    t.q('DELETE FROM notifications WHERE batch_id = ?', b.bid);
    t.signEngineer(b.bid, WANG);
    await t.go(wang, `/batches/${b.bid}`);
    const res = await t.post(wang, `/batches/${b.bid}/submit`);
    return { bid: b.bid, res };
  };
  const evil = '送審<script>alert(1)</script>&"測試';
  const s1 = await submitBatch(evil);
  t.ok(await waitFor(() => stub.messages.length >= 1), '送審後，簽核人的通知信在背景寄出');
  m = msg();
  const n1 = t.q('SELECT id, title FROM notifications WHERE batch_id = ? AND user_id = ?', s1.bid, ADMIN)[0];
  t.ok(m.rcpts.join() === 'admin@example.test' && stub.messages.length === 1, '只寄給簽核人一封（送審人自己不會收到）');
  t.ok(m.mime.header('subject').startsWith('【維護巡檢報告系統】') && m.mime.header('subject').includes('<script>'), '主旨：系統名稱＋通知標題（含使用者輸入的批次名稱）');
  t.ok(body_(m, 'text/html').includes('&lt;script&gt;') && !body_(m, 'text/html').includes('<script>') && body_(m, 'text/html').includes('&amp;'), 'HTML 信裡批次名稱一律跳脫（不會變成可執行的標籤）');
  t.ok(body_(m, 'text/plain').includes(`https://maint.example.test/batches/${s1.bid}`), '信裡的連結指到該批次');
  t.ok(await waitFor(() => notif(n1.id).s === 'sent'), '寄送結果寫回通知：sent');

  // 沒有 Email 的人：不寄、標為沒寄
  t.q("UPDATE users SET email = NULL WHERE username = 'admin'");
  stub.clear();
  const s2 = await submitBatch('沒有信箱的簽核人');
  const n2 = t.q('SELECT id FROM notifications WHERE batch_id = ? AND user_id = ?', s2.bid, ADMIN)[0].id;
  t.ok(await waitFor(() => notif(n2).s === 'skipped') && /沒有設定 Email/.test(notif(n2).e) && stub.messages.length === 0, '收件人沒有設定 Email：不寄，通知標為「沒寄」並說明原因');
  t.ok(s2.res.status === 200 && t.q('SELECT approval_status AS s FROM inspection_batches WHERE id = ?', s2.bid)[0].s === 'pending', '寄信不影響送審本身');
  t.q("UPDATE users SET email = 'admin@example.test' WHERE username = 'admin'");

  // ===== 失敗、寄送紀錄、重寄 =====
  await t.go(adm, '/admin/mail');
  stub.clear(); stub.failAuth = true;
  const nf = mkNotif('登入會失敗的通知');
  r = await t.post(adm, `/admin/mail/resend/${nf}`);
  t.ok(/err=resendfail/.test(r.url) && /重寄失敗/.test(r.text), 'SMTP 登入失敗：重寄顯示失敗');
  t.ok(notif(nf).s === 'failed' && /SMTP 登入失敗：帳號或密碼不正確/.test(notif(nf).e), '失敗原因翻成管理員看得懂的說明並寫回通知');
  t.ok(/登入會失敗的通知/.test(r.text) && /SMTP 登入失敗/.test(r.text), '寄送紀錄頁看得到這筆失敗與原因');
  r = await t.post(adm, '/admin/mail/test', 'to=' + encodeURIComponent('admin@example.test'));
  t.ok(/測試寄信失敗：SMTP 登入失敗/.test(r.text), '測試寄信同樣顯示登入失敗的說明');
  stub.failAuth = false;
  r = await t.post(adm, `/admin/mail/resend/${nf}`);
  t.ok(/ok=resent/.test(r.url) && /已重新寄出/.test(r.text) && notif(nf).s === 'sent' && notif(nf).e === null && stub.messages.length === 1, '修好之後重寄成功：狀態改 sent、錯誤訊息清掉');
  stub.rejectRcpt = true;
  const nr = mkNotif('會被拒收的通知');
  await t.post(adm, `/admin/mail/resend/${nr}`);
  t.ok(notif(nr).s === 'failed' && /550|Mailbox unavailable|Recipient/i.test(notif(nr).e), '收件人被伺服器拒收：標為失敗並保留伺服器回應');
  stub.rejectRcpt = false;
  const realPort = t.q('SELECT smtp_port AS p FROM mail_settings')[0].p;
  t.q('UPDATE mail_settings SET smtp_port = ?', await freePort());
  const nc = mkNotif('連不上主機的通知');
  await t.post(adm, `/admin/mail/resend/${nc}`);
  t.ok(notif(nc).s === 'failed' && /連不上 SMTP 主機：連線被拒絕/.test(notif(nc).e), '連不上主機：說明是連線被拒絕、請確認主機與埠號');
  t.q('UPDATE mail_settings SET smtp_port = ?', realPort);
  r = await t.post(adm, '/admin/mail/resend/999999');
  t.ok(/err=notfound/.test(r.url) && /找不到這則通知/.test(r.text), '重寄不存在的通知：友善錯誤');
  r = await t.post(adm, '/admin/mail/resend/abc');
  t.ok(/err=notfound/.test(r.url), '重寄的 id 不是數字：視為找不到');
  const MailRecent = t.q("SELECT COUNT(*) AS n FROM notifications WHERE email_status = 'failed'")[0].n;
  t.ok(MailRecent === 2, '失敗的通知數（會顯示在系統狀態頁）與實際相符');
  t.ok((await t.download(wang, '/admin/mail/resend/1').catch(() => ({ status: 403 }))).status !== 200, '技術人員不能用重寄功能');

  // ===== 標頭注入防護 =====
  stub.clear();
  const ni = mkNotif('測試\r\nBcc: evil@example.test\r\nX-Evil: 1', '內文');
  await t.go(adm, '/admin/mail');
  await t.post(adm, `/admin/mail/resend/${ni}`);
  m = msg();
  t.ok(m && !/[\r\n]/.test(m.mime.header('subject')) && m.mime.header('subject').includes('Bcc: evil@example.test'), '主旨裡的換行被換成空白（Bcc 字樣只是主旨的一部分）');
  t.ok(hdr(m, 'bcc').length === 0 && hdr(m, 'x-evil').length === 0 && m.rcpts.join() === 'admin@example.test', '沒有被夾帶額外標頭或收件人');

  // ===== 長中文內文（quoted-printable／base64 轉碼後還原）=====
  stub.clear();
  const longMsg = '這是一段很長的中文說明。'.repeat(80) + '\n第二行：特殊字元 ＜＞＆ 與表情 😀 保持原樣。';
  const nl = mkNotif('長內文', longMsg);
  await t.post(adm, `/admin/mail/resend/${nl}`);
  t.ok(body_(msg(), 'text/plain').includes(longMsg), '長中文內文（含全形符號與表情）寄出後完整還原');

  // ===== 報價請求信：附 PDF =====
  const ctx = await t.mkReportBatch();
  t.q("UPDATE inspection_items SET status = 'critical', note = '硬碟 SMART 異常' WHERE id IN (?, ?)", ctx.items[0], ctx.items[3]);
  t.q("UPDATE quote_settings SET sales_email = 'sales@example.test', attach_pdf = 1, require_confirm = 0 WHERE id = 1");
  stub.clear();
  await t.go(adm, '/admin/mail');
  r = await t.post(adm, '/quotes/new', `first=${ctx.items[0]}&items=${ctx.items[0]}&urgency=urgent&description=${encodeURIComponent('請盡快報價')}`);
  t.ok(/\/quotes\/\d+\?ok=created/.test(r.url), '建立報價請求成功');
  const qid = t.q('SELECT id FROM quote_requests ORDER BY id DESC LIMIT 1')[0].id;
  t.ok(await waitFor(() => stub.messages.length >= 1, 20000), '報價信在背景寄出');
  m = msg();
  t.ok(m.rcpts.join() === 'sales@example.test', '寄給設定的固定業務信箱');
  t.ok(m.mime.header('subject') === `【維護巡檢報告系統】【緊急】報價請求 Q-${qid}：【甲公司】ERP-DB01`, `主旨：緊急標示、請求編號、客戶與設備（${m.mime.header('subject')}）`);
  const pdf = leaves(m.mime).find(x => x.type === 'application/pdf');
  t.ok(pdf && pdf.filename === `報價請求-Q${qid}.pdf`, `附件檔名正確（${pdf && pdf.filename}）`);
  t.ok(pdf && pdf.content.slice(0, 5).toString() === '%PDF-' && pdf.content.slice(-8).toString().includes('%%EOF') && pdf.content.length > 5000, `附件是完整的 PDF（${pdf ? pdf.content.length : 0} bytes，Base64 轉回後檔頭與結尾正確）`);
  if (pdf && t.tools.poppler) {
    const f = t.tmpFile('quote-mail.pdf', pdf.content);
    t.ok(t.pdfPages(f) >= 1 && /ERP-DB01/.test(t.pdfText(f)) && /硬碟 SMART 異常/.test(t.pdfText(f)), '附件 PDF 可以開啟，內容有設備名稱與異常備註');
  }
  t.ok(/請盡快報價/.test(body_(m, 'text/plain')) && /硬碟 SMART 異常/.test(body_(m, 'text/plain')), '信件內文有工程師說明與項目備註');
  t.ok(body_(m, 'text/plain').includes(`https://maint.example.test/quotes/${qid}`), '信裡的連結指到這張報價請求');
  t.ok(t.q("SELECT detail AS message FROM quote_request_events WHERE request_id = ? AND action = 'email'", qid).some(e => /1 封寄出（附 PDF）/.test(e.message)), '請求時間軸記下「1 封寄出（附 PDF）」');

  // 關閉附 PDF → 沒有附件
  t.q('UPDATE quote_settings SET attach_pdf = 0 WHERE id = 1');
  stub.clear();
  await t.go(adm, '/admin/mail');
  await t.post(adm, '/quotes/new', `first=${ctx.items[3]}&items=${ctx.items[3]}&urgency=normal`);
  t.ok(await waitFor(() => stub.messages.length >= 1, 20000), '第二張請求的信寄出');
  t.ok(!leaves(msg().mime).some(x => x.type === 'application/pdf') && !/緊急/.test(msg().mime.header('subject')), '關閉「附 PDF」後：沒有附件，一般件主旨沒有「緊急」');

  // 寄信失敗不影響請求本身
  t.q('UPDATE quote_settings SET attach_pdf = 1 WHERE id = 1');
  t.q("UPDATE inspection_items SET status = 'critical' WHERE id = ?", ctx.items[1]);
  stub.clear(); stub.failAuth = true;
  await t.go(adm, '/admin/mail');
  r = await t.post(adm, '/quotes/new', `first=${ctx.items[1]}&items=${ctx.items[1]}&urgency=normal`);
  const q3 = t.q('SELECT id, status FROM quote_requests ORDER BY id DESC LIMIT 1')[0];
  t.ok(/ok=created/.test(r.url) && q3.status === 'sent', '寄信失敗時，報價請求仍然建立成功');
  t.ok(await waitFor(() => t.q("SELECT detail AS message FROM quote_request_events WHERE request_id = ? AND action = 'email'", q3.id).length > 0, 20000)
    && /失敗 1/.test(t.q("SELECT detail AS message FROM quote_request_events WHERE request_id = ? AND action = 'email'", q3.id)[0].message), '失敗原因記在請求時間軸（失敗 1）');
  stub.failAuth = false;
}
