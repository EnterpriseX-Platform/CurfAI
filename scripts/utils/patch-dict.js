const fs = require('fs');
let content = fs.readFileSync('src/lib/i18n/dict.ts', 'utf-8');

const keys = {
  en: {
    'tables.empty': 'No tables yet',
    'schedules.empty': 'No schedules yet.',
    'reports.empty': 'No reports yet',
    'reports.empty.land': "No reports yet — let's land your data first",
    'watchers.empty': 'No watchers yet. Create one above.',
    'watchers.fires.empty': 'No watcher fires yet.',
    'quality.empty': 'No data quality checks yet',
    'connections.empty': 'No connections yet.',
    'admin.users.empty': 'No users yet.',
    'admin.roles.empty': 'No roles yet. Add one above.',
    'admin.webhooks.empty': 'No deliveries yet — Test a webhook above to fire one.',
    'admin.apikeys.empty': 'No API keys yet.',
    'admin.activations.empty': 'No runs recorded yet.',
    'admin.connections.empty': 'No connections configured',
    'admin.syncs.empty': 'No syncs configured',
    'admin.external.empty': 'No external tables yet.',
    'dashboards.tokens.empty': 'No active tokens yet.',
    'dashboards.roles.empty': 'No roles defined yet — add some at /admin/roles first.'
  },
  th: {
    'tables.empty': 'ยังไม่มีตาราง',
    'schedules.empty': 'ยังไม่มีกำหนดการ',
    'reports.empty': 'ยังไม่มีรายงาน',
    'reports.empty.land': 'ยังไม่มีรายงาน — นำเข้าข้อมูลของคุณก่อน',
    'watchers.empty': 'ยังไม่มี Watcher สร้างได้ที่ด้านบน',
    'watchers.fires.empty': 'ยังไม่มีประวัติการทำงานของ Watcher',
    'quality.empty': 'ยังไม่มีการตรวจสอบคุณภาพข้อมูล',
    'connections.empty': 'ยังไม่มีการเชื่อมต่อ',
    'admin.users.empty': 'ยังไม่มีผู้ใช้',
    'admin.roles.empty': 'ยังไม่มีบทบาท เพิ่มได้ที่ด้านบน',
    'admin.webhooks.empty': 'ยังไม่มีการส่งข้อมูล — ทดสอบ Webhook ด้านบนเพื่อทดลองส่ง',
    'admin.apikeys.empty': 'ยังไม่มี API Key',
    'admin.activations.empty': 'ยังไม่มีประวัติการรัน',
    'admin.connections.empty': 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ',
    'admin.syncs.empty': 'ยังไม่ได้ตั้งค่าการซิงค์',
    'admin.external.empty': 'ยังไม่มีตารางภายนอก',
    'dashboards.tokens.empty': 'ยังไม่มี Token ที่ใช้งานอยู่',
    'dashboards.roles.empty': 'ยังไม่มีการกำหนดบทบาท — เพิ่มได้ที่ /admin/roles'
  },
  zh: {
    'tables.empty': '暂无表格',
    'schedules.empty': '暂无计划任务。',
    'reports.empty': '暂无报表',
    'reports.empty.land': '暂无报表 — 请先导入数据',
    'watchers.empty': '暂无监控。在上方创建一个。',
    'watchers.fires.empty': '暂无监控触发记录。',
    'quality.empty': '暂无数据质量检查',
    'connections.empty': '暂无连接。',
    'admin.users.empty': '暂无用户。',
    'admin.roles.empty': '暂无角色。在上方添加。',
    'admin.webhooks.empty': '暂无发送记录 — 在上方测试 Webhook 进行发送。',
    'admin.apikeys.empty': '暂无 API 密钥。',
    'admin.activations.empty': '暂无运行记录。',
    'admin.connections.empty': '未配置连接',
    'admin.syncs.empty': '未配置同步',
    'admin.external.empty': '暂无外部表格。',
    'dashboards.tokens.empty': '暂无活动的 Token。',
    'dashboards.roles.empty': '尚未定义角色 — 请先在 /admin/roles 添加。'
  }
};

function insertKeys(text, lang) {
  const marker = "const " + lang + ": Dictionary = {";
  const blockStart = text.indexOf(marker);
  if (blockStart === -1) { console.error('not found ' + lang); return text; }
  const blockEnd = text.indexOf('};', blockStart);
  if (blockEnd === -1) { console.error('not found end ' + lang); return text; }
  
  const insertStr = '\\n' + Object.entries(keys[lang]).map(([k, v]) => `  "${k}": "${v.replace(/"/g, '\\"')}",`).join('\\n') + '\\n';
  
  return text.slice(0, blockEnd) + insertStr + text.slice(blockEnd);
}

content = insertKeys(content, 'en');
content = insertKeys(content, 'th');
content = insertKeys(content, 'zh');

fs.writeFileSync('src/lib/i18n/dict.ts', content);
console.log('done updating dict.ts');
