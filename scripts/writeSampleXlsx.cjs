/**
 * Write a representative sample .xlsx for manually testing the Excel import
 * flow. Pure JS (exceljs only) so it runs without rebuilding native modules.
 *
 *   node scripts/writeSampleXlsx.cjs              → writes sample-marketing.xlsx in cwd
 *   node scripts/writeSampleXlsx.cjs <out.xlsx>   → writes to the given path
 *
 * Designed to exercise the parser's interesting paths: numeric, date,
 * boolean, and string columns; messy headers; a multi-sheet workbook.
 */
const path = require("node:path");
const ExcelJS = require("exceljs");

async function main() {
  const out = process.argv[2] || path.resolve("sample-marketing.xlsx");
  const wb = new ExcelJS.Workbook();

  // Sheet 1 — Marketing campaigns. Mixed types, real Date objects, booleans.
  const ws1 = wb.addWorksheet("Campaigns Q1 2026");
  ws1.columns = [
    { header: "Campaign Name",    key: "name",     width: 32 },
    { header: "Channel",          key: "channel",  width: 12 },
    { header: "Spend (USD)",      key: "spend",    width: 14 },
    { header: "Leads",            key: "leads",    width: 10 },
    { header: "ROI",              key: "roi",      width: 8 },
    { header: "Started At",       key: "started",  width: 14 },
    { header: "Active?",          key: "active",   width: 10 },
    { header: "Country",          key: "country",  width: 8 },
  ];
  ws1.addRows([
    { name: "Black Friday Mega Push 2025",  channel: "Search",  spend: 218400, leads: 13920, roi: 4.8,  started: new Date("2025-11-03"), active: true,  country: "USA" },
    { name: "EMEA Roadshow 2025",           channel: "Events",  spend: 215700, leads: 4180,  roi: 2.2,  started: new Date("2025-04-15"), active: false, country: "DEU" },
    { name: "Year-End Webinar Series 2024", channel: "Events",  spend: 187400, leads: 3410,  roi: 2.0,  started: new Date("2024-12-02"), active: false, country: "USA" },
    { name: "Cyber Week Social Burst 2025", channel: "Social",  spend: 184600, leads: 9240,  roi: 4.0,  started: new Date("2025-11-24"), active: true,  country: "USA" },
    { name: "Display Retargeting Push 2026",channel: "Display", spend: 184600, leads: 720,   roi: -0.2, started: new Date("2026-01-08"), active: true,  country: "USA" },
    { name: "APAC Webinar Series 2025",     channel: "Events",  spend: 168200, leads: 3640,  roi: 3.0,  started: new Date("2025-06-18"), active: false, country: "JPN" },
    { name: "Black Friday Push 2024",       channel: "Search",  spend: 168000, leads: 9240,  roi: 4.0,  started: new Date("2024-11-04"), active: false, country: "USA" },
    { name: "Q1 Social Always-On 2026",     channel: "Social",  spend: 158900, leads: 8120,  roi: 3.9,  started: new Date("2026-01-20"), active: true,  country: "GBR" },
    { name: "Search Intent Expansion 2025", channel: "Search",  spend: 156500, leads: 11340, roi: 4.6,  started: new Date("2025-08-26"), active: true,  country: "USA" },
    { name: "Summer Lead Gen Push 2025",    channel: "Search",  spend: 142800, leads: 9720,  roi: 4.4,  started: new Date("2025-05-08"), active: false, country: "FRA" },
    { name: "New Year Search Refresh 2026", channel: "Search",  spend: 134800, leads: 9460,  roi: 4.5,  started: new Date("2026-01-12"), active: true,  country: "USA" },
    { name: "Spring Product Launch 2025",   channel: "Search",  spend: 110200, leads: 7180,  roi: 3.9,  started: new Date("2025-02-10"), active: false, country: "USA" },
  ]);

  // Sheet 2 — KPIs by month. Tests numeric inference and percent-as-text.
  const ws2 = wb.addWorksheet("Monthly KPIs");
  ws2.addRow(["Month", "Spend", "Leads", "Conv Rate"]);
  ws2.addRow(["2025-10", 412500, 22100, "5.4%"]);
  ws2.addRow(["2025-11", 786400, 38900, "4.9%"]);
  ws2.addRow(["2025-12", 524200, 28100, "5.4%"]);
  ws2.addRow(["2026-01", 458100, 24600, "5.4%"]);
  ws2.addRow(["2026-02", 396800, 21800, "5.5%"]);
  ws2.addRow(["2026-03", 423000, 22900, "5.4%"]);

  // Sheet 3 — Header weirdness so reviewers can see sanitization in action.
  const ws3 = wb.addWorksheet("Funny Headers");
  ws3.addRow(["Total $ Spend (USD)", "% Conversion", "2024 Q1", "Notes"]);
  ws3.addRow([1234.5, 0.15, 100, "Steady growth"]);
  ws3.addRow([2345.6, 0.18, 120, "Holiday surge"]);

  await wb.xlsx.writeFile(out);
  console.log("Wrote " + out);
}

main().catch((e) => { console.error(e); process.exit(1); });
