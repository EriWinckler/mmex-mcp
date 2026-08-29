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
