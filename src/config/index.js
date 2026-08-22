const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[安全警告] SESSION_SECRET 未設定！本次使用臨時隨機金鑰，重啟後所有 session 將失效。正式部署請確認 deploy.sh 已設定此環境變數。');
}

module.exports = {
  PROJECT_ROOT,
  PORT,
  NODE_ENV,
  SESSION_SECRET: sessionSecret,
  DATA_DIR: path.join(PROJECT_ROOT, 'data'),
  DB_PATH: path.join(PROJECT_ROOT, 'data', 'maint_report.db'),
  UPLOADS_DIR: path.join(PROJECT_ROOT, 'uploads'),
};
