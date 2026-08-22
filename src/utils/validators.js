const ASSET_CATEGORIES = ['pc', 'server', 'nas', 'network_device'];
const ASSET_CATEGORY_LABELS = {
  pc: 'PC',
  server: 'Server',
  nas: 'NAS',
  network_device: '網路設備',
};
const ITEM_STATUSES = ['normal', 'warning', 'critical'];
const USER_ROLES = ['admin', 'technician'];

function isValidCategory(category) {
  return ASSET_CATEGORIES.includes(category);
}

function isValidStatus(status) {
  return ITEM_STATUSES.includes(status);
}

function isValidRole(role) {
  return USER_ROLES.includes(role);
}

module.exports = {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  ITEM_STATUSES,
  USER_ROLES,
  isValidCategory,
  isValidStatus,
  isValidRole,
};
