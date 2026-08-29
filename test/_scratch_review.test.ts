import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openReadOnly } from "../src/db/connection.js";
import { MMEX_SCHEMA_DDL } from "../src/fixture/schema.js";
import { accountBalances, incomeVsExpense, spendingByCategory } from "../src/semantics/analytics.js";
import { CategoryTree } from "../src/semantics/categories.js";
import { CurrencyResolver } from "../src/semantics/currency.js";

function build(seed: string) {
  const dir = mkdtempSync(join(tmpdir(), "mmex-rev-"));
  const path = join(dir, "t.mmb");
  const db = new Database(path);
  for (const ddl of MMEX_SCHEMA_DDL) db.exec(ddl);
  db.exec(seed);
  db.close();
  const h = openReadOnly(path);
  return { h, resolver: new CurrencyResolver(h), tree: new CategoryTree(h) };
}

const BASE = `
INSERT INTO INFOTABLE_V1 (INFONAME, INFOVALUE) VALUES ('DataVersion','19'),('BaseCurrencyID','1');
INSERT INTO CURRENCYFORMATS_V1 (CURRENCYID, CURRENCYNAME, CURRENCY_SYMBOL, CURRENCY_TYPE, SCALE, BASECONVRATE)
  VALUES (1,'US Dollar','USD','Fiat',100,1.0);
INSERT INTO ACCOUNTLIST_V1 (ACCOUNTID, ACCOUNTNAME, ACCOUNTTYPE, STATUS, FAVORITEACCT, CURRENCYID, INITIALBAL)
  VALUES (1,'Checking','Checking','Open','FALSE',1,100.00);
INSERT INTO CATEGORY_V1 (CATEGID, CATEGNAME, PARENTID, ACTIVE) VALUES (1,'Food',-1,1),(2,'Coffee',1,1);
`;

describe("scratch: doc-vs-code", () => {
  it("C5: uncategorized non-split rows are bucketed, not dropped", () => {
    const { h, resolver, tree } = build(`${BASE}
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,TRANSDATE,CATEGID,DELETEDTIME)
      VALUES (1,1,NULL,1,'Withdrawal',40.00,'','2026-01-05',-1,''),
             (2,1,NULL,1,'Withdrawal',10.00,'','2026-01-06',1,'');`);
    const r = spendingByCategory(h, resolver, tree, {});
    expect(r.totalBase.units).toBe(5000);
    expect(r.uncategorizedBase.units).toBe(4000);
  });

  it("C1: 'D' and 'F' rows are real money", () => {
    const { h, resolver, tree } = build(`${BASE}
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,TRANSDATE,CATEGID,DELETEDTIME)
      VALUES (1,1,NULL,1,'Withdrawal',10.00,'D','2026-01-05',1,''),
             (2,1,NULL,1,'Withdrawal',20.00,'F','2026-01-06',1,''),
             (3,1,NULL,1,'Withdrawal',30.00,'V','2026-01-07',1,''),
             (4,1,NULL,1,'Withdrawal',40.00,'','2026-01-08',1,'2026-02-01');`);
    const r = spendingByCategory(h, resolver, tree, {});
    expect(r.totalBase.units).toBe(3000);
  });

  it("split attribution signs by parent TRANSCODE", () => {
    const { h, resolver, tree } = build(`${BASE}
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,TRANSDATE,CATEGID,DELETEDTIME)
      VALUES (1,1,NULL,1,'Withdrawal',30.00,'','2026-01-05',-1,'');
      INSERT INTO SPLITTRANSACTIONS_V1 (SPLITTRANSID,TRANSID,CATEGID,SPLITTRANSAMOUNT)
      VALUES (1,1,1,40.00),(2,1,2,-10.00);`);
    const r = spendingByCategory(h, resolver, tree, { direction: "both" });
    const byId = new Map(r.categories.map((c) => [c.categoryId, c.amountBase.units]));
    expect(byId.get(1)).toBe(-4000);
    expect(byId.get(2)).toBe(1000);
  });

  it("SCALE=0: every amount collapses to zero", () => {
    const { h, resolver, tree } = build(`
      INSERT INTO INFOTABLE_V1 (INFONAME, INFOVALUE) VALUES ('DataVersion','19'),('BaseCurrencyID','1');
      INSERT INTO CURRENCYFORMATS_V1 (CURRENCYID, CURRENCYNAME, CURRENCY_SYMBOL, CURRENCY_TYPE, SCALE, BASECONVRATE)
        VALUES (1,'Odd','ODD','Fiat',0,1.0);
      INSERT INTO ACCOUNTLIST_V1 (ACCOUNTID,ACCOUNTNAME,ACCOUNTTYPE,STATUS,FAVORITEACCT,CURRENCYID,INITIALBAL)
        VALUES (1,'Checking','Checking','Open','FALSE',1,100.00);
      INSERT INTO CATEGORY_V1 (CATEGID,CATEGNAME,PARENTID,ACTIVE) VALUES (1,'Food',-1,1);
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,TRANSDATE,CATEGID,DELETEDTIME)
      VALUES (1,1,NULL,1,'Withdrawal',40.00,'','2026-01-05',1,'');`);
    const r = spendingByCategory(h, resolver, tree, {});
    console.log("SCALE=0 spending total:", JSON.stringify(r.totalBase), "cats:", r.categories.length);
    const b = accountBalances(h, resolver, {});
    console.log(
      "SCALE=0 balance:",
      JSON.stringify(b.accounts[0]?.balance),
      "netWorth:",
      JSON.stringify(b.netWorthBase),
    );
  });

  it("SCALE=3 (not a power of ten): SQL and places disagree", () => {
    const { h, resolver, tree } = build(`
      INSERT INTO INFOTABLE_V1 (INFONAME, INFOVALUE) VALUES ('DataVersion','19'),('BaseCurrencyID','1');
      INSERT INTO CURRENCYFORMATS_V1 (CURRENCYID, CURRENCYNAME, CURRENCY_SYMBOL, CURRENCY_TYPE, SCALE, BASECONVRATE)
        VALUES (1,'Odd','ODD','Fiat',3,1.0);
      INSERT INTO ACCOUNTLIST_V1 (ACCOUNTID,ACCOUNTNAME,ACCOUNTTYPE,STATUS,FAVORITEACCT,CURRENCYID,INITIALBAL)
        VALUES (1,'Checking','Checking','Open','FALSE',1,0.00);
      INSERT INTO CATEGORY_V1 (CATEGID,CATEGNAME,PARENTID,ACTIVE) VALUES (1,'Food',-1,1);
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,TRANSDATE,CATEGID,DELETEDTIME)
      VALUES (1,1,NULL,1,'Withdrawal',100.00,'','2026-01-05',1,'');`);
    const r = spendingByCategory(h, resolver, tree, {});
    console.log(
      "SCALE=3 spending total:",
      JSON.stringify(r.totalBase),
      "(expect 100.00 -> units 10000 at 2 places)",
    );
  });

  it("negative SCALE flips signs", () => {
    const { h, resolver, tree } = build(`
      INSERT INTO INFOTABLE_V1 (INFONAME, INFOVALUE) VALUES ('DataVersion','19'),('BaseCurrencyID','1');
      INSERT INTO CURRENCYFORMATS_V1 (CURRENCYID, CURRENCYNAME, CURRENCY_SYMBOL, CURRENCY_TYPE, SCALE, BASECONVRATE)
        VALUES (1,'Odd','ODD','Fiat',-100,1.0);
      INSERT INTO ACCOUNTLIST_V1 (ACCOUNTID,ACCOUNTNAME,ACCOUNTTYPE,STATUS,FAVORITEACCT,CURRENCYID,INITIALBAL)
        VALUES (1,'Checking','Checking','Open','FALSE',1,0.00);
      INSERT INTO CATEGORY_V1 (CATEGID,CATEGNAME,PARENTID,ACTIVE) VALUES (1,'Food',-1,1);
      INSERT INTO CHECKINGACCOUNT_V1 (TRANSID,ACCOUNTID,TOACCOUNTID,PAYEEID,TRANSCODE,TRANSAMOUNT,STATUS,TRANSDATE,CATEGID,DELETEDTIME)
      VALUES (1,1,NULL,1,'Withdrawal',100.00,'','2026-01-05',1,'');`);
    const r = spendingByCategory(h, resolver, tree, {});
    console.log("SCALE=-100 spending:", JSON.stringify(r.totalBase), "cats:", JSON.stringify(r.categories));
    const i = incomeVsExpense(h, resolver, {});
    console.log("SCALE=-100 income/expense:", JSON.stringify(i.incomeBase), JSON.stringify(i.expenseBase));
  });
});
