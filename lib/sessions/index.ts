import { listClaudeSessions, readClaudeTranscript } from "./claude.js";
import { listCodexSessions, readCodexTranscript } from "./codex.js";
import { listQwenSessions, readQwenTranscript } from "./qwen.js";
import type { Agent, SessionSummary, Transcript } from "./types.js";

export * from "./types.js";

const FRESH_MS = 5_000;
let lastScan: { at: number; sessions: SessionSummary[] } | null = null;
let inFlight: Promise<SessionSummary[]> | null = null;

async function scan(log: (message: string) => void): Promise<SessionSummary[]> {
  const sources: [Agent, () => Promise<SessionSummary[]>][] = [
    ["claude", listClaudeSessions],
    ["codex", listCodexSessions],
    ["qwen", listQwenSessions],
  ];
  const results = await Promise.all(
    sources.map(async ([agent, list]) => {
      try {
        return await list();
      } catch (error) {
        log(`${agent}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }),
  );
  return results.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** All sessions, newest first. Concurrent callers share one scan; results stay fresh for a few seconds. */
export async function listSessions(log: (message: string) => void): Promise<SessionSummary[]> {
  if (lastScan && Date.now() - lastScan.at < FRESH_MS) return lastScan.sessions;
  inFlight ??= scan(log).then(
    (sessions) => {
      lastScan = { at: Date.now(), sessions };
      inFlight = null;
      return sessions;
    },
    (error: unknown) => {
      inFlight = null;
      throw error;
    },
  );
  return inFlight;
}

export function isUnder(cwd: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return cwd === base || cwd.startsWith(`${base}/`);
}

export async function findSession(
  agent: Agent,
  id: string,
  log: (message: string) => void,
): Promise<SessionSummary | null> {
  const match = (sessions: SessionSummary[]) =>
    sessions.find((session) => session.agent === agent && session.id === id) ?? null;
  const found = match(await listSessions(log));
  if (found !== null) return found;
  lastScan = null;
  return match(await listSessions(log));
}

export function readTranscript(session: SessionSummary, complete = false): Promise<Transcript> {
  switch (session.agent) {
    case "claude":
      return readClaudeTranscript(session.file, complete);
    case "codex":
      return readCodexTranscript(session.file, complete);
    case "qwen":
      return readQwenTranscript(session.file, complete);
  }
}

export function resumeCommand(session: SessionSummary): string {
  const cd = session.cwd === "" ? "" : `cd ${JSON.stringify(session.cwd)} && `;
  switch (session.agent) {
    case "claude":
      return `${cd}claude --resume ${session.id}`;
    case "codex":
      return `${cd}codex resume ${session.id}`;
    case "qwen":
      return `${cd}qwen --resume ${session.id}`;
  }
}
