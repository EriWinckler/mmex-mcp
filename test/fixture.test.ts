import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReadOnly } from "../src/db/connection.js";
import { type FixtureSummary, generateFixture } from "../src/fixture/generate.js";

let dir: string;
let summary: FixtureSummary;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmex-fixture-"));
  summary = generateFixture(join(dir, "a.mmb"), { seed: 42 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("determinism", () => {
  it("produces a byte-identical file for the same seed", () => {
    const b = join(dir, "b.mmb");
    generateFixture(b, { seed: 42 });
    expect(readFileSync(b).equals(readFileSync(summary.path))).toBe(true);
  });

  it("produces a different file for a different seed", () => {
    const c = join(dir, "c.mmb");
    generateFixture(c, { seed: 43 });
    expect(readFileSync(c).equals(readFileSync(summary.path))).toBe(false);
  });

  it("never depends on the current date", () => {
    // The anchor is fixed, so the newest transaction is always before it.
    const db = openReadOnly(summary.path);
    const hi = db.queryOne<{ hi: string }>("SELECT MAX(TRANSDATE) hi FROM CHECKINGACCOUNT_V1");
    db.close();
    expect(hi?.hi).toBeDefined();
    expect(hi?.hi.localeCompare(summary.anchorDate)).toBeLessThanOrEqual(0);
  });

  it("is small enough to commit as a test fixture", () => {
    expect(statSync(summary.path).size).toBeLessThan(2_000_000);
  });
});

describe("the fixture is a valid MMEX database", () => {
  it("opens through the read-only connection layer", () => {
    const db = openReadOnly(summary.path);
    expect(db.info.get("basecurrencyid")).toBe("1");
    expect(db.verifyReadOnly()).toEqual({ queryOnly: true, writeRejectedWith: "SQLITE_READONLY" });
    db.close();
  });
});

describe("every semantic trap is actually planted", () => {
  it("has soft-deleted rows in both the empty-string and NULL encodings", () => {
    const db = openReadOnly(summary.path);
    const deleted = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 WHERE DELETEDTIME IS NOT NULL AND DELETEDTIME <> ''",
    );
    const emptyString = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 WHERE DELETEDTIME = ''",
    );
    const nulls = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 WHERE DELETEDTIME IS NULL",
    );
    db.close();
    expect(deleted?.n).toBeGreaterThan(0);
    expect(emptyString?.n).toBeGreaterThan(0);
    expect(nulls?.n).toBeGreaterThan(0);
  });

  it("has void and duplicate statuses", () => {
    const db = openReadOnly(summary.path);
    const rows = db.query<{ STATUS: string; n: number }>(
      "SELECT STATUS, COUNT(*) n FROM CHECKINGACCOUNT_V1 GROUP BY STATUS",
    );
    db.close();
    const byStatus = new Map(rows.map((r) => [r.STATUS, r.n]));
    expect(byStatus.get("V") ?? 0).toBeGreaterThan(0);
    expect(byStatus.get("D") ?? 0).toBeGreaterThan(0);
    expect(byStatus.get("R") ?? 0).toBeGreaterThan(0);
  });

  it("has transfers in one and two currencies", () => {
    const db = openReadOnly(summary.path);
    const same = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 WHERE TRANSCODE='Transfer' AND TRANSAMOUNT = TOTRANSAMOUNT",
    );
    const cross = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 WHERE TRANSCODE='Transfer' AND TRANSAMOUNT <> TOTRANSAMOUNT",
    );
    db.close();
    expect(same?.n).toBeGreaterThan(0);
    expect(cross?.n).toBeGreaterThan(0);
  });

  it("gives split parents no category of their own", () => {
    const db = openReadOnly(summary.path);
    const parents = db.query<{ CATEGID: number }>(
      "SELECT DISTINCT c.CATEGID FROM CHECKINGACCOUNT_V1 c JOIN SPLITTRANSACTIONS_V1 s ON s.TRANSID = c.TRANSID",
    );
    db.close();
    expect(parents).toHaveLength(1);
    expect(parents[0]?.CATEGID).toBe(-1);
  });

  it("keeps split rows summing to their parent amount", () => {
    const db = openReadOnly(summary.path);
    const mismatched = db.queryOne<{ bad: number }>(`
      SELECT COUNT(*) bad FROM (
        SELECT c.TRANSID
        FROM CHECKINGACCOUNT_V1 c JOIN SPLITTRANSACTIONS_V1 s ON s.TRANSID = c.TRANSID
        GROUP BY c.TRANSID
        HAVING ROUND(c.TRANSAMOUNT, 2) <> ROUND(SUM(s.SPLITTRANSAMOUNT), 2))`);
    db.close();
    expect(mismatched?.bad).toBe(0);
  });

  it("has a three-level category tree rooted at PARENTID = -1", () => {
    const db = openReadOnly(summary.path);
    const depths = db.query<{ fullname: string; depth: number }>(`
      WITH RECURSIVE t(categid, fullname, depth) AS (
        SELECT CATEGID, CATEGNAME, 1 FROM CATEGORY_V1 WHERE PARENTID = -1
        UNION ALL
        SELECT c.CATEGID, t.fullname || ':' || c.CATEGNAME, t.depth + 1
        FROM t JOIN CATEGORY_V1 c ON c.PARENTID = t.categid)
      SELECT fullname, depth FROM t ORDER BY depth DESC LIMIT 1`);
    db.close();
    expect(depths[0]?.depth).toBe(3);
    expect(depths[0]?.fullname).toContain(":");
  });

  it("has a zero-decimal currency and drifting FX history", () => {
    const db = openReadOnly(summary.path);
    const jpy = db.queryOne<{ SCALE: number }>(
      "SELECT SCALE FROM CURRENCYFORMATS_V1 WHERE CURRENCY_SYMBOL = 'JPY'",
    );
    const spread = db.queryOne<{ lo: number; hi: number }>(
      "SELECT MIN(CURRVALUE) lo, MAX(CURRVALUE) hi FROM CURRENCYHISTORY_V1 WHERE CURRENCYID = 2",
    );
    db.close();
    expect(jpy?.SCALE).toBe(1); // divisor 1 means zero decimal places
    expect(spread?.hi).toBeGreaterThan(spread?.lo ?? 0); // rates actually move
  });

  it("reports what it planted", () => {
    expect(summary.counts.transactionsTotal).toBeGreaterThan(800);
    expect(summary.counts.softDeleted).toBeGreaterThan(0);
    expect(summary.counts.splitParents).toBeGreaterThan(0);
    expect(summary.counts.transfersCrossCurrency).toBeGreaterThan(0);
  });
});
