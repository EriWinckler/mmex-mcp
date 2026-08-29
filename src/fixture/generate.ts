import { closeSync, existsSync, openSync, readSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { MMEX_SCHEMA_DDL, MMEX_SCHEMA_INDEXES } from "./schema.js";

/**
 * Deterministic synthetic MMEX database.
 *
 * A real .mmb file must never be committed, and tests need data that does not
 * change between runs. A generated database solves both, and doubles as sample
 * data for trying the server without pointing it at real finances. The same
 * seed always produces a byte-identical file, which is asserted by a test.
 *
 * The data is not merely plausible, it is adversarial on purpose. Every
 * semantic trap this server exists to handle is planted here: transfers in
 * one and two currencies, splits whose parent carries no category,
 * soft-deleted rows in both the empty-string and NULL forms, void and
 * duplicate statuses, a zero-decimal currency, and a three-level category
 * tree. A naive implementation gets visibly wrong answers on this file, which
 * is the point.
 */

/** INFOTABLE_V1 key identifying a file this generator produced. */
export const GENERATED_MARKER = "MmexMcpGeneratedFixture";

export class FixtureError extends Error {
  override readonly name = "FixtureError";
  constructor(message: string, hint?: string) {
    super(hint ? `${message}\n  ${hint}` : message);
  }
}

/**
 * Refuse to overwrite a real MMEX database even when --force is given.
 *
 * --force exists for replacing a previously generated fixture. It is not a
 * licence to destroy someone's finances, and the two cases are easy to tell
 * apart: a real database has MMEX's tables in it.
 */
function assertNotAnMmexDatabase(path: string): void {
  const header = Buffer.alloc(16);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (header.toString("latin1") !== "SQLite format 3\0") return;

  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const found = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ACCOUNTLIST_V1','CHECKINGACCOUNT_V1')",
      )
      .all();

    // A file this generator wrote is safe to replace; anything else is not.
    const generated = db
      .prepare<[string], { INFOVALUE: string }>("SELECT INFOVALUE FROM INFOTABLE_V1 WHERE INFONAME = ?")
      .get(GENERATED_MARKER);
    if (generated !== undefined) return;

    if (found.length === 2) {
      throw new FixtureError(
        `Refusing to overwrite what looks like a real Money Manager EX database: ${path}`,
        "--force replaces a generated fixture. It will not overwrite an MMEX database.",
      );
    }
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    // Unreadable or not SQLite after all: nothing to protect.
  } finally {
    db?.close();
  }
}

/** mulberry32: small, fast, and fully deterministic from a 32-bit seed. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureOptions {
  /** Any 32-bit integer. The same seed always yields the same file. */
  readonly seed?: number;
  /**
   * Overwrite an existing file.
   *
   * Off by default and deliberately awkward to turn on. `--out` is one
   * keystroke from `--db`, and the documentation prints both within a couple
   * of lines of each other, so a slip would otherwise write fabricated data
   * over a real financial database that may not be backed up.
   */
  readonly overwrite?: boolean;
  /** How many months of history to generate, ending at anchorDate. */
  readonly months?: number;
  /** Last date in the generated history, ISO YYYY-MM-DD. Never "today". */
  readonly anchorDate?: string;
}

/** What the generator planted, so tests and eval ground truth can assert on it. */
export interface FixtureSummary {
  readonly path: string;
  readonly seed: number;
  readonly anchorDate: string;
  readonly months: number;
  readonly counts: {
    readonly accounts: number;
    readonly categories: number;
    readonly payees: number;
    readonly transactionsTotal: number;
    readonly transactionsLive: number;
    readonly softDeleted: number;
    readonly voided: number;
    readonly duplicates: number;
    readonly transfersSameCurrency: number;
    readonly transfersCrossCurrency: number;
    readonly splitParents: number;
    readonly splitRows: number;
  };
}

const CURRENCIES = [
  // id, name, symbol, prefix, scale (divisor), baseconvrate, type
  [1, "US Dollar", "USD", "$", 100, 1.0, "Base"],
  [2, "Euro", "EUR", "€", 100, 1.0875, "Other"],
  [3, "Japanese Yen", "JPY", "¥", 1, 0.0064, "Other"],
] as const;

const ACCOUNTS = [
  // id, name, type, currencyId, initialBalance
  [1, "Everyday Checking", "Checking", 1, 2500.0],
  [2, "Savings", "Checking", 1, 12000.0],
  [3, "Euro Travel Card", "Checking", 2, 400.0],
  [4, "Yen Pocket", "Cash", 3, 30000],
] as const;

/** name, parentId. Root categories use PARENTID = -1, not NULL. */
const CATEGORIES: readonly (readonly [number, string, number])[] = [
  [1, "Food", -1],
  [2, "Groceries", 1],
  [3, "Dining", 1],
  [4, "Coffee", 3],
  [5, "Restaurants", 3],
  [6, "Transport", -1],
  [7, "Fuel", 6],
  [8, "Transit", 6],
  [9, "Home", -1],
  [10, "Rent", 9],
  [11, "Utilities", 9],
  [12, "Electric", 11],
  [13, "Water", 11],
  [14, "Income", -1],
  [15, "Salary", 14],
  [16, "Interest", 14],
  [17, "Travel", -1],
];

const PAYEES: readonly string[] = [
  "Corner Market",
  "GreenGrocer",
  "Cafe Aurora",
  "Trattoria Bianca",
  "Metro Transit",
  "Shell Station",
  "City Power",
  "Waterworks",
  "Landlord LLC",
  "Northwind Payroll",
  "Bank Interest",
  "Airline One",
  "Hotel Meridian",
  "Duty Free",
  "Book Nook",
  "Pharmacy Plus",
  "Hardware Depot",
  "Streaming Co",
  "Gym Collective",
  "Taxi Union",
];

/** Categories a withdrawal may land in, weighted by how often they occur. */
const SPEND_CATEGORIES: readonly number[] = [2, 2, 2, 4, 4, 5, 7, 8, 12, 13, 17];

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function money(rng: () => number, min: number, max: number): number {
  return Math.round((min + rng() * (max - min)) * 100) / 100;
}

export function generateFixture(outPath: string, options: FixtureOptions = {}): FixtureSummary {
  const seed = options.seed ?? 42;
  const months = options.months ?? 18;
  const anchorDate = options.anchorDate ?? "2026-06-30";
  const rng = makeRng(seed);

  if (existsSync(outPath)) {
    if (!options.overwrite) {
      throw new FixtureError(
        `Refusing to overwrite an existing file: ${outPath}`,
        "Choose another --out path, or pass --force if you meant to replace it.",
      );
    }
    assertNotAnMmexDatabase(outPath);
    rmSync(outPath, { force: true });
    // A leftover sidecar would otherwise be paired with the new database.
    rmSync(`${outPath}-wal`, { force: true });
    rmSync(`${outPath}-shm`, { force: true });
    rmSync(`${outPath}-journal`, { force: true });
  }

  const db = new Database(outPath);
  // Fixed page size and no WAL sidecar, so the file is reproducible byte for byte.
  db.pragma("page_size = 4096");
  db.pragma("journal_mode = DELETE");

  for (const ddl of MMEX_SCHEMA_DDL) db.exec(ddl);
  for (const idx of MMEX_SCHEMA_INDEXES) db.exec(idx);

  const startDate = addMonths(anchorDate, -months);

  const counts = {
    accounts: ACCOUNTS.length,
    categories: CATEGORIES.length,
    payees: PAYEES.length,
    transactionsTotal: 0,
    transactionsLive: 0,
    softDeleted: 0,
    voided: 0,
    duplicates: 0,
    transfersSameCurrency: 0,
    transfersCrossCurrency: 0,
    splitParents: 0,
    splitRows: 0,
  };

  const insertAll = db.transaction(() => {
    const info = db.prepare("INSERT INTO INFOTABLE_V1 (INFONAME, INFOVALUE) VALUES (?, ?)");
    for (const [k, v] of [
      ["BaseCurrencyID", "1"],
      ["DataVersion", "19"],
      ["DateFormat", "%Y-%m-%d"],
      ["CreatedAt", `${startDate} 00:00:00`],
      // Marks this file as fabricated. --force will replace a stamped file and
      // refuses an unstamped one, so a real database is never a candidate.
      [GENERATED_MARKER, "mmex-mcp fixture: synthetic data, not real finances"],
    ] as const) {
      info.run(k, v);
    }

    const cur = db.prepare(
      `INSERT INTO CURRENCYFORMATS_V1
       (CURRENCYID, CURRENCYNAME, PFX_SYMBOL, SFX_SYMBOL, DECIMAL_POINT, GROUP_SEPARATOR,
        UNIT_NAME, CENT_NAME, SCALE, BASECONVRATE, CURRENCY_SYMBOL, CURRENCY_TYPE)
       VALUES (?, ?, ?, '', '.', ',', '', '', ?, ?, ?, ?)`,
    );
    for (const [id, name, symbol, prefix, scale, rate, type] of CURRENCIES) {
      cur.run(id, name, prefix, scale, rate, symbol, type);
    }

    // Monthly FX history. Rates drift, which is exactly what makes using the
    // current rate for a historical total give a different (wrong) answer.
    const hist = db.prepare(
      "INSERT INTO CURRENCYHISTORY_V1 (CURRENCYID, CURRDATE, CURRVALUE, CURRUPDTYPE) VALUES (?, ?, ?, 1)",
    );
    for (let m = 0; m <= months; m++) {
      const date = addMonths(startDate, m);
      hist.run(2, date, Math.round((1.05 + rng() * 0.09) * 10000) / 10000);
      hist.run(3, date, Math.round((0.006 + rng() * 0.0009) * 1000000) / 1000000);
    }

    const acct = db.prepare(
      `INSERT INTO ACCOUNTLIST_V1
       (ACCOUNTID, ACCOUNTNAME, ACCOUNTTYPE, STATUS, INITIALBAL, INITIALDATE,
        FAVORITEACCT, CURRENCYID, NOTES)
       VALUES (?, ?, ?, 'Open', ?, ?, 'TRUE', ?, '')`,
    );
    for (const [id, name, type, currencyId, initial] of ACCOUNTS) {
      acct.run(id, name, type, initial, startDate, currencyId);
    }

    const cat = db.prepare(
      "INSERT INTO CATEGORY_V1 (CATEGID, CATEGNAME, ACTIVE, PARENTID) VALUES (?, ?, 1, ?)",
    );
    for (const [id, name, parent] of CATEGORIES) cat.run(id, name, parent);

    const pay = db.prepare(
      "INSERT INTO PAYEE_V1 (PAYEEID, PAYEENAME, CATEGID, ACTIVE, PATTERN) VALUES (?, ?, ?, 1, '')",
    );
    for (const [i, name] of PAYEES.entries()) {
      pay.run(i + 1, name, SPEND_CATEGORIES[i % SPEND_CATEGORIES.length] ?? 2);
    }

    const tx = db.prepare(
      `INSERT INTO CHECKINGACCOUNT_V1
       (TRANSID, ACCOUNTID, TOACCOUNTID, PAYEEID, TRANSCODE, TRANSAMOUNT, STATUS,
        TRANSACTIONNUMBER, NOTES, CATEGID, TRANSDATE, LASTUPDATEDTIME, DELETEDTIME,
        FOLLOWUPID, TOTRANSAMOUNT, COLOR)
       VALUES (@id, @account, @toAccount, @payee, @code, @amount, @status,
               '', @notes, @categ, @date, @updated, @deleted, -1, @toAmount, -1)`,
    );
    const split = db.prepare(
      "INSERT INTO SPLITTRANSACTIONS_V1 (TRANSID, CATEGID, SPLITTRANSAMOUNT, NOTES) VALUES (?, ?, ?, '')",
    );

    let id = 0;
    const totalDays = months * 30;

    for (let day = 0; day < totalDays; day++) {
      const date = addDays(startDate, day);
      const dayOfMonth = Number(date.slice(8, 10));

      // Monthly salary into checking.
      if (dayOfMonth === 1) {
        id++;
        counts.transactionsTotal++;
        counts.transactionsLive++;
        tx.run({
          id,
          account: 1,
          toAccount: -1,
          payee: 10,
          code: "Deposit",
          amount: 4200.0,
          status: "R",
          notes: "Monthly salary",
          categ: 15,
          date,
          updated: `${date} 09:00:00`,
          deleted: null,
          toAmount: 0,
        });
      }

      // Monthly rent, and a same-currency transfer to savings.
      if (dayOfMonth === 3) {
        id++;
        counts.transactionsTotal++;
        counts.transactionsLive++;
        tx.run({
          id,
          account: 1,
          toAccount: -1,
          payee: 9,
          code: "Withdrawal",
          amount: 1450.0,
          status: "R",
          notes: "Rent",
          categ: 10,
          date,
          updated: `${date} 09:00:00`,
          deleted: "",
          toAmount: 0,
        });

        id++;
        counts.transactionsTotal++;
        counts.transactionsLive++;
        counts.transfersSameCurrency++;
        tx.run({
          id,
          account: 1,
          toAccount: 2,
          payee: 1,
          code: "Transfer",
          amount: 500.0,
          status: "",
          notes: "To savings",
          categ: -1,
          date,
          updated: `${date} 09:05:00`,
          deleted: null,
          toAmount: 500.0,
        });
      }

      // Cross-currency transfer: USD leaves checking, EUR arrives on the card.
      if (dayOfMonth === 12) {
        const rate = 1.05 + rng() * 0.09;
        const usd = money(rng, 200, 400);
        id++;
        counts.transactionsTotal++;
        counts.transactionsLive++;
        counts.transfersCrossCurrency++;
        tx.run({
          id,
          account: 1,
          toAccount: 3,
          payee: 12,
          code: "Transfer",
          amount: usd,
          status: "",
          notes: "Top up travel card",
          categ: -1,
          date,
          updated: `${date} 10:00:00`,
          deleted: null,
          toAmount: Math.round((usd / rate) * 100) / 100,
        });
      }

      // A split transaction: the parent carries no category, the splits do.
      if (dayOfMonth === 17) {
        const a = money(rng, 30, 70);
        const b = money(rng, 10, 40);
        const c = money(rng, 5, 25);
        id++;
        counts.transactionsTotal++;
        counts.transactionsLive++;
        counts.splitParents++;
        tx.run({
          id,
          account: 1,
          toAccount: -1,
          payee: 2,
          code: "Withdrawal",
          amount: Math.round((a + b + c) * 100) / 100,
          status: "",
          notes: "Big shop",
          categ: -1,
          date,
          updated: `${date} 18:00:00`,
          deleted: null,
          toAmount: 0,
        });
        split.run(id, 2, a);
        split.run(id, 4, b);
        split.run(id, 13, c);
        counts.splitRows += 3;
      }

      // Everyday spending, one to three per day.
      const perDay = 1 + Math.floor(rng() * 3);
      for (let n = 0; n < perDay; n++) {
        const payee = 1 + Math.floor(rng() * PAYEES.length);
        const account = rng() < 0.75 ? 1 : rng() < 0.6 ? 3 : 4;
        const jpy = account === 4;
        const amount = jpy ? Math.round(money(rng, 300, 4000)) : money(rng, 3, 90);
        const roll = rng();

        // Deliberately mix the two "not deleted" encodings MMEX writes.
        let deleted: string | null = day % 2 === 0 ? "" : null;
        let status = day % 7 === 0 ? "R" : "";

        if (roll < 0.02) {
          deleted = addDays(date, 3);
          counts.softDeleted++;
        } else if (roll < 0.035) {
          status = "V";
          counts.voided++;
        } else if (roll < 0.045) {
          status = "D";
          counts.duplicates++;
        }

        id++;
        counts.transactionsTotal++;
        if (deleted === "" || deleted === null) counts.transactionsLive++;

        tx.run({
          id,
          account,
          toAccount: -1,
          payee,
          code: "Withdrawal",
          amount,
          status,
          notes: "",
          categ: SPEND_CATEGORIES[Math.floor(rng() * SPEND_CATEGORIES.length)] ?? 2,
          date,
          updated: `${date} 12:00:00`,
          deleted,
          toAmount: 0,
        });
      }
    }

    // A budget year with per-category monthly amounts.
    const budgetYear = anchorDate.slice(0, 4);
    db.prepare("INSERT INTO BUDGETYEAR_V1 (BUDGETYEARID, BUDGETYEARNAME) VALUES (1, ?)").run(budgetYear);
    const bud = db.prepare(
      "INSERT INTO BUDGETTABLE_V1 (BUDGETYEARID, CATEGID, PERIOD, AMOUNT, NOTES, ACTIVE) VALUES (1, ?, 'Monthly', ?, '', 1)",
    );
    for (const [categId, amount] of [
      [2, 450],
      [3, 250],
      [7, 120],
      [10, 1450],
      [11, 180],
    ] as const) {
      bud.run(categId, amount);
    }

    // Recurring items.
    const bills = db.prepare(
      `INSERT INTO BILLSDEPOSITS_V1
       (ACCOUNTID, TOACCOUNTID, PAYEEID, TRANSCODE, TRANSAMOUNT, STATUS, TRANSACTIONNUMBER,
        NOTES, CATEGID, TRANSDATE, FOLLOWUPID, TOTRANSAMOUNT, REPEATS, NEXTOCCURRENCEDATE,
        NUMOCCURRENCES, COLOR)
       VALUES (?, -1, ?, 'Withdrawal', ?, '', '', '', ?, ?, -1, 0, 1, ?, -1, -1)`,
    );
    bills.run(1, 9, 1450.0, 10, anchorDate, addMonths(anchorDate, 1));
    bills.run(1, 18, 15.99, 17, anchorDate, addMonths(anchorDate, 1));

    // Tags on a handful of transactions.
    const tag = db.prepare("INSERT INTO TAG_V1 (TAGID, TAGNAME, ACTIVE) VALUES (?, ?, 1)");
    tag.run(1, "business");
    tag.run(2, "reimbursable");
    const tagLink = db.prepare("INSERT INTO TAGLINK_V1 (REFTYPE, REFID, TAGID) VALUES ('Transaction', ?, ?)");
    for (let t = 5; t < Math.min(id, 200); t += 37) tagLink.run(t, (t % 2) + 1);
  });

  insertAll();
  db.exec("VACUUM");
  db.close();

  return { path: outPath, seed, anchorDate, months, counts };
}
