// 系統裡「可以授權給群組」的功能權限清單。管理員（role = admin）永遠擁有全部權限，不需要也不能
// 靠群組取得；技術人員預設沒有任何額外權限，由管理員把他加進某個權限群組才會取得該群組勾選的權限。
// 新增權限只要在這裡加一筆，群組管理頁就會自動列出；key 一旦寫進資料庫就不要改名。
const PERMISSIONS = [
  { key: 'categories.manage', label: '管理設備類型與資產欄位', description: '新增、改名、排序、停用設備類型，管理各類型的檢查項目，以及自訂資產欄位' },
  { key: 'quotes.receive', label: '接收與處理報價請求', description: '會收到工程師送出的報價請求通知，可以接手、填報價單號與金額、結案，並看到全部的報價請求與統計（「業務」群組用）' },
  { key: 'assets.manage', label: '管理資產建檔', description: '新增、編輯資產（設備）資料，包含位置、標籤與自訂欄位的值（和上面「管理設備類型與資產欄位」是分開的權限，要讓成員能新增、編輯設備請勾這一項）' },
];

const PERMISSION_KEYS = PERMISSIONS.map(p => p.key);

function isValidPermission(key) {
  return PERMISSION_KEYS.includes(key);
}

// user 是 req.user（app.js 每個請求都會依資料庫即時算好 permissions 這個 Set）
function can(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.permissions instanceof Set && user.permissions.has(permission);
}

module.exports = { PERMISSIONS, PERMISSION_KEYS, isValidPermission, can };
