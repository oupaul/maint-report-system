// 刪除與封存：批次、批次內的設備、設備、使用者、系統通知。
// 原則（改動前請先讀）：
// - 有稽核意義的紀錄（已完成／送審過的批次、簽核紀錄、報價）不直接硬刪：批次改用「封存」（可還原），報價只能取消／結案。
// - 草稿或手誤建立的：可以真刪（建立者或管理員），批次要輸入標題確認。
// - 沒用過的主檔資料（設備、使用者）才能刪；用過的維持只能停用。
// - 每個動作都在「同一個交易」裡檢查條件、刪資料、寫稽核紀錄；檔案（截圖、簽名）在交易提交後才刪（交易失敗不會留下「資料還在、檔案沒了」）。
// - 判斷條件一律在伺服器端；畫面上的按鈕與提示只是 UI。
const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const config = require('../config');
const AuditLog = require('../models/AuditLog');
const AssetTag = require('../models/AssetTag');
const Announcement = require('../models/Announcement');
const { nowTaipei } = require('../utils/time');

const isAdmin = (u) => !!u && u.role === 'admin';
const fail = (error, status = 400) => ({ ok: false, error, status });
const count = (sql, ...args) => db.prepare(sql).get(...args).n;

function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') console.warn(`[刪除] 無法刪除檔案 ${p}: ${e.message}`); }
}

// 批次的上傳資料夾（截圖、簽名檔）：只刪 UPLOADS_DIR/<批次編號> 這個資料夾，並確認路徑真的在 UPLOADS_DIR 底下
function removeBatchDir(batchId) {
  const root = path.resolve(config.UPLOADS_DIR);
  const dir = path.resolve(root, String(parseInt(batchId, 10)));
  if (!dir.startsWith(root + path.sep)) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn(`[刪除] 無法刪除資料夾 ${dir}: ${e.message}`); }
}

// ---------- 批次 ----------

function quoteRefsOfBatch(batchId) {
  return count('SELECT COUNT(*) AS n FROM quote_requests WHERE source_batch_id = ?', batchId)
    + count('SELECT COUNT(*) AS n FROM quote_request_items WHERE batch_id = ?', batchId);
}

// 回傳不能刪除的原因（沒有原因＝可以刪）。user 為 null 時只檢查資料狀態、不檢查權限（給畫面判斷要不要顯示按鈕）
function batchDeleteBlocker(batch, user) {
  if (!batch) return { error: '找不到批次', status: 404 };
  if (user && !(isAdmin(user) || batch.created_by === user.id)) return { error: '只有建立這個批次的人或管理員可以刪除批次', status: 403 };
  if (batch.status !== 'draft') return { error: '已完成的批次不能刪除，保留作為歷史紀錄；管理員可以改用「封存」把它從清單隱藏', status: 409 };
  if (batch.approval_status !== 'none' || count('SELECT COUNT(*) AS n FROM approval_records WHERE batch_id = ?', batch.id) > 0) {
    return { error: '這個批次送審過（審核中、被退回或已核准），簽核紀錄要保留，不能刪除', status: 409 };
  }
  if (quoteRefsOfBatch(batch.id) > 0) return { error: '已經有報價請求引用這個批次，不能刪除', status: 409 };
  return null;
}

function deleteBatch(batchId, user, confirmTitle) {
  let result;
  let photoPaths = [];
  db.transaction(() => {
    const batch = db.prepare('SELECT * FROM inspection_batches WHERE id = ?').get(batchId);
    const blocker = batchDeleteBlocker(batch, user);
    if (blocker) { result = fail(blocker.error, blocker.status); return; }
    if (String(confirmTitle || '').trim() !== batch.title) { result = fail('請輸入和批次標題完全相同的文字，才能確認刪除'); return; }

    const itemIds = db.prepare('SELECT id FROM inspection_items WHERE batch_id = ?').all(batch.id).map(r => r.id);
    photoPaths = db.prepare(
      'SELECT p.path FROM inspection_item_photos p JOIN inspection_items i ON i.id = p.inspection_item_id WHERE i.batch_id = ?'
    ).all(batch.id).map(r => r.path);
    const nAssets = count('SELECT COUNT(*) AS n FROM inspection_batch_assets WHERE batch_id = ?', batch.id);

    db.prepare('DELETE FROM inspection_item_photos WHERE inspection_item_id IN (SELECT id FROM inspection_items WHERE batch_id = ?)').run(batch.id);
    db.prepare('DELETE FROM inspection_item_volumes WHERE inspection_item_id IN (SELECT id FROM inspection_items WHERE batch_id = ?)').run(batch.id);
    db.prepare('DELETE FROM inspection_items WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM inspection_batch_assets WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM batch_signatures WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM approval_records WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM approval_events WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM notifications WHERE batch_id = ?').run(batch.id);
    db.prepare('DELETE FROM inspection_batches WHERE id = ?').run(batch.id);
    AuditLog.record(user, 'batch.delete', {
      type: 'batch', id: batch.id, label: batch.title,
      detail: `巡檢日期 ${batch.batch_date}；設備 ${nAssets} 台、檢查紀錄 ${itemIds.length} 筆、截圖 ${photoPaths.length} 張`,
    });
    result = { ok: true, title: batch.title };
  })();
  if (result && result.ok) { photoPaths.forEach(unlinkQuiet); removeBatchDir(batchId); }
  return result;
}

// 把一台設備移出（草稿）批次：該設備在這個批次的檢查紀錄、截圖、磁碟區一併刪除
function removeAssetFromBatch(batchId, assetId, user) {
  let result;
  let photoPaths = [];
  db.transaction(() => {
    const batch = db.prepare('SELECT * FROM inspection_batches WHERE id = ?').get(batchId);
    if (!batch) { result = fail('找不到批次', 404); return; }
    if (!(isAdmin(user) || batch.created_by === user.id)) { result = fail('只有建立這個批次的人或管理員可以把設備移出批次', 403); return; }
    if (batch.status !== 'draft' || (batch.approval_status !== 'none' && batch.approval_status !== 'returned')) {
      result = fail('這個批次已完成或正在審核，不能再移出設備', 409); return;
    }
    const link = db.prepare('SELECT 1 FROM inspection_batch_assets WHERE batch_id = ? AND asset_id = ?').get(batch.id, assetId);
    if (!link) { result = fail('這台設備不在這個批次裡', 404); return; }
    if (count('SELECT COUNT(*) AS n FROM inspection_batch_assets WHERE batch_id = ?', batch.id) <= 1) {
      result = fail('批次至少要保留一台設備；想整批不要了，請改用「刪除批次」'); return;
    }
    if (count('SELECT COUNT(*) AS n FROM quote_request_items WHERE batch_id = ? AND asset_id = ?', batch.id, assetId) > 0) {
      result = fail('這台設備在這個批次的檢查項目已經送出過報價請求，不能移出', 409); return;
    }
    const asset = db.prepare('SELECT name FROM assets WHERE id = ?').get(assetId);
    photoPaths = db.prepare(
      'SELECT p.path FROM inspection_item_photos p JOIN inspection_items i ON i.id = p.inspection_item_id WHERE i.batch_id = ? AND i.asset_id = ?'
    ).all(batch.id, assetId).map(r => r.path);
    const nItems = count('SELECT COUNT(*) AS n FROM inspection_items WHERE batch_id = ? AND asset_id = ?', batch.id, assetId);
    const sub = 'SELECT id FROM inspection_items WHERE batch_id = ? AND asset_id = ?';
    db.prepare(`DELETE FROM inspection_item_photos WHERE inspection_item_id IN (${sub})`).run(batch.id, assetId);
    db.prepare(`DELETE FROM inspection_item_volumes WHERE inspection_item_id IN (${sub})`).run(batch.id, assetId);
    db.prepare('DELETE FROM inspection_items WHERE batch_id = ? AND asset_id = ?').run(batch.id, assetId);
    db.prepare('DELETE FROM inspection_batch_assets WHERE batch_id = ? AND asset_id = ?').run(batch.id, assetId);
    AuditLog.record(user, 'batch.remove_asset', {
      type: 'batch', id: batch.id, label: batch.title,
      detail: `移出設備「${asset ? asset.name : '#' + assetId}」；一併刪除檢查紀錄 ${nItems} 筆、截圖 ${photoPaths.length} 張`,
    });
    result = { ok: true, assetName: asset ? asset.name : '' };
  })();
  if (result && result.ok) photoPaths.forEach(unlinkQuiet);
  return result;
}

// 封存／還原：只有管理員，只有已完成的批次。封存只是從清單與儀表板隱藏，資料與報告都在
function archiveBatch(batchId, user) {
  let result;
  db.transaction(() => {
    const batch = db.prepare('SELECT * FROM inspection_batches WHERE id = ?').get(batchId);
    if (!batch) { result = fail('找不到批次', 404); return; }
    if (!isAdmin(user)) { result = fail('只有管理員可以封存批次', 403); return; }
    if (batch.status !== 'completed') { result = fail('只有已完成的批次可以封存'); return; }
    if (batch.archived_at) { result = fail('這個批次已經封存了'); return; }
    db.prepare('UPDATE inspection_batches SET archived_at = ?, archived_by = ? WHERE id = ?').run(nowTaipei(), user.id, batch.id);
    AuditLog.record(user, 'batch.archive', { type: 'batch', id: batch.id, label: batch.title });
    result = { ok: true, title: batch.title };
  })();
  return result;
}

function unarchiveBatch(batchId, user) {
  let result;
  db.transaction(() => {
    const batch = db.prepare('SELECT * FROM inspection_batches WHERE id = ?').get(batchId);
    if (!batch) { result = fail('找不到批次', 404); return; }
    if (!isAdmin(user)) { result = fail('只有管理員可以還原封存的批次', 403); return; }
    if (!batch.archived_at) { result = fail('這個批次沒有封存'); return; }
    db.prepare('UPDATE inspection_batches SET archived_at = NULL, archived_by = NULL WHERE id = ?').run(batch.id);
    AuditLog.record(user, 'batch.unarchive', { type: 'batch', id: batch.id, label: batch.title });
    result = { ok: true, title: batch.title };
  })();
  return result;
}

// ---------- 設備 ----------

function assetUsage(assetId) {
  return {
    batches: count('SELECT COUNT(DISTINCT batch_id) AS n FROM inspection_batch_assets WHERE asset_id = ?', assetId),
    items: count('SELECT COUNT(*) AS n FROM inspection_items WHERE asset_id = ?', assetId),
    quotes: count('SELECT COUNT(*) AS n FROM quote_requests WHERE asset_id = ?', assetId),
    triage: count('SELECT COUNT(*) AS n FROM issue_triage WHERE asset_id = ?', assetId) + count('SELECT COUNT(*) AS n FROM issue_triage_log WHERE asset_id = ?', assetId),
  };
}

function assetDeleteBlocker(assetId) {
  const u = assetUsage(assetId);
  if (u.batches + u.items + u.quotes + u.triage === 0) return null;
  const parts = [];
  if (u.batches) parts.push(`${u.batches} 個巡檢批次`);
  if (u.quotes) parts.push(`${u.quotes} 筆報價請求`);
  if (u.triage && !u.batches && !u.quotes) parts.push('處理建議紀錄');
  if (u.items && !u.batches) parts.push(`${u.items} 筆檢查紀錄`);
  return `這台設備已經用過（出現在${parts.join('、')}），為了保留歷史紀錄只能停用，不能刪除`;
}

function deleteAssetTx(assetId, user) {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (!asset) return fail('找不到設備', 404);
  const reason = assetDeleteBlocker(assetId);
  if (reason) return fail(reason, 409);
  AssetTag.setForAsset(assetId, []); // 移除標籤連結，沒人在用的標籤一併清掉
  db.prepare('DELETE FROM asset_field_values WHERE asset_id = ?').run(assetId);
  db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
  AuditLog.record(user, 'asset.delete', {
    type: 'asset', id: asset.id, label: asset.name,
    detail: [asset.category, asset.location, asset.ip_address].filter(Boolean).join('・') || null,
  });
  return { ok: true, name: asset.name };
}

function deleteAsset(assetId, user) {
  let result;
  db.transaction(() => { result = deleteAssetTx(assetId, user); })();
  return result;
}

// 批次刪除：逐台檢查，用過的略過並回報原因；沒用過的刪掉（全部在同一個交易）
function deleteAssets(assetIds, user) {
  const ids = [...new Set(assetIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const out = { deleted: [], skipped: [] };
  db.transaction(() => {
    for (const id of ids) {
      const r = deleteAssetTx(id, user);
      if (r.ok) out.deleted.push(r.name);
      else out.skipped.push({ id, name: (db.prepare('SELECT name FROM assets WHERE id = ?').get(id) || {}).name || `#${id}`, reason: r.error });
    }
  })();
  return out;
}

// ---------- 使用者 ----------

// 「工作紀錄」：建立／送審過批次、填過檢查項目、簽過名、簽核過、發過通知、經手報價或處理建議。有的話只能停用
function userWorkRecords(userId) {
  const rows = [
    ['建立或送審過的批次', count('SELECT COUNT(*) AS n FROM inspection_batches WHERE created_by = ? OR submitted_by = ?', userId, userId)],
    ['填寫過的檢查項目', count('SELECT COUNT(*) AS n FROM inspection_items WHERE recorded_by = ?', userId)],
    ['簽名', count('SELECT COUNT(*) AS n FROM batch_signatures WHERE user_id = ?', userId)],
    ['簽核紀錄', count('SELECT COUNT(*) AS n FROM approval_records WHERE approver_id = ?', userId) + count('SELECT COUNT(*) AS n FROM approval_events WHERE user_id = ?', userId)],
    ['發出的系統通知', count('SELECT COUNT(*) AS n FROM announcements WHERE created_by = ?', userId)],
    ['經手的報價請求', count('SELECT COUNT(*) AS n FROM quote_requests WHERE requested_by = ? OR confirmed_by = ? OR closed_by = ? OR assigned_to = ?', userId, userId, userId, userId)
      + count('SELECT COUNT(*) AS n FROM quote_request_events WHERE user_id = ?', userId)],
    ['處理建議紀錄', count('SELECT COUNT(*) AS n FROM issue_triage WHERE updated_by = ?', userId) + count('SELECT COUNT(*) AS n FROM issue_triage_log WHERE user_id = ?', userId)],
  ];
  return rows.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n} 筆`);
}

function userDeleteBlocker(target, actor) {
  if (!target) return { error: '找不到使用者', status: 404 };
  if (actor && target.id === actor.id) return { error: '不能刪除自己的帳號', status: 409 };
  if (target.role === 'admin' && target.is_active && count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?", target.id) === 0) {
    return { error: '不能刪除最後一位啟用中的管理員', status: 409 };
  }
  const work = userWorkRecords(target.id);
  if (work.length) return { error: `這個帳號有工作紀錄（${work.join('、')}），為了保留紀錄只能停用，不能刪除`, status: 409 };
  return null;
}

function deleteUser(userId, actor) {
  let result;
  db.transaction(() => {
    if (!isAdmin(actor)) { result = fail('只有管理員可以刪除使用者', 403); return; }
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const blocker = userDeleteBlocker(target, actor);
    if (blocker) { result = fail(blocker.error, blocker.status); return; }
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM user_signatures WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM login_sessions WHERE user_id = ?').run(target.id);
    // 讓這個帳號現有的登入立刻失效
    try {
      const del = db.prepare('DELETE FROM sessions WHERE sid = ?');
      for (const row of db.prepare('SELECT sid, sess FROM sessions').all()) {
        try { const s = JSON.parse(row.sess); if (s.user && s.user.id === target.id) del.run(row.sid); } catch (e) { /* 無法解析的略過 */ }
      }
    } catch (e) { /* sessions 資料表還沒建立就不用處理 */ }
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    AuditLog.record(actor, 'user.delete', {
      type: 'user', id: target.id, label: target.username,
      detail: `${target.display_name || '-'}；角色 ${target.role === 'admin' ? '管理員' : '技術人員'}`,
    });
    result = { ok: true, username: target.username };
  })();
  return result;
}

// ---------- 系統通知 ----------

function deleteAnnouncement(id, user) {
  let result;
  db.transaction(() => {
    const a = Announcement.findById(id);
    if (!a) { result = fail('找不到這則通知', 404); return; }
    if (Announcement.stateOf(a) === 'active') { result = fail('這則通知還在顯示，請先撤回再刪除'); return; }
    db.prepare('DELETE FROM announcements WHERE id = ?').run(a.id);
    AuditLog.record(user, 'announcement.delete', { type: 'announcement', id: a.id, label: a.message.slice(0, 60), detail: `發出時間 ${a.created_at}` });
    result = { ok: true };
  })();
  return result;
}

module.exports = {
  batchDeleteBlocker, deleteBatch, removeAssetFromBatch, archiveBatch, unarchiveBatch,
  assetUsage, assetDeleteBlocker, deleteAsset, deleteAssets,
  userWorkRecords, userDeleteBlocker, deleteUser, deleteAnnouncement,
};
