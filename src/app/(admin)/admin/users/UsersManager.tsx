"use client";
import { useT } from "@/lib/i18n/LocaleContext";

import { useState } from "react";
import { Check, Loader2, UserPlus, Copy, Mail, MailX, Hourglass, RefreshCw, Trash2 } from "lucide-react";
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
type LastInvite = {
  email: string;
  emailStatus: "sent" | "skipped" | "failed";
  acceptUrl: string | null;
  expiresAt: string;
};

export function UsersManager({ initialUsers, allRoles }: { initialUsers: User[]; allRoles: Role[] }) {
  const { t } = useT();
  const { push } = useToast();
  const [users, setUsers] = useState(initialUsers);
  const [roleOptions, setRoleOptions] = useState<{ slug: string; label: string }[]>(allRoles);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "developer" | "executive" | "admin">("developer");
  const [inviting, setInviting] = useState(false);
  const [lastInvite, setLastInvite] = useState<LastInvite | null>(null);

  // Per-row pending-invite action state.
  const [resending, setResending] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  function toggle(userId: string, slug: string) {
    setUsers((xs) => xs.map((u) => {
      if (u.id !== userId) return u;
      const has = u.roles.includes(slug);
      return { ...u, roles: has ? u.roles.filter((r) => r !== slug) : [...u.roles, slug] };
    }));
  }

  async function save(userId: string) {
    const user = users.find((u) => u.id === userId);
    if (!user) return;
    setSaving(userId);
    try {
      const res = await fetch("/api/admin/users/" + userId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: user.roles }),
      });
      if (res.ok) {
        setSaved(userId);
        setTimeout(() => setSaved((s) => s === userId ? null : s), 1200);
      }
    } finally {
      setSaving(null);
    }
  }

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

  return (
    <div className="grid gap-6">
      {/* Invite form */}
      <section className="rounded-lg border bg-card p-5 shadow-xs">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                    <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[11px]">
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
      <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">{t("admin.usersManager.colUser")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("admin.usersManager.authRoleLabel")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("admin.usersManager.colCustomRoles")}</th>
              <th className="w-44" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t align-top">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{u.name ?? u.email}</span>
                    {u.pendingInvite && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                        <Hourglass className="h-3 w-3" /> {t("operate.status.pending")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </td>
                <td className="px-4 py-3 text-xs uppercase tracking-wide">{u.authRole}</td>
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
                    <Button
                      size="sm"
                      variant={saved === u.id ? "outline" : "default"}
                      onClick={() => save(u.id)}
                      disabled={saving === u.id}
                    >
                      {saving === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> :
                       saved === u.id ? <><Check className="mr-1.5 h-3.5 w-3.5" /> {t("admin.usersManager.saved")}</> :
                       t("action.save")}
                    </Button>
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
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={4} className="p-10 text-center text-xs text-muted-foreground">{t("admin.users.empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
