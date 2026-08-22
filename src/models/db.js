const Database = require('better-sqlite3');
const fs = require('fs');
const config = require('../config');

fs.mkdirSync(config.DATA_DIR, { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
