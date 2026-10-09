// 報價請求：工程師在警告／異常的檢查項目上「通知業務報價」，業務接手、報價、結案，全程有狀態與紀錄。
// 狀態：pending_confirm（待主管確認，選用）→ sent → processing → quoted → closed；任何進行中的階段都可 cancelled。
// 規則重點：
//   · 請求內容（設備資料、項目、截圖）是送出當下的「快照」，之後批次被鎖定或項目被改都不影響；截圖會複製一份。
//   · 同一個「設備＋檢查項目」已經有進行中的請求就不能再送（避免重複通知），只能「再次提醒」。
//   · 業務＝有 quotes.receive 權限的群組成員；沒有任何可通知的業務時改通知管理員，不會默默沒人知道。
//   · 通知業務時，站內通知＋一封附 PDF 的 Email（另外可設固定業務信箱）；寄信失敗不影響請求本身，結果記在時間軸。
const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const config = require('../config');
const Notification = require('../models/Notification');
const Asset = require('../models/Asset');
const AssetCategory = require('../models/AssetCategory');
const InspectionVolume = require('../models/InspectionVolume');
const InspectionItemPhoto = require('../models/InspectionItemPhoto');
const MailService = require('./MailService');
const QuotePdf = require('./QuotePdfService');
const capacity = require('../utils/capacity');
const { can } = require('../utils/permissions');
const PermissionGroup = require('../models/PermissionGroup');
const { nowTaipei } = require('../utils/time');

const STATUS = { pending_confirm: '待主管確認', sent: '已送出', processing: '處理中', quoted: '已報價', closed: '已結案', cancelled: '已取消' };
const OPEN = ['pending_confirm', 'sent', 'processing', 'quoted'];
const URGENCY = { normal: '一般', urgent: '緊急' };
const MAX_ITEMS = 10;
const PHOTOS_PER_ITEM = 3;
const MAX_TEXT = 1000;
const MAX_PDF_BYTES = 2.5 * 1024 * 1024; // Graph 寄信的附件上限很低，太大就不附、信裡說明
const AUTO_REMINDER_LIMIT = 3;
const REMIND_COOLDOWN_MS = 24 * 3600 * 1000;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, status = 400) => ({ ok: false, error, status });
const label = (u) => (u ? (u.display_name || u.username) : '（已刪除的使用者）');
const clean = (v, max = MAX_TEXT) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);

// "YYYY-MM-DD HH:mm:ss"（台北時間字串）→ epoch ms
const toMs = (s) => Date.parse(String(s).replace(' ', 'T') + '+08:00');

// ---------- 設定 ----------

function getSettings() {
  return db.prepare('SELECT * FROM quote_settings WHERE id = 1').get();
}

function validateSettings(input) {
  const email = clean(input.sales_email, 200);
  if (email && !MailService.isValidEmail(email)) return { error: '業務信箱的 Email 格式不正確' };
  const days = input.remind_days === '' || input.remind_days == null ? 3 : Number(input.remind_days);
  if (!Number.isInteger(days) || days < 0 || days > 30) return { error: '提醒天數請輸入 0–30 的整數（0＝不自動提醒）' };
  const b = (v) => (v === 'on' || v === '1' || v === true ? 1 : 0);
  return {
    values: {
      enabled: b(input.enabled), sales_email: email || null, attach_pdf: b(input.attach_pdf),
      show_ip: b(input.show_ip), show_mac: b(input.show_mac), show_serial: b(input.show_serial),
      show_purchase: b(input.show_purchase), show_custom: b(input.show_custom),
      require_confirm: b(input.require_confirm), remind_days: days,
    },
  };
}

function saveSettings(v) {
  db.prepare(
    `UPDATE quote_settings SET enabled = ?, sales_email = ?, attach_pdf = ?, show_ip = ?, show_mac = ?, show_serial = ?,
       show_purchase = ?, show_custom = ?, require_confirm = ?, remind_days = ? WHERE id = 1`
  ).run(v.enabled, v.sales_email, v.attach_pdf, v.show_ip, v.show_mac, v.show_serial, v.show_purchase, v.show_custom, v.require_confirm, v.remind_days);
}

// ---------- 人 ----------

const isHandler = (user) => !!user && can(user, 'quotes.receive'); // 管理員 can() 永遠為真

// 業務（有 quotes.receive 的群組的啟用中成員）；沒有就改由管理員接手。excludeId：不通知這個人（例如送出請求的人自己）
function salesRecipients(excludeId = null) {
  let users = db.prepare(
    `SELECT DISTINCT u.* FROM users u
     JOIN permission_group_perms p ON p.group_id = u.group_id AND p.permission = 'quotes.receive'
     WHERE u.is_active = 1 AND u.role <> 'admin'`
  ).all();
  if (users.length === 0) users = db.prepare("SELECT * FROM users WHERE role = 'admin' AND is_active = 1").all();
  return users.filter(u => u.id !== excludeId);
}

function admins(excludeId = null) {
  return db.prepare("SELECT * FROM users WHERE role = 'admin' AND is_active = 1").all().filter(u => u.id !== excludeId);
}

const userById = (id) => (id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null);

// ---------- 紀錄與通知 ----------

function addEvent(requestId, userId, action, detail = null) {
  db.prepare('INSERT INTO quote_request_events (request_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(requestId, userId, action, detail, nowTaipei());
}

function touch(requestId) {
  db.prepare('UPDATE quote_requests SET updated_at = ? WHERE id = ?').run(nowTaipei(), requestId);
}

// 一般通知（站內＋純文字 Email）
function notify(users, request, { type, title, message }) {
  for (const u of users) {
    const id = Notification.create(u.id, { batchId: null, type, title, message, link: `/quotes/${request.id}` });
    MailService.queueNotificationEmail(id);
  }
}

// ---------- 取得資料 ----------

function findRequest(id) {
  const r = db.prepare(
    `SELECT q.*, ru.display_name AS rn1, ru.username AS rn2, au.display_name AS an1, au.username AS an2
     FROM quote_requests q
     LEFT JOIN users ru ON ru.id = q.requested_by
     LEFT JOIN users au ON au.id = q.assigned_to
     WHERE q.id = ?`
  ).get(id);
  if (!r) return null;
  r.requested_by_name = r.rn1 || r.rn2 || '（已刪除的使用者）';
  r.assigned_to_name = r.an1 || r.an2 || null;
  return r;
}

function getDetail(id) {
  const request = findRequest(id);
  if (!request) return null;
  const items = db.prepare('SELECT * FROM quote_request_items WHERE request_id = ? ORDER BY id ASC').all(id);
  const photos = db.prepare(
    `SELECT p.* FROM quote_request_photos p JOIN quote_request_items i ON i.id = p.item_id WHERE i.request_id = ? ORDER BY p.item_id, p.sort_order`
  ).all(id);
  items.forEach(i => { i.photos = photos.filter(p => p.item_id === i.id); });
  const events = db.prepare(
    `SELECT e.*, u.display_name, u.username FROM quote_request_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.request_id = ? ORDER BY e.id ASC`
  ).all(id).map(e => ({ ...e, who: e.user_id ? (e.display_name || e.username || '（已刪除的使用者）') : '系統' }));
  // 這些項目後來的最新巡檢結果是不是已經恢復正常
  const latest = db.prepare(
    `SELECT ii.status FROM inspection_items ii JOIN inspection_batches b ON b.id = ii.batch_id
     WHERE ii.asset_id = ? AND ii.checklist_item_id = ? ORDER BY b.batch_date DESC, b.id DESC LIMIT 1`
  );
  const recovered = items.length > 0 && items.every(i => { const l = latest.get(i.asset_id, i.checklist_item_id); return l && l.status === 'normal'; });
  return { request, asset: JSON.parse(request.asset_snapshot), items, events, recovered };
}

function canView(user, request) {
  return !!user && (isHandler(user) || request.requested_by === user.id);
}

// 這個設備＋檢查項目目前進行中的請求（沒有回傳 undefined）
function openRequestFor(assetId, checklistItemId) {
  return db.prepare(
    `SELECT q.id, q.status FROM quote_request_items i JOIN quote_requests q ON q.id = i.request_id
     WHERE i.asset_id = ? AND i.checklist_item_id = ? AND q.status IN (${OPEN.map(() => '?').join(',')})
     ORDER BY q.id DESC LIMIT 1`
  ).get(assetId, checklistItemId, ...OPEN);
}

// 待處理項目頁用：每個「設備＋檢查項目」最新的一張請求（進行中的優先）→ Map('asset:item' → {id,status})
function latestByPair() {
  const rows = db.prepare(
    `SELECT i.asset_id, i.checklist_item_id, q.id, q.status FROM quote_request_items i JOIN quote_requests q ON q.id = i.request_id
     WHERE q.status <> 'cancelled' ORDER BY q.id ASC`
  ).all();
  const map = new Map();
  for (const r of rows) {
    const key = `${r.asset_id}:${r.checklist_item_id}`;
    const prev = map.get(key);
    // 進行中的永遠蓋過已結案的；同類取較新的
    if (!prev || OPEN.includes(r.status) || !OPEN.includes(prev.status)) map.set(key, { id: r.id, status: r.status });
  }
  return map;
}

// ---------- 建立 ----------

function capacityExtra(assetId, volumes) {
  if (!volumes || volumes.length === 0) return '';
  try {
    const capacityRoutes = require('../routes/capacity'); // 延後載入：避免服務與路由互相 require
    const names = new Set(volumes.map(v => v.name.toLowerCase()));
    const rows = InspectionVolume.seriesForAsset(assetId).map(r => ({ ...r, asset_id: assetId, volume: r.name }));
    return InspectionVolume.buildSeries(rows)
      .filter(s => names.has(String(s.volume).toLowerCase()))
      .map(s => `${s.volume}：${capacityRoutes.forecastText(s)}`).join('\n');
  } catch (e) {
    return '';
  }
}

function assetSnapshot(asset) {
  return JSON.stringify({
    name: asset.name, categoryLabel: AssetCategory.labelMap()[asset.category] || asset.category, location: asset.location || '',
    hostname: asset.hostname || '', brand: asset.brand || '', model: asset.model || '', serial_number: asset.serial_number || '',
    purchase_date: asset.purchase_date || '', ip_address: asset.ip_address || '', mac_address: asset.mac_address || '',
    custom: (asset.customDisplay || []).map(c => ({ label: c.label, text: c.text })),
  });
}

function create(user, { itemIds, urgency, description }) {
  const settings = getSettings();
  if (!settings.enabled) return fail('報價請求功能目前沒有啟用');
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : [itemIds]).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return fail('請選擇要通知業務的檢查項目');
  if (ids.length > MAX_ITEMS) return fail(`一張請求最多 ${MAX_ITEMS} 個項目`);
  const urg = Object.prototype.hasOwnProperty.call(URGENCY, urgency) ? urgency : 'normal';
  const desc = clean(description);

  const rows = db.prepare(
    `SELECT ii.*, COALESCE(ii.item_label, ci.label) AS label, b.title AS batch_title, b.batch_date
     FROM inspection_items ii JOIN checklist_items ci ON ci.id = ii.checklist_item_id JOIN inspection_batches b ON b.id = ii.batch_id
     WHERE ii.id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  if (rows.length !== ids.length) return fail('找不到指定的檢查項目，請重新整理頁面');
  if (new Set(rows.map(r => r.asset_id)).size !== 1) return fail('一張請求只能包含同一台設備的項目');
  if (rows.some(r => r.status !== 'warning' && r.status !== 'critical')) return fail('只有警告或異常的項目可以通知業務報價');
  const asset = Asset.findById(rows[0].asset_id);
  if (!asset || !asset.is_active) return fail('這台設備已停用，無法建立報價請求');
  for (const r of rows) {
    const open = openRequestFor(r.asset_id, r.checklist_item_id);
    if (open) return fail(`「${r.label}」已經有進行中的報價請求（Q-${open.id}），請不要重複送出`, 409);
  }
  InspectionVolume.attach(rows);

  const status = settings.require_confirm ? 'pending_confirm' : 'sent';
  const now = nowTaipei();
  const requestId = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO quote_requests (asset_id, asset_snapshot, source_batch_id, urgency, description, status, requested_by, requested_at, sent_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(asset.id, assetSnapshot(asset), rows[0].batch_id, urg, desc || null, status, user.id, now, status === 'sent' ? now : null, now);
    const rid = r.lastInsertRowid;
    const insItem = db.prepare(
      `INSERT INTO quote_request_items (request_id, inspection_item_id, asset_id, checklist_item_id, label, status, display, note, extra, batch_id, batch_title, batch_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insPhoto = db.prepare('INSERT INTO quote_request_photos (item_id, path, width, height, sort_order) VALUES (?, ?, ?, ?, ?)');
    const dir = path.join(config.UPLOADS_DIR, 'quotes', String(rid));
    for (const row of rows) {
      const display = row.volumes.length > 0 ? capacity.volumeLines(row.volumes).join('\n') : (row.value_text || '');
      const it = insItem.run(rid, row.id, row.asset_id, row.checklist_item_id, row.label, row.status, display || null, row.note || null,
        capacityExtra(row.asset_id, row.volumes) || null, row.batch_id, row.batch_title, row.batch_date);
      // 截圖複製一份（最多 3 張）：原項目之後被改或截圖被刪，這張請求裡的內容不變
      const photos = InspectionItemPhoto.findByItemId(row.id).filter(p => p.path && fs.existsSync(p.path)).slice(0, PHOTOS_PER_ITEM);
      photos.forEach((p, i) => {
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${it.lastInsertRowid}-${i}${path.extname(p.path) || '.webp'}`);
        fs.copyFileSync(p.path, dest);
        insPhoto.run(it.lastInsertRowid, dest, p.width || null, p.height || null, i);
      });
    }
    addEvent(rid, user.id, 'created', `${label(user)} 建立請求（${rows.length} 個項目，${URGENCY[urg]}）${status === 'pending_confirm' ? '，等待主管確認' : ''}`);
    return rid;
  })();

  const request = findRequest(requestId);
  if (status === 'pending_confirm') {
    const targets = admins(user.id);
    notify(targets, request, {
      type: 'quote_confirm', title: `待確認報價請求 Q-${requestId}：${asset.name}`,
      message: `${label(user)} 想通知業務為「${asset.name}」報價（${rows.map(r => r.label).join('、')}），需要你確認後才會送出。`,
    });
  } else {
    notifySales(request, 'new');
  }
  return ok({ id: requestId, status });
}

// ---------- 通知業務（站內＋附 PDF 的 Email） ----------

function requestSummaryText(detail, settings) {
  const { request, asset, items } = detail;
  const lines = [
    `緊急程度：${URGENCY[request.urgency]}`,
    `送出：${request.requested_by_name}`,
    `設備：${asset.name}`,
    ...QuotePdf.visibleAssetLines(asset, settings),
    '',
    ...items.map(i => `【${i.status === 'critical' ? '異常' : '警告'}】${i.label}${i.display ? `\n${i.display}` : ''}${i.note ? `\n備註：${i.note}` : ''}`),
  ];
  if (request.description) lines.push('', `工程師說明：${request.description}`);
  return lines.join('\n');
}

function notifySales(request, kind) {
  const users = request.status === 'processing' && request.assigned_to
    ? [userById(request.assigned_to)].filter(Boolean)
    : salesRecipients(request.requested_by);
  const detail = getDetail(request.id);
  const reminder = kind !== 'new';
  const title = `${reminder ? '【提醒】' : ''}${request.urgency === 'urgent' ? '【緊急】' : ''}報價請求 Q-${request.id}：${detail.asset.name}`;
  const message = `${request.requested_by_name} 通知業務為「${detail.asset.name}」報價（${detail.items.map(i => i.label).join('、')}）${reminder ? '，這張請求還在等你處理。' : '。'}請登入系統查看並處理。`;
  const notifMap = new Map();
  for (const u of users) {
    notifMap.set(u.id, Notification.create(u.id, { batchId: null, type: reminder ? 'quote_reminder' : 'quote_new', title, message, link: `/quotes/${request.id}` }));
  }
  if (users.length === 0) addEvent(request.id, null, 'warn', '目前沒有可以通知的業務（請在「權限群組」把人加進「業務」群組）');
  queueRichEmails(request.id, users, notifMap, title, reminder);
}

// 背景寄信（附 PDF）；結果寫回各人的通知與請求的時間軸。寄信失敗絕不影響請求本身。
function queueRichEmails(requestId, users, notifMap, title, reminder) {
  setImmediate(async () => {
    try {
      const settings = getSettings();
      const detail = getDetail(requestId);
      if (!detail) return;
      const targets = users.map(u => ({ user: u, to: MailService.recipientFor(u), notif: notifMap.get(u.id) }));
      const fixed = settings.sales_email && MailService.isValidEmail(settings.sales_email) ? settings.sales_email : null;
      const anyMail = targets.some(t => t.to) || fixed;
      if (!anyMail) { targets.forEach(t => t.notif && Notification.setEmailResult(t.notif, 'skipped', '這位使用者沒有設定 Email')); return; }
      if (!MailService.isReady()) { targets.forEach(t => t.notif && Notification.setEmailResult(t.notif, 'skipped', '寄信功能尚未啟用，或設定不完整')); return; }

      let attachments = [];
      let attachNote = '';
      if (settings.attach_pdf) {
        try {
          const pdf = await QuotePdf.generate(detail, settings);
          if (pdf.length <= MAX_PDF_BYTES) attachments = [{ filename: `報價請求-Q${requestId}.pdf`, content: pdf, contentType: 'application/pdf' }];
          else attachNote = '（PDF 檔案太大沒有附上，請登入系統查看完整內容與截圖）';
        } catch (e) {
          console.error('[報價請求] 產生 PDF 失敗：', e.message);
          attachNote = '（PDF 產生失敗沒有附上，請登入系統查看完整內容）';
        }
      }
      const base = MailService.appBaseUrl();
      const link = base ? `${base}/quotes/${requestId}` : null;
      const body = requestSummaryText(detail, settings) + (attachNote ? `\n\n${attachNote}` : '');
      const { text, html } = MailService.renderEmail({ title, message: body, linkUrl: link });
      const subject = `【維護巡檢報告系統】${title}`.replace(/[\r\n]+/g, ' ');

      let sentCount = 0;
      const failures = [];
      for (const t of targets) {
        if (!t.to) { if (t.notif) Notification.setEmailResult(t.notif, 'skipped', '這位使用者沒有設定 Email'); continue; }
        const r = await MailService.sendMail({ to: t.to, subject, text, html, attachments });
        if (t.notif) Notification.setEmailResult(t.notif, r.status, r.error || null);
        if (r.status === 'sent') sentCount++; else failures.push(`${label(t.user)}：${r.error || r.status}`);
      }
      if (fixed && !targets.some(t => t.to === fixed)) {
        const r = await MailService.sendMail({ to: fixed, subject, text, html, attachments });
        if (r.status === 'sent') sentCount++; else failures.push(`業務信箱：${r.error || r.status}`);
      }
      addEvent(requestId, null, 'email', `${reminder ? '提醒信' : '通知信'}：${sentCount} 封寄出${attachments.length ? '（附 PDF）' : ''}${failures.length ? `；失敗 ${failures.length}（${failures.join('；').slice(0, 300)}）` : ''}`);
    } catch (err) {
      console.error('[報價請求] 寄信處理失敗：', err);
    }
  });
}

// ---------- 狀態變更 ----------

function mustBeOpen(request, allowed) {
  return allowed.includes(request.status) ? null : fail(`這張請求目前是「${STATUS[request.status]}」，不能執行這個動作`, 409);
}

// 狀態轉換要在交易裡重新讀一次，避免兩個人同時按
function transition(id, fn) {
  let result;
  db.transaction(() => {
    const request = findRequest(id);
    result = request ? fn(request) : fail('找不到這張報價請求', 404);
  })();
  return result;
}

function confirm(id, user) {
  if (!can(user, 'quotes.receive') || user.role !== 'admin') return fail('只有管理員可以確認', 403);
  const r = transition(id, (request) => {
    const bad = mustBeOpen(request, ['pending_confirm']);
    if (bad) return bad;
    const now = nowTaipei();
    db.prepare("UPDATE quote_requests SET status = 'sent', confirmed_by = ?, confirmed_at = ?, sent_at = ?, updated_at = ? WHERE id = ?").run(user.id, now, now, now, id);
    addEvent(id, user.id, 'confirmed', `${label(user)} 確認送出`);
    return ok({ request });
  });
  if (r.ok) {
    const request = findRequest(id);
    notifySales(request, 'new');
    if (request.requested_by !== user.id) notify([userById(request.requested_by)].filter(Boolean), request, { type: 'quote_update', title: `報價請求 Q-${id} 已確認送出`, message: `${label(user)} 確認了你的報價請求，已通知業務。` });
  }
  return r;
}

function reject(id, user, reason) {
  if (user.role !== 'admin') return fail('只有管理員可以退回', 403);
  const text = clean(reason, 500);
  if (!text) return fail('退回時請填寫原因');
  const r = transition(id, (request) => {
    const bad = mustBeOpen(request, ['pending_confirm']);
    if (bad) return bad;
    const now = nowTaipei();
    db.prepare("UPDATE quote_requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    addEvent(id, user.id, 'rejected', `${label(user)} 退回（取消）：${text}`);
    return ok({ request });
  });
  if (r.ok) {
    const request = findRequest(id);
    notify([userById(request.requested_by)].filter(Boolean), request, { type: 'quote_update', title: `報價請求 Q-${id} 被退回`, message: `${label(user)} 沒有同意送出這張報價請求。原因：${text}` });
  }
  return r;
}

function claim(id, user) {
  if (!isHandler(user)) return fail('只有業務可以接手', 403);
  const r = transition(id, (request) => {
    const bad = mustBeOpen(request, ['sent']);
    if (bad) return bad;
    const now = nowTaipei();
    db.prepare('UPDATE quote_requests SET status = ?, assigned_to = ?, first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?').run('processing', user.id, now, now, id);
    addEvent(id, user.id, 'claimed', `${label(user)} 接手處理`);
    return ok({ request });
  });
  if (r.ok) notifyRequester(id, user, 'processing', `${label(user)} 已接手處理你的報價請求。`);
  return r;
}

function parseAmount(v) {
  const t = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (!t) return { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) > 1e9) return { error: '金額請輸入數字（最多兩位小數）' };
  return { value: Number(t) };
}

function quote(id, user, { quote_no, amount, note }) {
  if (!isHandler(user)) return fail('只有業務可以填報價', 403);
  const no = clean(quote_no, 50);
  const amt = parseAmount(amount);
  if (amt.error) return fail(amt.error);
  const text = clean(note, 1000);
  const r = transition(id, (request) => {
    const bad = mustBeOpen(request, ['sent', 'processing']);
    if (bad) return bad;
    const now = nowTaipei();
    db.prepare(
      `UPDATE quote_requests SET status = 'quoted', assigned_to = COALESCE(assigned_to, ?), first_response_at = COALESCE(first_response_at, ?),
         quoted_at = ?, quote_no = ?, quote_amount = ?, sales_note = ?, updated_at = ? WHERE id = ?`
    ).run(user.id, now, now, no || null, amt.value, text || null, now, id);
    addEvent(id, user.id, 'quoted', `${label(user)} 已報價${no ? `（單號 ${no}）` : ''}${amt.value != null ? `，金額 ${amt.value.toLocaleString('en-US')}` : ''}${text ? `：${text}` : ''}`);
    return ok({ request });
  });
  if (r.ok) notifyRequester(id, user, 'quoted', `${label(user)} 已完成報價${no ? `（單號 ${no}）` : ''}${amt.value != null ? `，金額 ${amt.value.toLocaleString('en-US')}` : ''}。${text ? `備註：${text}` : ''}`);
  return r;
}

function close(id, user, note) {
  if (!isHandler(user)) return fail('只有業務可以結案', 403);
  const text = clean(note, 1000);
  const r = transition(id, (request) => {
    const bad = mustBeOpen(request, ['sent', 'processing', 'quoted']);
    if (bad) return bad;
    if (request.status !== 'quoted' && !text) return fail('還沒報價就結案，請填寫原因（例如：客戶不需要）');
    const now = nowTaipei();
    db.prepare("UPDATE quote_requests SET status = 'closed', closed_at = ?, closed_by = ?, first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?").run(now, user.id, now, now, id);
    addEvent(id, user.id, 'closed', `${label(user)} 結案${text ? `：${text}` : ''}`);
    return ok({ request });
  });
  if (r.ok) notifyRequester(id, user, 'closed', `${label(user)} 已將這張報價請求結案。${text ? `說明：${text}` : ''}`);
  return r;
}

function cancel(id, user, reason) {
  const text = clean(reason, 500);
  const r = transition(id, (request) => {
    if (request.requested_by !== user.id && user.role !== 'admin') return fail('只有送出請求的人或管理員可以取消', 403);
    const bad = mustBeOpen(request, ['pending_confirm', 'sent', 'processing']);
    if (bad) return bad;
    const now = nowTaipei();
    db.prepare("UPDATE quote_requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    addEvent(id, user.id, 'cancelled', `${label(user)} 取消請求${text ? `：${text}` : ''}`);
    return ok({ request });
  });
  if (r.ok) {
    const request = findRequest(id);
    const targets = request.assigned_to ? [userById(request.assigned_to)] : salesRecipients(user.id);
    notify(targets.filter(u => u && u.id !== user.id), request, { type: 'quote_update', title: `報價請求 Q-${id} 已取消`, message: `${label(user)} 取消了這張報價請求。${text ? `原因：${text}` : ''}` });
    if (request.requested_by !== user.id) notify([userById(request.requested_by)].filter(Boolean), request, { type: 'quote_update', title: `報價請求 Q-${id} 已被取消`, message: `${label(user)} 取消了你的報價請求。${text ? `原因：${text}` : ''}` });
  }
  return r;
}

function remind(id, user) {
  const r = transition(id, (request) => {
    if (request.requested_by !== user.id && user.role !== 'admin') return fail('只有送出請求的人或管理員可以提醒', 403);
    const bad = mustBeOpen(request, ['sent', 'processing']);
    if (bad) return bad;
    const last = request.last_reminded_at ? toMs(request.last_reminded_at) : 0;
    if (Date.now() - last < REMIND_COOLDOWN_MS) return fail('24 小時內已經提醒過了，請稍後再試', 429);
    const now = nowTaipei();
    db.prepare('UPDATE quote_requests SET reminder_count = reminder_count + 1, last_reminded_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    addEvent(id, user.id, 'reminder', `${label(user)} 再次提醒業務（第 ${request.reminder_count + 1} 次）`);
    return ok({ request });
  });
  if (r.ok) notifySales(findRequest(id), 'reminder');
  return r;
}

function addNote(id, user, text) {
  const t = clean(text, 1000);
  if (!t) return fail('請輸入內容');
  const request = findRequest(id);
  if (!request) return fail('找不到這張報價請求', 404);
  if (!canView(user, request)) return fail('沒有權限', 403);
  addEvent(id, user.id, 'note', `${label(user)}：${t}`);
  touch(id);
  const other = request.requested_by === user.id
    ? (request.assigned_to ? [userById(request.assigned_to)] : (request.status === 'sent' ? salesRecipients(user.id) : []))
    : [userById(request.requested_by)];
  notify(other.filter(u => u && u.id !== user.id), request, { type: 'quote_update', title: `報價請求 Q-${id} 有新留言`, message: `${label(user)}：${t.slice(0, 200)}` });
  return ok();
}

function notifyRequester(id, actor, type, message) {
  const request = findRequest(id);
  const target = userById(request.requested_by);
  if (!target || target.id === actor.id) return;
  notify([target], request, { type: `quote_${type}`, title: `報價請求 Q-${id}：${STATUS[request.status]}`, message });
}

// ---------- 自動提醒 ----------

// 「已送出」超過 N 天沒人接手、或「處理中」超過 N 天沒進展，自動提醒業務（每張最多 3 次）。每小時檢查一次。
function runReminders() {
  const days = getSettings().remind_days;
  if (!days) return 0;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const rows = db.prepare("SELECT * FROM quote_requests WHERE status IN ('sent', 'processing') AND auto_reminder_count < ?").all(AUTO_REMINDER_LIMIT);
  let n = 0;
  for (const r of rows) {
    const since = Math.max(toMs(r.updated_at), r.last_reminded_at ? toMs(r.last_reminded_at) : 0);
    if (since > cutoff) continue;
    const now = nowTaipei();
    db.prepare('UPDATE quote_requests SET auto_reminder_count = auto_reminder_count + 1, last_reminded_at = ? WHERE id = ?').run(now, r.id);
    addEvent(r.id, null, 'auto_reminder', `超過 ${days} 天沒有進展，系統自動提醒業務（第 ${r.auto_reminder_count + 1} 次）`);
    notifySales(findRequest(r.id), 'reminder');
    n++;
  }
  return n;
}

let reminderTimer = null;
function startReminders() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(() => { try { runReminders(); } catch (e) { console.error('[報價請求] 自動提醒失敗：', e); } }, 60 * 60 * 1000);
  reminderTimer.unref();
  setTimeout(() => { try { runReminders(); } catch (e) { console.error('[報價請求] 自動提醒失敗：', e); } }, 60 * 1000).unref();
}

// ---------- 清單、儀表板、統計 ----------

// 業務／管理員看全部，其他人只看自己送出的
function listFor(user, { view = 'open', q = '', mine = false, page = 1, per = 50 } = {}) {
  const where = [];
  const params = [];
  if (!isHandler(user) || mine) { where.push('q.requested_by = ?'); params.push(user.id); }
  if (view === 'open') where.push(`q.status IN (${OPEN.map(() => '?').join(',')})`), params.push(...OPEN);
  else if (STATUS[view]) { where.push('q.status = ?'); params.push(view); }
  const term = String(q || '').trim().toLowerCase().slice(0, 60);
  if (term) {
    where.push(`(LOWER(q.asset_snapshot) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(q.quote_no,'')) LIKE ? ESCAPE '\\' OR CAST(q.id AS TEXT) = ?
      OR EXISTS (SELECT 1 FROM quote_request_items i WHERE i.request_id = q.id AND LOWER(i.label) LIKE ? ESCAPE '\\'))`);
    const like = `%${term.replace(/[\\%_]/g, m => '\\' + m)}%`;
    params.push(like, like, term.replace(/^q-?/, ''), like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM quote_requests q ${whereSql}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / per));
  const cur = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
  const rows = db.prepare(
    `SELECT q.*, ru.display_name AS rn1, ru.username AS rn2, au.display_name AS an1, au.username AS an2,
            (SELECT group_concat(label, '、') FROM quote_request_items i WHERE i.request_id = q.id) AS item_labels
     FROM quote_requests q LEFT JOIN users ru ON ru.id = q.requested_by LEFT JOIN users au ON au.id = q.assigned_to
     ${whereSql}
     ORDER BY CASE WHEN q.status IN ('closed','cancelled') THEN 1 ELSE 0 END, CASE q.urgency WHEN 'urgent' THEN 0 ELSE 1 END, q.id DESC
     LIMIT ? OFFSET ?`
  ).all(...params, per, (cur - 1) * per).map(r => ({
    ...r, asset: JSON.parse(r.asset_snapshot), requested_by_name: r.rn1 || r.rn2 || '（已刪除的使用者）', assigned_to_name: r.an1 || r.an2 || '',
  }));
  return { rows, total, page: cur, pages };
}

function counts(user) {
  const scope = isHandler(user) ? '' : 'WHERE requested_by = ?';
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM quote_requests ${scope} GROUP BY status`).all(...(isHandler(user) ? [] : [user.id]));
  const map = Object.fromEntries(rows.map(r => [r.status, r.n]));
  return { map, open: OPEN.reduce((a, s) => a + (map[s] || 0), 0) };
}

function dashboardFor(user) {
  const c = counts(user);
  if (isHandler(user)) {
    return { handler: true, waiting: (c.map.sent || 0), processing: (c.map.processing || 0), confirm: (c.map.pending_confirm || 0), quoted: (c.map.quoted || 0) };
  }
  return { handler: false, open: c.open };
}

function stats() {
  const all = db.prepare("SELECT * FROM quote_requests WHERE status <> 'pending_confirm'").all();
  const effective = all.filter(r => r.status !== 'cancelled');
  const quoted = effective.filter(r => r.quoted_at);
  const hours = (a, b) => (toMs(b) - toMs(a)) / 3600000;
  const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);
  const firstResp = avg(effective.filter(r => r.first_response_at && r.sent_at).map(r => hours(r.sent_at, r.first_response_at)));
  const toQuote = avg(quoted.filter(r => r.sent_at).map(r => hours(r.sent_at, r.quoted_at) / 24));
  const days = getSettings().remind_days || 3;
  const overdue = all.filter(r => r.status === 'sent' && Date.now() - toMs(r.sent_at || r.requested_at) > days * 86400000).length;
  // 最近 6 個月（含本月，台北時間）
  const months = [];
  const base = new Date(Date.now() + 8 * 3600 * 1000);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const byMonth = months.map(m => {
    const inMonth = effective.filter(r => (r.requested_at || '').startsWith(m));
    const q = inMonth.filter(r => r.quoted_at);
    return { month: m, created: inMonth.length, quoted: q.length, amount: q.reduce((a, r) => a + (r.quote_amount || 0), 0) };
  });
  const nameOf = (id) => { const u = userById(id); return u ? label(u) : '（已刪除的使用者）'; };
  const top = (key) => {
    const m = new Map();
    effective.forEach(r => { if (r[key]) m.set(r[key], (m.get(r[key]) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ name: nameOf(id), n }));
  };
  const byStatus = {};
  all.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  return {
    total: all.length, effective: effective.length, byStatus,
    quotedCount: quoted.length, quotedRate: effective.length ? quoted.length / effective.length : null,
    avgFirstResponseHours: firstResp, avgDaysToQuote: toQuote, overdue, remindDays: days,
    totalAmount: quoted.reduce((a, r) => a + (r.quote_amount || 0), 0),
    byMonth, topRequesters: top('requested_by'), topHandlers: top('assigned_to'),
  };
}

module.exports = {
  STATUS, OPEN, URGENCY, MAX_ITEMS,
  getSettings, validateSettings, saveSettings, isHandler, canView,
  findRequest, getDetail, openRequestFor, latestByPair,
  create, confirm, reject, claim, quote, close, cancel, remind, addNote,
  runReminders, startReminders, listFor, counts, dashboardFor, stats, salesRecipients,
};
