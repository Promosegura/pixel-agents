# Codex Support

This fork keeps the original Claude Code integration and adds a Codex-first path for daily use.

## What Works

- The main `+ Codex` button opens a new VS Code terminal in the selected workspace folder and runs `codex`.
- Pixel Agents watches Codex JSONL transcripts under `~/.codex/sessions/YYYY/MM/DD/`.
- The Codex agent is matched to the newest transcript whose session metadata `cwd` matches the terminal workspace folder.
- Standalone browser mode can receive Codex lifecycle hooks from the local CLI and uses them as the live primary signal.
- Codex `function_call` records animate the character as active tool usage.
- Codex `function_call_output` records clear the active tool animation.
- Codex token totals from `event_msg` `token_count` update the token display.

## Claude Compatibility

Claude Code remains available from the `+ Codex` hover menu:

- `Open Claude Code` keeps launching `claude --session-id <uuid>`.
- `Open Claude Code skip permissions` keeps launching Claude with `--dangerously-skip-permissions`.
- Claude hooks, JSONL polling, sub-agent visualization, and Agent Teams behavior are unchanged.

## Current Limitations

- VS Code extension Codex support still uses transcript polling. Codex lifecycle hooks are currently implemented for standalone browser mode.
- Codex sub-agents are shown as tool activity, not as persistent teammate characters.
- Session matching depends on Codex writing `session_meta.payload.cwd` in its JSONL file.
- The extension scans today's Codex session directory and the two previous day directories.

## Local Development

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Press F5 in VS Code, open the Pixel Agents panel, and click `+ Codex`.

## Standalone Browser Mode

Use this mode when you do not use VS Code and want to watch Codex Desktop or Codex CLI sessions in a normal browser:

```bash
cd /Users/geandre/trabalho/pessoal/pixel-agents
npm run standalone
```

The command builds the UI, starts a local server, and prints a URL like:

```text
http://127.0.0.1:54321
```

Open that URL in a browser. The server watches recent Codex transcripts in `~/.codex/sessions` and streams agent/tool events to the browser UI.

For lower-latency live updates, install the Codex lifecycle hooks once:

```bash
npm run codex:hooks:install
```

The installer adds Pixel Agents entries to `~/.codex/hooks.json`, preserves hooks from other tools, and writes a backup to `~/.codex/hooks.json.pixel-agents-bak`. The hooks post only to the local standalone server at `127.0.0.1` using a per-run bearer token stored in `~/.pixel-agents/standalone-codex-server.json`. If the server is not running, the hook relay exits successfully and the standalone server continues to rely on transcript polling when it starts.

To remove the Pixel Agents hook entries:

```bash
npm run codex:hooks:uninstall
```

If the UI is already built and you only want to start the server:

```bash
npm run standalone:serve
```

Optional environment variables:

- `PIXEL_AGENTS_STANDALONE_WINDOW_MINUTES=720` controls how far back the server scans Codex sessions.
- `PIXEL_AGENTS_STANDALONE_POLL_MS=750` controls the transcript polling interval.
- `PIXEL_AGENTS_STANDALONE_HOOK_TOKEN=<token>` overrides the random per-run hook bearer token for advanced local setups.

Current standalone limits:

- The browser mode observes existing Codex Desktop/CLI sessions; it does not launch Codex from the browser.
- Codex hooks provide live status updates in standalone mode; transcript polling remains the fallback and token usage source.
- Claude Code hooks and Agent Teams remain VS Code-extension functionality for now.
