const fs = require('fs');

const replacements = [
  {
    file: 'src/app/tables/TablesManager.tsx',
    isClient: true,
    texts: [
      { from: '>No tables yet<', to: '>{t("tables.empty")}<' }
    ]
  },
  {
    file: 'src/app/schedules/SchedulesManager.tsx',
    isClient: true,
    texts: [
      { from: '>No schedules yet.<', to: '>{t("schedules.empty")}<' }
    ]
  },
  {
    file: 'src/app/reports/page.tsx',
    isClient: false,
    texts: [
      { from: '>No reports yet<', to: '>{t(locale, "reports.empty")}<' },
      { from: ">No reports yet — let's land your data first<", to: '>{t(locale, "reports.empty.land")}<' }
    ]
  },
  {
    file: 'src/app/operate/watchers/WatchersManager.tsx',
    isClient: true,
    texts: [
      { from: '>No watchers yet. Create one above.<', to: '>{t("watchers.empty")}<' },
      { from: '>No watcher fires yet.<', to: '>{t("watchers.fires.empty")}<' }
    ]
  },
  {
    file: 'src/app/data/quality/QualityManager.tsx',
    isClient: true,
    texts: [
      { from: '>No data quality checks yet<', to: '>{t("quality.empty")}<' }
    ]
  },
  {
    file: 'src/app/connections/DataSourcesManager.tsx',
    isClient: true,
    texts: [
      { from: '>No connections yet.<', to: '>{t("connections.empty")}<' }
    ]
  },
  {
    file: 'src/app/admin/users/UsersManager.tsx',
    isClient: true,
    texts: [
      { from: '>No users yet.<', to: '>{t("admin.users.empty")}<' }
    ]
  },
  {
    file: 'src/app/admin/roles/RolesManager.tsx',
    isClient: true,
    texts: [
      { from: '>No roles yet. Add one above.<', to: '>{t("admin.roles.empty")}<' }
    ]
  },
  {
    file: 'src/app/admin/webhooks/WebhooksManager.tsx',
    isClient: true,
    texts: [
      { from: '>No deliveries yet — Test a webhook above to fire one.<', to: '>{t("admin.webhooks.empty")}<' }
    ]
  },
  {
    file: 'src/app/admin/api-keys/ApiKeysManager.tsx',
    isClient: true,
    texts: [
      { from: '>No API keys yet.<', to: '>{t("admin.apikeys.empty")}<' }
    ]
  },
  {
    file: 'src/app/admin/activations/ActivationsManager.tsx',
    isClient: true,
    texts: [
      { from: '>No runs recorded yet.<', to: '>{t("admin.activations.empty")}<' }
    ]
  },
  {
    file: 'src/app/admin/connections/page.tsx',
    isClient: false,
    texts: [
      { from: '>No connections configured<', to: '>{t(locale, "admin.connections.empty")}<' }
    ]
  },
  {
    file: 'src/app/admin/connections/[id]/syncs/SyncsManager.tsx',
    isClient: true,
    texts: [
      { from: '>No syncs configured<', to: '>{t("admin.syncs.empty")}<' }
    ]
  },
  {
    file: 'src/app/admin/external-tables/ExternalTablesClient.tsx',
    isClient: true,
    texts: [
      { from: '>No external tables yet.<', to: '>{t("admin.external.empty")}<' }
    ]
  },
  {
    file: 'src/app/dashboards/KioskTokenPanel.tsx',
    isClient: true,
    texts: [
      { from: '>No active tokens yet.<', to: '>{t("dashboards.tokens.empty")}<' }
    ]
  },
  {
    file: 'src/app/dashboards/DashboardsManager.tsx',
    isClient: true,
    texts: [
      { from: '>No roles defined yet — add some at /admin/roles first.<', to: '>{t("dashboards.roles.empty")}<' }
    ]
  }
];

function injectUseT(text) {
  if (!text.includes('useT')) {
    if (text.includes('from "lucide-react"')) {
      text = text.replace(/import \{.*?\} from "lucide-react";/, match => match + '\\nimport { useT } from "@/lib/i18n/LocaleContext";');
    } else {
      text = text.replace('"use client";', '"use client";\\nimport { useT } from "@/lib/i18n/LocaleContext";');
    }
  }
  
  if (!text.includes('const { t } = useT()') && !text.includes('const { t, locale } = useT()')) {
    text = text.replace(/(export function \\w+\\([^)]*\\)\\s*\\{)/, match => match + '\\n  const { t } = useT();');
  }
  return text;
}

function injectServerT(text) {
  if (!text.includes('cookies } from "next/headers"')) {
    if (text.includes('from "lucide-react"')) {
      text = text.replace(/import \{.*?\} from "lucide-react";/, match => match + '\\nimport { cookies } from "next/headers";\\nimport { t, LOCALES, type Locale } from "@/lib/i18n/dict";');
    } else {
      text = text.replace('import Link from "next/link";', 'import Link from "next/link";\\nimport { cookies } from "next/headers";\\nimport { t, LOCALES, type Locale } from "@/lib/i18n/dict";');
    }
  }
  if (!text.includes('const ck = cookies().get(')) {
    text = text.replace(/(export default async function \\w+\\([^)]*\\)\\s*\\{[\\s\\S]*?if \\(!user\\)[^\n]*\n)/, match => match + '\\n  const ck = cookies().get("rd_locale")?.value;\\n  const locale = (LOCALES as readonly string[]).includes(ck as any) ? (ck as Locale) : "en";\\n');
  }
  return text;
}

for (const task of replacements) {
  try {
    let text = fs.readFileSync(task.file, 'utf8');
    let original = text;
    for (const rep of task.texts) {
      text = text.replace(rep.from, rep.to);
    }
    if (text !== original) {
      if (task.isClient) {
        text = injectUseT(text);
      } else {
        text = injectServerT(text);
      }
      fs.writeFileSync(task.file, text);
      console.log('Updated', task.file);
    } else {
      console.log('No changes needed for', task.file);
    }
  } catch (e) {
    console.error('Failed on', task.file, e.message);
  }
}
