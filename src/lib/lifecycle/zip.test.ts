/**
 * The export's zip writer, read back with a real unzip implementation (the `unzipper` package) so "it writes bytes" can't
 * pass for "it writes a zip".
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { ZipWriter, crc32, safeEntryName } from "./zip";

const unzipper: any = require("unzipper");

let dir = "";
const tmp = () => { dir = mkdtempSync(join(tmpdir(), "curf-zip-")); return join(dir, "out.zip"); };
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

async function read(path: string) {
  const d = await unzipper.Open.file(path);
  const files: Record<string, Buffer> = {};
  for (const f of d.files) if (f.type === "File") files[f.path] = await f.buffer();
  return files;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
  it("can be continued across chunks", () => {
    const whole = crc32(Buffer.from("hello world"));
    expect(crc32(Buffer.from(" world"), crc32(Buffer.from("hello")))).toBe(whole);
  });
});

describe("safeEntryName", () => {
  it("keeps names inside the archive", () => {
    expect(safeEntryName("a/b.json")).toBe("a/b.json");
    expect(safeEntryName("/etc/passwd")).toBe("etc/passwd");
    expect(safeEntryName("..\\..\\evil.txt")).toBe("evil.txt");
    expect(safeEntryName("a/../../b")).toBe("a/b");
    expect(safeEntryName("name\u0000with\u001fcontrol")).toBe("namewithcontrol");
    expect(() => safeEntryName("../..")).toThrow();
    expect(() => safeEntryName("")).toThrow();
  });
});

describe("ZipWriter", () => {
  it("writes an archive a real unzip reads: text, empty, Thai names and a streamed entry", async () => {
    const path = tmp();
    const z = new ZipWriter(path);
    await z.addBuffer("manifest.json", JSON.stringify({ a: 1 }));
    await z.addBuffer("empty.txt", "");
    await z.addBuffer("รายงาน/สรุป.csv", "ชื่อ,ยอด\nสมชาย,100\n");
    await z.addStream("lake/sales.csv", Readable.from(["id,amount\n", "1,10\n", "2,20\n"]));
    const r = await z.finish();
    expect(r.entries).toBe(4);
    expect(r.bytes).toBe(statSync(path).size);

    const files = await read(path);
    expect(Object.keys(files).sort()).toEqual(["empty.txt", "lake/sales.csv", "manifest.json", "รายงาน/สรุป.csv"].sort());
    expect(files["manifest.json"]!.toString()).toBe('{"a":1}');
    expect(files["empty.txt"]!.length).toBe(0);
    expect(files["รายงาน/สรุป.csv"]!.toString()).toBe("ชื่อ,ยอด\nสมชาย,100\n");
    expect(files["lake/sales.csv"]!.toString()).toBe("id,amount\n1,10\n2,20\n");
  });

  it("streams a large entry without holding it, and the bytes come back identical", async () => {
    const path = tmp();
    const chunks = Array.from({ length: 40 }, () => randomBytes(256 * 1024)); // 10 MB of incompressible data
    const want = createHash("sha256");
    for (const c of chunks) want.update(c);
    const z = new ZipWriter(path);
    await z.addStream("big.bin", Readable.from(chunks));
    await z.addBuffer("after.txt", "still fine");
    await z.finish();
    const files = await read(path);
    expect(createHash("sha256").update(files["big.bin"]!).digest("hex")).toBe(want.digest("hex"));
    expect(files["after.txt"]!.toString()).toBe("still fine");
  });

  it("refuses a duplicate name, and a name that would escape the archive is made safe", async () => {
    const path = tmp();
    const z = new ZipWriter(path);
    await z.addBuffer("a.txt", "1");
    await expect(z.addBuffer("a.txt", "2")).rejects.toThrow(/duplicate/);
    await z.addBuffer("../../outside.txt", "x");
    await z.finish();
    expect(Object.keys(await read(path)).sort()).toEqual(["a.txt", "outside.txt"]);
  });

  it("can't be used after it is finished", async () => {
    const z = new ZipWriter(tmp());
    await z.addBuffer("a.txt", "1");
    await z.finish();
    await expect(z.addBuffer("b.txt", "2")).rejects.toThrow(/finished/);
    await expect(z.finish()).rejects.toThrow(/finished/);
  });

  it("a stream that fails stops the entry with its error", async () => {
    const z = new ZipWriter(tmp());
    const bad = new Readable({ read() { this.destroy(new Error("source broke")); } });
    await expect(z.addStream("x.csv", bad)).rejects.toThrow("source broke");
    z.abort();
  });
});
