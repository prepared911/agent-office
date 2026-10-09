# The Agent Keep: notes for Claude

A local, zero-dependency visualizer that shows running Claude Code and Cursor agents (and their subagents) as characters in a pixel-art medieval hall. It's an in-house replacement for the third-party "Pixel Agents" extension: third-party extensions aren't allowed on this laptop. See README.md for usage.

## Ground rules

- **No dependencies.** Node built-ins only (`node:sqlite` for Cursor titles). No npm packages, no CDN scripts, no downloaded art: every sprite is drawn in code in `index.html`.
- **Local and read-only.** Bind `127.0.0.1` only and keep the `Host` check (it blocks DNS rebinding). Only read transcript files; never modify Claude Code or Cursor settings, hooks or databases without an explicit go-ahead from the user.
- **No transcript content leaves the server.** The page receives titles, subagent descriptions, project and branch names, tool names and states, never prompts, code or tool output.
- **Port 7331.** Avoid 4317 and 4318: an OpenTelemetry collector (OrbStack) listens there on this machine.
- The transcript formats are undocumented. Parse defensively and skip unknown lines.

## Layout

- `server.mjs` checks transcript folders every 0.7s, reads only the new lines of each file, keeps one state per agent, and streams snapshots over Server-Sent Events (`/events`; `/state` returns JSON for debugging).
- `index.html` has the Canvas 2D renderer, a state-to-animation map, and a table.
- `demo.mjs` writes fake Claude Code and Cursor sessions to `demo-projects/` (gitignored). Run with:
  `CLAUDE_PROJECTS_DIR=./demo-projects/claude CURSOR_PROJECTS_DIR=./demo-projects/cursor CURSOR_STATE_DB= PORT=7332 node server.mjs` and `node demo.mjs`

## What's known about each source

**Claude Code (works, verified live):** `~/.claude/projects/<slug>/<session>.jsonl`, with subagents in `<session>/subagents/agent-<id>.jsonl` plus `.meta.json` (agentType, description, toolUseId). Lines carry timestamps, tool-call ids and tool results.

**Cursor local agents (works on recorded history; live behavior not yet verified):** `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, with subagents in `<id>/subagents/<subId>.jsonl`. Lines are `{role, message}` plus `{"type":"turn_ended"}`, with no timestamps, tool ids or tool results. Subagents are linked by matching their first user message to a parent `Task` call's `prompt`. Titles are read (read-only) from `…/Cursor/User/globalStorage/state.vscdb`, table `cursorDiskKV`, key `composerData:<id>`, field `name`. **Open question:** does Cursor append lines while a turn runs, or only at the end? Check by watching a file's size during a local agent run.

**Cursor cloud agents (v1 API, GET only):** IDs start with `bc-`. They run on Cursor's servers and write no local transcript. Do not read synced bubbles (`bubbleId:bc-<id>:<bubbleId>`) or `composerData:bc-<id>` for live state: on 2026-09-23 that sync lagged active work by about 1h15m. Do not read `~/Library/Application Support/Cursor/AgentStores/cursor_agent_stores/<id>/files/`; those are private work notes. Do not use hooks: hosted cloud hooks run inside the VM, and `sessionStart` / `sessionEnd` do not run there.

Live state comes from `https://api.cursor.com` ([endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)), with `CURSOR_API_KEY`. There is no read-only key scope, so `server.mjs` must keep sending only GET. It checks `GET /v1/me` once, lists `GET /v1/agents?includeArchived=false&limit=100` every `CLOUD_POLL_MS` (default 60s, floor 1s), and loads each new agent's full metadata once at no more than 20/minute. Group by repository basename from `repos[].url`, then named `env`, then `Unassigned`; combine multiple repositories under a `Multi-project` label. It opens `GET /v1/agents/{id}/runs/{runId}/stream` for each `ACTIVE` agent. Resume with `Last-Event-ID`. On `410 stream_expired`, GET that run and do not reopen the stream. Keep the agent name, run status, tool name and running/completed, repo basename, named environment, and branch. Drop assistant text, thinking, tool arguments, tool results, and pull-request URLs immediately. A rejected key or a failed poll must not affect the local transcript scan.

Cloud agents use `source: 'cursor-cloud'` and the teal `HOUSE` entry in `index.html`, separate from local Cursor's blue carpet. They live in `cloudAgents`, not the transcript map, so the file scan does not prune them. `node demo.mjs` serves a stand-in on port 7334; `node demo.mjs --check` asserts the privacy boundary.

## Known limits

- "Beset" (stuck or waiting for permission) is a guess: a tool call still unanswered after 10s. For Cursor it's rougher, since file modification time stands in for timestamps. Hooks would make it exact, but they change the tools' config, so they need the user's approval first.
- Cursor's built-in Browser Tab showed a blank gray page and never connected to the server. Simple Browser (Command Palette → "Simple Browser: Show") or a normal browser works.
