/** App-wide compact-around presets. The number is the compact *ceiling*;
 * the live model window is recycled at 80% of it. Auto (null) applies
 * AUTO_COMPACT_AROUND_TOKENS when the advertised window is larger and RAM
 * did not already clamp. */
export const COMPACTION_RATIO = 0.8;

export const COMPACT_AROUND_PRESETS = [32_000, 64_000, 96_000, 128_000, 160_000] as const;
export type CompactAroundPreset = (typeof COMPACT_AROUND_PRESETS)[number];

/** Auto recycle cap when Unsloth/oMLX advertise 256k and RAM never binds. */
export const AUTO_COMPACT_AROUND_TOKENS = 128_000;

export function isCompactAroundPreset(value: number): value is CompactAroundPreset {
  return (COMPACT_AROUND_PRESETS as readonly number[]).includes(value);
}

export function formatTokenK(tokens: number): string {
  return `${Math.round(tokens / 1_000)}k`;
}

export function compactFireTokens(ceilingTokens: number): number {
  return Math.floor(ceilingTokens * COMPACTION_RATIO);
}

/** How large the rewritten state vector may be. Auto = 15% of compact ceiling, capped at 6k.
 * Presets go up to the compact-around window so a big local stack can keep a full page. */
export const VECTOR_BUDGET_PRESETS = [
  2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 16_000, 32_000, 64_000, 96_000, 128_000, 160_000,
] as const;
export type VectorBudgetPreset = (typeof VECTOR_BUDGET_PRESETS)[number];
export const VECTOR_BUDGET_AUTO_CAP = 6_000;
export const VECTOR_BUDGET_MAX = 160_000;
export const VECTOR_PROMPT_MAX = 8_000;

export function isVectorBudgetPreset(value: number): value is VectorBudgetPreset {
  return (VECTOR_BUDGET_PRESETS as readonly number[]).includes(value);
}

/** Host prefixes on injected local-model ids (`unsloth::…`, `ollama::…`). */
export const LOCAL_INJECT_HOST_IDS = [
  "omlx",
  "ollama",
  "local_ollama",
  "exo",
  "lmstudio",
  "unsloth",
  "unsloth_api",
] as const;

/** True when the picker id is a local host inject (Unsloth, oMLX, Ollama, LM Studio, EXO). */
export function isLocalInjectModelId(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const sep = modelId.indexOf("::");
  if (sep <= 0) return false;
  const host = modelId.slice(0, sep);
  return (LOCAL_INJECT_HOST_IDS as readonly string[]).includes(host);
}

/** Default rewrite instructions. Editable in App Settings → Engines. Code still
 * never clips Next and never smears chat over a disk handoff. */
export const DEFAULT_EXTRACTION_PROMPT =
  "Write a one-page state vector a successor can continue from without the transcript. " +
  "Use these headings exactly:\nGoal\nVerified facts\nAddresses\nLandmines\nConstraints\nNext action\n" +
  "Verified facts: live truth only. Name dead ends in one line each (do not redo). " +
  "Addresses: live file paths, symbols, IDs, and 0x… values, one per line — omit disproven ones. " +
  "Landmines: what would destroy work if forgotten. " +
  "Constraints: never-do rules. " +
  "Next action: exactly one concrete step, complete, last section, never truncated. " +
  "Drop long recipes, logs, and how-tos a successor can re-read from disk (handoff_*.md / MEMORY.md). " +
  "Prefer the workspace MEMORY.md / handoff_*.md seed over tool chips and old chat. " +
  "The latest user message is live truth — quote it; do not replace it with an older Goal from seed. " +
  "This page must work for any local task (code, research, ops), not one domain. " +
  "Ignore [tool …] chips. Quote verbatim. Do not invent. Do not invent the next patch or feature.";

