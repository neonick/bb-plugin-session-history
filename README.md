# Session History for BB

A [BB](https://getbb.app) plugin that lists your past Claude Code, Codex and
Qwen Code sessions — the ones you ran in a terminal or VS Code — with the titles
the agents gave them, and opens any of them as a read-only transcript.

- **Past sessions** on the new-thread screen, limited to the selected project's
  folders; **All folders** lifts the limit.
- **Sessions** page in the sidebar: every session, filter by agent, search by
  title, first prompt or folder.
- Transcript view with user and assistant messages, optional tool calls, and a
  button that copies the resume command (`claude --resume`, `codex resume`,
  `qwen --resume`).
- `bb session-history list|show` for the terminal and for agents (see
  `skills/session-history`).

The interface follows the browser language: Russian or English.

## Where titles come from

| Agent       | Store                                     | Title                                                         |
| ----------- | ----------------------------------------- | ------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/<slug>/*.jsonl`       | custom title → AI title → summary → first prompt              |
| Codex       | `~/.codex/state_5.sqlite` (`threads`)     | thread name → generated title → first prompt; subagents hidden |
| Qwen Code   | `~/.qwen/projects/<slug>/chats/*.jsonl`   | first prompt (Qwen Code stores no title)                      |

`CODEX_HOME` is respected. Without `state_5.sqlite` the plugin falls back to
`session_index.jsonl` and the rollout files.

Session files are only read. Nothing leaves the machine. Summaries are cached
in memory per file and refreshed when a file's size or modification time
changes.

## Install

```sh
bb plugin install git:https://github.com/neonick/bb-plugin-session-history.git
```

## Develop

```sh
npm install --include=dev
npm run typecheck
bb plugin build .
bb plugin install .        # then: bb plugin reload session-history
```

## License

MIT
