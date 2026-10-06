package com.enterprisex.curf.engine.infrastructure.export;

import com.enterprisex.curf.engine.application.export.Cells;
import com.enterprisex.curf.engine.application.export.Cells.Cell;
import com.enterprisex.curf.engine.application.export.ExportLabels;
import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Options;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.application.export.FileRenderer;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.poi.ss.usermodel.BorderStyle;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.DataFormat;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.HorizontalAlignment;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;
import org.springframework.stereotype.Component;

/**
 * A workbook with one sheet per table and a provenance sheet. Numbers are real numbers, money and percentages carry
 * number formats, dates are real dates (or text when a Buddhist-era year or the author's own pattern is asked
 * for, since a spreadsheet date cannot show those). Every text value is a text cell, never a formula. The file
 * names its font, as a spreadsheet cannot embed one; the as-of time and data hashes are in its properties.
 */
@Component
public class XlsxFileRenderer implements FileRenderer {

    private static final int WIDTH_SAMPLE_ROWS = 500;

    @Override
    public ExportFormat format() {
        return ExportFormat.XLSX;
    }

    @Override
    public byte[] render(Document doc, Options options) {
        ExportLabels words = ExportLabels.of(doc.locale());
        try (SXSSFWorkbook wb = new SXSSFWorkbook(200); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Styles styles = new Styles(wb, options.font(), doc.currency());
            Set<String> names = new HashSet<>();
            for (Section section : doc.sections()) {
                writeSection(wb, styles, doc, words, section, unique(names, sheetName(section.title())));
            }
            writeProvenance(wb, styles, doc, words, unique(names, sheetName(words.get("provenance"))));
            properties(wb, doc);
            wb.write(out);
            wb.dispose();
            return out.toByteArray();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ------------------------------------------------------------------ sheets

    private void writeSection(SXSSFWorkbook wb, Styles s, Document doc, ExportLabels words, Section section, String name) {
        Sheet sheet = wb.createSheet(name);
        List<Column> columns = section.columns();
        int[] widths = new int[columns.size()];

        Row header = sheet.createRow(0);
        for (int c = 0; c < columns.size(); c++) {
            org.apache.poi.ss.usermodel.Cell cell = header.createCell(c);
            cell.setCellValue(columns.get(c).label());
            cell.setCellStyle(s.header);
            widths[c] = columns.get(c).label().length();
        }
        sheet.createFreezePane(0, 1);

        int r = 1;
        if (section.unavailable() != null) {
            note(sheet, s, r++, words.get("unavailable") + ": " + section.unavailable());
        } else if (section.rows().isEmpty()) {
            note(sheet, s, r++, words.get("noRows"));
        }
        int sampled = 0;
        for (Map<String, Object> data : section.rows()) {
            Row row = sheet.createRow(r++);
            for (int c = 0; c < columns.size(); c++) {
                Cell value = Cells.of(columns.get(c), data.get(columns.get(c).key()));
                int len = write(row.createCell(c), s, doc, columns.get(c), value);
                if (sampled < WIDTH_SAMPLE_ROWS) {
                    widths[c] = Math.max(widths[c], len);
                }
            }
            sampled++;
        }
        if (Cells.hasTotals(section)) {
            writeTotals(sheet, s, doc, words, section, r);
        }
        for (int c = 0; c < widths.length; c++) {
            sheet.setColumnWidth(c, Math.min(60, Math.max(10, (int) (widths[c] * 1.25) + 2)) * 256);
        }
    }

    private void writeTotals(Sheet sheet, Styles s, Document doc, ExportLabels words, Section section, int rowIndex) {
        Row row = sheet.createRow(rowIndex);
        List<BigDecimal> totals = Cells.totals(section);
        for (int c = 0; c < section.columns().size(); c++) {
            org.apache.poi.ss.usermodel.Cell cell = row.createCell(c);
            Column column = section.columns().get(c);
            if (totals.get(c) != null) {
                cell.setCellValue(totals.get(c).doubleValue());
                cell.setCellStyle(s.totalFor(column.type()));
            } else {
                cell.setCellValue(c == 0 ? words.get("total") : "");
                cell.setCellStyle(s.totalText);
            }
        }
    }

    private void writeProvenance(SXSSFWorkbook wb, Styles s, Document doc, ExportLabels words, String name) {
        Sheet sheet = wb.createSheet(name);
        int r = 0;
        r = pair(sheet, s, r, doc.locale().equals("th") ? "รายงาน" : "Report", doc.title());
        r = pair(sheet, s, r, words.get("version"), String.valueOf(doc.reportVersion()));
        r = pair(sheet, s, r, words.get("asOf"), doc.asOf());
        for (Map.Entry<String, Object> p : doc.params().entrySet()) {
            r = pair(sheet, s, r, words.get("parameters") + ": " + p.getKey(), String.valueOf(p.getValue()));
        }
        r++;
        Row head = sheet.createRow(r++);
        String[] titles = {words.get("query"), "", words.get("rows"), words.get("queryHash"), words.get("dataHash"), words.get("note")};
        titles[1] = doc.locale().equals("th") ? "ชื่อ" : "Name";
        for (int c = 0; c < titles.length; c++) {
            org.apache.poi.ss.usermodel.Cell cell = head.createCell(c);
            cell.setCellValue(titles[c]);
            cell.setCellStyle(s.header);
        }
        for (var src : doc.sources()) {
            Row row = sheet.createRow(r++);
            String[] values = {src.queryId(), src.queryName(), String.valueOf(src.rowCount()), src.queryHash(), src.dataHash(), src.note() == null ? "" : src.note()};
            for (int c = 0; c < values.length; c++) {
                org.apache.poi.ss.usermodel.Cell cell = row.createCell(c);
                cell.setCellValue(values[c]);
                cell.setCellStyle(s.text);
            }
        }
        int[] widths = {24, 30, 10, 34, 34, 60};
        for (int c = 0; c < widths.length; c++) {
            sheet.setColumnWidth(c, widths[c] * 256);
        }
    }

    private static int pair(Sheet sheet, Styles s, int r, String label, String value) {
        Row row = sheet.createRow(r);
        org.apache.poi.ss.usermodel.Cell a = row.createCell(0);
        a.setCellValue(label);
        a.setCellStyle(s.bold);
        org.apache.poi.ss.usermodel.Cell b = row.createCell(1);
        b.setCellValue(value);
        b.setCellStyle(s.text);
        return r + 1;
    }

    private static void note(Sheet sheet, Styles s, int r, String text) {
        org.apache.poi.ss.usermodel.Cell cell = sheet.createRow(r).createCell(0);
        cell.setCellValue(text);
        cell.setCellStyle(s.italic);
    }

    // ------------------------------------------------------------------ one cell

    /** Writes the value with the right type and style; returns how many characters wide it shows. */
    private int write(org.apache.poi.ss.usermodel.Cell cell, Styles s, Document doc, Column column, Cell value) {
        switch (value) {
            case Cells.Empty e -> {
                cell.setBlank();
                return 0;
            }
            case Cells.Bool b -> {
                cell.setCellValue(b.value());
                cell.setCellStyle(s.text);
                return 5;
            }
            case Cells.Num n -> {
                cell.setCellValue(n.value().doubleValue());
                cell.setCellStyle(s.numberFor(column.type()));
                return CellFormats.number(n.value()).length();
            }
            case Cells.Date d -> {
                boolean asText = doc.style().buddhist() || column.format() != null;
                if (asText) {
                    String text = Cells.display(d, column, doc);
                    cell.setCellValue(text);
                    cell.setCellStyle(s.text);
                    return text.length();
                }
                cell.setCellValue(d.withTime() ? d.value() : d.value().toLocalDate().atStartOfDay());
                cell.setCellStyle(d.withTime() ? s.dateTime : s.date);
                return d.withTime() ? 16 : 10;
            }
            case Cells.Text t -> {
                // A text cell, so a value like "=1+1" is shown as text and never evaluated.
                cell.setCellValue(t.value());
                cell.setCellStyle(s.text);
                return t.value().length();
            }
        }
    }

    // ------------------------------------------------------------------ names and properties

    static String sheetName(String title) {
        String clean = title.replaceAll("[\\[\\]:*?/\\\\]", " ").replaceAll("\\s+", " ").strip();
        if (clean.isEmpty()) {
            clean = "Sheet";
        }
        return clean.length() > 31 ? clean.substring(0, 31).strip() : clean;
    }

    private static String unique(Set<String> used, String name) {
        String candidate = name;
        for (int i = 2; !used.add(candidate.toLowerCase(java.util.Locale.ROOT)); i++) {
            String suffix = " (" + i + ")";
            candidate = (name.length() + suffix.length() > 31 ? name.substring(0, 31 - suffix.length()) : name) + suffix;
        }
        return candidate;
    }

    private static void properties(SXSSFWorkbook wb, Document doc) {
        var props = wb.getXSSFWorkbook().getProperties();
        props.getCoreProperties().setTitle(doc.title());
        props.getCoreProperties().setCreator("Curf engine");
        props.getCoreProperties().setDescription(ExportLabels.of(doc.locale()).get("asOf") + " " + doc.asOf());
        props.getCustomProperties().addProperty("curf.asOf", doc.asOf());
        props.getCustomProperties().addProperty("curf.reportVersion", doc.reportVersion());
        doc.sources().forEach(src -> props.getCustomProperties().addProperty("curf.dataHash." + src.queryId(), src.dataHash()));
    }

    // ------------------------------------------------------------------ styles

    /** All cell styles for one workbook, built once (a workbook may hold only a few thousand). */
    private static final class Styles {
        final CellStyle header;
        final CellStyle text;
        final CellStyle bold;
        final CellStyle italic;
        final CellStyle totalText;
        final CellStyle date;
        final CellStyle dateTime;
        private final CellStyle number;
        private final CellStyle currency;
        private final CellStyle percent;
        private final CellStyle totalNumber;
        private final CellStyle totalCurrency;
        private final CellStyle totalPercent;

        Styles(SXSSFWorkbook wb, String fontName, String currencyCode) {
            Font regular = font(wb, fontName, false, false);
            Font strong = font(wb, fontName, true, false);
            Font slanted = font(wb, fontName, false, true);
            DataFormat fmt = wb.createDataFormat();
            String symbol = CellFormats.symbol(currencyCode);
            String money = symbol.isEmpty() ? "#,##0.00" : "\"" + symbol + "\"#,##0.00";

            text = base(wb, regular, null, null);
            bold = base(wb, strong, null, null);
            italic = base(wb, slanted, null, null);
            header = base(wb, strong, null, HorizontalAlignment.LEFT);
            header.setFillForegroundColor(IndexedColors.GREY_25_PERCENT.getIndex());
            header.setFillPattern(FillPatternType.SOLID_FOREGROUND);
            header.setBorderBottom(BorderStyle.THIN);
            number = base(wb, regular, fmt.getFormat("#,##0.####"), HorizontalAlignment.RIGHT);
            currency = base(wb, regular, fmt.getFormat(money), HorizontalAlignment.RIGHT);
            percent = base(wb, regular, fmt.getFormat("0.0%"), HorizontalAlignment.RIGHT);
            date = base(wb, regular, fmt.getFormat("yyyy-mm-dd"), HorizontalAlignment.LEFT);
            dateTime = base(wb, regular, fmt.getFormat("yyyy-mm-dd hh:mm"), HorizontalAlignment.LEFT);
            totalText = totalOf(wb, strong, null, null);
            totalNumber = totalOf(wb, strong, fmt.getFormat("#,##0.####"), HorizontalAlignment.RIGHT);
            totalCurrency = totalOf(wb, strong, fmt.getFormat(money), HorizontalAlignment.RIGHT);
            totalPercent = totalOf(wb, strong, fmt.getFormat("0.0%"), HorizontalAlignment.RIGHT);
        }

        CellStyle numberFor(String type) {
            return "currency".equals(type) ? currency : "percent".equals(type) ? percent : number;
        }

        CellStyle totalFor(String type) {
            return "currency".equals(type) ? totalCurrency : "percent".equals(type) ? totalPercent : totalNumber;
        }

        private static Font font(SXSSFWorkbook wb, String name, boolean bold, boolean italic) {
            Font f = wb.createFont();
            f.setFontName(name);
            f.setFontHeightInPoints((short) 11);
            f.setBold(bold);
            f.setItalic(italic);
            return f;
        }

        private static CellStyle base(SXSSFWorkbook wb, Font font, Short format, HorizontalAlignment align) {
            CellStyle style = wb.createCellStyle();
            style.setFont(font);
            if (format != null) {
                style.setDataFormat(format);
            }
            if (align != null) {
                style.setAlignment(align);
            }
            return style;
        }

        private static CellStyle totalOf(SXSSFWorkbook wb, Font font, Short format, HorizontalAlignment align) {
            CellStyle style = base(wb, font, format, align);
            style.setBorderTop(BorderStyle.THIN);
            return style;
        }
    }
}
