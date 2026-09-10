import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendMicroVector,
  buildMicroEntryFromExchange,
  deleteTaskMicroVectors,
  markMicroCompacted,
  microLedgerPath,
  microVectorsDir,
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

describe("append + read roundtrip", () => {
  it("writes ledger.jsonl and formats a notebook blob", () => {
    const base = tmp();
    const entry = buildMicroEntryFromExchange({
      userText: "Fix the bug in server/store.ts at 0xDeadBeef01",
      assistantText: " Patched store.ts. Do not touch deleteBot wipe. Next: run vitest.",
      at: new Date("2026-09-10T01:00:00.000Z"),
    });
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
    const blob = readMicroLedger("b1", "t1", { baseDir: base });
    expect(blob).toContain("Goal:");
    expect(blob.toLowerCase()).toContain("store.ts");
  });

  it("skips empty / pad-only exchanges", () => {
    expect(buildMicroEntryFromExchange({ userText: "   ", assistantText: "" })).toBeNull();
    const pad = `UNIQUE-ABCDEF ${"a".repeat(3000)} ${"0123456789abcdef".repeat(200)}`;
    expect(buildMicroEntryFromExchange({ userText: pad, assistantText: "" })).toBeNull();
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
        role: "user",
        goal: "old goal before compact",
        facts: ["old fact"],
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
        role: "user",
        goal: "new goal after compact",
        addresses: ["0xCafeBabe"],
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
      entry: { at: "2026-09-10T01:00:00.000Z", role: "user", note: "x" },
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
