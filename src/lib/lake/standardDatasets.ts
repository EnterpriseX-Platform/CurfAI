/**
 * Standard datasets — one fixed shape for a shop's sales and stock, whatever
 * point-of-sale system the file came from.
 *
 * A multi-branch owner's POS exports all differ: branch A's file has "Item,
 * Qty, Amt, Date", branch B's "product_name, quantity, total_thb, sold_at".
 * Imported as they are, each becomes its own table with its own column
 * names, and every "sales across all branches" view has to be hand-written
 * for that one customer. Mapped onto these definitions on the way in, every
 * file lands in the same two tables with the same columns, and everything
 * built on top — dashboards, stock alerts, run-out estimates, basket and
 * promotion analysis — works for every customer unchanged.
 *
 * The tables are ordinary Curf Tables (the tenant lake): reports, Master
 * Builder, watchers and Ask read them like any other. What makes them
 * "standard" is the mapping step that fills them (lib/lake/columnMapping.ts)
 * and the replace rule that keeps a re-uploaded period from counting twice
 * (see `replace` below and lib/lake/standardImport.ts).
 */

export type StandardDatasetId = "sales_lines" | "inventory";

export type StandardField = {
  /** Column name in the standard table. */
  key: string;
  type: "text" | "number" | "date";
  required?: boolean;
  /**
   * At least one field of the same group must be mapped (e.g. a line needs
   * an item code or an item name — either will do).
   */
  requiredGroup?: string;
  /**
   * The file can leave this out and the user types one value for every row
   * instead — a branch's own POS export rarely says which branch it is, and
   * a one-day summary ("item-sales-summary-2025-03-27-2025-03-27.csv") says
   * its date only in its name (columnMapping.ts's dateFromFilename offers it).
   */
  allowFixed?: boolean;
  /**
   * Filled in automatically when the file has no column for it but has
   * these fields (see makeRowMapper in columnMapping.ts) — so a required
   * field is satisfied by them, and the mapping step can say "worked out
   * from quantity × price".
   */
  derivedFrom?: string[];
  /**
   * Header spellings that mean this field, English and Thai. Compared after
   * normalizeHeader(). A leading "=" matches the whole header only — for
   * short or generic words ("cost", "total", "date") that would otherwise
   * claim any header containing them.
   */
  synonyms: string[];
};

export type StandardDataset = {
  id: StandardDatasetId;
  /** Table name in the lake — fixed, so everything built on it can rely on it. */
  tableName: string;
  fields: StandardField[];
  /**
   * How an import replaces what is already there, so the same export
   * uploaded twice — or a month re-exported with corrections — never
   * counts twice. Rows are never compared value by value: one receipt can
   * genuinely hold the same item on two identical lines.
   *   range: per partition value (branch), the dates from the file's
   *          earliest to latest day are replaced as a whole.
   *   exact: per partition value, exactly the dates present in the file.
   */
  replace: { kind: "range" | "exact"; dateField: string; partitionField: string };
};

export const SOURCE_FILE_COLUMN = "source_file";

export const STANDARD_DATASETS: Record<StandardDatasetId, StandardDataset> = {
  sales_lines: {
    id: "sales_lines",
    tableName: "sales_lines",
    replace: { kind: "range", dateField: "sale_date", partitionField: "branch" },
    fields: [
      { key: "sale_date", type: "date", required: true, allowFixed: true, synonyms: [
        "saledate", "salesdate", "orderdate", "transactiondate", "billdate", "receiptdate", "invoicedate", "soldat", "datetime", "createdat", "=date", "=day",
        "วันที่", "วันที่ขาย", "วันที่ทำรายการ", "วันที่สั่งซื้อ", "วันที่ออกบิล", "วันเวลา", "วันที่เวลา",
      ] },
      { key: "sale_time", type: "text", derivedFrom: ["sale_date"], synonyms: [
        "saletime", "ordertime", "transactiontime", "=time", "เวลา", "เวลาขาย",
      ] },
      { key: "branch", type: "text", required: true, allowFixed: true, synonyms: [
        "branch", "branchname", "store", "storename", "storeno", "storecode", "shop", "shopname", "outlet", "location", "site",
        "สาขา", "ชื่อสาขา", "รหัสสาขา", "ร้าน", "ชื่อร้าน",
      ] },
      { key: "receipt_id", type: "text", synonyms: [
        "receiptid", "receiptno", "receiptnumber", "receipt", "billno", "billid", "billnumber", "=bill", "orderid", "orderno", "ordernumber",
        "invoiceno", "invoicenumber", "invoice", "transactionid", "transactionno", "ticketno", "ticket",
        "เลขที่ใบเสร็จ", "ใบเสร็จ", "เลขที่บิล", "บิล", "เลขบิล", "เลขที่ออเดอร์", "ออเดอร์", "เลขที่ใบกำกับ",
      ] },
      { key: "sku", type: "text", requiredGroup: "item", synonyms: [
        "sku", "itemcode", "productcode", "productid", "itemid", "itemno", "productno", "prodnum", "prodcode", "barcode", "plu", "=code",
        "รหัสสินค้า", "รหัส", "บาร์โค้ด", "รหัสเมนู",
      ] },
      { key: "product", type: "text", requiredGroup: "item", synonyms: [
        "product", "productname", "itemname", "item", "menu", "menuname", "description", "prodname", "prod", "=name",
        "สินค้า", "ชื่อสินค้า", "รายการ", "รายการสินค้า", "เมนู", "ชื่อเมนู",
      ] },
      { key: "category", type: "text", synonyms: [
        "category", "categoryname", "productcategory", "class", "department", "dept", "productgroup", "itemgroup", "=group", "=cl", "=cat", "division", "=div",
        "หมวด", "หมวดหมู่", "หมวดสินค้า", "ประเภท", "ประเภทสินค้า", "กลุ่มสินค้า", "กลุ่ม",
      ] },
      { key: "qty", type: "number", required: true, synonyms: [
        "qty", "quantity", "qtysold", "soldqty", "units", "unitssold", "itemssold", "=count", "pcs",
        "จำนวน", "จำนวนชิ้น", "จำนวนที่ขาย", "สินค้าที่ขาย", "ปริมาณ", "ชิ้น",
      ] },
      { key: "unit_price", type: "number", synonyms: [
        "unitprice", "price", "sellingprice", "priceperunit", "=rate",
        "ราคา", "ราคาต่อหน่วย", "ราคาขาย", "ราคาชิ้นละ",
      ] },
      { key: "discount", type: "number", synonyms: [
        "discount", "discountamount", "disc", "linediscount",
        "ส่วนลด", "ส่วนลดรวม",
      ] },
      { key: "net_amount", type: "number", required: true, derivedFrom: ["qty", "unit_price"], synonyms: [
        "netamount", "netsales", "netsale", "net", "linetotal", "totalamount", "=total", "=amount", "salesamount", "revenue", "=sales", "totalthb", "amountthb", "=amt",
        "ยอดสุทธิ", "ยอดขาย", "ยอดขายสุทธิ", "ยอดรวม", "ยอดเงิน", "จำนวนเงิน", "รวมเงิน", "=รวม", "ราคารวม",
      ] },
      { key: "cost", type: "number", synonyms: [
        "cost", "costamount", "cogs", "totalcost", "linecost",
        "ต้นทุน", "ต้นทุนรวม",
      ] },
      { key: "payment_method", type: "text", synonyms: [
        "paymentmethod", "paymenttype", "payment", "tender", "paidby", "paymentchannel",
        "วิธีชำระ", "วิธีชำระเงิน", "ชำระโดย", "ช่องทางชำระ", "ประเภทการชำระ",
      ] },
      { key: "channel", type: "text", synonyms: [
        "channel", "saleschannel", "ordertype", "ordersource", "platform",
        "ช่องทาง", "ช่องทางขาย", "ประเภทออเดอร์", "ประเภทการขาย",
      ] },
      { key: "promo_code", type: "text", synonyms: [
        "promotion", "promo", "promocode", "promotioncode", "campaign", "coupon", "couponcode", "voucher",
        "โปรโมชั่น", "โปรโมชัน", "โปร", "คูปอง", "รหัสโปรโมชั่น", "รหัสโปรโมชัน", "โค้ดโปรโมชั่น", "โค้ดโปรโมชัน", "โค้ดโปร", "โค้ดส่วนลด", "รหัสคูปอง",
      ] },
    ],
  },
  inventory: {
    id: "inventory",
    tableName: "inventory",
    replace: { kind: "exact", dateField: "snapshot_date", partitionField: "branch" },
    fields: [
      { key: "snapshot_date", type: "date", required: true, allowFixed: true, synonyms: [
        "snapshotdate", "stockdate", "asof", "asofdate", "inventorydate", "countdate", "daysid", "=date", "=day",
        "วันที่", "ณวันที่", "วันที่ข้อมูล", "วันที่นับสต็อก",
      ] },
      { key: "branch", type: "text", required: true, allowFixed: true, synonyms: [
        "branch", "branchname", "store", "storename", "storeno", "storecode", "shop", "outlet", "warehouse", "location", "site",
        "สาขา", "ชื่อสาขา", "รหัสสาขา", "คลัง", "คลังสินค้า", "ร้าน",
      ] },
      { key: "sku", type: "text", requiredGroup: "item", synonyms: [
        "sku", "itemcode", "productcode", "productid", "itemid", "itemno", "productno", "prodnum", "prodcode", "barcode", "=code",
        "รหัสสินค้า", "รหัส", "บาร์โค้ด",
      ] },
      { key: "product", type: "text", requiredGroup: "item", synonyms: [
        "product", "productname", "itemname", "item", "description", "prodname", "prod", "=name",
        "สินค้า", "ชื่อสินค้า", "รายการ", "รายการสินค้า",
      ] },
      { key: "category", type: "text", synonyms: [
        "category", "categoryname", "productcategory", "class", "department", "dept", "productgroup", "itemgroup", "=group", "=cl", "=cat", "division", "=div",
        "หมวด", "หมวดหมู่", "หมวดสินค้า", "ประเภท", "ประเภทสินค้า", "กลุ่มสินค้า", "กลุ่ม",
      ] },
      { key: "on_hand", type: "number", required: true, synonyms: [
        "onhand", "qtyonhand", "onhandqty", "sohqty", "soh", "stockqty", "stockonhand", "stock", "balance", "balanceqty", "inventoryqty", "=qty", "=quantity",
        "คงเหลือ", "จำนวนคงเหลือ", "ยอดคงเหลือ", "สต็อก", "สต๊อก", "สต็อกคงเหลือ", "สินค้าคงเหลือ",
      ] },
      { key: "stock_value", type: "number", derivedFrom: ["on_hand", "unit_cost"], synonyms: [
        "stockvalue", "inventoryvalue", "sohcost", "sohvalue", "sohcostamt", "stockcost", "costamount", "totalcost", "=value", "=amount",
        "มูลค่า", "มูลค่าสต็อก", "มูลค่าคงเหลือ", "มูลค่าสินค้าคงเหลือ", "ต้นทุนรวม",
      ] },
      { key: "unit_cost", type: "number", synonyms: [
        "unitcost", "costperunit", "avgcost", "averagecost", "=cost",
        "ต้นทุนต่อหน่วย", "ต้นทุนเฉลี่ย", "=ต้นทุน",
      ] },
      { key: "reorder_point", type: "number", synonyms: [
        "reorderpoint", "reorderlevel", "minstock", "minqty", "safetystock", "=min",
        "จุดสั่งซื้อ", "สต็อกขั้นต่ำ", "จำนวนขั้นต่ำ",
      ] },
      { key: "lead_time_days", type: "number", synonyms: [
        "leadtime", "leadtimedays", "leaddays",
        "ระยะเวลาสั่งซื้อ", "ระยะเวลารอสินค้า",
      ] },
      // What an ERP stock export often carries already. Used for stock
      // cover and slow movers when the workspace has no sales lines to
      // work them out from (lib/lake/retailMetrics.ts) — sales lines win
      // when there are some.
      { key: "avg_daily_sales", type: "number", synonyms: [
        "avgdailysales", "avgsalesqty", "averagedailysales", "dailysales", "avgsales", "salesperday", "avgdailyqty",
        "ยอดขายเฉลี่ยต่อวัน", "ขายเฉลี่ยต่อวัน", "ยอดขายเฉลี่ย",
      ] },
      { key: "last_sold_date", type: "date", synonyms: [
        "lastsold", "lastsolddate", "lastsale", "lastsaledate", "lastsolddt",
        "ขายล่าสุด", "วันที่ขายล่าสุด", "วันขายล่าสุด",
      ] },
      { key: "last_received_date", type: "date", synonyms: [
        "lastreceived", "lastreceiveddate", "lastreceipt", "lastgr", "lastgrdate", "lastinbound",
        "รับเข้าล่าสุด", "วันที่รับเข้าล่าสุด", "รับล่าสุด",
      ] },
    ],
  },
};

export function isStandardDatasetId(v: unknown): v is StandardDatasetId {
  return v === "sales_lines" || v === "inventory";
}

/** Every column the standard table holds, in order: its fields, then where each row came from. */
export function standardColumns(ds: StandardDataset): Array<{ name: string; type: StandardField["type"] }> {
  return [...ds.fields.map((f) => ({ name: f.key, type: f.type })), { name: SOURCE_FILE_COLUMN, type: "text" as const }];
}
