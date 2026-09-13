"use client";
/**
 * AskCurfPanel — slide-out chat over the whole report.
 *
 * UX shape:
 *   - Header trigger: "Ask Curf" pill (next to PresenceChip)
 *   - Slide-out from the right edge, ~440px wide
 *   - Conversation history with assistant-stylized bubbles
 *   - Composer with autosizing textarea + cmd-enter to send
 *   - Suggested follow-up chips after each assistant reply
 *   - "Save as block" CTA when Claude returns a new_chart action
 *   - "Jump to block" CTA when Claude returns a highlight_block action
 *
 * State is in-memory only (per-mount). For history-across-sessions we'd add
 * an AskConversation Prisma model — deferred for now since the value of a
 * persistent transcript is moderate and the per-tenant cost would matter.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, Send, X, Loader2, MessageCircle, ChevronRight, BarChart3, History, Plus, Trash2, Check } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";

type Action =
  | { kind: "new_chart"; spec: { type: string; title: string; queryId?: string; xField?: string; yFields?: string[]; description?: string } }
  | { kind: "highlight_block"; blockId: string };

type Msg = {
  role: "user" | "assistant";
  content: string;
  action?: Action;
  followups?: string[];
};

type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
};

export function AskCurfPanel({
  reportId,
  currentParams,
}: {
  reportId: string;
  currentParams: Record<string, unknown>;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  // Persistence state. conversationId tracks which row this chat is
  // currently writing to; null = fresh conversation, will be minted on
  // the next assistant reply. conversations[] is the user's history list,
  // lazy-loaded the first time the History dropdown opens.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const scrollerRef = useRef<HTMLDivElement>(null);
  // Track whether the user was at (or near) the bottom BEFORE the latest
  // message arrived. If they were reading earlier replies, we leave the
  // scroll position alone so a streaming reply doesn't yank them away.
  // Threshold of 80px gives a bit of slack for "essentially at the bottom".
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll only when the user was already at the bottom. New reply
  // arriving while they're scrolled up = leave them be (with a subtle
  // "new message" affordance, future polish).
  useEffect(() => {
    if (!scrollerRef.current) return;
    if (!wasAtBottomRef.current) return;
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, [messages.length, busy]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setError(null);
    const userMsg: Msg = { role: "user", content: trimmed };
    const next = [...messages, userMsg];
    setMessages(next);
    setDraft("");
    setBusy(true);
    try {
      const r = await fetch(`/api/reports/${reportId}/ask-chat`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          params: currentParams,
          conversationId,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      const reply: Msg = {
        role: "assistant",
        content: j.text ?? t("ask.emptyResponse"),
        action: j.action,
        followups: j.followups,
      };
      setMessages((prev) => [...prev, reply]);
      // Server returns the (new or existing) conversationId; capture it
      // so subsequent turns append to the same row. Also invalidate the
      // history list so it shows the new conv on next open.
      if (j.conversationId && j.conversationId !== conversationId) {
        setConversationId(j.conversationId);
      }
      setConversations(null);
    } catch (e: any) {
      setError(e?.message ?? t("ask.networkError"));
    } finally {
      setBusy(false);
    }
  }, [busy, messages, reportId, currentParams, conversationId, t]);

  function clearChat() {
    // "Clear" starts a brand-new conversation — the previous one stays
    // persisted and accessible via the history dropdown.
    setMessages([]);
    setConversationId(null);
    setError(null);
  }

  // Lazy-load history the first time the dropdown opens.
  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const r = await fetch(`/api/reports/${reportId}/ask-chat/conversations`, { credentials: "include" });
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      const j = await r.json();
      setConversations(j.items ?? []);
    } catch (e: any) {
      setError(e?.message ?? t("askCurfPanel.loadHistoryFailed"));
    } finally {
      setLoadingHistory(false);
    }
  }, [reportId, t]);

  useEffect(() => {
    if (showHistory && conversations === null) void loadHistory();
  }, [showHistory, conversations, loadHistory]);

  async function resumeConversation(convId: string) {
    setError(null);
    setShowHistory(false);
    try {
      const r = await fetch(`/api/reports/${reportId}/ask-chat/conversations/${convId}`, { credentials: "include" });
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      const j = await r.json();
      setConversationId(j.id);
      setMessages((j.messages ?? []).map((m: any) => ({
        role: m.role,
        content: m.content,
        action: m.action ?? undefined,
        followups: m.followups ?? undefined,
      })));
    } catch (e: any) {
      setError(e?.message ?? t("askCurfPanel.loadConversationFailed"));
    }
  }

  async function deleteConversation(convId: string) {
    if (!confirm(t("askCurfPanel.confirmDelete"))) return;
    try {
      const r = await fetch(`/api/reports/${reportId}/ask-chat/conversations/${convId}`, {
        method: "DELETE", credentials: "include",
      });
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      // If we deleted the one we're currently viewing, drop into a fresh chat.
      if (convId === conversationId) {
        setMessages([]);
        setConversationId(null);
      }
      setConversations(null); // force reload
      void loadHistory();
    } catch (e: any) {
      setError(e?.message ?? t("askCurfPanel.deleteFailed"));
    }
  }

  function highlightBlock(blockId: string) {
    if (typeof document === "undefined") return;
    const el = document.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement | null;
    if (!el) {
      setError(t("askCurfPanel.blockNotFound").replace("{id}", blockId));
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Pulse outline 1.5s as a visual confirmation.
    el.style.transition = "outline 0.2s ease-out";
    el.style.outline = "3px solid hsl(var(--primary))";
    el.style.outlineOffset = "4px";
    setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 1500);
  }

  // Saving a chart-suggestion as an actual block requires the Designer
  // round-trip; for v1 we stub it with a copy-the-spec behaviour and a
  // "Open the editor to add this" hint.
  function saveAsBlock(spec: Extract<Action, { kind: "new_chart" }>["spec"]) {
    navigator.clipboard?.writeText(JSON.stringify(spec, null, 2)).catch(() => { /* best-effort */ });
    setError(t("askCurfPanel.specCopied"));
  }

  const trigger = (
    // Sits in the report header next to Share / Export / Edit, so it takes
    // their button shape; the sparkle in the accent says "AI" on its own.
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
      title={t("askCurfPanel.triggerTooltip")}
    >
      <Sparkles className="h-3.5 w-3.5 text-primary" /> Ask Curf
    </button>
  );

  if (!open) return trigger;
  if (!mounted) return trigger;

  const panel = (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label={t("askCurfPanel.closeAriaLabel")}
        className="flex-1 bg-foreground/30 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <aside
        // Same opaque-bg fallback the rest of the design system uses — see
        // dialog.tsx + ChartPinOverlay.tsx for the pattern.
        style={{ backgroundColor: "hsl(var(--background, 0 0% 100%))" }}
        className="flex h-full w-full max-w-md flex-col border-l border-border text-foreground shadow-2xl shadow-black/20"
      >
        <header className="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              <Sparkles className="h-3 w-3" /> Ask Curf
            </p>
            <h3 className="mt-1 text-sm font-semibold">{t("askCurfPanel.heading")}</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("askCurfPanel.subtitle")}
            </p>
          </div>
          <div className="relative flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t("askCurfPanel.pastConversations")}
            >
              <History className="h-3 w-3" /> {t("askCurfPanel.historyButton")}
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clearChat}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t("askCurfPanel.newTooltip")}
              >
                <Plus className="h-3 w-3" /> {t("askCurfPanel.newButton")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("action.close")}
            >
              <X className="h-4 w-4" />
            </button>

            {/* Floating history popover anchored to the History button. */}
            {showHistory && (
              <div
                style={{ backgroundColor: "hsl(var(--background, 0 0% 100%))" }}
                className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg border border-border text-foreground shadow-2xl"
              >
                <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("askCurfPanel.pastConversations")}</span>
                  <button
                    type="button"
                    onClick={() => setShowHistory(false)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t("askCurfPanel.closeHistoryAriaLabel")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {loadingHistory && (
                    <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> {t("askCurfPanel.loading")}
                    </div>
                  )}
                  {!loadingHistory && (conversations ?? []).length === 0 && (
                    <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                      {t("askCurfPanel.noConversations")}<br />{t("askCurfPanel.noConversationsHint")}
                    </p>
                  )}
                  {!loadingHistory && (conversations ?? []).map((c) => (
                    <div
                      key={c.id}
                      className={
                        "group flex items-start gap-1 border-t border-border px-3 py-2 first:border-t-0 " +
                        (c.id === conversationId ? "bg-primary/5" : "hover:bg-muted/40")
                      }
                    >
                      <button
                        type="button"
                        onClick={() => resumeConversation(c.id)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="flex items-center gap-1 text-xs font-medium text-foreground">
                          {c.id === conversationId && <Check className="h-3 w-3 shrink-0 text-primary" />}
                          <span className="truncate">{c.title}</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {c.messageCount === 1 ? t("askCurfPanel.messageCountOne").replace("{n}", String(c.messageCount)) : t("askCurfPanel.messageCountMany").replace("{n}", String(c.messageCount))} · {timeAgo(c.updatedAt)}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteConversation(c.id)}
                        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        title={t("action.delete")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </header>

        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 && !busy && (
            <EmptyState onPick={(q) => void send(q)} />
          )}

          <ul className="space-y-4">
            {messages.map((m, i) => (
              <li key={i}>
                {m.role === "user" ? (
                  <div className="ml-8 rounded-lg rounded-tr-sm border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
                    {m.content}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="mr-8 rounded-lg rounded-tl-sm border border-border bg-muted/40 px-3 py-2 text-sm leading-relaxed text-foreground">
                      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                        <Sparkles className="h-3 w-3" /> Curf
                      </div>
                      {m.content
                        ? <MarkdownInline text={m.content} />
                        : <span className="italic text-muted-foreground">{t("ask.emptyResponse")}</span>}
                    </div>

                    {/* Inline action card */}
                    {m.action?.kind === "new_chart" && (
                      <ActionCard
                        icon={<BarChart3 className="h-3.5 w-3.5" />}
                        title={t("askCurfPanel.suggestedNewChart")}
                        body={
                          <div className="text-[11px] leading-relaxed text-muted-foreground">
                            <span className="font-medium text-foreground">{m.action.spec.title}</span>
                            <span className="ml-1 rounded bg-muted px-1 text-[10px]">{m.action.spec.type}</span>
                            {m.action.spec.description && <p className="mt-1">{m.action.spec.description}</p>}
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground/80">
                              query={m.action.spec.queryId ?? "—"} · x={m.action.spec.xField ?? "—"} · y=[{(m.action.spec.yFields ?? []).join(", ")}]
                            </p>
                          </div>
                        }
                        cta={t("askCurfPanel.saveAsBlock")}
                        onCta={() => saveAsBlock((m.action as any).spec)}
                      />
                    )}
                    {m.action?.kind === "highlight_block" && (
                      <ActionCard
                        icon={<ChevronRight className="h-3.5 w-3.5" />}
                        title={t("askCurfPanel.jumpToBlock")}
                        body={<span className="font-mono text-[11px] text-muted-foreground">{m.action.blockId}</span>}
                        cta={t("askCurfPanel.scrollToIt")}
                        onCta={() => highlightBlock((m.action as any).blockId)}
                      />
                    )}

                    {/* Follow-up chips */}
                    {m.followups && m.followups.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {m.followups.map((f, j) => (
                          <button
                            key={j}
                            type="button"
                            onClick={() => void send(f)}
                            className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {busy && (
            <div className="mt-3 mr-8 inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("askCurfPanel.thinking")}
            </div>
          )}
          {error && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              {error}
            </div>
          )}
        </div>

        <Composer
          draft={draft}
          setDraft={setDraft}
          onSend={() => void send(draft)}
          disabled={busy || !draft.trim()}
        />
      </aside>
    </div>
  );

  return (
    <>
      {trigger}
      {createPortal(panel, document.body)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const { t } = useT();
  const seeds = [
    t("askCurfPanel.seed.summarise"),
    t("askCurfPanel.seed.segment"),
    t("askCurfPanel.seed.chart"),
    t("askCurfPanel.seed.anomalies"),
  ];
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center">
        <Sparkles className="mx-auto h-5 w-5 text-primary" />
        <h4 className="mt-2 text-sm font-semibold">{t("askCurfPanel.startConversation")}</h4>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t("askCurfPanel.emptyStateDesc")}
        </p>
      </div>
      <ul className="grid gap-1.5">
        {seeds.map((s, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
            >
              <span>{s}</span>
              <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionCard({
  icon, title, body, cta, onCta,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  cta: string;
  onCta: () => void;
}) {
  return (
    <div className="mr-8 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
          {icon} {title}
        </span>
        <button
          type="button"
          onClick={onCta}
          className="inline-flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {cta}
        </button>
      </div>
      <div className="mt-1.5">{body}</div>
    </div>
  );
}

/**
 * Tiny inline-markdown renderer for assistant bubbles.
 *
 * Why not a full markdown lib (react-markdown, marked)? Claude responses
 * are short — usually 1–3 paragraphs of prose with the occasional bold/
 * italic/code/inline link. Pulling in a 60kb parser for "render
 * **bold** as <strong>" is a bad trade. This handles the four marks we
 * actually see in practice and gracefully falls through for anything else.
 *
 * Supported:
 *   **bold**     → <strong>
 *   *italic*     → <em>      (skips when adjacent chars are word-ish, so
 *                              `2.9*x*` stays literal — common in numbers)
 *   `code`       → <code>
 *   \n\n         → paragraph break
 *
 * NOT supported (kept literal): headings, lists, blockquotes, full links,
 * nested marks. If we start seeing those frequently we can graduate to
 * a real parser; for now this matches what Claude actually emits.
 */
function MarkdownInline({ text }: { text: string }) {
  // Split paragraphs first so each becomes a <p> with its own inline pass.
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className={i === 0 ? "" : "mt-2"}>
          {renderInline(p)}
        </p>
      ))}
    </>
  );
}

// Token-walk for **bold**, *italic*, `code`. Keeps O(n) and correctly
// handles **nested *bold-italic*** style by tokenising bold first then
// running italic on the inner content. Order matters: bold (greedy `**`)
// before italic (`*`) so `**foo**` doesn't parse as `*` + `foo` + `*`.
function renderInline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Pattern matches: **bold**, `code`, *italic* (single-line).
  // The italic check excludes word-adjacent asterisks to avoid clobbering
  // numbers like 2.9*x.
  const re = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\*[^\s*][^*\n]*?\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{s.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={key++} className="font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      out.push(<code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{tok.slice(1, -1)}</code>);
    } else {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(<span key={key++}>{s.slice(last)}</span>);
  return out;
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

function Composer({
  draft, setDraft, onSend, disabled,
}: {
  draft: string;
  setDraft: (s: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const { t } = useT();
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Autosize: grow with content up to ~6 lines, scroll after that.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }, [draft]);

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSend(); }}
      className="border-t border-border bg-muted/20 px-3 py-2.5"
    >
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={t("askCurfPanel.composerPlaceholder")}
        rows={1}
        className="block max-h-36 min-h-[36px] w-full resize-none rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        maxLength={4000}
      />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{t("askCurfPanel.composerHint")}</span>
        <button
          type="submit"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Send className="h-3 w-3" /> {t("action.send")}
        </button>
      </div>
    </form>
  );
}
