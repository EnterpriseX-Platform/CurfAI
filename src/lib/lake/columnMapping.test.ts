import { describe, it, expect } from "vitest";
import {
  columnDateOrder, dateFromFilename, headerScore, headerSignature, makeRowMapper, mappingProblems, normalizeHeader, profileColumns, suggestMapping,
} from "./columnMapping";
import { STANDARD_DATASETS } from "./standardDatasets";

const SALES = STANDARD_DATASETS.sales_lines;
const STOCK = STANDARD_DATASETS.inventory;

/** What suggestMapping picked, as field → column name. */
function picked(rows: Array<Record<string, unknown>>, ds = SALES): Record<string, string> {
  const { mapping } = suggestMapping(ds, profileColumns(rows));
  return Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, "column" in v ? v.column : `=${v.value}`]));
}

describe("suggestMapping — sales exports", () => {
  it("maps an English POS layout", () => {
    const rows = [
      { "Receipt No": "R-0001", "Date": "21/09/2026 14:35", "Item": "Latte", "Category": "Coffee", "Qty": 2, "Price": 65, "Discount": 0, "Total": 130, "Payment Type": "Cash" },
      { "Receipt No": "R-0002", "Date": "21/09/2026 15:02", "Item": "Croissant", "Category": "Bakery", "Qty": 1, "Price": 55, "Discount": 5, "Total": 50, "Payment Type": "QR" },
    ];
    expect(picked(rows)).toEqual({
      receipt_id: "Receipt No", sale_date: "Date", product: "Item", category: "Category",
      qty: "Qty", unit_price: "Price", discount: "Discount", net_amount: "Total", payment_method: "Payment Type",
    });
  });

  it("maps a Thai POS layout", () => {
    const rows = [
      { "เลขที่ใบเสร็จ": "INV001", "วันที่": "21/09/2569", "สาขา": "สยาม", "รหัสสินค้า": "A01", "ชื่อสินค้า": "ชาเย็น", "จำนวน": "3", "ราคาต่อหน่วย": "45", "ยอดสุทธิ": "135 บาท" },
    ];
    expect(picked(rows)).toEqual({
      receipt_id: "เลขที่ใบเสร็จ", sale_date: "วันที่", branch: "สาขา", sku: "รหัสสินค้า",
      product: "ชื่อสินค้า", qty: "จำนวน", unit_price: "ราคาต่อหน่วย", net_amount: "ยอดสุทธิ",
    });
  });

  it("maps snake_case headers", () => {
    const rows = [{ order_id: "o1", sold_at: "2026-09-21T10:00:00", product_name: "Pad Thai", quantity: 1, total_thb: 80, sales_channel: "Grab" }];
    expect(picked(rows)).toEqual({
      receipt_id: "order_id", sale_date: "sold_at", product: "product_name", qty: "quantity", net_amount: "total_thb", channel: "sales_channel",
    });
  });

  it("won't offer a column whose values don't fit the field", () => {
    // "Day" holds weekday names — not a date; "Total" is text here — not an amount.
    const rows = [{ Day: "Monday", Item: "Tea", Qty: 1, Total: "see note" }];
    const got = picked(rows);
    expect(got.sale_date).toBeUndefined();
    expect(got.net_amount).toBeUndefined();
  });
});

describe("suggestMapping — columns blank all through the sample", () => {
  // A promotion ran in September; the sample is the file's first 2,000 rows,
  // from July. The code column is blank in every one of them.
  const july = (extra: Record<string, unknown>) => [
    { "Receipt No": "T0629-001", "Date": "2026-06-29 08:33", "Store": "ทองหล่อ", "SKU": "B01", "Qty": 1, "Net Sales": 65, ...extra },
    { "Receipt No": "T0629-002", "Date": "2026-06-29 08:40", "Store": "ทองหล่อ", "SKU": "C03", "Qty": 1, "Net Sales": 95, ...extra },
  ];

  it("still maps an optional field whose header names it", () => {
    expect(picked(july({ "Promo Code": "" }))).toMatchObject({ promo_code: "Promo Code" });
    expect(picked(july({ "โค้ดโปรโมชั่น": null }))).toMatchObject({ promo_code: "โค้ดโปรโมชั่น" });
  });

  it("but not on a loose match with no values to back it", () => {
    // "promotional note" only contains a synonym; blank, it isn't evidence.
    expect(picked(july({ "Promotional Note Column": "" })).promo_code).toBeUndefined();
  });

  it("and never for a required field — every row would be skipped", () => {
    const rows = july({}).map(({ "Net Sales": _n, ...r }) => ({ ...r, "Net Sales": "" }));
    expect(picked(rows).net_amount).toBeUndefined();
  });
});

describe("suggestMapping — the real Aging & Provision export", () => {
  // Headers and the first data row verbatim from Aging__Provision_by_store_2026.xlsx.
  const row = {
    day_sid: 20260921, prod_num: 100226, Prod_Thai: "100226 ออปโป้เรโน่14 5G 256GBสีขาว_1PX W", store_no: 17,
    Items_location: "100226-17", area: "A13", aging_status_label: "2-AT", DIV: "NF", CL: "444 MOBILE PHONE", buyer_uid: "B51N",
    last_received: "2026-01-27T20:13:02.000+07:00", last_sold: "2026-09-09T07:00:00.000+07:00",
    inv_soh_qty: 1, inv_soh_cost_amt: 13901.05, avg_sales_qty: 0.0714, avg_sales_cost: 992.93, stock_day: 14.0003,
    aging_cost_amt: 13901.05, aging_prov_amt: 0, total_nbs_prov_amt: 0, total_aging_nbs_prov: 0,
  };

  it("maps it onto stock on hand", () => {
    expect(picked([row], STOCK)).toEqual({
      snapshot_date: "day_sid", branch: "store_no", sku: "prod_num", product: "Prod_Thai",
      category: "CL", on_hand: "inv_soh_qty", stock_value: "inv_soh_cost_amt",
      // What the ERP already knows about sales — stock status uses it when
      // there are no sales lines to work it out from.
      avg_daily_sales: "avg_sales_qty", last_sold_date: "last_sold", last_received_date: "last_received",
    });
  });

  it("reads the ERP date key and the rest of the row", () => {
    const { mapping } = suggestMapping(STOCK, profileColumns([row]));
    const out = makeRowMapper(STOCK, mapping, { sourceFile: "aging.xlsx" })(row);
    expect(out).toEqual({ row: expect.objectContaining({
      snapshot_date: "2026-09-21", branch: "17", sku: "100226", on_hand: 1, stock_value: 13901.05, source_file: "aging.xlsx",
    }) });
  });
});

describe("suggestMapping — a saved layout", () => {
  it("wins over name matching, for the columns that still exist", () => {
    const rows = [{ Date: "2026-09-21", Item: "Tea", Qty: 1, Total: 40, Note: "x" }];
    const got = suggestMapping(SALES, profileColumns(rows), {
      product: { column: "Note" }, branch: { value: "สยาม" }, sku: { column: "gone" },
    });
    expect(got.mapping.product).toEqual({ column: "Note" });
    expect(got.origin.product).toBe("saved");
    expect(got.mapping.branch).toEqual({ value: "สยาม" });
    expect(got.mapping.sku).toBeUndefined();
    expect(got.mapping.qty).toEqual({ column: "Qty" });
    expect(got.origin.qty).toBe("name");
  });
});

describe("a one-day POS summary with no date column", () => {
  // Loyverse's "item sales summary" export, Thai: one file per day, the day only in its name.
  const rows = [
    { "รายการ": "[นิยาย] กอดเกี้ยว (เล่ม 1)", "รหัสSKUสินค้า": "10013", "ประเภท": "สินค้า WOL", "สินค้าที่ขาย": "4.000", "ยอดขายรวม": "1960.00", "สินค้าที่รับคืน": "0.000", "คืนเงิน": "0.00", "ส่วนลด": "0.00", "ยอดขายสุทธิ": "1960.00", "ต้นทุนของสินค้า": "0.00", "กำไรรวม": "1960.00", "กำไร": "100.00%", "ภาษี": "0.00" },
    { "รายการ": "[แบบเล่ม] Chibi Character", "รหัสSKUสินค้า": "10076", "ประเภท": "หนังสือ Learning Space", "สินค้าที่ขาย": "2.000", "ยอดขายรวม": "739.00", "สินค้าที่รับคืน": "1.000", "คืนเงิน": "390.00", "ส่วนลด": "0.00", "ยอดขายสุทธิ": "349.00", "ต้นทุนของสินค้า": "0.00", "กำไรรวม": "349.00", "กำไร": "100.00%", "ภาษี": "0.00" },
  ];
  const DAY = "item-sales-summary-2025-03-27-2025-03-27.csv";

  it("reads the day from a file name that names one day, and nothing from a range or a bare number", () => {
    expect(dateFromFilename(DAY)).toBe("2025-03-27");
    expect(dateFromFilename("stock_20260921.xlsx")).toBe("2026-09-21");
    expect(dateFromFilename("item-sales-summary-2025-03-27-2025-04-08.csv")).toBeNull();
    expect(dateFromFilename("sales.csv")).toBeNull();
    expect(dateFromFilename("export_12345678.csv")).toBeNull();
    expect(dateFromFilename("batch-202503271.csv")).toBeNull();
  });

  it("maps quantity sold and net (not gross) sales by name, and takes the date from the file name", () => {
    const got = suggestMapping(SALES, profileColumns(rows), null, DAY);
    expect(got.mapping).toEqual({
      product: { column: "รายการ" }, sku: { column: "รหัสSKUสินค้า" }, category: { column: "ประเภท" },
      qty: { column: "สินค้าที่ขาย" }, discount: { column: "ส่วนลด" }, net_amount: { column: "ยอดขายสุทธิ" },
      cost: { column: "ต้นทุนของสินค้า" }, sale_date: { value: "2025-03-27" },
    });
    expect(got.origin.sale_date).toBe("filename");
    const mapping = { ...got.mapping, branch: { value: "Bookfair" } };
    expect(mappingProblems(SALES, mapping, Object.keys(rows[0]))).toEqual([]);
    // The POS writes 0.00 for a cost nobody entered (and "100%" profit beside it): not given.
    expect(makeRowMapper(SALES, mapping, { sourceFile: DAY })(rows[1])).toEqual({ row: expect.objectContaining({
      sale_date: "2025-03-27", branch: "Bookfair", sku: "10076", qty: 2, net_amount: 349, sale_time: null, cost: null, discount: 0,
    }) });
  });

  it("leaves the date open for a file whose name is a range", () => {
    const got = suggestMapping(SALES, profileColumns(rows), null, "item-sales-summary-2025-03-27-2025-04-08.csv");
    expect(got.mapping.sale_date).toBeUndefined();
    expect(mappingProblems(SALES, { ...got.mapping, branch: { value: "Bookfair" } }, Object.keys(rows[0]))).toContain("sale_date is needed.");
  });

  it("doesn't offer the file name's date when an unclaimed column holds dates", () => {
    const dated = rows.map((r) => ({ ...r, "Txn Dt": "27/03/2025" }));
    expect(suggestMapping(SALES, profileColumns(dated), null, "export_20260921.csv").mapping.sale_date).toBeUndefined();
  });

  it("doesn't carry yesterday's typed date over to today's file of the same layout", () => {
    const saved = { product: { column: "รายการ" }, branch: { value: "Bookfair" }, sale_date: { value: "2025-03-27" } };
    const next = suggestMapping(SALES, profileColumns(rows), saved, "item-sales-summary-2025-03-28-2025-03-28.csv");
    expect(next.mapping.sale_date).toEqual({ value: "2025-03-28" });
    expect(next.mapping.branch).toEqual({ value: "Bookfair" });
    expect(suggestMapping(SALES, profileColumns(rows), saved, "sales.csv").mapping.sale_date).toBeUndefined();
  });
});

describe("mappingProblems", () => {
  const headers = ["Date", "Item", "Qty", "Price"];

  it("accepts a complete mapping, with the amount worked out from quantity × price", () => {
    expect(mappingProblems(SALES, {
      sale_date: { column: "Date" }, branch: { value: "สยาม" }, product: { column: "Item" }, qty: { column: "Qty" }, unit_price: { column: "Price" },
    }, headers)).toEqual([]);
  });

  it("names what is missing", () => {
    const p = mappingProblems(SALES, { sale_date: { column: "Date" }, qty: { column: "Qty" } }, headers);
    expect(p).toContain("branch is needed.");
    expect(p.some((x) => x.startsWith("net_amount is needed"))).toBe(true);
    expect(p).toContain("Map at least one of: sku, product.");
  });

  it("refuses a column the file doesn't have, a column used twice, and a fixed value where none is allowed", () => {
    const p = mappingProblems(SALES, {
      sale_date: { column: "Nope" }, branch: { value: "สยาม" }, product: { column: "Item" }, sku: { column: "Item" },
      qty: { value: "1" }, net_amount: { column: "Price" },
    }, headers);
    expect(p).toContain('sale_date: the file has no column "Nope".');
    expect(p).toContain('"Item" is mapped to both sku and product.');
    expect(p).toContain("qty has to come from a column of the file.");
  });
});

describe("makeRowMapper", () => {
  const mapping = {
    sale_date: { column: "Date" }, branch: { value: "สยาม" }, product: { column: "Item" },
    qty: { column: "Qty" }, unit_price: { column: "Price" }, discount: { column: "Disc" },
  };
  const map = makeRowMapper(SALES, mapping, { sourceFile: "siam-sep.csv" });

  it("cleans each value, works out the amount and the time, and records the file", () => {
    expect(map({ Date: "21/09/2569 14:05", Item: " Latte ", Qty: "2", Price: "65 บาท", Disc: "5" })).toEqual({ row: {
      sale_date: "2026-09-21", sale_time: "14:05", branch: "สยาม", receipt_id: null, sku: null, product: "Latte",
      category: null, qty: 2, unit_price: 65, discount: 5, net_amount: 125, cost: null,
      payment_method: null, channel: null, promo_code: null, source_file: "siam-sep.csv",
    } });
  });

  it("skips a total line with no date, and a line with no quantity", () => {
    expect(map({ Date: "", Item: "Total", Qty: "12", Price: "", Disc: "" })).toEqual({ skipped: "sale_date" });
    expect(map({ Date: "21/09/2026", Item: "Tea", Qty: "", Price: "40", Disc: "" })).toEqual({ skipped: "qty" });
  });

  it("reads a cost of 0 as not given — on a line sold for money, and on a stock count", () => {
    const costed = makeRowMapper(SALES, { ...mapping, cost: { column: "Cost" } }, { sourceFile: "siam-sep.csv" });
    const cost = (raw: Record<string, unknown>) => (costed({ Date: "21/09/2026", Item: "Tea", Disc: "", ...raw }) as any).row.cost;
    expect(cost({ Qty: "2", Price: "40", Cost: "0.00" })).toBeNull();
    expect(cost({ Qty: "2", Price: "40", Cost: "30" })).toBe(30);
    // Given away for nothing at a cost of nothing is what the file says.
    expect(cost({ Qty: "1", Price: "0", Cost: "0" })).toBe(0);

    const stock = makeRowMapper(STOCK, {
      snapshot_date: { value: "2026-09-21" }, branch: { value: "สยาม" }, product: { column: "Item" },
      on_hand: { column: "On hand" }, unit_cost: { column: "Cost" },
    }, { sourceFile: "stock.csv" });
    expect(stock({ Item: "Tea", "On hand": "10", Cost: "0" })).toEqual({ row: expect.objectContaining({ on_hand: 10, unit_cost: null, stock_value: null }) });
    expect(stock({ Item: "Tea", "On hand": "10", Cost: "12" })).toEqual({ row: expect.objectContaining({ on_hand: 10, unit_cost: 12, stock_value: 120 }) });
  });
});

describe("columnDateOrder", () => {
  it("sees through the time of day — 01/09/2569 10:15 is 1 September, not 9 January", () => {
    // Found importing a Thai POS export over HTTP: with the time attached the
    // values didn't read as slash dates, the column "proved" nothing, and the
    // month-first fallback turned 1 Sep into 9 Jan.
    expect(columnDateOrder(["01/09/2569 10:15", "02/09/2569 12:40"])).toEqual({ order: "dmy", ambiguous: true });
    expect(columnDateOrder(["13/09/2569 10:15", "02/09/2569 12:40"])).toEqual({ order: "dmy", ambiguous: false });
    expect(columnDateOrder(["09/13/2026 10:15"])).toEqual({ order: "mdy", ambiguous: false });
  });

  it("has nothing to ask when there are no slash dates", () => {
    expect(columnDateOrder(["2026-09-03 08:05", "2026-09-04"])).toEqual({ order: "dmy", ambiguous: false });
    expect(columnDateOrder([20260921, 20260922])).toEqual({ order: "dmy", ambiguous: false });
  });
});

describe("headers", () => {
  it("normalizes spacing, case and punctuation", () => {
    expect(normalizeHeader(" Receipt-No. ")).toBe("receiptno");
    expect(normalizeHeader("ณ วันที่")).toBe("ณวันที่");
  });

  it("recognises the same layout whatever the column order or case", () => {
    expect(headerSignature(["Date", "Item", "Qty"])).toBe(headerSignature(["qty", "DATE", "item"]));
    expect(headerSignature(["Date", "Item"])).not.toBe(headerSignature(["Date", "Item", "Qty"]));
  });

  it("scores an exact synonym above a whole word above a substring", () => {
    const qty = SALES.fields.find((f) => f.key === "qty")!;
    expect(headerScore("Qty", qty)).toBeGreaterThan(headerScore("Qty sold here", qty));
    expect(headerScore("Qty sold here", qty)).toBeGreaterThan(headerScore("TotalQtyX", qty));
    expect(headerScore("Weather", qty)).toBe(0);
  });
});
