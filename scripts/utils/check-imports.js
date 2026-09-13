const fs = require('fs');
const files = [
  'src/app/tables/TablesManager.tsx',
  'src/app/schedules/SchedulesManager.tsx',
  'src/app/operate/watchers/WatchersManager.tsx',
  'src/app/data/quality/QualityManager.tsx',
  'src/app/connections/DataSourcesManager.tsx',
  'src/app/admin/users/UsersManager.tsx',
  'src/app/admin/roles/RolesManager.tsx',
  'src/app/admin/webhooks/WebhooksManager.tsx',
  'src/app/admin/api-keys/ApiKeysManager.tsx',
  'src/app/admin/activations/ActivationsManager.tsx',
  'src/app/admin/connections/[id]/syncs/SyncsManager.tsx',
  'src/app/admin/external-tables/ExternalTablesClient.tsx',
  'src/app/dashboards/KioskTokenPanel.tsx',
  'src/app/dashboards/DashboardsManager.tsx'
];
for(const f of files) {
  let text = fs.readFileSync(f, 'utf8');
  if (!text.includes('import { useT }')) {
    text = text.replace(/"use client";\n?/, '"use client";\nimport { useT } from "@/lib/i18n/LocaleContext";\n');
    fs.writeFileSync(f, text);
    console.log('Fixed import in', f);
  }
}
