// 報價請求：指定「通知哪個權限群組」（quote_settings.notify_group_id）。
// 原本是「有 quotes.receive 權限的群組成員，都沒有就改通知所有管理員」，管理員會在沒有業務時被默默通知；
// 改成只通知指定群組的成員（不再自動退回管理員）。這個欄位為 NULL 時＝通知所有有 quotes.receive 權限的群組成員。
// 既有安裝：預設指定 migration 0019 建立的「業務」群組（如果還在）。
module.exports = async function migrate_0020_quote_notify_group(db) {
  db.exec('ALTER TABLE quote_settings ADD COLUMN notify_group_id INTEGER');
  const g = db.prepare("SELECT g.id FROM permission_groups g JOIN permission_group_perms p ON p.group_id = g.id AND p.permission = 'quotes.receive' WHERE g.name = '業務'").get();
  if (g) db.prepare('UPDATE quote_settings SET notify_group_id = ? WHERE id = 1').run(g.id);
};
