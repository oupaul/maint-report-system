// 稽核紀錄（audit_log）：刪除、封存這類「事後想查是誰做的」的動作。
// 呼叫端可以放在刪除的同一個交易裡（寫不進去就整個一起取消，不會有「刪了卻沒紀錄」）。
const db = require('./db');
const { nowTaipei, formatTaipei } = require('../utils/time');

const RETENTION_DAYS = 180;

const ACTIONS = {
  'batch.delete': '刪除巡檢批次',
  'batch.remove_asset': '批次移出設備',
  'batch.archive': '封存批次',
  'batch.unarchive': '還原封存批次',
  'asset.delete': '刪除設備',
  'user.delete': '刪除使用者',
  'announcement.delete': '刪除系統通知',
  'customer.delete': '刪除客戶',
  'group.delete': '刪除權限群組',
  'category.delete': '刪除設備類型',
  'checklist_item.delete': '刪除檢查項目',
  'field.delete': '刪除自訂欄位',
  'approval_stage.delete': '刪除簽核關卡',
  'backup.delete': '刪除備份檔',
};

const AuditLog = {
  RETENTION_DAYS, ACTIONS,

  // user：req.user（取 id 與 username 快照）；label：被處理對象的名稱（當下快照）；detail：補充說明（純文字）
  record(user, action, { type = null, id = null, label = null, detail = null } = {}) {
    db.prepare(
      `INSERT INTO audit_log (at, user_id, username, action, target_type, target_id, target_label, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(nowTaipei(), user ? user.id : null, user ? user.username : null, action, type, id, label ? String(label).slice(0, 200) : null, detail ? String(detail).slice(0, 500) : null);
  },

  list({ days = 30, action = '', limit = 300 } = {}) {
    const since = formatTaipei(Date.now() - days * 86400000);
    const where = ['at >= ?'];
    const args = [since];
    if (action && ACTIONS[action]) { where.push('action = ?'); args.push(action); }
    return db.prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, limit);
  },

  prune() {
    return db.prepare('DELETE FROM audit_log WHERE at < ?').run(formatTaipei(Date.now() - RETENTION_DAYS * 86400000)).changes;
  },
};

module.exports = AuditLog;
