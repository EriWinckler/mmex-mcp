#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { boolFlag, parseArgs, stringFlag } from "../cli/args.js";
import { MmexDatabaseError, openReadOnly } from "../db/connection.js";
import { buildServer, SERVER_VERSION } from "../server/server.js";

const USAGE = `mmex-mcp ${SERVER_VERSION}: read-only MCP server for Money Manager EX

Usage:
  mmex-mcp --db <file.mmb> [--snapshot] [--redact]

Options:
  --db <file>   Path to the MMEX database. Required.
  --snapshot    Read a temporary copy instead of the live file. Use this if
                Money Manager EX is running and holding the database.
  --redact      Replace payee, account, and category names with stable
                placeholders in all output. Amounts are unchanged. For demos,
                screenshots, and bug reports.
  --version     Print the version
  --help        Show this message

This server never writes to your database and never opens a network socket.
Both are enforced in code and asserted by tests; mmex_database_info reports
the live posture.

No database yet? Generate one:
  npx mmex-fixture --out demo.mmb
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (boolFlag(args, "help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (boolFlag(args, "version")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const dbPath = stringFlag(args, "db");
  if (dbPath === undefined) {
    process.stderr.write("mmex-mcp: --db is required\n\n");
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const db = openReadOnly(dbPath, { snapshot: boolFlag(args, "snapshot") });
  const { server } = buildServer({ db, redact: boolFlag(args, "redact") });

  const shutdown = (): void => {
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // stdout is the MCP transport. Nothing may write to it but the protocol.
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof MmexDatabaseError ? error.message : String(error);
  process.stderr.write(`mmex-mcp: ${message}\n`);
  process.exit(1);
});
