import { chmodSync, closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";

/**
 * Read-only access to an MMEX database.
 *
 * The read-only guarantee is enforced twice, on purpose. `readonly: true`
 * opens the file without write intent at the OS level, and `PRAGMA
 * query_only` blocks writes at the SQL layer even if a future code path
 * somehow obtained a writable handle. Both are asserted by tests: a write
 * through this module fails with SQLITE_READONLY.
 *
 * This module opens no sockets and performs no network access. Nothing else
 * in the server does either, which is what makes the "your financial data
 * never leaves the machine" claim checkable rather than a promise.
 */

/** Every SQLite file begins with this exact 16-byte header. */
const SQLITE_MAGIC = "SQLite format 3\0";

/** Tables an MMEX database must have for this server to be useful. */
const REQUIRED_TABLES = ["ACCOUNTLIST_V1", "CHECKINGACCOUNT_V1", "CATEGORY_V1", "CURRENCYFORMATS_V1"];

/**
 * MMEX schema versions this server's semantics were verified against.
 *
 * The rules in src/semantics were read from Money Manager EX 1.9.4's source.
 * A newer schema may change them, and silently returning numbers derived from
 * stale rules is worse than saying so, hence the warning.
 */
export const VERIFIED_SCHEMA_VERSIONS = ["19"] as const;

export class MmexDatabaseError extends Error {
  override readonly name = "MmexDatabaseError";
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(hint ? `${message}\n  ${hint}` : message);
  }
}

export interface OpenOptions {
  /**
   * Copy the database to a temporary file before opening it.
   *
   * MMEX keeps its database open while running. A read-only open normally
   * still succeeds, but a snapshot removes any interaction with a live writer
   * and guarantees a stable view for the duration of a session. The copy is
   * deleted on close.
   */
  readonly snapshot?: boolean;
  /** How long to wait on a locked database before failing. Default 5000ms. */
  readonly busyTimeoutMs?: number;
}

/** Evidence that this handle cannot write, gathered by actually trying. */
export interface ReadOnlyProof {
  /** PRAGMA query_only reports ON. */
  readonly queryOnly: boolean;
  /** SQLite error code from a real attempted write. null means it was NOT rejected. */
  readonly writeRejectedWith: string | null;
}

export interface SchemaCompatibility {
  readonly version: string | null;
  readonly verified: boolean;
  /** Populated when the version is unknown or newer than what was verified. */
  readonly warning: string | null;
}

export interface MmexDatabase {
  /** Path actually opened. Differs from the requested path when snapshotting. */
  readonly openedPath: string;
  readonly sourcePath: string;
  /** Contents of INFOTABLE_V1, lowercased keys. Empty if the table is absent. */
  readonly info: ReadonlyMap<string, string>;
  /** Whether this database's schema version is one the semantics were verified against. */
  readonly schema: SchemaCompatibility;
  /**
   * Prove the read-only posture by attempting a write and reporting how
   * SQLite refused it. The probe is `DELETE ... WHERE 1 = 0`, which changes
   * nothing even in the failure case where it is somehow allowed to run.
   */
  verifyReadOnly(): ReadOnlyProof;
  query<T>(sql: string, params?: Record<string, unknown> | unknown[]): T[];
  queryOne<T>(sql: string, params?: Record<string, unknown> | unknown[]): T | undefined;
  close(): void;
}

function assertReadableSqliteFile(path: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new MmexDatabaseError(
      `No such database file: ${path}`,
      "Pass the path to your .mmb file, for example --db ~/finances.mmb",
    );
  }
  if (stat.isDirectory()) {
    throw new MmexDatabaseError(`That path is a directory, not a database file: ${path}`);
  }
  if (stat.size === 0) {
    throw new MmexDatabaseError(`Database file is empty: ${path}`);
  }

  const header = Buffer.alloc(16);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, 16, 0);
  } finally {
    closeSync(fd);
  }

  if (header.toString("latin1") !== SQLITE_MAGIC) {
    // An encrypted MMEX database (.emb, SQLCipher) has no plaintext header.
    throw new MmexDatabaseError(
      `Not an unencrypted SQLite database: ${path}`,
      basename(path).endsWith(".emb")
        ? "This looks like an encrypted MMEX database. Encrypted (.emb) files are not supported yet; open it in MMEX and save an unencrypted copy."
        : "The file does not begin with the SQLite header, so it is either encrypted or not a database.",
    );
  }
}

/**
 * Copy a database with SQLite's own VACUUM INTO rather than the filesystem.
 *
 * A plain file copy takes only the main .mmb and leaves the -wal and -shm
 * sidecars behind, so the copy reflects the last checkpoint rather than the
 * current state. On a WAL-mode database with a hot log that silently discards
 * every uncommitted-to-main transaction: measured at 500 transactions and eight
 * months of history on a test database, with no error and no warning.
 *
 * That matters most in exactly the case --snapshot exists for, since a hot WAL
 * is what a running Money Manager EX produces.
 *
 * VACUUM INTO is WAL-aware, produces a consistent copy from a read-only handle,
 * and verifies structure on the way through.
 */
function snapshotTo(sourcePath: string, destinationPath: string): void {
  let source: Database.Database | undefined;
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    // Single-quote escaping: SQLite has no parameter binding for VACUUM INTO.
    source.exec(`VACUUM INTO '${destinationPath.replace(/'/g, "''")}'`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new MmexDatabaseError(
        `Database is locked and could not be snapshotted: ${sourcePath}`,
        "Close Money Manager EX and try again.",
      );
    }
    throw error;
  } finally {
    source?.close();
  }
}

export function openReadOnly(path: string, options: OpenOptions = {}): MmexDatabase {
  assertReadableSqliteFile(path);

  let openedPath = path;
  let tempDir: string | undefined;
  if (options.snapshot) {
    tempDir = mkdtempSync(join(tmpdir(), "mmex-mcp-"));
    openedPath = join(tempDir, basename(path));
    try {
      snapshotTo(path, openedPath);
      // mkdtemp is already 0700; make the copy itself explicit too.
      chmodSync(openedPath, 0o600);
    } catch (error) {
      // Without this, a failed copy (a full disk being the usual cause) leaves
      // a partial copy of the user's financial database in the temp directory.
      rmSync(tempDir, { recursive: true, force: true });
      if (error instanceof MmexDatabaseError) throw error;
      throw new MmexDatabaseError(
        `Could not snapshot the database: ${(error as Error).message}`,
        "Check free space in the temp directory, or run without --snapshot.",
      );
    }
  }

  let db: Database.Database;
  try {
    db = new Database(openedPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    const code = (error as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new MmexDatabaseError(
        `Database is locked: ${path}`,
        "Money Manager EX is probably holding it. Close MMEX, or start this server with --snapshot to read a copy.",
      );
    }
    throw new MmexDatabaseError(`Could not open ${path}: ${(error as Error).message}`);
  }

  // Second layer of the read-only guarantee: refuse writes at the SQL level.
  db.pragma("query_only = ON");
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);

  const present = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name.toUpperCase()),
  );
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    throw new MmexDatabaseError(
      `This is a SQLite database but not a Money Manager EX one (missing ${missing.join(", ")})`,
      "Point --db at a .mmb file created by Money Manager EX.",
    );
  }

  const info = new Map<string, string>();
  if (present.has("INFOTABLE_V1")) {
    for (const row of db
      .prepare<[], { INFONAME: string; INFOVALUE: string }>("SELECT INFONAME, INFOVALUE FROM INFOTABLE_V1")
      .all()) {
      info.set(row.INFONAME.toLowerCase(), row.INFOVALUE);
    }
  }

  const version = info.get("dataversion") ?? null;
  const verified = version !== null && (VERIFIED_SCHEMA_VERSIONS as readonly string[]).includes(version);
  const schema: SchemaCompatibility = {
    version,
    verified,
    warning: verified
      ? null
      : version === null
        ? "This database reports no schema version (INFOTABLE_V1.DataVersion is absent). Results are unverified."
        : `This database reports schema version ${version}, but these semantics were verified against ${VERIFIED_SCHEMA_VERSIONS.join(", ")}. Results may be wrong if the schema changed.`,
  };

  let closed = false;
  const handle: MmexDatabase = {
    openedPath,
    sourcePath: path,
    info,
    schema,
    verifyReadOnly(): ReadOnlyProof {
      const pragma = db.pragma("query_only") as Array<{ query_only: number }>;
      let writeRejectedWith: string | null = null;
      try {
        // A write that is a no-op even if it were permitted.
        db.prepare("DELETE FROM ACCOUNTLIST_V1 WHERE 1 = 0").run();
      } catch (error) {
        writeRejectedWith = (error as { code?: string }).code ?? "UNKNOWN";
      }
      return { queryOnly: pragma[0]?.query_only === 1, writeRejectedWith };
    },
    query<T>(sql: string, params?: Record<string, unknown> | unknown[]): T[] {
      const statement = db.prepare(sql);
      return (params === undefined ? statement.all() : statement.all(params)) as T[];
    },
    queryOne<T>(sql: string, params?: Record<string, unknown> | unknown[]): T | undefined {
      const statement = db.prepare(sql);
      return (params === undefined ? statement.get() : statement.get(params)) as T | undefined;
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    },
  };
  return handle;
}
