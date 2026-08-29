import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, expandHome, loadConfig, requireDatabasePath } from "../src/config/config.js";

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "MMEX_MCP_DB",
  "MMEX_MCP_SNAPSHOT",
  "MMEX_MCP_REDACT",
  "MMEX_MCP_LLM_PROVIDER",
  "MMEX_MCP_LLM_MODEL",
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mmex-cfg-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function writeConfig(contents: unknown): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("defaults", () => {
  it("defaults the LLM provider to claude-code, which needs no API key", () => {
    const { config } = loadConfig({ configPath: writeConfig({}) });
    expect(config.llm.provider).toBe("claude-code");
    expect(config.llm.claudeCode.binary).toBe("claude");
    expect(config.llm.anthropic.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
  });

  it("defaults snapshot and redact off", () => {
    const { config } = loadConfig({ configPath: writeConfig({}) });
    expect(config.database.snapshot).toBe(false);
    expect(config.database.redact).toBe(false);
  });
});

describe("precedence: flags beat env beats file", () => {
  it("lets a flag win over the environment and the file", () => {
    process.env.MMEX_MCP_DB = "/from/env.mmb";
    const path = writeConfig({ database: { path: "/from/file.mmb" } });
    const { config } = loadConfig({ configPath: path, databasePath: "/from/flag.mmb" });
    expect(config.database.path).toBe("/from/flag.mmb");
  });

  it("lets the environment win over the file", () => {
    process.env.MMEX_MCP_DB = "/from/env.mmb";
    const path = writeConfig({ database: { path: "/from/file.mmb" } });
    expect(loadConfig({ configPath: path }).config.database.path).toBe("/from/env.mmb");
  });

  it("falls back to the file", () => {
    const path = writeConfig({ database: { path: "/from/file.mmb" } });
    expect(loadConfig({ configPath: path }).config.database.path).toBe("/from/file.mmb");
  });

  it("reads booleans from the environment in the usual spellings", () => {
    const path = writeConfig({});
    for (const truthy of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.MMEX_MCP_REDACT = truthy;
      expect(loadConfig({ configPath: path }).config.database.redact, truthy).toBe(true);
    }
    process.env.MMEX_MCP_REDACT = "0";
    expect(loadConfig({ configPath: path }).config.database.redact).toBe(false);
  });
});

describe("secrets are never accepted from the config file", () => {
  it.each(["apiKey", "api_key", "key", "token", "secret"])(
    "rejects llm.anthropic.%s loudly rather than ignoring it",
    (field) => {
      const path = writeConfig({ llm: { anthropic: { [field]: "sk-ant-nope" } } });
      expect(() => loadConfig({ configPath: path })).toThrow(ConfigError);
      expect(() => loadConfig({ configPath: path })).toThrow(/never be stored in a config file/);
    },
  );

  it("rejects a key at the llm level too", () => {
    const path = writeConfig({ llm: { apiKey: "sk-ant-nope" } });
    expect(() => loadConfig({ configPath: path })).toThrow(/never be stored in a config file/);
  });

  it("accepts the environment variable NAME, which is the supported way", () => {
    const path = writeConfig({ llm: { anthropic: { apiKeyEnv: "MY_KEY_VAR" } } });
    expect(loadConfig({ configPath: path }).config.llm.anthropic.apiKeyEnv).toBe("MY_KEY_VAR");
  });
});

describe("errors are actionable", () => {
  it("lists every way to set the database path when none is set", () => {
    const { config } = loadConfig({ configPath: writeConfig({}) });
    expect(() => requireDatabasePath(config)).toThrow(/--db/);
    expect(() => requireDatabasePath(config)).toThrow(/MMEX_MCP_DB/);
    expect(() => requireDatabasePath(config)).toThrow(/mmex-fixture/);
  });

  it("names the file when the JSON is malformed", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json");
    expect(() => loadConfig({ configPath: path })).toThrow(/is not valid JSON/);
  });

  it("rejects an unknown provider by name", () => {
    expect(() => loadConfig({ configPath: writeConfig({}), provider: "gpt" })).toThrow(
      /Unknown LLM provider "gpt"/,
    );
  });

  it("rejects unknown top-level keys instead of silently ignoring a typo", () => {
    const path = writeConfig({ databse: { path: "/typo.mmb" } });
    expect(() => loadConfig({ configPath: path })).toThrow(ConfigError);
  });

  it("reports a missing explicit config file rather than falling back", () => {
    expect(() => loadConfig({ configPath: join(dir, "absent.json") })).toThrow(/No config file at/);
  });
});

describe("expandHome", () => {
  it("expands a leading tilde", () => {
    expect(expandHome("~/finances.mmb").startsWith("~")).toBe(false);
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
    expect(expandHome("relative/path")).toBe("relative/path");
  });
});
