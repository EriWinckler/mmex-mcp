/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/
/**
 * Minimal argument parsing.
 *
 * Deliberately dependency-free. The server's headline safety claim is that it
 * reaches no network and has a small, auditable dependency tree, and an
 * argument parser is not worth spending that budget on.
 */
export interface ParsedArgs {
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positional: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { flags, positional };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) !== undefined;
}

export function intFlag(args: ParsedArgs, name: string, fallback: number): number {
  const raw = stringFlag(args, name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} expects an integer, got "${raw}"`);
  }
  return value;
}
