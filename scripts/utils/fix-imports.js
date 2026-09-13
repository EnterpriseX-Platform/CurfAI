const fs = require('fs');
const files = [
  'src/app/schedules/SchedulesManager.tsx',
  'src/app/connections/DataSourcesManager.tsx',
  'src/app/admin/users/UsersManager.tsx',
  'src/app/admin/api-keys/ApiKeysManager.tsx',
  'src/app/admin/connections/[id]/syncs/SyncsManager.tsx',
  'src/app/dashboards/KioskTokenPanel.tsx',
  'src/app/dashboards/DashboardsManager.tsx'
];
for(const f of files) {
  let text = fs.readFileSync(f, 'utf8');
  if (!text.includes('import { useT } from')) {
    text = text.replace(/"use client";\n?/, '"use client";\nimport { useT } from "@/lib/i18n/LocaleContext";\n');
    fs.writeFileSync(f, text);
    console.log('Fixed import in', f);
  }
}
