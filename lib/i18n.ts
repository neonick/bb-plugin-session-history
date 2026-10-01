// UI strings in Russian and English, picked from the browser language.
const en = {
  pastSessions: "Past sessions",
  sessions: "Sessions",
  all: "All",
  allFolders: "All folders",
  search: "Search by title, prompt or folder",
  searchLabel: "Search sessions",
  loadingList: "Reading sessions…",
  emptyList: "No sessions found.",
  showMore: (count: number) => `Show more (${count})`,
  archived: "archived",
  justNow: "just now",
  allSessions: "All sessions",
  loadingSession: "Reading session…",
  copyResume: "Copy resume command",
  tools: "Tools",
  truncated: (count: number) => `This session is very long: showing the first ${count} entries.`,
  emptySession: "This session has no messages.",
  copiedCommand: "Command copied",
  copiedId: "Session ID copied",
  showEarlier: (count: number) => `Show earlier (${count})`,
  openThread: "Open thread",
  continueHint: "Continue this session in BB",
  continuedHere: "Continued in BB",
  continuePlaceholder: "Continue the session: the agent reads the entire conversation",
};

const ru: typeof en = {
  pastSessions: "Прошлые сессии",
  sessions: "Сессии",
  all: "Все",
  allFolders: "Все папки",
  search: "Поиск по названию, вопросу, папке",
  searchLabel: "Поиск сессий",
  loadingList: "Читаю сессии…",
  emptyList: "Сессий не найдено.",
  showMore: (count) => `Показать ещё (${count})`,
  archived: "архив",
  justNow: "только что",
  allSessions: "Все сессии",
  loadingSession: "Читаю сессию…",
  copyResume: "Скопировать команду продолжения",
  tools: "Инструменты",
  truncated: (count) => `Сессия очень длинная: показаны первые ${count} записей.`,
  emptySession: "В сессии нет сообщений.",
  copiedCommand: "Команда скопирована",
  copiedId: "ID сессии скопирован",
  showEarlier: (count) => `Показать раньше (${count})`,
  openThread: "Открыть тред",
  continueHint: "Продолжить эту сессию в BB",
  continuedHere: "Продолжение в BB",
  continuePlaceholder: "Продолжите сессию: агент прочитает всю переписку",
};

export const locale =
  typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";

export const t = locale === "ru" ? ru : en;
