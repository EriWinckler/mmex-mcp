# mmex-mcp

**A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
[Money Manager EX](https://moneymanagerex.org), so you can ask an AI assistant
about your own finances and get answers that are actually correct.**

The interesting part is not that it reads a SQLite file. It is that reading a
personal finance database correctly is genuinely hard, and **Money Manager EX's
own published reports get it wrong in two places.** This server encodes the
semantics from the desktop application's C++ source instead, and documents
every divergence.

```
You:    What did I actually spend on groceries last quarter?

Naive:  SELECT SUM(TRANSAMOUNT) ... WHERE CATEGID = 2
        Wrong. Silently misses every split transaction, counts transactions
        you deleted, counts transfers to your own savings account as spending,
        and returns 30.299999999999997.
```

---

## Why this is not a thin SQLite wrapper

Hand an assistant raw SQL access to an MMEX database and it will produce
confident, wrong numbers. The schema has five traps, and a plausible-looking
query falls into all five:

| Trap | Where it hides | What a naive query does |
|---|---|---|
| **Transfers are one row, not two** | `CHECKINGACCOUNT_V1.TOACCOUNTID` + `TOTRANSAMOUNT` | Counts moving money into your own savings as an expense |
| **Splits carry the category, the parent does not** | `SPLITTRANSACTIONS_V1.CATEGID` | Every split transaction is misfiled, or vanishes entirely |
| **Soft deletes** | `DELETEDTIME`, which is `''` *or* `NULL` | Counts transactions sitting in your trash |
| **Historical vs current exchange rates** | `CURRENCYHISTORY_V1` vs `BASECONVRATE` | Last year's spending changes every time today's rate moves |
| **Categories are a self-referencing tree** | `CATEGORY_V1.PARENTID` (root is `-1`, not `NULL`) | No rollup, and a cyclic parent hangs the query forever |

Plus amounts are stored in `numeric` columns, which SQLite hands back as
floats. That is not theoretical:

```
sqlite> SELECT 10.10 + 20.20;
30.299999999999997
```

An MCP server over a database is not "expose the tables". It is a **semantic
layer** that encodes the domain invariants the model would otherwise get wrong.

## The part that surprised me

Partway through building this, "just match MMEX" stopped being a specification.
**MMEX's two official reports, asked the same question, give different answers:**

| | Category report | Income vs Expense report |
|---|---|---|
| Transfers | excluded by predicate | mapped to zero |
| Soft deletes | filtered | **not filtered at all** |
| Void / Duplicate | both excluded | only void |
| Currency conversion | applied | **none** |

So the reports could not be the authority. The **application** is. The rules in
this server were read out of the Money Manager EX C++ source (1.9.4 RC1, commit
`35f3081`) with a file and line citation for every rule.

That comparison turned up **eight divergences, five material, and two outright
bugs in MMEX's published reports**:

- `ExpenseAndRevenueByMonth` ignores `DELETEDTIME` entirely, so **transactions in
  your trash are counted as live income and expense.**
- `CategoriesStatLast12Months` conflates the two meanings of `CATEGID = -1`, so
  **plain uncategorized transactions do not get misfiled, they disappear from
  the report completely.**

All eight are documented with citations in **[docs/CONFORMANCE.md](docs/CONFORMANCE.md)**,
which is also the honest answer to "why does your number differ from mine?"

## Try it in 30 seconds, with no data of your own

> **Not published to npm yet.** Until it is, run it from a clone. The `npx`
> form below is what it will be, and is shown so the eventual command is
> obvious.

You do not need a Money Manager EX file. Generate a synthetic one:

```bash
git clone https://github.com/EriWinckler/mmex-mcp && cd mmex-mcp
npm install && npm run build

node dist/bin/fixture.js --out demo.mmb
claude mcp add mmex-demo -- node "$PWD/dist/bin/server.js" --db "$PWD/demo.mmb"
```

Then just ask Claude Code about it. Remove it with `claude mcp remove mmex-demo`.

Once published, that becomes:

```bash
npx mmex-fixture --out demo.mmb
claude mcp add mmex-demo -- npx -y mmex-mcp --db "$PWD/demo.mmb"
```

The generated database is **deterministic** (same seed, byte-identical file) and
**adversarial on purpose**. It contains 1,210 transactions across 4 accounts and
3 currencies (USD, EUR, and JPY for its zero-decimal precision), and every trap
above is planted deliberately: same-currency and
cross-currency transfers, splits whose parent has no category, soft deletes in
both encodings, void and duplicate rows, a zero-decimal currency (JPY), a
three-level category tree, and exchange rates that actually drift month to
month. A naive implementation gets visibly wrong answers on it. That is the
point.

Pointing it at your real data is the same command with a different path:

```bash
claude mcp add mmex -- node "$PWD/dist/bin/server.js" --db ~/finances.mmb
```

See **[docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md)** for scopes, options, and
configuration.

## Status

Under active development. What works today:

| | Status |
|---|---|
| Read-only connection layer, with a proven guarantee | Done |
| Exact money arithmetic (integer minor units) | Done |
| Semantic layer (transfers, splits, deletes, FX, category tree) | Done |
| Deterministic synthetic database generator | Done |
| MCP server + Claude Code integration | Done |
| Configurable LLM provider for the accuracy suite | Done |
| `mmex_database_info` tool | Done |
| Schema-version compatibility check | Done |
| Remaining 8 analytics tools | **In progress** |
| Answer-accuracy regression suite | **Planned** |
| CI | **Planned** |

**101 tests passing.** Typecheck and lint clean.

## Safety

Your financial data is the most sensitive thing on your machine, so the posture
is designed to be *checkable* rather than promised.

- **Read-only, enforced twice.** `readonly: true` at the SQLite handle and
  `PRAGMA query_only = ON` at the SQL layer.
- **Proven, not claimed.** `mmex_database_info` attempts a real write
  (`DELETE ... WHERE 1 = 0`, a no-op even if permitted) and reports the SQLite
  error code that refused it. If it does not say `SQLITE_READONLY`, do not trust
  it.
- **No network. At all.** The server opens no sockets. The only outbound call in
  the whole repository lives in the eval harness, which is a separate tool you
  run deliberately.
- **Three direct runtime dependencies**: `@modelcontextprotocol/sdk`,
  `better-sqlite3`, `zod`. Being precise, since it matters for a tool that
  reads your finances: those pull in **97 packages transitively**, most of them
  from the MCP SDK, which bundles an HTTP transport stack this server never
  uses. `npm ls --omit=dev --all` shows the full tree.
- **`--redact`** replaces payee, account and category names, and reduces the
  database path to its basename, with stable placeholders. Every amount is left
  intact, so the numbers still make sense. For screen sharing and bug reports.
- **`--snapshot`** reads a temporary copy, so a running MMEX is never touched.
- **API keys are never stored in config.** The config file holds the *name* of an
  environment variable, and an inline `apiKey` is rejected with an explicit
  error rather than ignored.
- **`.gitignore` refuses `*.mmb` and `*.emb` by default**, so a real database
  cannot be committed by accident.

## How it works

```
Claude Code  ──stdio/JSON-RPC──>  mmex-mcp
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
               tools/           semantics/         money/
            aggregate-first    the MMEX rules   integer minor
            outputSchema       (cited to C++)      units
                    │                │                │
                    └────────────────┼────────────────┘
                                     │
                                  db/  ── readonly + query_only
                                     │
                              your .mmb file
```

Design choices worth knowing:

- **Aggregate-first.** Tools return bounded summaries with an explicit
  `truncated` flag and a drill-down path, never raw transaction dumps. A year of
  transactions does not fit usefully in a context window, and dumping rows
  makes the model do arithmetic it is bad at.
- **Every tool declares an `outputSchema`**, so results arrive as structured
  data rather than prose. Tests assert this across every registered tool, so a
  new tool cannot ship without one.
- **Money never touches floating point.** Amounts convert to integer minor units
  at the SQL boundary and format back only at output. `recoverMinor` and
  `roundToMinor` are named apart on purpose: recovering a decimal the database
  already stores is not the same operation as making a rounding decision after
  a currency conversion.
- **Verified, not assumed.** The MCP SDK's published README documents an import
  path that does not resolve in the installed version. Every external API here
  was introspected from the installed package or run for real.

More in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Development

Requires **Node 22+** (Node 24 LTS recommended).

```bash
npm install
npm run verify      # typecheck + lint + test
npm run build
npm test -- --watch
```

| Script | What it does |
|---|---|
| `npm run verify` | The full gate: typecheck, lint, tests |
| `npm run build` | Compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | Biome check |
| `npm test` | Vitest |

Toolchain is pinned to exact versions so results are reproducible: TypeScript
7.0.2, MCP SDK 1.30.0, better-sqlite3 13.0.3, zod 4.5.2, vitest 4.1.11,
Biome 2.5.11.

See **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Roadmap

**v1** finishes the analytics surface:

- The remaining 8 tools: balances, spending by category, income vs expense,
  transaction search, payees, budget vs actual, net worth, recurring items.
- **An answer-accuracy regression suite.** Unit tests prove the SQL is right;
  they cannot prove an assistant given these tools actually answers a question
  correctly. The suite asks roughly 40 natural-language questions whose answers
  are computed independently by hand-verified SQL, and fails if the assistant's
  answer disagrees. Running the same questions against raw SQL access is the
  control: it shows which of the semantic rules are actually load-bearing, so a
  rule cannot be quietly dropped without a test noticing.

**Later:**

- Encrypted `.emb` (SQLCipher) support.
- An opt-in write mode, behind an explicit flag, with dry-run and automatic
  backup.
- Dropping the native dependency once Node's built-in `node:sqlite` is stable.

## Prior art

Personal finance MCP servers exist for
[MoneyWiz](https://github.com/jcvalerio/moneywiz-mcp-server),
[Monarch Money](https://github.com/felixgalindo/monarch-money-mcp), MoneyMoney
and others, and they were useful references for the general shape.

None targets Money Manager EX, which is why this exists. The emphasis here is
on matching the host application's semantics exactly and documenting where that
differs from its published reports, because a finance answer that is subtly
wrong is worse than no answer.

## License

MIT. See [LICENSE](LICENSE).

Money Manager EX is GPL-2.0 and is not affiliated with this project. The schema
definitions here are authored from the documented table and column names rather
than copied from the upstream repository.
