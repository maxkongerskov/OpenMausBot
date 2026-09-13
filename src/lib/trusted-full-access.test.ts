import { describe, expect, it, vi } from "vitest";

import { applyTrustedFullAccess } from "./trusted-full-access";

describe("applyTrustedFullAccess", () => {
  it("copies Full onto the thread when the bot default already has it", async () => {
    const setMode = vi.fn().mockResolvedValue({});
    await applyTrustedFullAccess(setMode, {
      botId: "bot",
      threadId: "thread",
      botDefaultIsFull: true,
    });
    expect(setMode.mock.calls).toEqual([["bot", "full", { threadId: "thread" }]]);
  });

  it("grants the bot default before stamping the thread, so the copy is not rejected", async () => {
    const setMode = vi.fn().mockResolvedValue({});
    await applyTrustedFullAccess(setMode, {
      botId: "bot",
      threadId: "thread",
      botDefaultIsFull: false,
    });
    expect(setMode.mock.calls).toEqual([
      ["bot", "full"],
      ["bot", "full", { threadId: "thread" }],
    ]);
  });

  it("does not stamp the thread if the bot-level grant fails", async () => {
    const setMode = vi.fn().mockRejectedValueOnce(new Error("packaged desktop required"));
    await expect(applyTrustedFullAccess(setMode, {
      botId: "bot",
      threadId: "thread",
      botDefaultIsFull: false,
    })).rejects.toThrow("packaged desktop required");
    expect(setMode.mock.calls).toEqual([["bot", "full"]]);
  });
});
