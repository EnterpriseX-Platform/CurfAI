// Minimal shim for the part of unzipper that lib/lake/xlsxStream.ts uses —
// random-access reads through the zip's central directory. unzipper ships
// no .d.ts and there is no @types package for the 0.10 line exceljs pins.
declare module "unzipper" {
  import type { Readable } from "stream";

  export type CentralDirectoryFile = {
    path: string;
    type: "File" | "Directory";
    uncompressedSize: number;
    stream(): Readable;
    buffer(): Promise<Buffer>;
  };

  export type CentralDirectory = { files: CentralDirectoryFile[] };

  export const Open: {
    file(path: string): Promise<CentralDirectory>;
    buffer(buf: Buffer): Promise<CentralDirectory>;
  };
}
