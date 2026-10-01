import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  FileCache,
  describeToolInput,
  listDirs,
  listJsonl,
  mapLimit,
  scanJsonl,
  statFile,
} from "./files.js";
import {
  TranscriptBuilder,
  clip,
  oneLine,
  toMs,
  type SessionSummary,
  type Transcript,
  type TranscriptEntry,
} from "./types.js";

const CODEX_HOME = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");

interface ThreadRow {
  id: string;
  rollout_path: string;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  cwd: string;
  name: string | null;
  title: string;
  first_user_message: string;
  archived: number;
  git_branch: string | null;
  model: string | null;
}

/**
 * Codex keeps the names its VS Code extension shows in state_5.sqlite
 * (`name`, falling back to the generated `title`). Subagent threads carry a
 * JSON `source` and threads without a visible preview are hidden, matching
 * Codex's own list.
 */
async function listFromStateDb(): Promise<SessionSummary[] | null> {
  if (!existsSync(STATE_DB)) return null;
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return null;
  }
  const db = new sqlite.DatabaseSync(STATE_DB, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, rollout_path, created_at_ms, updated_at_ms, cwd, name, title,
                first_user_message, archived, git_branch, model
           FROM threads
          WHERE preview <> '' AND source NOT LIKE '{%'`,
      )
      .all() as unknown as ThreadRow[];
    const sessions = await mapLimit(rows, 16, async (row) => {
      const info = await statFile(row.rollout_path);
      const title = row.name?.trim() || row.title.trim() || row.first_user_message.trim();
      const summary: SessionSummary = {
        agent: "codex",
        id: row.id,
        title: clip(oneLine(title), 200),
        firstPrompt: clip(oneLine(row.first_user_message), 300),
        cwd: row.cwd,
        createdAt: row.created_at_ms ?? 0,
        updatedAt: row.updated_at_ms ?? row.created_at_ms ?? 0,
        gitBranch: row.git_branch,
        model: row.model,
        archived: row.archived === 1,
        file: row.rollout_path,
        sizeBytes: info?.size ?? 0,
      };
      return info === null ? null : summary;
    });
    return sessions.filter((session): session is SessionSummary => session !== null);
  } finally {
    db.close();
  }
}

const rolloutCache = new FileCache<SessionSummary>();

/** Fallback for Codex builds without state_5.sqlite: names from session_index.jsonl. */
async function listFromRollouts(): Promise<SessionSummary[]> {
  const names = new Map<string, string>();
  await scanJsonl(path.join(CODEX_HOME, "session_index.jsonl"), null, (record) => {
    if (typeof record.id === "string" && typeof record.thread_name === "string") {
      names.set(record.id, record.thread_name);
    }
  });
  const files: string[] = [];
  for (const root of ["sessions", "archived_sessions"]) {
    const base = path.join(CODEX_HOME, root);
    files.push(...(await listJsonl(base)));
    for (const year of await listDirs(base)) {
      for (const month of await listDirs(year)) {
        for (const day of await listDirs(month)) files.push(...(await listJsonl(day)));
      }
    }
  }
  const sessions = await mapLimit(files, 8, (file) =>
    rolloutCache.get(file, async (info) => {
      let meta: Record<string, unknown> | null = null;
      let firstPrompt = "";
      await scanJsonl(file, ['"session_meta"', '"user_message"'], (record) => {
        const payload = record.payload as Record<string, unknown> | undefined;
        if (record.type === "session_meta" && payload) meta ??= payload;
        if (payload?.type === "user_message" && typeof payload.message === "string") {
          firstPrompt = payload.message;
          return false;
        }
      });
      if (meta === null) return null;
      const { id, cwd, timestamp, source } = meta as Record<string, unknown>;
      if (typeof id !== "string" || (source !== null && typeof source === "object")) return null;
      const title = names.get(id) || firstPrompt;
      if (title === "") return null;
      const summary: SessionSummary = {
        agent: "codex",
        id,
        title: clip(oneLine(title), 200),
        firstPrompt: clip(oneLine(firstPrompt), 300),
        cwd: typeof cwd === "string" ? cwd : "",
        createdAt: toMs(timestamp) ?? info.mtimeMs,
        updatedAt: info.mtimeMs,
        gitBranch: null,
        model: null,
        archived: file.includes(`${path.sep}archived_sessions${path.sep}`),
        file,
        sizeBytes: info.size,
      };
      return summary;
    }),
  );
  return sessions.filter((session): session is SessionSummary => session !== null);
}

export async function listCodexSessions(): Promise<SessionSummary[]> {
  return (await listFromStateDb()) ?? (await listFromRollouts());
}

/** Injected context Codex stores as user messages in older rollouts. */
function isInjected(text: string): boolean {
  return (
    /^<[a-z_-]+>/i.test(text) ||
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<environment_context>")
  );
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * Codex has written three shapes over time. Current rollouts carry clean
 * `item_completed` items; older ones have `event_msg` user/agent messages;
 * the oldest only have raw `response_item` messages mixed with injected
 * context. The first shape that yields a user message wins.
 */
export async function readCodexTranscript(file: string): Promise<Transcript> {
  const items = new TranscriptBuilder();
  const events = new TranscriptBuilder();
  const raw = new TranscriptBuilder();
  await scanJsonl(
    file,
    [
      '"UserMessage"',
      '"AgentMessage"',
      '"CommandExecution"',
      '"FileChange"',
      '"user_message"',
      '"agent_message"',
      '"type":"message"',
      '"function_call"',
      '"custom_tool_call"',
    ],
    (record) => {
      const payload = record.payload as Record<string, unknown> | undefined;
      if (!payload) return;
      const timestamp = toMs(record.timestamp);
      if (record.type === "event_msg" && payload.type === "item_completed") {
        const item = payload.item as Record<string, unknown> | undefined;
        switch (item?.type) {
          case "UserMessage":
            items.push("user", contentText(item.content), timestamp);
            break;
          case "AgentMessage":
            items.push("assistant", contentText(item.content), timestamp);
            break;
          case "CommandExecution": {
            const command = Array.isArray(item.command) ? item.command.at(-1) : item.command;
            items.push("tool", `exec: ${oneLine(String(command ?? ""))}`, timestamp);
            break;
          }
          case "FileChange": {
            const changes = item.changes as Record<string, unknown> | undefined;
            items.push("tool", `edit: ${Object.keys(changes ?? {}).join(", ")}`, timestamp);
            break;
          }
        }
      } else if (record.type === "event_msg") {
        if (payload.type === "user_message" && typeof payload.message === "string") {
          events.push("user", payload.message, timestamp);
        } else if (payload.type === "agent_message" && typeof payload.message === "string") {
          events.push("assistant", payload.message, timestamp);
        }
      } else if (record.type === "response_item") {
        if (payload.type === "message") {
          const text = contentText(payload.content);
          if (payload.role === "user" && !isInjected(text)) raw.push("user", text, timestamp);
          if (payload.role === "assistant") raw.push("assistant", text, timestamp);
        } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
          const input = payload.type === "function_call" ? payload.arguments : payload.input;
          let parsed: unknown = input;
          if (typeof input === "string" && input.startsWith("{")) {
            try {
              parsed = JSON.parse(input);
            } catch {
              parsed = input;
            }
          }
          const tool = `${String(payload.name)}: ${oneLine(describeToolInput(parsed))}`;
          raw.push("tool", tool, timestamp);
          events.push("tool", tool, timestamp);
        }
      }
      return !(items.full && events.full && raw.full);
    },
  );
  const hasUser = (entries: TranscriptEntry[]) => entries.some((entry) => entry.role === "user");
  if (hasUser(items.entries)) return items.result();
  if (hasUser(events.entries)) return events.result();
  return raw.result();
}
