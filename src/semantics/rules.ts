/**
 * MMEX financial semantics, as the desktop application actually implements
 * them.
 *
 * This file is the heart of the project, and it exists because "match MMEX"
 * turned out not to be a specification. MMEX's own published general-reports
 * SQL disagrees with the desktop app in eight places, five of them material,
 * and two of those are outright bugs in the reports. The rules below were
 * read out of the C++ source of Money Manager EX 1.9.4 RC1 (commit 35f3081)
 * rather than inferred from the schema or copied from the reports.
 *
 * See docs/CONFORMANCE.md for every divergence with citations.
 */

/** The five STATUS values MMEX recognizes. Unreconciled is '' and never NULL. */
export const TRANSACTION_STATUS = {
  unreconciled: "",
  reconciled: "R",
  void: "V",
  followUp: "F",
  duplicate: "D",
} as const;

/**
 * Rows excluded from every balance and every report.
 *
 * Only void and soft-deleted. This is narrower than MMEX's published reports,
 * which also drop 'D' (Duplicate), and the app is the authority: `is_valid()`
 * is `!is_void() && !is_deleted()` (src/data/TrxData.h:80), and 'D' appears in
 * no filter anywhere in the application source. A Duplicate is real money in
 * the register, the account balance, and the category report.
 *
 * The deleted test must be the IFNULL form. MMEX writes '' for a live row, but
 * other tooling writes NULL, and the app compiles exactly
 * `IFNULL(DELETEDTIME, '') = ''` (src/model/TrxModel.cpp:68 via
 * src/table/_TableClause.cpp:76). Testing only one of the two is a latent bug.
 *
 * The status test must also be IFNULL-guarded: in SQLite `NULL <> 'V'` is
 * NULL, not true, so a bare `STATUS <> 'V'` silently drops NULL-status rows.
 */
export function liveRows(alias = "t"): string {
  return `IFNULL(${alias}.DELETEDTIME, '') = '' AND IFNULL(${alias}.STATUS, '') <> 'V'`;
}

/** Only reconciled rows, for a reconciled balance. */
export function reconciledRows(alias = "t"): string {
  return `${liveRows(alias)} AND IFNULL(${alias}.STATUS, '') = 'R'`;
}

/**
 * TRANSDATE may carry a time component.
 *
 * MMEX writes `isoDateTime()`, so a value can be '2026-08-28T14:30:00' rather
 * than '2026-08-28' (src/data/TrxData.cpp:54). Range comparisons survive that
 * because ISO-8601 sorts correctly, but an equality test against a bare date
 * misses those rows entirely. Always normalize.
 */
export function transactionDate(alias = "t"): string {
  return `date(${alias}.TRANSDATE)`;
}

/**
 * How a transaction contributes to one account's balance.
 *
 * Transcribed from `TrxData::account_flow` (src/data/TrxData.cpp:109):
 *
 *   Withdrawal, viewed from ACCOUNTID    -> -TRANSAMOUNT
 *   Deposit,    viewed from ACCOUNTID    -> +TRANSAMOUNT
 *   Transfer,   viewed from ACCOUNTID    -> -TRANSAMOUNT
 *   Transfer,   viewed from TOACCOUNTID  -> +TOTRANSAMOUNT
 *   Transfer,   ACCOUNTID == TOACCOUNTID -> 0 (self-transfer, a revaluation)
 *   anything else                        -> 0
 *
 * Two consequences that are easy to get wrong. Neither side of a transfer is
 * rate-converted here: TRANSAMOUNT is already in the FROM account's currency
 * and TOTRANSAMOUNT in the TO account's, so the exchange is already baked into
 * the two stored figures. And a transfer row is visited twice, once per side,
 * so it must never be summed once globally.
 *
 * The self-transfer case is 1.9.1 and later. On 1.9.0 a self-transfer nets
 * -TRANSAMOUNT because the FROM branch is tested first.
 */
export function accountFlow(alias: string, accountIdSql: string): string {
  return `CASE
    WHEN ${alias}.TRANSCODE = 'Deposit'  AND ${alias}.ACCOUNTID = ${accountIdSql} THEN ${alias}.TRANSAMOUNT
    WHEN ${alias}.TRANSCODE = 'Transfer' AND ${alias}.ACCOUNTID = ${alias}.TOACCOUNTID THEN 0
    WHEN ${alias}.TRANSCODE = 'Transfer' AND ${alias}.TOACCOUNTID = ${accountIdSql} THEN ${alias}.TOTRANSAMOUNT
    WHEN ${alias}.TRANSCODE = 'Transfer' AND ${alias}.ACCOUNTID = ${accountIdSql} THEN -${alias}.TRANSAMOUNT
    WHEN ${alias}.ACCOUNTID = ${accountIdSql} THEN -${alias}.TRANSAMOUNT
    ELSE 0 END`;
}

/**
 * Asset and stock movements that MMEX excludes from income and expense.
 *
 * `is_foreignAsTransfer` (src/model/TrxModel.cpp:120): a row that is NOT a
 * Transfer but carries a TOACCOUNTID pointing at the AS_TRANSFER sentinel or
 * at its own ACCOUNTID. Neither published MMEX report knows about this, so
 * both double-count asset and share purchases as ordinary expenses.
 */
export const AS_TRANSFER_SENTINEL = -998;

export function isForeignAsTransfer(alias = "t"): string {
  return `(${alias}.TRANSCODE <> 'Transfer' AND ${alias}.TOACCOUNTID > 0
    AND (${alias}.TOACCOUNTID = ${AS_TRANSFER_SENTINEL} OR ${alias}.TOACCOUNTID = ${alias}.ACCOUNTID))`;
}

/**
 * Maximum category tree depth.
 *
 * MMEX has neither a depth limit nor cycle protection: the upward walk in
 * `get_data_fullname` is an unbounded while loop and `find_data_subtree_a` is
 * unbounded recursion, so a cyclic PARENTID hangs the application. A recursive
 * CTE would hang the same way, so this server caps it.
 */
export const MAX_CATEGORY_DEPTH = 32;

/** Root categories use PARENTID = -1, never NULL. */
export const CATEGORY_ROOT_PARENT_ID = -1;
