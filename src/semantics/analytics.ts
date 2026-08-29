import type { MmexDatabase } from "../db/connection.js";
import { convertMinor, type Minor, sumMinor } from "../money/money.js";
import type { CategoryTree } from "./categories.js";
import type { CurrencyResolver } from "./currency.js";
import { accountFlow, isForeignAsTransfer, liveRows, transactionDate } from "./rules.js";

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

function rangeClause(range: DateRange, alias = "t"): { sql: string; params: Record<string, string> } {
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
            CAST(ROUND(IFNULL(a.INITIALBAL, 0) * IFNULL(cf.SCALE, 100)) AS INTEGER) AS initialUnits,
            SUM(CAST(ROUND((${accountFlow("t", "a.ACCOUNTID")}) * IFNULL(cf.SCALE, 100)) AS INTEGER)) AS flowUnits,
            SUM(CASE WHEN IFNULL(t.STATUS,'') = 'R'
                     THEN CAST(ROUND((${accountFlow("t", "a.ACCOUNTID")}) * IFNULL(cf.SCALE, 100)) AS INTEGER)
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
  readonly totalBase: Minor;
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
  const sign = "CASE WHEN t.TRANSCODE = 'Deposit' THEN 1 ELSE -1 END";
  const scale = "IFNULL(cf.SCALE, 100)";
  const common =
    `${liveRows("t")}` +
    ` AND t.TRANSCODE <> 'Transfer'` +
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
    `SELECT SUM(CASE WHEN t.TRANSCODE = 'Transfer' THEN 1 ELSE 0 END) AS transfers,
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

  return {
    categories: all.slice(0, limit),
    totalBase: sumMinor(
      all.map((c) => c.amountBase),
      basePlaces,
    ),
    uncategorizedBase: uncategorized?.amountBase ?? { units: 0, places: basePlaces },
    transfersExcluded: excluded?.transfers ?? 0,
    assetTransfersExcluded: excluded?.assets ?? 0,
    truncated: all.length > limit,
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
  readonly periods: readonly PeriodTotals[];
  readonly incomeBase: Minor;
  readonly expenseBase: Minor;
  readonly netBase: Minor;
  readonly transfersExcluded: number;
  readonly basis: RateBasis;
}

export type Grouping = "month" | "quarter" | "year";

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
export function incomeVsExpense(
  db: MmexDatabase,
  resolver: CurrencyResolver,
  options: DateRange & { readonly groupBy?: Grouping; readonly accountIds?: readonly number[] } = {},
): IncomeVsExpenseResult {
  const grouping = options.groupBy ?? "month";
  const { sql: range, params } = rangeClause(options);
  const accountFilter =
    options.accountIds !== undefined && options.accountIds.length > 0
      ? ` AND t.ACCOUNTID IN (${options.accountIds.map((id) => Number(id)).join(",")})`
      : "";
  const scale = "IFNULL(cf.SCALE, 100)";

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
            SUM(CASE WHEN t.TRANSCODE = 'Deposit'
                     THEN CAST(ROUND(t.TRANSAMOUNT * ${scale}) AS INTEGER) ELSE 0 END) AS incomeUnits,
            SUM(CASE WHEN t.TRANSCODE <> 'Deposit'
                     THEN CAST(ROUND(t.TRANSAMOUNT * ${scale}) AS INTEGER) ELSE 0 END) AS expenseUnits,
            COUNT(*) AS n
       FROM CHECKINGACCOUNT_V1 t
       JOIN ACCOUNTLIST_V1 a ON a.ACCOUNTID = t.ACCOUNTID
       LEFT JOIN CURRENCYFORMATS_V1 cf ON cf.CURRENCYID = a.CURRENCYID
      WHERE ${liveRows("t")}
        AND t.TRANSCODE <> 'Transfer'
        AND NOT (${isForeignAsTransfer("t")})${accountFilter}${range}
      GROUP BY 1, 2, 3
      ORDER BY 1`,
    params,
  );

  const excluded = db.queryOne<{ n: number }>(
    `SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1 t
      WHERE ${liveRows("t")} AND t.TRANSCODE = 'Transfer'${accountFilter}${range}`,
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

  const periods: PeriodTotals[] = [];
  const allIncome: Minor[] = [];
  const allExpense: Minor[] = [];

  for (const [period, bucket] of [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const incomeBase = convertAndSum(bucket.income, resolver, basis);
    const expenseBase = convertAndSum(bucket.expense, resolver, basis);
    allIncome.push(incomeBase);
    allExpense.push(expenseBase);
    periods.push({
      period,
      incomeBase,
      expenseBase,
      netBase: { units: incomeBase.units - expenseBase.units, places: basePlaces },
      transactionCount: bucket.n,
    });
  }

  const totalIncome = sumMinor(allIncome, basePlaces);
  const totalExpense = sumMinor(allExpense, basePlaces);

  return {
    periods,
    incomeBase: totalIncome,
    expenseBase: totalExpense,
    netBase: { units: totalIncome.units - totalExpense.units, places: basePlaces },
    transfersExcluded: excluded?.n ?? 0,
    basis,
  };
}
