#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
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
const maxHookBodySize = 64 * 1024;
const maxFirstLineBytes = 1024 * 1024;
const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const pixelAgentsDir = path.join(os.homedir(), '.pixel-agents');
const discoveryFile = path.join(pixelAgentsDir, 'standalone-codex-server.json');

const clients = new Set();
const agentsByFile = new Map();
const agentsBySessionId = new Map();
const knownSessionFiles = new Map();
const closedFiles = new Set();
const recentHookEvents = new Map();
const waitingTimersByAgent = new Map();
const idleCloseTimersByAgent = new Map();
let nextAgentId = 1;
const hookToken =
  process.env.PIXEL_AGENTS_STANDALONE_HOOK_TOKEN || crypto.randomBytes(32).toString('hex');
const dedupeTtlMs = 5 * 60_000;

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

function validateOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol === 'http:' &&
      (allowedHosts.has(parsed.hostname) || allowedHosts.has(`[${parsed.hostname}]`))
    ) {
      return true;
    }
  } catch {
    // Reject malformed origins below.
  }
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

function addAgent(file, stat, meta, replay = false, initialOffset = undefined) {
  const sessionId = typeof meta.id === 'string' ? meta.id : path.basename(file, '.jsonl');
  const existingBySession = agentsBySessionId.get(sessionId);
  if (existingBySession) {
    if (!existingBySession.file || existingBySession.file.startsWith('hook:')) {
      existingBySession.file = file;
      existingBySession.offset = initialOffset ?? (replay ? 0 : stat.size);
      existingBySession.lineBuffer = '';
      existingBySession.decoder = new StringDecoder('utf8');
      agentsByFile.set(file, existingBySession);
      knownSessionFiles.delete(file);
      closedFiles.delete(file);
    }
    return existingBySession;
  }
  if (agentsByFile.has(file)) return agentsByFile.get(file);
  if (closedFiles.has(file)) return null;
  const id = nextAgentId++;
  const agent = {
    id,
    file,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
    sessionId,
    offset: initialOffset ?? (replay ? 0 : stat.size),
    lineBuffer: '',
    decoder: new StringDecoder('utf8'),
    activeToolIds: new Set(),
    activeToolNames: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    hookDelivered: false,
  };
  agentsByFile.set(file, agent);
  agentsBySessionId.set(agent.sessionId, agent);
  knownSessionFiles.delete(file);
  broadcast({ type: 'agentCreated', id, folderName: shortFolderName(meta.cwd) });
  return agent;
}

function addHookAgent(event) {
  const sessionId = getHookSessionId(event);
  if (!sessionId) return null;
  const existing = agentsBySessionId.get(sessionId);
  if (existing) {
    existing.hookDelivered = true;
    if (!existing.cwd && typeof event.cwd === 'string') {
      existing.cwd = event.cwd;
    }
    return existing;
  }
  const transcriptPath =
    typeof event.transcript_path === 'string'
      ? event.transcript_path
      : typeof event.transcriptPath === 'string'
        ? event.transcriptPath
        : undefined;
  const file = transcriptPath || `hook:${sessionId}`;
  const stat =
    transcriptPath && fs.existsSync(transcriptPath) ? fs.statSync(transcriptPath) : { size: 0 };
  return addAgent(file, stat, {
    id: sessionId,
    cwd: typeof event.cwd === 'string' ? event.cwd : cwd,
  });
}

function normalizeToolInput(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return input;
    }
  }
  return input;
}

function getCommandFromInput(input) {
  const normalized = normalizeToolInput(input);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return '';
  return typeof normalized.cmd === 'string'
    ? normalized.cmd
    : typeof normalized.command === 'string'
      ? normalized.command
      : '';
}

function getStringFieldFromInput(input, field) {
  const normalized = normalizeToolInput(input);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return '';
  const value = normalized[field];
  return typeof value === 'string' ? value : '';
}

function trimActivityText(text, maxLength = 90) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function extractFunctionalIntent(message) {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const objectiveMatch = normalized.match(
    /(?:objetivo|objective|task|tarefa)\s*:\s*(.+?)(?:\s+(?:faça|entregue|não|do not|return|requirements?)\b|$)/i,
  );
  if (objectiveMatch?.[1]) return trimActivityText(objectiveMatch[1]);
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const useful = sentences.find(
    (sentence) =>
      sentence.trim() &&
      !/^(você é|you are|contexto|context|não altere|do not edit|apenas|only)\b/i.test(
        sentence.trim(),
      ),
  );
  return trimActivityText(useful || normalized);
}

function formatSpawnAgentStatus(input) {
  const intent = extractFunctionalIntent(getStringFieldFromInput(input, 'message'));
  return intent ? `Delegating: ${intent}` : 'Delegating work';
}

function formatFunctionalCommandStatus(command) {
  const cmd = command.toLowerCase();
  if (!cmd.trim()) return 'Working in the terminal';
  if (
    /\bnpm\s+run\s+(test|test:webview|test:server|e2e)\b/.test(cmd) ||
    /\b(vitest|playwright test)\b/.test(cmd)
  ) {
    return 'Running quality smoke tests';
  }
  if (
    /\bnpm\s+run\s+(check-types|lint|format:check|knip)\b/.test(cmd) ||
    /\b(tsc|eslint|prettier --check|knip)\b/.test(cmd)
  ) {
    return 'Validating code quality';
  }
  if (
    /\bnpm\s+run\s+(build|compile|package|build:webview)\b/.test(cmd) ||
    /\b(vite build|esbuild)\b/.test(cmd)
  ) {
    return 'Building the application';
  }
  if (/\bnpm\s+(install|ci)\b/.test(cmd)) return 'Installing project dependencies';
  if (/\bgit\s+(status|diff|log|show|branch)\b/.test(cmd)) return 'Reviewing repository changes';
  if (/\bgit\s+(add|commit|push|pull|fetch)\b/.test(cmd)) return 'Updating version control';
  if (/\b(rg|grep|find|ls|sed|nl|cat)\b/.test(cmd)) return 'Inspecting project files';
  if (/\b(curl|wget)\b/.test(cmd)) return 'Checking a local service endpoint';
  if (/\b(lsof|ps|kill)\b/.test(cmd)) return 'Managing the local preview service';
  if (/\bnode\s+scripts\/standalone-codex-server\.mjs\b/.test(cmd))
    return 'Starting the browser preview';
  return 'Working in the terminal';
}

function formatCodexToolStatus(toolName, input) {
  if (toolName.endsWith('exec_command')) {
    return formatFunctionalCommandStatus(getCommandFromInput(input));
  }
  if (toolName.endsWith('apply_patch')) return 'Editing files';
  if (toolName.endsWith('spawn_agent')) return formatSpawnAgentStatus(input);
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

function clearIdleCloseTimer(agent) {
  const timer = idleCloseTimersByAgent.get(agent.id);
  if (timer) clearTimeout(timer);
  idleCloseTimersByAgent.delete(agent.id);
}

function scheduleWaiting(agent) {
  clearWaitingTimer(agent);
  clearIdleCloseTimer(agent);
  const timer = setTimeout(() => {
    waitingTimersByAgent.delete(agent.id);
    if (!agentsBySessionId.has(agent.sessionId)) return;
    broadcast({ type: 'agentStatus', id: agent.id, status: 'waiting' });
    const closeTimer = setTimeout(() => {
      idleCloseTimersByAgent.delete(agent.id);
      if (agentsBySessionId.has(agent.sessionId) && agent.activeToolIds.size === 0) {
        closeAgent(agent);
      }
    }, 4000);
    idleCloseTimersByAgent.set(agent.id, closeTimer);
  }, 1500);
  waitingTimersByAgent.set(agent.id, timer);
}

function closeAgent(agent) {
  clearWaitingTimer(agent);
  clearIdleCloseTimer(agent);
  clearAgentTools(agent);
  if (agent.file) {
    closedFiles.add(agent.file);
    agentsByFile.delete(agent.file);
  }
  agentsBySessionId.delete(agent.sessionId);
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

function shouldCreateAgentFromRecord(record) {
  const payload = record.payload ?? {};
  const payloadType = payload.type;
  return (
    record.type === 'turn_context' ||
    (record.type === 'event_msg' && payloadType === 'user_message') ||
    (record.type === 'event_msg' && payloadType === 'agent_message') ||
    (record.type === 'response_item' && payloadType === 'function_call')
  );
}

function readNewLines(agent) {
  if (!agent.file || agent.file.startsWith('hook:')) return;
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

function readPendingLines(candidate) {
  try {
    const stat = fs.statSync(candidate.file);
    if (stat.size <= candidate.offset) return;
    const fd = fs.openSync(candidate.file, 'r');
    try {
      const bytesToRead = Math.min(stat.size - candidate.offset, 256 * 1024);
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, candidate.offset);
      if (bytesRead === 0) return;
      candidate.offset += bytesRead;
      const text = candidate.lineBuffer + candidate.decoder.write(buf.subarray(0, bytesRead));
      const lines = text.split('\n');
      candidate.lineBuffer = lines.pop() ?? '';
      let agent = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!agent && shouldCreateAgentFromRecord(record)) {
            agent = addAgent(candidate.file, stat, candidate.meta, false, candidate.offset);
          }
          if (agent) processCodexRecord(agent, record);
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

function getHookSessionId(event) {
  for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId']) {
    if (typeof event[key] === 'string' && event[key].trim()) return event[key];
  }
  return undefined;
}

function getHookEventName(event) {
  for (const key of ['hook_event_name', 'hookEventName', 'event', 'type']) {
    if (typeof event[key] === 'string' && event[key].trim()) return event[key];
  }
  return undefined;
}

function getHookToolId(event) {
  for (const key of [
    'tool_use_id',
    'toolUseId',
    'tool_call_id',
    'toolCallId',
    'call_id',
    'callId',
    'id',
  ]) {
    if (typeof event[key] === 'string' && event[key].trim()) return event[key];
  }
  return `hook-${Date.now()}`;
}

function getHookToolName(event) {
  for (const key of ['tool_name', 'toolName', 'name']) {
    if (typeof event[key] === 'string' && event[key].trim()) return event[key];
  }
  if (event.tool && typeof event.tool === 'object' && typeof event.tool.name === 'string') {
    return event.tool.name;
  }
  return 'tool';
}

function getHookToolInput(event) {
  for (const key of ['tool_input', 'toolInput', 'input', 'arguments']) {
    if (event[key] !== undefined) return event[key];
  }
  if (event.tool && typeof event.tool === 'object' && event.tool.input !== undefined) {
    return event.tool.input;
  }
  return undefined;
}

function getHookDedupeKey(event, eventName) {
  const sessionId = getHookSessionId(event);
  if (!sessionId) return undefined;
  const turnId =
    typeof event.turn_id === 'string'
      ? event.turn_id
      : typeof event.turnId === 'string'
        ? event.turnId
        : '';
  const toolId = getHookToolId(event);
  const sequence =
    typeof event.sequence_number === 'number'
      ? String(event.sequence_number)
      : typeof event.sequenceNumber === 'number'
        ? String(event.sequenceNumber)
        : '';
  if (turnId || sequence || !toolId.startsWith('hook-')) {
    return [sessionId, eventName, turnId, toolId, sequence].join(':');
  }
  return undefined;
}

function isDuplicateHookEvent(event, eventName) {
  const now = Date.now();
  for (const [key, timestamp] of recentHookEvents) {
    if (now - timestamp > dedupeTtlMs) recentHookEvents.delete(key);
  }
  const key = getHookDedupeKey(event, eventName);
  if (!key) return false;
  if (recentHookEvents.has(key)) return true;
  recentHookEvents.set(key, now);
  return false;
}

function processCodexHookEvent(event) {
  const eventName = getHookEventName(event);
  if (!eventName) return { accepted: false, reason: 'missing hook event name' };
  if (isDuplicateHookEvent(event, eventName)) return { accepted: true };
  const agent = addHookAgent(event);
  if (!agent) return { accepted: false, reason: 'missing session id' };
  agent.hookDelivered = true;

  if (eventName === 'SessionStart' || eventName === 'UserPromptSubmit') {
    clearWaitingTimer(agent);
    clearAgentTools(agent);
    broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
    return { accepted: true };
  }

  if (eventName === 'PreToolUse') {
    const toolId = getHookToolId(event);
    const toolName = getHookToolName(event);
    const status = formatCodexToolStatus(toolName, getHookToolInput(event));
    clearWaitingTimer(agent);
    if (!agent.activeToolIds.has(toolId)) {
      agent.activeToolIds.add(toolId);
      agent.activeToolNames.set(toolId, toolName);
      broadcast({ type: 'agentToolStart', id: agent.id, toolId, status, toolName });
    }
    broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
    return { accepted: true };
  }

  if (eventName === 'PostToolUse') {
    const toolId = getHookToolId(event);
    const toolIds = agent.activeToolIds.has(toolId) ? [toolId] : [...agent.activeToolIds];
    for (const id of toolIds) {
      agent.activeToolIds.delete(id);
      agent.activeToolNames.delete(id);
      broadcast({ type: 'agentToolDone', id: agent.id, toolId: id });
    }
    if (agent.activeToolIds.size === 0) scheduleWaiting(agent);
    return { accepted: true };
  }

  if (eventName === 'PermissionRequest') {
    clearWaitingTimer(agent);
    broadcast({ type: 'agentToolPermission', id: agent.id });
    return { accepted: true };
  }

  if (eventName === 'Stop' || eventName === 'PostCompact') {
    clearAgentTools(agent);
    scheduleWaiting(agent);
    return { accepted: true };
  }

  if (eventName === 'PreCompact') {
    clearWaitingTimer(agent);
    broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
    return { accepted: true };
  }

  return { accepted: true };
}

function scanCodexSessions() {
  for (const { file, stat, meta } of discoverSessionFiles()) {
    if (closedFiles.has(file) || agentsByFile.has(file)) continue;
    const known = knownSessionFiles.get(file);
    if (!known) {
      knownSessionFiles.set(file, {
        file,
        offset: stat.size,
        meta,
        lineBuffer: '',
        decoder: new StringDecoder('utf8'),
      });
      continue;
    }
    if (stat.size > known.offset) {
      readPendingLines(known);
    }
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
    hooksEnabled: true,
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

function isAuthorizedHookRequest(req) {
  const header = req.headers.authorization;
  const expected = `Bearer ${hookToken}`;
  const actualBuffer = Buffer.from(typeof header === 'string' ? header : '');
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function handleCodexHook(req, res) {
  if (!validateOrigin(req, res)) return;
  if (!isAuthorizedHookRequest(req)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  let body = '';
  let bodySize = 0;
  let rejected = false;
  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > maxHookBodySize) {
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
      const event = body ? JSON.parse(body) : {};
      const result = processCodexHookEvent(event);
      if (!result.accepted) {
        json(res, 400, { ok: false, error: result.reason });
        return;
      }
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { ok: false, error: 'invalid json' });
    }
  });
}

function writeDiscoveryFile(port) {
  try {
    fs.mkdirSync(pixelAgentsDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${discoveryFile}.tmp`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify(
        {
          provider: 'codex',
          url: `http://127.0.0.1:${port}/api/hooks/codex`,
          token: hookToken,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.renameSync(tmpPath, discoveryFile);
    fs.chmodSync(discoveryFile, 0o600);
  } catch (error) {
    console.warn(`Failed to write Codex hook discovery file: ${error.message}`);
  }
}

function removeDiscoveryFile() {
  try {
    if (!fs.existsSync(discoveryFile)) return;
    const data = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
    if (data.pid === process.pid) fs.unlinkSync(discoveryFile);
  } catch {
    // Discovery cleanup is best-effort; hooks fail closed when the token file is absent.
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
    if (!validateOrigin(req, res)) return;
    handleMessage(req, res);
    return;
  }
  if (req.method === 'POST' && url === '/api/hooks/codex') {
    handleCodexHook(req, res);
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
  writeDiscoveryFile(port);
  console.log(`Pixel Agents standalone Codex server running at http://127.0.0.1:${port}`);
  console.log('Codex lifecycle hook endpoint enabled at /api/hooks/codex.');
  console.log(
    `Watching Codex sessions in ~/.codex/sessions as fallback (last ${scanWindowMinutes} minutes).`,
  );
});

process.once('exit', removeDiscoveryFile);
process.once('SIGINT', () => {
  removeDiscoveryFile();
  process.exit(130);
});
process.once('SIGTERM', () => {
  removeDiscoveryFile();
  process.exit(143);
});
