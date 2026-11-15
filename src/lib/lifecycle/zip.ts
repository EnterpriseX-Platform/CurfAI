/**
 * A small streaming ZIP writer, for the workspace export (lib/lifecycle/export.ts).
 *
 * Why not a library: none is in the dependency list, and a new package means vetting a new supply-chain risk for ~100
 * lines. This writes the plain format every unzip tool reads: deflate-compressed entries, UTF-8 names (Thai file names
 * included), sizes and CRC in a data descriptor after each entry — so an entry can be streamed from a source of unknown
 * length (a lake table, row by row) without holding it in memory. No ZIP64: an archive over 4 GB or 65,535 entries is
 * refused instead of written wrong.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { createDeflateRaw } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform, Writable, type Readable } from "node:stream";

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const MAX32 = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 over `buf`, continuing from `crc` (start from 0). */
export function crc32(buf: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A name safe inside an archive: forward slashes, no leading slash, no `..`, no control characters. */
export function safeEntryName(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/")
    .map((p) => p.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .filter((p) => p !== "" && p !== "." && p !== "..");
  if (parts.length === 0) throw new Error("zip: empty entry name");
  return parts.join("/");
}

type Central = { name: Buffer; crc: number; csize: number; usize: number; offset: number; time: number; date: number };

export class ZipWriter {
  private out: WriteStream;
  private offset = 0;
  private central: Central[] = [];
  private names = new Set<string>();
  private done = false;
  private failed: Error | null = null;

  /** Bytes written to the archive so far (entries only, until finish() adds the directory). */
  get bytesWritten(): number { return this.offset; }

  constructor(filePath: string) {
    this.out = createWriteStream(filePath);
    this.out.on("error", (e) => { this.failed = e; });
  }

  private write(buf: Buffer): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    this.offset += buf.length;
    return new Promise((resolve, reject) => this.out.write(buf, (e) => (e ? reject(e) : resolve())));
  }

  private header(name: Buffer, when: Date): Buffer {
    const { time, date } = dosDateTime(when);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
    h.writeUInt16LE(8, 8); // deflate
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    // crc and sizes are 0: they follow the data (descriptor)
    h.writeUInt16LE(name.length, 26);
    return Buffer.concat([h, name]);
  }

  private async begin(rawName: string, when: Date): Promise<{ name: Buffer; offset: number; time: number; date: number }> {
    if (this.done) throw new Error("zip: already finished");
    const name = Buffer.from(safeEntryName(rawName), "utf8");
    const key = name.toString("utf8");
    if (this.names.has(key)) throw new Error(`zip: duplicate entry ${key}`);
    if (this.central.length >= 65_535) throw new Error("zip: too many entries");
    this.names.add(key);
    const offset = this.offset;
    if (offset > MAX32) throw new Error("zip: archive too large");
    const { time, date } = dosDateTime(when);
    await this.write(this.header(name, when));
    return { name, offset, time, date };
  }

  private async end(meta: { name: Buffer; offset: number; time: number; date: number }, crc: number, csize: number, usize: number) {
    if (csize > MAX32 || usize > MAX32) throw new Error("zip: entry too large");
    const d = Buffer.alloc(16);
    d.writeUInt32LE(SIG_DESCRIPTOR, 0);
    d.writeUInt32LE(crc, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(usize, 12);
    await this.write(d);
    this.central.push({ ...meta, crc, csize, usize });
  }

  /** Add an entry from memory. */
  async addBuffer(name: string, data: Buffer | string, when: Date = new Date()): Promise<void> {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const meta = await this.begin(name, when);
    const { deflateRawSync } = await import("node:zlib");
    const comp = deflateRawSync(buf);
    await this.write(comp);
    await this.end(meta, crc32(buf), comp.length, buf.length);
  }

  /** Add an entry from a stream of unknown length; it is never held in memory whole. */
  async addStream(name: string, source: Readable, when: Date = new Date()): Promise<void> {
    const meta = await this.begin(name, when);
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const tally = new Transform({
      transform(chunk: Buffer, _enc, cb) { crc = crc32(chunk, crc); usize += chunk.length; cb(null, chunk); },
    });
    const sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => { csize += chunk.length; this.write(chunk).then(() => cb(), cb); },
    });
    await pipeline(source, tally, createDeflateRaw(), sink);
    await this.end(meta, crc, csize, usize);
  }

  /** Write the directory and close the file. Returns what was written. */
  async finish(): Promise<{ entries: number; bytes: number }> {
    if (this.done) throw new Error("zip: already finished");
    this.done = true;
    const cdStart = this.offset;
    for (const e of this.central) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(SIG_CENTRAL, 0);
      c.writeUInt16LE(20, 4); // made by
      c.writeUInt16LE(20, 6); // needed
      c.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
      c.writeUInt16LE(8, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.name]));
    }
    const cdSize = this.offset - cdStart;
    if (cdStart > MAX32) throw new Error("zip: archive too large");
    const z = Buffer.alloc(22);
    z.writeUInt32LE(SIG_END, 0);
    z.writeUInt16LE(this.central.length, 8);
    z.writeUInt16LE(this.central.length, 10);
    z.writeUInt32LE(cdSize, 12);
    z.writeUInt32LE(cdStart, 16);
    await this.write(z);
    const bytes = this.offset;
    await new Promise<void>((resolve, reject) => this.out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    return { entries: this.central.length, bytes };
  }

  /** Give up: close the file without a directory. The caller deletes the partial file. */
  abort(): void {
    this.done = true;
    this.out.destroy();
  }
}
