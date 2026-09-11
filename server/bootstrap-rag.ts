// Keep chatting M3: catalog pointers + keyword host RAG over notebook / archives.
// Keyword-first (no embed dependency). Used only when bootstrapHybrid is on.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  harvestAddresses,
  harvestPathsFromText,
  latestBootstrapSections,
} from "./context-compact.ts";
import { notebooksArchiveDir, TURN_PAGE_SEPARATOR } from "./micro-vectors.ts";

export const RAG_TOP_K_DEFAULT = 3;
export const RAG_CHUNK_MAX_CHARS = 900;
export const RAG_ATTACH_BUDGET_CHARS = 2_400;

const STOP = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "this",
  "from",
  "have",
  "will",
  "your",
  "into",
  "about",
  "when",
  "what",
  "which",
  "their",
  "there",
  "been",
  "were",
  "they",
  "them",
  "then",
  "than",
  "also",
  "just",
  "like",
  "goal",
  "open",
  "turn",
  "next",
  "action",
  "verified",
  "facts",
  "addresses",
  "landmines",
  "constraints",
  "continue",
  "please",
]);

/** Sorted archive basenames under tasks/<thread>/notebooks/ (session-NNN.md). */
export function listNotebookArchives(
  botId: string,
  threadId: string,
  baseDir?: string,
): string[] {
  try {
    const dir = notebooksArchiveDir(botId, threadId, baseDir);
    if (!existsSync(dir)) return [];
    const names = readdirSync(dir)
      .filter((n) => /^session-.+\.md$/i.test(n))
      .sort((a, b) => {
        const na = Number((/^session-(\d+)\.md$/i.exec(a) ?? [])[1] ?? 0);
        const nb = Number((/^session-(\d+)\.md$/i.exec(b) ?? [])[1] ?? 0);
        if (na && nb) return na - nb;
        return a.localeCompare(b);
      });
    return names;
  } catch {
    return [];
  }
}

/** Full text of the highest-numbered (latest) archive, or "". */
export function readLatestNotebookArchive(
  botId: string,
  threadId: string,
  baseDir?: string,
  maxChars = 64_000,
): string {
  try {
    const names = listNotebookArchives(botId, threadId, baseDir);
    if (!names.length) return "";
    const latest = names[names.length - 1]!;
    const path = join(notebooksArchiveDir(botId, threadId, baseDir), latest);
    if (!existsSync(path)) return "";
    const raw = readFileSync(path, "utf8");
    return raw.length > maxChars ? raw.slice(-maxChars) : raw;
  } catch {
    return "";
  }
}

/**
 * P1 Catalog bullets: archives on disk, top Addresses/paths, short topic pins.
 * Pointers only — never file bodies.
 */
export function buildNotebookCatalogHints(input: {
  notebook: string;
  botId?: string;
  threadId?: string;
  baseDir?: string;
}): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  const push = (line: string) => {
    const t = line.trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    hints.push(t);
  };

  if (input.botId && input.threadId) {
    const archives = listNotebookArchives(input.botId, input.threadId, input.baseDir);
    for (const name of archives.slice(-6)) {
      push(`archive notebooks/${name}`);
    }
    if (archives.length) {
      push(`${archives.length} archived notebook session(s)`);
    }
  }

  const sections = latestBootstrapSections(input.notebook ?? "");
  const addrs = [
    ...(sections.addresses
      ? sections.addresses
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : []),
    ...harvestAddresses(input.notebook),
    ...harvestPathsFromText(input.notebook),
  ];
  let addrCount = 0;
  for (const a of addrs) {
    if (addrCount >= 8) break;
    push(`address ${a}`);
    addrCount++;
  }

  if (sections.goal?.trim()) {
    const g = sections.goal.trim().replace(/\s+/g, " ");
    push(`topic ${g.length > 120 ? `${g.slice(0, 120).trimEnd()}…` : g}`);
  }
  if (sections.facts?.trim()) {
    const first = sections.facts
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^\(none\)/i.test(l));
    if (first) {
      const f = first.replace(/\s+/g, " ");
      push(`fact ${f.length > 100 ? `${f.slice(0, 100).trimEnd()}…` : f}`);
    }
  }

  return hints.slice(0, 14);
}

export function tokenizeQuery(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9_./+-]+/i)) {
    const t = raw.trim();
    if (t.length < 3 || STOP.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 48) break;
  }
  return out;
}

/** Split source text into retrieval chunks (turn pages, then soft length clips). */
export function splitRetrievalChunks(
  sourceId: string,
  text: string,
  maxChunkChars = RAG_CHUNK_MAX_CHARS,
): Array<{ id: string; text: string }> {
  const raw = (text ?? "").trim();
  if (!raw) return [];
  const pages = raw
    .split(new RegExp(`\n(?:${TURN_PAGE_SEPARATOR})\n`))
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: Array<{ id: string; text: string }> = [];
  let i = 0;
  for (const page of pages.length ? pages : [raw]) {
    if (page.length <= maxChunkChars) {
      chunks.push({ id: `${sourceId}#${i++}`, text: page });
      continue;
    }
    let offset = 0;
    while (offset < page.length) {
      const slice = page.slice(offset, offset + maxChunkChars).trim();
      if (slice) chunks.push({ id: `${sourceId}#${i++}`, text: slice });
      offset += maxChunkChars;
      if (chunks.length >= 80) return chunks;
    }
  }
  return chunks;
}

function scoreChunk(tokens: string[], chunk: string): number {
  if (!tokens.length || !chunk) return 0;
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!lower.includes(t)) continue;
    // Prefer rarer / longer tokens lightly.
    score += 1 + Math.min(2, Math.floor(t.length / 6));
    if (/^0x[0-9a-f]+$/i.test(t) || t.includes("/") || t.includes(".")) score += 2;
  }
  return score;
}

export type RetrievedChunk = { id: string; score: number; text: string };

/** Keyword top-k over notebook + archive sources. */
export function keywordRetrieve(input: {
  query: string;
  sources: Array<{ id: string; text: string }>;
  topK?: number;
  maxChunkChars?: number;
}): RetrievedChunk[] {
  const tokens = tokenizeQuery(input.query);
  if (!tokens.length) return [];
  const topK = Math.max(1, Math.min(8, input.topK ?? RAG_TOP_K_DEFAULT));
  const maxChunkChars = input.maxChunkChars ?? RAG_CHUNK_MAX_CHARS;
  const scored: RetrievedChunk[] = [];
  for (const src of input.sources) {
    if (!src?.text?.trim()) continue;
    for (const chunk of splitRetrievalChunks(src.id, src.text, maxChunkChars)) {
      const score = scoreChunk(tokens, chunk.text);
      if (score <= 0) continue;
      scored.push({ id: chunk.id, score, text: chunk.text });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // Dedupe near-identical text.
  const out: RetrievedChunk[] = [];
  const seenBody = new Set<string>();
  for (const hit of scored) {
    const key = hit.text.slice(0, 160).toLowerCase();
    if (seenBody.has(key)) continue;
    seenBody.add(key);
    out.push(hit);
    if (out.length >= topK) break;
  }
  return out;
}

/** Append Retrieved section under budget (after bootstrap pack). */
export function attachRetrievedChunks(
  pack: string,
  chunks: RetrievedChunk[],
  budgetChars = RAG_ATTACH_BUDGET_CHARS,
): string {
  const base = (pack ?? "").trim();
  if (!chunks.length || budgetChars < 48) return base;
  const lines: string[] = ["Retrieved"];
  let used = "Retrieved\n".length;
  for (const hit of chunks) {
    const body = hit.text.trim().replace(/\s+/g, " ");
    if (!body) continue;
    const clipped =
      body.length > 420 ? `${body.slice(0, 420).trimEnd()}…` : body;
    const block = `- [${hit.id} · score ${hit.score}] ${clipped}`;
    if (used + block.length + 1 > budgetChars) break;
    lines.push(block);
    used += block.length + 1;
  }
  if (lines.length <= 1) return base;
  const section = lines.join("\n");
  return base ? `${base}\n\n${section}` : section;
}
