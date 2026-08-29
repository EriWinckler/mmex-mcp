import type { MmexDatabase } from "../db/connection.js";
import { CATEGORY_ROOT_PARENT_ID, MAX_CATEGORY_DEPTH } from "./rules.js";

/**
 * The category tree.
 *
 * Roots are PARENTID = -1, never NULL (src/data/CategoryData.h:29, and the
 * seed data in src/table/tables_en.sql:113). The path separator is not fixed:
 * MMEX reads INFOTABLE_V1.CATEG_DELIMITER, defaulting to ':', and the
 * preferences UI lets a user type an arbitrary string
 * (src/model/CategoryModel.cpp:134). MMEX's own published report hardcodes
 * ':' and therefore shows different paths than the app for such a user.
 *
 * Depth is capped because MMEX has no cycle protection: a cyclic PARENTID
 * hangs the application, and would hang a recursive CTE identically.
 */

export interface CategoryNode {
  readonly id: number;
  readonly name: string;
  readonly parentId: number;
  readonly fullName: string;
  readonly depth: number;
  readonly active: boolean;
}

export class CategoryTree {
  private readonly byId = new Map<number, CategoryNode>();
  readonly delimiter: string;
  /** Ids that could not be placed, because of a missing parent or a cycle. */
  readonly orphaned: readonly number[];

  constructor(db: MmexDatabase) {
    this.delimiter = db.info.get("categ_delimiter") ?? ":";

    const rows = db.query<{
      CATEGID: number;
      CATEGNAME: string;
      PARENTID: number | null;
      ACTIVE: number | null;
    }>("SELECT CATEGID, CATEGNAME, PARENTID, ACTIVE FROM CATEGORY_V1");

    const raw = new Map(rows.map((r) => [r.CATEGID, r]));
    const orphaned: number[] = [];

    for (const row of rows) {
      const segments: string[] = [row.CATEGNAME];
      let parentId = row.PARENTID ?? CATEGORY_ROOT_PARENT_ID;
      let depth = 1;
      let ok = true;

      // MMEX treats 0 and negatives as root when walking upward.
      while (parentId > 0) {
        if (depth >= MAX_CATEGORY_DEPTH) {
          ok = false;
          break;
        }
        const parent = raw.get(parentId);
        if (parent === undefined) {
          // MMEX emits a literal "Error" segment here (issue #8276).
          ok = false;
          break;
        }
        segments.unshift(parent.CATEGNAME);
        parentId = parent.PARENTID ?? CATEGORY_ROOT_PARENT_ID;
        depth++;
      }

      if (!ok) {
        orphaned.push(row.CATEGID);
        continue;
      }

      this.byId.set(row.CATEGID, {
        id: row.CATEGID,
        name: row.CATEGNAME,
        parentId: row.PARENTID ?? CATEGORY_ROOT_PARENT_ID,
        fullName: segments.join(this.delimiter),
        depth,
        active: (row.ACTIVE ?? 1) !== 0,
      });
    }

    this.orphaned = orphaned;
  }

  get(id: number): CategoryNode | undefined {
    return this.byId.get(id);
  }

  /** Full path, or a stable placeholder for the uncategorized sentinel. */
  nameOf(id: number | null | undefined): string {
    if (id === null || id === undefined || id <= 0) return "(uncategorized)";
    return this.byId.get(id)?.fullName ?? `(unknown category ${id})`;
  }

  all(): readonly CategoryNode[] {
    return [...this.byId.values()];
  }

  /** The root ancestor's id, for rolling child spending up to a top-level total. */
  rootOf(id: number): number | undefined {
    let node = this.byId.get(id);
    if (node === undefined) return undefined;
    let guard = 0;
    while (node.parentId > 0 && guard++ < MAX_CATEGORY_DEPTH) {
      const parent = this.byId.get(node.parentId);
      if (parent === undefined) break;
      node = parent;
    }
    return node.id;
  }
}
