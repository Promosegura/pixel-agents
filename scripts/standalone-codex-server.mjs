#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const webviewDistDir = path.join(rootDir, 'dist', 'webview');
const sourceAssetsDir = path.join(rootDir, 'webview-ui', 'public', 'assets');
const distAssetsDir = path.join(rootDir, 'dist', 'assets');
const cwd = process.cwd();
const portArg = process.argv.find((arg) => arg.startsWith('--port='));
const requestedPort = parseRequestedPort(portArg);
const scanWindowMinutes = Number(process.env.PIXEL_AGENTS_STANDALONE_WINDOW_MINUTES ?? '720');
const pollIntervalMs = Number(process.env.PIXEL_AGENTS_STANDALONE_POLL_MS ?? '750');
const maxMessageBodySize = 64 * 1024;
const maxFirstLineBytes = 1024 * 1024;
const maxStatusArgChars = 500;
const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const clients = new Set();
const agentsByFile = new Map();
const closedFiles = new Set();
const waitingTimersByAgent = new Map();
let nextAgentId = 1;

function parseRequestedPort(arg) {
  if (!arg) return 0;
  const raw = arg.slice('--port='.length);
  if (!/^\d+$/.test(raw)) {
    console.error(`Invalid --port value: ${raw}`);
    process.exit(1);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port value: ${raw}`);
    process.exit(1);
  }
  return port;
}

function send(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event) {
  for (const client of clients) send(client, event);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function validateHost(req, res) {
  const hostHeader = req.headers.host;
  if (!hostHeader) {
    res.writeHead(403);
    res.end('forbidden');
    return false;
  }
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  if (allowedHosts.has(host)) return true;
  res.writeHead(403);
  res.end('forbidden');
  return false;
}

function getRecentCodexDirs() {
  const dirs = [];
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const now = new Date();
  for (let i = 0; i < 4; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dirs.push(
      path.join(
        root,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ),
    );
  }
  return dirs;
}

function readFirstLine(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks = [];
    let position = 0;
    while (position < maxFirstLineBytes) {
      const buf = Buffer.alloc(16_384);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      const newlineIndex = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(buf.subarray(0, newlineIndex));
        break;
      }
      chunks.push(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function getCodexSessionMeta(filePath) {
  try {
    const line = readFirstLine(filePath);
    if (!line.trim()) return null;
    const record = JSON.parse(line);
    if (record.type !== 'session_meta') return null;
    return record.payload ?? null;
  } catch {
    return null;
  }
}

function discoverSessionFiles() {
  const minMtime = Date.now() - scanWindowMinutes * 60_000;
  const files = [];
  for (const dir of getRecentCodexDirs()) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const file = path.join(dir, entry);
        const stat = fs.statSync(file);
        if (stat.mtimeMs < minMtime) continue;
        const meta = getCodexSessionMeta(file);
        if (!meta) continue;
        files.push({ file, stat, meta });
      }
    } catch {
      // Ignore transient directory reads while Codex rotates sessions.
    }
  }
  files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  return files;
}

function shortFolderName(sessionCwd) {
  if (!sessionCwd || sessionCwd === os.homedir()) return undefined;
  return path.basename(sessionCwd);
}

function addAgent(file, stat, meta, replay = false) {
  if (agentsByFile.has(file)) return agentsByFile.get(file);
  if (closedFiles.has(file)) return null;
  const id = nextAgentId++;
  const agent = {
    id,
    file,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
    sessionId: meta.id ?? path.basename(file, '.jsonl'),
    offset: replay ? 0 : stat.size,
    lineBuffer: '',
    decoder: new StringDecoder('utf8'),
    activeToolIds: new Set(),
    activeToolNames: new Map(),
    inputTokens: 0,
    outputTokens: 0,
  };
  agentsByFile.set(file, agent);
  broadcast({ type: 'agentCreated', id, folderName: shortFolderName(meta.cwd) });
  return agent;
}

function safeStatusArgs(input) {
  if (typeof input === 'string') return input.slice(0, maxStatusArgChars);
  if (!input || typeof input !== 'object') return '';
  try {
    const shallow = Array.isArray(input)
      ? input.slice(0, 10)
      : Object.fromEntries(Object.entries(input).slice(0, 10));
    return JSON.stringify(shallow).slice(0, maxStatusArgChars);
  } catch {
    return '';
  }
}

function formatCodexToolStatus(toolName, input) {
  const args = safeStatusArgs(input);
  const trimmedArgs = args.length > 90 ? `${args.slice(0, 90)}...` : args;
  if (toolName.endsWith('exec_command')) {
    return trimmedArgs ? `Running: ${trimmedArgs}` : 'Running command';
  }
  if (toolName.endsWith('apply_patch')) return 'Editing files';
  if (toolName.endsWith('spawn_agent')) return 'Spawning agent';
  if (toolName.endsWith('wait_agent')) return 'Waiting for agent';
  if (toolName === 'web.run') return 'Searching the web';
  return `Using ${toolName}`;
}

function clearAgentTools(agent) {
  for (const toolId of agent.activeToolIds) {
    broadcast({ type: 'agentToolDone', id: agent.id, toolId });
  }
  agent.activeToolIds.clear();
  agent.activeToolNames.clear();
}

function clearWaitingTimer(agent) {
  const timer = waitingTimersByAgent.get(agent.id);
  if (timer) clearTimeout(timer);
  waitingTimersByAgent.delete(agent.id);
}

function scheduleWaiting(agent) {
  clearWaitingTimer(agent);
  const timer = setTimeout(() => {
    waitingTimersByAgent.delete(agent.id);
    if (!agentsByFile.has(agent.file)) return;
    broadcast({ type: 'agentStatus', id: agent.id, status: 'waiting' });
  }, 1500);
  waitingTimersByAgent.set(agent.id, timer);
}

function closeAgent(agent) {
  clearWaitingTimer(agent);
  clearAgentTools(agent);
  closedFiles.add(agent.file);
  agentsByFile.delete(agent.file);
  broadcast({ type: 'agentClosed', id: agent.id });
}

function processCodexRecord(agent, record) {
  const payload = record.payload ?? {};
  const payloadType = payload.type;

  if (
    record.type === 'turn_context' ||
    (record.type === 'event_msg' && payloadType === 'user_message')
  ) {
    clearWaitingTimer(agent);
    clearAgentTools(agent);
    broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
    return;
  }

  if (record.type === 'event_msg' && payloadType === 'token_count') {
    const usage = payload.info?.total_token_usage;
    if (usage) {
      agent.inputTokens = usage.input_tokens ?? agent.inputTokens;
      agent.outputTokens = usage.output_tokens ?? agent.outputTokens;
      broadcast({
        type: 'agentTokenUsage',
        id: agent.id,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }
    return;
  }

  if (record.type === 'event_msg' && payloadType === 'agent_message') {
    clearWaitingTimer(agent);
    broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
    scheduleWaiting(agent);
    return;
  }

  if (record.type !== 'response_item') return;

  if (payloadType === 'function_call') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : `codex-${Date.now()}`;
    const namespace = typeof payload.namespace === 'string' ? `${payload.namespace}.` : '';
    const name = typeof payload.name === 'string' ? `${namespace}${payload.name}` : 'tool';
    const status = formatCodexToolStatus(name, payload.arguments);
    clearWaitingTimer(agent);
    agent.activeToolIds.add(callId);
    agent.activeToolNames.set(callId, name);
    broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
    broadcast({ type: 'agentToolStart', id: agent.id, toolId: callId, status, toolName: name });
    return;
  }

  if (payloadType === 'function_call_output') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    const toolIds = callId ? [callId] : [...agent.activeToolIds];
    for (const toolId of toolIds) {
      agent.activeToolIds.delete(toolId);
      agent.activeToolNames.delete(toolId);
      broadcast({ type: 'agentToolDone', id: agent.id, toolId });
    }
    if (agent.activeToolIds.size === 0) {
      scheduleWaiting(agent);
    }
  }
}

function readNewLines(agent) {
  try {
    const stat = fs.statSync(agent.file);
    if (stat.size <= agent.offset) return;
    const fd = fs.openSync(agent.file, 'r');
    try {
      const bytesToRead = Math.min(stat.size - agent.offset, 256 * 1024);
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, agent.offset);
      if (bytesRead === 0) return;
      agent.offset += bytesRead;
      const text = agent.lineBuffer + agent.decoder.write(buf.subarray(0, bytesRead));
      const lines = text.split('\n');
      agent.lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          processCodexRecord(agent, JSON.parse(line));
        } catch {
          // Ignore partial or malformed transcript lines.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Session files can disappear during cleanup; keep the UI stable.
  }
}

function scanCodexSessions() {
  for (const { file, stat, meta } of discoverSessionFiles()) {
    addAgent(file, stat, meta);
  }
  for (const agent of agentsByFile.values()) {
    readNewLines(agent);
  }
}

function sendInitialState(res) {
  send(res, {
    type: 'workspaceFolders',
    folders: [{ name: path.basename(cwd), path: cwd }],
  });
  send(res, {
    type: 'settingsLoaded',
    soundEnabled: false,
    extensionVersion: 'standalone-codex',
    lastSeenVersion: 'standalone-codex',
    watchAllSessions: true,
    alwaysShowLabels: true,
    hooksEnabled: false,
    hooksInfoShown: true,
    externalAssetDirectories: [],
  });
  const agents = [...agentsByFile.values()].map((agent) => agent.id);
  const folderNames = Object.fromEntries(
    [...agentsByFile.values()].map((agent) => [agent.id, shortFolderName(agent.cwd)]),
  );
  send(res, { type: 'existingAgents', agents, agentMeta: {}, folderNames, externalAgents: {} });
  for (const agent of agentsByFile.values()) {
    if (agent.inputTokens || agent.outputTokens) {
      send(res, {
        type: 'agentTokenUsage',
        id: agent.id,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

function safeResolve(baseDir, requestPath) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, requestPath.replace(/^\/+/, ''));
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}

function serveFile(res, filePath) {
  const stream = fs.createReadStream(filePath);
  stream
    .on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    })
    .once('open', () => {
      res.writeHead(200, { 'Content-Type': contentType(filePath) });
    })
    .pipe(res);
}

function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  if (pathname.startsWith('/assets/')) {
    const rel = pathname.slice('/assets/'.length);
    for (const base of [path.join(webviewDistDir, 'assets'), sourceAssetsDir, distAssetsDir]) {
      const candidate = safeResolve(base, rel);
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        serveFile(res, candidate);
        return;
      }
    }
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const rel = pathname === '/' ? 'index.html' : pathname;
  const filePath = safeResolve(webviewDistDir, rel);
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(res, filePath);
    return;
  }
  serveFile(res, path.join(webviewDistDir, 'index.html'));
}

function handleMessage(req, res) {
  let body = '';
  let bodySize = 0;
  let rejected = false;
  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > maxMessageBodySize) {
      rejected = true;
      res.writeHead(413);
      res.end('payload too large');
      req.destroy();
      return;
    }
    body += chunk.toString();
  });
  req.on('end', () => {
    if (rejected) return;
    try {
      const message = body ? JSON.parse(body) : {};
      if (message.type === 'webviewReady') {
        json(res, 200, { ok: true, mode: 'standalone' });
        return;
      }
      if (message.type === 'closeAgent') {
        const id = Number(message.id);
        for (const agent of agentsByFile.values()) {
          if (agent.id === id) {
            closeAgent(agent);
            break;
          }
        }
      }
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { ok: false, error: 'invalid json' });
    }
  });
}

if (!fs.existsSync(path.join(webviewDistDir, 'index.html'))) {
  console.error('dist/webview/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

scanCodexSessions();
setInterval(scanCodexSessions, pollIntervalMs);

const server = http.createServer((req, res) => {
  if (!validateHost(req, res)) return;
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/api/standalone') {
    json(res, 200, { ok: true, mode: 'standalone-codex' });
    return;
  }
  if (req.method === 'GET' && url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    clients.add(res);
    sendInitialState(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && url === '/api/messages') {
    handleMessage(req, res);
    return;
  }
  if (url.startsWith('/api/')) {
    json(res, 404, { ok: false, error: 'not found' });
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end('method not allowed');
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  console.log(`Pixel Agents standalone Codex server running at http://127.0.0.1:${port}`);
  console.log(`Watching Codex sessions in ~/.codex/sessions (last ${scanWindowMinutes} minutes).`);
});
