#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const relayScript = path.join(__dirname, 'standalone-codex-hook-relay.mjs');
const codexDir = path.join(os.homedir(), '.codex');
const hooksPath = path.join(codexDir, 'hooks.json');
const backupPath = `${hooksPath}.pixel-agents-bak`;
const hookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'PreCompact',
  'PostCompact',
];
const hookMarker = 'standalone-codex-hook-relay.mjs';

function readHooksFile() {
  try {
    if (!fs.existsSync(hooksPath)) return {};
    return JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${hooksPath}; refusing to overwrite it. ${error.message}`);
  }
}

function writeHooksFile(config) {
  fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(hooksPath)) {
    fs.copyFileSync(hooksPath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  const tmpPath = `${hooksPath}.pixel-agents-tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, hooksPath);
  fs.chmodSync(hooksPath, 0o600);
}

function isPixelAgentsEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((hook) => hook?.command?.includes(hookMarker))
  );
}

function cleanPixelAgentsEntries(config) {
  const next = {
    ...config,
    hooks: {
      ...(config.hooks && typeof config.hooks === 'object' ? config.hooks : {}),
    },
  };
  let changed = false;
  for (const event of Object.keys(next.hooks)) {
    const entries = next.hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((entry) => !isPixelAgentsEntry(entry));
    if (filtered.length !== entries.length) changed = true;
    if (filtered.length) {
      next.hooks[event] = filtered;
    } else {
      delete next.hooks[event];
    }
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { config: next, changed };
}

function makeHookEntry() {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node "${relayScript}"`,
        timeout: 5,
        async: true,
      },
    ],
  };
}

function install() {
  const current = readHooksFile();
  const cleaned = cleanPixelAgentsEntries(current).config;
  const next = {
    ...cleaned,
    hooks: {
      ...(cleaned.hooks && typeof cleaned.hooks === 'object' ? cleaned.hooks : {}),
    },
  };
  for (const event of hookEvents) {
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    next.hooks[event] = [...existing, makeHookEntry()];
  }
  writeHooksFile(next);
  console.log(`Installed Pixel Agents Codex hooks in ${hooksPath}`);
  if (fs.existsSync(backupPath)) console.log(`Backup: ${backupPath}`);
}

function uninstall() {
  const current = readHooksFile();
  const { config, changed } = cleanPixelAgentsEntries(current);
  if (!changed) {
    console.log('Pixel Agents Codex hooks are not installed.');
    return;
  }
  writeHooksFile(config);
  console.log(`Removed Pixel Agents Codex hooks from ${hooksPath}`);
  console.log(`Backup: ${backupPath}`);
}

const command = process.argv[2];
try {
  if (command === 'install') {
    install();
  } else if (command === 'uninstall') {
    uninstall();
  } else {
    console.error('Usage: node scripts/standalone-codex-hooks.mjs <install|uninstall>');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
