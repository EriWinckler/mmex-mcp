import { describe, expect, it } from "vitest";
import {
  addMinor,
  convertMinor,
  formatMinor,
  type Minor,
  MoneyError,
  negateMinor,
  placesFromScale,
  recoverMinor,
  roundToMinor,
  sumMinor,
  toMajor,
} from "../src/money/money.js";

describe("placesFromScale", () => {
  it("reads SCALE as a divisor, not a digit count", () => {
    expect(placesFromScale(1)).toBe(0); // JPY: divisor 1 means zero decimals
    expect(placesFromScale(10)).toBe(1);
    expect(placesFromScale(100)).toBe(2);
    expect(placesFromScale(1000)).toBe(3);
  });

  it("defaults to 2 when the column is absent", () => {
    expect(placesFromScale(null)).toBe(2);
    expect(placesFromScale(undefined)).toBe(2);
  });

  it("accepts the eight-decimal currency MMEX actually ships", () => {
    // Shipped SCALE values are 1, 100, 10000 and 100000000. An earlier version
    // capped at six digits and threw on the last one.
    expect(placesFromScale(10000)).toBe(4);
    expect(placesFromScale(100000000)).toBe(8);
  });

  it("falls back to 2 instead of throwing, so one odd row cannot break every currency", () => {
    // placesFromScale runs inside CurrencyResolver's constructor, over every
    // row in CURRENCYFORMATS_V1. Throwing on a single unusable value took the
    // whole resolver down with it.
    for (const bad of [0, -100, 50, Number.NaN, Number.POSITIVE_INFINITY, 1e300]) {
      expect(placesFromScale(bad), String(bad)).toBe(2);
    }
  });
});

describe("recoverMinor", () => {
  it("recovers the decimal the user entered from the stored double", () => {
    expect(recoverMinor(10.1, 2).units).toBe(1010);
    expect(recoverMinor(20.2, 2).units).toBe(2020);
    expect(recoverMinor(-45.67, 2).units).toBe(-4567);
    expect(recoverMinor(0, 2).units).toBe(0);
  });

  it("recovers the exact lossy sum this database actually returns", () => {
    // Verified against a real SQLite file: SUM over 10.10 and 20.20 comes
    // back as 30.299999999999997, not 30.30.
    const lossy = 10.1 + 20.2;
    expect(lossy).not.toBe(30.3);
    expect(recoverMinor(lossy, 2).units).toBe(3030);
  });

  it("handles zero-decimal currencies", () => {
    expect(recoverMinor(1500, 0).units).toBe(1500);
  });

  it("reports over-precise values in strict mode instead of silently truncating", () => {
    expect(() => recoverMinor(1.239, 2, true)).toThrow(MoneyError);
    expect(recoverMinor(1.239, 2, false).units).toBe(124);
  });

  it("rejects non-finite input", () => {
    expect(() => recoverMinor(Number.NaN, 2)).toThrow(MoneyError);
    expect(() => recoverMinor(Number.POSITIVE_INFINITY, 2)).toThrow(MoneyError);
  });
});

describe("roundToMinor", () => {
  it("rounds half away from zero, symmetrically", () => {
    expect(roundToMinor(1.005, 2).units).toBe(101);
    expect(roundToMinor(-1.005, 2).units).toBe(-101);
    expect(roundToMinor(2.675, 2).units).toBe(268);
    expect(roundToMinor(-2.675, 2).units).toBe(-268);
  });

  it("is symmetric under sign flip for every case it rounds", () => {
    for (const v of [0.005, 1.005, 2.675, 0.125, 99.995, 1234.567]) {
      expect(roundToMinor(v, 2).units).toBe(-roundToMinor(-v, 2).units);
    }
  });

  it("leaves exact values untouched", () => {
    expect(roundToMinor(12.34, 2).units).toBe(1234);
    expect(roundToMinor(0, 2).units).toBe(0);
  });
});

describe("integer arithmetic is exact where float arithmetic is not", () => {
  it("sums 10.10 + 20.20 to exactly 30.30", () => {
    const a = recoverMinor(10.1, 2);
    const b = recoverMinor(20.2, 2);
    const total = addMinor(a, b);
    expect(total.units).toBe(3030);
    expect(formatMinor(total)).toBe("30.30");
    // the float path this replaces
    expect((10.1 + 20.2).toString()).toBe("30.299999999999997");
  });

  it("stays exact over a long run of awkward values", () => {
    const values = Array.from({ length: 1000 }, (_, i) => 0.01 * (i + 1));
    const viaMinor = sumMinor(
      values.map((v) => recoverMinor(v, 2)),
      2,
    );
    // 0.01 + 0.02 + ... + 10.00 = 5005.00
    expect(viaMinor.units).toBe(500500);
    expect(formatMinor(viaMinor)).toBe("5005.00");
  });

  it("refuses to mix precisions instead of producing a wrong total", () => {
    const usd: Minor = { units: 100, places: 2 };
    const jpy: Minor = { units: 100, places: 0 };
    expect(() => addMinor(usd, jpy)).toThrow(MoneyError);
    expect(() => sumMinor([usd, jpy], 2)).toThrow(MoneyError);
  });

  it("sums an empty list to zero at the requested precision", () => {
    expect(sumMinor([], 2)).toEqual({ units: 0, places: 2 });
  });

  it("negates without changing magnitude", () => {
    expect(negateMinor({ units: -4567, places: 2 })).toEqual({ units: 4567, places: 2 });
  });
});

describe("convertMinor", () => {
  it("rounds once, at the end", () => {
    // 100.00 EUR at 1.0875 -> 108.75
    expect(convertMinor({ units: 10000, places: 2 }, 1.0875, 2).units).toBe(10875);
  });

  it("converts into a different precision", () => {
    // 10.00 USD at 150.5 -> 1505 JPY (zero decimals)
    expect(convertMinor({ units: 1000, places: 2 }, 150.5, 0).units).toBe(1505);
  });

  it("rejects a non-positive or non-finite rate rather than producing zero", () => {
    const m: Minor = { units: 100, places: 2 };
    expect(() => convertMinor(m, 0, 2)).toThrow(MoneyError);
    expect(() => convertMinor(m, -1, 2)).toThrow(MoneyError);
    expect(() => convertMinor(m, Number.NaN, 2)).toThrow(MoneyError);
  });
});

describe("formatMinor", () => {
  it("always carries full precision", () => {
    expect(formatMinor({ units: 3030, places: 2 })).toBe("30.30");
    expect(formatMinor({ units: 5, places: 2 })).toBe("0.05");
    expect(formatMinor({ units: 0, places: 2 })).toBe("0.00");
    expect(formatMinor({ units: 1500, places: 0 })).toBe("1500");
  });

  it("formats negatives with a single leading sign", () => {
    expect(formatMinor({ units: -5, places: 2 })).toBe("-0.05");
    expect(formatMinor({ units: -123456, places: 2 })).toBe("-1234.56");
  });

  it("round-trips through toMajor for representable values", () => {
    expect(toMajor({ units: 3030, places: 2 })).toBe(30.3);
  });
});
