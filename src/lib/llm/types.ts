/**
 * Provider-agnostic LLM types.
 *
 * Curf supports multiple LLM providers via a small driver layer. Every
 * driver implements `LlmDriver`. Code that wants to call an LLM uses
 * `callLLM()` from index.ts and never touches a provider directly.
 *
 * This is the only place provider-specific knowledge leaks into Curf.
 * Everywhere else (UI, business logic) refers to "the AI" or "the model".
 */

/** Discriminator for the active provider. Matches Tenant.llmProvider. */
export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openai-compatible";

export type LlmRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

/** Common request shape across providers. */
export type LlmRequest = {
  /** Tenant for key lookup + usage attribution. Required. */
  tenantId: string | null;
  /** Feature label — 'ask' | 'autoCurf' | 'caption' | 'why' | 'generate' | etc. Surfaces in usage dashboard. */
  kind: string;
  /** Optional pointer to the report this call serves (for per-report spend attribution). */
  reportId?: string | null;
  /** User who triggered it; null for cron paths. */
  userId?: string | null;

  /** System prompt — combined with messages by each provider as appropriate. */
  system?: string;
  /** Conversation history. Last message must be a user turn. */
  messages: LlmMessage[];

  /** Model id override. When omitted, the tenant's `llmModel` is used; when that's also unset, the provider's default model. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Per-request ceiling on how long to wait, in ms. Defaults to the
   * driver's own 90s.
   *
   * Raise it only from a call site that has EVIDENCE this path is slow —
   * the staged planner, for instance, exists precisely because a model
   * already failed to answer in one pass, so granting it more room is
   * informed rather than hopeful. Raising the driver default instead
   * would make every genuinely stuck request hang longer for everyone.
   */
  timeoutMs?: number;

  /**
   * Hint for the response — when set to "json", the driver enables the
   * provider's strict JSON mode where supported (OpenAI response_format,
   * Gemini responseMimeType, etc.) and falls back to system-prompt
   * coaching otherwise. Anthropic doesn't have a JSON mode — we coach
   * via system prompt + post-parse.
   */
  responseFormat?: "text" | "json";

  /**
   * "off" asks the provider not to think before answering, where the
   * provider has such a switch (Moonshot's `thinking: { type: "disabled" }`
   * on Kimi K2.5+; OpenAI's `reasoning_effort` on o-series). Set by
   * callLLM() for fast kinds (see isFastKind) — a grounded one-sentence
   * answer gains nothing from chain-of-thought and, on a thinking model,
   * loses its whole token budget to it. Ignored by drivers/models without
   * a switch; never sent to hosts that would reject the parameter.
   */
  reasoning?: "off" | "default";

  /**
   * Caller-side abort — a streaming route whose client disconnected, a
   * user who pressed Cancel. Drivers that fetch honour it alongside their
   * own timeout; an aborted call comes back status "failed" like any
   * other, never as a thrown exception.
   */
  signal?: AbortSignal;
};

/** Token usage broken out so the dashboard can split cache vs fresh. */
export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
};

export type LlmResponse = {
  /** The assistant's text reply. Empty string when status='failed'. */
  text: string;
  /** Provider id that produced this response. */
  provider: ProviderId;
  /** Model id that produced this response. */
  model: string;
  /** ok | failed — caller checks before using `text`. */
  status: "ok" | "failed";
  /** Human-readable error when status='failed'. */
  error?: string;
  /** Token counts (always present, may be zero on failure). */
  usage: LlmUsage;
  /** Wall-clock latency. */
  durationMs: number;
  /** Echo of the request id we minted (logged in the LlmTokenUsage row). */
  usageRowId?: string;
};

/** Per-provider driver interface. */
export type LlmDriver = {
  id: ProviderId;
  /** Human label used only in the LLM settings UI. */
  label: string;
  /** Default model when neither the request nor tenant specify one. */
  defaultModel: string;
  /** Help string under the credentials field. Shown in the settings UI. */
  credentialHint: string;
  /** Where to point users to obtain a key. Shown in the settings UI. */
  consoleUrl?: string;
  /** Whether this provider needs a base URL (only true for openai-compatible). */
  needsBaseUrl?: boolean;
  /** Suggested base URLs for the openai-compatible picker. */
  baseUrlSuggestions?: Array<{ label: string; url: string; defaultModel?: string }>;
  /** Execute the call. */
  call(req: LlmRequest, ctx: DriverContext): Promise<LlmResponse>;
};

/** Resolved per-tenant context handed to the driver. */
export type DriverContext = {
  apiKey: string;
  baseUrl: string | null;
  /** Final model resolved through (request → tenant → driver default). */
  model: string;
};
