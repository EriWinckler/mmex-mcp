/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/
import { spawn } from "node:child_process";
import type { MmexConfig } from "../config/config.js";

/**
 * How the eval harness talks to a model.
 *
 * Two providers, and the choice is mostly about cost and setup:
 *
 *   claude-code  Shells out to the Claude Code CLI in headless mode. Needs no
 *                API key and reuses whatever access is already on the machine,
 *                which is why it is the default. It is NOT cheap: every
 *                invocation is a fresh session that pays full cache-creation
 *                cost for Claude Code's system prompt. Measured on this
 *                machine, one trivial question cost $0.52 on Opus (52,309
 *                cache-creation tokens) and $0.05 on Haiku (33,488). Budget
 *                accordingly before running 80 of them.
 *
 *   anthropic    Calls the Messages API directly with only our own system
 *                prompt, so there is no multi-thousand-token preamble to pay
 *                for. Materially cheaper per question, but needs a key.
 *
 * The key is read from the environment variable NAMED in config. It is never
 * read from, or written to, a config file.
 */

export interface AskOptions {
  readonly question: string;
  readonly systemPrompt?: string;
  /** MCP servers to expose. Omit for the raw-SQL arm, which gets no tools. */
  readonly mcpServers?: Record<string, unknown>;
  /** Tool name prefixes the model may call, e.g. ["mcp__mmex"]. */
  readonly allowedTools?: readonly string[];
}

export interface AskResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  /** Reported by the provider when it knows, else null. */
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly turns: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  ask(options: AskOptions): Promise<AskResult>;
}

export class ProviderError extends Error {
  override readonly name = "ProviderError";
}

/**
 * Claude Code CLI, headless.
 *
 * Three things here are not obvious and each one breaks a naive
 * implementation. They were found by running the real command, not by reading
 * the help text.
 *
 * 1. stdin must be closed. Without it the CLI waits three seconds per call for
 *    input that is never coming, then prints a warning.
 * 2. stderr must be kept separate from stdout. User-configured hooks (SessionEnd
 *    and friends) write to the streams, so folding them together corrupts the
 *    JSON.
 * 3. stdout is not one JSON document. Scan lines for the object whose `type`
 *    is "result"; warnings and hook output share the stream.
 */
export class ClaudeCodeProvider implements LlmProvider {
  readonly name = "claude-code";
  constructor(
    readonly model: string,
    private readonly binary: string,
    private readonly timeoutMs: number,
    private readonly extraArgs: readonly string[] = [],
  ) {}

  async ask(options: AskOptions): Promise<AskResult> {
    const args = ["-p", options.question, "--output-format", "json", "--model", this.model];

    if (options.systemPrompt !== undefined) {
      args.push("--append-system-prompt", options.systemPrompt);
    }
    if (options.mcpServers !== undefined) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: options.mcpServers }));
    }
    if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
      args.push("--allowedTools", options.allowedTools.join(","));
    }
    args.push(...this.extraArgs);

    const started = Date.now();
    const stdout = await this.run(args);
    const durationMs = Date.now() - started;

    const envelope = findResultEnvelope(stdout);
    if (envelope === undefined) {
      throw new ProviderError(
        `Claude Code produced no result envelope. First 400 characters of stdout:\n${stdout.slice(0, 400)}`,
      );
    }
    if (envelope.is_error === true) {
      throw new ProviderError(`Claude Code reported an error: ${String(envelope.result ?? "unknown")}`);
    }

    const usage = (envelope.usage ?? {}) as Record<string, number>;
    return {
      text: String(envelope.result ?? ""),
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
      durationMs,
      turns: typeof envelope.num_turns === "number" ? envelope.num_turns : 1,
    };
  }

  private run(args: readonly string[]): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.binary, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new ProviderError(`Claude Code timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        rejectPromise(
          new ProviderError(
            `Could not run "${this.binary}": ${error.message}\n` +
              "  Is Claude Code installed and on PATH? Set llm.claudeCode.binary to its full path.",
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && findResultEnvelope(stdout) === undefined) {
          rejectPromise(new ProviderError(`Claude Code exited ${code}. stderr:\n${stderr.slice(0, 400)}`));
          return;
        }
        resolvePromise(stdout);
      });
    });
  }
}

/** Scan for the result object. Hooks and warnings share stdout. Exported for testing. */
export function findResultEnvelope(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "result") return parsed;
    } catch {
      // Not JSON, or a partial line. Keep scanning.
    }
  }
  return undefined;
}

/**
 * Anthropic Messages API.
 *
 * This is the only place in the project that opens a network socket, and it
 * lives in the eval harness rather than the server. The MCP server itself
 * reaches no network at all, which is asserted separately.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly maxTokens: number,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  async ask(options: AskOptions): Promise<AskResult> {
    if (options.mcpServers !== undefined) {
      throw new ProviderError(
        "The anthropic provider cannot expose MCP tools to the model. " +
          "Use the claude-code provider for the tool-using arm of the eval.",
      );
    }

    const started = Date.now();
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
        messages: [{ role: "user", content: options.question }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      // Never echo the key, even if the API reflects part of the request back.
      throw new ProviderError(`Anthropic API returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    return {
      text: (json.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(""),
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: null,
      durationMs: Date.now() - started,
      turns: 1,
    };
  }
}

const DEFAULT_MODELS = {
  "claude-code": "haiku",
  anthropic: "claude-haiku-4-5-20251001",
} as const;

export function createProvider(config: MmexConfig): LlmProvider {
  const { llm } = config;
  const model = llm.model ?? DEFAULT_MODELS[llm.provider];

  if (llm.provider === "claude-code") {
    return new ClaudeCodeProvider(
      model,
      llm.claudeCode.binary,
      llm.claudeCode.timeoutMs,
      llm.claudeCode.extraArgs,
    );
  }

  const apiKey = process.env[llm.anthropic.apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    throw new ProviderError(
      `The anthropic provider needs an API key, and ${llm.anthropic.apiKeyEnv} is not set.\n` +
        `  export ${llm.anthropic.apiKeyEnv}=sk-ant-...\n` +
        "  Or switch to the claude-code provider, which needs no key:\n" +
        '    { "llm": { "provider": "claude-code" } }',
    );
  }
  return new AnthropicProvider(model, apiKey, llm.anthropic.maxTokens, llm.anthropic.baseUrl ?? undefined);
}
