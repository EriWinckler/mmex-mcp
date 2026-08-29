#!/usr/bin/env node
import { resolve } from "node:path";
import { boolFlag, intFlag, parseArgs, stringFlag } from "../cli/args.js";
import { generateFixture } from "../fixture/generate.js";

const USAGE = `mmex-fixture: generate a synthetic Money Manager EX database

  Produces a deterministic .mmb file containing fabricated financial data.
  The same seed always produces a byte-identical file. No real data is used
  or required.

Usage:
  mmex-fixture [--out <file>] [--seed <n>] [--months <n>] [--anchor <YYYY-MM-DD>]

Options:
  --out <file>            Output path (default: ./mmex-demo.mmb)
  --seed <n>              Any integer; same seed, same file (default: 42)
  --months <n>            Months of history to generate (default: 18)
  --anchor <YYYY-MM-DD>   Last date in the history (default: 2026-06-30).
                          Fixed rather than "today" so output stays stable.
  --force                 Replace an existing file. Refused for anything that
                          looks like a real Money Manager EX database.
  --json                  Print the summary as JSON
  --help                  Show this message

Writes fabricated data. It will not overwrite an existing file unless you
pass --force, because --out is one keystroke from --db.
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (boolFlag(args, "help")) {
    process.stdout.write(USAGE);
    return;
  }

  const out = resolve(stringFlag(args, "out") ?? "mmex-demo.mmb");
  const anchor = stringFlag(args, "anchor") ?? "2026-06-30";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    throw new Error(`--anchor expects YYYY-MM-DD, got "${anchor}"`);
  }

  const summary = generateFixture(out, {
    seed: intFlag(args, "seed", 42),
    months: intFlag(args, "months", 18),
    anchorDate: anchor,
    overwrite: boolFlag(args, "force"),
  });

  if (boolFlag(args, "json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  const c = summary.counts;
  process.stdout.write(
    [
      `Wrote ${summary.path}`,
      `  seed ${summary.seed}, ${summary.months} months ending ${summary.anchorDate}`,
      `  ${c.accounts} accounts, ${c.categories} categories, ${c.payees} payees`,
      `  ${c.transactionsTotal} transactions (${c.transactionsLive} live)`,
      "",
      "  Planted on purpose, so a naive query gets these wrong:",
      `    ${c.softDeleted} soft-deleted, ${c.voided} void, ${c.duplicates} duplicate`,
      `    ${c.transfersSameCurrency} same-currency and ${c.transfersCrossCurrency} cross-currency transfers`,
      `    ${c.splitParents} split parents across ${c.splitRows} split rows`,
      "",
      "  Try it:",
      `    npx mmex-mcp --db ${summary.path}`,
      "",
    ].join("\n"),
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`mmex-fixture: ${(error as Error).message}\n`);
  process.exit(1);
}
