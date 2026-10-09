// 資產標籤：一台設備可以貼多個標籤（例如 ERP、財務部、重要），用來跨類別、跨位置地分組與篩選。
// 只新增兩張表，不動既有資料。標籤名稱不分大小寫唯一；沒有任何設備在用的標籤會在儲存設備時自動清掉。
module.exports = async function migrate_0016_asset_tags(db) {
  db.exec(`
    CREATE TABLE asset_tags (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE asset_tag_links (
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      tag_id   INTEGER NOT NULL REFERENCES asset_tags(id),
      PRIMARY KEY (asset_id, tag_id)
    );
    CREATE INDEX idx_asset_tag_links_tag ON asset_tag_links(tag_id);
  `);
};
