#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const discoveryFile = path.join(os.homedir(), '.pixel-agents', 'standalone-codex-server.json');
const maxBodyBytes = 64 * 1024;

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBodyBytes) {
        reject(new Error('hook payload too large'));
        process.stdin.destroy();
        return;
      }
      body += chunk;
    });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', reject);
  });
}

function readDiscovery() {
  const config = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
  if (typeof config.url !== 'string' || typeof config.token !== 'string') {
    throw new Error('invalid Pixel Agents discovery file');
  }
  const url = new URL(config.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('Pixel Agents hook endpoint must be local HTTP on 127.0.0.1');
  }
  return { url, token: config.token };
}

function postHook(url, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Pixel Agents hook relay timed out'));
    });
    req.end(body);
  });
}

try {
  const body = await readStdin();
  const { url, token } = readDiscovery();
  const status = await postHook(url, token, body || '{}');
  process.exit(status >= 200 && status < 300 ? 0 : 1);
} catch {
  // Hooks must never break Codex. The standalone server also tails JSONL as fallback.
  process.exit(0);
}
