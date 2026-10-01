import { codexSessionTitle } from "../lib/sessions/titles.js";
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


test("continuation titles survive direct and chunked context, including existing sessions", async () => {
  const titled = { ...session, title: 'История сессий "Claude" в BB' };
  const text = fullTranscript(titled, { entries: [], truncated: false });
  const direct = continuationContext(titled, text);
  const chunked = continuationContext(titled, text, 2);
  assert.equal(await codexSessionTitle(null, direct, direct, "/missing"), titled.title);
  assert.equal(await codexSessionTitle(null, chunked, chunked, "/missing"), titled.title);
  assert.equal(await codexSessionTitle("Моё название", direct, direct, "/missing"), "Моё название");
  assert.equal(await codexSessionTitle(null, "Обычная сессия", direct, "/missing"), "Обычная сессия");
  const legacy = direct.replace(/^Original session title: .+\n\n/m, "");
  assert.equal(await codexSessionTitle(null, legacy, legacy, "/missing"), titled.title);
  const legacyChunked = chunked.replace(/^Original session title: .+\n\n/m, "");
  const dir = await mkdtemp(path.join(tmpdir(), "session-history-title-"));
  const file = path.join(dir, "session.jsonl");
  try {
    await writeFile(file, JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
      type: "DynamicToolCall", tool: "session_history_read_context", arguments: { part: 1 },
      content_items: [{ type: "inputText", text: `Part 1/2; next part: 2\n\n${text}` }],
    } } }));
    assert.equal(await codexSessionTitle(null, legacyChunked, legacyChunked, file), titled.title);
    assert.equal(await codexSessionTitle(null, legacyChunked, legacyChunked, "/missing"), "Продолжение сессии");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
