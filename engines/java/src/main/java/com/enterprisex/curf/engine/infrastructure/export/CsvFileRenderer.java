package com.enterprisex.curf.engine.infrastructure.export;

import com.enterprisex.curf.engine.application.export.Cells;
import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Options;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.application.export.FileRenderer;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * One table as CSV: UTF-8 with a byte-order mark (so Excel reads Thai correctly), CRLF line ends, machine-readable
 * values (plain numbers, ISO dates) as Curf's own CSV export writes them. Text that a spreadsheet would read as a
 * formula is prefixed with an apostrophe, so opening the file can never run something a data value smuggled in.
 */
@Component
public class CsvFileRenderer implements FileRenderer {

    private static final byte[] BOM = {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};

    @Override
    public ExportFormat format() {
        return ExportFormat.CSV;
    }

    @Override
    public byte[] render(Document doc, Options options) {
        Section section = doc.sections().stream()
                .filter(s -> !s.blockId().isEmpty())
                .filter(s -> options.blockId() == null || options.blockId().equals(s.blockId()))
                .findFirst().orElseThrow();
        StringBuilder out = new StringBuilder();
        out.append(line(section.columns().stream().map(c -> field(c.label(), true)).toList()));
        for (Map<String, Object> row : section.rows()) {
            out.append(line(section.columns().stream().map(c -> cell(c, row.get(c.key()))).toList()));
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.writeBytes(BOM);
        bytes.writeBytes(out.toString().getBytes(StandardCharsets.UTF_8));
        return bytes.toByteArray();
    }

    private static String cell(Column column, Object raw) {
        Cells.Cell cell = Cells.of(column, raw);
        // Only text can be mistaken for a formula; a number such as -5 is data and stays as it is.
        return field(Cells.machine(cell), cell instanceof Cells.Text);
    }

    private static String line(Iterable<String> fields) {
        return String.join(",", fields) + "\r\n";
    }

    /** RFC 4180 quoting, plus the formula guard for text. */
    static String field(String value, boolean guardFormula) {
        String v = value == null ? "" : value;
        if (guardFormula && !v.isEmpty() && "=+-@\t\r".indexOf(v.charAt(0)) >= 0) {
            v = "'" + v;
        }
        if (v.indexOf('"') >= 0 || v.indexOf(',') >= 0 || v.indexOf('\r') >= 0 || v.indexOf('\n') >= 0) {
            return "\"" + v.replace("\"", "\"\"") + "\"";
        }
        return v;
    }
}
