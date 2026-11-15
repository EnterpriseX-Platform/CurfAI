"use client";
import { useT } from "@/lib/i18n/LocaleContext";

import { useState } from "react";
import { Check, Loader2, UserPlus, Copy, Mail, MailX, Hourglass, RefreshCw, Trash2, UserMinus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/lib/toast";
import { InlineTagManager } from "@/components/common/InlineTagManager";

type User = {
  id: string;
  email: string;
  name: string | null;
  authRole: string;
  roles: string[];
  pendingInvite?: boolean;
};
type Role = { id: string; slug: string; label: string };
type Saved = { authRole: string; roles: string[] };

const AUTH_ROLES = [
  { value: "viewer", key: "admin.usersManager.roleViewer" },
  { value: "executive", key: "admin.usersManager.roleExecutive" },
  { value: "developer", key: "admin.usersManager.roleDeveloper" },
  { value: "admin", key: "admin.usersManager.roleAdmin" },
] as const;

function baselineOf(users: User[]): Record<string, Saved> {
  return Object.fromEntries(users.map((u) => [u.id, { authRole: u.authRole, roles: [...u.roles] }]));
}

function sameRoles(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((r) => b.includes(r));
}

type LastInvite = {
  email: string;
  emailStatus: "sent" | "skipped" | "failed";
  acceptUrl: string | null;
  expiresAt: string;
};

export function UsersManager({ initialUsers, allRoles, currentUserId }: { initialUsers: User[]; allRoles: Role[]; currentUserId: string }) {
  const { t } = useT();
  const { push } = useToast();
  const [users, setUsers] = useState(initialUsers);
  const [roleOptions, setRoleOptions] = useState<{ slug: string; label: string }[]>(allRoles);
  // What the server last confirmed for each member: an edit marks a row
  // dirty against this, and one bar saves every dirty row together.
  const [baseline, setBaseline] = useState<Record<string, Saved>>(() => baselineOf(initialUsers));
  const [savingAll, setSavingAll] = useState(false);
  const [query, setQuery] = useState("");

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "developer" | "executive" | "admin">("developer");
  const [inviting, setInviting] = useState(false);
  const [lastInvite, setLastInvite] = useState<LastInvite | null>(null);

  // Per-row pending-invite action state.
  const [resending, setResending] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  function toggle(userId: string, slug: string) {
    setUsers((xs) => xs.map((u) => {
      if (u.id !== userId) return u;
      const has = u.roles.includes(slug);
      return { ...u, roles: has ? u.roles.filter((r) => r !== slug) : [...u.roles, slug] };
    }));
  }

  function setAuthRole(userId: string, authRole: string) {
    setUsers((xs) => xs.map((u) => (u.id === userId ? { ...u, authRole } : u)));
  }

  const dirty = users.filter((u) => {
    const b = baseline[u.id];
    return b && (b.authRole !== u.authRole || !sameRoles(b.roles, u.roles));
  });

  function discard() {
    setUsers((xs) => xs.map((u) => (baseline[u.id] ? { ...u, ...baseline[u.id], roles: [...baseline[u.id].roles] } : u)));
  }

  // No bulk endpoint: each changed row goes to the same per-user endpoints
  // the row Save used (custom roles) and the auth-role endpoint, so the
  // server's checks and audit trail are unchanged. Rows that fail stay dirty.
  async function saveAll() {
    if (dirty.length === 0) return;
    setSavingAll(true);
    const failed: string[] = [];
    const confirmed: Record<string, Saved> = {};
    try {
      for (const u of dirty) {
        const b = baseline[u.id];
        const done: Saved = { ...b };
        try {
          if (b.authRole !== u.authRole) {
            const res = await fetch("/api/admin/users/" + u.id + "/role", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ authRole: u.authRole }),
            });
            if (!res.ok) throw new Error(String(res.status));
            done.authRole = u.authRole;
          }
          if (!sameRoles(b.roles, u.roles)) {
            const res = await fetch("/api/admin/users/" + u.id, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ roles: u.roles }),
            });
            if (!res.ok) throw new Error(String(res.status));
            done.roles = [...u.roles];
          }
        } catch {
          failed.push(u.email);
        }
        confirmed[u.id] = done;
      }
    } finally {
      setBaseline((cur) => ({ ...cur, ...confirmed }));
      setSavingAll(false);
    }
    const savedCount = dirty.length - failed.length;
    if (failed.length > 0) {
      push({ variant: "destructive", title: t("admin.usersManager.saveSomeFailed"), description: failed.join(", ") });
    } else if (savedCount > 0) {
      push({ variant: "success", title: t("admin.usersManager.savedCount").replace("{n}", String(savedCount)) });
    }
  }

  const q = query.trim().toLowerCase();
  const visible = q
    ? users.filter((u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    : users;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setLastInvite(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          name: inviteName.trim() || undefined,
          role: inviteRole,
        }),
      });
      if (!res.ok) {
        let msg = await res.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: t("admin.usersManager.inviteFailed"), description: msg });
        return;
      }
      const body = await res.json();
      setUsers((xs) => [...xs, {
        id: body.id, email: body.email, name: body.name, authRole: body.role, roles: [],
        pendingInvite: true,
      }]);
      setBaseline((cur) => ({ ...cur, [body.id]: { authRole: body.role, roles: [] } }));
      setLastInvite({
        email: body.email,
        emailStatus: body.emailStatus,
        acceptUrl: body.acceptUrl,
        expiresAt: body.expiresAt,
      });
      setInviteEmail("");
      setInviteName("");
      const tone = body.emailStatus === "sent" ? "success" : "info";
      push({
        variant: tone as any,
        title: body.emailStatus === "sent"
          ? t("admin.usersManager.inviteEmailedTo").replace("{email}", body.email)
          : t("admin.usersManager.inviteMintedFor").replace("{email}", body.email),
        description: body.emailStatus === "sent"
          ? t("admin.usersManager.acceptWindow")
          : t("admin.usersManager.copyAcceptLink"),
      });
    } finally {
      setInviting(false);
    }
  }

  function copyAcceptUrl() {
    if (!lastInvite?.acceptUrl) return;
    navigator.clipboard.writeText(lastInvite.acceptUrl).then(() => {
      push({ variant: "success", title: t("admin.usersManager.acceptUrlCopied") });
    });
  }

  async function resendInvite(userId: string) {
    setResending(userId);
    try {
      const res = await fetch("/api/admin/users/" + userId + "/resend-invite", { method: "POST" });
      if (!res.ok) {
        let msg = await res.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: t("admin.usersManager.resendFailed"), description: msg });
        return;
      }
      const body = await res.json();
      // Replace the lastInvite banner with the freshly minted token so admins
      // can re-grab the URL when SMTP is missing.
      setLastInvite({
        email: body.email,
        emailStatus: body.emailStatus,
        acceptUrl: body.acceptUrl,
        expiresAt: body.expiresAt,
      });
      const tone = body.emailStatus === "sent" ? "success" : "info";
      push({
        variant: tone as any,
        title: body.emailStatus === "sent"
          ? t("admin.usersManager.inviteReSentTo").replace("{email}", body.email)
          : t("admin.usersManager.freshInviteMinted").replace("{email}", body.email),
        description: body.emailStatus === "sent"
          ? t("admin.usersManager.acceptWindowOld")
          : t("admin.usersManager.copyAcceptLinkOld"),
      });
    } finally {
      setResending(null);
    }
  }

  async function revokeInvite(userId: string, email: string) {
    if (!window.confirm(t("admin.usersManager.confirmRevokeInvite").replace("{email}", email))) {
      return;
    }
    setRevoking(userId);
    try {
      const res = await fetch("/api/admin/users/" + userId, { method: "DELETE" });
      if (!res.ok) {
        let msg = await res.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: t("admin.usersManager.revokeFailed"), description: msg });
        return;
      }
      setUsers((xs) => xs.filter((u) => u.id !== userId));
      // Clear the lastInvite banner if it referenced this user.
      setLastInvite((li) => li?.email === email ? null : li);
      push({ variant: "success", title: t("admin.usersManager.inviteRevoked"), description: t("admin.usersManager.removedFromWorkspace").replace("{email}", email) });
    } finally {
      setRevoking(null);
    }
  }

  // Offboarding a member who has accepted — a separate endpoint from
  // revokeInvite, so that button can never remove an active member.
  async function removeMember(userId: string, email: string) {
    if (!window.confirm(t("admin.usersManager.confirmRemoveMember").replace("{email}", email))) {
      return;
    }
    setRemoving(userId);
    try {
      const res = await fetch("/api/admin/users/" + userId + "/membership", { method: "DELETE" });
      if (!res.ok) {
        let msg = await res.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: t("admin.usersManager.removeFailed"), description: msg });
        return;
      }
      setUsers((xs) => xs.filter((u) => u.id !== userId));
      // Their private items moved to this admin and their API keys were
      // revoked in the same step — say so, with the counts.
      const body = await res.json().catch(() => ({})) as { movedItems?: number; revokedKeys?: number };
      const handover = (body.movedItems || body.revokedKeys)
        ? " " + t("admin.usersManager.removedHandover").replace("{items}", String(body.movedItems ?? 0)).replace("{keys}", String(body.revokedKeys ?? 0))
        : "";
      push({ variant: "success", title: t("admin.usersManager.memberRemoved"), description: t("admin.usersManager.removedFromWorkspace").replace("{email}", email) + handover });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="grid gap-6">
      {/* Invite form */}
      <section className="rounded-lg border bg-card p-5 shadow-xs">
        <p className="mb-3 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("admin.usersManager.inviteHeading")}
        </p>
        <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[1fr_1fr_140px_auto]">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">{t("admin.usersManager.emailLabel")}</Label>
            <Input
              id="invite-email" type="email" required
              placeholder="teammate@company.com"
              value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-name">{t("admin.usersManager.nameOptionalLabel")}</Label>
            <Input id="invite-name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("admin.usersManager.authRoleLabel")}</Label>
            <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">{t("admin.usersManager.roleViewer")}</SelectItem>
                <SelectItem value="executive">{t("admin.usersManager.roleExecutive")}</SelectItem>
                <SelectItem value="developer">{t("admin.usersManager.roleDeveloper")}</SelectItem>
                <SelectItem value="admin">{t("admin.usersManager.roleAdmin")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button type="submit" size="sm" disabled={inviting || !inviteEmail}>
              {inviting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <UserPlus className="mr-1.5 h-4 w-4" />}
              {t("admin.waitlist.sendInvite")}
            </Button>
          </div>
        </form>

        {lastInvite && (
          <div className={
            "mt-3 rounded-md border p-3 text-xs " +
            (lastInvite.emailStatus === "sent"
              ? "border-success/40 bg-success/5"
              : "border-warning/40 bg-warning/5")
          }>
            {lastInvite.emailStatus === "sent" ? (
              <div className="flex items-start gap-2">
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <div>
                  <p className="font-medium text-success-foreground">
                    {t("admin.usersManager.inviteEmailedTo").replace("{email}", lastInvite.email)}
                  </p>
                  <p className="mt-0.5 text-muted-foreground">
                    {t("admin.usersManager.acceptDeadline").replace("{date}", new Date(lastInvite.expiresAt).toLocaleDateString())}
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-start gap-2">
                  <MailX className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <div>
                    <p className="font-medium text-warning">
                      {t("admin.usersManager.emailNotConfigured").replace("{email}", lastInvite.email)}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {t("admin.usersManager.smtpHintPrefix")} <code className="font-mono">SMTP_HOST</code>, <code className="font-mono">SMTP_USER</code>{t("admin.usersManager.smtpHintSuffix").replace("{date}", new Date(lastInvite.expiresAt).toLocaleDateString())}
                    </p>
                  </div>
                </div>
                {lastInvite.acceptUrl && (
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-2xs">
                      {lastInvite.acceptUrl}
                    </code>
                    <Button size="sm" variant="outline" onClick={copyAcceptUrl}>
                      <Copy className="mr-1.5 h-3.5 w-3.5" /> {t("admin.apps.copyLinkTitle")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Existing users */}
      <div>
        <div className="mb-3 flex items-center gap-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("admin.usersManager.searchPlaceholder")}
              aria-label={t("admin.usersManager.searchPlaceholder")}
              className="pl-8"
            />
          </div>
          {q && (
            <span className="font-mono text-xs text-faint">
              {t("admin.usersManager.searchCount").replace("{n}", String(visible.length)).replace("{total}", String(users.length))}
            </span>
          )}
        </div>
        <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.usersManager.colUser")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.usersManager.authRoleLabel")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("admin.usersManager.colCustomRoles")}</th>
                <th className="w-28" />
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => {
                const isDirty = dirty.some((d) => d.id === u.id);
                return (
                <tr key={u.id} className={"border-t align-top " + (isDirty ? "bg-primary-soft/40" : "")}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{u.name ?? u.email}</span>
                      {isDirty && (
                        <span className="inline-flex items-center rounded-full bg-primary-soft px-1.5 py-0.5 text-2xs font-medium text-primary-ink">
                          {t("admin.usersManager.edited")}
                        </span>
                      )}
                      {u.pendingInvite && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-2xs font-medium text-warning">
                          <Hourglass className="h-3 w-3" /> {t("operate.status.pending")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    {/* Your own role is changed by another admin, never from
                        your own row — saving it could lock you out of this page. */}
                    {u.id === currentUserId ? (
                      <span className="text-xs uppercase tracking-wide">{u.authRole}</span>
                    ) : (
                      <Select value={u.authRole} onValueChange={(v) => setAuthRole(u.id, v)} disabled={savingAll}>
                        <SelectTrigger className="h-8 w-36 text-xs" aria-label={t("admin.usersManager.authRoleLabel")}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AUTH_ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{t(r.key)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <InlineTagManager
                      options={roleOptions}
                      selected={u.roles}
                      onToggle={(slug) => toggle(u.id, slug)}
                      onOptionsChange={setRoleOptions}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {u.pendingInvite && (
                        <>
                          <Button
                            size="sm" variant="outline"
                            title={t("admin.usersManager.resendInviteTitle")}
                            onClick={() => resendInvite(u.id)}
                            disabled={resending === u.id || revoking === u.id}
                          >
                            {resending === u.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <RefreshCw className="h-3.5 w-3.5" />}
                          </Button>
                          <Button
                            size="sm" variant="outline"
                            title={t("admin.usersManager.revokeInviteTitle")}
                            className="text-destructive hover:bg-destructive/10"
                            onClick={() => revokeInvite(u.id, u.email)}
                            disabled={revoking === u.id || resending === u.id}
                          >
                            {revoking === u.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Trash2 className="h-3.5 w-3.5" />}
                          </Button>
                        </>
                      )}
                      {!u.pendingInvite && u.id !== currentUserId && (
                        <Button
                          size="sm" variant="outline"
                          title={t("admin.usersManager.removeMemberTitle")}
                          aria-label={t("admin.usersManager.removeMemberTitle")}
                          className="text-destructive hover:bg-destructive/10"
                          onClick={() => removeMember(u.id, u.email)}
                          disabled={removing === u.id}
                        >
                          {removing === u.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <UserMinus className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={4} className="p-10 text-center text-xs text-muted-foreground">{t("admin.users.empty")}</td></tr>
              )}
              {users.length > 0 && visible.length === 0 && (
                <tr><td colSpan={4} className="p-10 text-center text-xs text-muted-foreground">{t("admin.usersManager.noMatches").replace("{q}", query.trim())}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {/* One save for every edited row, pinned to the bottom of the list
            while anything is unsaved. */}
        {dirty.length > 0 && (
          <div className="sticky bottom-0 z-10 mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-md">
            <span className="text-sm text-muted-foreground">
              {t("admin.usersManager.unsavedCount").replace("{n}", String(dirty.length))}
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={discard} disabled={savingAll}>
                {t("admin.usersManager.discardChanges")}
              </Button>
              <Button size="sm" onClick={saveAll} disabled={savingAll}>
                {savingAll ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                {t("admin.usersManager.saveChanges").replace("{n}", String(dirty.length))}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
