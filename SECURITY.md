# Security

## Reporting a vulnerability

Please report privately through
[GitHub's private vulnerability reporting](https://github.com/EriWinckler/mmex-mcp/security/advisories/new)
rather than opening a public issue.

**Never attach your `.mmb` file to a report.** If you need to share the shape of
your data, run the server with `--redact`, which replaces payee, account and
category names with stable placeholders and reduces the database path to its
basename, while leaving every amount intact.

## Threat model

This is a local, single-user tool. It runs on your machine, reads one SQLite
file, and speaks MCP over stdio to a client you started. There is no server, no
listening port, and no multi-tenancy.

The risks worth designing against are therefore:

1. **Corrupting or locking your database.** It is your real financial history
   and it may not be backed up.
2. **Leaking financial data** somewhere you did not intend, such as a log file,
   a screenshot, a bug report, or a third party.
3. **Returning a confidently wrong number**, which in a finance tool is a
   security-adjacent failure: you may act on it.

## What the design does about each

**Never writes.** The database is opened `readonly` and with
`PRAGMA query_only = ON`. Both layers are asserted by tests. `mmex_database_info`
proves it at runtime by attempting a real write and reporting the SQLite error
code that refused it, so you can check rather than trust. The write probe is
`DELETE ... WHERE 1 = 0`, which changes nothing even if it were permitted.

**Never opens a network socket.** The server performs no network I/O of any
kind. The only outbound request in this repository is in the eval harness, a
separate tool you run deliberately, never the server.

**Never writes your data to disk.** No caching, no temp files, except the
optional `--snapshot` copy, which is created in the system temp directory and
removed on close. A failed copy is cleaned up rather than left behind.

**Logging is off by default** and goes to stderr, never stdout. Log lines carry
counts, durations and error classes, never amounts, payee names or notes.

**Secrets are never read from config files.** The config file holds the *name*
of an environment variable. An inline `apiKey`, `token` or `secret` field is
rejected with an explicit error rather than ignored.

**`.gitignore` refuses `*.mmb` and `*.emb`** so a real database cannot be
committed by accident.

**Correctness is treated as a safety property.** The financial rules are
transcribed from the Money Manager EX application source with citations, and
where this server disagrees with MMEX's own published reports, the divergence is
documented in [docs/CONFORMANCE.md](docs/CONFORMANCE.md) rather than left for you
to discover.

## What it does not protect against

- **Your MCP client.** Once you register this server, whatever assistant you
  connect can read your entire financial history. That is the point of the tool,
  and it is a decision you make when you register it. Use `--redact` when sharing
  a session.
- **A compromised dependency.** Three direct dependencies pull in 97 packages
  transitively. `npm audit --omit=dev` runs in CI, but that is a floor, not a
  guarantee.
- **Encrypted databases.** `.emb` (SQLCipher) files are detected and refused,
  not decrypted. Your passphrase is never requested or handled.

## Supported versions

Pre-1.0. Fixes land on `main`.
