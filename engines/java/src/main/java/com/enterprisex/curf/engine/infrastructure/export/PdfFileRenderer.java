package com.enterprisex.curf.engine.infrastructure.export;

import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Options;
import com.enterprisex.curf.engine.application.export.FileRenderer;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import org.springframework.stereotype.Component;

/** A PDF: the report as an inline HTML page with the Thai font embedded, printed by a headless Chromium. */
@Component
public class PdfFileRenderer implements FileRenderer {

    private final GotenbergClient chromium;

    public PdfFileRenderer(GotenbergClient chromium) {
        this.chromium = chromium;
    }

    @Override
    public ExportFormat format() {
        return ExportFormat.PDF;
    }

    @Override
    public byte[] render(Document doc, Options options) {
        return chromium.print(HtmlReport.page(doc), HtmlReport.footer(doc), HtmlReport.landscape(doc));
    }
}
