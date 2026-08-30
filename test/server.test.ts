/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MmexDatabase, openReadOnly } from "../src/db/connection.js";
import { generateFixture } from "../src/fixture/generate.js";
import { buildServer } from "../src/server/server.js";

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmex-server-"));
  dbPath = join(dir, "demo.mmb");
  generateFixture(dbPath, { seed: 42 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Wire a real Client to a real server over an in-memory transport pair. */
async function connect(redact = false): Promise<{ client: Client; db: MmexDatabase }> {
  const db = openReadOnly(dbPath);
  const { server } = buildServer({ db, redact });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, db };
}

describe("MCP protocol surface", () => {
  it("lists its tools", async () => {
    const { client, db } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("mmex_database_info");
    await client.close();
    db.close();
  });

  it("marks every tool as read-only and closed-world", async () => {
    const { client, db } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
    }
    await client.close();
    db.close();
  });

  it("declares an output schema on every tool, so results are structured", async () => {
    const { client, db } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
    await client.close();
    db.close();
  });
});

describe("mmex_database_info", () => {
  it("reports a proven read-only posture, not a claimed one", async () => {
    const { client, db } = await connect();
    const result = await client.callTool({ name: "mmex_database_info", arguments: {} });
    const safety = (result.structuredContent as { safety: Record<string, unknown> }).safety;
    expect(safety.readOnly).toBe(true);
    expect(safety.writeRejectedWith).toBe("SQLITE_READONLY");
    expect(safety.queryOnly).toBe(true);
    expect(safety.networkAccess).toBe(false);
    await client.close();
    db.close();
  });

  it("describes the fixture's real contents", async () => {
    const { client, db } = await connect();
    const result = await client.callTool({ name: "mmex_database_info", arguments: {} });
    const structured = result.structuredContent as {
      database: { schemaVersion: string; baseCurrency: string; databaseName: string };
      contents: {
        accounts: number;
        liveTransactions: number;
        excludedTransactions: number;
        currencies: string[];
      };
    };
    expect(structured.database.schemaVersion).toBe("19");
    expect(structured.database.baseCurrency).toBe("USD");
    expect(structured.contents.accounts).toBe(4);
    expect(structured.contents.currencies).toEqual(["USD", "EUR", "JPY"]);
    // Soft-deleted, void and duplicate rows are counted separately, never silently.
    expect(structured.contents.excludedTransactions).toBeGreaterThan(0);
    expect(structured.contents.liveTransactions).toBeGreaterThan(0);
    await client.close();
    db.close();
  });

  it("never emits an absolute path, redacted or not", async () => {
    // A Bash-capable client handed the absolute path can run sqlite3 against
    // the database directly, bypassing every semantic rule here and producing
    // confidently wrong numbers. The path is not needed to answer any question,
    // so it is never exposed.
    for (const redact of [false, true]) {
      const { client, db } = await connect(redact);
      const result = await client.callTool({ name: "mmex_database_info", arguments: {} });
      const database = (
        result.structuredContent as {
          database: { databaseName: string; usingSnapshot: boolean };
        }
      ).database;

      expect(database.databaseName, `redact=${redact}`).toBe("demo.mmb");
      expect(database.databaseName).not.toContain("/");
      expect(database.databaseName).not.toContain("\\");
      expect(database.usingSnapshot).toBe(false);

      // Belt and braces: no field anywhere in the payload looks like a path.
      const serialized = JSON.stringify(result.structuredContent);
      expect(serialized, `redact=${redact}`).not.toContain(dbPath);
      expect(serialized).not.toMatch(/\/(home|Users|tmp)\//);

      await client.close();
      db.close();
    }
  });

  it("reports schema compatibility rather than silently trusting the database", async () => {
    const { client, db } = await connect();
    const result = await client.callTool({ name: "mmex_database_info", arguments: {} });
    const database = (
      result.structuredContent as {
        database: { schemaVersion: string; schemaVerified: boolean; schemaWarning: string | null };
      }
    ).database;
    expect(database.schemaVersion).toBe("19");
    expect(database.schemaVerified).toBe(true);
    expect(database.schemaWarning).toBeNull();
    await client.close();
    db.close();
  });

  it("reports when redaction is active", async () => {
    const { client, db } = await connect(true);
    const result = await client.callTool({ name: "mmex_database_info", arguments: {} });
    const safety = (result.structuredContent as { safety: { redacting: boolean } }).safety;
    expect(safety.redacting).toBe(true);
    await client.close();
    db.close();
  });
});

/**
 * Contract enforcement across the whole tool registry.
 *
 * These exist because income_vs_expense shipped an unbounded array and nothing
 * caught it: annotations and outputSchema were asserted, but the envelope that
 * makes a result honest was not. A test that walks every registered tool is the
 * only thing that stops tool number seven repeating it.
 */
describe("every tool obeys the result contract", () => {
  type JsonSchema = {
    properties?: Record<string, { type?: string; items?: unknown; properties?: Record<string, unknown> }>;
  };

  async function schemas(): Promise<{ name: string; schema: JsonSchema }[]> {
    const { client, db } = await connect();
    const { tools } = await client.listTools();
    await client.close();
    db.close();
    return tools.map((t) => ({ name: t.name, schema: (t.outputSchema ?? {}) as JsonSchema }));
  }

  it("puts every array behind a page or coverage envelope", async () => {
    for (const { name, schema } of await schemas()) {
      const props = schema.properties ?? {};
      const arrays = Object.entries(props).filter(([, v]) => v.type === "array");
      if (arrays.length === 0) continue;
      const enveloped = "page" in props || "coverage" in props;
      expect(enveloped, `${name} returns ${arrays.map(([k]) => k).join(", ")} with no page/coverage`).toBe(
        true,
      );
    }
  });

  it("declares a basis on every tool that reports figures", async () => {
    for (const { name, schema } of await schemas()) {
      if (name === "mmex_database_info" || name === "mmex_categories") continue;
      expect(Object.keys(schema.properties ?? {}), `${name} has no basis`).toContain("basis");
    }
  });

  it("never sends money as a bare number", async () => {
    // A plain float would undo the whole minor-units design at the last step.
    const moneyish = /amount|total|balance|income|expense|net|worth/i;
    for (const { name, schema } of await schemas()) {
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        if (!moneyish.test(key)) continue;
        expect(value.type, `${name}.${key} is a bare ${value.type}`).not.toBe("number");
      }
    }
  });

  it("returns a short text summary, not the payload restringified", async () => {
    const { client, db } = await connect();
    const calls: [string, Record<string, unknown>][] = [
      ["mmex_database_info", {}],
      ["mmex_spending_by_category", {}],
      ["mmex_account_balances", {}],
      ["mmex_income_vs_expense", {}],
      ["mmex_transactions", { limit: 5 }],
      ["mmex_categories", {}],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      const structured = JSON.stringify(result.structuredContent);
      expect(text.length, `${name} summary is empty`).toBeGreaterThan(0);
      // Restringifying the payload roughly doubled every response for no
      // added information.
      expect(text.length, `${name} text block is as large as the payload`).toBeLessThan(
        structured.length / 2,
      );
      expect(text, `${name} summary should not be raw JSON`).not.toMatch(/^\s*[{[]/);
    }
    await client.close();
    db.close();
  });
});
