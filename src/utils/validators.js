const ASSET_CATEGORIES = ['pc', 'server', 'nas', 'network_device'];
const ASSET_CATEGORY_LABELS = {
  pc: 'PC',
  server: 'Server',
  nas: 'NAS',
  network_device: '網路設備',
};
const ITEM_STATUSES = ['normal', 'warning', 'critical'];
const USER_ROLES = ['admin', 'technician'];
const SIGNATURE_ROLES = ['engineer', 'supervisor'];
const SIGNATURE_ROLE_LABELS = {
  engineer: '工程師',
  supervisor: '主管',
};

function isValidCategory(category) {
  return ASSET_CATEGORIES.includes(category);
}

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
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  ITEM_STATUSES,
  USER_ROLES,
  SIGNATURE_ROLES,
  SIGNATURE_ROLE_LABELS,
  isValidCategory,
  isValidStatus,
  isValidRole,
  isValidSignatureRole,
};
