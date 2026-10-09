// 「容量型」檢查項目：一個項目底下可以有多個磁碟區（C:、D:…），每個磁碟區記錄已用／總容量（GB），
// 才能跨次巡檢畫出容量成長趨勢、預估多久會滿。只新增欄位與資料表，不動既有資料：
// - checklist_items.input_kind：'text'（原本的狀態＋數值文字，預設）或 'capacity'（容量型）；
//   warn_pct / crit_pct：容量型項目的使用率「建議警告／建議異常」門檻（只是建議，填寫的人仍可自己改狀態）。
// - inspection_item_volumes：每個檢查紀錄的磁碟區；容量一律存成 GB。
// 原本內建的「磁碟空間」項目（code = disk_space）預設改成容量型，舊的文字數值保留顯示（value_text 不動）。
module.exports = async function migrate_0018_capacity_volumes(db) {
  db.exec(`
    ALTER TABLE checklist_items ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'text';
    ALTER TABLE checklist_items ADD COLUMN warn_pct INTEGER;
    ALTER TABLE checklist_items ADD COLUMN crit_pct INTEGER;

    CREATE TABLE inspection_item_volumes (
      id                 INTEGER PRIMARY KEY,
      inspection_item_id INTEGER NOT NULL REFERENCES inspection_items(id),
      name               TEXT NOT NULL,
      used_gb            REAL NOT NULL,
      total_gb           REAL NOT NULL,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      UNIQUE (inspection_item_id, name)
    );
    CREATE INDEX idx_item_volumes_item ON inspection_item_volumes(inspection_item_id);
  `);

  const r = db.prepare(
    "UPDATE checklist_items SET input_kind = 'capacity', warn_pct = 85, crit_pct = 95 WHERE code = 'disk_space'"
  ).run();
  console.log(`  ${r.changes} 個「磁碟空間」檢查項目已設為容量型（使用率 85% 建議警告、95% 建議異常）`);
};
