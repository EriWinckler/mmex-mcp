/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/** Smallest database that satisfies the MMEX table requirement, for connection tests. */
export function makeTinyMmexDb(fileName = "tiny.mmb"): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mmex-test-"));
  const path = join(dir, fileName);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ACCOUNTLIST_V1(ACCOUNTID INTEGER PRIMARY KEY, ACCOUNTNAME TEXT, CURRENCYID INTEGER);
    CREATE TABLE CHECKINGACCOUNT_V1(TRANSID INTEGER PRIMARY KEY, TRANSAMOUNT numeric, DELETEDTIME TEXT, STATUS TEXT);
    CREATE TABLE CATEGORY_V1(CATEGID INTEGER PRIMARY KEY, CATEGNAME TEXT, PARENTID INTEGER);
    CREATE TABLE CURRENCYFORMATS_V1(CURRENCYID INTEGER PRIMARY KEY, CURRENCY_SYMBOL TEXT, SCALE INTEGER, BASECONVRATE numeric);
    CREATE TABLE INFOTABLE_V1(INFOID INTEGER PRIMARY KEY, INFONAME TEXT COLLATE NOCASE, INFOVALUE TEXT);
    INSERT INTO INFOTABLE_V1 (INFONAME, INFOVALUE) VALUES ('BaseCurrencyID','1'),('DataVersion','19');
    INSERT INTO CURRENCYFORMATS_V1 VALUES (1,'USD',100,1.0);
  `);
  db.close();
  return { path, dir };
}

/** A SQLite database that is valid but is not an MMEX one. */
export function makeNonMmexDb(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mmex-test-"));
  const path = join(dir, "other.mmb");
  const db = new Database(path);
  db.exec("CREATE TABLE SOMETHING_ELSE(id INTEGER PRIMARY KEY)");
  db.close();
  return { path, dir };
}

/** A file that is not a SQLite database at all. */
export function makeGarbageFile(fileName: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mmex-test-"));
  const path = join(dir, fileName);
  writeFileSync(path, Buffer.from("this is definitely not a sqlite database at all"));
  return { path, dir };
}
