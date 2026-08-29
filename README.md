# mmex-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
[Money Manager EX](https://moneymanagerex.org). Point it at your `.mmb` file and
ask an assistant about your finances.

It never writes to your database and never opens a network socket.

## Install

Not published to npm yet, so build it from a clone:

```bash
git clone https://github.com/EriWinckler/mmex-mcp && cd mmex-mcp
npm install && npm run build
```

Register it with Claude Code:

```bash
claude mcp add mmex -- node "$PWD/dist/bin/server.js" --db ~/finances.mmb
```

Once published that becomes `claude mcp add mmex -- npx -y mmex-mcp --db ~/finances.mmb`.

### Try it without your own data

```bash
node dist/bin/fixture.js --out demo.mmb
claude mcp add mmex-demo -- node "$PWD/dist/bin/server.js" --db "$PWD/demo.mmb"
```

That writes a synthetic database with fabricated accounts, payees and 18 months
of transactions. Remove it with `claude mcp remove mmex-demo`.

## Options

```
--db <file>      Path to the MMEX database
--config <file>  Config file (default ./mmex-mcp.config.json, then ~/.config/mmex-mcp/config.json)
--snapshot       Read a temporary copy, for when Money Manager EX is running and holding the file
--redact         Replace payee, account and category names with stable placeholders; amounts unchanged
```

Environment equivalents: `MMEX_MCP_DB`, `MMEX_MCP_SNAPSHOT`, `MMEX_MCP_REDACT`.
Flags beat environment beats config file. Set `MMEX_MCP_LOG=debug` for
diagnostics on stderr.

Full details in [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md).

## Tools

| Tool | Returns |
|---|---|
| `mmex_database_info` | Schema version, base currency, date range, account and transaction counts, and the server's read-only status |

More are in progress; see [Status](#status).

## Status

Early. The foundation is built and tested; the analytics surface is not.

| | |
|---|---|
| Read-only connection, schema-version check | Done |
| Exact money arithmetic | Done |
| MMEX semantics (transfers, splits, deletes, currency, categories) | Done |
| Synthetic database generator | Done |
| MCP server, Claude Code integration, configuration | Done |
| `mmex_database_info` | Done |
| Spending by category, balances, income vs expense, transactions, categories | In progress |
| Answer-accuracy regression suite | Planned |

111 tests. Typecheck and lint clean.

**Today this server reports on a database but cannot yet answer "what did I
spend on groceries last quarter".** That needs the tools listed as in progress.

## Why the queries are not obvious

The reason this is a semantic layer rather than a SQL passthrough is that the
MMEX schema has five traps, and a plausible-looking query falls into all of
them:

| Trap | Where | Effect of getting it wrong |
|---|---|---|
| Transfers are one row, not two | `CHECKINGACCOUNT_V1.TOACCOUNTID`, `TOTRANSAMOUNT` | Moving money to your own savings counts as an expense |
| Splits carry the category, the parent does not | `SPLITTRANSACTIONS_V1.CATEGID` | Split transactions are misfiled or dropped |
| Soft deletes | `DELETEDTIME`, which is `''` *or* `NULL` | Deleted transactions counted as real |
| Historical vs current exchange rates | `CURRENCYHISTORY_V1` vs `BASECONVRATE` | Last year's totals change when today's rate moves |
| Categories are a tree rooted at `-1`, not `NULL` | `CATEGORY_V1.PARENTID` | No rollup; a cyclic parent hangs the query |

Amounts are stored in `numeric` columns, which SQLite returns as floats:
`SELECT 10.10 + 20.20` gives `30.299999999999997`. This server converts to
integer minor units at the SQL boundary and formats back only at output.

### Which semantics

MMEX's two published general reports disagree with each other, so they cannot
serve as the specification:

| | Category report | Income vs Expense report |
|---|---|---|
| Transfers | excluded | mapped to zero |
| Soft deletes | filtered | not filtered |
| Void / Duplicate | both excluded | only void |
| Currency conversion | applied | none |

This server follows the desktop application instead, read from its C++ source
(1.9.4 RC1, commit `35f3081`), with a file and line citation for each rule.
The comparison surfaced eight divergences from the published reports, including
two that lose data: `ExpenseAndRevenueByMonth` ignores `DELETEDTIME` entirely,
and `CategoriesStatLast12Months` drops uncategorized non-split transactions
rather than bucketing them.

All eight are in [docs/CONFORMANCE.md](docs/CONFORMANCE.md), which is the answer
to "why does your number differ from my report".

## Safety

- **Read-only**, enforced by `readonly: true` at the SQLite handle and
  `PRAGMA query_only = ON` at the SQL layer.
- `mmex_database_info` reports the live posture by attempting a write
  (`DELETE ... WHERE 1 = 0`, a no-op even if permitted) and returning the SQLite
  error code that refused it.
- **No network access.** The server opens no sockets.
- **The database path is never exposed.** It contains your account name and
  would otherwise land in transcripts, screen shares and pasted bug reports.
  This is privacy hygiene, not an access control: an assistant with shell access
  can still find the file via `ps`, the client config, or `find`. The defense
  against a raw query is that it gives wrong answers, which is what the semantic
  layer and the conformance document are for.
- `--redact` for screen sharing; `--snapshot` to avoid touching a live file.
- API keys are read only from named environment variables, never from a config
  file; an inline key is rejected with an error.
- `.gitignore` refuses `*.mmb` and `*.emb`.
- Three direct dependencies, 97 transitive, mostly from the MCP SDK's bundled
  HTTP transport that this stdio server does not use.

Threat model and limits: [SECURITY.md](SECURITY.md).

## Development

Node 22+ (24 LTS recommended).

```bash
npm install
npm run verify     # typecheck, lint, test
npm run build
```

Architecture and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- Spending by category, account balances, income vs expense, transaction search,
  category resolver.
- An answer-accuracy regression suite: unit tests prove the SQL is right, but
  not that an assistant given these tools answers correctly. Running the same
  questions against raw SQL is the control, showing which semantic rules are
  load-bearing.
- Encrypted `.emb` (SQLCipher) support.
- Optional write mode behind a flag, with dry-run and backup.

## Related

Personal finance MCP servers exist for
[MoneyWiz](https://github.com/jcvalerio/moneywiz-mcp-server),
[Monarch Money](https://github.com/felixgalindo/monarch-money-mcp) and others.
None targets Money Manager EX.

## License

MIT, see [LICENSE](LICENSE). Money Manager EX is GPL-2.0 and unaffiliated; the
schema definitions here are written from the documented table and column names
rather than copied from upstream.
