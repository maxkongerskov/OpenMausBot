// Fields a room (or any bot-initiated turn) must copy from the bot's
// picker selection. 1:1 chat already does this; a missing `model` is
// how Hermes hits OpenRouter (HTTP 401) and Qwen dies with Internal error
// while Grok silently runs its cloud default.
//
// Rooms follow the bot default ("This bot" / groups / new threads). A
// thread-only 1:1 override must not leak into a group — navigating private
// tabs must not change who the room talks with (#1130).
import type { EffortLevel, ModelSelection } from "./contracts.ts";

export function memberTurnSelection(selection: ModelSelection): {
  model: string;
  effort?: EffortLevel;
} {
  return {
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
  };
}

export function roomSpeakerSelection(bot: { modelSelection: ModelSelection }): ModelSelection {
  return { ...bot.modelSelection };
}
