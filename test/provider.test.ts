import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { createProvider, findResultEnvelope, ProviderError } from "../src/evals/provider.js";

describe("findResultEnvelope survives real Claude Code stdout", () => {
  it("finds the result object among warnings and hook output", () => {
    // Every line here was observed from a real `claude -p` run on this machine.
    const stdout = [
      "Warning: no stdin data received in 3s, proceeding without it.",
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "OK",
        total_cost_usd: 0.05,
      }),
      "SessionEnd hook [python3 $HOME/.claude/hooks/notion-session-index.py] completed",
    ].join("\n");
    const envelope = findResultEnvelope(stdout);
    expect(envelope?.result).toBe("OK");
    expect(envelope?.total_cost_usd).toBe(0.05);
  });

  it("returns undefined when there is no result envelope", () => {
    expect(findResultEnvelope("Warning: something\nnot json at all")).toBeUndefined();
  });

  it("ignores malformed JSON lines rather than throwing", () => {
    const stdout = ['{"type":"result", BROKEN', JSON.stringify({ type: "result", result: "fine" })].join(
      "\n",
    );
    expect(findResultEnvelope(stdout)?.result).toBe("fine");
  });

  it("does not mistake a non-result object for the answer", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", result: "wrong" }),
      JSON.stringify({ type: "result", result: "right" }),
    ].join("\n");
    expect(findResultEnvelope(stdout)?.result).toBe("right");
  });
});

describe("createProvider", () => {
  it("builds the claude-code provider with no API key present", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { config } = loadConfig({});
      const provider = createProvider({ ...config, llm: { ...config.llm, provider: "claude-code" } });
      expect(provider.name).toBe("claude-code");
      expect(provider.model).toBe("haiku"); // cheap by default, on purpose
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("explains how to fix a missing key, and offers the no-key alternative", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { config } = loadConfig({});
      const withAnthropic = { ...config, llm: { ...config.llm, provider: "anthropic" as const } };
      expect(() => createProvider(withAnthropic)).toThrow(ProviderError);
      expect(() => createProvider(withAnthropic)).toThrow(/ANTHROPIC_API_KEY is not set/);
      expect(() => createProvider(withAnthropic)).toThrow(/claude-code/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
