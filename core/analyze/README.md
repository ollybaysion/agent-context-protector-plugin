# analyze

**Not a hook.** No hooks.json wiring — a human runs it explicitly:

```bash
node core/analyze/analyze.mjs [--project <dir-name>] [--since <ISO>] \
                              [--top N] [--json out.json] [--precise]
```

Offline diagnostics over Claude Code transcript JSONL files
(`~/.claude/projects/*/*.jsonl`, read-only). This is the feedback half of the
plugin: input-gate/output-cap act in real time; analyze tells you afterwards
what they caught, what they missed, and what rule to add next.

## Report sections

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
| `--json <path>` | Also write the full structured report |
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
