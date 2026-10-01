import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { continuationContext, fullTranscript, transcriptParts, CONTEXT_PART_SIZE } from "../lib/sessions/context.js";
import { readClaudeTranscript } from "../lib/sessions/claude.js";
import { readCodexTranscript } from "../lib/sessions/codex.js";
import { readQwenTranscript } from "../lib/sessions/qwen.js";
import type { SessionSummary } from "../lib/sessions/types.js";

const session: SessionSummary = {
  agent: "codex", id: "fixture", title: "Full session", firstPrompt: "start", cwd: "/tmp/project",
  createdAt: 0, updatedAt: 0, gitBranch: null, model: null, archived: false, file: "/tmp/source.jsonl", sizeBytes: 0,
};

for (const agent of ["claude", "codex", "qwen"] as const) {
  test(`${agent}: continuation includes long messages and the last message beyond display limits`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "session-history-test-"));
    const file = path.join(dir, "session.jsonl");
    const messages = ["OPENING " + "x".repeat(45_000), ...Array.from({ length: 4100 }, (_, i) => `message ${i}`), "FINAL STATE marker"];
    const rows = messages.map((text, i) => {
      const timestamp = new Date(i * 1000).toISOString();
      switch (agent) {
        case "claude": return { type: "user", timestamp, message: { role: "user", content: text } };
        case "codex": return { type: "event_msg", timestamp, payload: { type: "user_message", message: text } };
        case "qwen": return { type: "user", provenance: "real_user", timestamp, message: { parts: [{ text }] } };
      }
    });
    try {
      await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n"));
      const read = agent === "claude" ? readClaudeTranscript : agent === "codex" ? readCodexTranscript : readQwenTranscript;
      const display = await read(file);
      assert.equal(display.truncated, true);
      const complete = await read(file, true);
      assert.equal(complete.truncated, false);
      assert.equal(complete.entries.length, messages.length);
      assert.equal(complete.entries[0]!.text, messages[0]);
      assert.equal(complete.entries.at(-1)!.text, "FINAL STATE marker");
      const text = fullTranscript({ ...session, agent }, complete);
      assert.ok(text.includes(messages[0]!));
      assert.ok(text.endsWith("FINAL STATE marker"));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("chunked context retains middle, final state and Unicode across chunk boundaries", () => {
  const text = "a".repeat(CONTEXT_PART_SIZE - 1) + "🦉" + "b".repeat(300_000) + "MIDDLE" + "c".repeat(200_000) + "END";
  const parts = transcriptParts(text);
  assert.equal(parts.join(""), text);
  for (const part of parts) assert.equal(Buffer.from(part).toString("utf8"), part);
  const prompt = continuationContext(session, text, parts.length);
  assert.ok(prompt.includes("Read ALL"));
  assert.ok(prompt.includes(`part=${parts.length}`));
  assert.ok(prompt.includes("session_history_read_context"));
  assert.ok(!prompt.includes("entries from the middle of the session omitted"));
});

test("a bounded transcript cannot be misrepresented as complete context", () => {
  assert.throws(() => fullTranscript(session, { entries: [], truncated: true }), /complete transcript/);
});
