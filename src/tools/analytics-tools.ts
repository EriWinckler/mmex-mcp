import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  accountBalances,
  incomeVsExpense,
  searchTransactions,
  spendingByCategory,
} from "../semantics/analytics.js";
import { maybeRedact, type ServerContext } from "../server/context.js";
import {
  amount,
  amountSchema,
  basis,
  basisSchema,
  clampLimit,
  coverage,
  coverageSchema,
  page,
  pageSchema,
  READ_ONLY_TOOL,
  toolResult,
} from "./result.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, YYYY-MM-DD")
  .describe("ISO date, YYYY-MM-DD");

const EXCLUDED_ALWAYS = ["void transactions", "soft-deleted transactions"];

export function registerAnalyticsTools(server: McpServer, context: ServerContext): void {
  const { db, resolver, tree } = context;

  // -------------------------------------------------------------------------
  server.registerTool(
    "mmex_spending_by_category",
    {
      title: "Spending by category",
      description:
        "Total spending or income grouped by category, over a date range. This is the tool for " +
        "'where did my money go' and 'how much did I spend on X'. Transfers between the user's own " +
        "accounts are excluded, split transactions are attributed to their split categories, and " +
        "foreign amounts are converted at each transaction's own date. Returns totals, not rows; " +
        "use mmex_transactions to see the individual transactions behind a figure.",
      inputSchema: {
        from: isoDate.optional().describe("Start of the range, inclusive. Omit for all history."),
        to: isoDate.optional().describe("End of the range, inclusive."),
        direction: z
          .enum(["expense", "income", "both"])
          .default("expense")
          .describe("'expense' for outflows (the default), 'income' for inflows, 'both' for the net."),
        rollup: z
          .enum(["leaf", "root"])
          .default("leaf")
          .describe(
            "'leaf' reports categories as recorded; 'root' rolls subcategories into their top level.",
          ),
        accountIds: z.array(z.number().int()).optional().describe("Restrict to these accounts."),
        limit: z.number().int().optional().describe("Maximum categories to return. Default 25, max 200."),
      },
      outputSchema: {
        categories: z.array(
          z.object({
            categoryId: z.number().int(),
            name: z.string(),
            amount: amountSchema,
            transactionCount: z.number().int(),
            shareOfTotal: z.number().describe("Fraction of the total, 0 to 1."),
          }),
        ),
        total: amountSchema.describe(
          "Total over ALL categories, including any below the cap. Do NOT re-derive this by " +
            "summing the returned categories; add coverage.other.amount to them instead.",
        ),
        uncategorized: amountSchema.describe("Amount with no category, reported rather than dropped."),
        transfersExcluded: z.number().int().describe("Transfers left out, which are not spending."),
        assetTransfersExcluded: z.number().int().describe("Asset and share movements left out."),
        coverage: coverageSchema,
        basis: basisSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    (args) => {
      const limit = clampLimit(args.limit, 25, 200);
      const result = spendingByCategory(db, resolver, tree, {
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.accountIds !== undefined ? { accountIds: args.accountIds } : {}),
        direction: args.direction,
        rollup: args.rollup,
        limit,
      });
      const currency = resolver.base?.symbol ?? "?";
      const totalUnits = Math.abs(result.totalBase.units) || 1;
      return toolResult({
        categories: result.categories.map((c) => ({
          categoryId: c.categoryId,
          name: maybeRedact(context, c.name, "category"),
          amount: amount(c.amountBase, currency),
          transactionCount: c.transactionCount,
          shareOfTotal: Math.round((Math.abs(c.amountBase.units) / totalUnits) * 10000) / 10000,
        })),
        total: amount(result.totalBase, currency),
        uncategorized: amount(result.uncategorizedBase, currency),
        transfersExcluded: result.transfersExcluded,
        assetTransfersExcluded: result.assetTransfersExcluded,
        coverage: coverage({
          groupsReturned: result.categories.length,
          groupsTotal: result.groupsTotal,
          otherGroups: result.otherGroups,
          otherAmount: result.otherBase,
          currency,
        }),
        basis: basis(db, resolver, result.basis, [
          ...EXCLUDED_ALWAYS,
          "transfers",
          "asset and share movements",
        ]),
      });
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "mmex_account_balances",
    {
      title: "Account balances",
      description:
        "Current balance of every account, plus total net worth. Use this for 'how much do I have', " +
        "'what is my balance', or 'what am I worth'. Balances start from each account's opening " +
        "balance and apply every transaction, with transfers credited and debited on the correct " +
        "side. Also reports the reconciled balance, which counts only transactions marked reconciled.",
      inputSchema: {
        asOf: isoDate.optional().describe("Balance as at this date. Omit for the latest."),
        includeClosed: z.boolean().default(false).describe("Include accounts marked closed."),
      },
      outputSchema: {
        accounts: z.array(
          z.object({
            accountId: z.number().int(),
            name: z.string(),
            type: z.string(),
            status: z.string(),
            currency: z.string(),
            balance: amountSchema.describe("In the account's own currency."),
            balanceInBaseCurrency: amountSchema,
            reconciledBalance: amountSchema.describe("Only transactions marked reconciled."),
            transactionCount: z.number().int(),
          }),
        ),
        netWorth: amountSchema,
        asOf: z.string().nullable(),
        basis: basisSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    (args) => {
      const result = accountBalances(db, resolver, {
        ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
        includeClosed: args.includeClosed,
      });
      const base = resolver.base?.symbol ?? "?";
      return toolResult({
        accounts: result.accounts.map((a) => ({
          accountId: a.accountId,
          name: maybeRedact(context, a.name, "account"),
          type: a.type,
          status: a.status,
          currency: a.currency,
          balance: amount(a.balance, a.currency),
          balanceInBaseCurrency: amount(a.balanceBase, base),
          reconciledBalance: amount(a.reconciledBalance, a.currency),
          transactionCount: a.transactionCount,
        })),
        netWorth: amount(result.netWorthBase, base),
        asOf: result.asOf,
        basis: basis(db, resolver, result.basis, EXCLUDED_ALWAYS),
      });
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "mmex_income_vs_expense",
    {
      title: "Income vs expense",
      description:
        "Income, expense and the net difference per period. Use this for 'am I saving', 'how much " +
        "did I earn', or any question about a trend over time. Transfers between the user's own " +
        "accounts are excluded from both sides, because moving money is neither income nor expense.",
      inputSchema: {
        from: isoDate.optional(),
        to: isoDate.optional(),
        groupBy: z.enum(["month", "quarter", "year"]).default("month"),
        accountIds: z.array(z.number().int()).optional(),
      },
      outputSchema: {
        periods: z.array(
          z.object({
            period: z.string(),
            income: amountSchema,
            expense: amountSchema,
            net: amountSchema,
            transactionCount: z.number().int(),
          }),
        ),
        totals: z.object({ income: amountSchema, expense: amountSchema, net: amountSchema }),
        transfersExcluded: z.number().int(),
        basis: basisSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    (args) => {
      const result = incomeVsExpense(db, resolver, {
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.accountIds !== undefined ? { accountIds: args.accountIds } : {}),
        groupBy: args.groupBy,
      });
      const currency = resolver.base?.symbol ?? "?";
      return toolResult({
        periods: result.periods.map((p) => ({
          period: p.period,
          income: amount(p.incomeBase, currency),
          expense: amount(p.expenseBase, currency),
          net: amount(p.netBase, currency),
          transactionCount: p.transactionCount,
        })),
        totals: {
          income: amount(result.incomeBase, currency),
          expense: amount(result.expenseBase, currency),
          net: amount(result.netBase, currency),
        },
        transfersExcluded: result.transfersExcluded,
        basis: basis(db, resolver, result.basis, [...EXCLUDED_ALWAYS, "transfers"]),
      });
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "mmex_transactions",
    {
      title: "Find transactions",
      description:
        "Individual transactions matching a filter, newest first. Use this to show the transactions " +
        "behind a total, or to answer 'when did I last pay X'. A category filter includes that " +
        "category's subcategories. Results are paged: check page.truncated and pass page.nextOffset " +
        "to continue. Prefer the aggregate tools for totals; this one is for looking at the detail.",
      inputSchema: {
        from: isoDate.optional(),
        to: isoDate.optional(),
        accountIds: z.array(z.number().int()).optional(),
        categoryId: z
          .number()
          .int()
          .optional()
          .describe("Includes subcategories. Resolve names with mmex_categories."),
        payeeContains: z.string().optional(),
        textContains: z.string().optional().describe("Matches notes, transaction number, or payee."),
        minAmount: z.number().optional().describe("Minimum absolute amount, in the account's currency."),
        maxAmount: z.number().optional(),
        includeTransfers: z.boolean().default(false),
        limit: z.number().int().optional().describe("Default 25, max 200."),
        offset: z.number().int().optional(),
      },
      outputSchema: {
        transactions: z.array(
          z.object({
            transactionId: z.number().int(),
            date: z.string(),
            account: z.string(),
            payee: z.string(),
            category: z.string().describe("'(split)' when the transaction is split across categories."),
            type: z.string(),
            status: z.string(),
            amount: amountSchema.describe("In the account's own currency."),
            amountInBaseCurrency: amountSchema,
            hasSplits: z.boolean(),
            notes: z.string(),
          }),
        ),
        page: pageSchema,
        basis: basisSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    (args) => {
      const limit = clampLimit(args.limit, 25, 200);
      const offset = Math.max(0, args.offset ?? 0);
      const result = searchTransactions(db, resolver, tree, {
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.accountIds !== undefined ? { accountIds: args.accountIds } : {}),
        ...(args.categoryId !== undefined ? { categoryId: args.categoryId } : {}),
        ...(args.payeeContains !== undefined ? { payeeContains: args.payeeContains } : {}),
        ...(args.textContains !== undefined ? { textContains: args.textContains } : {}),
        ...(args.minAmount !== undefined ? { minAmount: args.minAmount } : {}),
        ...(args.maxAmount !== undefined ? { maxAmount: args.maxAmount } : {}),
        includeTransfers: args.includeTransfers,
        limit,
        offset,
      });
      const base = resolver.base?.symbol ?? "?";
      return toolResult({
        transactions: result.rows.map((r) => ({
          transactionId: r.transactionId,
          date: r.date,
          account: maybeRedact(context, r.account, "account"),
          payee: maybeRedact(context, r.payee, "payee"),
          category: r.hasSplits ? "(split)" : maybeRedact(context, r.category, "category"),
          type: r.type,
          status: r.status,
          amount: amount(r.amount, r.currency),
          amountInBaseCurrency: amount(r.amountBase, base),
          hasSplits: r.hasSplits,
          notes: context.redact ? "" : r.notes,
        })),
        page: page({ returned: result.rows.length, limit, offset, totalMatching: result.totalMatching }),
        basis: basis(db, resolver, result.basis, EXCLUDED_ALWAYS),
      });
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "mmex_categories",
    {
      title: "List categories",
      description:
        "The category tree, with full paths. Call this to turn a category name the user mentioned " +
        "into the categoryId that the other tools take, rather than guessing at an id.",
      inputSchema: {
        contains: z.string().optional().describe("Case-insensitive filter on the full path."),
        activeOnly: z.boolean().default(true),
        limit: z.number().int().optional().describe("Default 100, max 500."),
      },
      outputSchema: {
        categories: z.array(
          z.object({
            categoryId: z.number().int(),
            name: z.string().describe("Leaf name."),
            fullName: z.string().describe("Full path, using the database's own delimiter."),
            parentId: z.number().int(),
            depth: z.number().int(),
            active: z.boolean(),
          }),
        ),
        delimiter: z.string().describe("Path separator this database uses. Not always ':'."),
        unresolved: z
          .array(z.number().int())
          .describe("Category ids that could not be placed, from a missing parent or a cycle."),
        page: pageSchema,
      },
      annotations: READ_ONLY_TOOL,
    },
    (args) => {
      const limit = clampLimit(args.limit, 100, 500);
      const needle = args.contains?.toLowerCase();
      const matching = tree
        .all()
        .filter((c) => (args.activeOnly ? c.active : true))
        .filter((c) => (needle === undefined ? true : c.fullName.toLowerCase().includes(needle)))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));

      return toolResult({
        categories: matching.slice(0, limit).map((c) => ({
          categoryId: c.id,
          name: maybeRedact(context, c.name, "category"),
          fullName: maybeRedact(context, c.fullName, "category"),
          parentId: c.parentId,
          depth: c.depth,
          active: c.active,
        })),
        delimiter: tree.delimiter,
        unresolved: [...tree.orphaned],
        page: page({
          returned: Math.min(matching.length, limit),
          limit,
          offset: 0,
          totalMatching: matching.length,
        }),
      });
    },
  );
}
