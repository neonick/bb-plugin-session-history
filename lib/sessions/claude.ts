import { homedir } from "node:os";
import path from "node:path";
import {
  FileCache,
  describeToolInput,
  listDirs,
  listJsonl,
  mapLimit,
  scanJsonl,
} from "./files.js";
import {
  TranscriptBuilder,
  clip,
  oneLine,
  toMs,
  type SessionSummary,
  type Transcript,
} from "./types.js";

const ROOT = path.join(homedir(), ".claude", "projects");
const cache = new FileCache<SessionSummary>();

/**
 * Text of a real user prompt, or null for tool results, meta records,
 * local-command echoes and injected reminders. Slash commands render as
 * `/name args`.
 */
function userText(record: Record<string, unknown>): string | null {
  if (record.isMeta === true || record.isSidechain === true) return null;
  if (record.isCompactSummary === true) return null;
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const typed = part as { type?: string; text?: unknown };
      if (typed.type === "tool_result") return null;
      if (typed.type === "text" && typeof typed.text === "string") {
        if (typed.text.startsWith("<system-reminder>")) continue;
        parts.push(typed.text);
      } else if (typed.type === "image") {
        parts.push("[изображение]");
      }
    }
    text = parts.join("\n\n");
  } else {
    return null;
  }
  // IDE context and reminders the extensions inject alongside the prompt.
  text = text.replace(
    /<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>/g,
    "",
  );
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
    return `${command[1]!.trim()} ${args.trim()}`.trim();
  }
  if (
    text.startsWith("<local-command-") ||
    text.startsWith("<local-command-caveat>") ||
    text.startsWith("Caveat: The messages below")
  ) {
    return null;
  }
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

async function summarize(
  file: string,
  info: { mtimeMs: number; size: number },
): Promise<SessionSummary | null> {
  let cwd = "";
  let gitBranch: string | null = null;
  let createdAt: number | null = null;
  let firstPrompt = "";
  let customTitle = "";
  let aiTitle = "";
  let summary = "";
  let model: string | null = null;
  await scanJsonl(
    file,
    [
      '"type":"user"',
      '"ai-title"',
      '"custom-title"',
      '"type":"summary"',
      '"model":"claude',
    ],
    (record) => {
      switch (record.type) {
        case "custom-title":
          if (typeof record.customTitle === "string") customTitle = record.customTitle;
          return;
        case "ai-title":
          if (typeof record.aiTitle === "string") aiTitle = record.aiTitle;
          return;
        case "summary":
          if (typeof record.summary === "string") summary = record.summary;
          return;
        case "assistant": {
          const name = (record.message as { model?: unknown } | undefined)?.model;
          if (model === null && typeof name === "string" && name !== "<synthetic>") {
            model = name;
          }
          return;
        }
        case "user": {
          if (cwd === "" && typeof record.cwd === "string") cwd = record.cwd;
          if (gitBranch === null && typeof record.gitBranch === "string" && record.gitBranch !== "") {
            gitBranch = record.gitBranch;
          }
          createdAt ??= toMs(record.timestamp);
          if (firstPrompt === "") firstPrompt = userText(record) ?? "";
          return;
        }
      }
    },
  );
  const title = customTitle || aiTitle || summary || firstPrompt;
  if (title === "") return null;
  return {
    agent: "claude",
    id: path.basename(file, ".jsonl"),
    title: clip(oneLine(title), 200),
    firstPrompt: clip(oneLine(firstPrompt), 300),
    cwd,
    createdAt: createdAt ?? info.mtimeMs,
    updatedAt: info.mtimeMs,
    gitBranch,
    model,
    archived: false,
    file,
    sizeBytes: info.size,
  };
}

export async function listClaudeSessions(): Promise<SessionSummary[]> {
  const files = (await mapLimit(await listDirs(ROOT), 8, listJsonl)).flat();
  const summaries = await mapLimit(files, 8, (file) =>
    cache.get(file, (info) => summarize(file, info)),
  );
  return summaries.filter((summary): summary is SessionSummary => summary !== null);
}

export async function readClaudeTranscript(file: string, complete = false): Promise<Transcript> {
  const builder = new TranscriptBuilder(complete);
  await scanJsonl(file, ['"type":"user"', '"type":"assistant"'], (record) => {
    const timestamp = toMs(record.timestamp);
    if (record.isSidechain === true) return;
    if (record.type === "user") {
      const text = userText(record);
      if (text !== null) builder.push("user", text, timestamp);
    } else if (record.type === "assistant") {
      const content = (record.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (part === null || typeof part !== "object") continue;
        const typed = part as { type?: string; text?: unknown; name?: unknown; input?: unknown };
        if (typed.type === "text" && typeof typed.text === "string") {
          builder.push("assistant", typed.text, timestamp);
        } else if (typed.type === "tool_use" && typeof typed.name === "string") {
          builder.push("tool", `${typed.name}: ${oneLine(describeToolInput(typed.input))}`, timestamp);
        }
      }
    }
    return !builder.full;
  });
  return builder.result();
}
