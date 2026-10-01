// bb-plugin-session-history — lists past Claude Code, Codex and Qwen Code
// sessions from their local stores, with the titles those agents show
// themselves, and renders a read-only transcript. Session files are only read.
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { homedir } from "node:os";
import { z } from "zod";
import {
  AGENTS,
  findSession,
  isUnder,
  listSessions,
  readTranscript,
  resumeCommand,
  type SessionSummary,
} from "./lib/sessions/index.js";

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
    }),
  },
});

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
      const transcript = await readTranscript(session);
      return { session: toRow(session), ...transcript };
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
