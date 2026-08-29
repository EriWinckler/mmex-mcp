import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MmexDatabase } from "../db/connection.js";
import { registerDatabaseInfo } from "../tools/database-info.js";
import type { ServerContext } from "./context.js";

export const SERVER_NAME = "mmex-mcp";
export const SERVER_VERSION = "0.1.0";

export interface BuildOptions {
  readonly db: MmexDatabase;
  readonly redact?: boolean;
}

/**
 * Build the MCP server and register every tool.
 *
 * Split from the bin entry so tests can drive a fully wired server in
 * process, over an in-memory transport, without spawning a subprocess.
 */
export function buildServer(options: BuildOptions): { server: McpServer; context: ServerContext } {
  const context: ServerContext = { db: options.db, redact: options.redact ?? false };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to a Money Manager EX database. Tools return aggregates, " +
        "not raw transaction rows, and already account for MMEX's semantics: transfers " +
        "between your own accounts are not income or expense, split transactions are " +
        "attributed to their split categories, soft-deleted and void rows are excluded, " +
        "and amounts are converted to the base currency at each transaction's own date. " +
        "Call mmex_database_info first to see what period the data covers.",
    },
  );

  registerDatabaseInfo(server, context);

  return { server, context };
}
