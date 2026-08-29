/**
 * Diagnostics.
 *
 * Everything goes to stderr, always. stdout is the MCP transport, and a single
 * stray byte there corrupts the JSON-RPC stream and breaks the session. That is
 * the entire reason this module exists rather than calling console.log.
 *
 * Off by default: an MCP server's stderr usually lands in a client log the user
 * never opens, and financial data must not accumulate there. Turn it on with
 * MMEX_MCP_LOG=debug when diagnosing something.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function configuredLevel(): LogLevel {
  const raw = (process.env.MMEX_MCP_LOG ?? "error").trim().toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : "error";
}

let level: LogLevel = configuredLevel();

/** For tests, and for a future --log flag. */
export function setLogLevel(next: LogLevel): void {
  level = next;
}

function emit(at: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (ORDER[at] > ORDER[level]) return;
  const suffix = context === undefined ? "" : ` ${JSON.stringify(context)}`;
  process.stderr.write(`[mmex-mcp] ${at}: ${message}${suffix}\n`);
}

/**
 * Never pass amounts, payee names, account names, notes, or a full row here.
 * Counts, durations, error classes, and decision branches only. A log line is
 * the easiest place for financial data to escape to somewhere nobody is
 * watching.
 */
export const log = {
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
};
