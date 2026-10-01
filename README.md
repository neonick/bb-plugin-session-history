# Session History for BB

A [BB](https://getbb.app) plugin that lists your past Claude Code, Codex and
Qwen Code sessions — the ones you ran in a terminal or VS Code — with the titles
the agents gave them, and lets you continue any of them in BB below the original transcript.

- **Past sessions** on the new-thread screen, limited to the selected project's
  folders; **All folders** lifts the limit.
- **Sessions** page in the sidebar: every session, filter by agent, search by
  title, first prompt or folder.
- Transcript view with user and assistant messages, optional tool calls, and a
  button that copies the resume command (`claude --resume`, `codex resume`,
  `qwen --resume`).
- A BB composer below the old conversation. Choose an agent and send the next
  message; the continuation opens inline and stays linked to the session.
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

Original session files are only read. Opening history does not upload it.
Sending a continuation passes its conversation to the agent you select, using
that provider's normal processing. Small conversations are included in full;
large ones are saved without display limits in the plugin database and read
in parts through the `session_history_read_context` agent tool. Tool results and image
contents are not exported; tool calls are described. This creates a new BB
thread with the original title, rather than resuming the provider's native
session. Reopening the session shows the same continuation.

Summaries are cached
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
npm test
bb plugin build .
bb plugin install .        # then: bb plugin reload session-history
```

## License

MIT
