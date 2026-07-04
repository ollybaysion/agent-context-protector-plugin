# analyze

**Not a hook.** No hooks.json wiring — invoked explicitly, two ways:

```bash
# terminal:
node core/analyze/analyze.mjs [--project <dir-name>] [--since <ISO>] \
                              [--top N] [--json out.json] [--precise]
```

Or inside a Claude Code session via the bundled skill
(`skills/analyze/SKILL.md`): type `/agent-context-protector:analyze
[same flags]` — Claude runs the CLI for the current project and interprets
the report (top patterns with meaning, ledger highlights, a take on each
proposal). Still human-triggered either way; the model never runs it on its
own.

Offline diagnostics over Claude Code transcript JSONL files
(`~/.claude/projects/*/*.jsonl`, read-only). This is the feedback half of the
plugin: input-gate/output-cap act in real time; analyze tells you afterwards
what they caught, what they missed, and what rule to add next.

## Report sections

0. **Usage totals / by day / by session / cost** — billed-token accounting
   straight from the transcript `usage` fields: output, fresh input
   (input + cache_creation), and cache reads (the per-turn context resend this
   plugin exists to shrink), split main agent vs subagents. The same numbers
   are then grouped **per local day** and **per session** (= work unit,
   labeled with the session's AI title, chronological, always the full list).
   One API response is logged as several transcript entries duplicating the
   same `usage` — totals dedupe by message id (measured: 182 entries vs 87
   distinct ids on one real session, so naive summing would ~double).

   Every row also carries an **estimated $ cost** from a per-model price
   table (API list prices; basis date printed in the report). Each usage
   entry is priced by its own `message.model` (present on 100% of real
   entries, verified 2026-07-04), so mid-session model switches price
   correctly. Cache writes are split by TTL — `ephemeral_5m` at 1.25x /
   `ephemeral_1h` at 2x base input (real CC traffic is all 1h, so a flat
   1.25x would understate writes) — and cache reads at 0.1x. A
   `## cost by model` section shows the token/cost split per model. Unknown
   models (`<synthetic>`, future ids) are never guessed: they show as
   unpriced rows excluded from $ totals. Caveats: prices are code constants
   (update on repricing; Sonnet 5 intro pricing not applied), and for
   subscription (Max) usage the $ figures are an API-equivalent reference,
   not an actual bill.
1. **Pattern totals** — tool calls normalized to families (`npm test`,
   `git diff`, `Read(*.md)`) via `lib/patterns.mjs` (shared with ctx-budget
   attribution, #8): calls · ~tokens (chars/4) · share · sessions touched.
   Cumulative HISTORY spend — no compact-boundary reset (that distinction
   matters for live-context attribution, not for "what has been costing us").
   Subshell `(cd X && cmd)` spend is attributed to `cmd`, not `cd`.
2. **output-cap ledger** — cap markers per pattern (events, dropped tokens).
   Recorded here only, never shown live (by design).
3. **deny ledger** — input-gate denies per rule head.
4. **Proposals** — the propose step of the measure → propose → add-rule →
   re-measure loop. Two kinds:
   - **rule-candidate** — an ungated pattern whose **per-call** cost is high
     (default ≥ 4k tok/call, `ACP_ANALYZE_PROPOSE_PER_CALL_TOKENS`) over at
     least `ACP_ANALYZE_PROPOSE_MIN_CALLS` (default 3) calls. Per-call is the
     right signal because "a ranged read would bound this" keys on how much a
     *single* call dumps, not on aggregate volume: `Read(*.output)` at ~10k
     tok/call is a real gate target, while `Read(*.md)` at ~1k tok/call over
     many calls is normal doc reading that a gate would only false-positive
     on. (The earlier tokens-per-session trigger did the opposite — it flagged
     the broad low-per-call patterns and missed the concentrated ones.)
   - **gate-promotion** — a pattern output-cap has capped ≥2x; a PreToolUse
     bound would avoid the runs entirely.
5. **`--precise`** — usage-delta attribution: growth between consecutive
   main-chain `usage` snapshots, minus the turn's own output tokens,
   distributed over the tool results in between (proportional to chars).
   Billed-token based instead of chars/4. Compaction pairs (negative growth)
   are skipped. Lives here because this is the one place with no hot-path
   constraint. Treat per-pattern precise numbers as an upper bound — deltas
   also carry user/system text arriving in the same window.

## Options

| Option | Meaning |
| --- | --- |
| `--project <dir>` | Only that project dir name (e.g. `-home-renoir-repo`) |
| `--since <ISO>` | Skip entries older than this timestamp |
| `--top N` | Rows in the pattern table (default 20) |
| `--full` | Every pattern row (overrides `--top`) |
| `--json <path>` | Also write the full structured report (+ cost fields) |
| `--precise` | usage-delta token attribution (slower, adds a column) |

`ACP_ANALYZE_ROOT` overrides the transcript root (used by tests).

## Notes / limits

- Pattern totals include sidechain (subagent) traffic — real spend;
  `--precise` uses main-chain entries only (usage deltas are per-context).
- Denied calls (input-gate) are counted in the deny ledger but not as spend.
- Transcript format is CC-internal: pinned against real transcripts
  (CC 2.1.198); re-verify before extending parsing, degrade gracefully.
- Dashboard integration is out of scope here — `--json` is the hand-off
  shape if/when the observability track wants it.
