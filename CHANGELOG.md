# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Read-only MCP server over Money Manager EX databases, speaking stdio.
- `mmex_database_info` tool reporting schema version, base currency, date range,
  account and transaction counts, and the live safety posture.
- Semantic layer implementing MMEX's financial rules, transcribed from the
  application's source with citations: transfer signing, split attribution,
  the live-row filter, the six-step currency fallback, and the category tree.
- Exact money arithmetic using integer minor units, avoiding the float error
  that SQLite's `numeric` columns otherwise introduce.
- `mmex-fixture` command generating a deterministic synthetic database, so the
  server can be run without pointing it at real finances.
- Configuration via flags, environment variables, or a config file, with API
  keys read only from named environment variables.
- Configurable LLM providers (Claude Code CLI, or the Anthropic API) for the
  planned answer-accuracy suite.
- Schema-version compatibility check, warning when a database reports a version
  the semantics were not verified against.
- `--redact` mode replacing names and reducing the database path to a basename.
- `--snapshot` mode reading a temporary copy, for when MMEX holds the database.
- Diagnostics to stderr, off by default, enabled with `MMEX_MCP_LOG`.

### Fixed

- `mmex-fixture` overwrote an existing file without warning. It now refuses
  unless `--force` is given, and refuses a real Money Manager EX database even
  then.
- `--snapshot` copied only the main database file, so on a WAL-mode database it
  silently omitted every transaction not yet checkpointed. It now uses SQLite's
  `VACUUM INTO`, which is WAL-aware.
- `--snapshot` left its temporary copy behind when the client detached by
  closing stdin, which is the normal way an MCP session ends. Cleanup now runs
  on every exit path, and the copy is written with owner-only permissions.
- `isForeignAsTransfer` could never match the asset-transfer sentinel, and
  returned NULL rather than false for ordinary transactions, which would have
  filtered out nearly every row for any caller using it.
- `placesFromScale` rejected the eight-decimal currencies MMEX ships, and threw
  on an unusable value instead of falling back, taking down every other currency
  with it.

- `--redact` was documented but inert: the redaction helpers were never called
  by any tool.
- A failed `--snapshot` copy left a partial copy of the database in the temp
  directory.
- Duplicate (`STATUS = 'D'`) transactions were excluded from counts. The Money
  Manager EX application treats them as real money; only void and soft-deleted
  rows are excluded.
