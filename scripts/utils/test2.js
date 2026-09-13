const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(process.cwd(), 'lake', 'cmq99qd5p0000u4fu8zueguqa.db');
const db = new Database(dbPath);
console.log(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name));
