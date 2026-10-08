// 設備類型與檢查項目改成管理員可自訂：
// 1. 新增 asset_categories（類型代碼、顯示名稱、排序、是否啟用），把原本寫死的四個類型用「相同的代碼」
//    搬進來，所以既有資產、檢查紀錄、PDF 全部不受影響。代碼建立後不可改，只能改顯示名稱。
// 2. assets.category / checklist_items.category 原本有 CHECK(category IN (四個固定值))，SQLite 無法直接
//    修改 CHECK，只能重建資料表；改成外鍵指向 asset_categories(code)，由資料庫保證類型一定存在。
// 3. checklist_items 增加 is_active：用過的項目只能「停用」不能刪除，停用後新增填寫時不再出現，
//    舊資料與舊報告照常顯示。
// 4. inspection_items 增加 item_label：記錄當下把檢查項目名稱存一份快照，之後管理員改名不會回頭改掉
//    已經寫好的報告。
//
// 重建資料表要關閉外鍵檢查（見 runner.js 的 disableForeignKeys），並在 COMMIT 前用
// PRAGMA foreign_key_check 驗證沒有破壞任何關聯；runner 在升級前也已自動留一份資料庫快照。

const BUILTIN_CATEGORIES = [
  // code, label, sort_order
  ['pc', 'PC', 1],
  ['server', 'Server', 2],
  ['nas', 'NAS', 3],
  ['network_device', '網路設備', 4],
];

module.exports = async function migrate_0008_asset_categories(db) {
  db.exec(`
    CREATE TABLE asset_categories (
      id         INTEGER PRIMARY KEY,
      code       TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insertCat = db.prepare('INSERT INTO asset_categories (code, label, sort_order) VALUES (?, ?, ?)');
  for (const row of BUILTIN_CATEGORIES) insertCat.run(...row);

  // 既有資料裡如果出現不在內建清單的代碼（理論上不會，因為舊的 CHECK 擋著），也補一筆，
  // 避免新的外鍵讓整個 migration 失敗。
  const known = new Set(BUILTIN_CATEGORIES.map(r => r[0]));
  const extra = db.prepare(
    `SELECT category FROM assets UNION SELECT category FROM checklist_items`
  ).all().map(r => r.category).filter(c => !known.has(c));
  let order = BUILTIN_CATEGORIES.length;
  for (const code of extra) insertCat.run(code, code, ++order);

  db.exec(`
    CREATE TABLE assets_new (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL REFERENCES asset_categories(code),
      location TEXT,
      identifier TEXT,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO assets_new (id, name, category, location, identifier, notes, is_active, created_at)
      SELECT id, name, category, location, identifier, notes, is_active, created_at FROM assets;
    DROP TABLE assets;
    ALTER TABLE assets_new RENAME TO assets;

    CREATE TABLE checklist_items_new (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL REFERENCES asset_categories(code),
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(category, code)
    );
    INSERT INTO checklist_items_new (id, category, code, label, sort_order, is_active)
      SELECT id, category, code, label, sort_order, 1 FROM checklist_items;
    DROP TABLE checklist_items;
    ALTER TABLE checklist_items_new RENAME TO checklist_items;

    ALTER TABLE inspection_items ADD COLUMN item_label TEXT;
    UPDATE inspection_items SET item_label = (
      SELECT label FROM checklist_items WHERE checklist_items.id = inspection_items.checklist_item_id
    );
  `);

  const violations = db.pragma('foreign_key_check');
  if (violations.length > 0) {
    throw new Error(`重建資料表後發現 ${violations.length} 筆外鍵不一致（例如 ${JSON.stringify(violations[0])}），已還原`);
  }
};
module.exports.disableForeignKeys = true;
