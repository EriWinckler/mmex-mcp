# Contributing

Thanks for looking. This document should get you from clone to a passing build
in about two minutes.

## Setup

Requires **Node 22 or later**. Node 24 LTS is what this is developed against.

```bash
git clone <this repo>
cd mmex-mcp
npm install
npm run verify
```

`npm run verify` is the whole gate: typecheck, lint, tests. It should be green
on a fresh clone. If it is not, that is a bug worth reporting.

## Working on it

```bash
npm test -- --watch          # tests on change
npm run lint:fix             # apply formatting and safe lint fixes
npm run build                # compile to dist/
node dist/bin/fixture.js --out /tmp/demo.mmb
node dist/bin/server.js --db /tmp/demo.mmb
```

To drive the built server through Claude Code:

```bash
claude mcp add mmex-dev -- node "$PWD/dist/bin/server.js" --db /tmp/demo.mmb
```

## Ground rules

**Never commit a real database.** `.gitignore` refuses `*.mmb` and `*.emb` by
default. Do not force-add one. If you need data, generate it:
`node dist/bin/fixture.js`.

**Never put a secret in a config file.** The config schema rejects an inline
`apiKey` with an explicit error. Use the environment variable name instead.

**Every commit passes `npm run verify`.** The history is meant to read as
working increments.

## File headers

Every `.ts` file under `src/` and `test/` opens with the copyright block:

```
/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)
 ...
 ********************************************************/
```

The layout follows Money Manager EX's own source convention, which makes the
two codebases read consistently for anyone moving between them. The license
paragraphs are MIT rather than MMEX's GPL-2.0, since that is this project's
license.

On the two `src/bin/*.ts` entry points the shebang stays on line 1 and the
header goes beneath it. A header above the shebang makes the published binary
unexecutable.

## Adding a tool

1. Create `src/tools/<name>.ts` with the copyright header above, exporting
   `register<Name>(server, context)`.
2. Declare an **`outputSchema`**. Results must arrive as `structuredContent`,
   not prose.
3. Declare **`annotations`**: `readOnlyHint: true`, `destructiveHint: false`,
   `openWorldHint: false`. Tests iterate every registered tool and assert these,
   so a tool without them fails the build.
4. **Put no financial logic in the tool.** Call into `src/semantics/`. Keeping
   the rules in one place is what makes them auditable.
5. Return **bounded aggregates** with a `truncated` flag and a drill-down path.
   Never dump rows.
6. Register it in `src/server/server.ts`.
7. Write tests. If the tool touches a semantic rule, add a hand-built database
   case where the expected answer is obvious by inspection.

## Changing a financial rule

This is the part to be careful with.

**Cite the source.** Every rule in `src/semantics/` carries a file and line
reference into the Money Manager EX C++ source. If you change behavior, update
the citation, or explain why the application is wrong.

The authority is the **desktop application**, not MMEX's published
`general-reports` SQL. Those reports contradict the application and each other,
and contain two known bugs. See [docs/CONFORMANCE.md](docs/CONFORMANCE.md).

If your change makes this server disagree with the application, that is a
deliberate decision and belongs in the conformance document with its reasoning.

**Add a test that demonstrates the wrong answer.** Several existing tests assert
the naive result next to the correct one, so the failure mode stays visible:

```ts
expect(correct?.n).toBe(1);
expect(naive?.n).toBe(0); // demonstrates the bug this guards against
```

## Commit messages

Conventional-commit prefix, then a body that explains **why**, not what. The
diff already says what. Good subjects from this repo's history:

```
feat(semantics): implement the desktop app's rules, not the published reports
fix(db): ... 
chore: force LF line endings repo-wide
```

If you hit something non-obvious, put it in the commit body. That is where the
next person looks.

## Reporting a bug

Include:

- What you asked, and what came back.
- Output of `mmex_database_info` (it contains no personal data).
- Whether it reproduces against a generated fixture:
  `npx mmex-fixture --out demo.mmb --seed 42`.

**Do not attach your real database.** If you need to share a shape, run the
server with `--redact`, which replaces names with stable placeholders and leaves
amounts intact.
