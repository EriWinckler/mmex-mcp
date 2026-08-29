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
        "Answer money questions with these tools only. Never query the .mmb file directly with " +
        "sqlite3, a SQLite library, or a shell, and do not compute figures yourself from raw rows. " +
        "Five traps in this schema each silently corrupt a hand-written query: transfers between " +
        "the user's own accounts are a single row and are neither income nor expense; split " +
        "transactions carry their category on child rows, not the parent; deleted rows are " +
        "soft-deleted and still present; categories form a tree rooted at PARENTID = -1, so totals " +
        "do not roll up on their own; and amounts are floats, so sums drift. The result looks right " +
        "and is wrong by a plausible amount. These tools handle all five.\n\n" +
        "Amounts come back as an exact decimal string in `text` plus integer minor units in " +
        "`minor`. Quote `text` verbatim and do arithmetic on `minor`. Do not reformat or re-derive " +
        "a figure.\n\n" +
        "When a result carries `coverage`, its `total` is over every group including those below " +
        "the cap. Do not add up the returned rows to get a total; that figure is short by " +
        "`coverage.other.amount`.\n\n" +
        "Call mmex_database_info first to see what period the data covers. If it returns a " +
        "schemaWarning, tell the user before quoting any figure.",
    },
  );

  registerDatabaseInfo(server, context);
  registerAnalyticsTools(server, context);

  return { server, context };
}
