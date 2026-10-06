/** Writes docs/REPORT_QUALITY_RULES.md from REPORT_RULES — see render.ts. */
import { writeFileSync } from "fs";
import { resolve } from "path";
import { renderReportRulesDoc } from "./render";

const out = resolve(__dirname, "../../docs/REPORT_QUALITY_RULES.md");
writeFileSync(out, renderReportRulesDoc());
console.log(`Wrote ${out}`);
