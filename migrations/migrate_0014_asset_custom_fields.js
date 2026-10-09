// 管理員自訂的資產欄位（/admin/fields）：只新增兩張表，不動既有資料。
// - asset_field_defs：欄位定義（名稱、資料類型 text/number/date/select/boolean、下拉選項、適用類別、是否顯示在列表、排序、是否啟用）。
//   資料類型沒加 CHECK（驗證在程式裡），日後要增加類型不用重建資料表。
// - asset_field_values：每台設備每個欄位一筆值（只存有填的；清空就刪掉那一筆）。值一律以文字存，
//   型別在寫入時驗證（number／date／boolean 的標準格式見 models/AssetField.js）。
// 用過的欄位（有任何值）只能停用、不能刪除，所以資料與報告不會因為欄位被拿掉而壞掉。
// options、category_codes 是 JSON 陣列文字；category_codes 為 NULL 代表適用所有類別。
module.exports = async function migrate_0014_asset_custom_fields(db) {
  db.exec(`
    CREATE TABLE asset_field_defs (
      id             INTEGER PRIMARY KEY,
      label          TEXT NOT NULL,
      type           TEXT NOT NULL,
      options        TEXT,
      category_codes TEXT,
      show_in_list   INTEGER NOT NULL DEFAULT 0,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      is_active      INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL
    );
    CREATE TABLE asset_field_values (
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      field_id INTEGER NOT NULL REFERENCES asset_field_defs(id),
      value    TEXT NOT NULL,
      PRIMARY KEY (asset_id, field_id)
    );
    CREATE INDEX idx_asset_field_values_field ON asset_field_values(field_id);
  `);
};
