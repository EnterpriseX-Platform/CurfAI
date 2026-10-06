package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.domain.export.ExportFormat;

/** Port: turns an {@link ExportModel.Document} into the bytes of one file format. */
public interface FileRenderer {

    ExportFormat format();

    byte[] render(ExportModel.Document document, ExportModel.Options options);
}
