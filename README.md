# The Agent Keep

A pixel-art medieval hall where your running Claude Code and Cursor agents, their subagents, and your Cursor cloud agents sit at scribes' desks and animate based on what they're doing. It's an in-house take on Pixel Agents, with no dependencies (Node 22.5+ built-ins only).

```bash
node server.mjs          # then open http://127.0.0.1:7331
```

Cursor cloud agents are off until you set a key. The key is created at Cursor Dashboard → API Keys. Cursor does not offer a read-only scope for this API, so the key can also create and cancel agents; this program never does, because it only sends GET.

```bash
export CURSOR_API_KEY=...   # user API key; never commit it
node server.mjs
```

The macOS launcher (`MAC-APP.md`) fetches the key from 1Password instead. Copy `.env.example` to `.env` and set `CURSOR_API_KEY_OP_ITEM` to your own item ID; `.env` is gitignored.

To try it without real agents, play fake Claude Code and Cursor sessions that spawn subagents. `demo.mjs` also serves a local Cloud Agents stand-in on port 7334 and keeps running so that stand-in stays up:

```bash
CLAUDE_PROJECTS_DIR=./demo-projects/claude CURSOR_PROJECTS_DIR=./demo-projects/cursor \
  CURSOR_API_BASE=http://127.0.0.1:7334 CURSOR_API_KEY=demo-key-not-real \
  CLOUD_POLL_MS=1000 PORT=7332 node server.mjs &
node demo.mjs            # open http://127.0.0.1:7332; Ctrl+C, then re-run to replay
```

`node demo.mjs --check` runs the cloud stand-in against a temporary server and fails if prompt text, tool arguments, tool results, or the API key show up in `/state` or the server log.

## How it works

- `server.mjs` checks both tools' transcript folders every 0.7s. It reads only the new lines of each file, turns them into one state per agent, and pushes that state to the page over Server-Sent Events.
- When `CURSOR_API_KEY` is set, it also polls Cursor's [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) once a minute and opens one stream per active run. A new cloud agent can take up to that minute to appear. One that is already running updates as the stream arrives.
- The hall and table are divided into project sections. Local sessions use their workspace name. A newly discovered cloud agent is looked up once with `GET /v1/agents/{id}` and grouped by `repos[].url`; a named environment is the fallback, then `Unassigned`. Multi-repository agents get a combined `Multi-project` section.
- `index.html` draws the hall on a Canvas 2D. Every sprite is drawn in code with `fillRect`; there are no image assets.
- It reads files only. Neither tool's settings or hooks are changed.

### Claude Code

- Sessions: `~/.claude/projects/<slug>/<session>.jsonl`
- Subagents: `<slug>/<session>/subagents/agent-<id>.jsonl`, plus a `.meta.json` that gives the type, the description and the parent's `Agent` tool-call id.
- Lines have timestamps, tool-call ids and tool results, so "how long has this tool been running" is exact.
- Titles come from `custom-title` and `ai-title` lines.

### Cursor

- Sessions: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`
- Subagents: `<id>/subagents/<subId>.jsonl`. There is no meta file. A subagent is linked to the parent's `Task` call whose `prompt` begins its first message; that call gives `subagent_type` and `description`. A forked subagent (whose file starts with its own `Task` call) is labeled from that call.
- Lines are `{role, message}` plus `{"type":"turn_ended"}`, with **no timestamps, tool ids or tool results**. The newest tool call counts as current until the next line appears, and the file's modification time stands in for timestamps.
- MCP tools are wrapped as `CallDynamicTool` or `CallMcpTool`; the real tool name comes from `toolName`.
- Chat titles are read from Cursor's own database (`…/Cursor/User/globalStorage/state.vscdb`, key `composerData:<id>`). The database is opened **read-only** for a single indexed lookup, at most once a minute per chat. Without it, titles fall back to `Cursor chat <id>`.

### Cursor Cloud

Cloud agents do not write a local transcript. The keep polls `GET /v1/agents?includeArchived=false&limit=100` and follows `nextCursor`. It loads each new agent's full record once, spacing metadata calls to stay within the standard API limit, and retains only repository basenames or the named environment for grouping. For each agent whose status is `ACTIVE`, it reads the run stream at `GET /v1/agents/{id}/runs/{runId}/stream` and resumes with `Last-Event-ID` after a disconnect. On `410 stream_expired` it reads `GET /v1/agents/{id}/runs/{runId}` instead of reopening the stream, and retries that read on a later poll if it fails.

`CREATING` is pondering, `RUNNING` follows the current tool (or conjuring when the tool name is unknown), and a finished, failed, cancelled, or expired run is "awaits thee". `IDLE` agents stay in the hall the same way a local session does after its turn. Archived agents, and agents that disappear from the list, walk out.

The stream carries assistant text, thinking, tool arguments, and tool results. Those are parsed only long enough to drop them. What is kept is the agent name, run status, tool name and whether it is running or completed, the repo's basename, and the branch name. The key is read from the environment and is never written to the page or the log. A missing or rejected key leaves local agents running; a `429` waits for `Retry-After`.

`GET /v1/me` runs once at startup to confirm the key. Hooks are not used: cloud hooks run inside the remote VM, not on this machine. Synced copies of cloud chats in Cursor's local database are ignored because they lag the live run.

## Who's who

- **Monarch** (crown, cape, throne): a session. A **crimson carpet** means Claude Code; a **blue carpet** means Cursor; a **teal carpet** means Cursor Cloud.
- **Knight** (steel helm, plume): a `general-purpose` / `generalPurpose` subagent
- **Ranger** (green hood): an `Explore` / `explore` subagent
- **Wizard** (pointed hat): a `Plan` subagent
- **Monk** (brown hood): any other subagent type

The open tome on each desk shows what the agent is doing: ink appearing (scribing), pages turning (studying), glowing runes (conjuring), or a campaign map (commanding subagents). The tome is closed when the agent is waiting for you.

## States

| Tool call (Claude Code / Cursor) | State |
|---|---|
| Edit, Write, NotebookEdit / StrReplace, Write, Edit, Delete | scribing |
| Read, Grep, Glob, Web*, MCP tools / Read, Grep, Glob, rg, ReadLints, Web*, MCP tools | studying |
| Bash / Shell, AwaitShell, and anything unrecognized | conjuring |
| Agent / Task | commanding (subagents walk in through the gate) |
| AskUserQuestion, ExitPlanMode / AskQuestion | awaits thee (it's asking you something) |
| a tool call still unanswered after 10s | beset: stuck, maybe waiting for permission (a guess, not certain) |
| end of turn or an interrupt | awaits thee; after 10 min, slumbering |
| subagent finishes | it walks out through the gate |

## Security

- Binds to `127.0.0.1` only and rejects requests whose `Host` isn't loopback, which blocks DNS rebinding.
- Sends only titles, subagent descriptions, project and branch names, and tool names. Prompts, code and tool output never leave the server. The first line of each Cursor subagent is kept in server memory only, to link it to its parent.
- The Cloud Agents key stays in the server process. Cloud requests are GET only. Assistant text, thinking, tool arguments, tool results, and pull-request URLs from the API are discarded before a snapshot is built.
- The default port is 7331. Avoid 4317 and 4318: they're the standard OpenTelemetry ports, and binding them on loopback can intercept a local telemetry collector.

## Settings (environment variables)

- `PORT` (default 7331)
- `ACTIVE_MINUTES`: hide sessions that have been quiet longer than this (default 30)
- `CLAUDE_PROJECTS_DIR`: Claude Code transcripts (default `~/.claude/projects`)
- `CURSOR_PROJECTS_DIR`: Cursor transcripts (default `~/.cursor/projects`)
- `CURSOR_STATE_DB`: Cursor's database, used for chat titles; set it empty to turn title lookup off
- `CURSOR_API_KEY`: user API key for Cursor cloud agents. Leave it unset to skip them. There is no read-only scope; the keep still only sends GET
- `CURSOR_API_BASE`: Cloud Agents API origin (default `https://api.cursor.com`). The demo stand-in is `http://127.0.0.1:7334`
- `CLOUD_POLL_MS`: how often to list cloud agents, in milliseconds (default 60000, minimum 1000). The macOS launcher reads this from `.env`

Neither tool documents its transcript format, so an update to either may change it. Unknown lines are skipped.
