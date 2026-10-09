#!/usr/bin/env node
// Writes fake Claude Code and Cursor sessions into ./demo-projects so you can
// watch the hall without running real agents:
//   CLAUDE_PROJECTS_DIR=./demo-projects/claude CURSOR_PROJECTS_DIR=./demo-projects/cursor PORT=7332 node server.mjs &
//   node demo.mjs
//
// The same process serves a local Cloud Agents API mock on 7334. Point the
// keep at it with CURSOR_API_BASE=http://127.0.0.1:7334 CURSOR_API_KEY=demo-key-not-real
// `node demo.mjs --check` starts that mock, a temporary server, and checks
// state, stream resume, the expired-stream fallback, and that prompt text stays out.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(process.env.DEMO_DIR || 'demo-projects');
const MOCK_TOKEN = 'demo-key-not-real';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const append = (file, obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');
let n = 0;

// ---------- Claude Code: timestamped lines, tool ids and results, meta.json per subagent ----------

async function claudeDemo() {
  const slug = '-demo-acme-web', sessionId = 'demo-session-0001';
  const dir = path.join(ROOT, 'claude', slug);
  const subDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const sessionFile = path.join(dir, `${sessionId}.jsonl`);
  const write = (file, obj) => append(file, { cwd: '/work/acme-web', gitBranch: 'demo/branch', timestamp: new Date().toISOString(), ...obj });
  const toolUse = (file, name, extra = {}) => {
    const id = `toolu_demo_${++n}`;
    write(file, { type: 'assistant', ...extra, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: {} }] } });
    return id;
  };
  const toolResult = (file, id, extra = {}) =>
    write(file, { type: 'user', ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const say = (file, extra = {}) =>
    write(file, { type: 'assistant', ...extra, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
  const runTools = async (file, tools, extra) => {
    for (const [name, ms] of tools) { const id = toolUse(file, name, extra); await sleep(ms); toolResult(file, id, extra); await sleep(300); }
  };
  const subagent = async (agentId, agentType, description, tools, parentToolUseId) => {
    const file = path.join(subDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType, description, toolUseId: parentToolUseId, spawnDepth: 1 }));
    const extra = { isSidechain: true, agentId };
    write(file, { type: 'user', ...extra, message: { role: 'user', content: description } });
    await runTools(file, tools, extra);
    say(file, extra);
  };

  write(sessionFile, { type: 'custom-title', customTitle: 'Demo: add dark mode' });
  write(sessionFile, { type: 'user', message: { role: 'user', content: 'Add dark mode to the settings page' } });
  await sleep(1500);
  await runTools(sessionFile, [['Read', 2000], ['Grep', 1500]]);
  const ids = ['Agent', 'Agent', 'Agent'].map(name => toolUse(sessionFile, name));
  await Promise.all([
    subagent('a1', 'Explore', 'Find every theme token usage', [['Grep', 2500], ['Read', 2000], ['Glob', 1500], ['Read', 2500]], ids[0]),
    (async () => { await sleep(700); await subagent('a2', 'general-purpose', 'Draft CSS variables for dark palette', [['Read', 2000], ['Write', 4000], ['Edit', 3000]], ids[1]); })(),
    // This one sits on a Bash call long enough to look like a permission prompt.
    (async () => { await sleep(1400); await subagent('a3', 'general-purpose', 'Run the visual regression suite', [['Bash', 16000], ['Read', 1500]], ids[2]); })(),
  ]);
  for (const id of ids) toolResult(sessionFile, id);
  await sleep(1200);
  await runTools(sessionFile, [['Edit', 3000], ['Bash', 3000]]);
  say(sessionFile);
}

// ---------- Cursor: {role, message} lines + turn_ended, no timestamps, ids or results ----------

async function cursorDemo() {
  const slug = 'acme-api', id = 'c0ffee00-demo-4000-8000-000000000001';
  const base = path.join(ROOT, 'cursor', slug, 'agent-transcripts', id);
  fs.mkdirSync(path.join(base, 'subagents'), { recursive: true });
  const sessionFile = path.join(base, `${id}.jsonl`);
  const stamp = () => `<timestamp>${new Date().toString()}</timestamp>\n`;
  const user = (file, text) => append(file, { role: 'user', message: { content: [{ type: 'text', text: stamp() + text }] } });
  const tool = (file, name, input = {}) => append(file, { role: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const text = (file, t) => append(file, { role: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  const end = (file) => append(file, { type: 'turn_ended', status: 'success' });
  const run = async (file, tools) => { for (const [name, ms, input] of tools) { tool(file, name, input); await sleep(ms); } };
  const subagent = async (subId, type, description, prompt, tools) => {
    tool(sessionFile, 'Task', { description, prompt, subagent_type: type });
    const file = path.join(base, 'subagents', `${subId}.jsonl`);
    user(file, prompt);
    await sleep(400);
    await run(file, tools);
    text(file, 'Summary for the parent.');
    end(file);
  };

  await sleep(2500);
  user(sessionFile, 'Why is the /orders endpoint slow?');
  text(sessionFile, "I'll look at the handler first.");
  await sleep(800);
  await run(sessionFile, [['Read', 2000], ['Grep', 1800]]);
  // Cursor's Task tool: the subagent's first message is the prompt, which is how we link it.
  await Promise.all([
    subagent('d00d0001-demo', 'explore', 'Trace the orders query path', 'Trace how GET /orders builds its SQL and list every join.', [['Grep', 2500], ['Read', 2500], ['Glob', 1500], ['Read', 2000]]),
    (async () => { await sleep(900); await subagent('d00d0002-demo', 'generalPurpose', 'Benchmark the orders query', 'Run the orders benchmark and report p50/p95.', [['Shell', 5000], ['ReadLints', 1500], ['StrReplace', 2500]]); })(),
  ]);
  await sleep(800);
  await run(sessionFile, [['StrReplace', 2500], ['Shell', 3000]]);
  // AskQuestion means the agent is waiting on you.
  tool(sessionFile, 'AskQuestion', { question: 'Add the index now?' });
  await sleep(6000);
  user(sessionFile, 'Yes');
  await run(sessionFile, [['Write', 2500]]);
  text(sessionFile, 'Added the index; p95 dropped.');
  end(sessionFile);
}

function cloudItems() {
  const now = new Date().toISOString();
  const base = (id, name, status, runId) => ({
    id, name, status, env: { type: 'cloud' }, url: `https://cursor.com/agents/${id}`,
    createdAt: now, updatedAt: now, latestRunId: runId,
    prompt: { text: 'SECRET_PROMPT' },
  });
  return {
    page1: [
      base('bc-demo-active', 'Demo: watch the cloud hall', 'ACTIVE', 'run-active'),
      base('bc-demo-idle', 'Demo: idle cloud agent', 'IDLE', 'run-idle'),
    ],
    page2: [
      base('bc-demo-expired', 'Demo: expired stream', 'ACTIVE', 'run-expired'),
      base('bc-demo-unassigned', 'Demo: no repository yet', 'IDLE', 'run-unassigned'),
    ],
  };
}

function cloudMetadata(id) {
  const common = { id, status: 'ACTIVE', prompt: { text: 'SECRET_PROMPT' } };
  if (id === 'bc-demo-active') {
    return { ...common, name: 'Demo: watch the cloud hall', repos: [{ url: 'https://github.com/acme/acme-web' }], env: { type: 'cloud' } };
  }
  if (id === 'bc-demo-idle') {
    return { ...common, name: 'Demo: idle cloud agent', repos: [], env: { type: 'cloud', name: 'docs-sandbox' } };
  }
  if (id === 'bc-demo-expired') {
    return { ...common, name: 'Demo: expired stream', repos: [{ url: 'https://github.com/acme/cloud-repo.git' }], env: { type: 'cloud' } };
  }
  if (id === 'bc-demo-unassigned') {
    return { ...common, name: 'Demo: no repository yet', repos: [], env: { type: 'cloud' } };
  }
  return null;
}

function sse(res, id, event, data) {
  res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// A tiny GET-only stand-in for https://api.cursor.com. The first agent list
// returns 429 once. The active run drops the stream so the client must resume
// with Last-Event-ID. The other active run answers 410 so the client reads the
// run instead. Every body includes secret text the keep must not forward.
function startCloudMock(port) {
  const methods = [];
  let listCalls = 0;
  const items = cloudItems();
  const server = http.createServer((req, res) => {
    methods.push(req.method || '');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'unauthorized' }));
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/me') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ apiKeyName: 'demo' }));
      return;
    }
    if (url.pathname === '/v1/agents') {
      listCalls += 1;
      if (listCalls === 1) {
        res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' }).end(JSON.stringify({ code: 'rate_limit_exceeded', message: 'SECRET_PROMPT' }));
        return;
      }
      const page = url.searchParams.get('cursor') ? items.page2 : items.page1;
      const body = url.searchParams.get('cursor') ? { items: page } : { items: page, nextCursor: 'page-2' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    const agent = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (agent) {
      const body = cloudMetadata(agent[1]);
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
        .end(JSON.stringify(body || { code: 'not_found' }));
      return;
    }
    const stream = url.pathname.match(/^\/v1\/agents\/([^/]+)\/runs\/([^/]+)\/stream$/);
    const run = url.pathname.match(/^\/v1\/agents\/([^/]+)\/runs\/([^/]+)$/);
    if (stream && stream[1] === 'bc-demo-expired') {
      res.writeHead(410, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'stream_expired', message: 'SECRET_STREAM' }));
      return;
    }
    if (run && run[1] === 'bc-demo-expired') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'run-expired', agentId: 'bc-demo-expired', status: 'FINISHED',
        result: 'SECRET_FINAL',
        git: { branches: [{ repoUrl: 'github.com/acme/cloud-repo', branch: 'cursor/cloud-demo', prUrl: 'https://github.com/acme/cloud-repo/pull/9' }] },
      }));
      return;
    }
    if (stream && stream[1] === 'bc-demo-active') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'X-Cursor-Stream-Retention-Seconds': '60' });
      const last = req.headers['last-event-id'];
      if (!last) {
        sse(res, '', 'status', { runId: 'run-active', status: 'RUNNING' });
        sse(res, '1', 'assistant', { text: 'SECRET_ASSISTANT' });
        sse(res, '2', 'tool_call', { callId: 'c1', name: 'read_file', status: 'running', args: { path: 'SECRET_ARG' }, result: 'SECRET_RESULT' });
        res.end();
        return;
      }
      sse(res, '', 'status', { runId: 'run-active', status: 'RUNNING' });
      sse(res, '3', 'thinking', { text: 'SECRET_ASSISTANT' });
      sse(res, '4', 'tool_call', { callId: 'c1', name: 'read_file', status: 'completed', args: { path: 'SECRET_ARG' }, result: 'SECRET_RESULT' });
      sse(res, '5', 'tool_call', { callId: 'c2', name: 'run_terminal_cmd', status: 'running', args: { command: 'SECRET_ARG' } });
      const hb = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 5000);
      res.on('close', () => clearInterval(hb));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'not_found' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      methods,
      close: () => new Promise(r => server.close(() => r())),
    }));
  });
}

const SECRET_BITS = ['SECRET_PROMPT', 'SECRET_ARG', 'SECRET_RESULT', 'SECRET_ASSISTANT', 'SECRET_FINAL', 'SECRET_STREAM', MOCK_TOKEN, 'pull/9', 'github.com/acme'];
const AGENT_FIELDS = ['key', 'source', 'kind', 'parentKey', 'sessionKey', 'project', 'title', 'agentType', 'branch', 'state', 'tool', 'pendingForMs', 'idleForMs'];

async function checkCloud() {
  const mock = await startCloudMock(0);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-'));
  const serverPort = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  let logs = '';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: HERE,
    env: {
      ...process.env,
      PORT: String(serverPort),
      CURSOR_API_KEY: MOCK_TOKEN,
      CURSOR_API_BASE: `http://127.0.0.1:${mock.port}`,
      CLOUD_POLL_MS: '1000',
      CLAUDE_PROJECTS_DIR: empty,
      CURSOR_PROJECTS_DIR: empty,
      CURSOR_STATE_DB: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  const fail = (message, extra) => {
    console.error(message);
    if (extra) console.error(extra);
    console.error(logs);
    return message;
  };
  let error = '';
  try {
    const started = Date.now();
    let last = '';
    while (Date.now() - started < 15_000) {
      await sleep(200);
      let body = '';
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/state`);
        body = await res.text();
      } catch { continue; }
      last = body;
      let snap;
      try { snap = JSON.parse(body); } catch { continue; }
      const cloud = (snap.agents || []).filter(a => a.source === 'cursor-cloud');
      const active = cloud.find(a => a.title === 'Demo: watch the cloud hall');
      const idle = cloud.find(a => a.title === 'Demo: idle cloud agent');
      const expired = cloud.find(a => a.title === 'Demo: expired stream');
      const unassigned = cloud.find(a => a.title === 'Demo: no repository yet');
      if (!active || active.tool !== 'run_terminal_cmd' || active.state !== 'running') continue;
      if (!idle || idle.state !== 'waiting' || idle.project !== 'Environment: docs-sandbox') continue;
      if (active.project !== 'acme-web') continue;
      if (!expired || expired.state !== 'waiting' || expired.branch !== 'cursor/cloud-demo' || expired.project !== 'cloud-repo') continue;
      if (!unassigned || unassigned.state !== 'waiting' || unassigned.project !== 'Unassigned') continue;
      const leaked = SECRET_BITS.filter(bit => body.includes(bit) || logs.includes(bit));
      if (leaked.length) { error = fail(`leaked ${leaked.join(', ')}`, body); break; }
      const extra = snap.agents.flatMap(a => Object.keys(a).filter(k => !AGENT_FIELDS.includes(k)));
      if (extra.length || Object.keys(snap).some(k => k !== 'now' && k !== 'agents')) { error = fail(`unexpected snapshot fields: ${extra.join(', ')}`, body); break; }
      if (mock.methods.some(m => m !== 'GET')) { error = fail(`non-GET request: ${mock.methods.join(', ')}`); break; }
      console.log('cloud check ok');
      console.log(JSON.stringify(cloud, null, 2));
      return;
    }
    if (!error) error = fail('timed out waiting for cloud agents', last);
  } finally {
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    await mock.close();
    fs.rmSync(empty, { recursive: true, force: true });
  }
  process.exit(1);
}

if (process.argv.includes('--check')) {
  await checkCloud();
} else {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const mock = await startCloudMock(Number(process.env.CLOUD_MOCK_PORT || 7334));
  console.log(`demo transcripts -> ${ROOT}`);
  console.log(`cloud mock -> http://127.0.0.1:${mock.port}`);
  console.log(`watch it with CURSOR_API_BASE=http://127.0.0.1:${mock.port} CURSOR_API_KEY=${MOCK_TOKEN}`);
  await Promise.all([claudeDemo(), cursorDemo()]);
  console.log('demo transcripts finished. Cloud mock is still serving; Ctrl+C to stop. Re-run to replay.');
  await new Promise(() => {});
}
