export type Agent = "claude" | "codex" | "qwen";

export const AGENTS: readonly Agent[] = ["claude", "codex", "qwen"];

export interface SessionSummary {
  agent: Agent;
  id: string;
  title: string;
  /** First real user prompt, for search and a subtitle when it differs from title. */
  firstPrompt: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  gitBranch: string | null;
  model: string | null;
  archived: boolean;
  file: string;
  sizeBytes: number;
}

export type EntryRole = "user" | "assistant" | "tool";

export interface TranscriptEntry {
  role: EntryRole;
  text: string;
  timestamp: number | null;
}

export interface Transcript {
  entries: TranscriptEntry[];
  truncated: boolean;
}

export const MAX_ENTRIES = 4000;
export const MAX_TEXT = 40_000;
export const MAX_TOOL_TEXT = 400;
/** Total characters per transcript, so one RPC response stays a few megabytes at most. */
export const MAX_TOTAL_TEXT = 3_000_000;

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Collects entries up to the shared bound; the caller stops reading when full. */
export class TranscriptBuilder {
  readonly entries: TranscriptEntry[] = [];
  truncated = false;
  private totalText = 0;

  get full(): boolean {
    return this.truncated;
  }

  push(role: EntryRole, text: string, timestamp: number | null): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (this.truncated) return;
    const clipped = clip(trimmed, role === "tool" ? MAX_TOOL_TEXT : MAX_TEXT);
    if (this.entries.length >= MAX_ENTRIES || this.totalText + clipped.length > MAX_TOTAL_TEXT) {
      this.truncated = true;
      return;
    }
    this.totalText += clipped.length;
    this.entries.push({ role, text: clipped, timestamp });
  }

  result(): Transcript {
    return { entries: this.entries, truncated: this.truncated };
  }
}
