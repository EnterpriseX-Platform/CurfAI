import { describe, it, expect } from "vitest";
import { contentDisposition, filenameFromDisposition } from "./contentDisposition";

describe("contentDisposition", () => {
  it("keeps a Thai report's name, with an ASCII fallback", () => {
    const h = contentDisposition("attachment", "ค่าเผื่อสินค้า: วิธีเดิม เทียบ วิธีใหม่", "xlsx");
    expect(h).toMatch(/^attachment; filename="report\.xlsx"; filename\*=UTF-8''/);
    expect(filenameFromDisposition(h)).toBe("ค่าเผื่อสินค้า วิธีเดิม เทียบ วิธีใหม่.xlsx");
  });

  it("slugs an English name for the fallback and keeps its case in the real one", () => {
    const h = contentDisposition("inline", "Weekly Sales (Q3)", "pdf");
    expect(h).toContain('filename="weekly-sales-q3.pdf"');
    expect(h).toContain("filename*=UTF-8''Weekly%20Sales%20%28Q3%29.pdf");
    expect(filenameFromDisposition(h)).toBe("Weekly Sales (Q3).pdf");
  });

  it("drops what no file system takes", () => {
    expect(filenameFromDisposition(contentDisposition("attachment", 'a/b:c"d<e>|f*g?h', "csv"))).toBe("a b c d e f g h.csv");
  });
});

describe("filenameFromDisposition", () => {
  it("reads a plain filename when there's no UTF-8 one", () => {
    expect(filenameFromDisposition('attachment; filename="sales.csv"')).toBe("sales.csv");
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
