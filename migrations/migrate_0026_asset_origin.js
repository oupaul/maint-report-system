// 記錄設備是「在哪次巡檢、由誰」新增的（建立批次或填寫頁的「快速新增設備」）：
// 這樣在巡檢中新增、又發現加錯的設備，可以在移出批次時一併刪除（沒有其他用途時），
// 新增的人本人也能移除自己加的設備。既有設備與從資產管理新增的設備這兩欄都是 NULL（行為不變）。
// 沒有外鍵：批次或使用者被刪除時不會被這兩欄擋住。
module.exports = async function migrate_0026_asset_origin(db) {
  db.exec(`
    ALTER TABLE assets ADD COLUMN created_in_batch_id INTEGER;
    ALTER TABLE assets ADD COLUMN created_by INTEGER;
  `);
};
