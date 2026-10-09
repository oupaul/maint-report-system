// 修正：migration 0009 預先建立的「設備管理員」群組只有「管理設備類型」權限，後來才新增「管理資產建檔」權限，
// 所以把人加進這個群組後，他們還是不能新增／編輯資產。
// 只修「還是出廠預設」的那個群組（名稱為「設備管理員」、權限剛好只有 categories.manage、說明文字沒被改過）：
// 補上 assets.manage 並更新說明。管理員自己改過的群組一律不動。
module.exports = async function migrate_0015_group_assets_permission(db) {
  const group = db.prepare("SELECT id, description FROM permission_groups WHERE name = '設備管理員'").get();
  if (!group) return;
  const perms = db.prepare('SELECT permission FROM permission_group_perms WHERE group_id = ?').all(group.id).map(p => p.permission);
  if (perms.length !== 1 || perms[0] !== 'categories.manage') return;
  if (group.description !== '可以管理設備類型與各類型的檢查項目') return;
  db.prepare('INSERT OR IGNORE INTO permission_group_perms (group_id, permission) VALUES (?, ?)').run(group.id, 'assets.manage');
  db.prepare('UPDATE permission_groups SET description = ? WHERE id = ?').run('可以管理設備類型、檢查項目與資產建檔', group.id);
  console.log('  已替預設的「設備管理員」群組補上「管理資產建檔」權限');
};
