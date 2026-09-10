// Per-task micro state vectors: cheap append-only notes between Keep chatting
// compact cycles. Opt-in via compaction.microVectorsEnabled. Writers never
// throw — a disk hiccup must not fail a turn or a compact.
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

import { harvestAddresses, isBulkPadText, stubBulkPadText } from "./context-compact.ts";
import { workspaceDir } from "./workspace.ts";

export const TASKS_DIRNAME = "tasks";
export const MICRO_VECTORS_DIRNAME = "micro-vectors";
export const LEDGER_FILENAME = "ledger.jsonl";
export const META_FILENAME = "meta.json";

/** Cap a single ledger line's note/goal fields. */
const FIELD_MAX = 240;
const FACT_MAX = 6;
const ADDR_MAX = 12;
const PATH_MAX = 8;
const DEFAULT_READ_CHARS = 12_000;

export type MicroVectorEntry = {
  at: string;
  role: "user" | "assistant";
  goal?: string;
  facts?: string[];
  addresses?: string[];
  landmines?: string[];
  constraints?: string[];
  next?: string;
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

function clipField(text: string | undefined, max = FIELD_MAX): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function uniqCap(items: string[], max: number): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t || t.length > 200) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}

const PATH_RE =
  /(?<![A-Za-z0-9_])((?:~\/|\/|[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z][\w.-]*)/g;
const BARE_PATH_RE =
  /(?<![A-Za-z0-9_./])([\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|yml|yaml|toml|css|html|sh))(?![A-Za-z0-9_])/gi;
const LANDMINE_RE =
  /\b(?:don'?t|do not|never|avoid|warning|landmine|gotcha|pitfall|must not)\b[^.!?\n]{0,120}/gi;
const CONSTRAINT_RE =
  /\b(?:must|only|require[sd]?|constraint|cannot|can'?t|no\s+(?:network|internet|sudo))\b[^.!?\n]{0,100}/gi;

function harvestPaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const p = raw.trim();
    if (!p || p.length > 180) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const m of text.matchAll(PATH_RE)) add(m[1]!);
  for (const m of text.matchAll(BARE_PATH_RE)) add(m[1]!);
  return out.slice(0, PATH_MAX);
}

function harvestSnippets(re: RegExp, text: string, max: number): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const t = m[0]!.replace(/\s+/g, " ").trim();
    if (t.length < 8) continue;
    out.push(t.length > FIELD_MAX ? `${t.slice(0, FIELD_MAX - 1)}…` : t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Heuristic micro note from the latest user (+ optional assistant prose).
 * Skips empty / pad-only turns. Never calls an LLM.
 */
export function buildMicroEntryFromExchange(input: {
  userText?: string;
  assistantText?: string;
  at?: Date;
}): MicroVectorEntry | null {
  const userRaw = input.userText?.trim() ?? "";
  const asstRaw = input.assistantText?.trim() ?? "";
  if (!userRaw && !asstRaw) return null;
  if (userRaw && isBulkPadText(userRaw) && (!asstRaw || isBulkPadText(asstRaw))) return null;

  const user = userRaw ? stubBulkPadText(userRaw) : "";
  const asst = asstRaw && !isBulkPadText(asstRaw) ? asstRaw : asstRaw ? stubBulkPadText(asstRaw) : "";
  const blob = [user, asst].filter(Boolean).join("\n");
  if (!blob.trim()) return null;

  const addresses = uniqCap(harvestAddresses(blob), ADDR_MAX);
  const pathFacts = harvestPaths(blob).map((p) => `path: ${p}`);
  const factLines: string[] = [...pathFacts];
  if (asst) {
    const sentence = asst
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .find((s) => s.length > 20 && s.length < 200 && !/^#{1,6}\s/.test(s));
    if (sentence) factLines.push(sentence);
  }
  const facts = uniqCap(factLines, FACT_MAX);
  const landmines = uniqCap(harvestSnippets(LANDMINE_RE, blob, 4), 4);
  const constraints = uniqCap(harvestSnippets(CONSTRAINT_RE, blob, 4), 4);

  const goal = user
    ? clipField(user.split(/\n/).find((l) => l.trim()) ?? user, FIELD_MAX)
    : undefined;
  const next = asst
    ? clipField(
        asst
          .split(/\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1),
        FIELD_MAX,
      )
    : undefined;

  const entry: MicroVectorEntry = {
    at: (input.at ?? new Date()).toISOString(),
    role: user ? "user" : "assistant",
    ...(goal ? { goal } : {}),
    ...(facts ? { facts } : {}),
    ...(addresses ? { addresses } : {}),
    ...(landmines ? { landmines } : {}),
    ...(constraints ? { constraints } : {}),
    ...(next && next !== goal ? { next } : {}),
    sourceTurnChars: (userRaw.length || 0) + (asstRaw.length || 0),
  };

  // Drop empty shells (only at/role/sourceTurnChars).
  if (!entry.goal && !entry.facts && !entry.addresses && !entry.landmines && !entry.constraints && !entry.next) {
    const note = clipField(user || asst, FIELD_MAX);
    if (!note) return null;
    entry.note = note;
  }
  return entry;
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

function formatEntry(entry: MicroVectorEntry): string {
  if (entry.compacted) return "";
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
