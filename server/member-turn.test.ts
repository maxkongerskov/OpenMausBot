import { describe, expect, it } from "vitest";

import { memberTurnSelection, roomSpeakerSelection } from "./member-turn.ts";

describe("memberTurnSelection", () => {
  it("carries the picker model so a room turn injects the same host as 1:1", () => {
    expect(
      memberTurnSelection({ instanceId: "hermes", model: "omlx::gemma-4-31b-it-bf16" }),
    ).toEqual({ model: "omlx::gemma-4-31b-it-bf16" });
  });

  it("keeps a configured effort", () => {
    expect(
      memberTurnSelection({ instanceId: "qwen", model: "omlx::gemma-4-31b-it-bf16", effort: "high" }),
    ).toEqual({ model: "omlx::gemma-4-31b-it-bf16", effort: "high" });
  });
});

describe("roomSpeakerSelection", () => {
  const bot = {
    id: "kiwi",
    threadId: "direct",
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  };

  it("uses the bot default, not a thread-only 1:1 override", () => {
    expect(roomSpeakerSelection(bot)).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
    expect(
      roomSpeakerSelection({
        ...bot,
        modelSelection: { instanceId: "grok", model: "grok-4.6", effort: "high" },
      }),
    ).toEqual({ instanceId: "grok", model: "grok-4.6", effort: "high" });
  });

  it("copies the selection so later thread edits cannot mutate a prepared room turn", () => {
    const source = { ...bot, modelSelection: { ...bot.modelSelection } };
    const selection = roomSpeakerSelection(source);
    source.modelSelection.model = "changed";
    expect(selection.model).toBe("claude-sonnet-5");
  });
});
