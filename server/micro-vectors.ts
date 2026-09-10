// Per-task rolling notebook for Keep chatting. Opt-in via
// compaction.microVectorsEnabled. Writers never throw — a disk hiccup must
// not fail a turn or a compact.
//
// Product rule: all notebook truth is LLM intelligence, not scripts.
// The harness only decides when to fire, I/O's notebook.md, sanitizes the
// write, and calls generateSideText. No regex/heuristic truth inventing.
//
// Layout (under each bot workspace via workspaceDir):
//   workspaces/<botId>/tasks/<threadId>/meta.json
//   workspaces/<botId>/tasks/<threadId>/notebook.md   ← primary (rolling)
//   workspaces/<botId>/tasks/<threadId>/micro-vectors/ledger.jsonl  ← thin history / migration seed
//
// deleteBot already rmSync(workspaceDir(id)), which wipes tasks/ with it.
// deleteTask → deleteTaskMicroVectors removes tasks/<threadId>/ (notebook included).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { sanitizeForwardOnlyVector } from "./context-compact.ts";
import { workspaceDir } from "./workspace.ts";

export const TASKS_DIRNAME = "tasks";
export const MICRO_VECTORS_DIRNAME = "micro-vectors";
export const LEDGER_FILENAME = "ledger.jsonl";
export const META_FILENAME = "meta.json";
export const NOTEBOOK_FILENAME = "notebook.md";

/** Clip absurdly long assistant replies / user text before the side LLM call. */
export const MICRO_REPLY_CLIP_CHARS = 12_000;
export const MICRO_USER_CLIP_CHARS = 4_000;
const DEFAULT_READ_CHARS = 12_000;

/** Best-effort wait for an in-flight notebook settle update before compact. */
export const NOTEBOOK_AWAIT_MS = 3_000;

export type MicroVectorEntry = {
  at: string;
  role: "user" | "assistant";
  /** Full LLM markdown notebook page (preferred). */
  vector?: string;
  goal?: string;
  facts?: string[];
  addresses?: string[];
  landmines?: string[];
  constraints?: string[];
  next?: string;
  /** Legacy/full markdown page when `vector` is unset. */
  note?: string;
  sourceTurnChars?: number;
  /** Boundary written after a successful compact; readers skip lines before the last one. */
  compacted?: boolean;
};

export type TaskMeta = {
  botId: string;
  threadId: string;
  taskTitle?: string;
  updatedAt: string;
};

function resolveWorkspace(botId: string, baseDir?: string): string {
  return baseDir?.trim() ? baseDir.trim() : workspaceDir(botId);
}

export function taskDir(botId: string, threadId: string, baseDir?: string): string {
  return join(resolveWorkspace(botId, baseDir), TASKS_DIRNAME, threadId);
}

export function microVectorsDir(botId: string, threadId: string, baseDir?: string): string {
  return join(taskDir(botId, threadId, baseDir), MICRO_VECTORS_DIRNAME);
}

export function microLedgerPath(botId: string, threadId: string, baseDir?: string): string {
  return join(microVectorsDir(botId, threadId, baseDir), LEDGER_FILENAME);
}

export function notebookPath(botId: string, threadId: string, baseDir?: string): string {
  return join(taskDir(botId, threadId, baseDir), NOTEBOOK_FILENAME);
}

export function taskMetaPath(botId: string, threadId: string, baseDir?: string): string {
  return join(taskDir(botId, threadId, baseDir), META_FILENAME);
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[clipped]`;
}

/** Ensure tasks/<thread>/ exists (and micro-vectors/ for thin ledger). Returns task dir or null. */
export function ensureTaskMicroDir(
  botId: string,
  threadId: string,
  opts?: { baseDir?: string; taskTitle?: string },
): string | null {
  try {
    const dir = taskDir(botId, threadId, opts?.baseDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(microVectorsDir(botId, threadId, opts?.baseDir), { recursive: true, mode: 0o700 });
    writeTaskMeta(botId, threadId, { taskTitle: opts?.taskTitle, baseDir: opts?.baseDir });
    return dir;
  } catch {
    return null;
  }
}

function writeTaskMeta(
  botId: string,
  threadId: string,
  opts?: { taskTitle?: string; baseDir?: string },
): void {
  try {
    const path = taskMetaPath(botId, threadId, opts?.baseDir);
    mkdirSync(taskDir(botId, threadId, opts?.baseDir), { recursive: true, mode: 0o700 });
    let prev: Partial<TaskMeta> = {};
    if (existsSync(path)) {
      try {
        prev = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskMeta>;
      } catch {
        prev = {};
      }
    }
    const meta: TaskMeta = {
      botId,
      threadId,
      updatedAt: new Date().toISOString(),
      ...(opts?.taskTitle?.trim()
        ? { taskTitle: opts.taskTitle.trim() }
        : prev.taskTitle
          ? { taskTitle: prev.taskTitle }
          : {}),
    };
    writeFileSync(path, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

/**
 * Side-LLM prompt: prior rolling notebook + this turn's user text + assistant
 * reply → updated notebook.md. Dense: Goal / Verified facts / Next primarily;
 * omit empty optional sections (never spam (none)).
 */
export function buildMicroNotebookPrompt(input: {
  priorNotebook?: string;
  userText?: string;
  assistantReply: string;
}): string {
  const prior = (input.priorNotebook ?? "").trim();
  const user = clipText((input.userText ?? "").trim(), MICRO_USER_CLIP_CHARS);
  const reply = clipText(input.assistantReply, MICRO_REPLY_CLIP_CHARS);
  return (
    "Update the rolling task notebook from the prior notebook (if any) plus this turn's user message and assistant reply.\n" +
    "Output a single dense markdown page. Prefer these headings when they have content:\n" +
    "Goal\nVerified facts\nNext action\n" +
    "Add Addresses, Landmines, or Constraints only when this turn (or prior notebook) actually states them.\n" +
    "Rules:\n" +
    "- Quote verbatim. Do not invent facts, paths, ids, or next steps.\n" +
    "- Omit empty sections entirely — never write (none), (not stated), or filler placeholders.\n" +
    "- Carry forward uncontradicted Goal / Verified facts / Addresses / Landmines / Constraints from the prior notebook.\n" +
    "- Ignore [tool …] chips or tool telemetry if any leaked into the reply text.\n" +
    "- Keep each section short (a few lines). No bulk UNIQUE/pad hex.\n" +
    "- Next action: exactly one forward concrete step for the user — never confirm/verify/search for a previous chat turn, an essay from last turn, missing history, or transcript meta.\n" +
    "- Do not put harness/dogfood labels like Fill #N into Goal or Constraints.\n" +
    "- Do not mention compaction, recycling, or a refreshed session.\n" +
    "- Output only the markdown page, no preamble.\n\n" +
    (prior
      ? `Prior notebook:\n${prior}\n\n`
      : "Prior notebook:\n(none yet — start from this turn)\n\n") +
    (user ? `User:\n${user}\n\n` : "") +
    "Assistant reply:\n" +
    reply
  );
}

/**
 * Validate side-LLM notebook markdown. Returns cleaned text or null if empty.
 * Applies the same forward-only Next ban + Fill #N strip as compact.
 */
export function sanitizeNotebookWrite(
  raw: string | null | undefined,
  userText = "",
): string | null {
  const text = raw?.trim() ?? "";
  if (!text || text.length < 8) return null;
  const cleaned = sanitizeForwardOnlyVector(text, userText).trim();
  if (!cleaned || cleaned.length < 8) return null;
  return cleaned;
}

/**
 * Turn a side-LLM notebook response into a ledger entry (thin history).
 * Returns null if empty/useless. Prefer writeTaskNotebook for the primary file.
 */
export function parseMicroNotebookResult(
  raw: string | null | undefined,
  opts?: { at?: Date; sourceTurnChars?: number; userText?: string },
): MicroVectorEntry | null {
  const cleaned = sanitizeNotebookWrite(raw, opts?.userText ?? "");
  if (!cleaned) return null;
  return {
    at: (opts?.at ?? new Date()).toISOString(),
    role: "assistant",
    vector: cleaned,
    ...(typeof opts?.sourceTurnChars === "number" ? { sourceTurnChars: opts.sourceTurnChars } : {}),
  };
}

/** Overwrite tasks/<thread>/notebook.md with sanitized markdown. Never throws. */
export function writeTaskNotebook(input: {
  botId: string;
  threadId: string;
  text: string;
  userText?: string;
  taskTitle?: string;
  baseDir?: string;
  /** When true (default), also append a thin ledger snapshot for history. */
  appendLedger?: boolean;
}): string | null {
  try {
    const cleaned = sanitizeNotebookWrite(input.text, input.userText ?? "");
    if (!cleaned) return null;
    const dir = ensureTaskMicroDir(input.botId, input.threadId, {
      baseDir: input.baseDir,
      taskTitle: input.taskTitle,
    });
    if (!dir) return null;
    const path = notebookPath(input.botId, input.threadId, input.baseDir);
    writeFileSync(path, `${cleaned}\n`, { mode: 0o600 });
    if (input.appendLedger !== false) {
      appendMicroVector({
        botId: input.botId,
        threadId: input.threadId,
        taskTitle: input.taskTitle,
        baseDir: input.baseDir,
        entry: {
          at: new Date().toISOString(),
          role: "assistant",
          vector: cleaned,
        },
      });
    }
    return path;
  } catch {
    return null;
  }
}

/** Append one micro note to the thin ledger. Never throws. Returns ledger path or null. */
export function appendMicroVector(input: {
  botId: string;
  threadId: string;
  taskTitle?: string;
  entry: MicroVectorEntry;
  baseDir?: string;
}): string | null {
  try {
    const dir = ensureTaskMicroDir(input.botId, input.threadId, {
      baseDir: input.baseDir,
      taskTitle: input.taskTitle,
    });
    if (!dir) return null;
    const path = microLedgerPath(input.botId, input.threadId, input.baseDir);
    appendFileSync(path, `${JSON.stringify(input.entry)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

/** Mark a successful compact boundary on the thin ledger (history only). */
export function markMicroCompacted(input: {
  botId: string;
  threadId: string;
  baseDir?: string;
  at?: Date;
}): string | null {
  return appendMicroVector({
    botId: input.botId,
    threadId: input.threadId,
    baseDir: input.baseDir,
    entry: {
      at: (input.at ?? new Date()).toISOString(),
      role: "assistant",
      compacted: true,
    },
  });
}

function parseLedgerLines(raw: string): MicroVectorEntry[] {
  const out: MicroVectorEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as MicroVectorEntry);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

/** Format one ledger entry for the compact LLM prompt / migration seed. */
function formatEntry(entry: MicroVectorEntry): string {
  if (entry.compacted) return "";
  const page = entry.vector?.trim() || entry.note?.trim();
  if (page && (entry.vector || /^(Goal|Verified facts|Addresses|Landmines|Constraints|Next action)\b/m.test(page))) {
    return page;
  }
  const bits: string[] = [];
  if (entry.goal) bits.push(`Goal\n${entry.goal}`);
  if (entry.facts?.length) bits.push(`Verified facts\n${entry.facts.join("\n")}`);
  if (entry.addresses?.length) bits.push(`Addresses\n${entry.addresses.join("\n")}`);
  if (entry.landmines?.length) bits.push(`Landmines\n${entry.landmines.join("\n")}`);
  if (entry.constraints?.length) bits.push(`Constraints\n${entry.constraints.join("\n")}`);
  if (entry.next) bits.push(`Next action\n${entry.next}`);
  if (entry.note) bits.push(entry.note);
  return bits.join("\n");
}

/**
 * Read the thin micro ledger as a text blob (legacy / history).
 * Prefer lines after the last `{compacted:true}` marker.
 */
export function readMicroLedger(
  botId: string,
  threadId: string,
  opts?: { sinceCompactAt?: string; maxChars?: number; baseDir?: string },
): string {
  try {
    const path = microLedgerPath(botId, threadId, opts?.baseDir);
    if (!existsSync(path)) return "";
    const entries = parseLedgerLines(readFileSync(path, "utf8"));
    let start = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.compacted) {
        start = i + 1;
        break;
      }
    }
    if (opts?.sinceCompactAt) {
      const since = Date.parse(opts.sinceCompactAt);
      if (Number.isFinite(since)) {
        const idx = entries.findIndex((e, i) => i >= start && Date.parse(e.at) >= since);
        if (idx >= 0) start = idx;
      }
    }
    const maxChars = opts?.maxChars ?? DEFAULT_READ_CHARS;
    const parts: string[] = [];
    let used = 0;
    for (const entry of entries.slice(start)) {
      const block = formatEntry(entry);
      if (!block) continue;
      if (used + block.length + 2 > maxChars) break;
      parts.push(block);
      used += block.length + 2;
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

/**
 * Latest non-empty notebook page from the thin ledger (for one-shot migration).
 */
function latestLedgerNotebookPage(
  botId: string,
  threadId: string,
  baseDir?: string,
): string {
  try {
    const path = microLedgerPath(botId, threadId, baseDir);
    if (!existsSync(path)) return "";
    const entries = parseLedgerLines(readFileSync(path, "utf8"));
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.compacted) continue;
      const page = formatEntry(entry).trim();
      if (page) return page;
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Primary compact reader: rolling notebook.md.
 * If missing once, optionally seed from the latest ledger.jsonl page and
 * write notebook.md so subsequent reads hit the file.
 */
export function readTaskNotebook(
  botId: string,
  threadId: string,
  opts?: { maxChars?: number; baseDir?: string; seedFromLedger?: boolean },
): string {
  try {
    const path = notebookPath(botId, threadId, opts?.baseDir);
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim();
      if (text) {
        const maxChars = opts?.maxChars ?? DEFAULT_READ_CHARS;
        return text.length > maxChars ? text.slice(0, maxChars) : text;
      }
    }
    if (opts?.seedFromLedger === false) return "";
    const seeded = latestLedgerNotebookPage(botId, threadId, opts?.baseDir).trim();
    if (!seeded) return "";
    // One-shot migration: persist so compact keeps trusting notebook.md.
    try {
      ensureTaskMicroDir(botId, threadId, { baseDir: opts?.baseDir });
      writeFileSync(path, `${seeded}\n`, { mode: 0o600 });
    } catch {
      /* still return seeded even if write fails */
    }
    const maxChars = opts?.maxChars ?? DEFAULT_READ_CHARS;
    return seeded.length > maxChars ? seeded.slice(0, maxChars) : seeded;
  } catch {
    return "";
  }
}

// --- In-flight settle updates (await briefly before compact) ---

const pendingNotebookByThread = new Map<string, Promise<unknown>>();

function notebookKey(botId: string, threadId: string): string {
  return `${botId}::${threadId}`;
}

/** Register a fire-and-forget notebook update so compact can await it briefly. */
export function trackNotebookUpdate(
  botId: string,
  threadId: string,
  update: Promise<unknown>,
): void {
  const key = notebookKey(botId, threadId);
  const tracked = Promise.resolve(update).finally(() => {
    if (pendingNotebookByThread.get(key) === tracked) {
      pendingNotebookByThread.delete(key);
    }
  });
  pendingNotebookByThread.set(key, tracked);
}

/** Best-effort wait for an in-flight notebook write (default ~3s). */
export async function awaitPendingNotebookUpdate(
  botId: string,
  threadId: string,
  ms = NOTEBOOK_AWAIT_MS,
): Promise<void> {
  const pending = pendingNotebookByThread.get(notebookKey(botId, threadId));
  if (!pending) return;
  const bound = Math.max(0, ms);
  if (bound === 0) return;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, bound);
        timer.unref?.();
      }),
    ]);
  } catch {
    /* soft — compact proceeds with whatever notebook is on disk */
  }
}

/**
 * Remove tasks/<threadId>/ (meta + notebook.md + micro-vectors). Safe if missing.
 * deleteBot already recursive-wipes workspaceDir(id) which includes tasks/.
 */
export function deleteTaskMicroVectors(botId: string, threadId: string, baseDir?: string): void {
  try {
    const dir = taskDir(botId, threadId, baseDir);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // If parent tasks/ is empty, tidy it — best-effort.
  try {
    const parent = join(resolveWorkspace(botId, baseDir), TASKS_DIRNAME);
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}
