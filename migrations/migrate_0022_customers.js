// 客戶：設備歸屬哪一家客戶（巡檢批次可以同時涵蓋多家客戶的設備，批次的客戶由它涵蓋的設備決定，不另外存）。
// - customers：客戶主檔（名稱不分大小寫唯一、簡稱／代碼、備註、可停用）；用過（有設備）的只能停用不能刪除。
// - assets.customer_id：設備所屬客戶；NULL＝未指定客戶（既有設備升級後都是 NULL，用「批次設定客戶」或 CSV 匯入補）。
// 位置（assets.location）維持原樣，當作客戶底下的據點。
module.exports = async function migrate_0022_customers(db) {
  db.exec(`
    CREATE TABLE customers (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      code       TEXT,
      notes      TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    ALTER TABLE assets ADD COLUMN customer_id INTEGER REFERENCES customers(id);
    CREATE INDEX idx_assets_customer ON assets(customer_id);
  `);
};
