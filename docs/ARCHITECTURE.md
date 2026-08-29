# Architecture

**TL;DR.** Five layers, each with one job, arranged so the hard part (MMEX's
financial semantics) is isolated, cited, and independently testable. Money never
touches floating point. The database handle physically cannot write. Every rule
that could be got wrong has a test that demonstrates the wrong answer alongside
the right one.

## Module map

```
src/
  bin/         CLI entry points (mmex-mcp, mmex-fixture). Thin: parse, load
               config, wire, connect. No logic.
  config/      Flags > environment > config file > defaults. Rejects inline
               API keys outright.
  db/          The read-only connection. The only place that opens the file.
  money/       Integer minor units. The only place that does arithmetic on
               amounts.
  semantics/   MMEX's financial rules, cited to the application's C++ source.
               The heart of the project.
  tools/       MCP tool definitions. Each declares an outputSchema and
               annotations. Thin: call semantics, shape the result.
  server/      Builds the McpServer and registers tools. Split from bin/ so
               tests can drive a fully wired server in process.
  fixture/     Deterministic synthetic database generator.
  evals/       LLM providers for the eval harness. The only outbound network
               code in the repository, and it is not part of the server.
```

The dependency direction is strictly downward: `tools` depends on `semantics`
depends on `db` and `money`. Nothing in `semantics` knows what MCP is, which is
why it can be tested against hand-built databases with no server running.

## Request path

```
Claude Code
    │  JSON-RPC over stdio
    ▼
bin/server.ts ──> config/ ──> db/connection.ts   (readonly + query_only)
    │
    ▼
server/server.ts  registers tools, each with an outputSchema
    │
    ▼
tools/*.ts ──> semantics/*.ts ──> SQL ──> money/ ──> structuredContent
```

## The five layers, and why each exists

### db: one place that opens the file

The read-only guarantee is enforced twice, because one layer alone is not
provable:

- `readonly: true` refuses writes at the SQLite handle level.
- `PRAGMA query_only = ON` refuses them at the SQL level, even if a future code
  path somehow obtained a writable handle.

`verifyReadOnly()` proves it rather than asserting it. It attempts a real write
and reports the SQLite error code that refused it. The probe is
`DELETE FROM ACCOUNTLIST_V1 WHERE 1 = 0`, chosen because it changes nothing even
in the failure case where it is somehow permitted.

**A gotcha worth recording**, because a test asserting the obvious thing passes
for the wrong reason: `prepare()` on an INSERT does **not** throw, and `.all()`
on one hits better-sqlite3's own "does not return data" guard rather than
`SQLITE_READONLY`. Only `.run()` and `.exec()` surface the real error code.

This layer also handles the unhappy paths a user will actually hit: a missing
file, a directory, an empty file, a non-SQLite file, an encrypted `.emb`
(detected by the absent SQLite header, with a specific hint), a valid SQLite
database that is not MMEX, and a database locked by a running MMEX.

### money: no floating point, ever

SQLite returns `numeric` columns as IEEE 754 doubles, and `10.10 + 20.20` really
does come back as `30.299999999999997`. Every total would inherit that.

Amounts convert to integer minor units at the SQL boundary, stay integral
through all arithmetic, and format back only at output. Minor units are held in
`number` rather than `bigint`: a double represents every integer up to 2^53
exactly, which is roughly 90 trillion units at two decimal places, and every
conversion asserts the safe-integer bound rather than assuming it.

Two operations are deliberately named apart, because conflating them is how
rounding bugs get in:

- **`recoverMinor`** takes a value the database already stores at the currency's
  precision. Scaling and rounding to the nearest integer reproduces the decimal
  the user typed. This is *recovery*, not a decision.
- **`roundToMinor`** makes a genuine rounding decision, such as after a currency
  conversion. Half away from zero, so a sign flip never changes magnitude.

Mixing precisions throws rather than producing a plausible wrong total.

### semantics: the part that is actually hard

Every rule here is transcribed from Money Manager EX 1.9.4 RC1 (commit
`35f3081`) with a file and line citation in the source comments, because MMEX's
own published reports contradict both the application and each other. See
[CONFORMANCE.md](CONFORMANCE.md).

The four rules most likely to be got wrong:

**Live rows.** `IFNULL(DELETEDTIME, '') = '' AND IFNULL(STATUS, '') <> 'V'`.
Both halves must be `IFNULL`-guarded. MMEX writes `''` for a live row but other
tooling writes `NULL`, and in SQLite `NULL <> 'V'` evaluates to `NULL`, not
true, so a bare comparison silently drops rows. Only void and deleted are
excluded: `'D'` (Duplicate) is real money to the application, and excluding it
was a real bug in this codebase that the source review caught.

**Transaction signing.** A transfer is one row visited once *per side*:
`-TRANSAMOUNT` for the source account, `+TOTRANSAMOUNT` for the destination,
zero for a self-transfer. Neither side is rate-converted, because each column is
already denominated in its own account's currency.

**Splits.** Discriminate on the *existence* of `SPLITTRANSACTIONS_V1` rows, never
on `CATEGID = -1`. That sentinel means both "this is a split" and "this is plain
uncategorized", and conflating them is exactly the bug that makes MMEX's own
category report lose money.

**Currency.** A six-step fallback chain, gated on `USECURRENCYHISTORY`, resolved
on the *account's* currency. Step five reaches **forward to a future rate** when
that rate is nearer in time. It is neither carry-forward nor interpolation.

### tools: thin by construction

A tool parses input, calls semantics, and shapes a result. It contains no
financial logic, which is what keeps the rules in one auditable place.

Every tool declares:

- an **`outputSchema`**, so results arrive as `structuredContent` rather than
  prose the model has to re-parse;
- **`annotations`** marking it `readOnlyHint`, non-destructive, closed-world.

Both are asserted by tests that iterate every registered tool, so a new tool
cannot ship without them.

Results are **aggregate-first**: bounded summaries with an explicit `truncated`
flag and a drill-down path, never raw row dumps. A year of transactions does not
fit usefully in a context window, and handing a model thousands of rows makes it
do arithmetic it is bad at.

### fixture: test data that is safe to commit

A real `.mmb` file must never end up in version control, and tests need data
that does not change between runs. A generated database solves both, and it
doubles as sample data for anyone who wants to try the server without pointing
it at their own finances.

Determinism took deliberate care: a fixed `page_size`, `journal_mode = DELETE`,
a fixed anchor date rather than "today", mulberry32 for all randomness, and a
fixed insert order. Same seed, byte-identical file, asserted by a test.

The data is adversarial by design. Every trap the semantic layer exists to
handle is planted, so a naive implementation produces visibly wrong answers.

## Decisions, and what they cost

| Decision | Why | What it costs |
|---|---|---|
| TypeScript on the official SDK | Tier 1 SDK, `npx` distribution, largest MCP ecosystem | Not the fastest language for the data work |
| `better-sqlite3` over `node:sqlite` | Stable today, prebuilt binaries, no experimental-feature warning on startup | A native dependency; revisit when `node:sqlite` is stable |
| Integer minor units in `number` | Exact for the domain, and readable | Would need `bigint` past 2^53 minor units, which no personal database reaches |
| Read-only in v1 | Write access to a finance database means locking, integrity and backup concerns, for a tool whose job is answering questions | Cannot categorize or correct transactions |
| Aggregate-first tools | Row dumps blow the context window and push arithmetic onto the model | Some questions need a drill-down round trip |
| Conform to the app, not the reports | The reports contradict each other and contain two bugs | Numbers differ from MMEX's own reports, hence CONFORMANCE.md |
| Hand-rolled argument parsing | Keeps the dependency tree auditable, which is part of the safety claim | A little more code |

## Testing approach

Three kinds of test, deliberately:

1. **Hand-built databases** where every row's expected treatment is known. Used
   for the semantic rules, so a failure points at one rule rather than at a
   1,156-row fixture.
2. **The generated fixture**, for integration behavior at realistic scale.
3. **A real MCP client against a real server** over the SDK's in-memory
   transport, so the protocol surface is exercised rather than mocked.

Several tests assert the **wrong** answer alongside the right one, to document
the failure mode they guard:

```ts
expect(withIfnull?.n).toBe(1);
expect(naive?.n).toBe(0); // demonstrates the bug this guards against
```

That pattern covers the `NULL <> 'V'` three-valued-logic trap and the
`TRANSDATE = '2026-01-01'` case that misses rows stored as
`'2026-01-01T14:30:00'`.
