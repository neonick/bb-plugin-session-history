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

const ROOT = path.join(homedir(), ".qwen", "projects");
const cache = new FileCache<SessionSummary>();

interface QwenPart {
  text?: unknown;
  thought?: unknown;
  functionCall?: { name?: unknown; args?: unknown };
}

function parts(record: Record<string, unknown>): QwenPart[] {
  const message = record.message as { parts?: unknown } | undefined;
  return Array.isArray(message?.parts) ? (message.parts as QwenPart[]) : [];
}

function partsText(record: Record<string, unknown>): string {
  return parts(record)
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n\n");
}

async function summarize(
  file: string,
  info: { mtimeMs: number; size: number },
): Promise<SessionSummary | null> {
  let cwd = "";
  let gitBranch: string | null = null;
  let createdAt: number | null = null;
  let model: string | null = null;
  let firstPrompt = "";
  await scanJsonl(file, ['"session_model"', '"real_user"', '"session_source"'], (record) => {
    if (cwd === "" && typeof record.cwd === "string") cwd = record.cwd;
    if (gitBranch === null && typeof record.gitBranch === "string") gitBranch = record.gitBranch;
    createdAt ??= toMs(record.timestamp);
    if (record.subtype === "session_model") {
      const id = (record.systemPayload as { modelId?: unknown } | undefined)?.modelId;
      if (typeof id === "string") model = id;
    }
    if (record.type === "user" && record.provenance === "real_user") {
      firstPrompt = partsText(record);
      return false;
    }
  });
  if (firstPrompt.trim() === "") return null;
  return {
    agent: "qwen",
    id: path.basename(file, ".jsonl"),
    title: clip(oneLine(firstPrompt), 200),
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

export async function listQwenSessions(): Promise<SessionSummary[]> {
  const chatDirs = (await listDirs(ROOT)).map((dir) => path.join(dir, "chats"));
  const files = (await mapLimit(chatDirs, 8, listJsonl)).flat();
  const summaries = await mapLimit(files, 8, (file) =>
    cache.get(file, (info) => summarize(file, info)),
  );
  return summaries.filter((summary): summary is SessionSummary => summary !== null);
}

export async function readQwenTranscript(file: string, complete = false): Promise<Transcript> {
  const builder = new TranscriptBuilder(complete);
  await scanJsonl(file, ['"real_user"', '"type":"assistant"'], (record) => {
    const timestamp = toMs(record.timestamp);
    if (record.type === "user" && record.provenance === "real_user") {
      builder.push("user", partsText(record), timestamp);
    } else if (record.type === "assistant") {
      builder.push("assistant", partsText(record), timestamp);
      for (const part of parts(record)) {
        const call = part.functionCall;
        if (call && typeof call.name === "string") {
          builder.push("tool", `${call.name}: ${oneLine(describeToolInput(call.args))}`, timestamp);
        }
      }
    }
    return !builder.full;
  });
  return builder.result();
}
