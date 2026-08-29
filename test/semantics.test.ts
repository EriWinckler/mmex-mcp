import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MmexDatabase, openReadOnly } from "../src/db/connection.js";
import { generateFixture } from "../src/fixture/generate.js";
import { MMEX_SCHEMA_DDL } from "../src/fixture/schema.js";
import { CategoryTree } from "../src/semantics/categories.js";
import { CurrencyResolver } from "../src/semantics/currency.js";
import { accountFlow, liveRows, reconciledRows, transactionDate } from "../src/semantics/rules.js";

let dir: string;
let db: MmexDatabase;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmex-sem-"));
  const path = join(dir, "demo.mmb");
  generateFixture(path, { seed: 42 });
  db = openReadOnly(path);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A hand-built database where every row's expected treatment is known. */
function handBuilt(rows: string): MmexDatabase {
  const d = mkdtempSync(join(tmpdir(), "mmex-hand-"));
  const path = join(d, "h.mmb");
  const w = new Database(path);
  for (const ddl of MMEX_SCHEMA_DDL) w.exec(ddl);
  w.exec(rows);
  w.close();
  const handle = openReadOnly(path);
  return handle;
}

describe("live-row filter matches the desktop app, not the published reports", () => {
  it("counts Duplicate ('D') rows as real money", () => {
    // The regression this test exists for: MMEX's published Category report
    // filters `status NOT IN ('V','D')`, but the desktop app's is_valid() is
    // only `!is_void() && !is_deleted()`. 'D' appears in no filter anywhere in
    // the application source, so a Duplicate is real money in the register,
    // the balance, and every report.
    const h = handBuilt(`
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
      VALUES (1,1,-1,1,'Withdrawal',10.00,'',1,'2026-01-01','',0),
             (2,1,-1,1,'Withdrawal',20.00,'D',1,'2026-01-02','',0),
             (3,1,-1,1,'Withdrawal',40.00,'F',1,'2026-01-03','',0),
             (4,1,-1,1,'Withdrawal',80.00,'R',1,'2026-01-04','',0);`);
    const kept = h.queryOne<{ total: number }>(
      `SELECT SUM(TRANSAMOUNT) total FROM CHECKINGACCOUNT_V1 t WHERE ${liveRows()}`,
    );
    h.close();
    expect(kept?.total).toBe(150); // all four: 10 + 20 + 40 + 80
  });

  it("excludes void rows", () => {
    const h = handBuilt(`
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
      VALUES (1,1,-1,1,'Withdrawal',10.00,'',1,'2026-01-01','',0),
             (2,1,-1,1,'Withdrawal',20.00,'V',1,'2026-01-02','',0);`);
    const kept = h.queryOne<{ total: number }>(
      `SELECT SUM(TRANSAMOUNT) total FROM CHECKINGACCOUNT_V1 t WHERE ${liveRows()}`,
    );
    h.close();
    expect(kept?.total).toBe(10);
  });

  it("excludes soft deletes in BOTH encodings, and keeps live rows in both", () => {
    const h = handBuilt(`
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
      VALUES (1,1,-1,1,'Withdrawal',10.00,'',1,'2026-01-01','',0),
             (2,1,-1,1,'Withdrawal',20.00,'',1,'2026-01-02',NULL,0),
             (3,1,-1,1,'Withdrawal',40.00,'',1,'2026-01-03','2026-02-01',0);`);
    const kept = h.queryOne<{ total: number }>(
      `SELECT SUM(TRANSAMOUNT) total FROM CHECKINGACCOUNT_V1 t WHERE ${liveRows()}`,
    );
    h.close();
    expect(kept?.total).toBe(30); // '' and NULL are both live, the stamped one is not
  });

  it("keeps NULL-status rows, which a bare STATUS <> 'V' silently drops", () => {
    const h = handBuilt(`
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
      VALUES (1,1,-1,1,'Withdrawal',10.00,NULL,1,'2026-01-01','',0);`);
    const withIfnull = h.queryOne<{ n: number }>(
      `SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 t WHERE ${liveRows()}`,
    );
    // The naive form, for contrast: NULL <> 'V' is NULL, not true.
    const naive = h.queryOne<{ n: number }>("SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 WHERE STATUS <> 'V'");
    h.close();
    expect(withIfnull?.n).toBe(1);
    expect(naive?.n).toBe(0); // demonstrates the bug this guards against
  });

  it("counts only 'R' as reconciled", () => {
    const h = handBuilt(`
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
      VALUES (1,1,-1,1,'Withdrawal',10.00,'R',1,'2026-01-01','',0),
             (2,1,-1,1,'Withdrawal',20.00,'',1,'2026-01-02','',0),
             (3,1,-1,1,'Withdrawal',40.00,'D',1,'2026-01-03','',0);`);
    const rec = h.queryOne<{ total: number }>(
      `SELECT SUM(TRANSAMOUNT) total FROM CHECKINGACCOUNT_V1 t WHERE ${reconciledRows()}`,
    );
    h.close();
    expect(rec?.total).toBe(10);
  });
});

describe("transfer signing matches TrxData::account_flow", () => {
  const transfers = `
    INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
    VALUES (1,1,2,1,'Transfer',100.00,'',-1,'2026-01-01','',92.00),
           (2,1,1,1,'Transfer',500.00,'',-1,'2026-01-02','',500.00);`;

  it("signs the FROM side negative with TRANSAMOUNT", () => {
    const h = handBuilt(transfers);
    const flow = h.queryOne<{ f: number }>(
      `SELECT ${accountFlow("t", "1")} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 1`,
    );
    h.close();
    expect(flow?.f).toBe(-100);
  });

  it("signs the TO side positive with TOTRANSAMOUNT, not TRANSAMOUNT", () => {
    const h = handBuilt(transfers);
    const flow = h.queryOne<{ f: number }>(
      `SELECT ${accountFlow("t", "2")} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 1`,
    );
    h.close();
    // 92.00, the destination-currency figure. Using 100.00 here would be the
    // cross-currency bug: each side takes its own stored column verbatim.
    expect(flow?.f).toBe(92);
  });

  it("nets a transfer to zero across both of its accounts", () => {
    const h = handBuilt(transfers);
    const a = h.queryOne<{ f: number }>(
      `SELECT ${accountFlow("t", "1")} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 1`,
    );
    const b = h.queryOne<{ f: number }>(
      `SELECT ${accountFlow("t", "2")} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 1`,
    );
    h.close();
    // Not zero in absolute terms across currencies, but neither side is income
    // or expense: money left one owned account and arrived in another.
    expect(a?.f).toBeLessThan(0);
    expect(b?.f).toBeGreaterThan(0);
  });

  it("treats a self-transfer as zero (1.9.1 and later)", () => {
    const h = handBuilt(transfers);
    const flow = h.queryOne<{ f: number }>(
      `SELECT ${accountFlow("t", "1")} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 2`,
    );
    h.close();
    expect(flow?.f).toBe(0);
  });

  it("contributes nothing to an unrelated account", () => {
    const h = handBuilt(transfers);
    const flow = h.queryOne<{ f: number }>(
      `SELECT ${accountFlow("t", "9")} f FROM CHECKINGACCOUNT_V1 t WHERE TRANSID = 1`,
    );
    h.close();
    expect(flow?.f).toBe(0);
  });
});

describe("date normalization", () => {
  it("matches rows whose TRANSDATE carries a time component", () => {
    // MMEX writes isoDateTime(), so TRANSDATE can be '2026-01-01T14:30:00'.
    const h = handBuilt(`
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
      VALUES (1,1,-1,1,'Withdrawal',10.00,'',1,'2026-01-01T14:30:00','',0),
             (2,1,-1,1,'Withdrawal',20.00,'',1,'2026-01-01','',0);`);
    const normalized = h.queryOne<{ n: number }>(
      `SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 t WHERE ${transactionDate()} = '2026-01-01'`,
    );
    const naive = h.queryOne<{ n: number }>(
      "SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 WHERE TRANSDATE = '2026-01-01'",
    );
    h.close();
    expect(normalized?.n).toBe(2);
    expect(naive?.n).toBe(1); // demonstrates the bug this guards against
  });
});

describe("CurrencyResolver implements MMEX's six-step chain", () => {
  it("returns 1.0 for the base currency and the -1 sentinel", () => {
    const r = new CurrencyResolver(db);
    expect(r.baseCurrencyId).toBe(1);
    expect(r.rateFor(1, "2026-01-01")).toBe(1);
    expect(r.rateFor(-1, "2026-01-01")).toBe(1);
  });

  it("uses an exact-date history rate when one exists", () => {
    const r = new CurrencyResolver(db);
    const row = db.queryOne<{ CURRDATE: string; CURRVALUE: number }>(
      "SELECT date(CURRDATE) CURRDATE, CURRVALUE FROM CURRENCYHISTORY_V1 WHERE CURRENCYID = 2 ORDER BY CURRDATE LIMIT 1",
    );
    expect(row).toBeDefined();
    expect(r.rateFor(2, row?.CURRDATE ?? "")).toBe(row?.CURRVALUE);
  });

  it("reaches forward to a nearer future rate, not just backward", () => {
    const r = new CurrencyResolver(db);
    const rows = db.query<{ CURRDATE: string; CURRVALUE: number }>(
      "SELECT date(CURRDATE) CURRDATE, CURRVALUE FROM CURRENCYHISTORY_V1 WHERE CURRENCYID = 2 ORDER BY date(CURRDATE)",
    );
    const first = rows[0];
    const second = rows[1];
    expect(first && second).toBeTruthy();
    if (!first || !second) return;
    // A date one day before the earliest history row has no previous rate, so
    // the only candidate is the future one.
    const before = new Date(`${first.CURRDATE}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    expect(r.rateFor(2, before.toISOString().slice(0, 10))).toBe(first.CURRVALUE);
  });

  it("honors different rates on different dates, so history is stable", () => {
    const r = new CurrencyResolver(db);
    const rows = db.query<{ CURRDATE: string; CURRVALUE: number }>(
      "SELECT date(CURRDATE) CURRDATE, CURRVALUE FROM CURRENCYHISTORY_V1 WHERE CURRENCYID = 2 ORDER BY date(CURRDATE)",
    );
    const early = rows[0];
    const late = rows[rows.length - 1];
    if (!early || !late) throw new Error("fixture has no FX history");
    expect(r.rateFor(2, early.CURRDATE)).not.toBe(r.rateFor(2, late.CURRDATE));
  });

  it("reads the zero-decimal currency's precision from SCALE", () => {
    const r = new CurrencyResolver(db);
    expect(r.info(3)?.symbol).toBe("JPY");
    expect(r.info(3)?.places).toBe(0);
    expect(r.info(1)?.places).toBe(2);
  });

  it("defaults USECURRENCYHISTORY to true when the key is absent", () => {
    expect(new CurrencyResolver(db).useCurrencyHistory).toBe(true);
  });
});

describe("CategoryTree", () => {
  it("builds full paths from the PARENTID = -1 root", () => {
    const tree = new CategoryTree(db);
    const names = tree.all().map((c) => c.fullName);
    expect(names).toContain("Food");
    expect(names).toContain("Food:Groceries");
    expect(names).toContain("Food:Dining:Coffee");
  });

  it("uses the delimiter from INFOTABLE_V1 rather than a hardcoded colon", () => {
    expect(new CategoryTree(db).delimiter).toBe(":");
  });

  it("rolls a deep category up to its root", () => {
    const tree = new CategoryTree(db);
    const coffee = tree.all().find((c) => c.fullName === "Food:Dining:Coffee");
    expect(coffee).toBeDefined();
    if (!coffee) return;
    expect(tree.rootOf(coffee.id)).toBe(tree.all().find((c) => c.fullName === "Food")?.id);
  });

  it("labels the uncategorized sentinel rather than inventing a name", () => {
    const tree = new CategoryTree(db);
    expect(tree.nameOf(-1)).toBe("(uncategorized)");
    expect(tree.nameOf(null)).toBe("(uncategorized)");
    expect(tree.nameOf(99999)).toContain("unknown category");
  });

  it("does not hang on a cyclic PARENTID", () => {
    const h = handBuilt(`
      DELETE FROM CATEGORY_V1;
      INSERT INTO CATEGORY_V1 (CATEGID,CATEGNAME,ACTIVE,PARENTID) VALUES (1,'A',1,2),(2,'B',1,1);`);
    const tree = new CategoryTree(h);
    h.close();
    // Both are unresolvable, and crucially the constructor returned.
    expect(tree.orphaned).toHaveLength(2);
  });
});
