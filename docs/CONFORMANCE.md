# Conformance: whose semantics does mmex-mcp implement?

**TL;DR.** It implements the **Money Manager EX desktop application's** rules, read
out of its C++ source. It deliberately does **not** follow MMEX's own published
`general-reports` SQL, because those reports disagree with the application in
eight places, five of them material, and two of those are outright bugs that
lose or invent money.

If a number from this server disagrees with a number from a general report, this
page says why, and the desktop app agrees with this server.

## Why this document exists

"Match MMEX" sounds like a specification until you try to write it down. Two
official MMEX reports, asked the same question, give two different answers:

| | Category report | Income vs Expense report |
|---|---|---|
| Transfers | excluded by predicate | mapped to zero |
| Soft deletes | filtered | **not filtered at all** |
| Void / Duplicate | both excluded | only void |
| Currency conversion | applied | **none** |

So the reports cannot be the authority. The application is.

## Source of truth

Money Manager EX **1.9.4 RC1**, commit `35f3081` (2026-08-28),
[moneymanagerex/moneymanagerex](https://github.com/moneymanagerex/moneymanagerex).

One trap for anyone verifying this: between 1.9.0 and 1.9.1 the model layer was
renamed wholesale (`Model_Checking` to `TrxModel`/`TrxData`, `Model_Account` to
`AccountModel`, `src/reports/` to `src/report/`). The `_V1` database schema is
unchanged, so this is a C++ rename and not a migration, but paths from older
documentation will not resolve.

## The rules this server implements

### Row exclusion

```sql
IFNULL(DELETEDTIME, '') = '' AND IFNULL(STATUS, '') <> 'V'
```

Void and soft-deleted only. `is_valid()` is `!is_void() && !is_deleted()`
(`src/data/TrxData.h:80`).

Both halves must be `IFNULL`-guarded. MMEX writes `''` for a live row, but other
tooling writes `NULL`, and the app compiles exactly `IFNULL(DELETEDTIME, '') = ''`
(`src/model/TrxModel.cpp:68`). On the status side, `NULL <> 'V'` evaluates to
`NULL` in SQLite, not true, so a bare comparison silently drops NULL-status rows.

The five recognized statuses are `''` (unreconciled), `R`, `V`, `F`, `D`
(`src/data/_DataEnum.cpp:94`). An unrecognized value falls back to unreconciled,
and an unrecognized `TRANSCODE` falls back to `Withdrawal`.

### Transaction signing

From `TrxData::account_flow` (`src/data/TrxData.cpp:109`):

| TRANSCODE | Account viewed | Contribution |
|---|---|---|
| Withdrawal | `ACCOUNTID` | `-TRANSAMOUNT` |
| Deposit | `ACCOUNTID` | `+TRANSAMOUNT` |
| Transfer | `ACCOUNTID` (from) | `-TRANSAMOUNT` |
| Transfer | `TOACCOUNTID` (to) | `+TOTRANSAMOUNT` |
| Transfer | `ACCOUNTID == TOACCOUNTID` | `0` (self-transfer, a revaluation) |
| any | neither | `0` |

Neither side of a transfer is rate-converted at read time: `TRANSAMOUNT` is
already in the source account's currency and `TOTRANSAMOUNT` in the
destination's. A transfer row is visited once **per side**, so it must never be
summed once globally.

The self-transfer case is 1.9.1 and later. On 1.9.0 a self-transfer nets
`-TRANSAMOUNT`, because the from-branch is tested first.

### Splits

Discriminate on the **existence of `SPLITTRANSACTIONS_V1` rows**, never on
`CATEGID = -1`. The sentinel `-1` means both "this is a split" and "this is
plain uncategorized" (`src/data/TrxData.cpp:29` and `src/dialog/TrxDialog.cpp:694`),
and conflating them is exactly bug C5 below.

Each split row is signed by the **parent's** `TRANSCODE`, not by its own sign
(`src/model/CategoryModel.cpp:343`). Individual split amounts may be negative;
only the total must be non-negative.

The sum of `SPLITTRANSAMOUNT` equals the parent `TRANSAMOUNT` by construction
from the UI, but nothing enforces it: no constraint, no trigger, and Tools then
"Check DB" is only `PRAGMA integrity_check`. Treat it as a strong convention.

### Currency

`CurrencyHistoryModel::get_id_date_rate` (`src/model/CurrencyHistoryModel.cpp:103`),
in order:

1. Base currency, or the `-1` sentinel: rate is `1.0`.
2. `INFOTABLE_V1.USECURRENCYHISTORY` is false (default **true**): use
   `CURRENCYFORMATS_V1.BASECONVRATE` and stop.
3. Exact `CURRENCYHISTORY_V1` row for that currency and date: use `CURRVALUE`.
4. No history rows for that currency at all: `BASECONVRATE`.
5. Otherwise the **nearest date in either direction**, ties going to the earlier.
6. Final fallback: `BASECONVRATE`.

Step 5 is the surprising one: MMEX will reach **forward to a future rate** when
that rate is closer in time. It is neither carry-forward nor interpolation.

The rate is resolved on the **account's** currency, not the transaction's
(`src/model/CategoryModel.cpp:326`).

MMEX is internally inconsistent about *which date*: the Category, Income vs
Expense, Payee and Transaction reports convert at each transaction's own date,
while the Cash Flow report and the home page convert everything at today's rate
(`src/report/FlowReport.cpp:105`, `src/panel/DashboardWidget.cpp:775`). Both are
genuinely "the app's behavior", so **each tool in this server states which basis
it uses in its own description.**

### SCALE

`CURRENCYFORMATS_V1.SCALE` is an integer **divisor**, and decimal places are
`log10(SCALE)` (`src/data/CurrencyData.h:63`). So `100` means two decimals and
`1` means zero (the JPY case). It is display and rounding precision only, never
a storage multiplier: amounts are stored as plain decimals, `12.34` and not `1234`.

Across all shipped currencies the values are `1`, `100`, `10000` and `100000000`,
all powers of ten. The column is nullable and unconstrained, so this server
defaults to 2 decimals when it is NULL or zero.

### Categories

Roots are `PARENTID = -1`, never NULL. The path separator is
`INFOTABLE_V1.CATEG_DELIMITER`, defaulting to `:`, and it is user-configurable
through an editable combo box, so it must be read rather than hardcoded
(`src/model/CategoryModel.cpp:134`).

MMEX has **no depth limit and no cycle protection**: a cyclic `PARENTID` hangs
the application, and would hang a recursive CTE identically. This server caps
depth at 32 and reports unresolvable categories instead of looping.

### Dates

`TRANSDATE` may carry a time component, because MMEX writes `isoDateTime()`
(`src/data/TrxData.cpp:54`). A value can be `2026-08-28T14:30:00`. Range
comparisons survive that since ISO-8601 sorts correctly, but equality against a
bare date misses those rows, so every date predicate here uses `date(TRANSDATE)`.

## Divergences from MMEX's published general-reports

Five material, three minor.

| # | Divergence | Severity | Who is right |
|---|---|---|---|
| C1 | Reports exclude `'D'` (Duplicate); the app never does | Material | App |
| C2 | `ExpenseAndRevenueByMonth` ignores `DELETEDTIME` entirely | **Bug** | App |
| C3 | `CategoriesStatLast12Months` converts every month at today's newest rate | Material | App |
| C4 | `CategoriesStatLast12Months` restricts to `ac.status = 'Open'` | Material | App |
| C5 | `CategoriesStatLast12Months` silently drops uncategorized non-split rows | **Bug** | App |
| C6 | The report CTE hardcodes `':'` instead of reading `CATEG_DELIMITER` | Minor | App |
| C7 | Three different transfer conventions across the three sources | Design call | App |
| C8 | Neither report knows about asset/stock `is_foreignAsTransfer` exclusion | Material | App |

### C2, in detail: soft deletes counted as live income and expense

`ExpenseAndRevenueByMonth` filters `status <> 'V'` with no `DELETEDTIME` clause
at all. Transactions sitting in the user's trash are counted as real money. This
is not an alternative convention, it is an omission. The same predicate also
drops NULL-status rows, for the SQLite three-valued-logic reason above.

### C5, in detail: money that vanishes

The report resolves a category with:

```sql
CASE ifnull(c.categid, -1) WHEN -1 THEN s.categid ELSE c.categid END
```

over a `LEFT JOIN splittransactions_v1`. For a genuine split that is correct.
But for a **plain uncategorized transaction**, `CATEGID = -1` with no split rows,
the join yields `NULL`, `SUM` skips it, and the money disappears from the report
entirely. Not misfiled into an "uncategorized" bucket: gone.

The app avoids this by discriminating on split-row existence
(`if (trxId_tpA_m[trx_d.m_id].empty())`, `src/model/CategoryModel.cpp:343`), and so
does this server.

## What is not yet verified

Whether the OFX and CSV import paths can persist a single-row split set,
bypassing the dialog rule that collapses a one-row split back into a normal
transaction. This does not affect correctness here, because this server keys on
split-row existence rather than on row count.
