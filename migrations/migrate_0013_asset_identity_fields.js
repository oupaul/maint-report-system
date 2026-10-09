// 資產的「識別碼」拆成獨立欄位：IP 位址、MAC 位址、主機名稱、序號、財產編號，另加廠牌、型號、購置日期（全部選填），
// 方便篩選、重複檢查與日後匯入匯出。purchase_date 存 YYYY-MM-DD 字串。
// - 只新增欄位，不重建資料表、不刪除舊的 identifier 欄位。
// - 舊資料：identifier 的內容如果「整個都是 IP 位址」（IPv4／IPv6，可多個，以逗號／空白／分號分隔），
//   才自動搬到 ip_address 並清空 identifier；其他內容（序號？財產編號？混合？）不猜，原樣留在 identifier，
//   編輯頁會顯示成「舊識別碼（待整理）」，由管理員整理完再清空。
const net = require('net');

module.exports = async function migrate_0013_asset_identity_fields(db) {
  db.exec(`
    ALTER TABLE assets ADD COLUMN ip_address TEXT;
    ALTER TABLE assets ADD COLUMN hostname TEXT;
    ALTER TABLE assets ADD COLUMN serial_number TEXT;
    ALTER TABLE assets ADD COLUMN asset_tag TEXT;
    ALTER TABLE assets ADD COLUMN mac_address TEXT;
    ALTER TABLE assets ADD COLUMN brand TEXT;
    ALTER TABLE assets ADD COLUMN model TEXT;
    ALTER TABLE assets ADD COLUMN purchase_date TEXT;
  `);

  const rows = db.prepare("SELECT id, identifier FROM assets WHERE identifier IS NOT NULL AND TRIM(identifier) <> ''").all();
  const move = db.prepare('UPDATE assets SET ip_address = ?, identifier = NULL WHERE id = ?');
  let moved = 0;
  for (const row of rows) {
    const tokens = row.identifier.split(/[\s,;，；]+/).filter(Boolean);
    if (tokens.length > 0 && tokens.every(t => net.isIP(t) !== 0)) {
      move.run(tokens.join(', '), row.id);
      moved++;
    }
  }
  console.log(`  資產識別碼：${rows.length} 筆舊資料中，${moved} 筆是純 IP 已自動搬到「IP 位址」，${rows.length - moved} 筆留在「舊識別碼（待整理）」`);
};
