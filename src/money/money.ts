/**
 * Money handling for MMEX databases.
 *
 * MMEX stores every amount in a SQLite column of `numeric` affinity, which
 * SQLite hands back to Node as an IEEE 754 double. That is lossy for decimal
 * money, and demonstrably so against a real database:
 *
 *   SELECT SUM(TRANSAMOUNT) ...  ->  30.299999999999997   (for 10.10 + 20.20)
 *
 * Every amount in this server is therefore converted to integer minor units
 * at the SQL boundary, kept as an integer through all arithmetic, and
 * formatted back to a decimal string only at the output boundary.
 *
 * Minor units are held in `number`, not `bigint`. A double represents every
 * integer up to 2^53 exactly, which is about 90 trillion units at two decimal
 * places. That is far beyond any personal finance database, and it keeps the
 * arithmetic readable. Every conversion asserts the safe-integer bound rather
 * than assuming it.
 */

/** An amount in integer minor units, tagged with its currency's precision. */
export interface Minor {
  /** Integer count of minor units. Negative for outflows. */
  readonly units: number;
  /** Decimal places for the currency, e.g. 2 for USD, 0 for JPY. */
  readonly places: number;
}

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

/**
 * Derive decimal places from CURRENCYFORMATS_V1.SCALE.
 *
 * MMEX stores SCALE as the integer divisor, not as a count of digits: 100
 * means two decimal places, 10 means one, and 1 means zero (the JPY case).
 * MMEX computes it as `(int)log10(SCALE)`.
 *
 * Shipped currencies use 1, 100, 10000 and 100000000, so eight decimal places
 * is a real value and not a corruption.
 *
 * This never throws. The column is nullable and unconstrained, and one odd row
 * must not take down every currency in the database: an unusable value falls
 * back to two decimal places, which is what the overwhelming majority of
 * currencies use.
 */
export function placesFromScale(scale: number | null | undefined): number {
  const FALLBACK = 2;
  if (scale === null || scale === undefined) return FALLBACK;
  if (!Number.isFinite(scale) || scale <= 0) return FALLBACK;

  const digits = Math.round(Math.log10(scale));
  if (10 ** digits !== scale) {
    // Not a power of ten. MMEX truncates via a cast, but a non-power-of-ten
    // means the column holds something unexpected, so prefer the common case.
    return FALLBACK;
  }
  if (digits < 0 || digits > 8) return FALLBACK;
  return digits;
}

function assertSafe(units: number, context: string): number {
  if (!Number.isSafeInteger(units)) {
    throw new MoneyError(`${context} produced a value outside safe integer range: ${units}`);
  }
  return units;
}

/**
 * Recover minor units from a value the database already stores at `places`
 * precision.
 *
 * This is a recovery, not a rounding decision: the stored double is the
 * nearest representable value to a decimal the user actually entered, so
 * scaling and rounding to the nearest integer reproduces that decimal
 * exactly. `strict` additionally reports values that are not actually at the
 * expected precision, which indicates data written by something other than
 * MMEX.
 */
export function recoverMinor(amount: number, places: number, strict = false): Minor {
  if (!Number.isFinite(amount)) {
    throw new MoneyError(`amount is not a finite number: ${amount}`);
  }
  const scaled = amount * 10 ** places;
  const units = Math.round(scaled);
  if (strict && Math.abs(scaled - units) > 1e-6) {
    throw new MoneyError(
      `amount ${amount} carries more precision than the currency's ${places} decimal places`,
    );
  }
  return { units: assertSafe(units, "recoverMinor"), places };
}

/**
 * Round an arbitrary real number to minor units, half away from zero.
 *
 * Used where a genuine rounding decision is being made, such as after a
 * currency conversion. Half away from zero keeps rounding symmetric, so a sign
 * flip never changes the magnitude.
 *
 * This deliberately rounds the double it is given, with no epsilon correction.
 * An earlier version nudged the value by 4 ULP first, on the theory that a
 * decimal sitting exactly on the half might be represented just below it. That
 * gap is at most 0.5 ULP, so a 4 ULP nudge over-corrected by eight times and
 * produced real errors: converting 10,000,000,000,000.00 at a rate of exactly
 * 1.0 came back one minor unit larger than it went in.
 *
 * Recovering a decimal a user actually typed is `recoverMinor`'s job, and it
 * does not need a nudge either. This function's input is a computed real with
 * no decimal intent to recover, so the nearest representable answer is the
 * right one.
 */
export function roundToMinor(value: number, places: number): Minor {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`value is not a finite number: ${value}`);
  }
  const scaled = value * 10 ** places;
  const units = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return { units: assertSafe(units, "roundToMinor"), places };
}

function samePlaces(a: Minor, b: Minor): void {
  if (a.places !== b.places) {
    throw new MoneyError(
      `refusing to combine amounts with different precision (${a.places} vs ${b.places}); convert to a common currency first`,
    );
  }
}

export function addMinor(a: Minor, b: Minor): Minor {
  samePlaces(a, b);
  return { units: assertSafe(a.units + b.units, "addMinor"), places: a.places };
}

export function negateMinor(a: Minor): Minor {
  return { units: -a.units, places: a.places };
}

/** Sum amounts that all share one precision. An empty list needs `places`. */
export function sumMinor(items: readonly Minor[], places: number): Minor {
  let total = 0;
  for (const item of items) {
    if (item.places !== places) {
      throw new MoneyError(
        `refusing to sum an amount with ${item.places} decimal places into a total with ${places}`,
      );
    }
    total += item.units;
  }
  return { units: assertSafe(total, "sumMinor"), places };
}

/**
 * Convert between currencies at a given rate, rounding once at the end.
 *
 * Rounding happens exactly once, on the final value, rather than at any
 * intermediate step. Converting a list of amounts individually and summing
 * can differ from summing then converting; this server always converts each
 * transaction at its own date's rate and then sums, which is what makes a
 * historical total stable as rates move.
 */
export function convertMinor(amount: Minor, rate: number, targetPlaces: number): Minor {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new MoneyError(`conversion rate must be a positive finite number, got ${rate}`);
  }
  const major = amount.units / 10 ** amount.places;
  return roundToMinor(major * rate, targetPlaces);
}

/** Exact decimal string, always carrying the currency's full precision. */
export function formatMinor(amount: Minor): string {
  const negative = amount.units < 0;
  const digits = Math.abs(amount.units)
    .toString()
    .padStart(amount.places + 1, "0");
  const cut = digits.length - amount.places;
  const whole = digits.slice(0, cut);
  const frac = digits.slice(cut);
  const body = amount.places > 0 ? `${whole}.${frac}` : whole;
  return negative ? `-${body}` : body;
}

/** Plain number in major units. For display and JSON only, never for math. */
export function toMajor(amount: Minor): number {
  return amount.units / 10 ** amount.places;
}
