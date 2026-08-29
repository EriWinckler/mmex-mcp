import { z } from "zod";
import type { MmexDatabase } from "../db/connection.js";
import { formatMinor, type Minor, toMajor } from "../money/money.js";
import type { RateBasis } from "../semantics/analytics.js";
import type { CurrencyResolver } from "../semantics/currency.js";

/**
 * Shared shape for every analytic tool result.
 *
 * Two envelopes, both enforced by a test that iterates every registered tool,
 * so a new tool cannot ship without them.
 *
 * `basis` states how a figure was produced: which currency it is in, which date
 * the exchange rate came from, and what was left out. Without it a user whose
 * number disagrees with their Money Manager EX report has no way to find out
 * why, and the conformance document is not something they will read first.
 *
 * `page` states what is missing. A tool that silently returns the top 25 of 300
 * categories is indistinguishable from one that returned everything.
 */

export const amountSchema = z.object({
  /** Exact decimal string. This is the authoritative value. */
  formatted: z.string().describe("Exact decimal string, in the base currency. Report this as given."),
  /** Convenience for arithmetic. Subject to float representation, unlike `formatted`. */
  value: z.number().describe("Numeric form, for comparison only. `formatted` is authoritative."),
  currency: z.string(),
});

export type AmountPayload = z.infer<typeof amountSchema>;

export function amount(minor: Minor, currency: string): AmountPayload {
  return { formatted: formatMinor(minor), value: toMajor(minor), currency };
}

export const basisSchema = z.object({
  baseCurrency: z.string().describe("Currency all figures are expressed in."),
  rateBasis: z
    .enum(["transaction-date", "fixed-date", "none"])
    .describe(
      "How foreign amounts were converted. 'transaction-date' uses each transaction's own rate; " +
        "'fixed-date' converts everything at one date; 'none' means no conversion was needed.",
    ),
  rateDate: z.string().nullable().describe("The date used, when rateBasis is 'fixed-date'."),
  excluded: z
    .array(z.string())
    .describe("What was left out of these figures, e.g. void, soft-deleted, transfers."),
  schemaVerified: z
    .boolean()
    .describe("False if the database's schema version was not one these rules were verified against."),
  note: z.string().describe("Where to look when a figure disagrees with a Money Manager EX report."),
});

export type BasisPayload = z.infer<typeof basisSchema>;

const CONFORMANCE_NOTE =
  "Figures follow the Money Manager EX desktop application. They can differ from MMEX's own " +
  "published reports, which disagree with the application and with each other; see docs/CONFORMANCE.md.";

export function basis(
  db: MmexDatabase,
  resolver: CurrencyResolver,
  rate: RateBasis,
  excluded: readonly string[],
): BasisPayload {
  return {
    baseCurrency: resolver.base?.symbol ?? "?",
    rateBasis: resolver.all().length <= 1 ? "none" : rate.kind,
    rateDate: rate.kind === "fixed-date" ? rate.date : null,
    excluded: [...excluded],
    schemaVerified: db.schema.verified,
    note: CONFORMANCE_NOTE,
  };
}

export const pageSchema = z.object({
  returned: z.number().int().describe("How many items are in this response."),
  limit: z.number().int(),
  offset: z.number().int(),
  totalMatching: z
    .number()
    .int()
    .nullable()
    .describe("Total items matching the query, or null when counting them would be expensive."),
  truncated: z.boolean().describe("True when more items matched than were returned."),
  nextOffset: z
    .number()
    .int()
    .nullable()
    .describe("Pass as `offset` to fetch the next page, or null when this is the last one."),
});

export type PagePayload = z.infer<typeof pageSchema>;

export function page(args: {
  returned: number;
  limit: number;
  offset: number;
  totalMatching: number | null;
}): PagePayload {
  const { returned, limit, offset, totalMatching } = args;
  const more = totalMatching === null ? returned === limit : offset + returned < totalMatching;
  return {
    returned,
    limit,
    offset,
    totalMatching,
    truncated: more,
    nextOffset: more ? offset + returned : null,
  };
}

/** Bounds a caller-supplied limit so one tool call cannot pull an entire database. */
export function clampLimit(requested: number | undefined, fallback: number, max: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.max(1, Math.min(Math.trunc(requested), max));
}

/** Annotations every tool in this server carries. Read-only, local, side-effect free. */
export const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Standard tool return: the structured payload, plus a compact text rendering.
 *
 * Both are sent because a client that ignores structuredContent still needs
 * something readable, and the SDK validates structuredContent against the
 * declared outputSchema, which is what catches a handler drifting from its
 * contract.
 */
export function toolResult<T extends Record<string, unknown>>(
  structuredContent: T,
): { content: { type: "text"; text: string }[]; structuredContent: T } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}
