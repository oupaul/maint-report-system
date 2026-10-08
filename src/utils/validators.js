// 設備類型（與各類型的檢查項目）已改由管理員在「系統管理 → 設備類型」自訂，存在資料庫的
// asset_categories / checklist_items，不再寫死在這裡（見 models/AssetCategory.js）。
const ITEM_STATUSES = ['normal', 'warning', 'critical'];
const USER_ROLES = ['admin', 'technician'];
const SIGNATURE_ROLES = ['engineer', 'supervisor'];
const SIGNATURE_ROLE_LABELS = {
  engineer: '工程師',
  supervisor: '主管',
};

function isValidStatus(status) {
  return ITEM_STATUSES.includes(status);
}

function isValidRole(role) {
  return USER_ROLES.includes(role);
}

function isValidSignatureRole(role) {
  return SIGNATURE_ROLES.includes(role);
}

module.exports = {
  ITEM_STATUSES,
  USER_ROLES,
  SIGNATURE_ROLES,
  SIGNATURE_ROLE_LABELS,
  isValidStatus,
  isValidRole,
  isValidSignatureRole,
};
