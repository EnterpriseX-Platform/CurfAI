/**
 * The "what are you connecting?" step of Add connection. Pure: groups the connector kinds by what a person has in hand
 * (a file, a database, a warehouse, an app) rather than by driver name. The chooser only picks the form's kind, so the
 * checks stay where they were: the form's own fields, the tier lock and the server-side SSRF / read-only / secrets rules.
 */
import type { PickerKind } from "./types";

export type KindChoice = { kind: PickerKind; labelKey: string; hintKey: string };
export type KindGroup = { id: string; titleKey: string; choices: KindChoice[] };

const GROUPS: { id: string; choices: { kind: PickerKind; label: string }[] }[] = [
  { id: "file", choices: [{ kind: "excel", label: "excel" }, { kind: "sqlite", label: "sqlite" }, { kind: "sftp", label: "sftp" }] },
  { id: "database", choices: [{ kind: "postgres", label: "postgres" }, { kind: "mysql", label: "mysql" }] },
  { id: "warehouse", choices: [{ kind: "snowflake", label: "snowflake" }, { kind: "bigquery", label: "bigquery" }] },
  { id: "app", choices: [{ kind: "rest", label: "rest" }, { kind: "hubspot", label: "hubspot" }, { kind: "zendesk", label: "zendesk" }] },
  { id: "engine", choices: [{ kind: "engine", label: "engine" }] },
];

/**
 * `available` says which kinds this form may offer (its allowed kinds, and whether a preset's connector is built in);
 * a group with nothing to offer is left out.
 */
export function kindGroups(available: (kind: PickerKind) => boolean): KindGroup[] {
  return GROUPS.map((g) => ({
    id: g.id,
    titleKey: `connectionForm.choose.group.${g.id}`,
    choices: g.choices
      .filter((c) => available(c.kind))
      .map((c) => ({ kind: c.kind, labelKey: `connectionForm.choose.${c.label}`, hintKey: `connectionForm.choose.${c.label}.hint` })),
  })).filter((g) => g.choices.length > 0);
}
