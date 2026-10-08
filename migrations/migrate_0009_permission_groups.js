// 權限群組：管理員可以建立群組、勾選該群組擁有的功能權限，再把使用者歸屬到群組。
// 刻意不改 users 資料表的既有結構（它被很多表引用，重建風險高），只新增兩張表和一個欄位：
// users.role 仍然是 admin / technician（admin 擁有全部權限），group_id 只用來替技術人員額外授權。
// 權限用「列」存（group_id + permission key），key 的合法值在應用程式端（utils/permissions.js）
// 驗證，不下 CHECK 約束，之後新增權限不需要再改資料表。
module.exports = async function migrate_0009_permission_groups(db) {
  db.exec(`
    CREATE TABLE permission_groups (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE permission_group_perms (
      group_id   INTEGER NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      PRIMARY KEY (group_id, permission)
    );

    ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES permission_groups(id);
  `);

  // 預先建立一個「設備管理員」群組（只有管理設備類型的權限），讓管理員直接把人加進去就能用；
  // 不需要的話可以在「權限群組」頁修改或刪除。
  const result = db.prepare('INSERT INTO permission_groups (name, description) VALUES (?, ?)')
    .run('設備管理員', '可以管理設備類型與各類型的檢查項目');
  db.prepare('INSERT INTO permission_group_perms (group_id, permission) VALUES (?, ?)')
    .run(result.lastInsertRowid, 'categories.manage');
};
