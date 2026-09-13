/**
 * Turns a raw LLM-provider error string (network errors, HTTP status text,
 * or a whole JSON error body — e.g. Kimi/OpenAI-compatible providers return
 * `{"error":{"message":"...suspended due to insufficient balance..."}}`)
 * into a short, bilingual (EN/TH), user-facing message.
 *
 * Originally lived only in customPlanner.ts (Master Builder's initial plan);
 * iterator.ts (chat-iterate) and askChat.ts (Ask Curf) both forwarded the
 * raw provider error straight into a chat bubble instead — an org id, raw
 * JSON, and billing-account internals shown to end users with no way to act
 * on any of it. Centralized here so every LLM call site gets the same
 * treatment for free.
 */
export function humanizeLlmError(rawError: string | undefined): {
  message: string;
  notConfigured: boolean;
  /**
   * True when the failure is plausibly specific to the *sub-model* chosen
   * (ran out of reasoning budget, took too long) rather than the provider,
   * key, or prompt — the two cases where the message already tells the
   * user to "try a different sub-model in Tenant Settings → LLM". A caller
   * that offers an inline model-override retry (see MasterBuilderEntry.tsx)
   * uses this to decide whether to show it.
   */
  canSwitchModel: boolean;
} {
  const raw = rawError ?? "";
  const lower = raw.toLowerCase();
  const notConfigured = lower.includes("not configured");

  if (notConfigured) {
    return {
      notConfigured: true,
      canSwitchModel: false,
      message:
        "This prompt doesn't match a built-in preset, and no AI provider is connected. Connect a key in Tenant Settings → LLM.\n(คำสั่งนี้ไม่ตรงกับรูปแบบมาตรฐาน และยังไม่ได้เชื่อมต่อ AI โปรดตั้งค่าใน Tenant Settings → LLM)",
    };
  }
  if (raw.includes("REASONING_BUDGET_EXHAUSTED")) {
    return {
      notConfigured: false,
      canSwitchModel: true,
      message:
        "This model spent its entire response budget on internal reasoning and never produced an answer for this prompt. It may work for simpler prompts but isn't reliable for Master Builder's larger ones — try a different sub-model in Tenant Settings → LLM, or rephrase more narrowly.\n(โมเดลนี้ใช้ token ทั้งหมดไปกับการ \"คิด\" ภายในจนไม่เหลือสำหรับคำตอบจริง อาจใช้ได้กับคำสั่งง่ายๆ แต่ไม่เสถียรพอสำหรับ Master Builder ลองเปลี่ยนโมเดลย่อยใน Tenant Settings → LLM หรือปรับคำสั่งให้แคบลง)",
    };
  }
  if (lower.includes("timed out after")) {
    // Pull the actual elapsed seconds out of the driver's own error string
    // (e.g. "Request timed out after 91s") instead of hardcoding the
    // timeout constant here — the two would only drift apart otherwise.
    const seconds = raw.match(/timed out after (\d+)s/i)?.[1] ?? "the wait limit";
    return {
      notConfigured: false,
      canSwitchModel: true,
      message:
        `The AI provider took too long to respond and the request was cancelled after ${seconds} seconds. This can happen even on a working model — some are slower to "think" on harder prompts. Please try again, or switch to a different sub-model in Tenant Settings → LLM if it keeps happening.\n` +
        `(ผู้ให้บริการ AI ตอบกลับช้าเกินไป ระบบยกเลิกคำขอหลังจากรอ ${seconds} วินาที เหตุการณ์นี้เกิดขึ้นได้แม้ model จะใช้งานได้ปกติ เพราะบาง model "คิด" นานกว่าเมื่อเจอคำสั่งที่ซับซ้อน กรุณาลองใหม่ หรือเปลี่ยนโมเดลย่อยใน Tenant Settings → LLM หากเกิดซ้ำบ่อย)`,
    };
  }
  if (lower.includes("temperature")) {
    return {
      notConfigured: false,
      // This is a per-model quirk (the model rejects a parameter another
      // model on the same provider/key accepts fine) — unlike the branches
      // below, a different sub-model plausibly just works.
      canSwitchModel: true,
      message:
        "The AI model settings (e.g., Temperature) are incompatible. Please check your settings.\n(การตั้งค่าโมเดล AI เช่น ค่า Temperature ไม่รองรับกับโมเดลนี้ กรุณาตรวจสอบการตั้งค่า)",
    };
  }
  if (lower.includes("fetch failed") || lower.includes("timeout") || lower.includes("aborted")) {
    return {
      notConfigured: false,
      canSwitchModel: false,
      message:
        "Connection to the AI provider failed or timed out. Please try again.\n(พบปัญหาการเชื่อมต่อกับ AI หรือเชื่อมต่อขัดข้อง กรุณาลองใหม่อีกครั้ง)",
    };
  }
  if (lower.includes("rate limit") || raw.includes("429") || lower.includes("insufficient balance") || lower.includes("suspended")) {
    return {
      notConfigured: false,
      canSwitchModel: false,
      message:
        "AI provider rate limit exceeded. Please wait a moment and try again.\n(เกินขีดจำกัดการใช้งาน AI ชั่วคราว กรุณารอสักครู่แล้วลองใหม่)",
    };
  }
  if (raw.includes("401") || raw.includes("403") || lower.includes("invalid_api_key")) {
    return {
      notConfigured: false,
      canSwitchModel: false,
      message:
        "AI API Key is invalid or expired. Please check Tenant Settings.\n(API Key ของ AI ไม่ถูกต้องหรือหมดอายุ กรุณาตรวจสอบในการตั้งค่า)",
    };
  }
  if (!raw) {
    return {
      notConfigured: false,
      canSwitchModel: true,
      message:
        "The AI took too long to think or the response was blocked. Please try again.\n(ระบบ AI ใช้เวลาคิดนานเกินไป หรือการตอบกลับถูกบล็อก กรุณาลองใหม่อีกครั้ง)",
    };
  }
  // Last resort — still not the raw provider payload, just a generic notice.
  // Any specific case worth naming should get its own branch above instead
  // of leaking provider internals (account ids, JSON bodies) to end users.
  // canSwitchModel: true here too — an unclassified failure is, by
  // definition, one we can't rule out being model-specific, and offering
  // the retry costs the user nothing if it isn't.
  return {
    notConfigured: false,
    canSwitchModel: true,
    message:
      "AI planning failed. Please try again.\n(การสร้างแผน AI ล้มเหลว กรุณาลองใหม่อีกครั้ง)",
  };
}
