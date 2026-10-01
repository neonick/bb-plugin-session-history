// bb-plugin-session-history — lists past Claude Code, Codex and Qwen Code
// sessions from their local stores, with the titles those agents show
// themselves, renders a read-only transcript, and continues a session as a BB
// thread that receives the transcript as agent-only context. Session files are
// only read.
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AGENTS,
  findSession,
  isUnder,
  listSessions,
  readTranscript,
  resumeCommand,
  type Agent,
  type SessionSummary,
} from "./lib/sessions/index.js";
import { CONTEXT_BUDGET, continuationContext, fullTranscript, transcriptParts } from "./lib/sessions/context.js";

const agentSchema = z.enum(AGENTS as [string, ...string[]]).transform((value) => value as SessionSummary["agent"]);

const sessionSchema = z.object({
  agent: z.enum(["claude", "codex", "qwen"]),
  id: z.string(),
  title: z.string(),
  firstPrompt: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  gitBranch: z.string().nullable(),
  model: z.string().nullable(),
  archived: z.boolean(),
  sizeBytes: z.number(),
  resumeCommand: z.string(),
});
export type SessionRow = z.infer<typeof sessionSchema>;

const entrySchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  timestamp: z.number().nullable(),
});
export type TranscriptRow = z.infer<typeof entrySchema>;

export const rpcContract = defineRpcContract({
  sessions_list: {
    input: z
      .object({
        /** Limit to sessions whose cwd is inside this BB project's sources. */
        projectId: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({
      sessions: z.array(sessionSchema),
      roots: z.array(z.string()),
    }),
  },
  session_transcript: {
    input: z.object({ agent: agentSchema, id: z.string().min(1).max(200) }).strict(),
    output: z.object({
      session: sessionSchema,
      entries: z.array(entrySchema),
      truncated: z.boolean(),
      /** The BB thread that already continues this session, if any. */
      threadId: z.string().nullable(),
      /** Seeds for the continuation composer. */
      suggestedProjectId: z.string().nullable(),
      suggestedProviderId: z.string().nullable(),
      suggestedCwd: z.string().nullable(),
    }),
  },
  session_continue: {
    input: z
      .object({
        agent: agentSchema,
        id: z.string().min(1).max(200),
        /** The composer's NewThreadRequest, forwarded to threads.spawn. */
        request: z
          .object({ projectId: z.string(), input: z.array(z.record(z.string(), z.unknown())).min(1) })
          .passthrough(),
      })
      .strict(),
    output: z.object({ threadId: z.string() }),
  },
});

/** BB provider that continues each agent's sessions. */
const PROVIDER_FOR: Record<Agent, string> = {
  claude: "claude-code",
  codex: "codex",
  qwen: "qwen",
};

const linkKey = (agent: Agent, id: string) => `link:${agent}:${id}`;

const HOME = homedir();

/** Shows the home directory as `~` so paths stay readable and screenshots stay anonymous. */
function tildify(cwd: string): string {
  return isUnder(cwd, HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
}

function toRow(session: SessionSummary): SessionRow {
  const { file: _file, ...rest } = session;
  return { ...rest, cwd: tildify(session.cwd), resumeCommand: resumeCommand(session) };
}

const AGENT_LABELS: Record<SessionSummary["agent"], string> = {
  claude: "Claude",
  codex: "Codex",
  qwen: "Qwen",
};

export default async function plugin(bb: BbPluginApi) {
  const warn = (message: string) => bb.log.warn(message);

  async function projectRoots(projectId: string | null | undefined): Promise<string[]> {
    if (!projectId) return [];
    try {
      const project = await bb.sdk.projects.get({ projectId });
      return project.sources.map((source) => source.path);
    } catch (error) {
      warn(`project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** The BB project whose source contains `cwd`, preferring the deepest match. */
  async function projectForCwd(cwd: string): Promise<string | null> {
    if (cwd === "") return null;
    try {
      const projects = await bb.sdk.projects.list();
      let best: { id: string; depth: number } | null = null;
      for (const project of projects) {
        for (const source of project.sources) {
          if (isUnder(cwd, source.path) && (best === null || source.path.length > best.depth)) {
            best = { id: project.id, depth: source.path.length };
          }
        }
      }
      return best?.id ?? null;
    } catch (error) {
      warn(`projects: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function availableProvider(agent: Agent): Promise<string | null> {
    try {
      const providers = await bb.sdk.providers.list();
      const id = PROVIDER_FOR[agent];
      return providers.some((provider) => provider.id === id && provider.available) ? id : null;
    } catch {
      return null;
    }
  }

  /** The live thread linked to a session; a deleted thread drops the link. */
  async function linkedThread(agent: Agent, id: string): Promise<string | null> {
    const link = await bb.storage.kv.get<{ threadId: string }>(linkKey(agent, id));
    if (!link) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId: link.threadId });
      if (thread.deletedAt === null) return thread.id;
    } catch {
      // Missing thread: forget the link below.
    }
    await bb.storage.kv.delete(linkKey(agent, id));
    return null;
  }

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS session_contexts (id TEXT PRIMARY KEY, thread_id TEXT)",
    "CREATE TABLE IF NOT EXISTS session_context_parts (context_id TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(context_id, part))",
  ]);
  const removeContext = (id: string) => {
    db.prepare("DELETE FROM session_context_parts WHERE context_id = ?").run(id);
    db.prepare("DELETE FROM session_contexts WHERE id = ?").run(id);
  };
  bb.events.on("thread.deleted", ({ thread }) => {
    const rows = db.prepare("SELECT id FROM session_contexts WHERE thread_id = ?").all(thread.id) as { id: string }[];
    for (const row of rows) removeContext(row.id);
  });
  bb.agents.registerTool({
    name: "session_history_read_context",
    description: "Read one part of this continuation's complete original conversation. Read all parts in order before answering the first message.",
    parameters: z.object({ part: z.number().int().min(1) }).strict(),
    async execute({ part }, { threadId }) {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: bb.pluginId });
      const id = metadata.sessionContextId;
      if (typeof id !== "string") throw new Error("This thread has no session context");
      const row = db.prepare("SELECT body FROM session_context_parts WHERE context_id = ? AND part = ?").get(id, part) as { body: string } | undefined;
      if (!row) throw new Error("Session context part not found");
      const { total } = db.prepare("SELECT COUNT(*) AS total FROM session_context_parts WHERE context_id = ?").get(id) as { total: number };
      bb.log.info(`context ${id} part ${part}/${total} read by ${threadId}`);
      return `Part ${part}/${total}${part < total ? `; next part: ${part + 1}` : "; end of original conversation"}\n\n${row.body}`;
    },
  });
  bb.agents.configure((context) => ({
    tools: typeof context.pluginMetadata.sessionContextId === "string" ? ["session_history_read_context"] : [],
    skills: [],
  }));

  const creating = new Map<string, Promise<{ threadId: string }>>();

  bb.rpc.register(rpcContract, {
    async sessions_list({ projectId }) {
      const roots = await projectRoots(projectId);
      const all = await listSessions(warn);
      const sessions =
        roots.length === 0 ? all : all.filter((s) => roots.some((root) => isUnder(s.cwd, root)));
      return { sessions: sessions.map(toRow), roots };
    },
    async session_transcript({ agent, id }) {
      const session = await findSession(agent, id, warn);
      if (session === null) throw new Error(`Session ${agent}/${id} not found`);
      const [transcript, threadId, suggestedProjectId, suggestedProviderId] = await Promise.all([
        readTranscript(session),
        linkedThread(agent, id),
        projectForCwd(session.cwd),
        availableProvider(agent),
      ]);
      return { session: toRow(session), ...transcript, threadId, suggestedProjectId, suggestedProviderId, suggestedCwd: session.cwd || null };
    },
    async session_continue({ agent, id, request }) {
      const key = linkKey(agent, id);
      const pending = creating.get(key);
      if (pending) return pending;
      const create = async () => {
        const session = await findSession(agent, id, warn);
        if (session === null) throw new Error(`Session ${agent}/${id} not found`);
        const existing = await linkedThread(agent, id);
        if (existing !== null) {
          // A stale composer must not silently discard a newly submitted message.
          await bb.sdk.threads.send({ threadId: existing, input: request.input } as Parameters<typeof bb.sdk.threads.send>[0]);
          return { threadId: existing };
        }
        const text = fullTranscript(session, await readTranscript(session, true));
        const parts = text.length > CONTEXT_BUDGET ? transcriptParts(text) : [];
        const contextId = parts.length > 0 ? randomUUID() : null;
        if (contextId !== null) {
          db.transaction(() => {
            db.prepare("INSERT INTO session_contexts (id) VALUES (?)").run(contextId);
            const insert = db.prepare("INSERT INTO session_context_parts (context_id, part, body) VALUES (?, ?, ?)");
            parts.forEach((body, index) => insert.run(contextId, index + 1, body));
          })();
        }
        let threadId: string | null = null;
        try {
          const thread = await bb.sdk.threads.spawn({
            ...request,
            title: session.title,
            pluginMetadata: { sessionAgent: agent, sessionId: id, ...(contextId ? { sessionContextId: contextId } : {}) },
            input: [
              { type: "text", text: continuationContext(session, text, parts.length), mentions: [], visibility: "agent-only" },
              ...request.input,
            ],
          } as unknown as Parameters<typeof bb.sdk.threads.spawn>[0]);
          threadId = thread.id;
          if (contextId) db.prepare("UPDATE session_contexts SET thread_id = ? WHERE id = ?").run(thread.id, contextId);
          await bb.storage.kv.set(key, { threadId: thread.id });
          bb.log.info(`continued ${agent}/${id} as ${thread.id} (${text.length} characters, ${parts.length} context parts)`);
          return { threadId: thread.id };
        } catch (error) {
          if (contextId !== null && threadId === null) removeContext(contextId);
          throw error;
        }
      };
      const promise = create();
      creating.set(key, promise);
      try {
        return await promise;
      } finally {
        creating.delete(key);
      }
    },
  });

  const usage = [
    "Usage:",
    "  bb session-history list [--agent claude|codex|qwen] [--cwd <path>] [--limit <n>] [--json]",
    "  bb session-history show <agent> <session-id> [--json]",
  ].join("\n");

  bb.cli.register({
    name: "session-history",
    summary: "List past Claude Code, Codex and Qwen Code sessions and read their transcripts",
    commands: [
      {
        name: "list",
        summary: "List past sessions, newest first",
        usage: "bb session-history list [--agent claude|codex|qwen] [--cwd <path>] [--limit <n>] [--json]",
      },
      {
        name: "show",
        summary: "Print a session transcript",
        usage: "bb session-history show <agent> <session-id> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const option = (name: string) => {
        const index = args.indexOf(name);
        return index === -1 ? undefined : args[index + 1];
      };
      const [command] = args;
      if (command === "list") {
        const agent = option("--agent");
        const cwd = option("--cwd");
        const limit = Math.max(1, Math.min(500, Number(option("--limit") ?? 30) || 30));
        let sessions = await listSessions(warn);
        if (agent) sessions = sessions.filter((s) => s.agent === agent);
        if (cwd) sessions = sessions.filter((s) => isUnder(s.cwd, cwd));
        const rows = sessions.slice(0, limit).map(toRow);
        if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
        const lines = rows.map(
          (s) =>
            `${AGENT_LABELS[s.agent].padEnd(6)} ${new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ")}  ${s.id}  ${s.title}`,
        );
        return { exitCode: 0, stdout: lines.length === 0 ? "No sessions." : lines.join("\n") };
      }
      if (command === "show" && args.length >= 3) {
        const parsed = agentSchema.safeParse(args[1]);
        if (!parsed.success) return { exitCode: 1, stderr: usage };
        const session = await findSession(parsed.data, args[2]!, warn);
        if (session === null) return { exitCode: 1, stderr: `No ${args[1]} session ${args[2]}.` };
        const transcript = await readTranscript(session);
        const entries = json
          ? transcript.entries
          : transcript.entries.filter((entry) => entry.role !== "tool");
        const render = (entry: (typeof entries)[number]) =>
          json
            ? JSON.stringify(entry)
            : `## ${entry.role === "user" ? "User" : "Assistant"}\n\n${entry.text}`;
        // BB caps CLI output; keep the newest entries that fit.
        let budget = PLUGIN_CLI_OUTPUT_MAX_BYTES - 64 * 1024;
        let start = entries.length;
        while (start > 0) {
          const size = Buffer.byteLength(render(entries[start - 1]!)) + 2;
          if (size > budget) break;
          budget -= size;
          start -= 1;
        }
        const kept = entries.slice(start);
        const truncated = transcript.truncated || start > 0;
        if (json) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ session: toRow(session), entries: kept, truncated }),
          };
        }
        const header = `# ${session.title}\n${session.cwd}\n${resumeCommand(session)}`;
        const note = start > 0 ? `\n\n… ${start} earlier entries omitted` : "";
        return { exitCode: 0, stdout: `${header}${note}\n\n${kept.map(render).join("\n\n")}` };
      }
      return { exitCode: command === undefined || command === "help" ? 0 : 1, stdout: usage };
    },
  });
}
