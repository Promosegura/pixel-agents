# Codex Support

This fork keeps the original Claude Code integration and adds a Codex-first path for daily use.

## What Works

- The main `+ Codex` button opens a new VS Code terminal in the selected workspace folder and runs `codex`.
- Pixel Agents watches Codex JSONL transcripts under `~/.codex/sessions/YYYY/MM/DD/`.
- The Codex agent is matched to the newest transcript whose session metadata `cwd` matches the terminal workspace folder.
- Codex `function_call` records animate the character as active tool usage.
- Codex `function_call_output` records clear the active tool animation.
- Codex token totals from `event_msg` `token_count` update the token display.

## Claude Compatibility

Claude Code remains available from the `+ Codex` hover menu:

- `Open Claude Code` keeps launching `claude --session-id <uuid>`.
- `Open Claude Code skip permissions` keeps launching Claude with `--dangerously-skip-permissions`.
- Claude hooks, JSONL polling, sub-agent visualization, and Agent Teams behavior are unchanged.

## Current Limitations

- Codex support is transcript-polling only. Codex hooks are not installed because Codex does not expose the same Claude Code hook contract used by this extension.
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
