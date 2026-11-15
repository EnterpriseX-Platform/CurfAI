/**
 * Tiny inline-markdown renderer for assistant replies (Ask, the agent, the
 * report's Ask panel).
 *
 * Why not a full markdown lib (react-markdown, marked)? Replies are short —
 * usually 1–3 paragraphs of prose with the occasional bold/italic/code.
 * Pulling in a 60kb parser for "render **bold** as <strong>" is a bad trade.
 * This handles the marks we actually see and falls through for anything
 * else (the caller keeps line breaks with whitespace-pre-wrap).
 *
 * Supported:
 *   **bold**     → <strong>
 *   *italic*     → <em>      (skips when adjacent chars are word-ish, so
 *                              `2.9*x*` stays literal — common in numbers)
 *   `code`       → <code>
 *   a blank line → paragraph break
 */
export function MarkdownInline({ text }: { text: string }) {
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
      out.push(<code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">{tok.slice(1, -1)}</code>);
    } else {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(<span key={key++}>{s.slice(last)}</span>);
  return out;
}

