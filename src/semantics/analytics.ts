/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/
import type { MmexDatabase } from "../db/connection.js";
import { convertMinor, type Minor, sumMinor } from "../money/money.js";
import type { CategoryTree } from "./categories.js";
import type { CurrencyResolver } from "./currency.js";
import { accountFlow, isForeignAsTransfer, liveRows, transactionDate, transCode } from "./rules.js";

/**
 * Analytics over an MMEX database.
 *
 * Two rules shape every query here.
 *
 * Amounts are aggregated in SQL as INTEGER minor units, never as floats:
 * `SUM(CAST(ROUND(amount * SCALE) AS INTEGER))`. SQLite integers are 64-bit and
 * exact, so a sum over 50,000 rows carries no accumulated error. Summing the
 * `numeric` columns directly would be a float sum, and while it usually rounds
 * back to the right answer, "usually" is not a property worth building a
 * finance tool on.
 *
 * Conversion to the base currency happens per transaction date, so results
 * grouped by (bucket, currency, date) come back from SQL and are converted and
 * summed in TypeScript. Converting an aggregate at one rate would make last
 * year's totals move whenever today's rate moves.
 */

/** Which date each row's exchange rate was taken at. */
export type RateBasis =
  | { readonly kind: "transaction-date" }
  | { readonly kind: "fixed-date"; readonly date: string };

export interface DateRange {
  /** ISO YYYY-MM-DD, inclusive. */
  readonly from?: string;
  /** ISO YYYY-MM-DD, inclusive. */
  readonly to?: string;
}

export class AnalyticsError extends Error {
  override readonly name = "AnalyticsError";
}

/**
 * SQL multiplier that turns a decimal amount into integer minor units.
 *
 * Built from placesFromScale's validated output, NOT from CURRENCYFORMATS_V1
 * .SCALE directly. The raw column is nullable and unconstrained, and using it
 * meant the SQL multiplier and the JS `places` could disagree: SCALE = 0 made
 * every balance in that currency read 0.00, SCALE = 50 halved it, and a
 * negative SCALE flipped its sign, all without an error. Hardening
 * placesFromScale to fall back rather than throw is what turned that from a
 * loud failure into a silent wrong number, so the two must be derived from one
 * source.
 */
function scaleExpression(resolver: CurrencyResolver, currencyIdSql: string): string {
  const arms = resolver
    .all()
    .map((c) => `WHEN ${Number(c.id)} THEN ${10 ** c.places}`)
    .join(" ");
  const fallback = 10 ** resolver.basePlaces;
  return arms === "" ? String(fallback) : `CASE ${currencyIdSql} ${arms} ELSE ${fallback} END`;
}

function rangeClause(range: DateRange, alias = "t"): { sql: string; params: Record<string, string> } {
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    // Silently returning nothing would look like "you spent nothing", which is
    // a wrong answer rather than a refused one.
    throw new AnalyticsError(`Date range is backwards: from ${range.from} is later than to ${range.to}`);
  }
  const parts: string[] = [];
  const params: Record<string, string> = {};
  if (range.from !== undefined) {
    parts.push(`${transactionDate(alias)} >= @from`);
    params.from = range.from;
  }
  if (range.to !== undefined) {
    parts.push(`${transactionDate(alias)} <= @to`);
    params.to = range.to;
  }
  return { sql: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "", params };
}

/**
 * Convert rows already aggregated per (currency, date) into one base-currency
 * total. Each row is converted at its own date's rate, then summed exactly.
 */
function convertAndSum(
  rows: readonly { currencyId: number; date: string; units: number }[],
  resolver: CurrencyResolver,
  basis: RateBasis,
): Minor {
  const basePlaces = resolver.basePlaces;
  const converted: Minor[] = [];
  for (const row of rows) {
    const currency = resolver.info(row.currencyId);
    const places = currency?.places ?? basePlaces;
    const amount: Minor = { units: row.units, places };
    if (row.currencyId === resolver.baseCurrencyId) {
      converted.push(places === basePlaces ? amount : convertMinor(amount, 1, basePlaces));
      continue;
    }
    const rateDate = basis.kind === "fixed-date" ? basis.date : row.date;
    converted.push(convertMinor(amount, resolver.rateFor(row.currencyId, rateDate), basePlaces));
  }
  return sumMinor(converted, basePlaces);
}

// ---------------------------------------------------------------------------
// Account balances
// ---------------------------------------------------------------------------

export interface AccountBalance {
  readonly accountId: number;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly currency: string;
  /** In the account's own currency. */
  readonly balance: Minor;
  /** Same balance converted to the base currency. */
  readonly balanceBase: Minor;
  /** Only STATUS = 'R' rows, in the account's own currency. */
  readonly reconciledBalance: Minor;
  readonly transactionCount: number;
}

export interface AccountBalancesResult {
  readonly accounts: readonly AccountBalance[];
  readonly netWorthBase: Minor;
  readonly asOf: string | null;
  readonly basis: RateBasis;
}

/**
 * Balances, following MMEX: start from ACCOUNTLIST_V1.INITIALBAL and apply
 * `account_flow` per transaction. A transfer is visited once per side, so the
 * join matches both ACCOUNTID and TOACCOUNTID.
 *
 * Rate basis is a single fixed date (the `asOf` date, or the latest transaction
 * in the database), matching what MMEX's own home page does for account totals.
 * The per-transaction-date basis is used for the flow reports instead, which is
 * MMEX's own split too.
 */
export function accountBalances(
  db: MmexDatabase,
  resolver: CurrencyResolver,
  options: { readonly asOf?: string; readonly includeClosed?: boolean } = {},
): AccountBalancesResult {
  const scale = scaleExpression(resolver, "a.CURRENCYID");
  const asOfClause = options.asOf !== undefined ? ` AND ${transactionDate("t")} <= @asOf` : "";
  const statusClause = options.includeClosed === true ? "" : " AND a.STATUS <> 'Closed'";

  const rows = db.query<{
    ACCOUNTID: number;
    ACCOUNTNAME: string;
    ACCOUNTTYPE: string;
    STATUS: string;
    CURRENCYID: number;
    initialUnits: number;
    flowUnits: number | null;
    reconciledUnits: number | null;
    txCount: number;
  }>(
    `SELECT a.ACCOUNTID, a.ACCOUNTNAME, a.ACCOUNTTYPE, a.STATUS, a.CURRENCYID,
            CAST(ROUND(IFNULL(a.INITIALBAL, 0) * ${scale}) AS INTEGER) AS initialUnits,
            SUM(CAST(ROUND((${accountFlow("t", "a.ACCOUNTID")}) * ${scale}) AS INTEGER)) AS flowUnits,
            SUM(CASE WHEN IFNULL(t.STATUS,'') = 'R'
                     THEN CAST(ROUND((${accountFlow("t", "a.ACCOUNTID")}) * ${scale}) AS INTEGER)
                     ELSE 0 END) AS reconciledUnits,
            COUNT(t.TRANSID) AS txCount
       FROM ACCOUNTLIST_V1 a
       LEFT JOIN CURRENCYFORMATS_V1 cf ON cf.CURRENCYID = a.CURRENCYID
       LEFT JOIN CHECKINGACCOUNT_V1 t
              ON (t.ACCOUNTID = a.ACCOUNTID OR t.TOACCOUNTID = a.ACCOUNTID)
             AND ${liveRows("t")}${asOfClause}
      WHERE 1 = 1${statusClause}
      GROUP BY a.ACCOUNTID
      ORDER BY a.ACCOUNTNAME COLLATE NOCASE`,
    options.asOf !== undefined ? { asOf: options.asOf } : {},
  );

  const latest = db.queryOne<{ hi: string | null }>(
    `SELECT MAX(${transactionDate("t")}) hi FROM CHECKINGACCOUNT_V1 t WHERE ${liveRows("t")}`,
  );
  const rateDate = options.asOf ?? latest?.hi ?? null;
  const basis: RateBasis =
    rateDate === null ? { kind: "transaction-date" } : { kind: "fixed-date", date: rateDate };

  const basePlaces = resolver.basePlaces;
  const accounts: AccountBalance[] = [];
  const baseTotals: Minor[] = [];

  for (const row of rows) {
    const currency = resolver.info(row.CURRENCYID);
    const places = currency?.places ?? basePlaces;
    const balance: Minor = { units: row.initialUnits + (row.flowUnits ?? 0), places };
    const reconciled: Minor = { units: row.initialUnits + (row.reconciledUnits ?? 0), places };

    const balanceBase =
      row.CURRENCYID === resolver.baseCurrencyId && places === basePlaces
        ? balance
        : convertMinor(
            balance,
            row.CURRENCYID === resolver.baseCurrencyId
              ? 1
              : resolver.rateFor(row.CURRENCYID, rateDate ?? "1970-01-01"),
            basePlaces,
          );

    accounts.push({
      accountId: row.ACCOUNTID,
      name: row.ACCOUNTNAME,
      type: row.ACCOUNTTYPE,
      status: row.STATUS,
      currency: currency?.symbol ?? String(row.CURRENCYID),
      balance,
      balanceBase,
      reconciledBalance: reconciled,
      transactionCount: row.txCount,
    });
    baseTotals.push(balanceBase);
  }

  return {
    accounts,
    netWorthBase: sumMinor(baseTotals, basePlaces),
    asOf: options.asOf ?? null,
    basis,
  };
}

// ---------------------------------------------------------------------------
// Spending by category
// ---------------------------------------------------------------------------

export interface CategoryTotal {
  readonly categoryId: number;
  readonly name: string;
  readonly amountBase: Minor;
  readonly transactionCount: number;
}

export interface SpendingByCategoryResult {
  readonly categories: readonly CategoryTotal[];
  /** Over ALL groups, including those below the cap. Never the sum of `categories`. */
  readonly totalBase: Minor;
  /**
   * The groups that did not fit under the cap, folded into one figure.
   *
   * This exists so `sum(categories) + otherBase = totalBase` holds exactly. A
   * capped aggregate without it invites a reader to add up the visible rows and
   * report a total short by the entire tail, which is the same class of silent
   * wrongness this server exists to prevent.
   */
  readonly otherBase: Minor;
  readonly otherGroups: number;
  readonly groupsTotal: number;
  readonly uncategorizedBase: Minor;
  readonly transfersExcluded: number;
  readonly assetTransfersExcluded: number;
  readonly truncated: boolean;
  readonly basis: RateBasis;
}

export interface SpendingOptions extends DateRange {
  /** "leaf" reports the category as recorded; "root" rolls up to the top level. */
  readonly rollup?: "leaf" | "root";
  /** Only outflows by default. "income" for inflows, "both" for the net. */
  readonly direction?: "expense" | "income" | "both";
  readonly accountIds?: readonly number[];
  /** Cap on returned rows. The total is always over everything. */
  readonly limit?: number;
}

/**
 * Spending grouped by category.
 *
 * This is where the schema's traps compound, so the shape of the query matters:
 *
 * - Split and unsplit transactions are two separate branches, unioned. The
 *   discriminator is whether SPLITTRANSACTIONS_V1 rows exist, never
 *   CATEGID = -1, because that sentinel also means "plain uncategorized" and
 *   conflating the two is what makes MMEX's own report lose money.
 * - A split row is signed by its PARENT's TRANSCODE, not by its own sign.
 * - Transfers are excluded, and so are asset and share movements that MMEX
 *   treats as transfers.
 * - Every row is converted at its own transaction date's rate.
 */
export function spendingByCategory(
  db: MmexDatabase,
  resolver: CurrencyResolver,
  tree: CategoryTree,
  options: SpendingOptions = {},
): SpendingByCategoryResult {
  const { sql: range, params } = rangeClause(options);
  const direction = options.direction ?? "expense";
  const limit = options.limit ?? 25;

  const accountFilter =
    options.accountIds !== undefined && options.accountIds.length > 0
      ? ` AND t.ACCOUNTID IN (${options.accountIds.map((id) => Number(id)).join(",")})`
      : "";

  // Anything not a Deposit is a Withdrawal, matching MMEX's parser default.
  const sign = `CASE WHEN ${transCode("t")} = 'DEPOSIT' THEN 1 ELSE -1 END`;
  const scale = scaleExpression(resolver, "a.CURRENCYID");
  const common =
    `${liveRows("t")}` +
    ` AND ${transCode("t")} <> 'TRANSFER'` +
    ` AND NOT (${isForeignAsTransfer("t")})` +
    `${accountFilter}${range}`;

  const rows = db.query<{ bucketId: number; curId: number; day: string; units: number; n: number }>(
    `SELECT u.bucketId AS bucketId, u.curId AS curId, u.day AS day,
            SUM(u.units) AS units, SUM(u.n) AS n
       FROM (
       SELECT IFNULL(t.CATEGID, -1) AS bucketId, a.CURRENCYID AS curId,
              ${transactionDate("t")} AS day,
              SUM(${sign} * CAST(ROUND(t.TRANSAMOUNT * ${scale}) AS INTEGER)) AS units,
              COUNT(*) AS n
         FROM CHECKINGACCOUNT_V1 t
         JOIN ACCOUNTLIST_V1 a ON a.ACCOUNTID = t.ACCOUNTID
         LEFT JOIN CURRENCYFORMATS_V1 cf ON cf.CURRENCYID = a.CURRENCYID
        WHERE NOT EXISTS (SELECT 1 FROM SPLITTRANSACTIONS_V1 s WHERE s.TRANSID = t.TRANSID)
          AND ${common}
        GROUP BY 1, 2, 3
       UNION ALL
       SELECT IFNULL(s.CATEGID, -1) AS bucketId, a.CURRENCYID AS curId,
              ${transactionDate("t")} AS day,
              SUM(${sign} * CAST(ROUND(s.SPLITTRANSAMOUNT * ${scale}) AS INTEGER)) AS units,
              COUNT(*) AS n
         FROM CHECKINGACCOUNT_V1 t
         JOIN SPLITTRANSACTIONS_V1 s ON s.TRANSID = t.TRANSID
         JOIN ACCOUNTLIST_V1 a ON a.ACCOUNTID = t.ACCOUNTID
         LEFT JOIN CURRENCYFORMATS_V1 cf ON cf.CURRENCYID = a.CURRENCYID
        WHERE ${common}
        GROUP BY 1, 2, 3
     ) u
      GROUP BY u.bucketId, u.curId, u.day`,
    params,
  );

  const excluded = db.queryOne<{ transfers: number; assets: number }>(
    `SELECT SUM(CASE WHEN ${transCode("t")} = 'TRANSFER' THEN 1 ELSE 0 END) AS transfers,
            SUM(CASE WHEN ${isForeignAsTransfer("t")} THEN 1 ELSE 0 END) AS assets
       FROM CHECKINGACCOUNT_V1 t
      WHERE ${liveRows("t")}${accountFilter}${range}`,
    params,
  );

  const basePlaces = resolver.basePlaces;
  const basis: RateBasis = { kind: "transaction-date" };

  // Bucket per category, keeping (currency, date) so conversion stays per-date.
  const buckets = new Map<
    number,
    { rows: { currencyId: number; date: string; units: number }[]; n: number }
  >();
  for (const row of rows) {
    const bucketId =
      options.rollup === "root" && row.bucketId > 0
        ? (tree.rootOf(row.bucketId) ?? row.bucketId)
        : row.bucketId;
    const bucket = buckets.get(bucketId) ?? { rows: [], n: 0 };
    bucket.rows.push({ currencyId: row.curId, date: row.day, units: row.units });
    bucket.n += row.n;
    buckets.set(bucketId, bucket);
  }

  const all: CategoryTotal[] = [];
  for (const [categoryId, bucket] of buckets) {
    const amountBase = convertAndSum(bucket.rows, resolver, basis);
    if (direction === "expense" && amountBase.units >= 0) continue;
    if (direction === "income" && amountBase.units <= 0) continue;
    all.push({
      categoryId,
      name: tree.nameOf(categoryId),
      // Expenses are reported as positive magnitudes; the direction is the label.
      amountBase: direction === "expense" ? { ...amountBase, units: -amountBase.units } : amountBase,
      transactionCount: bucket.n,
    });
  }

  all.sort((a, b) => Math.abs(b.amountBase.units) - Math.abs(a.amountBase.units));
  const uncategorized = all.find((c) => c.categoryId <= 0);
  const shown = all.slice(0, limit);
  const tail = all.slice(limit);

  return {
    categories: shown,
    totalBase: sumMinor(
      all.map((c) => c.amountBase),
      basePlaces,
    ),
    otherBase: sumMinor(
      tail.map((c) => c.amountBase),
      basePlaces,
    ),
    otherGroups: tail.length,
    groupsTotal: all.length,
    uncategorizedBase: uncategorized?.amountBase ?? { units: 0, places: basePlaces },
    transfersExcluded: excluded?.transfers ?? 0,
    assetTransfersExcluded: excluded?.assets ?? 0,
    truncated: tail.length > 0,
    basis,
  };
}

// ---------------------------------------------------------------------------
// Income vs expense over time
// ---------------------------------------------------------------------------

export interface PeriodTotals {
  readonly period: string;
  readonly incomeBase: Minor;
  readonly expenseBase: Minor;
  readonly netBase: Minor;
  readonly transactionCount: number;
}

export interface IncomeVsExpenseResult {
  /** Most recent periods first-to-last, capped. Older ones fold into `other`. */
  readonly periods: readonly PeriodTotals[];
  /** Over EVERY period in range, including any folded away. */
  readonly incomeBase: Minor;
  readonly expenseBase: Minor;
  readonly netBase: Minor;
  /** The periods that did not fit under the cap, as one figure. */
  readonly otherIncomeBase: Minor;
  readonly otherExpenseBase: Minor;
  readonly otherPeriods: number;
  readonly periodsTotal: number;
  readonly transfersExcluded: number;
  /** Set when no range was given and a default window was applied. */
  readonly defaultedRange: { readonly from: string; readonly to: string } | null;
  readonly basis: RateBasis;
}

export type Grouping = "month" | "quarter" | "year";

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function periodExpression(grouping: Grouping, alias = "t"): string {
  const d = transactionDate(alias);
  switch (grouping) {
    case "year":
      return `strftime('%Y', ${d})`;
    case "quarter":
      return `strftime('%Y', ${d}) || '-Q' || ((CAST(strftime('%m', ${d}) AS INTEGER) + 2) / 3)`;
    default:
      return `strftime('%Y-%m', ${d})`;
  }
}

/**
 * Income and expense per period.
 *
 * Transfers are excluded structurally, matching the desktop application, which
 * accumulates only on deposits and withdrawals. This is the figure MMEX's own
 * ExpenseAndRevenueByMonth report gets wrong: it applies no currency conversion
 * and does not filter deleted rows at all.
 */
/** Periods returned before the tail is folded away. Generous for a trend. */
const MAX_PERIODS = 60;

/** Window applied when the caller gives neither end of the range. */
const DEFAULT_WINDOW_MONTHS = 24;

export function incomeVsExpense(
  db: MmexDatabase,
  resolver: CurrencyResolver,
  options: DateRange & {
    readonly groupBy?: Grouping;
    readonly accountIds?: readonly number[];
    readonly maxPeriods?: number;
  } = {},
): IncomeVsExpenseResult {
  const grouping = options.groupBy ?? "month";

  // Period count is bounded only by how long someone has used Money Manager EX,
  // which the server does not control, and a monthly grouping over all history
  // is the default call. MMEX dates to 2005, so a fifteen year database is the
  // core case rather than an edge one. Without a window, that single call is
  // the largest response this server can produce.
  let effective: DateRange = options;
  let defaultedRange: { from: string; to: string } | null = null;
  if (options.from === undefined && options.to === undefined) {
    const latest = db.queryOne<{ hi: string | null }>(
      `SELECT MAX(${transactionDate("t")}) hi FROM CHECKINGACCOUNT_V1 t WHERE ${liveRows("t")}`,
    );
    if (latest?.hi) {
      const from = addMonthsIso(latest.hi, -DEFAULT_WINDOW_MONTHS);
      defaultedRange = { from, to: latest.hi };
      effective = { from, to: latest.hi };
    }
  }

  const { sql: range, params } = rangeClause(effective);
  const accountFilter =
    options.accountIds !== undefined && options.accountIds.length > 0
      ? ` AND t.ACCOUNTID IN (${options.accountIds.map((id) => Number(id)).join(",")})`
      : "";
  const scale = scaleExpression(resolver, "a.CURRENCYID");

  const rows = db.query<{
    period: string;
    curId: number;
    day: string;
    incomeUnits: number;
    expenseUnits: number;
    n: number;
  }>(
    `SELECT ${periodExpression(grouping)} AS period, a.CURRENCYID AS curId,
            ${transactionDate("t")} AS day,
            SUM(CASE WHEN ${transCode("t")} = 'DEPOSIT'
                     THEN CAST(ROUND(t.TRANSAMOUNT * ${scale}) AS INTEGER) ELSE 0 END) AS incomeUnits,
            SUM(CASE WHEN ${transCode("t")} <> 'DEPOSIT'
                     THEN CAST(ROUND(t.TRANSAMOUNT * ${scale}) AS INTEGER) ELSE 0 END) AS expenseUnits,
            COUNT(*) AS n
       FROM CHECKINGACCOUNT_V1 t
       JOIN ACCOUNTLIST_V1 a ON a.ACCOUNTID = t.ACCOUNTID
       LEFT JOIN CURRENCYFORMATS_V1 cf ON cf.CURRENCYID = a.CURRENCYID
      WHERE ${liveRows("t")}
        AND ${transCode("t")} <> 'TRANSFER'
        AND NOT (${isForeignAsTransfer("t")})${accountFilter}${range}
      GROUP BY 1, 2, 3
      ORDER BY 1`,
    params,
  );

  const excluded = db.queryOne<{ n: number }>(
    `SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 t
      WHERE ${liveRows("t")} AND ${transCode("t")} = 'TRANSFER'${accountFilter}${range}`,
    params,
  );

  const basePlaces = resolver.basePlaces;
  const basis: RateBasis = { kind: "transaction-date" };
  type ConvertibleRow = { currencyId: number; date: string; units: number };
  const byPeriod = new Map<string, { income: ConvertibleRow[]; expense: ConvertibleRow[]; n: number }>();

  for (const row of rows) {
    const bucket = byPeriod.get(row.period) ?? { income: [], expense: [], n: 0 };
    bucket.income.push({ currencyId: row.curId, date: row.day, units: row.incomeUnits });
    bucket.expense.push({ currencyId: row.curId, date: row.day, units: row.expenseUnits });
    bucket.n += row.n;
    byPeriod.set(row.period, bucket);
  }

  const computed: PeriodTotals[] = [];
  for (const [period, bucket] of [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const incomeBase = convertAndSum(bucket.income, resolver, basis);
    const expenseBase = convertAndSum(bucket.expense, resolver, basis);
    computed.push({
      period,
      incomeBase,
      expenseBase,
      netBase: { units: incomeBase.units - expenseBase.units, places: basePlaces },
      transactionCount: bucket.n,
    });
  }

  // Keep the most recent periods: a trend question is about the recent end.
  const cap = Math.max(1, Math.min(options.maxPeriods ?? MAX_PERIODS, MAX_PERIODS));
  const folded = computed.length > cap ? computed.slice(0, computed.length - cap) : [];
  const shown = computed.slice(folded.length);

  const totalIncome = sumMinor(
    computed.map((p) => p.incomeBase),
    basePlaces,
  );
  const totalExpense = sumMinor(
    computed.map((p) => p.expenseBase),
    basePlaces,
  );

  return {
    periods: shown,
    incomeBase: totalIncome,
    expenseBase: totalExpense,
    netBase: { units: totalIncome.units - totalExpense.units, places: basePlaces },
    otherIncomeBase: sumMinor(
      folded.map((p) => p.incomeBase),
      basePlaces,
    ),
    otherExpenseBase: sumMinor(
      folded.map((p) => p.expenseBase),
      basePlaces,
    ),
    otherPeriods: folded.length,
    periodsTotal: computed.length,
    transfersExcluded: excluded?.n ?? 0,
    defaultedRange,
    basis,
  };
}

// ---------------------------------------------------------------------------
// Transaction search
// ---------------------------------------------------------------------------

export interface TransactionRow {
  readonly transactionId: number;
  readonly date: string;
  readonly accountId: number;
  readonly account: string;
  readonly payee: string;
  readonly categoryId: number;
  readonly category: string;
  readonly type: string;
  readonly status: string;
  /** Symbol of the account's own currency, for labelling `amount`. */
  readonly currency: string;
  /** In the account's own currency. */
  readonly amount: Minor;
  /** Converted at this transaction's own date. */
  readonly amountBase: Minor;
  readonly hasSplits: boolean;
  readonly notes: string;
}

export interface SearchResult {
  readonly rows: readonly TransactionRow[];
  readonly totalMatching: number;
  readonly basis: RateBasis;
}

export interface SearchOptions extends DateRange {
  readonly accountIds?: readonly number[];
  /** Matches this category, or any of its descendants. */
  readonly categoryId?: number;
  readonly payeeContains?: string;
  readonly textContains?: string;
  /** Magnitude bounds, in the account's own currency. */
  readonly minAmount?: number;
  readonly maxAmount?: number;
  readonly includeTransfers?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Individual transactions, so an aggregate can be checked rather than trusted.
 *
 * A category filter matches descendants too: asking for "Food" should return
 * the coffees filed under Food:Dining:Coffee, which is what a person means.
 * Split rows are matched through their parent, and the parent is returned, so
 * the caller sees the transaction that actually exists.
 */
export function searchTransactions(
  db: MmexDatabase,
  resolver: CurrencyResolver,
  tree: CategoryTree,
  options: SearchOptions = {},
): SearchResult {
  const clauses: string[] = [liveRows("t")];
  const params: Record<string, string | number> = {};

  const { sql: range, params: rangeParams } = rangeClause(options);
  if (range !== "") clauses.push(range.replace(/^ AND /, ""));
  Object.assign(params, rangeParams);

  if (options.accountIds !== undefined && options.accountIds.length > 0) {
    const ids = options.accountIds.map((id) => Number(id)).join(",");
    clauses.push(`(t.ACCOUNTID IN (${ids}) OR t.TOACCOUNTID IN (${ids}))`);
  }
  if (options.includeTransfers !== true) {
    clauses.push(`${transCode("t")} <> 'TRANSFER'`);
  }
  if (options.payeeContains !== undefined && options.payeeContains !== "") {
    clauses.push("p.PAYEENAME LIKE @payee ESCAPE '\\'");
    params.payee = `%${escapeLike(options.payeeContains)}%`;
  }
  if (options.textContains !== undefined && options.textContains !== "") {
    clauses.push(
      "(t.NOTES LIKE @text ESCAPE '\\' OR t.TRANSACTIONNUMBER LIKE @text ESCAPE '\\' OR p.PAYEENAME LIKE @text ESCAPE '\\')",
    );
    params.text = `%${escapeLike(options.textContains)}%`;
  }
  if (options.minAmount !== undefined) {
    clauses.push("ABS(t.TRANSAMOUNT) >= @minAmount");
    params.minAmount = options.minAmount;
  }
  if (options.maxAmount !== undefined) {
    clauses.push("ABS(t.TRANSAMOUNT) <= @maxAmount");
    params.maxAmount = options.maxAmount;
  }
  if (options.categoryId !== undefined) {
    // Descendants included, resolved in TypeScript because the tree is already
    // built and a recursive CTE here would duplicate its cycle guard.
    const wanted = new Set<number>([options.categoryId]);
    for (const node of tree.all()) {
      if (tree.rootOf(node.id) === undefined) continue;
      let cursor: number | undefined = node.id;
      const seen = new Set<number>();
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        if (cursor === options.categoryId) {
          wanted.add(node.id);
          break;
        }
        cursor = tree.get(cursor)?.parentId;
        if (cursor !== undefined && cursor <= 0) break;
      }
    }
    const ids = [...wanted].map((id) => Number(id)).join(",");
    clauses.push(
      `(t.CATEGID IN (${ids}) OR EXISTS (SELECT 1 FROM SPLITTRANSACTIONS_V1 s2 WHERE s2.TRANSID = t.TRANSID AND s2.CATEGID IN (${ids})))`,
    );
  }

  const scale = scaleExpression(resolver, "a.CURRENCYID");
  const where = clauses.join(" AND ");
  const limit = Math.max(1, Math.min(options.limit ?? 25, 200));
  const offset = Math.max(0, options.offset ?? 0);

  const total = db.queryOne<{ n: number }>(
    `SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 t
       JOIN ACCOUNTLIST_V1 a ON a.ACCOUNTID = t.ACCOUNTID
       LEFT JOIN PAYEE_V1 p ON p.PAYEEID = t.PAYEEID
      WHERE ${where}`,
    params,
  );

  const rows = db.query<{
    TRANSID: number;
    day: string;
    ACCOUNTID: number;
    ACCOUNTNAME: string;
    PAYEENAME: string | null;
    CATEGID: number | null;
    TRANSCODE: string;
    STATUS: string | null;
    NOTES: string | null;
    CURRENCYID: number;
    units: number;
    splitCount: number;
  }>(
    `SELECT t.TRANSID, ${transactionDate("t")} AS day, t.ACCOUNTID, a.ACCOUNTNAME,
            p.PAYEENAME, t.CATEGID, t.TRANSCODE, t.STATUS, t.NOTES, a.CURRENCYID,
            CAST(ROUND(t.TRANSAMOUNT * ${scale}) AS INTEGER) AS units,
            (SELECT COUNT(*) FROM SPLITTRANSACTIONS_V1 s WHERE s.TRANSID = t.TRANSID) AS splitCount
       FROM CHECKINGACCOUNT_V1 t
       JOIN ACCOUNTLIST_V1 a ON a.ACCOUNTID = t.ACCOUNTID
       LEFT JOIN CURRENCYFORMATS_V1 cf ON cf.CURRENCYID = a.CURRENCYID
       LEFT JOIN PAYEE_V1 p ON p.PAYEEID = t.PAYEEID
      WHERE ${where}
      ORDER BY day DESC, t.TRANSID DESC
      LIMIT @limit OFFSET @offset`,
    { ...params, limit, offset },
  );

  const basePlaces = resolver.basePlaces;
  const basis: RateBasis = { kind: "transaction-date" };

  return {
    rows: rows.map((row) => {
      const currency = resolver.info(row.CURRENCYID);
      const places = currency?.places ?? basePlaces;
      const native: Minor = { units: row.units, places };
      const amountBase =
        row.CURRENCYID === resolver.baseCurrencyId && places === basePlaces
          ? native
          : convertMinor(
              native,
              row.CURRENCYID === resolver.baseCurrencyId ? 1 : resolver.rateFor(row.CURRENCYID, row.day),
              basePlaces,
            );
      return {
        transactionId: row.TRANSID,
        date: row.day,
        accountId: row.ACCOUNTID,
        account: row.ACCOUNTNAME,
        payee: row.PAYEENAME ?? "(none)",
        categoryId: row.CATEGID ?? -1,
        category: row.splitCount > 0 ? "(split)" : tree.nameOf(row.CATEGID),
        type: row.TRANSCODE,
        status: row.STATUS ?? "",
        currency: currency?.symbol ?? String(row.CURRENCYID),
        amount: native,
        amountBase,
        hasSplits: row.splitCount > 0,
        notes: row.NOTES ?? "",
      };
    }),
    totalMatching: total?.n ?? 0,
    basis,
  };
}

/** LIKE treats % and _ as wildcards; a user searching for them means them. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
