/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/
import type { MmexDatabase } from "../db/connection.js";
import type { CategoryTree } from "../semantics/categories.js";
import type { CurrencyResolver } from "../semantics/currency.js";

/** Shared state every tool handler receives. */
export interface ServerContext {
  readonly db: MmexDatabase;
  /**
   * Built once at startup, not per call. Both read the whole of their table and
   * cache, so rebuilding them for every tool invocation would re-query the
   * database on every question the user asks.
   */
  readonly resolver: CurrencyResolver;
  readonly tree: CategoryTree;
  /**
   * Replace payee names, account names, and notes with stable placeholders.
   *
   * For demos, screenshots, and bug reports: the shape of the data stays
   * intact so the numbers still make sense, but nothing identifying leaves
   * the tool. Redaction is applied at the output boundary, never by changing
   * the query, so an aggregate is identical with it on or off.
   */
  readonly redact: boolean;
}

/** Deterministic placeholder, so the same name always redacts the same way. */
export function redactName(name: string, kind: "payee" | "account" | "category"): string {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const id = (hash >>> 0).toString(36).slice(0, 5).toUpperCase();
  return `${kind}-${id}`;
}

export function maybeRedact(
  context: ServerContext,
  name: string,
  kind: "payee" | "account" | "category",
): string {
  return context.redact ? redactName(name, kind) : name;
}
