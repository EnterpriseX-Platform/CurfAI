"use client";
/**
 * Tenant LLM provider panel — picks the AI provider for this workspace.
 *
 * This is the ONLY UI surface in Curf that names specific providers
 * (Anthropic / OpenAI / Gemini / OpenAI-compatible). Every other product
 * surface refers to "the AI" generically. That separation is deliberate:
 * the workspace owner owns the provider choice once, and downstream UX
 * stays vendor-neutral.
 *
 * The cleartext key is never echoed back to the UI after save; we only
 * show a masked preview ("sk-…x123") and a status pill. The "show"
 * toggle only affects what the user just typed in the field — it can't
 * reveal a previously-saved key.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Key, CheckCircle2, AlertCircle, Eye, EyeOff, Trash2, Cpu, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";
import { eeClient } from "@/ee/client";
import { UpgradeLock } from "@/components/common/UpgradeLock";

type Driver = {
  id: "anthropic" | "openai" | "gemini" | "openai-compatible";
  label: string;
  defaultModel: string;
  credentialHint: string;
  consoleUrl: string | null;
  needsBaseUrl: boolean;
  baseUrlSuggestions: Array<{ label: string; url: string; defaultModel?: string }>;
};

type Status = {
  provider: Driver["id"];
  /** This workspace's plan — drives the upgrade locks below. */
  tier: string;
  /** Bringing your own key is Business and above on Cloud. */
  ownKeyAllowed: boolean;
  configured: boolean;
  masked: string | null;
  model: string | null;
  fastModel?: string | null;
  baseUrl: string | null;
  fallbackEnv: boolean;
  migrationNeeded?: boolean;
  legacyKeyPresent?: boolean;
  drivers: Driver[];
};

export function LlmProviderPanel() {
  const { push } = useToast();
  const { t } = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Form state
  const [provider, setProvider] = useState<Driver["id"]>("anthropic");
  const [keyInput, setKeyInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [model, setModel] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const [testingConnection, setTestingConnection] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);

  const driver = useMemo<Driver | null>(
    () => status?.drivers.find((d) => d.id === provider) ?? null,
    [status, provider],
  );

  // The tenant has exactly ONE stored provider config (Tenant.llmProvider +
  // llmKeyEnc, not a column per provider) — status.configured/masked always
  // describe that single active provider, never the one currently
  // highlighted in the picker below. Without this, clicking through the
  // tabs after saving (say) a Custom/OpenAI-compatible key showed the same
  // masked key and "Configured for this workspace" badge under Anthropic
  // and OpenAI too, with nothing distinguishing "this is what's active"
  // from "this is just the tab I'm looking at" — exactly what produced a
  // real "no AI provider connected" mid-session confusion even after a key
  // had genuinely been saved, just under a different tab.
  const viewingActiveProvider = status?.provider === provider;

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/tenant/llm");
      const j: Status = await r.json();
      setStatus(j);
      setProvider(j.provider);
      setModel(j.model ?? "");
      setFastModel(j.fastModel ?? "");
      setBaseUrl(j.baseUrl ?? "");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/admin/tenant/llm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          key: keyInput.trim() || undefined,
          model: model.trim() || null,
          fastModel: fastModel.trim() || null,
          baseUrl: baseUrl.trim() || null,
        }),
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep */ }
        push({ variant: "destructive", title: "Save failed", description: msg });
        return;
      }
      const j = await r.json();
      setStatus((s) => s ? { ...s, ...j } : s);
      setKeyInput("");
      push({ variant: "success", title: "LLM provider saved", description: "AI features will now use the configured provider." });
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!window.confirm("Remove the LLM credentials for this workspace? AI features will fall back to the platform-wide key (if any) or stop working.")) return;
    setRemoving(true);
    try {
      const r = await fetch("/api/admin/tenant/llm", { method: "DELETE" });
      if (!r.ok) {
        push({ variant: "destructive", title: "Remove failed" });
        return;
      }
      setStatus((s) => s ? { ...s, configured: false, masked: null, model: null, fastModel: null, baseUrl: null } : s);
      setFastModel("");
      push({ variant: "success", title: "LLM credentials removed" });
    } finally { setRemoving(false); }
  }

  async function testConnection() {
    setTestingConnection(true);
    try {
      const r = await fetch("/api/admin/tenant/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "testConnection",
          provider,
          key: keyInput.trim() || undefined,
          model: model.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        }),
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep */ }
        push({ variant: "destructive", title: "Connection failed", description: msg });
        return;
      }
      const j = await r.json();
      if (j.warning) {
        push({ variant: "destructive", title: "Connected, but may not work with Master Builder", description: j.warning });
      } else {
        push({ variant: "success", title: "Connection successful", description: "The provider accepted the credentials and produced valid structured JSON — the same mode Master Builder uses." });
      }
    } catch (e: any) {
      push({ variant: "destructive", title: "Error", description: e?.message ?? "Network error." });
    } finally {
      setTestingConnection(false);
    }
  }

  async function fetchModels() {
    setFetchingModels(true);
    setFetchedModels(null);
    try {
      const r = await fetch("/api/admin/tenant/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fetchModels",
          provider,
          key: keyInput.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        }),
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep */ }
        push({ variant: "destructive", title: "Fetch models failed", description: msg });
        return;
      }
      const j = await r.json();
      setFetchedModels(j.models);
      push({ variant: "default", title: "Models fetched", description: `Found ${j.models.length} models.` });
    } catch (e: any) {
      push({ variant: "destructive", title: "Error", description: e?.message ?? "Network error." });
    } finally {
      setFetchingModels(false);
    }
  }

  if (loading || !status) {
    return (
      <div id="llm" className="mb-8 flex scroll-mt-20 items-center gap-2 rounded-lg border bg-card p-5 text-sm text-muted-foreground shadow-xs">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading LLM settings…
      </div>
    );
  }

  if (status.migrationNeeded) {
    return (
      <section id="llm" className="mb-8 scroll-mt-20 rounded-lg border border-warning/40 bg-warning/5 p-5 shadow-xs">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-warning">
          <Cpu className="mr-1 inline h-3 w-3 -translate-y-px" /> LLM provider
        </p>
        <p className="text-sm text-warning">
          Database migration required. Run <code className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[12px]">npx prisma db push</code> in
          the project directory to add the LLM provider columns, then restart the dev server.
        </p>
      </section>
    );
  }

  const StatusPill = () => {
    // Only the tab that matches the tenant's actually-saved provider gets
    // to claim "configured" or "using the platform-wide key" — see
    // viewingActiveProvider above. Every other tab is just a form you
    // haven't saved yet.
    if (status.configured && viewingActiveProvider) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
          <CheckCircle2 className="h-3.5 w-3.5" /> Configured for this workspace
        </span>
      );
    }
    if (status.fallbackEnv && viewingActiveProvider) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
          <CheckCircle2 className="h-3.5 w-3.5" /> Curf AI — included with your plan, metered in AI credits
        </span>
      );
    }
    if (!viewingActiveProvider && (status.configured || status.fallbackEnv)) {
      const activeLabel = status.drivers.find((d) => d.id === status.provider)?.label ?? status.provider;
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
          <Info className="h-3.5 w-3.5" /> Not set — workspace is using {activeLabel}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
        <AlertCircle className="h-3.5 w-3.5" /> Not configured — AI features disabled
      </span>
    );
  };

  return (
    <section id="llm" className="mb-8 scroll-mt-20 rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Cpu className="mr-1 inline h-3 w-3 -translate-y-px" />
            LLM provider
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(eeClient.edition === "community" ? "admin.llm.descriptionCommunity" : "admin.llm.description")}
          </p>
        </div>
        <StatusPill />
      </div>

      {/* Bring your own key — Business and above on Cloud. */}
      {!status.ownKeyAllowed && !status.configured ? (
        <UpgradeLock
          feature="gov.tenant_anthropic_key"
          currentTier={status.tier}
          title="Bring your own key"
          description="Curf AI is included with your plan and metered in AI credits. On Business and above you can connect your own Anthropic, OpenAI, Gemini or compatible key instead: any model your provider offers, and no metering."
        />
      ) : (
      <>
      {/* Provider picker */}
      <div className="mb-3">
        <Label className="text-xs">Provider</Label>
        <div className="mt-1 grid grid-cols-2 gap-2 md:grid-cols-4">
          {status.drivers.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => {
                setProvider(d.id);
                // Switching tabs must show THAT provider's own value, not
                // whatever was left typed for the previously-selected one —
                // the old `if (!model)` guard only ever fired on the very
                // first click (model is never empty afterwards), so e.g.
                // Custom's "kimi-k2.7-code-highspeed" kept showing under
                // Anthropic/OpenAI/Gemini too. The active provider (see
                // viewingActiveProvider) restores its real saved model/
                // base URL; every other tab starts clean at that driver's
                // own default, never a leftover from a different provider.
                const isActive = d.id === status.provider;
                setModel(isActive ? (status.model ?? d.defaultModel) : d.defaultModel);
                setBaseUrl(isActive ? (status.baseUrl ?? "") : "");
                setFetchedModels(null);
              }}
              className={
                "rounded-md border px-3 py-2 text-left text-xs transition " +
                (provider === d.id
                  ? "border-primary/60 bg-primary/5 text-foreground shadow-xs"
                  : "border-border bg-background hover:bg-muted")
              }
            >
              <div className="font-semibold">{d.label}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                Default: <code className="font-mono">{d.defaultModel}</code>
              </div>
            </button>
          ))}
        </div>
      </div>

      {driver && (
        <p className="mb-3 text-[11px] text-muted-foreground">{driver.credentialHint}</p>
      )}

      {/* Existing key preview — only for the tab that's actually active;
          see viewingActiveProvider above. */}
      {status.configured && status.masked && viewingActiveProvider && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 font-mono text-xs">
          <Key className="h-3.5 w-3.5 text-success" />
          <span className="text-success">{status.masked}</span>
          <span className="text-muted-foreground">· encrypted at rest</span>
        </div>
      )}
      {status.legacyKeyPresent && !status.configured && (
        <div className="mb-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          A legacy Anthropic key from before the LLM pivot is on file. Click Save to migrate it under the unified provider config.
        </div>
      )}

      {/* Key input */}
      <div className="grid gap-2">
        <Label htmlFor="llm-key" className="text-xs">
          {status.configured && viewingActiveProvider ? "Replace key" : "Set key"}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="llm-key"
            type={showInput ? "text" : "password"}
            placeholder={driver?.credentialHint ?? "API key"}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            disabled={saving}
            className="font-mono text-xs"
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowInput((s) => !s)} title={showInput ? "Hide" : "Show"}>
            {showInput ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        {driver?.consoleUrl && (
          <p className="text-[11px] text-muted-foreground">
            Get a key at <a href={driver.consoleUrl} target="_blank" rel="noreferrer"
              className="text-primary underline">{driver.consoleUrl.replace(/^https?:\/\//, "")}</a>.
            The key is AES-256-GCM encrypted before it touches the database.
          </p>
        )}
      </div>

      {/* Model picker */}
      <div className="mt-4 grid gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="llm-model" className="text-xs flex items-center gap-1.5">
            Model
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => push({
                variant: "default",
                title: "Model Tools",
                description: "Fetch Models: Retrieves a list of available models. (ดึงรายชื่อโมเดล)\nTest Connection: Verifies your API key and model. (ทดสอบการเชื่อมต่อ)",
              })}
              title="Click to learn about Fetch Models and Test Connection"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </Label>
          <div className="flex items-center gap-2">
            {(provider === "openai" || provider === "openai-compatible") && (
              <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={fetchModels} disabled={fetchingModels}>
                {fetchingModels ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null} Fetch Models
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={testConnection} disabled={testingConnection}>
              {testingConnection ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null} Test Connection
            </Button>
          </div>
        </div>
        <Input
          id="llm-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={driver?.defaultModel ?? "model id"}
          className="font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          Leave blank to use the provider's default ({driver?.defaultModel ?? "—"}).
        </p>
        
        {fetchedModels && fetchedModels.length > 0 && (
          <div className="mt-2">
            <p className="mb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Available Models:</p>
            <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto p-1 border rounded-md bg-muted/20">
              {fetchedModels.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModel(m)}
                  className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono hover:bg-muted"
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Fast model — Q&A-shaped calls. Same provider and key; only the
          model id differs. A reasoning model above is right for Master
          Builder and wrong for a one-sentence grounded answer. */}
      <div className="mt-4 grid gap-2">
        <Label htmlFor="llm-fast-model" className="text-xs">Fast model — Ask, captions, briefs, request drafts (optional)</Label>
        <Input
          id="llm-fast-model"
          value={fastModel}
          onChange={(e) => setFastModel(e.target.value)}
          placeholder={model.trim() || driver?.defaultModel || "same as Model"}
          className="font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          Leave blank to use the Model above for everything. Set a non-reasoning model here when the Model above is a reasoning model (e.g. <span className="font-mono">kimi-k3</span> for Master Builder, <span className="font-mono">kimi-k2.6</span> here) — grounded answers don't need chain-of-thought, and a reasoning model spends its whole token budget thinking before it answers.
        </p>
      </div>

      {/* Base URL — only for openai-compatible */}
      {driver?.needsBaseUrl && (
        <div className="mt-4 grid gap-2">
          <Label htmlFor="llm-base-url" className="text-xs">Base URL</Label>
          <Input
            id="llm-base-url"
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="font-mono text-xs"
          />
          {driver.baseUrlSuggestions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Quick-pick:</span>
              {driver.baseUrlSuggestions.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  onClick={() => {
                    setBaseUrl(s.url);
                    if (!model && s.defaultModel) setModel(s.defaultModel);
                    setFetchedModels(null);
                  }}
                  className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] hover:bg-muted"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <div>
          {status.configured && viewingActiveProvider && (
            <Button variant="ghost" size="sm" onClick={remove} disabled={removing} className="text-destructive hover:bg-destructive/10">
              {removing ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Removing</>
                         : <><Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove credentials</>}
            </Button>
          )}
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving</> : "Save"}
        </Button>
      </div>
      </>
      )}
    </section>
  );
}
