import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendMicroVector,
  buildMicroNotebookPrompt,
  deleteTaskMicroVectors,
  markMicroCompacted,
  microLedgerPath,
  microVectorsDir,
  parseMicroNotebookResult,
  readMicroLedger,
  taskDir,
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

describe("micro-vectors layout", () => {
  it("nests under tasks/<thread>/micro-vectors when baseDir is injected", () => {
    const base = tmp();
    const botId = "bot-a";
    const threadId = "task-1";
    expect(microVectorsDir(botId, threadId, base)).toBe(
      join(base, "tasks", threadId, "micro-vectors"),
    );
    expect(taskDir(botId, threadId, base)).toBe(join(base, "tasks", threadId));
  });
});

describe("LLM notebook prompt + parse", () => {
  it("builds a reply-only prompt with state-vector headings", () => {
    const prompt = buildMicroNotebookPrompt(
      "Patched server/store.ts at 0xDeadBeef01. Do not touch deleteBot wipe. Next: run vitest.",
    );
    expect(prompt).toContain("Assistant reply:");
    expect(prompt).toContain("0xDeadBeef01");
    expect(prompt).toContain("Verified facts");
    expect(prompt.toLowerCase()).toContain("do not invent");
    expect(prompt.toLowerCase()).toContain("ignore");
    expect(prompt).not.toMatch(/\buser\b.*Fix the bug/i);
  });

  it("clips absurdly long replies", () => {
    const long = "x".repeat(13_000);
    const prompt = buildMicroNotebookPrompt(long);
    expect(prompt).toContain("…[clipped]");
    expect(prompt.length).toBeLessThan(long.length);
  });

  it("parses LLM markdown into a vector ledger entry", () => {
    const page = [
      "Goal",
      "Fix store wipe",
      "Verified facts",
      "Patched store.ts",
      "Addresses",
      "server/store.ts",
      "0xDeadBeef01",
      "Landmines",
      "Do not touch deleteBot wipe",
      "Constraints",
      "(none)",
      "Next action",
      "run vitest",
    ].join("\n");
    const entry = parseMicroNotebookResult(page, {
      at: new Date("2026-09-10T01:00:00.000Z"),
      sourceTurnChars: 120,
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
  });
});

describe("append + read roundtrip", () => {
  it("writes ledger.jsonl and formats LLM notebook pages for compact", () => {
    const base = tmp();
    const entry = parseMicroNotebookResult(
      [
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
      { at: new Date("2026-09-10T01:00:00.000Z") },
    );
    expect(entry).toBeTruthy();
    const path = appendMicroVector({
      botId: "b1",
      threadId: "t1",
      taskTitle: "Fix store",
      entry: entry!,
      baseDir: base,
    });
    expect(path).toBe(microLedgerPath("b1", "t1", base));
    expect(existsSync(path!)).toBe(true);
    const raw = readFileSync(path!, "utf8");
    expect(raw).toContain("0xDeadBeef01");
    expect(raw).toContain('"vector"');
    const blob = readMicroLedger("b1", "t1", { baseDir: base });
    expect(blob).toContain("notebook");
    expect(blob).toContain("Goal");
    expect(blob).toContain("0xDeadBeef01");
    expect(blob.toLowerCase()).toContain("store.ts");
  });

  it("still formats legacy structured entries", () => {
    const base = tmp();
    appendMicroVector({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      entry: {
        at: "2026-09-10T01:00:00.000Z",
        role: "assistant",
        goal: "legacy goal",
        facts: ["legacy fact"],
      },
    });
    const blob = readMicroLedger("b1", "t1", { baseDir: base });
    expect(blob).toContain("Goal: legacy goal");
    expect(blob).toContain("legacy fact");
  });
});

describe("compact boundary", () => {
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

describe("deleteTaskMicroVectors", () => {
  it("removes the task folder", () => {
    const base = tmp();
    appendMicroVector({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      entry: { at: "2026-09-10T01:00:00.000Z", role: "assistant", note: "x" },
    });
    expect(existsSync(taskDir("b1", "t1", base))).toBe(true);
    deleteTaskMicroVectors("b1", "t1", base);
    expect(existsSync(taskDir("b1", "t1", base))).toBe(false);
  });
});

describe("disabled callers", () => {
  it("helpers still work; callers skip append when microVectorsEnabled is false", () => {
    const base = tmp();
    const path = appendMicroVector({
      botId: "b1",
      threadId: "t1",
      baseDir: base,
      entry: { at: "2026-09-10T01:00:00.000Z", role: "assistant", note: "still writable" },
    });
    expect(path).toBeTruthy();
    expect(readMicroLedger("b1", "t1", { baseDir: base })).toContain("still writable");
  });
});
