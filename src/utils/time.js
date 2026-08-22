// SQLite 的 datetime('now') 回傳的是 UTC，Node.js 的 dayjs()/new Date() 顯示
// 出來的「現在時間」則跟著伺服器作業系統本身的時區設定走——很多雲端主機（含
// 這個系統實際部署的 Ubuntu 主機）預設時區是 UTC，不是 Asia/Taipei，導致系統
// 裡的時間戳記全部慢了 8 小時。
//
// 台灣全年不實施日光節約時間，UTC+8 是固定不變的偏移量，不需要處理夏令時間、
// 也不需要完整的 IANA 時區資料庫，直接用 Date.now()（規範保證回傳 UTC 毫秒數，
// 不受伺服器時區設定影響）加 8 小時换算即可，不用額外引入時區相關套件。
function nowTaipei() {
  const taipeiMs = Date.now() + 8 * 60 * 60 * 1000;
  return new Date(taipeiMs).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { nowTaipei };
