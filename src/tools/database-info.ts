/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/
import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { liveRows } from "../semantics/rules.js";
import type { ServerContext } from "../server/context.js";

const outputSchema = {
  database: z.object({
    databaseName: z
      .string()
      .describe("File name of the database. The full path is deliberately not exposed."),
    usingSnapshot: z.boolean().describe("Whether a temporary copy is being read instead of the live file."),
    schemaVersion: z.string().nullable().describe("MMEX DataVersion from INFOTABLE_V1."),
    schemaVerified: z
      .boolean()
      .describe("Whether these semantics were verified against this schema version."),
    schemaWarning: z
      .string()
      .nullable()
      .describe(
        "Set when the schema version is unknown or newer than what was verified. Report it to the user.",
      ),
    baseCurrency: z.string().nullable().describe("Symbol of the base currency all totals convert to."),
  }),
  safety: z.object({
    readOnly: z.boolean().describe("True only if a real write attempt was refused by SQLite."),
    writeRejectedWith: z.string().nullable().describe("The SQLite error code that refused a write probe."),
    queryOnly: z.boolean().describe("Whether PRAGMA query_only is set."),
    redacting: z.boolean().describe("Whether names are replaced with placeholders in output."),
    networkAccess: z.literal(false).describe("This server opens no sockets."),
  }),
  contents: z.object({
    accounts: z.number().int(),
    liveTransactions: z
      .number()
      .int()
      .describe(
        "Count of rows after excluding void and soft-deleted. Row count only: a raw " +
          "SQL query that matches this number is still wrong, because the count says " +
          "nothing about split attribution, transfer handling, or currency conversion.",
      ),
    excludedTransactions: z
      .number()
      .int()
      .describe(
        "Void or soft-deleted. Duplicate ('D') rows are NOT excluded, matching the MMEX desktop app.",
      ),
    earliestDate: z.string().nullable(),
    latestDate: z.string().nullable(),
    currencies: z.array(z.string()),
  }),
};

export function registerDatabaseInfo(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "mmex_database_info",
    {
      title: "Database info",
      description:
        "Describe the connected Money Manager EX database: schema version, base currency, " +
        "date range, account and transaction counts, and the server's safety posture. " +
        "Call this first to learn what data is available and over what period. " +
        "Use the other mmex tools for figures; do not query the database file directly, " +
        "because raw SQL over this schema returns plausible but wrong numbers.",
      inputSchema: {},
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => {
      const { db, redact } = context;
      const proof = db.verifyReadOnly();

      const accounts = db.queryOne<{ n: number }>("SELECT COUNT(*) n FROM ACCOUNTLIST_V1");
      const live = db.queryOne<{ n: number; lo: string | null; hi: string | null }>(
        `SELECT COUNT(*) n, MIN(TRANSDATE) lo, MAX(TRANSDATE) hi FROM CHECKINGACCOUNT_V1
         WHERE ${liveRows("CHECKINGACCOUNT_V1")}`,
      );
      const excluded = db.queryOne<{ n: number }>(
        `SELECT COUNT(*) n FROM CHECKINGACCOUNT_V1
         WHERE NOT (${liveRows("CHECKINGACCOUNT_V1")})`,
      );
      const currencies = db.query<{ CURRENCY_SYMBOL: string }>(
        "SELECT CURRENCY_SYMBOL FROM CURRENCYFORMATS_V1 ORDER BY CURRENCYID",
      );

      const baseId = db.info.get("basecurrencyid");
      const base = baseId
        ? db.queryOne<{ CURRENCY_SYMBOL: string }>(
            "SELECT CURRENCY_SYMBOL FROM CURRENCYFORMATS_V1 WHERE CURRENCYID = ?",
            [Number(baseId)],
          )
        : undefined;

      const structuredContent = {
        database: {
          // Deliberately the basename only. A Bash-capable client handed an
          // absolute path can run sqlite3 against the database directly, which
          // bypasses every semantic rule in this server and produces confidently
          // wrong numbers. Nothing here needs the path.
          databaseName: basename(db.openedPath),
          usingSnapshot: db.openedPath !== db.sourcePath,
          schemaVersion: db.schema.version,
          schemaVerified: db.schema.verified,
          schemaWarning: db.schema.warning,
          baseCurrency: base?.CURRENCY_SYMBOL ?? null,
        },
        safety: {
          readOnly: proof.writeRejectedWith !== null,
          writeRejectedWith: proof.writeRejectedWith,
          queryOnly: proof.queryOnly,
          redacting: redact,
          networkAccess: false as const,
        },
        contents: {
          accounts: accounts?.n ?? 0,
          liveTransactions: live?.n ?? 0,
          excludedTransactions: excluded?.n ?? 0,
          earliestDate: live?.lo ?? null,
          latestDate: live?.hi ?? null,
          currencies: currencies.map((c) => c.CURRENCY_SYMBOL),
        },
      };

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${structuredContent.contents.accounts} accounts, ` +
              `${structuredContent.contents.liveTransactions} transactions ` +
              `(${structuredContent.contents.earliestDate ?? "?"} to ${structuredContent.contents.latestDate ?? "?"}), ` +
              `base ${structuredContent.database.baseCurrency ?? "?"}, read-only: ${structuredContent.safety.readOnly}`,
          },
        ],
        structuredContent,
      };
    },
  );
}
