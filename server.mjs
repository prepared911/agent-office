#!/usr/bin/env node
// The Agent Keep: watches Claude Code and Cursor agent transcripts, and Cursor
// cloud agents, and streams per-agent state (never transcript content) to a
// local pixel-art page.
// Zero dependencies: node built-ins only (node:sqlite for Cursor chat titles,
// fetch for the Cloud Agents API).

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CLAUDE_ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const CURSOR_ROOT = process.env.CURSOR_PROJECTS_DIR || path.join(HOME, '.cursor', 'projects');
const CURSOR_DB = process.env.CURSOR_STATE_DB ?? defaultCursorDb();
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 7331);
const SCAN_MS = 700;
// The Cloud Agents key can also create and cancel agents. This process only
// ever sends GET, and the poll stays at or below once a second.
const CURSOR_API_KEY = process.env.CURSOR_API_KEY || '';
const CURSOR_API_BASE = (process.env.CURSOR_API_BASE || 'https://api.cursor.com').replace(/\/$/, '');
const CLOUD_POLL_MS = Math.max(1000, Number(process.env.CLOUD_POLL_MS) || 60_000);
const ACTIVE_MS = Number(process.env.ACTIVE_MINUTES || 30) * 60_000; // hide sessions quiet longer than this
const TAIL_BYTES = 512 * 1024; // first read of an existing file only looks at its tail
const DONE_LINGER_MS = 6_000; // finished subagents stay visible briefly before walking out
const TITLE_REFRESH_MS = 60_000;

const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* titles fall back to ids */ }

function defaultCursorDb() {
  const rel = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', ...rel);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', ...rel);
  return path.join(HOME, '.config', ...rel);
}

/** @type {Map<string, FileCursor>} file path -> read position */
const cursors = new Map();
/** @type {Map<string, Agent>} agent key -> state */
const agents = new Map();
/** Claude Agent tool_use id -> key of the agent that issued it (for parent links). */
const spawnedBy = new Map();
/** Finished agent key -> file size when it finished; revived only if the file grows. */
const tombstones = new Map();

let dirty = true;

// ---------- transcript discovery ----------

/**
 * @typedef {{ source: 'claude'|'cursor', file: string, kind: 'session'|'subagent', slug: string,
 *   sessionId: string, agentId?: string, size: number, mtimeMs: number }} Transcript
 */

const readdir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
function safeStat(f) { try { return fs.statSync(f); } catch { return null; } }

function pushIfActive(out, t, cutoff) {
  const st = safeStat(t.file);
  if (st && st.mtimeMs >= cutoff) out.push({ ...t, size: st.size, mtimeMs: st.mtimeMs });
}

// ~/.claude/projects/<slug>/<session>.jsonl  +  <slug>/<session>/subagents/agent-<id>.jsonl (+ .meta.json)
function listClaude(cutoff) {
  const out = [];
  for (const p of readdir(CLAUDE_ROOT)) {
    if (!p.isDirectory()) continue;
    const dir = path.join(CLAUDE_ROOT, p.name);
    for (const e of readdir(dir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        pushIfActive(out, { source: 'claude', file: path.join(dir, e.name), kind: 'session', slug: p.name, sessionId: e.name.slice(0, -6) }, cutoff);
      } else if (e.isDirectory()) {
        const subDir = path.join(dir, e.name, 'subagents');
        for (const s of readdir(subDir)) {
          if (!s.name.startsWith('agent-') || !s.name.endsWith('.jsonl')) continue;
          pushIfActive(out, { source: 'claude', file: path.join(subDir, s.name), kind: 'subagent', slug: p.name, sessionId: e.name, agentId: s.name.slice(6, -6) }, cutoff);
        }
      }
    }
  }
  return out;
}

// ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl  +  <id>/subagents/<subId>.jsonl
function listCursor(cutoff) {
  const out = [];
  for (const p of readdir(CURSOR_ROOT)) {
    if (!p.isDirectory() || p.name.startsWith('.')) continue;
    const dir = path.join(CURSOR_ROOT, p.name, 'agent-transcripts');
    for (const e of readdir(dir)) {
      if (!e.isDirectory()) continue;
      const base = path.join(dir, e.name);
      pushIfActive(out, { source: 'cursor', file: path.join(base, `${e.name}.jsonl`), kind: 'session', slug: p.name, sessionId: e.name }, cutoff);
      for (const s of readdir(path.join(base, 'subagents'))) {
        if (!s.name.endsWith('.jsonl')) continue;
        pushIfActive(out, { source: 'cursor', file: path.join(base, 'subagents', s.name), kind: 'subagent', slug: p.name, sessionId: e.name, agentId: s.name.slice(0, -6) }, cutoff);
      }
    }
  }
  return out;
}

// ---------- incremental reading ----------

/** @typedef {{ offset: number, partial: string }} FileCursor */

function readNewLines(t) {
  let cur = cursors.get(t.file);
  let start;
  let skipFirst = false;
  if (!cur) {
    start = Math.max(0, t.size - TAIL_BYTES);
    skipFirst = start > 0; // we landed mid-line
    cur = { offset: start, partial: '' };
    cursors.set(t.file, cur);
  } else {
    if (t.size < cur.offset) { cur.offset = 0; cur.partial = ''; } // truncated/rewritten
    start = cur.offset;
  }
  if (t.size <= start) return [];
  const len = t.size - start;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(t.file, 'r');
    fs.readSync(fd, buf, 0, len, start);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
  cur.offset = t.size;
  const text = cur.partial + buf.toString('utf8');
  const lines = text.split('\n');
  cur.partial = lines.pop() ?? '';
  if (skipFirst) lines.shift();
  const parsed = [];
  for (const l of lines) {
    if (!l) continue;
    try { parsed.push(JSON.parse(l)); } catch { /* unknown or partial line: ignore */ }
  }
  return parsed;
}

// ---------- state model ----------

/**
 * @typedef {Object} Agent
 * @property {string} key
 * @property {'claude'|'cursor'|'cursor-cloud'} source
 * @property {'session'|'subagent'} kind
 * @property {string} sessionKey
 * @property {string|null} parentKey
 * @property {string} project      basename of the workspace
 * @property {string} title        session title or subagent description
 * @property {string|null} agentType
 * @property {string|null} branch
 * @property {string} state        thinking | typing | reading | running | delegating | waiting | done
 * @property {string|null} tool    current tool name
 * @property {Map<string,{name:string,ts:number}>} pending  unanswered tool calls
 * @property {number} lastTs
 * @property {number|null} doneAt
 */

// Tool names from both Claude Code and Cursor.
const TOOL_STATE = {
  Edit: 'typing', MultiEdit: 'typing', Write: 'typing', NotebookEdit: 'typing', StrReplace: 'typing', Delete: 'typing', EditNotebook: 'typing',
  Read: 'reading', ReadFile: 'reading', Grep: 'reading', Glob: 'reading', LS: 'reading', rg: 'reading', ReadLints: 'reading',
  WebFetch: 'reading', WebSearch: 'reading', ToolSearch: 'reading', GetDynamicTools: 'reading', GetMcpTools: 'reading', SearchConversations: 'reading',
  read_file: 'reading',
  Bash: 'running', BashOutput: 'running', Monitor: 'running', KillShell: 'running', Shell: 'running', AwaitShell: 'running', Await: 'running',
  run_terminal_cmd: 'running',
  Agent: 'delegating', Task: 'delegating',
  AskUserQuestion: 'waiting', ExitPlanMode: 'waiting', AskQuestion: 'waiting',
  TodoWrite: 'thinking', UpdateCurrentStep: 'thinking', CreatePlan: 'thinking',
};

function stateForTool(name) {
  if (TOOL_STATE[name]) return TOOL_STATE[name];
  if (name === 'mcp' || name.startsWith('mcp__')) return 'reading';
  return 'running';
}

function setTool(a, name) {
  a.tool = name; a.state = stateForTool(name); a.doneAt = null;
}

function ensureAgent(t) {
  const sessionKey = `${t.source}:${t.slug}/${t.sessionId}`;
  const key = t.kind === 'session' ? sessionKey : `${sessionKey}/${t.agentId}`;
  let a = agents.get(key);
  if (!a) {
    a = {
      key, source: t.source, file: t.file, kind: t.kind, sessionKey, parentKey: t.kind === 'session' ? null : sessionKey,
      id: t.kind === 'session' ? t.sessionId : t.agentId,
      project: projectFromSlug(t.slug), title: '', agentType: null, branch: null,
      state: 'thinking', tool: null, pending: new Map(), lastTs: t.mtimeMs, doneAt: null,
    };
    if (t.source === 'claude' && t.kind === 'subagent') loadClaudeMeta(a, t);
    agents.set(key, a);
    dirty = true;
  }
  return a;
}

function finishTurn(a, ts) {
  a.pending.clear();
  a.tool = null;
  if (a.kind === 'subagent') { a.state = 'done'; a.doneAt = a.doneAt ?? ts ?? Date.now(); }
  else a.state = 'waiting';
}

// Slugs are paths with '/' turned into '-', which is ambiguous when folder names
// contain '-'. Walk the real filesystem to find the folder the slug came from.
const slugCache = new Map();
function projectFromSlug(slug) {
  if (slugCache.has(slug)) return slugCache.get(slug);
  const tokens = slug.replace(/^-/, '').split('-');
  let dir = path.sep, i = 0, name = slug;
  while (i < tokens.length && tokens.length < 40) {
    let found = false;
    for (let j = tokens.length; j > i; j--) {
      const part = tokens.slice(i, j).join('-');
      for (const cand of [part, '.' + part]) {
        if (part && safeStat(path.join(dir, cand))?.isDirectory()) { dir = path.join(dir, cand); name = cand; i = j; found = true; break; }
      }
      if (found) break;
    }
    if (!found) { name = tokens.slice(i).join('-') || name; break; }
  }
  slugCache.set(slug, name);
  return name;
}

// ---------- Claude Code lines ----------

function loadClaudeMeta(a, t) {
  const metaFile = t.file.replace(/\.jsonl$/, '.meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    a.agentType = meta.agentType ?? null;
    a.title = meta.description ?? '';
    a.toolUseId = meta.toolUseId ?? null;
    a.metaLoaded = true;
  } catch { a.metaLoaded = false; }
}

function tsOf(line) {
  const n = line.timestamp ? Date.parse(line.timestamp) : NaN;
  return Number.isFinite(n) ? n : null;
}

function applyClaude(a, line) {
  const ts = tsOf(line);
  if (ts) a.lastTs = Math.max(a.lastTs, ts);
  if (line.cwd) a.project = path.basename(line.cwd);
  if (line.gitBranch) a.branch = line.gitBranch;

  switch (line.type) {
    case 'custom-title':
      if (line.customTitle) { a.title = line.customTitle; a.hasCustomTitle = true; }
      return;
    case 'ai-title':
      if (line.aiTitle && !a.hasCustomTitle) a.title = line.aiTitle;
      return;
    case 'assistant': {
      const content = line.message?.content ?? [];
      for (const b of content) {
        if (b.type === 'tool_use') {
          a.pending.set(b.id, { name: b.name, ts: ts ?? Date.now() });
          if (b.name === 'Agent' || b.name === 'Task') spawnedBy.set(b.id, a.key);
        }
      }
      const stop = line.message?.stop_reason;
      if (content.some(b => b.type === 'tool_use')) {
        setTool(a, [...a.pending.values()].pop().name);
      } else if (stop === 'end_turn' || stop === 'stop_sequence') {
        finishTurn(a, ts);
      } else {
        a.state = 'thinking'; a.tool = null; a.doneAt = null;
      }
      return;
    }
    case 'user': {
      const c = line.message?.content;
      if (typeof c === 'string') {
        if (c.startsWith('[Request interrupted')) finishTurn(a, ts);
        else { a.state = 'thinking'; a.tool = null; a.doneAt = null; }
        return;
      }
      if (!Array.isArray(c)) return;
      let sawResult = false;
      for (const b of c) {
        if (b.type === 'tool_result') {
          sawResult = true;
          a.pending.delete(b.tool_use_id);
          markClaudeSubagentReturned(b.tool_use_id, ts);
        } else if (b.type === 'text' && b.text?.startsWith('[Request interrupted')) {
          finishTurn(a, ts); return;
        }
      }
      if (sawResult) {
        if (a.pending.size) setTool(a, [...a.pending.values()].pop().name);
        else { a.state = 'thinking'; a.tool = null; }
      } else if (!line.isMeta) {
        a.state = 'thinking'; a.tool = null; a.doneAt = null;
      }
      return;
    }
    case 'system':
      if (line.subtype === 'stop_hook_summary' && a.pending.size === 0) finishTurn(a, ts);
      return;
  }
}

function markClaudeSubagentReturned(toolUseId, ts) {
  for (const a of agents.values()) {
    if (a.source === 'claude' && a.kind === 'subagent' && a.toolUseId === toolUseId && a.state !== 'done') {
      a.state = 'done'; a.tool = null; a.doneAt = ts ?? Date.now(); dirty = true;
    }
  }
}

// ---------- Cursor lines ----------
// Cursor writes {role, message:{content}} lines plus {"type":"turn_ended"}. There are no
// timestamps, tool ids or tool results, so the newest tool call is the current one until
// the next line lands, and file mtime stands in for time.

function cursorTool(b) {
  const inp = b.input && typeof b.input === 'object' ? b.input : {};
  if (b.name === 'CallDynamicTool' || b.name === 'CallMcpTool') {
    const n = inp.toolName || b.name;
    const ns = inp.namespace || inp.server || '';
    const args = inp.arguments && typeof inp.arguments === 'object' ? inp.arguments : {};
    return { name: !ns || ns === 'cursor' ? n : `mcp__${ns}__${n}`, args };
  }
  return { name: b.name, args: inp };
}

const textOf = (content) => content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n');

function applyCursor(a, line, t) {
  if (line.type === 'turn_ended') { finishTurn(a, t.mtimeMs); return; }
  const content = line.message?.content;
  if (!Array.isArray(content)) return;
  a.pending.clear();
  if (line.role === 'user') {
    // Kept in memory only, to match a subagent to the Task call that spawned it.
    if (a.kind === 'subagent' && a.firstText === undefined) a.firstText = textOf(content).slice(0, 2000);
    a.state = 'thinking'; a.tool = null; a.doneAt = null;
    return;
  }
  if (line.role !== 'assistant') return;
  const uses = content.filter(b => b?.type === 'tool_use').map(cursorTool);
  if (a.kind === 'subagent' && a.firstText === undefined) {
    // A forked subagent's file starts with its own Task call rather than a prompt.
    a.firstText = '';
    const fork = uses.find(u => u.name === 'Task');
    if (fork) { a.agentType = fork.args.subagent_type || 'fork'; a.title ||= fork.args.description || ''; a.matched = true; }
  }
  if (!uses.length) { a.state = 'thinking'; a.tool = null; a.doneAt = null; return; }
  for (const u of uses) {
    if (u.name === 'Task' && a.kind === 'session' && typeof u.args.prompt === 'string') {
      (a.taskPrompts ??= []).push({ head: u.args.prompt.slice(0, 120), type: u.args.subagent_type || null, description: u.args.description || '' });
      if (a.taskPrompts.length > 50) a.taskPrompts.shift();
    }
  }
  const last = uses.at(-1);
  a.pending.set('current', { name: last.name, ts: t.mtimeMs });
  setTool(a, last.name);
}

function matchCursorSubagent(a) {
  if (a.matched || !a.firstText) return;
  const parent = agents.get(a.sessionKey);
  const hit = parent?.taskPrompts?.find(p => p.head && a.firstText.includes(p.head));
  if (!hit) return;
  a.matched = true;
  a.agentType = hit.type || 'task';
  if (!a.title) a.title = hit.description;
  dirty = true;
}

// Cursor keeps chat names in its settings database, keyed by the transcript id.
function cursorTitle(id) {
  if (!sqlite || !CURSOR_DB || !fs.existsSync(CURSOR_DB)) return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(CURSOR_DB, { readOnly: true });
    const row = db.prepare("SELECT json_extract(value, '$.name') AS name FROM cursorDiskKV WHERE key = ?").get(`composerData:${id}`);
    return row?.name || null;
  } catch { return null; } finally { try { db?.close(); } catch { /* ignore */ } }
}

function refreshCursorTitle(a, now) {
  if (a.titleCheckedAt && now - a.titleCheckedAt < TITLE_REFRESH_MS) return;
  a.titleCheckedAt = now;
  const name = cursorTitle(a.id);
  if (name && (a.kind === 'session' || !a.title) && name !== a.title) { a.title = name; dirty = true; }
  if (!a.title && a.kind === 'session') a.title = `Cursor chat ${a.id.slice(0, 8)}`;
}

// ---------- scan loop ----------

function scan() {
  const seen = new Set();
  const cutoff = Date.now() - ACTIVE_MS;
  // Sessions first so parent links resolve before their subagents' first lines.
  const files = [...listClaude(cutoff), ...listCursor(cutoff)]
    .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'session' ? -1 : 1));
  for (const t of files) {
    const k = `${t.source}:${t.slug}/${t.sessionId}` + (t.kind === 'subagent' ? `/${t.agentId}` : '');
    if (tombstones.get(k) === t.size) continue; // finished and nothing new since
    tombstones.delete(k);
    const a = ensureAgent(t);
    seen.add(a.key);
    if (a.source === 'claude' && a.kind === 'subagent' && !a.metaLoaded) loadClaudeMeta(a, t);
    const lines = readNewLines(t);
    for (const l of lines) (a.source === 'claude' ? applyClaude(a, l) : applyCursor(a, l, t));
    if (lines.length) { dirty = true; if (a.source === 'cursor') a.lastTs = Math.max(a.lastTs, t.mtimeMs); }
  }
  const now = Date.now();
  for (const [key, a] of agents) {
    if (a.source === 'claude' && a.kind === 'subagent' && a.toolUseId && spawnedBy.has(a.toolUseId)) {
      a.parentKey = spawnedBy.get(a.toolUseId);
    }
    if (a.source === 'cursor') {
      if (a.kind === 'subagent') matchCursorSubagent(a);
      refreshCursorTitle(a, now);
    }
    const tooOld = now - a.lastTs > ACTIVE_MS;
    const doneLongAgo = a.state === 'done' && now - Math.max(a.doneAt ?? 0, a.lastTs) > DONE_LINGER_MS;
    if (doneLongAgo) tombstones.set(key, cursors.get(a.file)?.offset);
    if (!seen.has(key) || tooOld || doneLongAgo) { agents.delete(key); dirty = true; }
  }
  // A subagent whose session vanished has nowhere to sit.
  for (const [key, a] of agents) {
    if (a.kind === 'subagent' && !agents.has(a.sessionKey)) { agents.delete(key); dirty = true; }
  }
}

function snapshot() {
  const now = Date.now();
  return {
    now,
    agents: [...agents.values(), ...cloudAgents.values()].map(a => {
      const oldestPending = [...a.pending.values()].reduce((m, p) => Math.min(m, p.ts), Infinity);
      const pendingForMs = Number.isFinite(oldestPending) ? now - oldestPending : 0;
      return {
        key: a.key,
        source: a.source,
        kind: a.kind,
        parentKey: a.parentKey,
        sessionKey: a.sessionKey,
        project: a.project,
        title: a.title,
        agentType: a.agentType,
        branch: a.branch,
        state: a.state,
        tool: a.tool,
        pendingForMs,
        idleForMs: now - a.lastTs,
      };
    }),
  };
}

// ---------- Cursor cloud agents ----------
// Polled from the v1 Cloud Agents API. There is no local transcript. A separate
// map keeps these out of the file scan, which would otherwise prune them.

/** @type {Map<string, Agent>} */
const cloudAgents = new Map();
/** @type {Map<string, CloudStream>} agent id -> live run stream */
const cloudStreams = new Map();
const cloudMetadataQueue = new Set();
let cloudMetadataTimer = null;
let cloudMetadataBusy = false;
const RUN_TERMINAL = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

/**
 * @typedef {Object} CloudStream
 * @property {string} runId
 * @property {AbortController} abort
 * @property {string} lastEventId
 * @property {boolean} stopped
 * @property {boolean} gaveUp
 * @property {number} attempts
 * @property {ReturnType<typeof setTimeout>|null} timer
 */

function cloudKey(id) { return `cursor-cloud:${id}`; }

function retryAfterMs(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function cursorFetch(pathname, headers, signal) {
  if (!pathname.startsWith('/v1/')) throw new Error('refusing non-cloud-agent path');
  return fetch(CURSOR_API_BASE + pathname, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${CURSOR_API_KEY}`, ...headers },
    signal,
    redirect: 'error',
  });
}

async function cursorGetJson(pathname) {
  const res = await cursorFetch(pathname);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const err = new Error('Cursor API request failed');
    err.status = res.status;
    err.code = body && typeof body.code === 'string' ? body.code : '';
    err.retryAfterMs = retryAfterMs(res.headers.get('retry-after'));
    throw err;
  }
  return body && typeof body === 'object' ? body : {};
}

async function drain(res) {
  try { await res.body?.cancel(); } catch { /* already closed */ }
}

/** Branch name and repo basename only. Pull-request URLs are not kept. */
function pickGit(git) {
  const branches = Array.isArray(git?.branches) ? git.branches : [];
  for (const b of branches) {
    if (!b || typeof b.branch !== 'string' || !b.branch) continue;
    const repo = typeof b.repoUrl === 'string' ? b.repoUrl : '';
    return { branch: b.branch, project: repo.split('/').filter(Boolean).pop() || '' };
  }
  return null;
}

function applyCloudGit(a, git) {
  // Full agent metadata is the authoritative grouping source. A run may report
  // only the repository whose branch was pushed, which would collapse a
  // multi-repository agent into the wrong section.
  if (!a.metadataLoaded && git.project && git.project !== a.project) { a.project = git.project; dirty = true; }
  if (git.branch && git.branch !== a.branch) { a.branch = git.branch; dirty = true; }
}

function repoName(url) {
  if (typeof url !== 'string') return '';
  return url.replace(/\/+$/, '').split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || '';
}

function projectFromCloudMetadata(body) {
  const repos = Array.isArray(body.repos) ? body.repos : [];
  const names = [...new Set(repos.map(r => repoName(r?.url)).filter(Boolean))];
  if (names.length === 1) return names[0];
  if (names.length > 1) return `Multi-project: ${names.join(' + ')}`;
  const envName = typeof body.env?.name === 'string' ? body.env.name.trim() : '';
  return envName ? `Environment: ${envName}` : 'Unassigned';
}

async function loadCloudMetadata(a) {
  if (a.metadataLoaded || a.metadataLoading) return;
  a.metadataLoading = true;
  try {
    const body = await cursorGetJson(`/v1/agents/${encodeURIComponent(a.id)}`);
    const agent = cloudAgents.get(a.key);
    if (!agent) return;
    const project = projectFromCloudMetadata(body);
    if (project !== agent.project) { agent.project = project; dirty = true; }
    agent.metadataLoaded = true;
  } catch (err) {
    // Retry on the next discovery poll. Metadata failure must not hide the
    // agent or disturb its live run stream.
    console.error(`cloud metadata failed: ${err.status || 'offline'}`);
  } finally {
    const agent = cloudAgents.get(a.key);
    if (agent) agent.metadataLoading = false;
  }
}

function queueCloudMetadata(a) {
  if (a.metadataLoaded || a.metadataLoading || cloudMetadataQueue.has(a.key)) return;
  cloudMetadataQueue.add(a.key);
  if (!cloudMetadataBusy && !cloudMetadataTimer) cloudMetadataTimer = setTimeout(pumpCloudMetadata, 0);
}

async function pumpCloudMetadata() {
  cloudMetadataTimer = null;
  const key = cloudMetadataQueue.values().next().value;
  if (!key) return;
  cloudMetadataQueue.delete(key);
  const a = cloudAgents.get(key);
  cloudMetadataBusy = true;
  try {
    if (a) await loadCloudMetadata(a);
  } finally {
    cloudMetadataBusy = false;
  }
  // The standard API limit is 20 requests/minute. Metadata is durable, so
  // loading one new record every 3.1s is fast enough without a startup burst.
  if (cloudMetadataQueue.size) cloudMetadataTimer = setTimeout(pumpCloudMetadata, 3100);
}

function applyCloudRunStatus(a, status) {
  if (!status) return;
  if (status === 'CREATING') {
    a.pending.clear(); a.tool = null; a.state = 'thinking'; a.doneAt = null;
  } else if (status === 'RUNNING') {
    a.doneAt = null;
    if (a.pending.size) setTool(a, [...a.pending.values()].at(-1).name);
    else if (!a.tool) { a.state = 'running'; a.tool = null; }
  } else if (RUN_TERMINAL.has(status)) {
    a.pending.clear(); a.tool = null; a.state = 'waiting'; a.doneAt = null;
    a.lastTs = Date.now();
    if (a.runId) a.runSettled = a.runId;
  }
  dirty = true;
}

function cloudIsVisible(item, now) {
  if (item.status !== 'ACTIVE' && item.status !== 'IDLE') return false;
  const ts = Date.parse(item.updatedAt);
  if (item.status !== 'ACTIVE' && Number.isFinite(ts) && now - ts > ACTIVE_MS) return false;
  return true;
}

function upsertCloud(item, now) {
  const key = cloudKey(item.id);
  const ts = Date.parse(item.updatedAt);
  const lastTs = Number.isFinite(ts) ? ts : now;
  let a = cloudAgents.get(key);
  if (!a) {
    a = {
      key, source: 'cursor-cloud', kind: 'session', sessionKey: key, parentKey: null,
      id: item.id, project: '', title: '', agentType: null, branch: null,
      state: item.status === 'IDLE' ? 'waiting' : 'thinking',
      tool: null, pending: new Map(), lastTs, doneAt: null,
      apiStatus: item.status, runId: item.latestRunId || null,
      streamExpiredRun: null, needRunRefresh: false, refreshing: false, goneAt: null,
      metadataLoaded: false, metadataLoading: false,
    };
    cloudAgents.set(key, a);
    dirty = true;
  }
  a.goneAt = null;
  a.apiStatus = item.status;
  if (typeof item.name === 'string' && item.name && item.name !== a.title) { a.title = item.name; dirty = true; }
  if (lastTs > a.lastTs) a.lastTs = lastTs;
  if (item.latestRunId && item.latestRunId !== a.runId) {
    a.runId = item.latestRunId;
    a.streamExpiredRun = null;
    a.needRunRefresh = false;
    a.runSettled = null;
    dirty = true;
  }
  if (item.status === 'IDLE') {
    if (a.state !== 'waiting' || a.tool) {
      a.pending.clear(); a.tool = null; a.state = 'waiting'; a.doneAt = null; dirty = true;
    }
  } else if (item.status === 'ACTIVE' && a.state === 'waiting' && a.streamExpiredRun !== a.runId && a.runSettled !== a.runId) {
    a.state = 'thinking'; a.tool = null; dirty = true;
  }
  return a;
}

function pruneCloud(now) {
  for (const [key, a] of cloudAgents) {
    const lingered = a.goneAt && now - a.goneAt > DONE_LINGER_MS;
    const idleTooLong = a.apiStatus !== 'ACTIVE' && !a.goneAt && now - a.lastTs > ACTIVE_MS;
    if (lingered || idleTooLong) {
      stopStream(a.id);
      cloudAgents.delete(key);
      dirty = true;
    }
  }
}

async function listCloudAgents() {
  const items = [];
  let cursor = '';
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ limit: '100', includeArchived: 'false' });
    if (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      params.set('cursor', cursor);
    }
    const body = await cursorGetJson(`/v1/agents?${params}`);
    if (Array.isArray(body.items)) items.push(...body.items);
    cursor = typeof body.nextCursor === 'string' ? body.nextCursor : '';
    if (!cursor) break;
  }
  return items;
}

function reconcileCloud(items) {
  const now = Date.now();
  const seen = new Set();
  const visible = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !cloudIsVisible(item, now)) continue;
    seen.add(item.id);
    visible.push(item);
    const a = upsertCloud(item, now);
    queueCloudMetadata(a);
  }
  for (const a of cloudAgents.values()) {
    if (!seen.has(a.id) && !a.goneAt) {
      a.goneAt = now;
      a.state = 'done'; a.tool = null; a.pending.clear(); a.doneAt = now;
      dirty = true;
      stopStream(a.id);
    }
  }
  syncCloudStreams(visible);
  for (const a of cloudAgents.values()) {
    if (a.needRunRefresh && a.runId) refreshExpiredRun(a.id, a.runId);
  }
  pruneCloud(now);
}

function syncCloudStreams(items) {
  const wanted = new Map();
  for (const item of items) {
    if (item.status === 'ACTIVE' && typeof item.latestRunId === 'string' && item.latestRunId) wanted.set(item.id, item);
  }
  for (const [id, handle] of cloudStreams) {
    const item = wanted.get(id);
    if (!item || item.latestRunId !== handle.runId) stopStream(id);
  }
  for (const [id, item] of wanted) {
    const a = cloudAgents.get(cloudKey(id));
    if (a?.streamExpiredRun === item.latestRunId) continue;
    const handle = cloudStreams.get(id);
    if (handle && !handle.gaveUp && !handle.abort.signal.aborted) continue;
    openCloudStream(item);
  }
}

function stopStream(agentId) {
  const handle = cloudStreams.get(agentId);
  if (!handle) return;
  handle.stopped = true;
  if (handle.timer) clearTimeout(handle.timer);
  handle.abort.abort();
  cloudStreams.delete(agentId);
}

function openCloudStream(item) {
  stopStream(item.id);
  /** @type {CloudStream} */
  const handle = {
    runId: item.latestRunId, abort: new AbortController(), lastEventId: '',
    stopped: false, gaveUp: false, attempts: 0, timer: null,
  };
  cloudStreams.set(item.id, handle);
  watchStream(item.id, handle);
}

function delay(ms, handle) {
  return new Promise(resolve => {
    if (handle.abort.signal.aborted || handle.stopped) return resolve();
    handle.timer = setTimeout(resolve, ms);
    handle.abort.signal.addEventListener('abort', () => { clearTimeout(handle.timer); resolve(); }, { once: true });
  });
}

async function watchStream(agentId, handle) {
  while (!handle.stopped && !handle.abort.signal.aborted && !handle.gaveUp) {
    let outcome = 'retry';
    try {
      outcome = await readCloudStream(agentId, handle);
      if (outcome === 'stop' || handle.stopped || handle.abort.signal.aborted) return;
      if (outcome === 'continue') continue;
      handle.attempts += 1;
    } catch (err) {
      if (err?.name === 'AbortError' || handle.abort.signal.aborted) return;
      handle.attempts += 1;
      if (handle.attempts > 5) {
        handle.gaveUp = true;
        console.error(`cloud stream failed: ${err.status || 'offline'}`);
        return;
      }
    }
    if (handle.attempts > 5) { handle.gaveUp = true; return; }
    await delay(Math.min(30_000, 1000 * 2 ** Math.max(0, handle.attempts - 1)), handle);
  }
}

/** Keep status, tool name, and branch. Drop assistant text, thinking, and tool payloads at once. */
function retainSse(block) {
  let event = 'message';
  let id = '';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    const field = sep === -1 ? line : line.slice(0, sep);
    const raw = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');
    if (field === 'event') event = raw;
    else if (field === 'id') id = raw;
    else if (field === 'data') dataLines.push(raw);
  }
  let data = {};
  if (dataLines.length) {
    try { data = JSON.parse(dataLines.join('\n')); } catch { data = {}; }
  }
  const kept = { event, id };
  if (event === 'tool_call') {
    kept.callId = typeof data.callId === 'string' ? data.callId : '';
    kept.name = typeof data.name === 'string' ? data.name : '';
    kept.status = data.status === 'running' || data.status === 'completed' ? data.status : '';
  } else if (event === 'status' || event === 'result') {
    kept.status = typeof data.status === 'string' ? data.status : '';
    kept.git = pickGit(data.git);
  } else if (event === 'error') {
    kept.code = typeof data.code === 'string' ? data.code : '';
  }
  return kept;
}

function applyCloudEvent(agentId, handle, evt) {
  const a = cloudAgents.get(cloudKey(agentId));
  if (!a) return;
  if (evt.event === 'tool_call') {
    if (!evt.name || !evt.status) return;
    if (evt.status === 'running') {
      a.pending.set(evt.callId || 'current', { name: evt.name, ts: Date.now() });
      setTool(a, evt.name);
    } else {
      a.pending.delete(evt.callId || 'current');
      if (a.pending.size) setTool(a, [...a.pending.values()].at(-1).name);
      else { a.state = 'thinking'; a.tool = null; a.doneAt = null; }
    }
    a.lastTs = Date.now();
    dirty = true;
    return;
  }
  if (evt.event === 'status' || evt.event === 'result') {
    if (evt.git) applyCloudGit(a, evt.git);
    applyCloudRunStatus(a, evt.status);
    if (RUN_TERMINAL.has(evt.status)) handle.stopped = true;
    return;
  }
  if (evt.event === 'done') handle.stopped = true;
  else if (evt.event === 'error' && evt.code) console.error(`cloud stream error: ${evt.code}`);
}

async function readCloudStream(agentId, handle) {
  const headers = { Accept: 'text/event-stream' };
  if (handle.lastEventId) headers['Last-Event-ID'] = handle.lastEventId;
  const pathname = `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(handle.runId)}/stream`;
  const res = await cursorFetch(pathname, headers, handle.abort.signal);
  if (res.status === 410) {
    await drain(res);
    handle.stopped = true;
    await refreshExpiredRun(agentId, handle.runId);
    return 'stop';
  }
  if (res.status === 400 && handle.lastEventId) {
    await drain(res);
    handle.lastEventId = '';
    return 'continue';
  }
  if (!res.ok || !res.body) {
    const wait = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null;
    await drain(res);
    if (wait) await delay(wait, handle);
    return 'retry';
  }
  handle.attempts = 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (!handle.abort.signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let split;
    while ((split = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, split);
      buf = buf.slice(split + 2);
      const kept = retainSse(block);
      if (kept.id) handle.lastEventId = kept.id;
      applyCloudEvent(agentId, handle, kept);
    }
    if (buf.length > 1_048_576) buf = '';
  }
  return handle.stopped ? 'stop' : 'retry';
}

async function refreshExpiredRun(agentId, runId) {
  const a = cloudAgents.get(cloudKey(agentId));
  if (!a || a.refreshing) return;
  a.refreshing = true;
  a.streamExpiredRun = runId;
  a.needRunRefresh = false;
  try {
    const body = await cursorGetJson(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`);
    const status = typeof body.status === 'string' ? body.status : '';
    const git = pickGit(body.git);
    delete body.result;
    delete body.text;
    const agent = cloudAgents.get(cloudKey(agentId));
    if (!agent) return;
    if (git) applyCloudGit(agent, git);
    applyCloudRunStatus(agent, status);
  } catch (err) {
    console.error(`cloud run refresh failed: ${err.status || 'offline'}`);
    const agent = cloudAgents.get(cloudKey(agentId));
    if (agent) agent.needRunRefresh = true;
  } finally {
    const agent = cloudAgents.get(cloudKey(agentId));
    if (agent) agent.refreshing = false;
  }
}

let cloudTimer = null;
let cloudAuthChecked = false;

function scheduleCloudPoll(ms) {
  if (cloudTimer) clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => { runCloudPoll(); }, ms);
}

async function runCloudPoll() {
  try {
    if (!cloudAuthChecked) {
      await cursorGetJson('/v1/me');
      cloudAuthChecked = true;
    }
    reconcileCloud(await listCloudAgents());
    scheduleCloudPoll(CLOUD_POLL_MS);
  } catch (err) {
    console.error(`cloud poll failed: ${err.status || 'offline'}${err.code ? ' ' + err.code : ''}`);
    if (err.status === 401 || err.status === 403) return;
    scheduleCloudPoll(err.retryAfterMs || CLOUD_POLL_MS);
  }
}

function startCloud() {
  if (!CURSOR_API_KEY) return;
  scheduleCloudPoll(0);
}

// ---------- http + SSE ----------

const clients = new Set();

function allowedHost(req) {
  // Blocks DNS-rebinding: only answer requests addressed to loopback names.
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost';
}

const server = http.createServer((req, res) => {
  if (!allowedHost(req)) {
    console.warn(`Refused ${req.url}: Host "${req.headers.host}" is not 127.0.0.1 or localhost`);
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Open this page at http://127.0.0.1:' + PORT);
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    });
    fs.createReadStream(INDEX_HTML).pipe(res);
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 1h12v8l-6 6-6-6z" fill="#d9a441"/><path d="M3 2h10v7l-5 5-5-5z" fill="#8f1d2c"/><path d="M7 3h2v9H7zM4 6h8v2H4z" fill="#d9a441"/></svg>');
    return;
  }
  if (url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot(), null, 2));
    return;
  }
  res.writeHead(404).end();
});

let ticks = 0;
setInterval(() => {
  try { scan(); pruneCloud(Date.now()); } catch (err) { console.error('scan failed:', err); }
  ticks++;
  // Push on change, plus every ~3s so "for 42s" counters keep moving.
  if (dirty || ticks % 4 === 0) {
    dirty = false;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(msg);
  }
}, SCAN_MS);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The Agent Keep may already be running: open http://${HOST}:${PORT}`);
    console.error(`To run another copy, pick a different port:  PORT=${PORT + 2} node server.mjs`);
    process.exit(1);
  }
  throw err;
});

scan();
server.listen(PORT, HOST, () => {
  console.log(`The Agent Keep is watching:`);
  console.log(`  Claude Code  ${CLAUDE_ROOT}`);
  console.log(`  Cursor       ${CURSOR_ROOT}${sqlite && fs.existsSync(CURSOR_DB) ? '' : '  (chat titles unavailable)'}`);
  console.log(CURSOR_API_KEY
    ? `  Cursor Cloud ${CURSOR_API_BASE} every ${CLOUD_POLL_MS / 1000}s`
    : '  Cursor Cloud off (set CURSOR_API_KEY)');
  console.log(`Open http://${HOST}:${PORT}`);
});
startCloud();
