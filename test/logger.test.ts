import { afterEach, describe, expect, it, vi } from "vitest";
import { log, setLogLevel } from "../src/log/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel("error");
});

describe("logging never touches stdout", () => {
  it("writes to stderr only, because stdout is the MCP transport", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    setLogLevel("debug");

    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");

    expect(err).toHaveBeenCalledTimes(4);
    // A single stray byte on stdout corrupts the JSON-RPC stream.
    expect(out).not.toHaveBeenCalled();
  });
});

describe("level filtering", () => {
  it("suppresses everything below the configured level", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setLogLevel("warn");
    log.error("shown");
    log.warn("shown");
    log.info("hidden");
    log.debug("hidden");
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("silences everything at silent", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setLogLevel("silent");
    log.error("nope");
    expect(err).not.toHaveBeenCalled();
  });

  it("defaults to error, so an unopened client log does not accumulate data", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    log.info("hidden by default");
    log.error("shown by default");
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe("output shape", () => {
  it("prefixes and serializes context", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setLogLevel("info");
    log.info("opened database", { schemaVersion: "19" });
    expect(err).toHaveBeenCalledWith('[mmex-mcp] info: opened database {"schemaVersion":"19"}\n');
  });
});
