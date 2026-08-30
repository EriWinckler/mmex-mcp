/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openReadOnly } from "../src/db/connection.js";
import { FixtureError, GENERATED_MARKER, generateFixture } from "../src/fixture/generate.js";
import { MMEX_SCHEMA_DDL } from "../src/fixture/schema.js";
import { isForeignAsTransfer, liveRows } from "../src/semantics/rules.js";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "mmex-safety-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("the fixture generator cannot destroy data", () => {
  it("refuses to overwrite an existing file", () => {
    const dir = scratch();
    const out = join(dir, "existing.mmb");
    writeFileSync(out, "important");
    expect(() => generateFixture(out, { seed: 1 })).toThrow(FixtureError);
    expect(() => generateFixture(out, { seed: 1 })).toThrow(/Refusing to overwrite/);
    expect(readFileSync(out, "utf8")).toBe("important");
  });

  it("refuses a real MMEX database even with overwrite requested", () => {
    // --force is for replacing a generated fixture, not for destroying finances.
    const dir = scratch();
    const real = join(dir, "finances.mmb");
    const db = new Database(real);
    for (const ddl of MMEX_SCHEMA_DDL) db.exec(ddl);
    db.close();
    const before = statSync(real).size;

    expect(() => generateFixture(real, { seed: 1, overwrite: true })).toThrow(
      /looks like a real Money Manager EX database/,
    );
    expect(statSync(real).size).toBe(before);
  });

  it("does overwrite a previously generated fixture when asked", () => {
    // --force has to remain useful for its actual purpose. A generated fixture
    // is MMEX-shaped too, so the generator stamps its output and only a stamped
    // file is replaceable.
    const dir = scratch();
    const out = join(dir, "demo.mmb");
    generateFixture(out, { seed: 1 });
    const first = readFileSync(out);
    expect(() => generateFixture(out, { seed: 2, overwrite: true })).not.toThrow();
    expect(readFileSync(out).equals(first)).toBe(false);
  });

  it("stamps generated files so a real database is never mistaken for one", () => {
    const dir = scratch();
    const out = join(dir, "demo.mmb");
    generateFixture(out, { seed: 1 });
    const db = openReadOnly(out);
    const marker = db.info.get(GENERATED_MARKER.toLowerCase());
    db.close();
    expect(marker).toContain("synthetic data");
  });

  it("writes happily to a fresh path", () => {
    const dir = scratch();
    const out = join(dir, "fresh.mmb");
    expect(() => generateFixture(out, { seed: 1 })).not.toThrow();
    expect(existsSync(out)).toBe(true);
  });
});

describe("snapshot mode is WAL-aware", () => {
  function walDatabase(dir: string): { path: string; writer: Database.Database; total: number } {
    const path = join(dir, "wal.mmb");
    const w = new Database(path);
    w.pragma("journal_mode = WAL");
    for (const ddl of MMEX_SCHEMA_DDL) w.exec(ddl);
    w.exec("INSERT INTO INFOTABLE_V1 (INFONAME, INFOVALUE) VALUES ('DataVersion','19')");
    const insert = w.prepare(
      `INSERT INTO CHECKINGACCOUNT_V1
       (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
       VALUES (?,1,-1,1,'Withdrawal',1.00,'',1,'2026-01-01','',0)`,
    );
    for (let i = 1; i <= 500; i++) insert.run(i);
    // Deliberately do NOT checkpoint, and keep the writer open: this is the
    // state a running Money Manager EX leaves the file in.
    return { path, writer: w, total: 500 };
  }

  it("sees rows still sitting in the write-ahead log", () => {
    const dir = scratch();
    const { path, writer, total } = walDatabase(dir);
    try {
      const snap = openReadOnly(path, { snapshot: true });
      const seen = snap.queryOne<{ n: number }>("SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1");
      snap.close();
      // A plain file copy would take only the main .mmb and see the last
      // checkpoint, silently losing everything since.
      expect(seen?.n).toBe(total);
    } finally {
      writer.close();
    }
  });

   it.skipIf(process.platform === "win32")(
    "gives the snapshot copy owner-only permissions",
    () => {
      // Windows/NTFS has no POSIX permission model — chmod can only toggle
      // the read-only attribute, so this check isn't meaningful there.
      const dir = scratch();
      const { path, writer } = walDatabase(dir);
      try {
        const snap = openReadOnly(path, { snapshot: true });
        const mode = statSync(snap.openedPath).mode & 0o777;
        snap.close();
        expect(mode).toBe(0o600);
      } finally {
        writer.close();
      }
    },
  );

  it("removes the copy on close, leaving nothing in the temp directory", () => {
    const dir = scratch();
    const { path, writer } = walDatabase(dir);
    try {
      const before = readdirSync(tmpdir()).filter((n) => n.startsWith("mmex-mcp-")).length;
      const snap = openReadOnly(path, { snapshot: true });
      const copy = snap.openedPath;
      snap.close();
      expect(existsSync(copy)).toBe(false);
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith("mmex-mcp-")).length).toBe(before);
    } finally {
      writer.close();
    }
  });
});

describe("isForeignAsTransfer", () => {
  function db(rows: string) {
    const dir = scratch();
    const path = join(dir, "f.mmb");
    const w = new Database(path);
    for (const ddl of MMEX_SCHEMA_DDL) w.exec(ddl);
    w.exec(rows);
    w.close();
    return openReadOnly(path);
  }

  const ROWS = `
    INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
    VALUES (1,1,NULL,1,'Withdrawal',10.00,'',1,'2026-01-01','',0),
           (2,1,NULL,1,'Deposit',20.00,'',1,'2026-01-02','',0),
           (3,1,-998,1,'Withdrawal',40.00,'',1,'2026-01-03','',0),
           (4,1,1,1,'Withdrawal',80.00,'',1,'2026-01-04','',0),
           (5,1,2,1,'Transfer',60.00,'',-1,'2026-01-05','',60.00);`;

  it("detects the AS_TRANSFER sentinel", () => {
    // An earlier version guarded on TOACCOUNTID > 0, which made the negative
    // sentinel branch unreachable, so asset and share purchases were counted
    // as ordinary expenses.
    const h = db(ROWS);
    const hit = h.queryOne<{ f: number }>(
      `SELECT ${isForeignAsTransfer()} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 3`,
    );
    h.close();
    expect(hit?.f).toBe(1);
  });

  it("detects a row whose TOACCOUNTID is its own account", () => {
    const h = db(ROWS);
    const hit = h.queryOne<{ f: number }>(
      `SELECT ${isForeignAsTransfer()} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 4`,
    );
    h.close();
    expect(hit?.f).toBe(1);
  });

  it("returns 0, never NULL, for ordinary transactions with a NULL TOACCOUNTID", () => {
    // This is the one that matters. NULL would make `WHERE NOT (...)` filter
    // out every ordinary withdrawal and deposit, which is nearly every row in a
    // real database, and report near-zero income and expense.
    const h = db(ROWS);
    const rows = h.query<{ TRANSID: number; f: number }>(
      `SELECT TRANSID, ${isForeignAsTransfer()} f FROM CHECKINGACCOUNT_V1 t ORDER BY TRANSID`,
    );
    const kept = h.query<{ TRANSID: number }>(
      `SELECT TRANSID FROM CHECKINGACCOUNT_V1 t WHERE NOT (${isForeignAsTransfer()}) ORDER BY TRANSID`,
    );
    h.close();

    expect(rows.find((r) => r.TRANSID === 1)?.f).toBe(0);
    expect(rows.find((r) => r.TRANSID === 2)?.f).toBe(0);
    for (const r of rows) expect(r.f, `TRANSID ${r.TRANSID}`).not.toBeNull();

    // The natural caller expression keeps the ordinary rows and the transfer,
    // and drops only the two asset-style rows.
    expect(kept.map((r) => r.TRANSID)).toEqual([1, 2, 5]);
  });

  it("does not flag a real Transfer", () => {
    const h = db(ROWS);
    const hit = h.queryOne<{ f: number }>(
      `SELECT ${isForeignAsTransfer()} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 5`,
    );
    h.close();
    expect(hit?.f).toBe(0);
  });

  it("composes with liveRows without producing NULL", () => {
    const h = db(ROWS);
    const n = h.queryOne<{ n: number }>(
      `SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 t WHERE ${liveRows()} AND NOT (${isForeignAsTransfer()})`,
    );
    h.close();
    expect(n?.n).toBe(3);
  });
});
