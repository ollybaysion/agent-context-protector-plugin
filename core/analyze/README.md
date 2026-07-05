# analyze

**Not a hook.** No hooks.json wiring — invoked explicitly, three ways:

```bash
# terminal (repo checkout):
node core/analyze/analyze.mjs [--project <dir-name>] [--since <ISO>] \
                              [--top N] [--json out.json] [--precise] \
                              [--plugin-report]

# standalone, no clone and NO PLUGIN INSTALL needed (root package.json bin):
npx github:ollybaysion/agent-context-protector-plugin --project <dir-name>
```

Or inside a Claude Code session via the bundled skill
(`skills/analyze/SKILL.md`): type `/agent-context-protector:analyze
[same flags]` — Claude runs the CLI for the current project and interprets
the report. Still human-triggered either way; the model never runs it on its
own.

Offline diagnostics over Claude Code transcript JSONL files
(`~/.claude/projects/*/*.jsonl`, read-only). The transcripts are written by
Claude Code itself, so the **default report works on machines where this
plugin was never installed** — total cost, where it went, and what rules
would bound it. The plugin-effect sections (what the hooks actually caught,
and whether they run efficiently) key on markers only the hooks produce, so
they live behind `--plugin-report`.

## Default report (works anywhere)

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
2. **Proposals (rule-candidate)** — an ungated pattern whose **per-call**
   cost is high (default ≥ 4k tok/call,
   `ACP_ANALYZE_PROPOSE_PER_CALL_TOKENS`) over at least
   `ACP_ANALYZE_PROPOSE_MIN_CALLS` (default 3) calls. Per-call is the right
   signal because "a ranged read would bound this" keys on how much a
   *single* call dumps, not on aggregate volume: `Read(*.output)` at ~10k
   tok/call is a real gate target, while `Read(*.md)` at ~1k tok/call over
   many calls is normal doc reading that a gate would only false-positive
   on. On a machine without the plugin, these double as "what a gate would
   have saved" install rationale. The exclusion list (`GATED`) mirrors
   input-gate's covered families — **keep in sync with
   core/input-gate/input-gate.mjs** (Bash FOLLOW/VOLUME rules +
   LOG_ARTIFACT_READ/ARTIFACT_READ extensions).
3. **`--precise`** — usage-delta attribution: growth between consecutive
   main-chain `usage` snapshots, minus the turn's own output tokens,
   distributed over the tool results in between (proportional to chars).
   Billed-token based instead of chars/4. Compaction pairs (negative growth)
   are skipped. Treat per-pattern precise numbers as an upper bound — deltas
   also carry user/system text arriving in the same window.

## `--plugin-report` (plugin-effect sections)

Reads markers that exist only when the hooks were active in the period. If
none are found, prints a "hooks appear inactive" notice and skips these
sections (the default report above still prints in full).

- **4 — output-cap ledger + savings** — cap events per pattern, and an
  **estimated $ saved per pattern**: each dropped chunk would have been
  cache-written once (1h TTL, 2x base input — CC's measured profile) and
  re-read at 0.1x on every later turn of that session. Because this is
  post-hoc, the remaining-turn count is **measured from the transcript**,
  not assumed. Priced by the nearest preceding main-chain entry's model;
  unpriced models are counted but never guessed. Main-chain events only.
- **5 — deny ledger + retry tracking** — input-gate denies per rule head.
  Denies carry **no $ figure by design**: the call was blocked before
  execution, so its would-be size was never recorded. `deny→retry` reports
  how many denies were followed by a same-family retry in that session —
  a retry means the rule's suggested bounded alternative was taken.
- **6 — Inefficiency diagnostics** —
  - `gate-promotion`: a pattern output-cap has capped ≥2x; a PreToolUse
    bound would avoid the runs entirely.
  - `no-retry`: a deny that was never retried in its session — the rule
    message may not offer a usable alternative, or the task was dropped.
  - `quiet-rules`: gated families with traffic but zero interventions this
    period — usually the gate working silently (calls stayed bounded), but
    a consistently quiet rule under heavy traffic is worth a threshold
    check.

## Options

| Option | Meaning |
| --- | --- |
| `--project <dir>` | Only that project dir name (e.g. `-home-renoir-repo`) |
| `--since <ISO>` | Skip entries older than this timestamp |
| `--top N` | Rows in the pattern table (default 20) |
| `--full` | Every pattern row (overrides `--top`) |
| `--json <path>` | Also write the full structured report (+ cost fields) |
| `--precise` | usage-delta token attribution (slower, adds a column) |
| `--plugin-report` | Add plugin-effect sections (ledgers, savings, inefficiencies) |

`ACP_ANALYZE_ROOT` overrides the transcript root (used by tests).

## Notes / limits

- Pattern totals include sidechain (subagent) traffic — real spend;
  `--precise` and the `--plugin-report` savings/retry math use main-chain
  events only (usage deltas and remaining-turn counts are per-context).
- Denied calls (input-gate) are counted in the deny ledger but not as spend.
- Transcript format is CC-internal: pinned against real transcripts
  (CC 2.1.198); re-verify before extending parsing, degrade gracefully.
- `--json` always contains the plugin-effect data (`pluginReport` key, plus
  both proposal kinds) regardless of the flag — only console output is
  gated. It remains the hand-off shape for the observability track
  (agentic-claude-hooks#56).
- The root `package.json` exists solely for the npx/bin path; the Claude
  Code plugin loads via `.claude-plugin/plugin.json` and ignores it.
