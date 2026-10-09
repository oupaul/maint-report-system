const db = require('./db');
const { PERMISSION_KEYS, isValidPermission } = require('../utils/permissions');

const MAX_NAME = 30;
const MAX_DESC = 200;

function validateName(name, excludeId = null) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return '請輸入群組名稱';
  if (text.length > MAX_NAME) return `群組名稱不能超過 ${MAX_NAME} 個字`;
  if (/[\u0000-\u001f<>]/.test(text)) return '群組名稱含有不允許的字元';
  const dup = db.prepare('SELECT id FROM permission_groups WHERE lower(name) = lower(?)').get(text);
  if (dup && dup.id !== excludeId) return '已經有同名的群組';
  return null;
}

function cleanPermissions(input) {
  const list = Array.isArray(input) ? input : (input ? [input] : []);
  return [...new Set(list.filter(isValidPermission))];
}

const PermissionGroup = {
  MAX_NAME,
  MAX_DESC,
  validateName,

  findAll() {
    const groups = db.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS member_count
       FROM permission_groups g ORDER BY g.id ASC`
    ).all();
    const perms = db.prepare('SELECT group_id, permission FROM permission_group_perms').all();
    return groups.map(g => ({
      ...g,
      permissions: perms.filter(p => p.group_id === g.id).map(p => p.permission),
    }));
  },

  findById(id) {
    const group = db.prepare('SELECT * FROM permission_groups WHERE id = ?').get(id);
    if (!group) return null;
    group.permissions = db.prepare('SELECT permission FROM permission_group_perms WHERE group_id = ?')
      .all(id).map(p => p.permission);
    return group;
  },

  members(id) {
    return db.prepare('SELECT id, username, display_name, role, is_active FROM users WHERE group_id = ? ORDER BY username ASC').all(id);
  },

  // 可以加進群組的人：啟用中的技術人員，不含已經在這個群組的人（管理員永遠擁有全部權限，不需要靠群組）。
  // current_group_name 讓畫面提醒「加入後會從原本的群組移出」（一個人同時只屬於一個群組）
  candidates(groupId) {
    return db.prepare(
      `SELECT u.id, u.username, u.display_name, g.name AS current_group_name
       FROM users u LEFT JOIN permission_groups g ON g.id = u.group_id
       WHERE u.is_active = 1 AND u.role <> 'admin' AND (u.group_id IS NULL OR u.group_id <> ?)
       ORDER BY u.username ASC`
    ).all(groupId);
  },

  // 加入成員；回傳實際加入的人數（不合格的 id 會被略過：不存在、已停用、管理員）
  addMembers(groupId, userIds) {
    const ids = [...new Set(userIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    const eligible = new Set(PermissionGroup.candidates(groupId).map(u => u.id));
    const upd = db.prepare('UPDATE users SET group_id = ? WHERE id = ?');
    let added = 0;
    db.transaction(() => {
      for (const id of ids) {
        if (eligible.has(id)) { upd.run(groupId, id); added++; }
      }
    })();
    return added;
  },

  // 移出成員（只會動「目前真的屬於這個群組」的人）
  removeMember(groupId, userId) {
    return db.prepare('UPDATE users SET group_id = NULL WHERE id = ? AND group_id = ?').run(userId, groupId).changes > 0;
  },

  create({ name, description, permissions }) {
    const tx = db.transaction(() => {
      const result = db.prepare('INSERT INTO permission_groups (name, description) VALUES (?, ?)')
        .run(name.trim(), (description || '').trim().slice(0, MAX_DESC) || null);
      PermissionGroup.setPermissions(result.lastInsertRowid, permissions);
      return result.lastInsertRowid;
    });
    return PermissionGroup.findById(tx());
  },

  update(id, { name, description, permissions }) {
    const tx = db.transaction(() => {
      db.prepare('UPDATE permission_groups SET name = ?, description = ? WHERE id = ?')
        .run(name.trim(), (description || '').trim().slice(0, MAX_DESC) || null, id);
      PermissionGroup.setPermissions(id, permissions);
    });
    tx();
  },

  setPermissions(id, permissions) {
    db.prepare('DELETE FROM permission_group_perms WHERE group_id = ?').run(id);
    const ins = db.prepare('INSERT INTO permission_group_perms (group_id, permission) VALUES (?, ?)');
    for (const p of cleanPermissions(permissions)) ins.run(id, p);
  },

  // 還有成員的群組不能刪除（刪了成員會默默失去權限，要先把人移到別的群組）
  remove(id) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE group_id = ?').get(id).n;
    if (count > 0) return false;
    db.prepare('DELETE FROM permission_groups WHERE id = ?').run(id);
    return true;
  },

  // 這個使用者目前實際擁有的權限（每個請求都從資料庫重新算，所以管理員調整群組後立刻生效）。
  // user 需要有 role 與 group_id；管理員 = 全部權限。
  permissionsForUser(user) {
    if (!user) return new Set();
    if (user.role === 'admin') return new Set(PERMISSION_KEYS);
    if (!user.group_id) return new Set();
    return new Set(
      db.prepare('SELECT permission FROM permission_group_perms WHERE group_id = ?')
        .all(user.group_id).map(p => p.permission).filter(isValidPermission)
    );
  },
};

module.exports = PermissionGroup;
