import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * Streams a JSONL file and hands parsed records to `onRecord`. Lines that do
 * not contain any of `needles` are skipped before JSON.parse, which keeps
 * multi-hundred-megabyte Codex rollouts cheap. Return `false` to stop early.
 */
export async function scanJsonl(
  file: string,
  needles: readonly string[] | null,
  onRecord: (record: Record<string, unknown>) => boolean | void,
): Promise<void> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line === "") continue;
      if (needles !== null && !needles.some((needle) => line.includes(needle))) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record === null || typeof record !== "object") continue;
      if (onRecord(record as Record<string, unknown>) === false) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

export async function listJsonl(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

export async function statFile(
  file: string,
): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const info = await stat(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

/** Per-file summary cache keyed by mtime and size, so a refresh only rereads changed files. */
export class FileCache<T> {
  private readonly entries = new Map<
    string,
    { mtimeMs: number; size: number; value: T | null }
  >();

  async get(
    file: string,
    load: (info: { mtimeMs: number; size: number }) => Promise<T | null>,
  ): Promise<T | null> {
    const info = await statFile(file);
    if (info === null) {
      this.entries.delete(file);
      return null;
    }
    const cached = this.entries.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.value;
    }
    const value = await load(info);
    this.entries.set(file, { ...info, value });
    return value;
  }
}

/** Runs `fn` over `items` with bounded concurrency. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Best one-line description of a tool call's arguments. */
export function describeToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of [
    "command",
    "cmd",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.join(" ");
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}
