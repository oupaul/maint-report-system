const db = require('../models/db');
const Notification = require('../models/Notification');
const MailService = require('./MailService');
const { nowTaipei } = require('../utils/time');

// 巡檢批次的簽核流程（比照 expense-platform）：
//   草稿 → 送出審核（鎖定） → 依序通過各關卡 → 最後一關核准 = 已核准（status 設為 completed）
//   任何一關「退回」或送審的人「撤回」→ 回到可編輯狀態（approval_status = returned），修改後重新送出（新的一輪 round）
//   管理員可以對已核准的批次「重新開啟」（需填原因，留紀錄）
// 沒有啟用簽核流程、或舊資料（approval_status = none）完全維持原本的行為。
//
// 每次送審都會把當時的關卡設定「快照」進 approval_records，之後管理員改關卡設定
// 不會影響審核中與歷史紀錄。

const MAX_STAGE_LABEL = 30;
const MAX_COMMENT = 500;

const display = (u) => (u && (u.display_name || u.username)) || '（未知）';
const isAdmin = (u) => !!u && u.role === 'admin';

// ---------- 設定 ----------

function getSettings() {
  return db.prepare('SELECT * FROM approval_settings WHERE id = 1').get();
}

function isEnabled() {
  return !!getSettings().enabled;
}

function updateSettings({ enabled, block_self_approval }) {
  db.prepare('UPDATE approval_settings SET enabled = ?, block_self_approval = ? WHERE id = 1')
    .run(enabled ? 1 : 0, block_self_approval ? 1 : 0);
}

// ---------- 關卡設定 ----------

function listStages({ includeInactive = false } = {}) {
  return db.prepare(
    `SELECT s.*, g.name AS group_name FROM approval_stages s
     LEFT JOIN permission_groups g ON g.id = s.group_id
     ${includeInactive ? '' : 'WHERE s.is_active = 1'}
     ORDER BY s.stage_order ASC, s.id ASC`
  ).all();
}

function findStage(id) {
  return db.prepare('SELECT * FROM approval_stages WHERE id = ?').get(id);
}

function validateStageLabel(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text) return '請輸入關卡名稱';
  if (text.length > MAX_STAGE_LABEL) return `關卡名稱不能超過 ${MAX_STAGE_LABEL} 個字`;
  if (/[\u0000-\u001f<>]/.test(text)) return '關卡名稱含有不允許的字元';
  return null;
}

function createStage(label, groupId) {
  const next = db.prepare('SELECT COALESCE(MAX(stage_order), 0) + 1 AS n FROM approval_stages').get().n;
  const r = db.prepare('INSERT INTO approval_stages (stage_order, label, group_id) VALUES (?, ?, ?)')
    .run(next, label.trim(), groupId || null);
  return findStage(r.lastInsertRowid);
}

function updateStage(id, { label, groupId }) {
  db.prepare('UPDATE approval_stages SET label = ?, group_id = ? WHERE id = ?').run(label.trim(), groupId || null, id);
}

function setStageActive(id, active) {
  db.prepare('UPDATE approval_stages SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

function moveStage(id, direction) {
  const list = listStages({ includeInactive: true });
  const i = list.findIndex(s => s.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return false;
  const ids = list.map(s => s.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const upd = db.prepare('UPDATE approval_stages SET stage_order = ? WHERE id = ?');
  db.transaction(() => ids.forEach((sid, idx) => upd.run(idx + 1, sid)))();
  return true;
}

function stageUsed(id) {
  return !!db.prepare('SELECT 1 FROM approval_records WHERE stage_id = ? LIMIT 1').get(id);
}

// 用過（有任何審核紀錄參照）的關卡只能停用
function removeStage(id) {
  if (stageUsed(id)) return false;
  db.prepare('DELETE FROM approval_stages WHERE id = ?').run(id);
  return true;
}

function groupInUse(groupId) {
  return !!db.prepare('SELECT 1 FROM approval_stages WHERE group_id = ? LIMIT 1').get(groupId);
}

// ---------- 狀態查詢 ----------

// 審核中與已核准的批次都鎖定、不能編輯（被退回／撤回、或沒走簽核的才可以改）
function isLocked(batch) {
  return batch.approval_status === 'pending' || batch.approval_status === 'approved';
}

function latestRound(batchId) {
  return db.prepare('SELECT COALESCE(MAX(round), 0) AS r FROM approval_records WHERE batch_id = ?').get(batchId).r;
}

function recordsOf(batchId, round) {
  return db.prepare(
    `SELECT r.*, u.display_name AS approver_name, u.username AS approver_username
     FROM approval_records r LEFT JOIN users u ON u.id = r.approver_id
     WHERE r.batch_id = ? AND r.round = ? ORDER BY r.stage_order ASC`
  ).all(batchId, round);
}

// 審核中的批次「現在輪到的那一關」
function currentRecord(batch) {
  if (batch.approval_status !== 'pending') return null;
  return db.prepare(
    `SELECT * FROM approval_records WHERE batch_id = ? AND round = ? AND status = 'waiting'
     ORDER BY stage_order ASC LIMIT 1`
  ).get(batch.id, latestRound(batch.id)) || null;
}

// 這一關有資格簽核的人：指定群組的啟用中成員；沒有指定群組，或群組已經沒有任何可用成員時，改由所有管理員負責
// （這樣流程不會因為設定上的疏漏就卡死）。若設定了「不能簽核自己送的單」，送審的人不算。
function approversOf(record, batch) {
  let users = [];
  if (record.group_id) {
    users = db.prepare('SELECT * FROM users WHERE group_id = ? AND is_active = 1').all(record.group_id);
  }
  if (users.length === 0) users = db.prepare("SELECT * FROM users WHERE role = 'admin' AND is_active = 1").all();
  if (getSettings().block_self_approval && batch.submitted_by) users = users.filter(u => u.id !== batch.submitted_by);
  return users;
}

function canAct(user, batch, record) {
  if (!user || !record || batch.approval_status !== 'pending') return false;
  if (getSettings().block_self_approval && batch.submitted_by === user.id) return false;
  if (isAdmin(user)) return true;
  return !!record.group_id && user.group_id === record.group_id;
}

function canSubmit(batch) {
  return isEnabled() && batch.status === 'draft' && (batch.approval_status === 'none' || batch.approval_status === 'returned');
}

function canWithdraw(user, batch) {
  return batch.approval_status === 'pending' && !!user && (user.id === batch.submitted_by || isAdmin(user));
}

function canReopen(user, batch) {
  return batch.approval_status === 'approved' && isAdmin(user);
}

// 目前有哪些審核中的批次輪到這個使用者簽核（儀表板「待我簽核」用）
function pendingFor(user) {
  const batches = db.prepare("SELECT * FROM inspection_batches WHERE approval_status = 'pending' ORDER BY submitted_at ASC").all();
  const out = [];
  for (const b of batches) {
    const record = currentRecord(b);
    if (record && canAct(user, b, record)) out.push({ batch: b, record });
  }
  return out;
}

// 畫面上的狀態文字
function statusInfo(batch) {
  switch (batch.approval_status) {
    case 'pending': {
      const rec = currentRecord(batch);
      return { text: rec ? `審核中（${rec.stage_label}）` : '審核中', tone: 'warning' };
    }
    case 'approved': return { text: '已核准', tone: 'normal' };
    case 'returned': return { text: '已退回，待修改', tone: 'critical' };
    default: return { text: batch.status === 'completed' ? '已完成' : '草稿', tone: batch.status === 'completed' ? 'normal' : 'draft' };
  }
}

// 時間軸：把事件與關卡紀錄依時間排好（最新一輪的待簽核關卡放最後）
function history(batch) {
  const events = db.prepare(
    `SELECT e.*, u.display_name AS user_name, u.username AS user_username
     FROM approval_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.batch_id = ?`
  ).all(batch.id);
  const records = db.prepare(
    `SELECT r.*, u.display_name AS approver_name, u.username AS approver_username
     FROM approval_records r LEFT JOIN users u ON u.id = r.approver_id WHERE r.batch_id = ?`
  ).all(batch.id);
  const latest = latestRound(batch.id);

  const entries = [];
  const EVENT_TEXT = { submitted: '送出審核', withdrawn: '撤回審核', reopened: '重新開啟' };
  for (const e of events) {
    entries.push({
      at: e.created_at, prio: e.kind === 'submitted' ? 0 : 2, round: e.round, kind: e.kind,
      text: EVENT_TEXT[e.kind] || e.kind, who: display({ display_name: e.user_name, username: e.user_username }), comment: e.comment,
    });
  }
  for (const r of records) {
    if (r.status === 'approved' || r.status === 'returned') {
      const who = display({ display_name: r.approver_name, username: r.approver_username });
      entries.push({
        at: r.acted_at, prio: 1, round: r.round, kind: r.status,
        text: `「${r.stage_label}」${r.status === 'approved' ? '核准' : '退回'}${r.acted_as_admin ? '（管理員代為處理）' : ''}`,
        who, comment: r.comment,
      });
    }
  }
  // 先依輪次（每次送審算一輪）、再依時間排；同一秒內用 prio 排出「送出 → 各關卡 → 撤回/重新開啟」的先後
  entries.sort((a, b) => (a.round - b.round) || (a.at < b.at ? -1 : a.at > b.at ? 1 : a.prio - b.prio));
  if (batch.approval_status === 'pending') {
    for (const r of records.filter(x => x.round === latest && x.status === 'waiting').sort((a, b) => a.stage_order - b.stage_order)) {
      entries.push({ at: null, prio: 3, round: r.round, kind: 'waiting', text: `「${r.stage_label}」待簽核`, who: null, comment: null });
    }
  }
  return entries;
}

// 被退回／撤回／重新開啟的批次，回到填寫頁時要讓人看到「為什麼、要改什麼」
function lastReturnNote(batch) {
  if (batch.approval_status !== 'returned') return null;
  const list = history(batch).filter(e => ['returned', 'withdrawn', 'reopened'].includes(e.kind));
  return list.length ? list[list.length - 1] : null;
}

// 「已核准」報告用：最後一輪各關卡的結果
function approvalSummary(batch) {
  const round = latestRound(batch.id);
  if (round === 0) return null;
  const records = recordsOf(batch.id, round).filter(r => r.status === 'approved' || r.status === 'returned' || r.status === 'waiting');
  const submitter = batch.submitted_by ? db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(batch.submitted_by) : null;
  return { records, submittedBy: submitter ? display(submitter) : null, submittedAt: batch.submitted_at, status: batch.approval_status };
}

// ---------- 動作 ----------

function notifyAll(users, batch, { type, title, message }) {
  for (const u of users) {
    const id = Notification.create(u.id, { batchId: batch.id, type, title, message });
    MailService.queueNotificationEmail(id); // 站內通知先寫好，Email 在交易提交後背景寄出
  }
}

function fresh(batchId) {
  return db.prepare('SELECT * FROM inspection_batches WHERE id = ?').get(batchId);
}

function cleanComment(comment) {
  return (typeof comment === 'string' ? comment.trim() : '').slice(0, MAX_COMMENT);
}

function submit(batchId, user, comment) {
  let result;
  db.transaction(() => {
    const batch = fresh(batchId);
    if (!batch) { result = { ok: false, error: '找不到批次' }; return; }
    if (!isEnabled()) { result = { ok: false, error: '尚未啟用簽核流程' }; return; }
    if (!canSubmit(batch)) { result = { ok: false, error: '這個批次目前不能送出審核（可能已在審核中或已核准）' }; return; }
    const count = db.prepare('SELECT COUNT(*) AS n FROM inspection_items WHERE batch_id = ?').get(batch.id).n;
    if (count === 0) { result = { ok: false, error: '還沒有填寫任何檢查項目，無法送出審核' }; return; }
    const stages = listStages();
    if (stages.length === 0) { result = { ok: false, error: '尚未設定任何簽核關卡，請聯絡管理員' }; return; }

    const round = latestRound(batch.id) + 1;
    const now = nowTaipei();
    const ins = db.prepare(
      `INSERT INTO approval_records (batch_id, round, stage_id, stage_order, stage_label, group_id) VALUES (?, ?, ?, ?, ?, ?)`
    );
    stages.forEach((s, i) => ins.run(batch.id, round, s.id, i + 1, s.label, s.group_id));
    db.prepare("UPDATE inspection_batches SET approval_status = 'pending', submitted_by = ?, submitted_at = ? WHERE id = ?")
      .run(user.id, now, batch.id);
    db.prepare('INSERT INTO approval_events (batch_id, round, kind, user_id, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(batch.id, round, 'submitted', user.id, cleanComment(comment) || null, now);

    const after = fresh(batch.id);
    const first = currentRecord(after);
    notifyAll(approversOf(first, after), after, {
      type: 'submitted',
      title: `待簽核：${batch.title}`,
      message: `${display(user)} 送出了巡檢批次「${batch.title}」（${batch.batch_date}），目前在「${first.stage_label}」關卡，請登入系統查看並簽核。`,
    });
    result = { ok: true };
  })();
  return result;
}

function decide(batchId, user, action, comment) {
  let result;
  db.transaction(() => {
    const batch = fresh(batchId);
    if (!batch) { result = { ok: false, error: '找不到批次' }; return; }
    const record = currentRecord(batch);
    if (!record) { result = { ok: false, error: '這個批次目前不在審核中' }; return; }
    if (!canAct(user, batch, record)) {
      const self = getSettings().block_self_approval && batch.submitted_by === user.id;
      result = { ok: false, error: self ? '不能簽核自己送出的批次，請由其他人處理' : '您不是這個關卡的簽核人', status: 403 };
      return;
    }
    const text = cleanComment(comment);
    if (action === 'return' && !text) { result = { ok: false, error: '退回時請填寫意見，讓送審的人知道要修改什麼' }; return; }

    const now = nowTaipei();
    const actedAsAdmin = isAdmin(user) && !(record.group_id && user.group_id === record.group_id) && record.group_id ? 1 : 0;
    db.prepare(
      `UPDATE approval_records SET status = ?, approver_id = ?, comment = ?, acted_at = ?, acted_as_admin = ? WHERE id = ?`
    ).run(action === 'approve' ? 'approved' : 'returned', user.id, text || null, now, actedAsAdmin, record.id);

    const submitter = batch.submitted_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(batch.submitted_by) : null;

    if (action === 'return') {
      db.prepare("UPDATE approval_records SET status = 'skipped' WHERE batch_id = ? AND round = ? AND status = 'waiting'")
        .run(batch.id, record.round);
      db.prepare("UPDATE inspection_batches SET approval_status = 'returned', status = 'draft', completed_at = NULL WHERE id = ?").run(batch.id);
      if (submitter && submitter.id !== user.id) {
        notifyAll([submitter], batch, {
          type: 'returned',
          title: `已退回：${batch.title}`,
          message: `「${record.stage_label}」關卡的 ${display(user)} 將巡檢批次「${batch.title}」退回修改。意見：${text}`,
        });
      }
      result = { ok: true, outcome: 'returned' };
      return;
    }

    const after = fresh(batch.id);
    const next = db.prepare(
      `SELECT * FROM approval_records WHERE batch_id = ? AND round = ? AND status = 'waiting' ORDER BY stage_order ASC LIMIT 1`
    ).get(batch.id, record.round);
    if (next) {
      notifyAll(approversOf(next, after), after, {
        type: 'submitted',
        title: `待簽核：${batch.title}`,
        message: `巡檢批次「${batch.title}」已通過「${record.stage_label}」（${display(user)}），現在輪到「${next.stage_label}」關卡，請登入系統查看並簽核。`,
      });
      result = { ok: true, outcome: 'next' };
      return;
    }
    db.prepare("UPDATE inspection_batches SET approval_status = 'approved', status = 'completed', completed_at = ? WHERE id = ?").run(now, batch.id);
    if (submitter && submitter.id !== user.id) {
      notifyAll([submitter], batch, {
        type: 'approved',
        title: `已核准：${batch.title}`,
        message: `巡檢批次「${batch.title}」已通過所有簽核關卡（最後由 ${display(user)} 核准），報告可以下載使用了。`,
      });
    }
    result = { ok: true, outcome: 'approved' };
  })();
  return result;
}

const approve = (batchId, user, comment) => decide(batchId, user, 'approve', comment);
const returnBatch = (batchId, user, comment) => decide(batchId, user, 'return', comment);

function withdraw(batchId, user) {
  let result;
  db.transaction(() => {
    const batch = fresh(batchId);
    if (!batch || !canWithdraw(user, batch)) { result = { ok: false, error: '只有送審的人或管理員可以撤回審核中的批次', status: 403 }; return; }
    const record = currentRecord(batch);
    const round = latestRound(batch.id);
    const now = nowTaipei();
    db.prepare("UPDATE approval_records SET status = 'skipped' WHERE batch_id = ? AND round = ? AND status = 'waiting'").run(batch.id, round);
    db.prepare("UPDATE inspection_batches SET approval_status = 'returned' WHERE id = ?").run(batch.id);
    db.prepare('INSERT INTO approval_events (batch_id, round, kind, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(batch.id, round, 'withdrawn', user.id, now);
    if (record) {
      notifyAll(approversOf(record, batch).filter(u => u.id !== user.id), batch, {
        type: 'withdrawn',
        title: `已撤回：${batch.title}`,
        message: `${display(user)} 撤回了巡檢批次「${batch.title}」的審核，不需要再處理了。`,
      });
    }
    result = { ok: true };
  })();
  return result;
}

function reopen(batchId, user, reason) {
  let result;
  db.transaction(() => {
    const batch = fresh(batchId);
    if (!batch || !canReopen(user, batch)) { result = { ok: false, error: '只有管理員可以重新開啟已核准的批次', status: 403 }; return; }
    const text = cleanComment(reason);
    if (!text) { result = { ok: false, error: '重新開啟時請填寫原因（會記錄在簽核紀錄裡）' }; return; }
    const now = nowTaipei();
    db.prepare("UPDATE inspection_batches SET approval_status = 'returned', status = 'draft', completed_at = NULL WHERE id = ?").run(batch.id);
    db.prepare('INSERT INTO approval_events (batch_id, round, kind, user_id, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(batch.id, latestRound(batch.id), 'reopened', user.id, text, now);
    const submitter = batch.submitted_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(batch.submitted_by) : null;
    if (submitter && submitter.id !== user.id) {
      notifyAll([submitter], batch, {
        type: 'reopened',
        title: `已重新開啟：${batch.title}`,
        message: `${display(user)} 重新開啟了已核准的巡檢批次「${batch.title}」，原因：${text}。修改後需要重新送出審核。`,
      });
    }
    result = { ok: true };
  })();
  return result;
}

module.exports = {
  MAX_STAGE_LABEL, MAX_COMMENT,
  getSettings, isEnabled, updateSettings,
  listStages, findStage, validateStageLabel, createStage, updateStage, setStageActive, moveStage, stageUsed, removeStage, groupInUse,
  isLocked, latestRound, recordsOf, currentRecord, approversOf, canAct, canSubmit, canWithdraw, canReopen,
  pendingFor, statusInfo, history, lastReturnNote, approvalSummary,
  submit, approve, returnBatch, withdraw, reopen,
};
