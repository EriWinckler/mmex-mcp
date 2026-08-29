import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MmexDatabase, openReadOnly } from "../src/db/connection.js";
import { MMEX_SCHEMA_DDL } from "../src/fixture/schema.js";
import { formatMinor } from "../src/money/money.js";
import { accountBalances, incomeVsExpense, spendingByCategory } from "../src/semantics/analytics.js";
import { CategoryTree } from "../src/semantics/categories.js";
import { CurrencyResolver } from "../src/semantics/currency.js";

/**
 * A deliberately small database where every expected figure is checkable by
 * hand. Each row exists to exercise exactly one rule.
 *
 *   Account 1 "Checking"  USD (base), opening 1000.00
 *   Account 2 "Euro"      EUR,        opening  100.00
 *
 *   EUR history: 2026-01-01 -> 1.5, 2026-02-01 -> 1.6.  BASECONVRATE is 2.0,
 *   deliberately different, so using the current rate is visible in the result.
 *
 *   T1  Checking  Withdrawal   50.00  Groceries   2026-01-05  live
 *   T2  Checking  Deposit    2000.00  (none)      2026-01-10  live
 *   T3  Checking  Transfer    100.00 -> 60.00 EUR 2026-01-15  live
 *   T4  Checking  Withdrawal   30.00  Dining      2026-01-20  SOFT DELETED
 *   T5  Checking  Withdrawal   20.00  Dining      2026-01-25  VOID
 *   T6  Checking  Withdrawal   40.00  Dining      2026-01-26  DUPLICATE (counts)
 *   T7  Checking  Withdrawal   90.00  split 60 Groceries / 30 Rent  2026-01-28
 *   T8  Euro      Withdrawal   10.00  Groceries   2026-02-05  live
 */
let dir: string;
let db: MmexDatabase;
let resolver: CurrencyResolver;
let tree: CategoryTree;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmex-an-"));
  const path = join(dir, "a.mmb");
  const w = new Database(path);
  for (const ddl of MMEX_SCHEMA_DDL) w.exec(ddl);
  w.exec(`
    INSERT INTO INFOTABLE_V1 (INFONAME, INFOVALUE) VALUES ('BaseCurrencyID','1'),('DataVersion','19');
    INSERT INTO CURRENCYFORMATS_V1 (CURRENCYID,CURRENCYNAME,PFX_SYMBOL,SFX_SYMBOL,DECIMAL_POINT,GROUP_SEPARATOR,UNIT_NAME,CENT_NAME,SCALE,BASECONVRATE,CURRENCY_SYMBOL,CURRENCY_TYPE)
      VALUES (1,'US Dollar','$','','.',',','','',100,1.0,'USD','Base'),
             (2,'Euro','E','','.',',','','',100,2.0,'EUR','Other');
    INSERT INTO CURRENCYHISTORY_V1 (CURRENCYID,CURRDATE,CURRVALUE,CURRUPDTYPE)
      VALUES (2,'2026-01-01',1.5,1),(2,'2026-02-01',1.6,1);
    INSERT INTO ACCOUNTLIST_V1 (ACCOUNTID,ACCOUNTNAME,ACCOUNTTYPE,STATUS,INITIALBAL,INITIALDATE,FAVORITEACCT,CURRENCYID)
      VALUES (1,'Checking','Checking','Open',1000.00,'2026-01-01','TRUE',1),
             (2,'Euro','Checking','Open',100.00,'2026-01-01','TRUE',2);
    INSERT INTO CATEGORY_V1 (CATEGID,CATEGNAME,ACTIVE,PARENTID)
      VALUES (1,'Food',1,-1),(2,'Groceries',1,1),(3,'Dining',1,1),(4,'Rent',1,-1);
    INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,CATEGID,TRANSDATE,DELETEDTIME,TOTRANSAMOUNT)
      VALUES (1,1,NULL,1,'Withdrawal',  50.00,'', 2,'2026-01-05','',   0),
             (2,1,NULL,1,'Deposit',   2000.00,'',-1,'2026-01-10',NULL, 0),
             (3,1,2,   1,'Transfer',   100.00,'',-1,'2026-01-15','',  60.00),
             (4,1,NULL,1,'Withdrawal',  30.00,'', 3,'2026-01-20','2026-03-01',0),
             (5,1,NULL,1,'Withdrawal',  20.00,'V',3,'2026-01-25','',   0),
             (6,1,NULL,1,'Withdrawal',  40.00,'D',3,'2026-01-26','',   0),
             (7,1,NULL,1,'Withdrawal',  90.00,'',-1,'2026-01-28','',   0),
             (8,2,NULL,1,'Withdrawal',  10.00,'', 2,'2026-02-05','',   0);
    INSERT INTO SPLITTRANSACTIONS_V1 (TRANSID,CATEGID,SPLITTRANSAMOUNT,NOTES)
      VALUES (7,2,60.00,''),(7,4,30.00,'');
  `);
  w.close();
  db = openReadOnly(path);
  resolver = new CurrencyResolver(db);
  tree = new CategoryTree(db);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("account balances", () => {
  it("computes the checking balance from opening balance plus flows", () => {
    // 1000 - 50 + 2000 - 100 (transfer out) - 40 (duplicate) - 90 = 2720.00
    // Soft-deleted (T4) and void (T5) contribute nothing.
    const result = accountBalances(db, resolver);
    const checking = result.accounts.find((a) => a.name === "Checking");
    expect(formatMinor(checking?.balance ?? { units: 0, places: 2 })).toBe("2720.00");
  });

  it("credits the destination of a transfer with TOTRANSAMOUNT, not TRANSAMOUNT", () => {
    // 100.00 EUR opening + 60.00 arriving - 10.00 spent = 150.00 EUR.
    // Using TRANSAMOUNT (100.00) here would give 190.00.
    const result = accountBalances(db, resolver);
    const euro = result.accounts.find((a) => a.name === "Euro");
    expect(formatMinor(euro?.balance ?? { units: 0, places: 2 })).toBe("150.00");
  });

  it("counts only reconciled rows in the reconciled balance", () => {
    // Nothing in this database is 'R', so it stays at the opening balance.
    const result = accountBalances(db, resolver);
    const checking = result.accounts.find((a) => a.name === "Checking");
    expect(formatMinor(checking?.reconciledBalance ?? { units: 0, places: 2 })).toBe("1000.00");
  });

  it("converts the euro balance at a historical rate, not BASECONVRATE", () => {
    // BASECONVRATE is 2.0, which would give 300.00. The latest transaction is
    // 2026-02-05, whose nearest history row is 2026-02-01 at 1.6 -> 240.00.
    const result = accountBalances(db, resolver);
    const euro = result.accounts.find((a) => a.name === "Euro");
    expect(formatMinor(euro?.balanceBase ?? { units: 0, places: 2 })).toBe("240.00");
    expect(result.basis.kind).toBe("fixed-date");
  });

  it("nets a transfer to zero across the pair, in base currency terms", () => {
    // 2720.00 + 240.00 = 2960.00
    const result = accountBalances(db, resolver);
    expect(formatMinor(result.netWorthBase)).toBe("2960.00");
  });
});

describe("spending by category", () => {
  it("attributes split amounts to their split categories, never the parent", () => {
    // T7's parent has CATEGID -1 but splits 60 to Groceries and 30 to Rent.
    const result = spendingByCategory(db, resolver, tree);
    const byName = new Map(result.categories.map((c) => [c.name, formatMinor(c.amountBase)]));
    // Groceries: 50 (T1) + 60 (T7 split) + 16 (T8, 10 EUR at 1.6) = 126.00
    expect(byName.get("Food:Groceries")).toBe("126.00");
    expect(byName.get("Rent")).toBe("30.00");
  });

  it("includes duplicates and excludes void and deleted", () => {
    // Dining has three rows: 30 deleted, 20 void, 40 duplicate. Only the
    // duplicate counts, because the desktop app excludes neither 'D' nor 'F'.
    const result = spendingByCategory(db, resolver, tree);
    const dining = result.categories.find((c) => c.name === "Food:Dining");
    expect(formatMinor(dining?.amountBase ?? { units: 0, places: 2 })).toBe("40.00");
  });

  it("converts each row at its own transaction date's rate", () => {
    // T8 is 10.00 EUR on 2026-02-05. Nearest history is 2026-02-01 at 1.6, so
    // 16.00. BASECONVRATE (2.0) would give 20.00 and the January rate 15.00.
    const result = spendingByCategory(db, resolver, tree, { from: "2026-02-01", to: "2026-02-28" });
    expect(formatMinor(result.totalBase)).toBe("16.00");
    expect(result.basis.kind).toBe("transaction-date");
  });

  it("excludes transfers from spending and reports how many", () => {
    const result = spendingByCategory(db, resolver, tree);
    // 50 + 60 + 16 + 40 + 30 = 196.00, with the 100.00 transfer left out.
    expect(formatMinor(result.totalBase)).toBe("196.00");
    expect(result.transfersExcluded).toBe(1);
  });

  it("rolls child categories up to their root when asked", () => {
    // Food = Groceries 126 + Dining 40 = 166.00
    const result = spendingByCategory(db, resolver, tree, { rollup: "root" });
    const byName = new Map(result.categories.map((c) => [c.name, formatMinor(c.amountBase)]));
    expect(byName.get("Food")).toBe("166.00");
    expect(byName.get("Rent")).toBe("30.00");
  });

  it("buckets uncategorized income rather than dropping it", () => {
    // The bug in MMEX's own report: an uncategorized non-split transaction
    // vanishes entirely. T2 is a 2000.00 uncategorized deposit.
    const result = spendingByCategory(db, resolver, tree, { direction: "income" });
    const uncategorized = result.categories.find((c) => c.name === "(uncategorized)");
    expect(uncategorized).toBeDefined();
    expect(formatMinor(uncategorized?.amountBase ?? { units: 0, places: 2 })).toBe("2000.00");
  });

  it("filters by date range", () => {
    const jan = spendingByCategory(db, resolver, tree, { from: "2026-01-01", to: "2026-01-31" });
    // January only: 50 + 40 + 60 + 30 = 180.00, the euro row is February.
    expect(formatMinor(jan.totalBase)).toBe("180.00");
  });

  it("filters by account", () => {
    const euroOnly = spendingByCategory(db, resolver, tree, { accountIds: [2] });
    expect(formatMinor(euroOnly.totalBase)).toBe("16.00");
  });
});

describe("income vs expense", () => {
  it("separates income from expense and excludes transfers", () => {
    const result = incomeVsExpense(db, resolver);
    expect(formatMinor(result.incomeBase)).toBe("2000.00");
    expect(formatMinor(result.expenseBase)).toBe("196.00");
    expect(formatMinor(result.netBase)).toBe("1804.00");
    expect(result.transfersExcluded).toBe(1);
  });

  it("groups by month", () => {
    const result = incomeVsExpense(db, resolver, { groupBy: "month" });
    const byPeriod = new Map(result.periods.map((p) => [p.period, p]));
    expect(byPeriod.get("2026-01")).toBeDefined();
    expect(byPeriod.get("2026-02")).toBeDefined();
    // January: 2000 in, 180 out. February: the 16.00 euro row.
    expect(formatMinor(byPeriod.get("2026-01")?.incomeBase ?? { units: 0, places: 2 })).toBe("2000.00");
    expect(formatMinor(byPeriod.get("2026-01")?.expenseBase ?? { units: 0, places: 2 })).toBe("180.00");
    expect(formatMinor(byPeriod.get("2026-02")?.expenseBase ?? { units: 0, places: 2 })).toBe("16.00");
  });

  it("groups by quarter and year", () => {
    const q = incomeVsExpense(db, resolver, { groupBy: "quarter" });
    expect(q.periods.map((p) => p.period)).toEqual(["2026-Q1"]);
    const y = incomeVsExpense(db, resolver, { groupBy: "year" });
    expect(y.periods.map((p) => p.period)).toEqual(["2026"]);
    expect(formatMinor(y.periods[0]?.netBase ?? { units: 0, places: 2 })).toBe("1804.00");
  });
});
