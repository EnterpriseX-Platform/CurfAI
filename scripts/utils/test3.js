const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const dbs = fs.readdirSync('lake').filter(f => f.endsWith('.db'));
for (const f of dbs) {
  try {
    const db = new Database(path.join('lake', f));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (tables.some(t => t.name === 'student_behavior')) {
      console.log('FOUND in', f);
    }
  } catch (e) {}
}
