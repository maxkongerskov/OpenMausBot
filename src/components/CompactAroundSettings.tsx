import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AUTO_COMPACT_AROUND_TOKENS,
  COMPACT_AROUND_PRESETS,
  compactFireTokens,
  DEFAULT_EXTRACTION_PROMPT,
  formatTokenK,
  VECTOR_BUDGET_PRESETS,
  VECTOR_PROMPT_MAX,
} from "../../shared/compact-around";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { shortPath } from "@/lib/short-path";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { Switch } from "./SettingsPrimitives";

export function CompactAroundSettings() {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const compactAround = state.config?.compaction?.compactAround ?? null;
  const vectorBudget = state.config?.compaction?.vectorBudget ?? null;
  const savedPrompt = state.config?.compaction?.prompt ?? null;
  const keepVectors = state.config?.compaction?.keepVectors === true;
  const archiveDir = state.config?.compaction?.vectorArchiveDir ?? null;
  const envOverride = state.config?.compaction?.envOverride ?? null;
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [promptDraft, setPromptDraft] = useState(savedPrompt ?? DEFAULT_EXTRACTION_PROMPT);

  useEffect(() => {
    setPromptDraft(savedPrompt ?? DEFAULT_EXTRACTION_PROMPT);
  }, [savedPrompt]);

  const patch = async (compaction: Record<string, unknown>) => {
    if (envOverride !== null && "compactAround" in compaction) return;
    setSaving(JSON.stringify(compaction));
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ compaction }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setSaving(null);
    }
  };

  const fireOf = (ceiling: number) => formatTokenK(compactFireTokens(ceiling));
  const aroundAuto = compactAround === null;
  const vectorAuto = vectorBudget === null;
  const ceilingCap = compactAround ?? AUTO_COMPACT_AROUND_TOKENS;
  const promptIsStandard = (savedPrompt ?? DEFAULT_EXTRACTION_PROMPT) === DEFAULT_EXTRACTION_PROMPT;
  const promptDirty = promptDraft !== (savedPrompt ?? DEFAULT_EXTRACTION_PROMPT);
  const canPick = Boolean(window.ogb?.pickFolder);

  const pickArchive = async () => {
    const chosen = await window.ogb?.pickFolder?.(archiveDir || undefined);
    if (chosen) void patch({ vectorArchiveDir: chosen, keepVectors: true });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[13px] leading-relaxed text-ink-secondary">
        <p>
          Keep this chat going on a local model without starting over. When the model fills up, OpenMausBot
          saves a short recap, gives it a fresh start, and leaves your conversation in place. A line in the
          thread marks the refresh. You do not restart the model yourself.
        </p>
        <p className="mt-2">
          Match the size to your computer: a smaller number refreshes more often and stays lighter on memory.
          A larger number waits longer. Auto is a good default. Cloud chats are unchanged.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[13px] font-medium text-ink">When to refresh</div>
        <div
          role="radiogroup"
          aria-label="When to refresh"
          aria-disabled={envOverride !== null}
          className="flex flex-wrap overflow-hidden rounded-lg border border-hairline/40"
        >
          <button
            type="button"
            role="radio"
            aria-checked={aroundAuto}
            disabled={envOverride !== null || saving !== null}
            onClick={() => void patch({ compactAround: null })}
            className={cn(
              "flex-1 px-3 py-1.5 text-[13px]",
              aroundAuto ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Auto
          </button>
          {COMPACT_AROUND_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={compactAround === preset}
              disabled={envOverride !== null || saving !== null}
              onClick={() => void patch({ compactAround: preset })}
              className={cn(
                "flex-1 border-l border-hairline/40 px-3 py-1.5 text-[13px] tabular-nums",
                compactAround === preset ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {formatTokenK(preset)}
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          {envOverride !== null
            ? `A computer setting is overriding this (${formatTokenK(envOverride)}).`
            : aroundAuto
              ? "Auto refreshes at a comfortable size for most computers."
              : `Refreshes around ${fireOf(compactAround)}. This chat stays; a line appears in the thread.`}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[13px] font-medium text-ink">How much to remember</div>
        <div
          role="radiogroup"
          aria-label="How much to remember"
          className="flex flex-wrap overflow-hidden rounded-lg border border-hairline/40"
        >
          <button
            type="button"
            role="radio"
            aria-checked={vectorAuto}
            disabled={saving !== null}
            onClick={() => void patch({ vectorBudget: null })}
            className={cn(
              "px-3 py-1.5 text-[13px]",
              vectorAuto ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Auto
          </button>
          {VECTOR_BUDGET_PRESETS.map((preset) => {
            const over = preset > ceilingCap;
            return (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={vectorBudget === preset}
                disabled={saving !== null || over}
                title={over ? `Limited to the refresh size (${formatTokenK(ceilingCap)})` : undefined}
                onClick={() => void patch({ vectorBudget: preset })}
                className={cn(
                  "border-l border-hairline/40 px-3 py-1.5 text-[13px] tabular-nums",
                  vectorBudget === preset ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {formatTokenK(preset)}
              </button>
            );
          })}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          The recap that carries the chat forward. Auto is enough for most people. Raise it if the bot forgets
          the next step after a refresh.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="vector-prompt" className="text-[13px] font-medium text-ink">
            Recap notes
          </label>
          <button
            type="button"
            disabled={saving !== null || promptIsStandard}
            onClick={() => {
              setPromptDraft(DEFAULT_EXTRACTION_PROMPT);
              void patch({ prompt: null });
            }}
            className="rounded-md px-1.5 py-1 text-[11.5px] font-medium text-accent-text hover:bg-accent/10 disabled:opacity-40"
          >
            Reset to standard
          </button>
        </div>
        <textarea
          id="vector-prompt"
          className="min-h-[160px] w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          maxLength={VECTOR_PROMPT_MAX}
          aria-label="Recap notes"
          value={promptDraft}
          disabled={saving !== null}
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={() => {
            if (!promptDirty) return;
            const next = promptDraft.trim();
            void patch({ prompt: next === DEFAULT_EXTRACTION_PROMPT || !next ? null : next });
          }}
        />
        <div className="flex items-start justify-between gap-3 text-[11px] text-ink-secondary">
          <span>Standard recap: goal, facts, places, cautions, and the next step.</span>
          <span className="shrink-0 tabular-nums">
            {promptDraft.length.toLocaleString()} / {VECTOR_PROMPT_MAX.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-ink">Save each recap as a file</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
              Keep a markdown copy of every refresh so you can compare them later. Off by default.
            </p>
          </div>
          <Switch
            checked={keepVectors}
            disabled={saving !== null}
            aria-label="Save each recap as a file"
            onClick={() => void patch({ keepVectors: !keepVectors })}
          />
        </div>
        {keepVectors ? (
          <div className="flex items-center gap-2">
            <div
              className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink"
              title={archiveDir ?? undefined}
            >
              {archiveDir ? (
                shortPath(archiveDir, home)
              ) : (
                <span className="font-sans text-ink-secondary">Default — each bot&apos;s private folder</span>
              )}
            </div>
            {canPick ? (
              <button
                type="button"
                onClick={() => void pickArchive()}
                disabled={saving !== null}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                <FolderOpen size={14} />
                Choose…
              </button>
            ) : null}
            {archiveDir ? (
              <button
                type="button"
                onClick={() => void patch({ vectorArchiveDir: null })}
                disabled={saving !== null}
                className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50"
              >
                Reset
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
