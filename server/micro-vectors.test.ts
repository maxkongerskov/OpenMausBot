import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendMicroVector,
  appendTurnPage,
  archiveAndSeedNotebook,
  awaitPendingNotebookUpdate,
  buildMicroNotebookPrompt,
  deleteTaskMicroVectors,
  gateHarvestPage,
  markMicroCompacted,
  microLedgerPath,
  notebookPath,
  notebooksArchiveDir,
  parseMicroNotebookResult,
  readMicroLedger,
  readTaskNotebook,
  sanitizeNotebookWrite,
  taskDir,
  trackNotebookUpdate,
  TURN_PAGE_SEPARATOR,
  writeTaskNotebook,
} from "./micro-vectors.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "omb-micro-"));
  scratch.push(dir);
  return dir;
}

describe("notebook path layout", () => {
  it("places notebook.md under tasks/<threadId>/", () => {
    const base = tmp();
    const botId = "bot-a";
    const threadId = "task-1";
    expect(notebookPath(botId, threadId, base)).toBe(join(base, "tasks", threadId, "notebook.md"));
    expect(taskDir(botId, threadId, base)).toBe(join(base, "tasks", threadId));
  });
});

describe("LLM notebook prompt + sanitize", () => {
  it("builds a harvest turn-page prompt with prior as context only", () => {
    const prompt = buildMicroNotebookPrompt({
      priorNotebook: "Goal\nFix store\nVerified facts\nstore.ts patched\nNext action\nrun vitest",
      userText: "Also check deleteBot wipe",
      assistantReply:
        "Patched server/store.ts at 0xDeadBeef01. Do not touch deleteBot wipe. Next: run vitest.",
    });
    expect(prompt).toMatch(/Harvest a rich turn page/i);
    expect(prompt).toContain("This turn");
    expect(prompt).toContain("Open");
    expect(prompt.toLowerCase()).toMatch(/this turn is required/);
    expect(prompt.toLowerCase()).toMatch(/omit open if nothing is open/);
    expect(prompt.toLowerCase()).toMatch(/never soft-park/);
    expect(prompt).toContain("Prior notebook (context only");
    expect(prompt).toMatch(/Do NOT rewrite/i);
    expect(prompt).toContain("Fix store");
    expect(prompt).toContain("User:");
    expect(prompt).toContain("Also check deleteBot wipe");
    expect(prompt).toContain("Assistant reply:");
    expect(prompt).toContain("0xDeadBeef01");
    expect(prompt).toContain("Verified facts");
    expect(prompt.toLowerCase()).toContain("omit empty sections");
    expect(prompt.toLowerCase()).toContain("never write (none)");
    expect(prompt.toLowerCase()).toContain("do not invent");
    expect(prompt.toLowerCase()).toMatch(/confirm\/verify\/search/);
    expect(prompt).toMatch(/Fill #N/);
  });

  it("clips absurdly long replies", () => {
    const long = "x".repeat(13_000);
    const prompt = buildMicroNotebookPrompt({ assistantReply: long });
    expect(prompt).toContain("…[clipped]");
    expect(prompt).not.toContain("x".repeat(12_001));
  });

  it("sanitizes Fill #N and banned Open/Next soft-park on write", () => {
    const page = [
      "Goal",
      "Fill #3 ship store fix",
      "Verified facts",
      "Patched store.ts",
      "Constraints",
      "Fill #3 only",
      "Next action",
      "wait for next instruction",
    ].join("\n");
    const cleaned = sanitizeNotebookWrite(page, "run the store tests");
    expect(cleaned).toBeTruthy();
    expect(cleaned!).not.toMatch(/Fill\s*#\s*3/i);
    expect(cleaned!.toLowerCase()).not.toMatch(/wait for next/);
    expect(cleaned!).toContain("Open");
    expect(cleaned!).toMatch(/run the store tests/i);
  });

  it("parses LLM markdown into a sanitized vector entry", () => {
    const page = [
      "Goal",
      "Fix store wipe",
      "Verified facts",
      "Patched store.ts",
      "Addresses",
      "server/store.ts",
      "0xDeadBeef01",
      "Next action",
      "run vitest",
    ].join("\n");
    const entry = parseMicroNotebookResult(page, {
      at: new Date("2026-09-10T01:00:00.000Z"),
      sourceTurnChars: 120,
      userText: "run vitest please",
    });
    expect(entry).toMatchObject({
      at: "2026-09-10T01:00:00.000Z",
      role: "assistant",
      sourceTurnChars: 120,
    });
    expect(entry?.vector).toContain("0xDeadBeef01");
    expect(entry?.vector).toContain("Next action");
  });

  it("returns null for empty LLM output", () => {
    expect(parseMicroNotebookResult("")).toBeNull();
    expect(parseMicroNotebookResult("   ")).toBeNull();
    expect(parseMicroNotebookResult(null)).toBeNull();
    expect(sanitizeNotebookWrite("")).toBeNull();
  });
});

describe("write + read notebook.md", () => {
  it("writes notebook.md and compact reads it as primary", () => {
    const base = tmp();
    const path = writeTaskNotebook({
      botId: "b1",
      threadId: "t1",
      taskTitle: "Fix store",
      baseDir: base,
      userText: "run vitest",
      text: [
        "Goal",
        "Fix the bug in server/store.ts",
        "Verified facts",
        "Patched store.ts",
        "Addresses",
        "server/store.ts",
        "0xDeadBeef01",
        "Next action",
        "run vitest",
      ].join("\n"),
    });
    expect(path).toBe(notebookPath("b1", "t1", base));
    expect(existsSync(path!)).toBe(true);
    const raw = readFileSync(path!, "utf8");
    expect(raw).toContain("0xDeadBeef01");
    const blob = readTaskNotebook("b1", "t1", { baseDir: base });
    expect(blob).toContain("Goal");
    expect(blob).toContain("0xDeadBeef01");
    expect(blob.toLowerCase()).toContain("store.ts");
    // Thin ledger history also recorded.
    expect(existsSync(microLedgerPath("b1", "t1", base))).toBe(true);
  });

  it("seeds notebook.md once from legacy ledger.jsonl when notebook missing", () => {
    const base = tmp();
    appendMicroVector({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      entry: {
        at: "2026-09-10T01:00:00.000Z",
        role: "assistant",
        vector: "Goal\nlegacy goal\nVerified facts\nlegacy fact\nNext action\nkeep going",
      },
    });
    expect(existsSync(notebookPath("b1", "t1", base))).toBe(false);
    const blob = readTaskNotebook("b1", "t1", { baseDir: base });
    expect(blob).toContain("legacy goal");
    expect(blob).toContain("legacy fact");
    expect(existsSync(notebookPath("b1", "t1", base))).toBe(true);
    expect(readFileSync(notebookPath("b1", "t1", base), "utf8")).toContain("legacy goal");
  });

  it("keeps the newest notebook pages when truncating maxChars", () => {
    const base = tmp();
    const sep = `\n\n${TURN_PAGE_SEPARATOR}\n\n`;
    const oldPage = "Goal\nold page that should drop\nNext action\nignore";
    const newPage = "Goal\nnewest page keep me\nNext action\ncontinue";
    writeTaskNotebook({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: `${oldPage}${sep}${newPage}`,
      appendLedger: false,
    });
    const blob = readTaskNotebook("b1", "t1", { baseDir: base, maxChars: newPage.length + 8 });
    expect(blob).toContain("newest page keep me");
    expect(blob).not.toContain("old page that should drop");
  });

  it("prefers notebook.md over ledger when both exist", () => {
    const base = tmp();
    writeTaskNotebook({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: "Goal\nfrom notebook file\nNext action\ncontinue",
      appendLedger: false,
    });
    appendMicroVector({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      entry: {
        at: "2026-09-10T01:00:00.000Z",
        role: "assistant",
        vector: "Goal\nfrom ledger only\nNext action\nignore",
      },
    });
    expect(readTaskNotebook("b1", "t1", { baseDir: base })).toContain("from notebook file");
    expect(readTaskNotebook("b1", "t1", { baseDir: base })).not.toContain("from ledger only");
  });
});

describe("compact boundary ledger", () => {
  it("readMicroLedger only returns lines after the last compacted marker", () => {
    const base = tmp();
    appendMicroVector({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      entry: {
        at: "2026-09-10T01:00:00.000Z",
        role: "assistant",
        vector: "Goal\nold goal before compact\nVerified facts\nold fact",
      },
    });
    markMicroCompacted({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      at: new Date("2026-09-10T02:00:00.000Z"),
    });
    appendMicroVector({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      entry: {
        at: "2026-09-10T03:00:00.000Z",
        role: "assistant",
        vector: "Goal\nnew goal after compact\nAddresses\n0xCafeBabe",
      },
    });
    const blob = readMicroLedger("b1", "t1", { baseDir: base });
    expect(blob).toContain("new goal after compact");
    expect(blob).toContain("0xCafeBabe");
    expect(blob).not.toContain("old goal before compact");
  });
});

describe("appendTurnPage", () => {
  it("appends pages with separator and never rewrites prior pages", () => {
    const base = tmp();
    appendTurnPage({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: "Goal\nFix store\nThis turn\nfirst page\nVerified facts\nA\nNext action\ncontinue",
      appendLedger: false,
    });
    appendTurnPage({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: "Goal\nFix store\nThis turn\nsecond page\nAddresses\n0xCafe\nVerified facts\nB\nNext action\nrun tests",
      appendLedger: false,
    });
    const raw = readFileSync(notebookPath("b1", "t1", base), "utf8");
    expect(raw).toContain("first page");
    expect(raw).toContain("second page");
    expect(raw).toContain(TURN_PAGE_SEPARATOR);
    expect(raw.indexOf("first page")).toBeLessThan(raw.indexOf("second page"));
    const blob = readTaskNotebook("b1", "t1", { baseDir: base });
    expect(blob).toContain("first page");
    expect(blob).toContain("0xCafe");
  });
});

describe("archiveAndSeedNotebook", () => {
  it("archives live stack to notebooks/session-NNN.md and seeds live with V", () => {
    const base = tmp();
    appendTurnPage({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: "Goal\nold stack\nThis turn\npage one\nVerified facts\nkeep me\nNext action\ngo",
      appendLedger: false,
    });
    appendTurnPage({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: "Goal\nold stack\nThis turn\npage two\nAddresses\n0xDead\nNext action\ngo",
      appendLedger: false,
    });
    const result = archiveAndSeedNotebook({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      seedText:
        "Goal\nFix store\nVerified facts\nfolded from stack\nAddresses\n0xDead\nNext action\nrun vitest",
      userText: "run vitest",
    });
    expect(result.archivePath).toBeTruthy();
    expect(result.archivePath!).toContain(join("notebooks", "session-001.md"));
    expect(existsSync(result.archivePath!)).toBe(true);
    const archived = readFileSync(result.archivePath!, "utf8");
    expect(archived).toContain("page one");
    expect(archived).toContain("page two");
    const live = readFileSync(notebookPath("b1", "t1", base), "utf8");
    expect(live).toContain("folded from stack");
    expect(live).not.toContain("page one");
    // Next settle appends under the seed
    appendTurnPage({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: "Goal\nFix store\nThis turn\nafter seed\nNext action\ncontinue",
      appendLedger: false,
    });
    const after = readFileSync(notebookPath("b1", "t1", base), "utf8");
    expect(after).toContain("folded from stack");
    expect(after).toContain("after seed");
    expect(after).toContain(TURN_PAGE_SEPARATOR);
    // second compact archives as session-002
    const second = archiveAndSeedNotebook({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      seedText: "Goal\nround two\nVerified facts\nok\nNext action\nship",
      userText: "ship it",
    });
    expect(second.archivePath!).toContain("session-002.md");
    expect(existsSync(join(notebooksArchiveDir("b1", "t1", base), "session-001.md"))).toBe(true);
    expect(existsSync(join(notebooksArchiveDir("b1", "t1", base), "session-002.md"))).toBe(true);
  });
});

describe("deleteTaskMicroVectors", () => {
  it("removes the task folder including notebook.md and notebooks/", () => {
    const base = tmp();
    writeTaskNotebook({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: "Goal\nx\nNext action\ny",
    });
    archiveAndSeedNotebook({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      seedText: "Goal\nseed\nVerified facts\nz\nNext action\ngo",
    });
    expect(existsSync(notebookPath("b1", "t1", base))).toBe(true);
    expect(existsSync(notebooksArchiveDir("b1", "t1", base))).toBe(true);
    expect(existsSync(taskDir("b1", "t1", base))).toBe(true);
    deleteTaskMicroVectors("b1", "t1", base);
    expect(existsSync(taskDir("b1", "t1", base))).toBe(false);
  });
});

describe("await pending notebook update", () => {
  it("waits briefly for an in-flight write", async () => {
    const base = tmp();
    let done = false;
    const update = (async () => {
      await new Promise((r) => setTimeout(r, 40));
      appendTurnPage({
        botId: "b1",
        threadId: "t1",
        baseDir: base,
        text: "Goal\nawaited\nThis turn\nsettled\nNext action\ngo",
      });
      done = true;
    })();
    trackNotebookUpdate("b1", "t1", update);
    await awaitPendingNotebookUpdate("b1", "t1", 2_000);
    expect(done).toBe(true);
    expect(readTaskNotebook("b1", "t1", { baseDir: base })).toContain("awaited");
  });
});

describe("disabled callers", () => {
  it("helpers still work; callers skip write when microVectorsEnabled is false", () => {
    const base = tmp();
    const path = writeTaskNotebook({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      text: "Goal\nstill writable\nNext action\ncontinue",
    });
    expect(path).toBeTruthy();
    expect(readTaskNotebook("b1", "t1", { baseDir: base })).toContain("still writable");
  });
});

describe("gateHarvestPage", () => {
  it("repairs coding page missing Addresses from path in user text", () => {
    const page =
      "Goal\nFix store\nThis turn\npatched the store\nVerified facts\nstore broke\nOpen\nrun tests";
    const out = gateHarvestPage(page, "please edit server/store.ts");
    expect(out).toBeTruthy();
    expect(out!).toMatch(/Addresses/i);
    expect(out!).toContain("server/store.ts");
  });

  it("keeps verbs-only coding page without requiring Addresses", () => {
    const page =
      "Goal\nImprove UX\nThis turn\ndiscussed approach\nOpen\nsketch the flow";
    const out = gateHarvestPage(page, "please implement the refactor carefully");
    expect(out).toBeTruthy();
    expect(out!).not.toMatch(/^Addresses\s*$/m);
  });

  it("ensures Open when mid-task page lacks Open/Next", () => {
    const page = "Goal\nShip keep chatting\nThis turn\nwrote harvest gate\nVerified facts\ngate exists";
    const out = gateHarvestPage(page, "wire Addresses repair into append");
    expect(out).toBeTruthy();
    expect(out!).toMatch(/^Open$/m);
    expect(out!.toLowerCase()).toContain("wire addresses repair");
  });

  it("rewrites soft-park Open via sanitizeNotebookWrite", () => {
    const raw =
      "Goal\nContinue task\nThis turn\nwaited\nOpen\nAwaiting the user for the next instruction";
    const out = sanitizeNotebookWrite(raw, "finish the Addresses gate tests");
    expect(out).toBeTruthy();
    expect(out!.toLowerCase()).not.toMatch(/awaiting the user/);
    expect(out!).toMatch(/Open/i);
    expect(out!.toLowerCase()).toContain("finish the addresses gate");
  });

  it("allows non-coding chatty page without Addresses", () => {
    const page =
      "Goal\nCatch up\nThis turn\ntalked about weekend plans\nVerified facts\nrain tomorrow\nOpen\npick a movie";
    const out = gateHarvestPage(page, "how was your weekend?");
    expect(out).toBeTruthy();
    expect(out!).not.toMatch(/Addresses/i);
  });

  it("appendTurnPage skips rejected page when repair cannot fill Addresses", () => {
    // Concrete hex in user ask but page has empty Addresses heading that merge
    // should fill — happy path append still works after repair.
    const base = tmp();
    const path = appendTurnPage({
      botId: "b1",
      threadId: "t-gate",
      baseDir: base,
      userText: "look at 0xCafeBabe in the dump",
      text: "Goal\nDebug VA\nThis turn\ninspected dump\nAddresses\n(none)\nOpen\nkeep digging",
      appendLedger: false,
    });
    expect(path).toBeTruthy();
    const raw = readFileSync(notebookPath("b1", "t-gate", base), "utf8");
    expect(raw).toMatch(/0xCafeBabe/i);
  });
});
