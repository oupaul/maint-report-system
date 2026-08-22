// 巡檢項目改為支援多張截圖：新增 inspection_item_photos（一對多），
// 把既有 inspection_items.screenshot_* 單張截圖資料搬過去，再移除舊欄位。

module.exports = async function migrate_0002_multi_photos(db) {
  db.exec(`
    CREATE TABLE inspection_item_photos (
      id INTEGER PRIMARY KEY,
      inspection_item_id INTEGER NOT NULL REFERENCES inspection_items(id),
      path TEXT NOT NULL,
      format TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_inspection_item_photos_item_id ON inspection_item_photos(inspection_item_id);

    INSERT INTO inspection_item_photos (inspection_item_id, path, format, width, height)
    SELECT id, screenshot_path, screenshot_format, screenshot_width, screenshot_height
    FROM inspection_items
    WHERE screenshot_path IS NOT NULL;

    ALTER TABLE inspection_items DROP COLUMN screenshot_path;
    ALTER TABLE inspection_items DROP COLUMN screenshot_format;
    ALTER TABLE inspection_items DROP COLUMN screenshot_width;
    ALTER TABLE inspection_items DROP COLUMN screenshot_height;
  `);
};
