import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  attachRetrievedChunks,
  attachVFallback,
  buildNotebookCatalogHints,
  keywordRetrieve,
  listNotebookArchives,
  readLatestNotebookArchive,
  scoreBootstrapConfidence,
  splitRetrievalChunks,
  tokenizeQuery,
} from "./bootstrap-rag.ts";
import { buildBootstrapPack } from "./context-compact.ts";
import { notebooksArchiveDir } from "./micro-vectors.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-rag-"));
  scratch.push(dir);
  return dir;
}

describe("tokenizeQuery", () => {
  it("drops stopwords and keeps paths / hex-ish tokens", () => {
    const tokens = tokenizeQuery("continue the fix in server/store.ts for 0xCafeBabe please");
    expect(tokens).toContain("server/store.ts");
    expect(tokens.some((t) => t.includes("cafebabe") || t === "0xcafebabe")).toBe(true);
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("please");
  });
});

describe("keywordRetrieve", () => {
  it("ranks the canary page above an unrelated page", () => {
    const notebook = [
      "Goal",
      "Ship bootstrap",
      "This turn",
      "unrelated weather chat about rain",
      "Open",
      "chat",
      "",
      "---",
      "",
      "Goal",
      "Ship bootstrap",
      "This turn",
      "Planted CANARY_RAG_HIT_F6B3 in the vault path",
      "Addresses",
      "server/vault.ts",
      "Verified facts",
      "CANARY_RAG_HIT_F6B3",
      "Open",
      "retrieve canary after compact",
    ].join("\n");
    const hits = keywordRetrieve({
      query: "retrieve CANARY_RAG_HIT_F6B3 vault after compact",
      sources: [{ id: "notebook", text: notebook }],
      topK: 2,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("CANARY_RAG_HIT_F6B3");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("can pull from archive-latest as well as notebook", () => {
    const archive = "Goal\nold session\nVerified facts\nCANARY_ARCHIVE_ONLY\nOpen\nresume";
    const notebook = "Goal\nlive\nThis turn\nshort\nOpen\ngo";
    const hits = keywordRetrieve({
      query: "CANARY_ARCHIVE_ONLY resume",
      sources: [
        { id: "notebook", text: notebook },
        { id: "archive-latest", text: archive },
      ],
      topK: 3,
    });
    expect(hits.some((h) => h.text.includes("CANARY_ARCHIVE_ONLY"))).toBe(true);
  });
});

describe("buildNotebookCatalogHints + archives", () => {
  it("lists archive pointers and top addresses", () => {
    const base = tmp();
    const botId = "b-rag";
    const threadId = "t-rag";
    const archDir = notebooksArchiveDir(botId, threadId, base);
    mkdirSync(archDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(archDir, "session-001.md"), "Goal\nold\nOpen\nx\n", { mode: 0o600 });
    writeFileSync(join(archDir, "session-002.md"), "Goal\nnewer\nOpen\ny\n", { mode: 0o600 });

    const notebook = [
      "Goal",
      "Keep chatting RAG",
      "Addresses",
      "0xDeadBeef",
      "server/bootstrap-rag.ts",
      "Verified facts",
      "CANARY_CATALOG_FACT",
      "Open",
      "ship M3",
    ].join("\n");

    const hints = buildNotebookCatalogHints({
      notebook,
      botId,
      threadId,
      baseDir: base,
    });
    expect(listNotebookArchives(botId, threadId, base)).toEqual([
      "session-001.md",
      "session-002.md",
    ]);
    expect(readLatestNotebookArchive(botId, threadId, base)).toContain("newer");
    expect(hints.some((h) => h.includes("session-002.md"))).toBe(true);
    expect(hints.some((h) => h.includes("0xDeadBeef"))).toBe(true);
    expect(hints.some((h) => h.includes("bootstrap-rag.ts"))).toBe(true);
    expect(hints.some((h) => /topic/i.test(h) && /Keep chatting RAG/i.test(h))).toBe(true);
  });
});

describe("attachRetrievedChunks + bootstrap pack", () => {
  it("appends Retrieved under budget and pack still carries Catalog", () => {
    const notebook = [
      "Goal",
      "Hybrid continuity",
      "Addresses",
      "0x100474798",
      "Landmines",
      "Do not drop Addresses",
      "Verified facts",
      "CANARY_BOOTSTRAP_P1",
      "Open",
      "attach RAG hits",
    ].join("\n");
    const pack = buildBootstrapPack({
      notebook,
      budgetChars: 4_000,
      userText: "find CANARY_RAG_HIT_F6B3",
      catalogHints: ["archive notebooks/session-001.md", "address 0x100474798"],
    });
    expect(pack).toContain("Catalog");
    const hits = keywordRetrieve({
      query: "CANARY_RAG_HIT_F6B3",
      sources: [
        {
          id: "notebook",
          text: `${notebook}\n\n---\n\nThis turn\nPlanted CANARY_RAG_HIT_F6B3 here\nOpen\nretrieve`,
        },
      ],
      topK: 2,
    });
    const withRag = attachRetrievedChunks(pack, hits, 2_400);
    expect(withRag).toContain("Retrieved");
    expect(withRag).toContain("CANARY_RAG_HIT_F6B3");
    expect(withRag).toContain("Catalog");
    expect(withRag).toContain("0x100474798");
  });

  it("splitRetrievalChunks breaks on turn separators", () => {
    const chunks = splitRetrievalChunks(
      "notebook",
      "page one about alpha\n\n---\n\npage two about beta",
    );
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.text).toContain("alpha");
    expect(chunks[1]!.text).toContain("beta");
  });
});

describe("scoreBootstrapConfidence + attachVFallback (M5)", () => {
  it("stays on bootstrap when P0 + hits are strong", () => {
    const pack = "Goal\nship\nOpen\ngo\nAddresses\nsrc/a.ts\nRetrieved\n- hit";
    const conf = scoreBootstrapConfidence({
      pack,
      pins: { goal: "ship", open: "go", addresses: "src/a.ts" },
      hits: [{ id: "notebook#0", score: 6, text: "CANARY strong" }],
      notebookChars: 2000,
    });
    expect(conf.path).toBe("bootstrap");
    expect(conf.score).toBeGreaterThanOrEqual(0.55);
    const out = attachVFallback(pack, conf, "Goal\nship\nOpen\ngo");
    expect(out.summary).not.toMatch(/Fallback/);
  });

  it("attaches mini-V when Open missing and retrieve weak", () => {
    const notebook = [
      "Goal",
      "Ship Keep chatting",
      "Addresses",
      "server/store.ts",
      "Verified facts",
      "CANARY_FALLBACK_MINI",
      "This turn",
      "lost the open pin",
    ].join("\n");
    const pack = "Goal\nShip Keep chatting\nAddresses\nserver/store.ts";
    const conf = scoreBootstrapConfidence({
      pack,
      pins: { goal: "Ship Keep chatting", open: "", addresses: "server/store.ts" },
      hits: [],
      notebookChars: 2500,
    });
    expect(conf.path === "mini-v" || conf.path === "full-v").toBe(true);
    const out = attachVFallback(pack, conf, notebook, "continue");
    expect(out.summary).toMatch(/Fallback/);
    expect(out.summary).toContain("CANARY_FALLBACK_MINI");
  });
});
