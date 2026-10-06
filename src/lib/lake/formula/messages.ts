/**
 * Every way a formula can be wrong, in each language the app speaks.
 *
 * A FormulaError carries a key from here and the parts that fill it in (a
 * column's name, the function it meant); its English message is built from
 * the same table, so there is one wording per error. The editor shows the
 * reader's own language (formulaErrorText); the API sends key and params
 * with the English text.
 *
 * A param whose name starts with "type" holds a type ("number", "text",
 * "date", "boolean", "any") and is shown as that type's word. Keys that
 * share a `code` are variants of one kind of error — the code is what
 * callers and tests branch on.
 *
 * Pure: the browser uses it as you type.
 */
import type { Locale } from "@/lib/i18n/dict";

type Entry = { code: string; en: string; th: string; zh: string };

const E = <T extends Record<string, Entry>>(t: T) => t;

export const FORMULA_ERRORS = E({
  bad_number: { code: "bad_number", en: `"{text}" isn't a number`, th: `"{text}" ไม่ใช่ตัวเลข`, zh: `"{text}" 不是数字` },
  open_text: { code: "open_text", en: "This text is missing its closing quote", th: "ข้อความนี้ขาดเครื่องหมายคำพูดปิด", zh: "这段文本缺少结尾的引号" },
  open_bracket: { code: "open_bracket", en: "A column name in [brackets] is missing its ]", th: "ชื่อคอลัมน์ใน [วงเล็บเหลี่ยม] ขาด ]", zh: "[方括号] 中的列名缺少 ]" },
  empty_bracket: { code: "empty_bracket", en: "[ ] needs a column name inside", th: "ต้องมีชื่อคอลัมน์อยู่ใน [ ]", zh: "[ ] 里需要写列名" },
  bad_char: { code: "bad_char", en: `"{char}" can't be used in a formula`, th: `ใช้ "{char}" ในสูตรไม่ได้`, zh: `公式中不能使用 "{char}"` },
  too_long: { code: "too_long", en: "A formula can be at most {max} characters", th: "สูตรยาวได้ไม่เกิน {max} ตัวอักษร", zh: "公式最多 {max} 个字符" },
  empty: { code: "empty", en: "Write a formula", th: "พิมพ์สูตร", zh: "请输入公式" },
  bad_column_name: { code: "bad_column_name", en: "Column name must match {pattern}", th: "ชื่อคอลัมน์ใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข และ _ และต้องขึ้นต้นด้วยตัวอักษรหรือ _ ({pattern})", zh: "列名只能包含英文字母、数字和 _，并以字母或 _ 开头（{pattern}）" },
  bad_new_column_name: { code: "bad_column_name", en: "New column name must match {pattern}", th: "ชื่อใหม่ของคอลัมน์ใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข และ _ และต้องขึ้นต้นด้วยตัวอักษรหรือ _ ({pattern})", zh: "新列名只能包含英文字母、数字和 _，并以字母或 _ 开头（{pattern}）" },
  used_by_formula: { code: "used_by_formulas", en: "{col} is used by the formula column {readers} — change or remove it first", th: "{col} ถูกใช้โดยคอลัมน์สูตร {readers} — แก้หรือลบคอลัมน์นั้นก่อน", zh: "{col} 被公式列 {readers} 使用——请先修改或删除它" },
  used_by_formulas: { code: "used_by_formulas", en: "{col} is used by the formula columns {readers} — change or remove them first", th: "{col} ถูกใช้โดยคอลัมน์สูตร {readers} — แก้หรือลบคอลัมน์เหล่านั้นก่อน", zh: "{col} 被公式列 {readers} 使用——请先修改或删除它们" },
  suggest_empty: { code: "suggest_empty", en: "Describe what the column should hold.", th: "อธิบายว่าคอลัมน์นี้ควรเก็บอะไร", zh: "请描述这一列应包含什么。" },
  suggest_cant: { code: "suggest_cant", en: "This table's columns can't give that.", th: "คอลัมน์ในตารางนี้ให้ค่านั้นไม่ได้", zh: "这张表的列无法得出该结果。" },
  too_deep: { code: "too_deep", en: "This formula nests too deeply", th: "สูตรนี้ซ้อนกันลึกเกินไป", zh: "此公式嵌套层数过多" },
  too_complex: { code: "too_complex", en: "This formula is too complex to work out — split it into two columns", th: "สูตรนี้ซับซ้อนเกินกว่าจะคำนวณได้ — แยกเป็นสองคอลัมน์", zh: "此公式过于复杂，无法计算——请拆成两列" },
  ends_early: { code: "ends_early", en: "The formula ends too early", th: "สูตรจบเร็วเกินไป", zh: "公式提前结束了" },
  stray_paren: { code: "stray_paren", en: "There's a ) without a matching (", th: "มี ) ที่ไม่มี ( คู่กัน", zh: "有一个 ) 没有对应的 (" },
  stray_comma: { code: "stray_comma", en: "A , is only used between a function's values", th: "ใช้ , คั่นค่าในฟังก์ชันเท่านั้น", zh: ", 只能用于分隔函数的参数" },
  stray_operator: { code: "stray_operator", en: `"{op}" needs a value on each side`, th: `"{op}" ต้องมีค่าทั้งสองข้าง`, zh: `"{op}" 两边都需要有值` },
  open_paren: { code: "open_paren", en: "Missing a closing )", th: "ขาด ) ปิด", zh: "缺少右括号 )" },
  open_paren_values: { code: "open_paren", en: "Too many values here, or a missing )", th: "มีค่ามากเกินไป หรือขาด )", zh: "这里的值太多，或缺少 )" },
  open_paren_operator: {
    code: "open_paren", en: "Missing a closing ) — or an operator between two values",
    th: "ขาด ) ปิด — หรือขาดเครื่องหมายระหว่างสองค่า", zh: "缺少右括号 ) — 或两个值之间缺少运算符",
  },
  unexpected: {
    code: "unexpected", en: "{what} is in an unexpected place — is an operator missing before it?",
    th: "{what} อยู่ผิดตำแหน่ง — ขาดเครื่องหมายก่อนหน้าหรือเปล่า?", zh: "{what} 出现的位置不对 — 前面是否缺少运算符？",
  },
  self_reference: { code: "self_reference", en: "A formula can't use its own column ({name})", th: "สูตรใช้คอลัมน์ของตัวเองไม่ได้ ({name})", zh: "公式不能使用它自己的列（{name}）" },
  unknown_column: { code: "unknown_column", en: "There's no column called {name}", th: "ไม่มีคอลัมน์ชื่อ {name}", zh: "没有名为 {name} 的列" },
  unknown_column_near: {
    code: "unknown_column", en: "There's no column called {name} — did you mean {near}?",
    th: "ไม่มีคอลัมน์ชื่อ {name} — หมายถึง {near} หรือเปล่า?", zh: "没有名为 {name} 的列 — 你是指 {near} 吗？",
  },
  circular: {
    code: "circular", en: "{col} is worked out from {self}, so {self} can't use it — that would go round in a circle",
    th: "{col} คำนวณจาก {self} อยู่แล้ว {self} จึงใช้ {col} ไม่ได้ — จะวนเป็นวงกลม", zh: "{col} 是由 {self} 算出的，所以 {self} 不能使用它 — 否则会形成循环",
  },
  col_not_number_text: {
    code: "type_mismatch", en: "{col} is a text column, so it can't be used as a number — if it holds numbers, change its type to number first",
    th: "{col} เป็นคอลัมน์ข้อความ จึงใช้เป็นตัวเลขไม่ได้ — ถ้าเก็บตัวเลขอยู่ ให้เปลี่ยนชนิดเป็นตัวเลขก่อน",
    zh: "{col} 是文本列，不能当作数字使用 — 如果里面是数字，请先把类型改为数字",
  },
  col_not_number_date: {
    code: "type_mismatch", en: "{col} is a date column, so it can't be used as a number — use DAYS(end_date, start_date) for the days between two dates",
    th: "{col} เป็นคอลัมน์วันที่ จึงใช้เป็นตัวเลขไม่ได้ — ใช้ DAYS(end_date, start_date) เพื่อหาจำนวนวันระหว่างสองวันที่",
    zh: "{col} 是日期列，不能当作数字使用 — 计算两个日期之间的天数请用 DAYS(end_date, start_date)",
  },
  col_not_number_boolean: {
    code: "type_mismatch", en: "{col} is a yes/no column, so it can't be used as a number",
    th: "{col} เป็นคอลัมน์ใช่/ไม่ใช่ จึงใช้เป็นตัวเลขไม่ได้", zh: "{col} 是“是/否”列，不能当作数字使用",
  },
  col_not_date: { code: "type_mismatch", en: "{col} is {type}, not a date", th: "{col} เป็น{type} ไม่ใช่วันที่", zh: "{col} 是{type}，不是日期" },
  col_not_test: {
    code: "type_mismatch", en: "{col} is {type}, not a yes/no test — compare it, like {col} > 0",
    th: "{col} เป็น{type} ไม่ใช่เงื่อนไขใช่/ไม่ใช่ — ให้เปรียบเทียบ เช่น {col} > 0", zh: "{col} 是{type}，不是“是/否”判断 — 请进行比较，例如 {col} > 0",
  },
  gives_wrong: {
    code: "type_mismatch", en: "This gives {typeA}, but {typeB} is needed here",
    th: "ส่วนนี้ให้ผลเป็น{typeA} แต่ตรงนี้ต้องการ{typeB}", zh: "这里得到的是{typeA}，但此处需要{typeB}",
  },
  bad_date: {
    code: "bad_date", en: `"{text}" isn't a date — write dates as "YYYY-MM-DD"`,
    th: `"{text}" ไม่ใช่วันที่ — เขียนวันที่แบบ "YYYY-MM-DD"`, zh: `"{text}" 不是日期 — 日期请写成 "YYYY-MM-DD"`,
  },
  text_arith: {
    code: "type_mismatch", en: "Text can't be used with {op} — use & to join texts",
    th: "ใช้ข้อความกับ {op} ไม่ได้ — ใช้ & เพื่อต่อข้อความ", zh: "文本不能与 {op} 一起使用 — 连接文本请用 &",
  },
  date_arith: {
    code: "type_mismatch", en: "Dates can't be used with {op} — use DAYS(end_date, start_date) for the days between two dates",
    th: "ใช้วันที่กับ {op} ไม่ได้ — ใช้ DAYS(end_date, start_date) เพื่อหาจำนวนวันระหว่างสองวันที่",
    zh: "日期不能与 {op} 一起使用 — 计算两个日期之间的天数请用 DAYS(end_date, start_date)",
  },
  test_arith: { code: "type_mismatch", en: "A yes/no test can't be used with {op}", th: "ใช้เงื่อนไขใช่/ไม่ใช่กับ {op} ไม่ได้", zh: "“是/否”判断不能与 {op} 一起使用" },
  cant_compare: { code: "type_mismatch", en: "Can't compare {typeA} with {typeB}", th: "เปรียบเทียบ{typeA}กับ{typeB}ไม่ได้", zh: "无法比较{typeA}和{typeB}" },
  changing_function: {
    code: "changing_function", en: "{fn}() changes on its own, so a column can't hold it — use it in a report instead",
    th: "{fn}() เปลี่ยนค่าไปเองได้ คอลัมน์จึงเก็บไม่ได้ — ให้ใช้ในรายงานแทน", zh: "{fn}() 的值会自己变化，列里不能保存它 — 请在报表中使用",
  },
  unknown_function: { code: "unknown_function", en: "There's no function called {fn}", th: "ไม่มีฟังก์ชันชื่อ {fn}", zh: "没有名为 {fn} 的函数" },
  unknown_function_near: {
    code: "unknown_function", en: "There's no function called {fn} — did you mean {near}?",
    th: "ไม่มีฟังก์ชันชื่อ {fn} — หมายถึง {near} หรือเปล่า?", zh: "没有名为 {fn} 的函数 — 你是指 {near} 吗？",
  },
  arity_one: { code: "arity", en: "{fn} takes 1 value: {sig}", th: "{fn} ต้องมี 1 ค่า: {sig}", zh: "{fn} 需要 1 个值：{sig}" },
  arity_exact: { code: "arity", en: "{fn} takes {n} values: {sig}", th: "{fn} ต้องมี {n} ค่า: {sig}", zh: "{fn} 需要 {n} 个值：{sig}" },
  arity_range: { code: "arity", en: "{fn} takes {min} or {max} values: {sig}", th: "{fn} ต้องมี {min} หรือ {max} ค่า: {sig}", zh: "{fn} 需要 {min} 或 {max} 个值：{sig}" },
  arity_min: { code: "arity", en: "{fn} takes {min} or more values: {sig}", th: "{fn} ต้องมีอย่างน้อย {min} ค่า: {sig}", zh: "{fn} 至少需要 {min} 个值：{sig}" },
  if_mixed: {
    code: "type_mismatch", en: "IF's two answers must be the same kind — here one is {typeA} and the other {typeB}",
    th: "ผลลัพธ์ทั้งสองของ IF ต้องเป็นชนิดเดียวกัน — ตอนนี้อันหนึ่งเป็น{typeA} อีกอันเป็น{typeB}",
    zh: "IF 的两个结果必须是同一类 — 这里一个是{typeA}，另一个是{typeB}",
  },
  values_mixed: {
    code: "type_mismatch", en: "{fn}'s values must be the same kind — here there's {typeA} and {typeB}",
    th: "ค่าต่างๆ ของ {fn} ต้องเป็นชนิดเดียวกัน — ตอนนี้มีทั้ง{typeA}และ{typeB}", zh: "{fn} 的各个值必须是同一类 — 这里有{typeA}也有{typeB}",
  },
});

export type FormulaErrorKey = keyof typeof FORMULA_ERRORS;
export type FormulaErrorParams = Record<string, string | number>;

/** A type as it reads inside a sentence. */
const TYPE_WORDS: Record<Locale, Record<string, string>> = {
  en: { number: "a number", text: "text", date: "a date", boolean: "a yes/no test", any: "a value" },
  th: { number: "ตัวเลข", text: "ข้อความ", date: "วันที่", boolean: "เงื่อนไขใช่/ไม่ใช่", any: "ค่า" },
  zh: { number: "数字", text: "文本", date: "日期", boolean: "“是/否”判断", any: "值" },
};

/** The error in `locale`. An unknown key (a newer server than this page) falls back to the English message given. */
export function formulaErrorText(locale: Locale, err: { key?: string; params?: FormulaErrorParams; message?: string }): string {
  const entry = err.key ? (FORMULA_ERRORS as Record<string, Entry>)[err.key] : undefined;
  if (!entry) return err.message ?? "";
  const words = TYPE_WORDS[locale] ?? TYPE_WORDS.en;
  return (entry[locale] ?? entry.en).replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = err.params?.[name];
    if (v === undefined) return m;
    return name.startsWith("type") ? (words[String(v)] ?? String(v)) : String(v);
  });
}

/** What each function does, for the editor's list — the English is FORMULA_FUNCTIONS' own. */
export const FORMULA_FUNCTION_DOCS: Record<"th" | "zh", Record<string, string>> = {
  th: {
    ROUND: "ปัดเศษตามจำนวนตำแหน่งทศนิยม (0 ถ้าไม่ระบุ)", ABS: "ตัวเลขโดยไม่มีเครื่องหมายบวกลบ",
    MIN: "ค่าที่น้อยที่สุด โดยไม่นับค่าว่าง", MAX: "ค่าที่มากที่สุด โดยไม่นับค่าว่าง",
    IF: "ค่าหนึ่งเมื่อเงื่อนไขเป็นจริง อีกค่าเมื่อไม่จริง", AND: "จริงเมื่อทุกเงื่อนไขจริง", OR: "จริงเมื่อมีเงื่อนไขใดจริง",
    NOT: "ตรงข้ามกับเงื่อนไข", ISBLANK: "จริงเมื่อค่าว่าง", COALESCE: "ค่าแรกที่ไม่ว่าง",
    YEAR: "ปีของวันที่", MONTH: "เดือนของวันที่ 1–12", DAY: "วันที่ของเดือน 1–31", DAYS: "จำนวนวันจากวันเริ่มถึงวันสิ้นสุด",
    LEFT: "ตัวอักษรช่วงต้นของข้อความ", RIGHT: "ตัวอักษรช่วงท้ายของข้อความ", UPPER: "เป็นตัวพิมพ์ใหญ่", LOWER: "เป็นตัวพิมพ์เล็ก",
    TRIM: "ตัดช่องว่างหัวท้าย", LEN: "จำนวนตัวอักษร", CONTAINS: "จริงเมื่อข้อความมีส่วนนั้นอยู่ ไม่สนตัวพิมพ์", CONCAT: "ต่อข้อความเข้าด้วยกัน (เหมือน &)",
  },
  zh: {
    ROUND: "四舍五入到指定的小数位数（省略则为 0）", ABS: "去掉正负号的数字",
    MIN: "最小值，忽略空值", MAX: "最大值，忽略空值",
    IF: "条件成立时取一个值，否则取另一个值", AND: "所有条件都成立时为真", OR: "任一条件成立时为真",
    NOT: "条件取反", ISBLANK: "值为空时为真", COALESCE: "第一个非空的值",
    YEAR: "日期的年份", MONTH: "日期的月份，1–12", DAY: "日期是当月第几天，1–31", DAYS: "从开始日期到结束日期的天数",
    LEFT: "文本开头的若干字符", RIGHT: "文本结尾的若干字符", UPPER: "转为大写", LOWER: "转为小写",
    TRIM: "去掉两端的空格", LEN: "字符数", CONTAINS: "文本包含该部分时为真，不区分大小写", CONCAT: "把文本连接起来（与 & 相同）",
  },
};
