package com.enterprisex.curf.engine.infrastructure.export;

import com.enterprisex.curf.engine.application.export.Cells;
import com.enterprisex.curf.engine.application.export.ExportLabels;
import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Options;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.application.export.FileRenderer;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import org.apache.poi.xwpf.usermodel.ParagraphAlignment;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFFooter;
import org.apache.poi.xwpf.model.XWPFHeaderFooterPolicy;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFRun;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableCell;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.CTPageSz;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.CTRPr;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.CTSectPr;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.STPageOrientation;
import org.springframework.stereotype.Component;

/**
 * A Word document: the title, the as-of time and parameters, one table per section with a totals row where the
 * column asks for one, and a closing table of where each query's data came from. Text uses the configured font
 * for Latin and Thai alike (Word reads Thai from the complex-script font setting, so that is set too). Like Curf's
 * own Word export, it holds tables, not charts. Wide tables switch the page to landscape.
 */
@Component
public class DocxFileRenderer implements FileRenderer {

    private static final int LANDSCAPE_FROM_COLUMNS = 7;

    @Override
    public ExportFormat format() {
        return ExportFormat.DOCX;
    }

    @Override
    public byte[] render(Document doc, Options options) {
        ExportLabels words = ExportLabels.of(doc.locale());
        String font = options.font();
        try (XWPFDocument docx = new XWPFDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (doc.sections().stream().anyMatch(s -> s.columns().size() >= LANDSCAPE_FROM_COLUMNS)) {
                landscape(docx);
            }
            paragraph(docx, font, doc.title(), 20, true, false);
            paragraph(docx, font, words.get("asOf") + " " + doc.asOf(), 10, false, true);
            if (!doc.params().isEmpty()) {
                StringBuilder sb = new StringBuilder(words.get("parameters")).append(": ");
                doc.params().forEach((k, v) -> sb.append(k).append(" = ").append(v).append("   "));
                paragraph(docx, font, sb.toString().strip(), 10, false, true);
            }

            for (Section section : doc.sections()) {
                paragraph(docx, font, section.title(), 14, true, false);
                if (section.unavailable() != null) {
                    paragraph(docx, font, words.get("unavailable") + ": " + section.unavailable(), 11, false, true);
                    continue;
                }
                table(docx, font, doc, words, section);
            }
            sources(docx, font, doc, words);
            footer(docx, font, words.get("asOf") + " " + doc.asOf() + "  ·  " + words.get("version") + " " + doc.reportVersion());

            var props = docx.getProperties();
            props.getCoreProperties().setTitle(doc.title());
            props.getCoreProperties().setCreator("Curf engine");
            props.getCustomProperties().addProperty("curf.asOf", doc.asOf());
            props.getCustomProperties().addProperty("curf.reportVersion", doc.reportVersion());
            doc.sources().forEach(src -> props.getCustomProperties().addProperty("curf.dataHash." + src.queryId(), src.dataHash()));

            docx.write(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ------------------------------------------------------------------ pieces

    private void table(XWPFDocument docx, String font, Document doc, ExportLabels words, Section section) {
        List<Column> columns = section.columns();
        XWPFTable table = docx.createTable(1, columns.size());
        table.setWidth("100%");
        borders(table);
        XWPFTableRow header = table.getRow(0);
        for (int c = 0; c < columns.size(); c++) {
            cell(header.getCell(c), font, columns.get(c).label(), true, false, "E8E8E8");
        }
        if (section.rows().isEmpty()) {
            paragraph(docx, font, words.get("noRows"), 10, false, true);
        }
        for (Map<String, Object> data : section.rows()) {
            XWPFTableRow row = table.createRow();
            for (int c = 0; c < columns.size(); c++) {
                Column column = columns.get(c);
                Cells.Cell value = Cells.of(column, data.get(column.key()));
                cell(row.getCell(c), font, Cells.display(value, column, doc), false, value instanceof Cells.Num, null);
            }
        }
        if (Cells.hasTotals(section)) {
            XWPFTableRow row = table.createRow();
            List<BigDecimal> totals = Cells.totals(section);
            for (int c = 0; c < columns.size(); c++) {
                String text = totals.get(c) == null ? (c == 0 ? words.get("total") : "") : totalText(columns.get(c), totals.get(c), doc);
                cell(row.getCell(c), font, text, true, totals.get(c) != null, null);
            }
        }
        paragraph(docx, font, "", 6, false, false);
    }

    private static String totalText(Column column, BigDecimal total, Document doc) {
        return Cells.display(new Cells.Num(total), column, doc);
    }

    private void sources(XWPFDocument docx, String font, Document doc, ExportLabels words) {
        paragraph(docx, font, words.get("sources"), 12, true, false);
        XWPFTable table = docx.createTable(1, 5);
        table.setWidth("100%");
        borders(table);
        String[] titles = {words.get("query"), words.get("rows"), words.get("queryHash"), words.get("dataHash"), words.get("note")};
        for (int c = 0; c < titles.length; c++) {
            cell(table.getRow(0).getCell(c), font, titles[c], true, false, "E8E8E8");
        }
        for (var src : doc.sources()) {
            XWPFTableRow row = table.createRow();
            String[] values = {src.queryName() == null ? src.queryId() : src.queryName(), String.valueOf(src.rowCount()), src.queryHash(), src.dataHash(), src.note() == null ? "" : src.note()};
            for (int c = 0; c < values.length; c++) {
                cell(row.getCell(c), font, values[c], false, c == 1, null);
            }
        }
    }

    private static void cell(XWPFTableCell cell, String font, String text, boolean bold, boolean right, String fill) {
        if (fill != null) {
            cell.setColor(fill);
        }
        XWPFParagraph p = cell.getParagraphs().get(0);
        p.setAlignment(right ? ParagraphAlignment.RIGHT : ParagraphAlignment.LEFT);
        XWPFRun run = p.createRun();
        run.setText(text);
        run.setBold(bold);
        run.setFontSize(10);
        font(run, font);
    }

    private static void paragraph(XWPFDocument docx, String font, String text, int size, boolean bold, boolean italic) {
        XWPFParagraph p = docx.createParagraph();
        XWPFRun run = p.createRun();
        run.setText(text);
        run.setBold(bold);
        run.setItalic(italic);
        run.setFontSize(size);
        font(run, font);
    }

    private static void footer(XWPFDocument docx, String font, String text) {
        XWPFHeaderFooterPolicy policy = docx.createHeaderFooterPolicy();
        XWPFFooter footer = policy.createFooter(XWPFHeaderFooterPolicy.DEFAULT);
        XWPFParagraph p = footer.createParagraph();
        p.setAlignment(ParagraphAlignment.CENTER);
        XWPFRun run = p.createRun();
        run.setText(text);
        run.setFontSize(8);
        font(run, font);
    }

    /** Latin, east-Asian and complex-script (Thai) font settings, so Word picks the same font for Thai text. */
    private static void font(XWPFRun run, String font) {
        run.setFontFamily(font);
        CTRPr props = run.getCTR().isSetRPr() ? run.getCTR().getRPr() : run.getCTR().addNewRPr();
        var fonts = props.sizeOfRFontsArray() > 0 ? props.getRFontsArray(0) : props.addNewRFonts();
        fonts.setCs(font);
        fonts.setEastAsia(font);
    }

    private static void borders(XWPFTable table) {
        table.setInsideHBorder(XWPFTable.XWPFBorderType.SINGLE, 1, 0, "BBBBBB");
        table.setInsideVBorder(XWPFTable.XWPFBorderType.SINGLE, 1, 0, "BBBBBB");
        table.setTopBorder(XWPFTable.XWPFBorderType.SINGLE, 1, 0, "BBBBBB");
        table.setBottomBorder(XWPFTable.XWPFBorderType.SINGLE, 1, 0, "BBBBBB");
        table.setLeftBorder(XWPFTable.XWPFBorderType.SINGLE, 1, 0, "BBBBBB");
        table.setRightBorder(XWPFTable.XWPFBorderType.SINGLE, 1, 0, "BBBBBB");
    }

    private static void landscape(XWPFDocument docx) {
        CTSectPr sect = docx.getDocument().getBody().isSetSectPr() ? docx.getDocument().getBody().getSectPr() : docx.getDocument().getBody().addNewSectPr();
        CTPageSz page = sect.isSetPgSz() ? sect.getPgSz() : sect.addNewPgSz();
        page.setOrient(STPageOrientation.LANDSCAPE);
        page.setW(BigInteger.valueOf(16838));
        page.setH(BigInteger.valueOf(11906));
    }
}
