const fs = require('fs');

const files = [
  { f: 'src/app/tables/TablesManager.tsx', isClient: true },
  { f: 'src/app/schedules/SchedulesManager.tsx', isClient: true },
  { f: 'src/app/reports/page.tsx', isClient: false },
  { f: 'src/app/operate/watchers/WatchersManager.tsx', isClient: true },
  { f: 'src/app/data/quality/QualityManager.tsx', isClient: true },
  { f: 'src/app/connections/DataSourcesManager.tsx', isClient: true },
  { f: 'src/app/admin/users/UsersManager.tsx', isClient: true },
  { f: 'src/app/admin/roles/RolesManager.tsx', isClient: true },
  { f: 'src/app/admin/webhooks/WebhooksManager.tsx', isClient: true },
  { f: 'src/app/admin/api-keys/ApiKeysManager.tsx', isClient: true },
  { f: 'src/app/admin/activations/ActivationsManager.tsx', isClient: true },
  { f: 'src/app/admin/connections/page.tsx', isClient: false },
  { f: 'src/app/admin/connections/[id]/syncs/SyncsManager.tsx', isClient: true },
  { f: 'src/app/admin/external-tables/ExternalTablesClient.tsx', isClient: true },
  { f: 'src/app/dashboards/KioskTokenPanel.tsx', isClient: true },
  { f: 'src/app/dashboards/DashboardsManager.tsx', isClient: true }
];

for (const {f, isClient} of files) {
  let text = fs.readFileSync(f, 'utf8');
  let original = text;

  if (isClient) {
    if (!text.includes('import { useT } from "@/lib/i18n/LocaleContext";')) {
      text = text.replace(/"use client";?\\n?/, '"use client";\\nimport { useT } from "@/lib/i18n/LocaleContext";\\n');
    }
    if (!text.includes('const { t } = useT()') && !text.includes('const { t, locale } = useT()')) {
      // Find first export function or export default function
      text = text.replace(/(export (?:default )?function [^{]+\\{)/, match => match + '\\n  const { t } = useT();');
    }
  } else {
    // Server
    if (!text.includes('cookies } from "next/headers"')) {
      if (text.includes('import Link from "next/link";')) {
          text = text.replace('import Link from "next/link";', 'import Link from "next/link";\\nimport { cookies } from "next/headers";\\nimport { t, LOCALES, type Locale } from "@/lib/i18n/dict";');
      } else {
          text = text.replace(/(import \{.*?\} from "lucide-react";)/, match => match + '\\nimport { cookies } from "next/headers";\\nimport { t, LOCALES, type Locale } from "@/lib/i18n/dict";');
      }
    }
    if (!text.includes('const ck = cookies().get(')) {
      text = text.replace(/(export default async function [^{]+\\{)/, match => match + '\\n  const ck = cookies().get("rd_locale")?.value;\\n  const locale = (LOCALES as readonly string[]).includes(ck as any) ? (ck as Locale) : "en";\\n');
    }
  }

  if (text !== original) {
    fs.writeFileSync(f, text);
    console.log('Fixed', f);
  }
}
