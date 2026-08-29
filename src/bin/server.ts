#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { boolFlag, parseArgs, stringFlag } from "../cli/args.js";
import { ConfigError, loadConfig, requireDatabasePath } from "../config/config.js";
import { MmexDatabaseError, openReadOnly } from "../db/connection.js";
import { buildServer, SERVER_VERSION } from "../server/server.js";

const USAGE = `mmex-mcp ${SERVER_VERSION}: read-only MCP server for Money Manager EX

Usage:
  mmex-mcp [--db <file.mmb>] [--config <file>] [--snapshot] [--redact]

Options:
  --db <file>      Path to the MMEX database.
  --config <file>  Config file. Defaults to ./mmex-mcp.config.json, then
                   ~/.config/mmex-mcp/config.json.
  --snapshot       Read a temporary copy instead of the live file. Use this if
                   Money Manager EX is running and holding the database.
  --redact         Replace payee, account, and category names with stable
                   placeholders in all output. Amounts are unchanged.
  --version        Print the version
  --help           Show this message

Settings resolve in this order: flags, then environment
(MMEX_MCP_DB, MMEX_MCP_SNAPSHOT, MMEX_MCP_REDACT), then the config file,
then defaults.

Register with Claude Code:
  claude mcp add mmex -- npx -y mmex-mcp --db ~/finances.mmb

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

  const { config } = loadConfig({
    ...optional("configPath", stringFlag(args, "config")),
    ...optional("databasePath", stringFlag(args, "db")),
    ...(boolFlag(args, "snapshot") ? { snapshot: true } : {}),
    ...(boolFlag(args, "redact") ? { redact: true } : {}),
  });

  const db = openReadOnly(requireDatabasePath(config), { snapshot: config.database.snapshot });
  const { server } = buildServer({ db, redact: config.database.redact });

  const shutdown = (): void => {
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // stdout is the MCP transport. Nothing may write to it but the protocol.
  await server.connect(new StdioServerTransport());
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

main().catch((error: unknown) => {
  const message =
    error instanceof MmexDatabaseError || error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`mmex-mcp: ${message}\n`);
  process.exit(1);
});
