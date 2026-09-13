import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HelpCircle, Info } from "lucide-react";
import { BlockType } from "@/lib/reporting/schema";
import { useT } from "@/lib/i18n/LocaleContext";
import { Locale } from "@/lib/i18n/dict";

type GuideItem = { label: string; text: string };
type GuideContent = { title: string; desc: string; items: GuideItem[]; defaultItems?: GuideItem[] };
type GuidesByLocale = Record<Locale, Partial<Record<BlockType | "default", GuideContent>>>;

const GUIDES: GuidesByLocale = {
  th: {
    kpi: {
      title: "KPI (Key Performance Indicator)",
      desc: "ใช้แสดงตัวเลขสำคัญเพียงค่าเดียว เช่น ยอดขายรวม, จำนวนผู้ใช้งาน",
      items: [
        { label: "Query ID", text: "เลือกข้อมูลที่ต้องการนำมาแสดงผล" },
        { label: "Label", text: "ชื่อหัวข้อที่จะแสดงด้านบนของตัวเลข" },
        { label: "Value Field", text: "คอลัมน์ที่ต้องการนำมาแสดงผลเป็นตัวเลขหลัก" },
        { label: "Format", text: "รูปแบบการแสดงผล (ตัวเลข, สกุลเงิน, เปอร์เซ็นต์)" },
        { label: "Compare Field", text: "คอลัมน์ที่ใช้เทียบค่า (เช่น ค่าของเดือนก่อน) เพื่อแสดงการเติบโตเป็นเปอร์เซ็นต์" },
        { label: "Prefix / Suffix", text: "คำนำหน้าหรือต่อท้ายตัวเลข (เช่น ฿, USD)" },
        { label: "Spark Positive", text: "ทิศทางของกราฟเล็กๆ (Sparkline) ที่ถือว่าเป็นแง่บวก (Up = เพิ่มขึ้นดี, Down = ลดลงดี)" },
        { label: "Aggregate", text: "หากข้อมูลมีหลายแถว สามารถเลือกวิธีการรวมค่าได้ (ผลรวม, ค่าเฉลี่ย, จำนวน, ค่าน้อยสุด/มากสุด)" },
      ],
    },
    chart: {
      title: "Chart (กราฟ)",
      desc: "ใช้แสดงข้อมูลในรูปแบบของกราฟแท่ง, เส้น, พื้นที่, วงกลม หรือมาตรวัด",
      items: [
        { label: "Query ID", text: "เลือกข้อมูลที่ต้องการนำมาแสดงผล" },
        { label: "Title / Subtitle", text: "หัวข้อและคำบรรยายของกราฟ" },
        { label: "Chart Type", text: "เลือกประเภทกราฟ (Bar, Line, Area, Scatter, Pie ฯลฯ)" },
        { label: "X Field", text: "คอลัมน์สำหรับแกนแนวนอน (แกน X) เช่น เดือน, วันที่, หมวดหมู่" },
        { label: "Y Field", text: "คอลัมน์สำหรับแกนแนวตั้ง (แกน Y) ที่ใช้แสดงค่า เช่น ยอดขาย, ปริมาณ" },
        { label: "Series Field", text: "ใช้สำหรับแบ่งกลุ่มข้อมูลให้แสดงกราฟหลายเส้น หรือแบ่งสี (เช่น ยอดขายแยกตามสาขา)" },
        { label: "Sort By / Sort Order", text: "การเรียงลำดับข้อมูล (เรียงตามแกน X, แกน Y หรือไม่มีการเรียง)" },
        { label: "Stack", text: "หากมี Series สามารถเลือกให้กราฟแท่งหรือพื้นที่ซ้อนทับกัน (Stacked) ได้" },
        { label: "Show Legend / Grid", text: "แสดง/ซ่อนคำอธิบายสัญลักษณ์และเส้นตารางพื้นหลัง" },
        { label: "Color Palette", text: "เลือกโทนสีกราฟที่ต้องการ" },
        { label: "Goal Line / Goal Label", text: "เพิ่มเส้นเป้าหมาย (เส้นแนวนอน) เพื่อเทียบกับค่าจริง" },
        { label: "Trendline", text: "เพิ่มเส้นแนวโน้ม (เช่น Linear) เพื่อวิเคราะห์ทิศทาง" },
        { label: "AI Caption", text: "เปิดใช้ AI วิเคราะห์และอธิบายสรุปข้อมูลจากกราฟอัตโนมัติ" },
        { label: "Actions (JSON)", text: "ใส่ค่า JSON เพื่อสร้างปุ่มหรือฟีเจอร์โต้ตอบพิเศษบนกราฟ" },
      ],
    },
    table: {
      title: "Table (ตาราง)",
      desc: "ใช้แสดงข้อมูลในรูปแบบแถวและคอลัมน์เหมือนสเปรดชีต",
      items: [
        { label: "Query ID", text: "เลือกข้อมูลที่ต้องการนำมาแสดงผล" },
        { label: "Title", text: "หัวข้อของตารางที่จะแสดงด้านบน" },
        { label: "Columns", text: "กด Auto-generate columns เพื่อสร้างคอลัมน์ตามข้อมูล คุณสามารถแก้ไขหัวคอลัมน์, จัดตำแหน่งซ้าย-ขวา, เปลี่ยน Format หรือตั้งค่าการรวมยอด (Total) ในส่วนนี้" },
        { label: "Page Size", text: "จำนวนแถวสูงสุดที่จะแสดงต่อ 1 หน้า (หากเกินจะมีปุ่มเปลี่ยนหน้า)" },
        { label: "Stripe", text: "สลับสีพื้นหลังตารางแถวเว้นแถวให้อ่านง่ายขึ้น" },
        { label: "Show Totals", text: "เปิดแสดงผลรวม (Total) ที่ด้านล่างของตาราง (ต้องตั้งค่าใน Columns ด้วย)" },
        { label: "Actions (JSON)", text: "ใส่ค่า JSON เพื่อสร้างปุ่มทำงานพิเศษในแต่ละแถว" },
      ],
    },
    progress: {
      title: "Progress Bar",
      desc: "ใช้แสดงความคืบหน้า หรือร้อยละของเป้าหมาย",
      items: [
        { label: "Query ID", text: "เลือกข้อมูลหากต้องการดึงค่าอัตโนมัติ (ข้ามได้ถ้าต้องการกรอกตัวเลขเอง)" },
        { label: "Label", text: "ชื่อหัวข้อของแถบความคืบหน้า" },
        { label: "Value Field", text: "หากเลือก Query ให้ระบุคอลัมน์ที่มีค่าที่ต้องการ" },
        { label: "Value", text: "กรอกค่าตัวเลขความคืบหน้า (0-100) ในกรณีที่ไม่ได้เลือก Query ID" },
        { label: "Show Percent", text: "แสดงตัวเลขเปอร์เซ็นต์กำกับด้านข้างหลอดความคืบหน้า" },
        { label: "Color", text: "เลือกสีของแถบความคืบหน้าให้ตรงกับความหมาย" },
      ],
    },
    pivot: {
      title: "Pivot Table",
      desc: "ใช้สรุปและวิเคราะห์ข้อมูลแบบหลายมิติ",
      items: [
        { label: "Query ID", text: "เลือกข้อมูลหลัก" },
        { label: "Title", text: "หัวข้อของ Pivot Table" },
        { label: "Row Field", text: "คอลัมน์ที่จะใช้จัดกลุ่มในแนวแถว (แนวแกน Y)" },
        { label: "Col Field", text: "คอลัมน์ที่จะใช้จัดกลุ่มในแนวคอลัมน์ (แนวแกน X แนวนอน)" },
        { label: "Value Field", text: "ค่าตัวเลขที่ต้องการนำมาสรุปผลในแต่ละช่อง" },
        { label: "Aggregation", text: "วิธีการสรุปผล เช่น Sum (ผลรวม), Avg (ค่าเฉลี่ย), Count (นับจำนวน)" },
        { label: "Format", text: "รูปแบบการแสดงผลของตัวเลข (ตัวเลข, สกุลเงิน, เปอร์เซ็นต์)" },
      ],
    },
    heatmap: {
      title: "Heatmap",
      desc: "แสดงความหนาแน่นของข้อมูลด้วยเฉดสี",
      items: [
        { label: "Query ID", text: "เลือกข้อมูลหลัก" },
        { label: "Title / Subtitle", text: "หัวข้อและคำบรรยายของ Heatmap" },
        { label: "Mode", text: "รูปแบบการแสดงผล Calendar (ตารางปฏิทิน) หรือ Grid (ตารางแนว x/y ทั่วไป)" },
        { label: "Date Field (Calendar mode)", text: "คอลัมน์วันที่สำหรับแสดงข้อมูลลงในปฏิทิน" },
        { label: "Value Field", text: "คอลัมน์ค่าตัวเลขที่จะกำหนดความเข้มของสี ยิ่งค่ามากสีจะยิ่งเข้ม" },
      ],
    },
    map: {
      title: "Map (แผนที่)",
      desc: "แสดงผลรวมข้อมูลตามแต่ละพื้นที่ทางภูมิศาสตร์ด้วยความเข้มสี",
      items: [
        { label: "Query ID", text: "เลือกข้อมูลที่จะมาแสดงบนแผนที่" },
        { label: "Title / Subtitle", text: "หัวข้อและคำบรรยายของแผนที่" },
        { label: "Region Type", text: "ระดับของภูมิภาค เช่น Country (ระดับประเทศ) หรือ US-State (รัฐในอเมริกา)" },
        { label: "Region Field", text: "คอลัมน์ในข้อมูลที่ระบุรหัสประเทศ (ISO-3) หรือรหัสรัฐ" },
        { label: "Value Field", text: "คอลัมน์ค่าตัวเลขที่ต้องการให้แสดงผลเป็นสี ยิ่งค่ามากสียิ่งเข้ม" },
        { label: "Aggregation", text: "วิธีสรุปผลในกรณีที่มีหลายแถวซ้ำกันในภูมิภาคเดียวกัน (Sum, Avg, Count)" },
        { label: "Format", text: "รูปแบบตัวเลข (ตัวเลขปกติ, ย่อแบบ k/M, สกุลเงิน, เปอร์เซ็นต์)" },
        { label: "Ramp", text: "โทนสีแผนที่" },
      ],
    },
    cohort_retention: {
      title: "Cohort Retention",
      desc: "แสดงอัตราการคงอยู่ของกลุ่มผู้ใช้ในช่วงเวลาต่างๆ (Retention Chart)",
      items: [
        { label: "Query ID", text: "เลือกข้อมูล" },
        { label: "Title / Subtitle", text: "หัวข้อและคำบรรยาย" },
        { label: "Cohort Field", text: "คอลัมน์ชื่อกลุ่มอ้างอิงเริ่มต้น (เช่น เดือนที่เริ่มใช้งาน: Jan 2024)" },
        { label: "Period Field", text: "คอลัมน์ระยะเวลาถัดมา (เช่น เดือนที่ 1, เดือนที่ 2)" },
        { label: "Retention Field", text: "คอลัมน์อัตราการคงอยู่ (ค่าที่จะแสดงในช่อง)" },
        { label: "Cohort Size Field", text: "คอลัมน์ขนาดตั้งต้นของกลุ่ม (เช่น 1,500 คน)" },
        { label: "Cell Format", text: "รูปแบบแสดงผลในตาราง (เปอร์เซ็นต์ หรือ จำนวนเต็ม)" },
      ],
    },
    funnel: {
      title: "Funnel",
      desc: "แสดงการกรองข้อมูลแบบเป็นลำดับขั้น (Conversion Funnel)",
      items: [
        { label: "Query ID", text: "เลือกข้อมูล" },
        { label: "Title / Subtitle", text: "หัวข้อและคำบรรยาย" },
        { label: "Step Field", text: "คอลัมน์ชื่อขั้นตอน (เช่น Visit, Signup, Purchase)" },
        { label: "Reached Field", text: "จำนวนคนที่เข้ามาถึงในขั้นตอนนี้" },
        { label: "Conversion From Prior Field", text: "(Optional) อัตราการแปลงจากขั้นตอนก่อนหน้า" },
        { label: "Conversion From Top Field", text: "(Optional) อัตราการแปลงจากขั้นตอนแรกสุด" },
      ],
    },
    title: {
      title: "Title (หัวข้อ)",
      desc: "กล่องสำหรับใส่ข้อความหัวเรื่องขนาดใหญ่",
      items: [
        { label: "Text", text: "ข้อความหัวเรื่องหลัก" },
        { label: "Subtitle", text: "ข้อความอธิบายรอง" },
        { label: "Align", text: "การจัดตำแหน่งซ้าย, กลาง, ขวา" },
      ],
    },
    text: {
      title: "Text (ข้อความบรรยาย)",
      desc: "กล่องสำหรับใส่ข้อความย่อหน้าทั่วไป",
      items: [
        { label: "Text", text: "ข้อความหรือเนื้อหารายละเอียดต่างๆ" },
        { label: "Align", text: "การจัดตำแหน่งซ้าย, กลาง, ขวา" },
        { label: "Size", text: "ขนาดตัวอักษร (Small, Medium, Large)" },
      ],
    },
    image: {
      title: "Image (รูปภาพ)",
      desc: "แสดงรูปภาพประกอบในรายงาน",
      items: [
        { label: "Source (URL)", text: "ลิงก์ที่อยู่ของรูปภาพที่ต้องการให้แสดง" },
        { label: "Alt Text", text: "ข้อความอธิบายรูปภาพ (แสดงตอนภาพไม่โหลด)" },
        { label: "Fit", text: "การจัดวางรูปภาพ (Contain=พอดีกรอบ, Cover=เต็มกรอบ, Fill=ยืดตามกรอบ)" },
      ],
    },
    divider: {
      title: "Divider (เส้นแบ่ง)",
      desc: "เพิ่มเส้นคั่นระหว่างเนื้อหาเพื่อความเป็นระเบียบ",
      items: [
        { label: "Style", text: "รูปแบบของเส้น (เส้นทึบ, เส้นประ, เส้นจุด)" },
        { label: "Thickness", text: "ความหนาของเส้นเป็นพิกเซล (1-8px)" },
      ],
    },
    callout: {
      title: "Callout (กล่องข้อความเตือน)",
      desc: "กล่องเน้นข้อความสำหรับข้อความสำคัญ หรือคำเตือน",
      items: [
        { label: "Variant", text: "ประเภทความสำคัญ (Info=ข้อมูล, Success=สำเร็จ, Warning=เตือน, Danger=อันตราย)" },
        { label: "Title", text: "หัวข้อของกล่องข้อความเตือน" },
        { label: "Body", text: "เนื้อหาภายในกล่องเตือน" },
      ],
    },
    pageBreak: {
      title: "Page Break (ขึ้นหน้าใหม่)",
      desc: "เมื่อผู้ใช้อ่านรายงานหรือส่งออกเป็น PDF เนื้อหาหลังจากบล็อกนี้จะถูกปัดขึ้นหน้าใหม่เสมอ",
      items: [],
    },
    default: {
      title: "Block Guide",
      desc: "บล็อกนี้มีไว้สำหรับปรับแต่งหน้าตาหรือข้อความทั่วไป สามารถปรับการตั้งค่าใน Property Panel ด้านขวาเพื่อดูการเปลี่ยนแปลงบนหน้ากระดาษได้ทันที",
      items: [],
    }
  },
  en: {
    kpi: {
      title: "KPI (Key Performance Indicator)",
      desc: "Displays a single important metric, such as Total Sales or Active Users.",
      items: [
        { label: "Query ID", text: "Select the data source query for this KPI." },
        { label: "Label", text: "The title displayed above the number." },
        { label: "Value Field", text: "The data column containing the main metric value." },
        { label: "Format", text: "Number formatting (Number, Currency, Percent)." },
        { label: "Compare Field", text: "Column for comparison (e.g., previous month) to show growth percentage." },
        { label: "Prefix / Suffix", text: "Text prepended or appended to the number (e.g., $, USD)." },
        { label: "Spark Positive", text: "Which sparkline direction is considered positive (Up = good, Down = good)." },
        { label: "Aggregate", text: "Method to aggregate multiple rows (Sum, Avg, Count, Min, Max)." },
      ],
    },
    chart: {
      title: "Chart",
      desc: "Visualizes data as bars, lines, areas, pie charts, or gauges.",
      items: [
        { label: "Query ID", text: "Select the data source query for this chart." },
        { label: "Title / Subtitle", text: "Chart title and description." },
        { label: "Chart Type", text: "Select the chart style (Bar, Line, Area, Scatter, Pie, etc.)." },
        { label: "X Field", text: "Column for the horizontal X-axis (e.g., Date, Category)." },
        { label: "Y Field", text: "Column for the vertical Y-axis values." },
        { label: "Series Field", text: "Column to group data into multiple lines or colored bars." },
        { label: "Sort By / Sort Order", text: "How to sort the X-axis categories." },
        { label: "Stack", text: "Whether to stack bars or areas on top of each other." },
        { label: "Show Legend / Grid", text: "Toggle the visibility of the legend and background grid lines." },
        { label: "Color Palette", text: "Choose the color theme for the chart series." },
        { label: "Goal Line / Goal Label", text: "Add a horizontal reference line for targets." },
        { label: "Trendline", text: "Add a trendline (e.g., Linear) to visualize direction." },
        { label: "AI Caption", text: "Enable AI-generated summary and analysis of the chart's data." },
        { label: "Actions (JSON)", text: "JSON config to add interactive buttons to the chart." },
      ],
    },
    table: {
      title: "Table",
      desc: "Displays data in a spreadsheet-like row and column format.",
      items: [
        { label: "Query ID", text: "Select the data source query." },
        { label: "Title", text: "Title displayed above the table." },
        { label: "Columns", text: "Click Auto-generate to create columns. You can edit headers, alignment, formatting, and totals here." },
        { label: "Page Size", text: "Maximum rows per page before pagination." },
        { label: "Stripe", text: "Alternate row background colors for readability." },
        { label: "Show Totals", text: "Show a summary footer row (requires configuration in Columns)." },
        { label: "Actions (JSON)", text: "JSON config to add action buttons to each row." },
      ],
    },
    progress: {
      title: "Progress Bar",
      desc: "Shows progress towards a goal or a percentage value.",
      items: [
        { label: "Query ID", text: "Select data source (optional if entering Value manually)." },
        { label: "Label", text: "Title of the progress bar." },
        { label: "Value Field", text: "Column containing the progress value." },
        { label: "Value", text: "Manual progress value (0-100) if no Query ID is selected." },
        { label: "Show Percent", text: "Display the percentage number next to the bar." },
        { label: "Color", text: "Color of the progress indicator." },
      ],
    },
    pivot: {
      title: "Pivot Table",
      desc: "Summarizes and analyzes multi-dimensional data.",
      items: [
        { label: "Query ID", text: "Select the main data source." },
        { label: "Title", text: "Title of the pivot table." },
        { label: "Row Field", text: "Column to group by rows (Y-axis)." },
        { label: "Col Field", text: "Column to group by columns (X-axis)." },
        { label: "Value Field", text: "Numeric column to summarize in cells." },
        { label: "Aggregation", text: "Summary method (Sum, Avg, Count, etc.)." },
        { label: "Format", text: "Number formatting (Number, Currency, Percent)." },
      ],
    },
    heatmap: {
      title: "Heatmap",
      desc: "Displays data density using color intensity.",
      items: [
        { label: "Query ID", text: "Select the main data source." },
        { label: "Title / Subtitle", text: "Heatmap title and description." },
        { label: "Mode", text: "Display as a Calendar or a standard X/Y Grid." },
        { label: "Date Field", text: "(Calendar mode) Date column for the calendar grid." },
        { label: "Value Field", text: "Numeric column that determines color intensity." },
      ],
    },
    map: {
      title: "Map",
      desc: "Displays aggregated data on geographical regions using choropleth colors.",
      items: [
        { label: "Query ID", text: "Select the data source." },
        { label: "Title / Subtitle", text: "Map title and description." },
        { label: "Region Type", text: "Geographic level (Country or US-State)." },
        { label: "Region Field", text: "Column containing region codes (e.g., ISO-3 or state initials)." },
        { label: "Value Field", text: "Numeric column that determines color intensity." },
        { label: "Aggregation", text: "How to summarize multiple rows in the same region (Sum, Avg, Count)." },
        { label: "Format", text: "Number formatting (Compact, Currency, Percent)." },
        { label: "Ramp", text: "Color palette theme for the map." },
      ],
    },
    cohort_retention: {
      title: "Cohort Retention",
      desc: "Displays user retention over time (Retention Chart).",
      items: [
        { label: "Query ID", text: "Select the data source." },
        { label: "Title / Subtitle", text: "Chart title and description." },
        { label: "Cohort Field", text: "Column for the starting cohort group (e.g., Jan 2024)." },
        { label: "Period Field", text: "Column for the subsequent periods (e.g., Month 1, Month 2)." },
        { label: "Retention Field", text: "Column containing the retention metric for the cell." },
        { label: "Cohort Size Field", text: "Column for the initial cohort size." },
        { label: "Cell Format", text: "Format of the cell values (Percent or Count)." },
      ],
    },
    funnel: {
      title: "Funnel",
      desc: "Displays conversion rates across sequential steps.",
      items: [
        { label: "Query ID", text: "Select the data source." },
        { label: "Title / Subtitle", text: "Funnel title and description." },
        { label: "Step Field", text: "Column containing the step names (e.g., Visit, Signup)." },
        { label: "Reached Field", text: "Number of users who reached the step." },
        { label: "Conversion From Prior Field", text: "(Optional) Conversion rate from the previous step." },
        { label: "Conversion From Top Field", text: "(Optional) Conversion rate from the very first step." },
      ],
    },
    title: {
      title: "Title",
      desc: "Large heading text block.",
      items: [
        { label: "Text", text: "Main heading text." },
        { label: "Subtitle", text: "Secondary description text." },
        { label: "Align", text: "Text alignment (Left, Center, Right)." },
      ],
    },
    text: {
      title: "Text",
      desc: "Standard paragraph text block.",
      items: [
        { label: "Text", text: "The paragraph content." },
        { label: "Align", text: "Text alignment (Left, Center, Right)." },
        { label: "Size", text: "Font size (Small, Medium, Large)." },
      ],
    },
    image: {
      title: "Image",
      desc: "Displays an image in the report.",
      items: [
        { label: "Source (URL)", text: "Link to the image file." },
        { label: "Alt Text", text: "Alternative text for accessibility." },
        { label: "Fit", text: "How the image fills its container (Contain, Cover, Fill)." },
      ],
    },
    divider: {
      title: "Divider",
      desc: "A horizontal line to separate content.",
      items: [
        { label: "Style", text: "Line style (Solid, Dashed, Dotted)." },
        { label: "Thickness", text: "Line thickness in pixels (1-8px)." },
      ],
    },
    callout: {
      title: "Callout",
      desc: "A highlighted box for important messages or warnings.",
      items: [
        { label: "Variant", text: "Visual style (Info, Success, Warning, Danger)." },
        { label: "Title", text: "Heading of the callout." },
        { label: "Body", text: "Main text content." },
      ],
    },
    pageBreak: {
      title: "Page Break",
      desc: "Forces subsequent content to a new page when exported to PDF.",
      items: [],
    },
    default: {
      title: "Block Guide",
      desc: "This block is used for layout or generic display. You can adjust its settings in the Property Panel on the right to see immediate changes on the canvas.",
      items: [],
    }
  },
  zh: {
    kpi: {
      title: "KPI (关键绩效指标)",
      desc: "显示一个重要指标，例如总销售额或活跃用户数。",
      items: [
        { label: "Query ID", text: "选择此 KPI 的数据源查询。" },
        { label: "Label", text: "显示在数字上方的标题。" },
        { label: "Value Field", text: "包含主要指标值的数据列。" },
        { label: "Format", text: "数字格式 (数字, 货币, 百分比)。" },
        { label: "Compare Field", text: "用于比较的列 (例如上个月) 以显示增长百分比。" },
        { label: "Prefix / Suffix", text: "数字前缀或后缀 (例如 $, USD)。" },
        { label: "Spark Positive", text: "迷你图的正向趋势 (上升 = 好, 下降 = 好)。" },
        { label: "Aggregate", text: "汇总多行的方法 (求和, 平均, 计数, 最小, 最大)。" },
      ],
    },
    chart: {
      title: "Chart (图表)",
      desc: "以柱状图、折线图、面积图、饼图或仪表盘等形式可视化数据。",
      items: [
        { label: "Query ID", text: "选择此图表的数据源查询。" },
        { label: "Title / Subtitle", text: "图表标题和描述。" },
        { label: "Chart Type", text: "选择图表样式 (柱状图, 折线图, 面积图, 散点图, 饼图等)。" },
        { label: "X Field", text: "水平 X 轴的列 (例如 日期, 类别)。" },
        { label: "Y Field", text: "垂直 Y 轴的值的列。" },
        { label: "Series Field", text: "用于将数据分组为多条线或彩色柱的列。" },
        { label: "Sort By / Sort Order", text: "如何对 X 轴类别进行排序。" },
        { label: "Stack", text: "是否将柱或面积堆叠在一起。" },
        { label: "Show Legend / Grid", text: "切换图例和背景网格线的可见性。" },
        { label: "Color Palette", text: "选择图表系列的主题颜色。" },
        { label: "Goal Line / Goal Label", text: "添加目标的水平参考线。" },
        { label: "Trendline", text: "添加趋势线 (例如 线性) 以可视化方向。" },
        { label: "AI Caption", text: "启用 AI 生成的图表数据摘要和分析。" },
        { label: "Actions (JSON)", text: "用于向图表添加交互式按钮的 JSON 配置。" },
      ],
    },
    table: {
      title: "Table (表格)",
      desc: "以类似电子表格的行列格式显示数据。",
      items: [
        { label: "Query ID", text: "选择数据源查询。" },
        { label: "Title", text: "显示在表格上方的标题。" },
        { label: "Columns", text: "点击自动生成列。您可以在此处编辑标题、对齐方式、格式和总计。" },
        { label: "Page Size", text: "分页前的每页最大行数。" },
        { label: "Stripe", text: "交替行背景颜色以提高可读性。" },
        { label: "Show Totals", text: "显示摘要页脚行 (需要在 Columns 中配置)。" },
        { label: "Actions (JSON)", text: "用于向每行添加操作按钮的 JSON 配置。" },
      ],
    },
    progress: {
      title: "Progress Bar (进度条)",
      desc: "显示实现目标的进度或百分比值。",
      items: [
        { label: "Query ID", text: "选择数据源 (如果手动输入值则可选)。" },
        { label: "Label", text: "进度条的标题。" },
        { label: "Value Field", text: "包含进度值的列。" },
        { label: "Value", text: "如果没有选择 Query ID，则为手动进度值 (0-100)。" },
        { label: "Show Percent", text: "在进度条旁边显示百分比数字。" },
        { label: "Color", text: "进度指示器的颜色。" },
      ],
    },
    pivot: {
      title: "Pivot Table (数据透视表)",
      desc: "汇总和分析多维数据。",
      items: [
        { label: "Query ID", text: "选择主数据源。" },
        { label: "Title", text: "数据透视表的标题。" },
        { label: "Row Field", text: "按行分组的列 (Y 轴)。" },
        { label: "Col Field", text: "按列分组的列 (X 轴)。" },
        { label: "Value Field", text: "要在单元格中汇总的数字列。" },
        { label: "Aggregation", text: "汇总方法 (求和, 平均, 计数等)。" },
        { label: "Format", text: "数字格式 (数字, 货币, 百分比)。" },
      ],
    },
    heatmap: {
      title: "Heatmap (热力图)",
      desc: "使用颜色强度显示数据密度。",
      items: [
        { label: "Query ID", text: "选择主数据源。" },
        { label: "Title / Subtitle", text: "热力图标题和描述。" },
        { label: "Mode", text: "显示为日历或标准 X/Y 网格。" },
        { label: "Date Field", text: "(日历模式) 用于日历网格的日期列。" },
        { label: "Value Field", text: "决定颜色强度的数字列。" },
      ],
    },
    map: {
      title: "Map (地图)",
      desc: "使用等值线颜色显示地理区域的汇总数据。",
      items: [
        { label: "Query ID", text: "选择数据源。" },
        { label: "Title / Subtitle", text: "地图标题和描述。" },
        { label: "Region Type", text: "地理级别 (国家或美国州)。" },
        { label: "Region Field", text: "包含区域代码的列 (例如 ISO-3 或州缩写)。" },
        { label: "Value Field", text: "决定颜色强度的数字列。" },
        { label: "Aggregation", text: "如何汇总同一区域的多行 (求和, 平均, 计数)。" },
        { label: "Format", text: "数字格式 (紧凑, 货币, 百分比)。" },
        { label: "Ramp", text: "地图的颜色调色板主题。" },
      ],
    },
    cohort_retention: {
      title: "Cohort Retention (同期群留存)",
      desc: "显示随时间推移的用户留存情况 (留存图表)。",
      items: [
        { label: "Query ID", text: "选择数据源。" },
        { label: "Title / Subtitle", text: "图表标题和描述。" },
        { label: "Cohort Field", text: "起始同期群组的列 (例如 2024 年 1 月)。" },
        { label: "Period Field", text: "后续期间的列 (例如 第 1 个月, 第 2 个月)。" },
        { label: "Retention Field", text: "包含单元格留存指标的列。" },
        { label: "Cohort Size Field", text: "初始同期群大小的列。" },
        { label: "Cell Format", text: "单元格值的格式 (百分比或计数)。" },
      ],
    },
    funnel: {
      title: "Funnel (漏斗图)",
      desc: "显示连续步骤中的转化率。",
      items: [
        { label: "Query ID", text: "选择数据源。" },
        { label: "Title / Subtitle", text: "漏斗图标题和描述。" },
        { label: "Step Field", text: "包含步骤名称的列 (例如 访问, 注册)。" },
        { label: "Reached Field", text: "到达该步骤的用户数。" },
        { label: "Conversion From Prior Field", text: "(可选) 上一步的转化率。" },
        { label: "Conversion From Top Field", text: "(可选) 第一步的转化率。" },
      ],
    },
    title: {
      title: "Title (标题)",
      desc: "大标题文本块。",
      items: [
        { label: "Text", text: "主标题文本。" },
        { label: "Subtitle", text: "辅助描述文本。" },
        { label: "Align", text: "文本对齐方式 (左, 中, 右)。" },
      ],
    },
    text: {
      title: "Text (文本)",
      desc: "标准段落文本块。",
      items: [
        { label: "Text", text: "段落内容。" },
        { label: "Align", text: "文本对齐方式 (左, 中, 右)。" },
        { label: "Size", text: "字体大小 (小, 中, 大)。" },
      ],
    },
    image: {
      title: "Image (图片)",
      desc: "在报告中显示图像。",
      items: [
        { label: "Source (URL)", text: "图像文件的链接。" },
        { label: "Alt Text", text: "用于可访问性的替代文本。" },
        { label: "Fit", text: "图像如何填充其容器 (包含, 覆盖, 填充)。" },
      ],
    },
    divider: {
      title: "Divider (分隔线)",
      desc: "用于分隔内容的水平线。",
      items: [
        { label: "Style", text: "线条样式 (实线, 虚线, 点线)。" },
        { label: "Thickness", text: "线条厚度 (以像素为单位，1-8px)。" },
      ],
    },
    callout: {
      title: "Callout (标注)",
      desc: "用于重要消息或警告的高亮框。",
      items: [
        { label: "Variant", text: "视觉样式 (信息, 成功, 警告, 危险)。" },
        { label: "Title", text: "标注的标题。" },
        { label: "Body", text: "主要文本内容。" },
      ],
    },
    pageBreak: {
      title: "Page Break (分页符)",
      desc: "导出为 PDF 时，强制将后续内容放到新页面。",
      items: [],
    },
    default: {
      title: "Block Guide",
      desc: "此区块用于布局或一般显示。您可以在右侧的属性面板中调整其设置，以在画布上看到即时变化。",
      items: [],
    }
  }
};

// Add standard RBAC text for each language
const RBAC_ITEMS = {
  th: { label: "Visibility (RBAC)", text: "จำกัดสิทธิ์การมองเห็นบล็อกนี้เฉพาะบาง Role เท่านั้น" },
  en: { label: "Visibility (RBAC)", text: "Restrict block visibility to specific reader roles." },
  zh: { label: "Visibility (RBAC)", text: "将区块可见性限制为特定读者角色。" },
};

export function BlockGuide({ blockType }: { blockType: BlockType }) {
  const { locale, t } = useT();
  const guideData = GUIDES[locale] || GUIDES.en;
  const contentData = guideData[blockType] || guideData.default;

  if (!contentData) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" title={t("guide.settings") || (locale === "th" ? "คำแนะนำการตั้งค่า (Guide)" : "Settings Guide")}>
          <HelpCircle className="h-4 w-4 text-primary hover:text-primary transition-colors" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[650px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Info className="h-5 w-5 text-primary" />
            {t("guide.settings") || (locale === "th" ? "คำแนะนำการตั้งค่า" : locale === "zh" ? "设置指南" : "Settings Guide")}
          </DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <div className="space-y-4 text-sm text-foreground leading-relaxed">
            <p><strong>{contentData.title}</strong> {contentData.desc}</p>
            {(contentData.items.length > 0 || blockType !== "pageBreak") && (
              <ul className="list-disc pl-5 space-y-3 mt-2 text-muted-foreground">
                {contentData.items.map((item, idx) => (
                  <li key={idx}>
                    <strong className="text-foreground font-medium">{item.label}:</strong> {item.text}
                  </li>
                ))}
                {blockType !== "pageBreak" && (
                  <li>
                    <strong className="text-foreground font-medium">{RBAC_ITEMS[locale].label}:</strong> {RBAC_ITEMS[locale].text}
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
