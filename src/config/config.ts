import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/**
 * Configuration for the server and the eval harness.
 *
 * Resolution order, highest priority first:
 *   1. command line flags
 *   2. environment variables (MMEX_MCP_*)
 *   3. a config file
 *   4. built-in defaults
 *
 * A config file is looked for at --config, then ./mmex-mcp.config.json, then
 * $XDG_CONFIG_HOME/mmex-mcp/config.json, then ~/.config/mmex-mcp/config.json.
 *
 * An API key is NEVER read from, or written to, the config file. The file
 * holds only the NAME of an environment variable to read it from. A config
 * file gets committed, pasted into issues, and synced between machines; a key
 * in it is a key leaked. This is enforced by rejecting an `apiKey` field
 * outright rather than ignoring it, so the mistake is loud.
 */

const claudeCodeSchema = z
  .object({
    binary: z.string().default("claude"),
    extraArgs: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().default(180_000),
  })
  .prefault({});

const anthropicSchema = z
  .object({
    apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
    baseUrl: z.string().url().optional(),
    maxTokens: z.number().int().positive().default(2048),
  })
  .prefault({});

const llmSchema = z
  .object({
    /**
     * How the eval harness talks to a model.
     *
     * "claude-code" shells out to the Claude Code CLI in headless mode, which
     * needs no API key and reuses whatever access is already set up on the
     * machine. That is the default because it is the only option that costs
     * the user nothing extra to run.
     *
     * "anthropic" calls the Messages API directly, reading the key from the
     * environment variable named by anthropic.apiKeyEnv.
     */
    provider: z.enum(["claude-code", "anthropic"]).default("claude-code"),
    model: z.string().optional(),
    claudeCode: claudeCodeSchema,
    anthropic: anthropicSchema,
  })
  .prefault({});

const databaseSchema = z
  .object({
    path: z.string().optional(),
    snapshot: z.boolean().default(false),
    redact: z.boolean().default(false),
  })
  .prefault({});

const configFileSchema = z
  .object({
    database: databaseSchema,
    llm: llmSchema,
  })
  .strict();

export type MmexConfig = z.infer<typeof configFileSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Expand a leading ~ so config files can use it, as everyone expects. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function configSearchPaths(explicit?: string): string[] {
  if (explicit !== undefined) return [resolve(expandHome(explicit))];
  const xdg = process.env.XDG_CONFIG_HOME;
  return [
    resolve("mmex-mcp.config.json"),
    ...(xdg ? [join(xdg, "mmex-mcp", "config.json")] : []),
    join(homedir(), ".config", "mmex-mcp", "config.json"),
  ];
}

function readConfigFile(explicit?: string): { data: unknown; path: string | null } {
  for (const candidate of configSearchPaths(explicit)) {
    if (!existsSync(candidate)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(candidate, "utf8"));
    } catch (error) {
      throw new ConfigError(`Config file ${candidate} is not valid JSON: ${(error as Error).message}`);
    }
    return { data: parsed, path: candidate };
  }
  if (explicit !== undefined) {
    throw new ConfigError(`No config file at ${resolve(expandHome(explicit))}`);
  }
  return { data: {}, path: null };
}

/** Refuse a key in the file loudly, rather than quietly ignoring it. */
function rejectInlineSecrets(data: unknown, path: string | null): void {
  const where = path ?? "the config";
  const llm = (data as { llm?: Record<string, unknown> } | undefined)?.llm;
  if (llm === undefined) return;
  const anthropic = llm.anthropic as Record<string, unknown> | undefined;
  for (const [container, obj] of [
    ["llm", llm],
    ["llm.anthropic", anthropic],
  ] as const) {
    if (obj === undefined) continue;
    for (const field of ["apiKey", "api_key", "key", "token", "secret"]) {
      if (field in obj) {
        throw new ConfigError(
          `${where} sets ${container}.${field}. API keys must never be stored in a config file.\n` +
            `  Set llm.anthropic.apiKeyEnv to the NAME of an environment variable instead, ` +
            `and export the key there.`,
        );
      }
    }
  }
}

export interface ConfigOverrides {
  readonly configPath?: string;
  readonly databasePath?: string;
  readonly snapshot?: boolean;
  readonly redact?: boolean;
  readonly provider?: string;
  readonly model?: string;
}

export interface LoadedConfig {
  readonly config: MmexConfig;
  /** Which file it came from, or null when only defaults and env were used. */
  readonly sourcePath: string | null;
}

export function loadConfig(overrides: ConfigOverrides = {}): LoadedConfig {
  const { data, path } = readConfigFile(overrides.configPath);
  rejectInlineSecrets(data, path);

  let parsed: MmexConfig;
  try {
    parsed = configFileSchema.parse(data);
  } catch (error) {
    const issues =
      error instanceof z.ZodError
        ? error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")
        : String(error);
    throw new ConfigError(`Invalid config${path ? ` in ${path}` : ""}:\n${issues}`);
  }

  const env = process.env;
  const databasePath = overrides.databasePath ?? env.MMEX_MCP_DB ?? parsed.database.path;

  const config: MmexConfig = {
    database: {
      ...(databasePath !== undefined ? { path: expandHome(databasePath) } : {}),
      snapshot: overrides.snapshot ?? envBool(env.MMEX_MCP_SNAPSHOT) ?? parsed.database.snapshot,
      redact: overrides.redact ?? envBool(env.MMEX_MCP_REDACT) ?? parsed.database.redact,
    },
    llm: {
      provider: parseProvider(overrides.provider ?? env.MMEX_MCP_LLM_PROVIDER) ?? parsed.llm.provider,
      ...pickModel(overrides.model ?? env.MMEX_MCP_LLM_MODEL ?? parsed.llm.model),
      claudeCode: {
        ...parsed.llm.claudeCode,
        binary: env.MMEX_MCP_CLAUDE_BIN ?? parsed.llm.claudeCode.binary,
      },
      anthropic: {
        ...parsed.llm.anthropic,
        apiKeyEnv: env.MMEX_MCP_ANTHROPIC_KEY_ENV ?? parsed.llm.anthropic.apiKeyEnv,
      },
    },
  };

  return { config, sourcePath: path };
}

function pickModel(model: string | undefined): { model?: string } {
  return model !== undefined ? { model } : {};
}

function parseProvider(value: string | undefined): "claude-code" | "anthropic" | undefined {
  if (value === undefined) return undefined;
  if (value === "claude-code" || value === "anthropic") return value;
  throw new ConfigError(`Unknown LLM provider "${value}". Expected "claude-code" or "anthropic".`);
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/** Absolute path to the database, or a clear error explaining every way to set it. */
export function requireDatabasePath(config: MmexConfig): string {
  const path = config.database.path;
  if (path === undefined || path === "") {
    throw new ConfigError(
      "No database path configured. Set it in any one of these:\n" +
        "  --db /path/to/finances.mmb\n" +
        "  MMEX_MCP_DB=/path/to/finances.mmb\n" +
        '  a config file with { "database": { "path": "~/finances.mmb" } }\n' +
        "\nNo database yet? Generate one: npx mmex-fixture --out demo.mmb",
    );
  }
  return isAbsolute(path) ? path : resolve(path);
}
