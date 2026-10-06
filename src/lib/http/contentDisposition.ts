/**
 * A Content-Disposition header that keeps a file's own name.
 *
 * The report export routes each slugged the report's name to ASCII, so a
 * Thai report ("ค่าเผื่อสินค้า: วิธีเดิม เทียบ วิธีใหม่") downloaded as
 * "report.xlsx" every time — a finance user exporting three reports got
 * three files with the same name (2026-09-28). RFC 6266/5987: `filename`
 * stays an ASCII fallback for old clients, `filename*` carries the real
 * name; fetchExport (lib/reporting/exportDownload.ts) reads it first.
 */
export function contentDisposition(kind: "attachment" | "inline", name: string, ext: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
  // Characters no file system takes, and control characters, become spaces.
  const real = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || ascii;
  const encoded = encodeURIComponent(`${real}.${ext}`).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}.${ext}"; filename*=UTF-8''${encoded}`;
}

/** The file name a Content-Disposition header gives, preferring the UTF-8 one. */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through to the plain name */ }
  }
  return /filename="([^"]+)"/.exec(header)?.[1] ?? null;
}
