import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MmexDatabase } from "../db/connection.js";
import { CategoryTree } from "../semantics/categories.js";
import { CurrencyResolver } from "../semantics/currency.js";
import { registerAnalyticsTools } from "../tools/analytics-tools.js";
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
  const context: ServerContext = {
    db: options.db,
    resolver: new CurrencyResolver(options.db),
    tree: new CategoryTree(options.db),
    redact: options.redact ?? false,
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to a Money Manager EX database.\n\n" +
        "Answer money questions with these tools only. Do NOT query the .mmb file " +
        "directly with sqlite3, Bash, or any other client, and do not ask the user " +
        "for its path. Raw SQL over this schema produces confidently wrong numbers: " +
        "a transfer between the user's own accounts looks like an expense, split " +
        "transactions carry their category on a separate table so they get misfiled " +
        "or dropped, deleted rows are still present, amounts are floats that do not " +
        "sum exactly, and foreign-currency rows need the exchange rate as of each " +
        "transaction's own date. These tools already handle all of that.\n\n" +
        "Call mmex_database_info first to see what period the data covers. If it " +
        "returns a schemaWarning, tell the user before giving them figures.\n\n" +
        "Amounts are returned as exact decimal strings in the base currency. Report " +
        "them as given rather than reformatting or re-deriving them.",
    },
  );

  registerDatabaseInfo(server, context);
  registerAnalyticsTools(server, context);

  return { server, context };
}
