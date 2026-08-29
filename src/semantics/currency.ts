import type { MmexDatabase } from "../db/connection.js";
import { placesFromScale } from "../money/money.js";

/**
 * Currency conversion, transcribed from
 * `CurrencyHistoryModel::get_id_date_rate` (src/model/CurrencyHistoryModel.cpp:103).
 *
 * The six-step fallback is more subtle than "use the historical rate", and
 * step 5 in particular surprises people: MMEX will reach FORWARD to a future
 * rate if that rate is closer in time than the previous one. It is neither
 * carry-forward nor interpolation, it picks one endpoint whole.
 */

export interface CurrencyInfo {
  readonly id: number;
  readonly symbol: string;
  readonly name: string;
  readonly places: number;
  readonly baseConvRate: number;
}

/** Which date a tool converts at. MMEX itself is inconsistent, so tools declare it. */
export type RateBasis =
  /** The transaction's own date. What Category, Income/Expense, Payee and Transaction reports do. */
  | "transaction-date"
  /** One fixed date for everything. What the Cash Flow report and home page do (with today). */
  | "fixed-date";

export class CurrencyResolver {
  private readonly currencies = new Map<number, CurrencyInfo>();
  private readonly historyByCurrency = new Map<number, { date: string; rate: number }[]>();
  private readonly rateCache = new Map<string, number>();
  readonly baseCurrencyId: number;
  readonly useCurrencyHistory: boolean;
  /** Currencies whose definition could not be read. Reported, not swallowed. */
  readonly unresolvable: number[] = [];

  constructor(private readonly db: MmexDatabase) {
    for (const row of db.query<{
      CURRENCYID: number;
      CURRENCY_SYMBOL: string;
      CURRENCYNAME: string;
      SCALE: number | null;
      BASECONVRATE: number | null;
    }>("SELECT CURRENCYID, CURRENCY_SYMBOL, CURRENCYNAME, SCALE, BASECONVRATE FROM CURRENCYFORMATS_V1")) {
      // Per-row containment: this loop runs over every currency in the file,
      // including ones nothing references. One unusable row must degrade that
      // currency, not take down every currency-aware tool in the server.
      try {
        this.currencies.set(row.CURRENCYID, {
          id: row.CURRENCYID,
          symbol: row.CURRENCY_SYMBOL,
          name: row.CURRENCYNAME,
          places: placesFromScale(row.SCALE),
          baseConvRate: row.BASECONVRATE !== null && row.BASECONVRATE > 0 ? row.BASECONVRATE : 1,
        });
      } catch {
        this.unresolvable.push(row.CURRENCYID);
      }
    }

    // INFOTABLE_V1.BASECURRENCYID, default -1 (src/model/PrefModel.cpp:260).
    const rawBase = db.info.get("basecurrencyid");
    const parsedBase = rawBase !== undefined && rawBase !== "" ? Number(rawBase) : Number.NaN;
    this.baseCurrencyId = Number.isFinite(parsedBase) ? parsedBase : -1;

    // INFOTABLE_V1.USECURRENCYHISTORY, default true. getBool accepts 1/TRUE and
    // 0/FALSE case-insensitively; anything else falls back to the default
    // (src/model/InfoModel.cpp:119).
    const rawUse = db.info.get("usecurrencyhistory");
    // Default true. Only an explicit 0/false turns it off; anything
    // unrecognized falls back to the default, matching getBool.
    this.useCurrencyHistory = rawUse === undefined ? true : !/^(0|false)$/i.test(rawUse.trim());
  }

  get base(): CurrencyInfo | undefined {
    return this.currencies.get(this.baseCurrencyId);
  }

  /** Decimal places of the base currency, the precision every total is reported in. */
  get basePlaces(): number {
    return this.base?.places ?? 2;
  }

  info(currencyId: number): CurrencyInfo | undefined {
    return this.currencies.get(currencyId);
  }

  all(): readonly CurrencyInfo[] {
    return [...this.currencies.values()];
  }

  private history(currencyId: number): { date: string; rate: number }[] {
    let rows = this.historyByCurrency.get(currencyId);
    if (rows === undefined) {
      rows = this.db
        .query<{ CURRDATE: string; CURRVALUE: number }>(
          // date() yields NULL for a value SQLite cannot parse, and CURRDATE
          // carries no format constraint. Such a row must be dropped here: it
          // sorts first, compares falsely against a real date in JS, and would
          // otherwise be selected as the nearest rate for every lookup,
          // silently multiplying every converted amount by an arbitrary number.
          `SELECT date(CURRDATE) CURRDATE, CURRVALUE FROM CURRENCYHISTORY_V1
            WHERE CURRENCYID = ? AND date(CURRDATE) IS NOT NULL AND CURRVALUE > 0
            ORDER BY date(CURRDATE)`,
          [currencyId],
        )
        .map((r) => ({ date: r.CURRDATE, rate: r.CURRVALUE }));
      this.historyByCurrency.set(currencyId, rows);
    }
    return rows;
  }

  /**
   * Rate to multiply an amount in `currencyId` by, to get base currency.
   *
   * `date` is ISO YYYY-MM-DD. The resolution order is exactly MMEX's.
   */
  rateFor(currencyId: number, date: string): number {
    // 1. The base currency, and the -1 sentinel, are always 1.0.
    if (currencyId === this.baseCurrencyId || currencyId === -1) return 1;

    const currency = this.currencies.get(currencyId);
    if (currency === undefined) return 1;

    // 2. Preference off: the current rate, and stop.
    if (!this.useCurrencyHistory) return currency.baseConvRate;

    const key = `${currencyId}|${date}`;
    const cached = this.rateCache.get(key);
    if (cached !== undefined) return cached;

    const rate = this.resolveHistorical(currency, date);
    this.rateCache.set(key, rate);
    return rate;
  }

  private resolveHistorical(currency: CurrencyInfo, date: string): number {
    const rows = this.history(currency.id);

    // 4. No history at all for this currency.
    if (rows.length === 0) return currency.baseConvRate;

    // 3. Exact date match.
    for (const row of rows) {
      if (row.date === date) return row.rate;
    }

    // 5. Nearest date in EITHER direction, ties to the earlier one.
    let prev: { date: string; rate: number } | undefined;
    let next: { date: string; rate: number } | undefined;
    for (const row of rows) {
      if (row.date < date) prev = row;
      else if (next === undefined) next = row;
    }

    if (prev !== undefined && next !== undefined) {
      const prevDays = daysBetween(prev.date, date);
      const nextDays = daysBetween(date, next.date);
      // Belt and braces after the SQL filter: never let a NaN comparison decide.
      if (!Number.isFinite(prevDays)) return next.rate;
      if (!Number.isFinite(nextDays)) return prev.rate;
      return prevDays <= nextDays ? prev.rate : next.rate;
    }
    if (prev !== undefined) return prev.rate;
    if (next !== undefined) return next.rate;

    // 6. Final fallback.
    return currency.baseConvRate;
  }
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}
