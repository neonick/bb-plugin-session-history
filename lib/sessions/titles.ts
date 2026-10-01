import { FileCache, scanJsonl } from "./files.js";

const recoveredTitles = new FileCache<string>();
const continuation = /^You are continuing an earlier (?:Claude Code|Codex|Qwen Code) session\b/;

function transcriptTitle(text: string): string | null {
  return /(?:^|\n)# ([^\n]+)\n\nAgent: (?:Claude Code|Codex|Qwen Code)\n\nSession id: [^\n]+/.exec(text)?.[1]?.trim() || null;
}

/** Recover original names without changing native session files or custom names. */
export async function codexSessionTitle(name: string | null, title: string, firstPrompt: string, file: string): Promise<string> {
  if (name?.trim()) return name.trim();
  const selected = title.trim() || firstPrompt.trim();
  if (!continuation.test(selected)) return selected;
  const marker = /^Original session title: (.+)$/m.exec(firstPrompt.split("\n\nRead ")[0]!);
  if (marker) {
    try {
      const original: unknown = JSON.parse(marker[1]!);
      if (typeof original === "string" && original.trim()) return original.trim();
    } catch { /* Older prompts have only the transcript header. */ }
  }
  const embedded = transcriptTitle(firstPrompt);
  if (embedded) return embedded;
  const recovered = await recoveredTitles.get(file, async () => {
    let result: string | null = null;
    await scanJsonl(file, ['"session_history_read_context"'], (record) => {
      const payload = record.payload as { item?: { type?: string; tool?: string; arguments?: { part?: number }; content_items?: { text?: string }[] } } | undefined;
      const item = payload?.item;
      if (item?.type !== "DynamicToolCall" || item.tool !== "session_history_read_context" || item.arguments?.part !== 1) return;
      for (const content of item.content_items ?? []) {
        result = transcriptTitle(content.text ?? "");
        if (result) break;
      }
      return false;
    });
    return result;
  });
  return recovered || "Продолжение сессии";
}
