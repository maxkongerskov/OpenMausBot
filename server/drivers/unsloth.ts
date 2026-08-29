// Unsloth Studio — custom-only Local-rail engine. Catalog is the same
// host::model inject as Qwen / Hermes / pi / BotAgent (oMLX, Ollama,
// LM Studio, Unsloth, …). Turns POST OpenAI-compat /v1/chat/completions
// at the injected host. When the pick is Unsloth Studio itself, we opt
// into Studio's server-side agent tools (python, bash, web search).
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import {
  applyOpenAIInject,
  decodeInjectId,
  hostApiKey,
  localHost,
  mergeLocalInject,
} from "./local-inject.ts";

const DRIVER_KIND = "unslothAgent";
const DEFAULT_URL = "http://127.0.0.1:8888/v1";
const EMPTY: ModelCatalog = { default: "", options: [] };
const STUDIO_TOOLS = ["python", "web_search", "terminal"] as const;

export interface UnslothConfig {
  url: string;
}

export function decodeUnslothConfig(raw: unknown): UnslothConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const url = typeof o.url === "string" && o.url ? o.url.replace(/\/+$/, "") : DEFAULT_URL;
  return { url };
}

function isUnslothHost(modelId: string | undefined): boolean {
  const host = decodeInjectId(modelId)?.host;
  return host === "unsloth" || host === "unsloth_api";
}

export const UnslothStudioDriver: ProviderDriver<UnslothConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Unsloth Studio",
    supportsMultipleInstances: true,
    access: "custom",
  },
  install: {
    docsUrl: "https://unsloth.ai/docs",
    command: {
      darwin: "curl -fsSL https://unsloth.ai/install.sh | sh",
      linux: "curl -fsSL https://unsloth.ai/install.sh | sh",
      win32: "irm https://unsloth.ai/install.ps1 | iex",
    },
  },
  models: EMPTY,
  decodeConfig: decodeUnslothConfig,
  defaultConfig: () => decodeUnslothConfig({}),

  async create(input: DriverCreateInput<UnslothConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const env: Record<string, string | undefined> = { ...process.env, ...input.environment };
    let models = EMPTY;
    const refreshModels = async () => {
      try {
        const resolved = await mergeLocalInject(EMPTY, env);
        if (resolved.options.length) models = resolved;
      } catch {
        // keep last usable catalog
      }
    };
    await refreshModels();

    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const endpointFor = (modelId: string | undefined) => {
      const overlay: Record<string, string | undefined> = { ...env };
      const applied = applyOpenAIInject(overlay, modelId);
      const studio = localHost("unsloth")!;
      const url = (overlay.OPENAI_BASE_URL || config.url).replace(/\/+$/, "");
      const key = overlay.OPENAI_API_KEY || hostApiKey(studio, env);
      const apiModel = applied.model || models.default || "";
      return {
        url,
        key,
        apiModel,
        enableTools: isUnslothHost(modelId) || (!decodeInjectId(modelId) && url.includes(":8888")),
      };
    };

    const complete = async (
      messages: Array<{ role: string; content: string }>,
      turn: SendTurnInput,
      opts: {
        stream: boolean;
        signal?: AbortSignal;
        onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void;
        onTool?: (name: string, phase: "start" | "end", ok?: boolean) => void;
      },
    ): Promise<{ text: string; reasoning: string; usage: { input: number; output: number } | null }> => {
      const ep = endpointFor(turn.model);
      if (!ep.apiModel) throw new Error("no Unsloth / local model selected");
      const body: Record<string, unknown> = {
        model: ep.apiModel,
        messages,
        stream: opts.stream,
        session_id: turn.threadId,
      };
      if (ep.enableTools) {
        body.enable_tools = true;
        body.enabled_tools = [...STUDIO_TOOLS];
      }
      const res = await fetch(`${ep.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ep.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Unsloth HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 240)}` : ""}`);
      }
      if (!opts.stream) {
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const msg = json.choices?.[0]?.message;
        return {
          text: typeof msg?.content === "string" ? msg.content : "",
          reasoning: typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "",
          usage: json.usage
            ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
            : null,
        };
      }
      return readSse(res, opts);
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });
      const ep = endpointFor(turn.model);
      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, {
        dir: "out",
        source: "unsloth.chat.completions",
        msg: { model: ep.apiModel, url: ep.url, enableTools: ep.enableTools, messageCount: messages.length },
      });
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({
        ...base(threadId, turnId),
        type: "session.started",
        sessionId: null,
        model: turn.model ?? ep.apiModel,
      });
      void (async () => {
        try {
          const { text, reasoning, usage } = await complete(messages, turn, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta, streamKind = "assistant_text") =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind, delta }),
            onTool: (name, phase, ok) => {
              if (phase === "start") {
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId: name,
                  title: name,
                });
              } else {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: name,
                  ok: ok !== false,
                });
              }
            },
          });
          appendNative(threadId, {
            dir: "in",
            source: "unsloth.chat.completions",
            msg: { textLength: text.length, reasoningLength: reasoning.length, usage },
          });
          const replyText = text.trim() ? text : reasoning;
          if (replyText.trim()) {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: replyText,
            });
          }
          if (usage) emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
          active.delete(threadId);
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
            ...(usage ? { usage } : {}),
          });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();
      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const studio = localHost("unsloth")!;
      const key = hostApiKey(studio, env);
      try {
        const res = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(4_000),
        });
        if (res.ok) return { state: "available", authenticated: true, version: "Unsloth Studio" };
        if (res.status === 401) {
          return { state: "available", authenticated: false, version: "Unsloth Studio" };
        }
        return {
          state: "unavailable",
          reason: `Unsloth Studio answered HTTP ${res.status}`,
        };
      } catch {
        return {
          state: "unavailable",
          reason: "Start Unsloth Studio (`unsloth studio`) and load a model",
        };
      }
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => "unavailable" as const,
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text, reasoning } = await complete(
          [{ role: "user", content: prompt }],
          { threadId: "generateText", text: prompt },
          { stream: false },
        );
        return text.trim() ? text : reasoning;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};

async function readSse(
  res: Response,
  opts: {
    onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void;
    onTool?: (name: string, phase: "start" | "end", ok?: boolean) => void;
  },
): Promise<{ text: string; reasoning: string; usage: { input: number; output: number } | null }> {
  if (!res.body) return { text: "", reasoning: "", usage: null };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let reasoning = "";
  let usage: { input: number; output: number } | null = null;
  const seenTool = new Set<string>();

  const consume = (block: string) => {
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const eventName = typeof json.event === "string" ? json.event : typeof json.type === "string" ? json.type : "";
      if (eventName === "tool_result" || eventName === "tool_call") {
        const name = String((json.name ?? json.tool ?? "tool") as string);
        opts.onTool?.(name, eventName === "tool_call" ? "start" : "end", json.isError !== true);
        continue;
      }
      const usageRec = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usageRec) usage = { input: usageRec.prompt_tokens ?? 0, output: usageRec.completion_tokens ?? 0 };
      const choices = json.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
      const delta = choices?.[0]?.delta;
      if (!delta) continue;
      const content = delta.content;
      if (typeof content === "string" && content) {
        text += content;
        opts.onDelta?.(content, "assistant_text");
      }
      const think = delta.reasoning_content;
      if (typeof think === "string" && think) {
        reasoning += think;
        opts.onDelta?.(think, "reasoning_text");
      }
      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const fn = tc && typeof tc === "object" ? (tc as { function?: { name?: string } }).function : undefined;
          const name = fn?.name;
          if (name && !seenTool.has(name)) {
            seenTool.add(name);
            opts.onTool?.(name, "start");
          }
        }
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      consume(block);
    }
  }
  if (buf.trim()) consume(buf);
  for (const name of seenTool) opts.onTool?.(name, "end", true);
  return { text, reasoning, usage };
}
