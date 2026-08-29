# Using mmex-mcp with Claude Code

**TL;DR.** One command registers it, and then you just talk to Claude about your
money:

```bash
claude mcp add mmex -- npx -y mmex-mcp --db ~/finances.mmb
```

No API key. Claude Code is already the model.

> **Not on npm yet.** Until it is published, substitute a built checkout
> everywhere `npx -y mmex-mcp` appears:
>
> ```bash
> npm install && npm run build
> claude mcp add mmex -- node "$PWD/dist/bin/server.js" --db ~/finances.mmb
> ```

## Try it without your own data first

You do not need a Money Manager EX file to try this. Generate a synthetic one,
with fabricated accounts, payees and 18 months of transactions:

```bash
node dist/bin/fixture.js --out demo.mmb     # or: npx mmex-fixture, once published
claude mcp add mmex-demo -- node "$PWD/dist/bin/server.js" --db "$PWD/demo.mmb"
```

Then ask, in Claude Code:

```
What did I spend on groceries last quarter, and how does that compare to the quarter before?
```

Remove it again with `claude mcp remove mmex-demo`.

## Registration options

**User scope**, available in every project on the machine:

```bash
claude mcp add --scope user mmex -- npx -y mmex-mcp --db ~/finances.mmb
```

**Project scope**, committed to a repo and shared with collaborators. This repo
ships a `.mcp.json` already, so inside a checkout it is picked up automatically
once `MMEX_MCP_DB` is set:

```bash
export MMEX_MCP_DB=~/finances.mmb
```

**With options:**

```bash
# Money Manager EX is running and holding the database
claude mcp add mmex -- npx -y mmex-mcp --db ~/finances.mmb --snapshot

# Screen sharing or filing a bug: keep the numbers, hide the names
claude mcp add mmex -- npx -y mmex-mcp --db ~/finances.mmb --redact
```

Verify it connected:

```bash
claude mcp list
```

## Configuration

Settings resolve in this order, highest first: **command line flags**, then
**environment variables**, then a **config file**, then defaults.

| Setting | Flag | Environment | Config file |
|---|---|---|---|
| Database path | `--db` | `MMEX_MCP_DB` | `database.path` |
| Read a copy | `--snapshot` | `MMEX_MCP_SNAPSHOT` | `database.snapshot` |
| Hide names | `--redact` | `MMEX_MCP_REDACT` | `database.redact` |
| Config file location | `--config` | | |

A config file is read from `--config`, then `./mmex-mcp.config.json`, then
`$XDG_CONFIG_HOME/mmex-mcp/config.json`, then `~/.config/mmex-mcp/config.json`.
Copy `mmex-mcp.config.example.json` to start.

### API keys are never stored in the config file

The config file holds the **name of an environment variable**, never a key:

```json
{ "llm": { "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY" } } }
```

Writing `apiKey` into the file is rejected with an explicit error rather than
silently ignored. Config files get committed, pasted into issues, and synced
between machines. A key in one is a key leaked.

## Configuring a model for the eval harness

> **Status:** the model providers and their configuration are implemented and
> tested. The harness that drives them (question set, ground truth, scorecard)
> is the next piece of work, so there is no `npm run eval` yet.

The harness will compare two arms answering the same questions: one with these
semantic tools, one with raw SQL access to the same database. It needs a model,
and there are two ways to give it one.

### Claude Code (default, no API key)

Shells out to `claude -p` and reuses the access already set up on your machine.
Selected by default, or explicitly:

```json
{ "llm": { "provider": "claude-code", "model": "haiku" } }
```

**Cost, measured rather than estimated.** Every headless invocation is a fresh
session that pays full cache-creation cost for Claude Code's system prompt. On
this machine a single trivial question cost:

| Model | Cache-creation tokens | Cost for one question |
|---|---|---|
| Opus | 52,309 | **$0.52** |
| Haiku | 33,488 | **$0.05** |

A 40-question run over two arms is 80 calls. That is roughly **$4 on Haiku** and
**$42 on Opus**. The default is Haiku for exactly this reason. Override with
`--model` or `llm.model` when you want a stronger model for the scorecard, and
know what you are buying.

### Anthropic API directly

Materially cheaper per question, because it carries only this project's own
system prompt rather than Claude Code's:

```json
{ "llm": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001" } }
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

The direct provider cannot expose MCP tools to the model, so it can only run
the raw-SQL arm. The tool-using arm requires the `claude-code` provider.

## Troubleshooting

**`claude mcp list` shows it but the tools never appear in a nested `claude -p`.**
Headless runs do not inherit registered servers. Pass them explicitly:

```bash
claude -p "..." \
  --mcp-config '{"mcpServers":{"mmex":{"command":"npx","args":["-y","mmex-mcp"],"env":{"MMEX_MCP_DB":"/abs/path/finances.mmb"}}}}' \
  --allowedTools "mcp__mmex"
```

**"Database is locked".** Money Manager EX is holding it. Either close MMEX or
add `--snapshot` to read a temporary copy.

**"Not an unencrypted SQLite database".** Encrypted `.emb` files are not
supported yet. Open it in MMEX and save an unencrypted copy.

**The server writes nothing to stdout but protocol.** If you are debugging, look
at stderr. stdout is the MCP transport and anything else on it corrupts the
stream.
