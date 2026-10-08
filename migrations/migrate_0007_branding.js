// 自訂瀏覽器分頁圖示（favicon）：圖示存在資料庫裡（轉好的 PNG 各尺寸），不是放在檔案系統，
// 這樣備份（含資料庫）一定帶得走，還原後圖示也跟著回來。單一列，沒有自訂圖示時各欄位為 NULL，
// 系統使用內建的預設圖示。
module.exports = async function migrate_0007_branding(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS branding (
      id            INTEGER PRIMARY KEY,
      icon_32       BLOB,
      icon_180      BLOB,
      icon_256      BLOB,
      original_name TEXT,
      updated_at    TEXT
    );
    INSERT OR IGNORE INTO branding (id) VALUES (1);
  `);
};
