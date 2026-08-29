import { afterEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { UnslothStudioDriver } from "./unsloth.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UnslothStudioDriver", () => {
  it("is a custom-only Local engine", () => {
    expect(UnslothStudioDriver.driverKind).toBe("unslothAgent");
    expect(UnslothStudioDriver.metadata.access).toBe("custom");
    expect(UnslothStudioDriver.metadata.displayName).toBe("Unsloth Studio");
  });

  it("defaults to the Studio OpenAI-compat URL", () => {
    expect(UnslothStudioDriver.defaultConfig()).toEqual({ url: "http://127.0.0.1:8888/v1" });
  });

  it("sends Studio server-side tools for a unsloth:: pick", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        seen.push({ url, body });
        return new Response(
          'data: {"choices":[{"delta":{"content":"42"}}]}\ndata: [DONE]\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await UnslothStudioDriver.create({
      instanceId: "unsloth",
      displayName: "Unsloth Studio",
      enabled: true,
      config: { url: "http://127.0.0.1:8888/v1" },
      environment: { UNSLOTH_STUDIO_AUTH_TOKEN: "sk-unsloth-test" },
    });
    const recorder = recordEvents(inst.adapter);
    try {
      await inst.adapter.sendTurn({
        threadId: "t-unsloth",
        text: "search the web",
        model: "unsloth::Qwen3.8-27B",
      });
      await recorder.until((e) => e.type === "turn.completed");
      expect(seen[0]?.url).toBe("http://127.0.0.1:8888/v1/chat/completions");
      expect(seen[0]?.body.model).toBe("Qwen3.8-27B");
      expect(seen[0]?.body.enable_tools).toBe(true);
      expect(seen[0]?.body.enabled_tools).toEqual(["python", "web_search", "terminal"]);
      expect(seen[0]?.body.session_id).toBe("t-unsloth");
    } finally {
      recorder.stop();
      await inst.dispose();
    }
  });

  it("injects oMLX without Studio server-side tools", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await UnslothStudioDriver.create({
      instanceId: "unsloth",
      displayName: "Unsloth Studio",
      enabled: true,
      config: { url: "http://127.0.0.1:8888/v1" },
      environment: { UNSLOTH_STUDIO_AUTH_TOKEN: "sk-unsloth-test" },
    });
    const recorder = recordEvents(inst.adapter);
    try {
      await inst.adapter.sendTurn({
        threadId: "t-omlx",
        text: "hi",
        model: "omlx::GLM-5.3-Flash-oQ4e",
      });
      await recorder.until((e) => e.type === "turn.completed");
      expect(seen[0]?.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
      expect(seen[0]?.body.model).toBe("GLM-5.3-Flash-oQ4e");
      expect(seen[0]?.body.enable_tools).toBeUndefined();
    } finally {
      recorder.stop();
      await inst.dispose();
    }
  });
});
