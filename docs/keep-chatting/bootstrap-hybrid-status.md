# Bootstrap hybrid — status (2026-09-11)

Worktree: `OpenMausBot/Development` · branch `keep-chatting` · **local commits only** (do not push PR #1080 unless Max asks).

Related: [bootstrap-hybrid-plan.md](./bootstrap-hybrid-plan.md).

## Goal (reminder)

Keep chatting should feel continuous across host resets without stuffing a fat state vector every time. **Bootstrap hybrid** = thin P0 seed (Goal / Open / Addresses / Re-read / Landmines) + external notebook + keyword RAG + Address re-read + **V-fallback** when confidence is low. Fat V remains the safe path when the thin pack is weak.

## Implemented (M0–M7 + follow-ups)

| Milestone | Commit | What landed |
|---|---|---|
| M0 + M1 | `c92e9ed9` | `compaction.bootstrapHybrid` (default **off**); thin P0 packer when on |
| M2 | `08178be7` | Harvest gates: Addresses repair/reject; mid-task Open |
| M3 | `d6775d72` | Catalog hints + keyword RAG over notebook/archive → Retrieved on compact |
| M4–M5 + M7 | `cd8e00e1` | Address re-read cue; confidence → mini-V / full-V fallback; Settings toggle (Experimental → Keep chatting → Bootstrap hybrid) |
| bump | `27eca67c` | `0.1.94` for dogfood |
| package fix | `82f6b58b` | Drop unused imports blocking package |
| extractive notebook | `fd49aa05` | If side LLM harvest returns null, write **quote-only** `buildExtractiveTurnPage`; score V-fallback from **pack pins ∪ notebook pins** so an empty notebook does not always force full-V |

### Behaviour when flag is on

1. Every settle should append a turn page to live `notebook.md` (LLM harvest, or extractive fallback).
2. On compact: fold/archive as before, but inject a **thin bootstrap pack** (not only fat V).
3. Keyword retrieve + Catalog/Retrieved sections attach when notebook/archive has content.
4. Confidence score decides thin vs mini-V vs full-V; logs `[keep-chatting] bootstrap …`.

When flag is **off**: previous fat-V inject path unchanged.

## Dogfood so far (Gemma 4 / 0.1.94)

- App: `/Applications/OpenMausBot.app` (server hot-swapped once with extractive `dist-server/index.js`).
- Config (`~/.openmausbot/config.json`): `bootstrapHybrid: true`, `microVectorsEnabled: true`, `compactAround: 32000` (**must** be a preset 32k/64k/96k/128k/160k — invalid values drop the whole compaction block).
- Bot: Gemma 4 `cc7dcbea-…`, thread `33f1ec89-…` (Unsloth via grok instance).
- API POSTs need desktop-owner auth; practical path = CDP `9222` + `Runtime.evaluate` fetch from the renderer.

### What worked

- Compact #1: canary `CANARY_BOOTSTRAP_M6_F6B3` + `server/bootstrap-rag.ts` survived post-compact (via Fallback V).
- Notebook path is real: `~/.openmausbot/workspaces/<botId>/tasks/<threadId>/notebook.md` (not empty `task-workspaces/…`).
- After extractive ship: log `micro vectors: inject + generateText both failed — using quote-only extractive turn page`.
- `notebook.md` now has pages with Goal / This turn / Open / Addresses (canary + `server/bootstrap-rag.ts` present).

### What did **not** prove yet

- **Thin bootstrap-only** path (no forced full-V) with a populated notebook + Catalog/Retrieved.
- Compact #2 / #3 continuity under bootstrap hybrid.
- **Noodle / Claude** compact pass.
- Clean Settings UI strings for Bootstrap hybrid in the **installed** `app.asar` (server + disk config work; UI may still lack the toggle label until a full package).

### Recurring pain

- Unsloth/Gemma side path: `micro vectors: inject + generateText both failed` (empty content / thinking / auth). Extractive unblocks rolling pages; real LLM harvest still desirable.
- Curl without `x-openmausbot-desktop-owner` → 403.

## What to focus on fixing next

Priority order while continuing dogfood:

1. **Prove thin path on Gemma**  
   Pad thread to 32k hard cap with notebook pages present → compact → expect higher confidence, Catalog/Retrieved, and **not** only `V-fallback full-v score=0.25`. Confirm canary + address survive without relying solely on fat Fallback V.

2. **Side-LLM harvest (Unsloth)**  
   Root-cause empty `content` on micro-vector / notebook generateText (auth, thinking tokens, model quirks). Extractive is a safety net, not the quality bar for Open / Landmines / dense This turn.

3. **Pack-pin scoring vs notebook quality**  
   Ensure confidence uses real pin coverage from extractive + LLM pages so thin pack wins when Goal/Open/Addresses are present; avoid false full-V.

4. **Noodle (Claude) compact**  
   Same flag on; verify hostProxy / universal inject still carries thin pack + re-read cue; SPT/chip still sane after compact.

5. **Compact #2 / #3**  
   Archive/seed notebook correctly; retrieved chunks stay useful; no cold-start persona / missing Open after second fold.

6. **Clean package**  
   Full `pnpm package:mac` so UI Settings toggle + server extractive are one install (stop relying on hot-swap). Confirm arm64 app path Max actually runs.

7. **Hygiene (later)**  
   Do not push #1080; keep keep-chatting separate from UI PR #1112. Optional: harden CDP dogfood helper / document desktop-owner header for API scripts.

## Local commit map (bootstrap series)

```
c92e9ed9  M0 flag + M1 thin P0 pack
08178be7  M2 harvest gates
d6775d72  M3 catalog + keyword RAG
cd8e00e1  M4–M5 + M7 settings
27eca67c  bump 0.1.94
82f6b58b  unused-import package fix
fd49aa05  extractive notebook + packPins scoring
```

## Handoff note

If usage is tight: this file is the source of truth for “what’s in” and “what’s next.” Continue from item **1** (thin-path Gemma compact with live notebook). Bootstrap hybrid plan quality target (~95%) still needs thin path proven, not only V-fallback survival.
