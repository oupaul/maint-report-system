// 客戶加「統一編號」（選填、8 碼數字、有填的不可重複）。既有客戶升級後都是 NULL。
module.exports = async function migrate_0023_customer_tax_id(db) {
  db.exec(`
    ALTER TABLE customers ADD COLUMN tax_id TEXT;
    CREATE UNIQUE INDEX idx_customers_tax_id ON customers(tax_id) WHERE tax_id IS NOT NULL;
  `);
};
