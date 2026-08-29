import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MmexDatabaseError, openReadOnly } from "../src/db/connection.js";
import { makeGarbageFile, makeNonMmexDb, makeTinyMmexDb } from "./helpers/tiny-db.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("read-only guarantee", () => {
  it("sets PRAGMA query_only", () => {
    const { path, dir } = makeTinyMmexDb();
    cleanup.push(dir);
    const db = openReadOnly(path);
    expect(db.query<{ query_only: number }>("PRAGMA query_only")[0]?.query_only).toBe(1);
    db.close();
  });

  it("proves the write refusal by actually attempting one", () => {
    const { path, dir } = makeTinyMmexDb();
    cleanup.push(dir);
    const db = openReadOnly(path);
    const proof = db.verifyReadOnly();
    expect(proof.queryOnly).toBe(true);
    expect(proof.writeRejectedWith).toBe("SQLITE_READONLY");
    db.close();
  });

  it("refuses writes through the public query API too", () => {
    const { path, dir } = makeTinyMmexDb();
    cleanup.push(dir);
    const db = openReadOnly(path);
    // The public API only exposes row-returning reads, so a write is refused
    // before SQLite is even reached. Both layers matter; both are asserted.
    expect(() => db.query("INSERT INTO CATEGORY_V1 VALUES (99, 'X', -1)")).toThrow();
    db.close();
  });

  it("rejects DDL as well as DML", () => {
    const { path, dir } = makeTinyMmexDb();
    cleanup.push(dir);
    const db = openReadOnly(path);
    expect(() => db.query("DROP TABLE CATEGORY_V1")).toThrow();
    expect(() => db.query("UPDATE CATEGORY_V1 SET CATEGNAME = 'x'")).toThrow();
    expect(() => db.query("DELETE FROM CATEGORY_V1")).toThrow();
    db.close();
  });

  it("leaves the source file byte-identical after a session", () => {
    const { path, dir } = makeTinyMmexDb();
    cleanup.push(dir);
    const before = readFileSync(path);
    const db = openReadOnly(path);
    db.query("SELECT * FROM CATEGORY_V1");
    db.close();
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe("input validation", () => {
  it("gives an actionable error for a missing file", () => {
    const missing = join(tmpdir(), "definitely-not-here-9f3a.mmb");
    expect(() => openReadOnly(missing)).toThrow(MmexDatabaseError);
    expect(() => openReadOnly(missing)).toThrow(/No such database file/);
  });

  it("rejects a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "mmex-test-"));
    cleanup.push(dir);
    expect(() => openReadOnly(dir)).toThrow(/is a directory/);
  });

  it("rejects a file that is not a SQLite database", () => {
    const { path, dir } = makeGarbageFile("junk.mmb");
    cleanup.push(dir);
    expect(() => openReadOnly(path)).toThrow(/Not an unencrypted SQLite database/);
  });

  it("explains encryption when the file is named .emb", () => {
    const { path, dir } = makeGarbageFile("secret.emb");
    cleanup.push(dir);
    expect(() => openReadOnly(path)).toThrow(/encrypted MMEX database/);
  });

  it("rejects a valid SQLite database that is not an MMEX one", () => {
    const { path, dir } = makeNonMmexDb();
    cleanup.push(dir);
    expect(() => openReadOnly(path)).toThrow(/not a Money Manager EX one/);
  });
});

describe("metadata", () => {
  it("reads INFOTABLE_V1 with lowercased keys", () => {
    const { path, dir } = makeTinyMmexDb();
    cleanup.push(dir);
    const db = openReadOnly(path);
    expect(db.info.get("basecurrencyid")).toBe("1");
    expect(db.info.get("dataversion")).toBe("19");
    db.close();
  });
});

describe("snapshot mode", () => {
  it("opens a copy and leaves the source untouched", () => {
    const { path, dir } = makeTinyMmexDb();
    cleanup.push(dir);
    const db = openReadOnly(path, { snapshot: true });
    expect(db.openedPath).not.toBe(path);
    expect(db.sourcePath).toBe(path);
    expect(existsSync(db.openedPath)).toBe(true);
    const copyPath = db.openedPath;
    db.close();
    expect(existsSync(copyPath)).toBe(false); // temp copy cleaned up
    expect(existsSync(path)).toBe(true); // source survives
  });

  it("is idempotent on close", () => {
    const { path, dir } = makeTinyMmexDb();
    cleanup.push(dir);
    const db = openReadOnly(path, { snapshot: true });
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});
