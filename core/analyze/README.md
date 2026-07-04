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

0. **Usage totals / by day / by session** — billed-token accounting straight
   from the transcript `usage` fields: output, fresh input
   (input + cache_creation), and cache reads (the per-turn context resend this
   plugin exists to shrink), split main agent vs subagents. The same numbers
   are then grouped **per local day** and **per session** (= work unit,
   labeled with the session's AI title, chronological, always the full list).
   One API response is logged as several transcript entries duplicating the
   same `usage` — totals dedupe by message id (measured: 182 entries vs 87
   distinct ids on one real session, so naive summing would ~double).
1. **Pattern totals** — tool calls normalized to families (`npm test`,
   `git diff`, `Read(*.md)`) via `lib/patterns.mjs` (shared with ctx-budget
   attribution, #8): calls · ~tokens (chars/4) · share · sessions touched.
   Cumulative HISTORY spend — no compact-boundary reset (that distinction
   matters for live-context attribution, not for "what has been costing us").
   Subshell `(cd X && cmd)` spend is attributed to `cmd`, not `cd`.
2. **output-cap ledger** — cap markers per pattern (events, dropped tokens).
   Recorded here only, never shown live (by design).
3. **deny ledger** — input-gate denies per rule head.
4. **Proposals** — patterns above ~5k tok/session with no input-gate rule
   ("rule-candidate") and patterns capped ≥2x ("gate-promotion"). The
   measure → propose → add-rule → re-measure loop's propose step.
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
| `--full` | Every pattern row (overrides `--top`); by-day / by-session are always complete |
| `--json <path>` | Also write the full structured report (incl. `usage`, `byDay`, `bySession`) |
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
