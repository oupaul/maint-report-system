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
