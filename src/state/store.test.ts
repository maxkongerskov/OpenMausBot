import { describe, expect, it } from "vitest";

import { configStatusFromFrame, initialState, reducer, type Bot, type Message } from "./store";

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
      }),
    ).toEqual({
      xai: { configured: true },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
    });
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("team switcher", () => {
  const bot = (id: string, teamId?: string): Bot => ({
    id,
    threadId: `${id}-thread`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
    messages: [],
    ...(teamId ? { teamId } : {}),
  });

  it("hydrate and setActiveTeam keep the current chat when it still belongs", () => {
    const scout = bot("scout", "eng");
    const copy = bot("copy", "mkt");
    const hydrated = reducer(initialState, {
      type: "hydrate",
      bots: [scout, copy],
      groups: [],
      teams: [
        { id: "eng", name: "Engineering", createdAt: 1 },
        { id: "mkt", name: "Marketing", createdAt: 2 },
      ],
      activeTeamId: "eng",
      computerControl: {},
    });
    expect(hydrated.selectedId).toBe("scout");
    expect(hydrated.activeTeamId).toBe("eng");

    const selected = reducer(hydrated, { type: "select", id: "scout" });
    const switched = reducer(selected, { type: "setActiveTeam", teamId: "mkt" });
    expect(switched.activeTeamId).toBe("mkt");
    expect(switched.selectedId).toBe("copy");
  });
});
