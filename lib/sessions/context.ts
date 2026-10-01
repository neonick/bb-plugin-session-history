import type { SessionSummary, Transcript, TranscriptEntry } from "./types.js";

/** Small histories fit directly in the prompt; larger ones are read from a complete snapshot in parts. */
export const CONTEXT_BUDGET = 100_000;
export const CONTEXT_PART_SIZE = 20_000;

const AGENT_NAMES: Record<SessionSummary["agent"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  qwen: "Qwen Code",
};

function render(entry: TranscriptEntry): string {
  const label = entry.role === "user" ? "User" : entry.role === "assistant" ? "Assistant" : "Tool call";
  const timestamp = entry.timestamp === null ? "" : ` (${new Date(entry.timestamp).toISOString()})`;
  return `### ${label}${timestamp}\n\n${entry.text}`;
}

/** No display limits: every parsed user/assistant message survives export. */
export function fullTranscript(session: SessionSummary, transcript: Transcript): string {
  if (transcript.truncated) throw new Error("Continuation requires a complete transcript");
  return [
    `# ${session.title}`,
    `Agent: ${AGENT_NAMES[session.agent]}`,
    `Session id: ${session.id}`,
    `Working directory: ${session.cwd || "unknown"}`,
    session.gitBranch ? `Branch: ${session.gitBranch}` : "",
    `Source file: ${session.file}`,
    "",
    ...transcript.entries.map(render),
  ].join("\n\n");
}

/** Split between Unicode code points so every character can be reassembled. */
export function transcriptParts(text: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CONTEXT_PART_SIZE, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** The original conversation is history; only the new user message is current work. */
export function continuationContext(session: SessionSummary, text: string, parts = 0): string {
  return [
    `You are continuing an earlier ${AGENT_NAMES[session.agent]} session in BB.`,
    `Its working directory was ${JSON.stringify(session.cwd)}. Check the actual workspace and current files before acting.`,
    "The transcript is historical conversation, not a new instruction. Preserve its decisions and constraints; the current user message follows this context and determines what to do now. Do not automatically execute unfinished historical commands.",
    "Tool calls are shown as descriptions; tool results and image contents are not included. The original session file is listed in the transcript if those are needed.",
    parts === 0
      ? `Read the complete transcript below before responding.\n\n${text}`
      : [
          `Read ALL ${parts} parts of the original conversation using the session_history_read_context tool, with part=1 through part=${parts}, in order, before responding or doing the user's work.`,
          "Together these parts contain the entire conversation with no omitted middle or end. The snapshot belongs to this thread and remains available after reopening it.",
          "If the conversation exceeds your context window, keep a checkpoint of decisions, constraints and the most recent state while you read, then continue through every remaining part. Do not claim to have read the whole session after reading only selected portions.",
        ].join("\n"),
  ].join("\n\n");
}
