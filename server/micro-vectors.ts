// Per-task micro state vectors: LLM notebook pages between Keep chatting
// compact cycles. Opt-in via compaction.microVectorsEnabled. Writers never
// throw — a disk hiccup must not fail a turn or a compact.
//
// Product rule: all state-vector truth is LLM intelligence, not scripts.
// The harness only decides when to fire, I/O's the ledger, and calls
// generateText on the assistant's visible reply. No regex/heuristic truth.
//
// Layout (under each bot workspace via workspaceDir):
//   workspaces/<botId>/tasks/<threadId>/meta.json
//   workspaces/<botId>/tasks/<threadId>/micro-vectors/ledger.jsonl
//
// deleteBot already rmSync(workspaceDir(id)), which wipes tasks/ with it.
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

import { workspaceDir } from "./workspace.ts";

export const TASKS_DIRNAME = "tasks";
export const MICRO_VECTORS_DIRNAME = "micro-vectors";
export const LEDGER_FILENAME = "ledger.jsonl";
export const META_FILENAME = "meta.json";

/** Clip absurdly long assistant replies before the side LLM call. */
export const MICRO_REPLY_CLIP_CHARS = 12_000;
const DEFAULT_READ_CHARS = 12_000;

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

export function taskMetaPath(botId: string, threadId: string, baseDir?: string): string {
  return join(taskDir(botId, threadId, baseDir), META_FILENAME);
}

/** Ensure tasks/<thread>/micro-vectors exists. Returns the micro-vectors dir or null. */
export function ensureTaskMicroDir(
  botId: string,
  threadId: string,
  opts?: { baseDir?: string; taskTitle?: string },
): string | null {
  try {
    const dir = microVectorsDir(botId, threadId, opts?.baseDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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
 * Side-LLM prompt: assistant visible reply only → markdown micro notebook page.
 * Truth comes from the reply; do not invent; ignore leaked tool chips.
 */
export function buildMicroNotebookPrompt(assistantReply: string): string {
  const clipped =
    assistantReply.length > MICRO_REPLY_CLIP_CHARS
      ? `${assistantReply.slice(0, MICRO_REPLY_CLIP_CHARS)}\n…[clipped]`
      : assistantReply;
  return (
    "Extract a compact micro state-vector notebook page from the assistant's visible chat reply below.\n" +
    "Use these headings exactly (markdown):\n" +
    "Goal\nVerified facts\nAddresses\nLandmines\nConstraints\nNext action\n" +
    "Rules:\n" +
    "- Quote verbatim from the reply. Do not invent facts, paths, ids, or next steps.\n" +
    "- If the reply does not state a section, write (none) or omit detail — never guess.\n" +
    "- Ignore [tool …] chips or tool telemetry if any leaked into the reply text.\n" +
    "- Keep each section short (a few lines). No bulk UNIQUE/pad hex.\n" +
    "- Next action: exactly one forward concrete step for the user — never confirm/verify/search for a previous chat turn, an essay from last turn, missing history, or transcript meta.\n" +
    "- Do not put harness/dogfood labels like Fill #N into Constraints.\n" +
    "- Do not mention compaction, recycling, or a refreshed session.\n" +
    "- Output only the markdown page, no preamble.\n\n" +
    "Assistant reply:\n" +
    clipped
  );
}

/**
 * Turn a side-LLM notebook response into a ledger entry.
 * Stores the markdown page in `vector` (full page). Returns null if empty/useless.
 */
export function parseMicroNotebookResult(
  raw: string | null | undefined,
  opts?: { at?: Date; sourceTurnChars?: number },
): MicroVectorEntry | null {
  const text = raw?.trim() ?? "";
  if (!text) return null;
  // Refuse pure refusals / empty shells with no substance.
  if (text.length < 8) return null;
  return {
    at: (opts?.at ?? new Date()).toISOString(),
    role: "assistant",
    vector: text,
    ...(typeof opts?.sourceTurnChars === "number" ? { sourceTurnChars: opts.sourceTurnChars } : {}),
  };
}

/** Append one micro note. Never throws. Returns ledger path or null. */
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

/** Mark a successful compact boundary so the next read starts fresh after it. */
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

/** Format one ledger entry for the compact LLM prompt. */
function formatEntry(entry: MicroVectorEntry): string {
  if (entry.compacted) return "";
  const page = entry.vector?.trim() || entry.note?.trim();
  if (page && (entry.vector || /^(Goal|Verified facts|Addresses|Landmines|Constraints|Next action)\b/m.test(page))) {
    return `[${entry.at}] ${entry.role} notebook\n${page}`;
  }
  const bits: string[] = [];
  bits.push(`[${entry.at}] ${entry.role}`);
  if (entry.goal) bits.push(`Goal: ${entry.goal}`);
  if (entry.facts?.length) bits.push(`Facts: ${entry.facts.join("; ")}`);
  if (entry.addresses?.length) bits.push(`Addresses: ${entry.addresses.join(", ")}`);
  if (entry.landmines?.length) bits.push(`Landmines: ${entry.landmines.join("; ")}`);
  if (entry.constraints?.length) bits.push(`Constraints: ${entry.constraints.join("; ")}`);
  if (entry.next) bits.push(`Next: ${entry.next}`);
  if (entry.note) bits.push(entry.note);
  return bits.join("\n");
}

/**
 * Read the micro ledger as a text blob for the compact seed.
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
 * Remove tasks/<threadId>/ (meta + micro-vectors). Safe if missing.
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
