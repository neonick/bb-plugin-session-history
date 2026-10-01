// bb-plugin-session-history — frontend. A "Past sessions" section on the
// new-thread screen (scoped to the selected project) and a "Sessions" page
// with the full list and a read-only transcript at /sessions/<agent>/<id>.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Markdown,
  definePluginApp,
  useBbNavigate,
  useRpc,
  type PluginHomepageSectionProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { SessionRow, TranscriptRow, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { locale, t } from "@/lib/i18n";

type Agent = SessionRow["agent"];
type AgentFilter = Agent | "all";

const PANEL_PATH = "sessions";
const AGENT_LABEL: Record<Agent, string> = { claude: "Claude", codex: "Codex", qwen: "Qwen" };
const AGENT_TONE: Record<Agent, string> = {
  claude: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  codex: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  qwen: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
function ago(ms: number): string {
  const seconds = Math.round((ms - Date.now()) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return t.justNow;
}

function dateTime(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function folderName(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch (cause) {
    toast.error(errorText(cause));
  }
}

function useSessions(projectId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{
    sessions: SessionRow[] | null;
    roots: string[];
    error: string | null;
  }>({ sessions: null, roots: [], error: null });
  const load = useCallback(() => {
    rpc.call("sessions_list", { projectId }).then(
      (result) => setState({ sessions: result.sessions, roots: result.roots, error: null }),
      (cause) => setState((prev) => ({ ...prev, error: errorText(cause) })),
    );
  }, [rpc, projectId]);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

function AgentBadge({ agent }: { agent: Agent }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-14 shrink-0 items-center justify-center rounded text-[11px] font-medium",
        AGENT_TONE[agent],
      )}
    >
      {AGENT_LABEL[agent]}
    </span>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function matches(session: SessionRow, agent: AgentFilter, query: string): boolean {
  if (agent !== "all" && session.agent !== agent) return false;
  if (query === "") return true;
  const haystack = `${session.title}\n${session.firstPrompt}\n${session.cwd}\n${session.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

function SessionRowView({
  session,
  showFolder,
  onOpen,
}: {
  session: SessionRow;
  showFolder: boolean;
  onOpen: () => void;
}) {
  const subtitle = [
    showFolder ? folderName(session.cwd) : null,
    session.gitBranch,
    session.archived ? t.archived : null,
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={session.firstPrompt || session.title}
        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-state-hover"
      >
        <AgentBadge agent={session.agent} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{session.title}</span>
          {subtitle.length > 0 ? (
            <span className="block truncate text-xs text-muted-foreground">{subtitle.join(" · ")}</span>
          ) : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{ago(session.updatedAt)}</span>
      </button>
    </li>
  );
}

function SessionList({
  sessions,
  error,
  pageSize,
  showFolder,
  toolbarExtra,
}: {
  sessions: SessionRow[] | null;
  error: string | null;
  pageSize: number;
  showFolder: boolean;
  toolbarExtra?: ReactNode;
}) {
  const navigate = useBbNavigate();
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => setLimit(pageSize), [agent, query, pageSize]);

  const counts = useMemo(() => {
    const result: Record<AgentFilter, number> = { all: 0, claude: 0, codex: 0, qwen: 0 };
    for (const session of sessions ?? []) {
      result.all += 1;
      result[session.agent] += 1;
    }
    return result;
  }, [sessions]);
  const filtered = useMemo(
    () => (sessions ?? []).filter((session) => matches(session, agent, query.trim())),
    [sessions, agent, query],
  );
  const filters: AgentFilter[] = ["all", "claude", "codex", "qwen"];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {filters.map((filter) => (
            <Button
              key={filter}
              size="sm"
              variant="ghost"
              aria-pressed={agent === filter}
              disabled={filter !== "all" && counts[filter] === 0}
              onClick={() => setAgent(filter)}
            >
              {filter === "all" ? t.all : AGENT_LABEL[filter]}
              <span className="text-muted-foreground">{counts[filter]}</span>
            </Button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.search}
          aria-label={t.searchLabel}
          className="h-8 min-w-48 flex-1"
        />
        {toolbarExtra}
      </div>
      {error !== null ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-2">
        {sessions === null ? (
          <EmptyState>{t.loadingList}</EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState>{t.emptyList}</EmptyState>
        ) : (
          <>
            <ul className="flex flex-col">
              {filtered.slice(0, limit).map((session) => (
                <SessionRowView
                  key={`${session.agent}/${session.id}`}
                  session={session}
                  showFolder={showFolder}
                  onOpen={() =>
                    navigate.toPluginPanel(PANEL_PATH, { subPath: `${session.agent}/${session.id}` })
                  }
                />
              ))}
            </ul>
            {filtered.length > limit ? (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 w-full text-muted-foreground"
                onClick={() => setLimit((value) => value + 50)}
              >
                {t.showMore(filtered.length - limit)}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function HomepageSessions({ projectId }: PluginHomepageSectionProps) {
  const [allFolders, setAllFolders] = useState(false);
  const { sessions, roots, error } = useSessions(allFolders ? null : projectId);
  const scoped = !allFolders && roots.length > 0;
  return (
    <SessionList
      sessions={sessions}
      error={error}
      pageSize={8}
      showFolder={!scoped}
      toolbarExtra={
        projectId !== null ? (
          <Button size="sm" variant="ghost" aria-pressed={allFolders} onClick={() => setAllFolders((v) => !v)}>
            {t.allFolders}
          </Button>
        ) : null
      }
    />
  );
}

function Message({ entry }: { entry: TranscriptRow }) {
  if (entry.role === "tool") {
    return (
      <div className="flex items-start gap-2 px-1 font-mono text-xs text-muted-foreground">
        <Icon name="Toolbox" className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="min-w-0 break-all">{entry.text}</span>
      </div>
    );
  }
  if (entry.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm">
        <div className="whitespace-pre-wrap break-words">{entry.text}</div>
        {entry.timestamp !== null ? (
          <div className="mt-1 text-right text-[11px] text-muted-foreground">{dateTime(entry.timestamp)}</div>
        ) : null}
      </div>
    );
  }
  return <Markdown content={entry.text} className="text-sm" />;
}

const TRANSCRIPT_PAGE = 150;

function TranscriptView({ agent, id }: { agent: Agent; id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<{
    session: SessionRow;
    entries: TranscriptRow[];
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [limit, setLimit] = useState(TRANSCRIPT_PAGE);

  useEffect(() => {
    setData(null);
    setError(null);
    setLimit(TRANSCRIPT_PAGE);
    rpc.call("session_transcript", { agent, id }).then(setData, (cause) => setError(errorText(cause)));
  }, [rpc, agent, id]);

  const visible = useMemo(
    () => (data?.entries ?? []).filter((entry) => showTools || entry.role !== "tool"),
    [data, showTools],
  );
  const back = () => navigate.toPluginPanel(PANEL_PATH);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <Button size="sm" variant="ghost" onClick={back} className="-ml-2">
          <Icon name="ArrowLeft" />
          {t.allSessions}
        </Button>
        {error !== null ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : data === null ? (
          <div className="mt-3">
            <EmptyState>{t.loadingSession}</EmptyState>
          </div>
        ) : (
          <>
            <div className="mt-2 flex items-start gap-3">
              <AgentBadge agent={data.session.agent} />
              <div className="min-w-0 flex-1">
                <h1 className="text-lg font-semibold leading-snug">{data.session.title}</h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[
                    data.session.cwd,
                    data.session.gitBranch,
                    data.session.model,
                    `${dateTime(data.session.createdAt)} — ${dateTime(data.session.updatedAt)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => copy(data.session.resumeCommand, t.copiedCommand)}>
                <Icon name="Terminal" />
                {t.copyResume}
              </Button>
              <Button size="sm" variant="outline" onClick={() => copy(data.session.id, t.copiedId)}>
                <Icon name="Copy" />
                ID
              </Button>
              <Button size="sm" variant="ghost" aria-pressed={showTools} onClick={() => setShowTools((v) => !v)}>
                <Icon name="Toolbox" />
                {t.tools}
              </Button>
            </div>
            {data.truncated ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {t.truncated(data.entries.length)}
              </p>
            ) : null}
            <div className="mt-5 flex flex-col gap-4">
              {visible.length === 0 ? <EmptyState>{t.emptySession}</EmptyState> : null}
              {visible.slice(0, limit).map((entry, index) => (
                <Message key={index} entry={entry} />
              ))}
            </div>
            {visible.length > limit ? (
              <Button
                size="sm"
                variant="outline"
                className="mt-4 w-full"
                onClick={() => setLimit((value) => value + TRANSCRIPT_PAGE)}
              >
                {t.showMore(visible.length - limit)}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SessionsPage({ subPath }: PluginNavPanelProps) {
  const [agent, id] = subPath.split("/");
  const { sessions, error } = useSessions(null);
  if ((agent === "claude" || agent === "codex" || agent === "qwen") && id) {
    return <TranscriptView agent={agent} id={id} />;
  }
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <SessionList sessions={sessions} error={error} pageSize={100} showFolder />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "past-sessions",
    title: t.pastSessions,
    component: HomepageSessions,
  });
  app.slots.navPanel({
    id: "sessions",
    title: t.sessions,
    icon: "Clock",
    path: PANEL_PATH,
    component: SessionsPage,
  });
});
