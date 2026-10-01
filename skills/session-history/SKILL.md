---
name: session-history
description: Find and read past Claude Code, Codex or Qwen Code sessions that ran outside BB (terminal, VS Code) on this machine. Use when the user refers to an earlier session, asks what was done before, or wants its resume command.
---

# Past agent sessions

- `bb session-history list [--agent claude|codex|qwen] [--cwd <path>] [--limit <n>] [--json]` lists sessions newest first with their titles and ids. `--cwd` keeps sessions whose working directory is inside that path.
- `bb session-history show <agent> <session-id> [--json]` prints the transcript (user and assistant messages; `--json` also includes tool calls). Output over BB's 1 MB CLI limit keeps the newest entries.

Sessions are read-only. Quote the session title and id when you reference one.
