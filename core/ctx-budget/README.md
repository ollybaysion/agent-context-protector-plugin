# ctx-budget

**Events:** PostToolUse (matcher `*`) + UserPromptSubmit · **Mechanism:**
`systemMessage` (user-facing) · **Never blocks, never touches the model's
context.**

The UserPromptSubmit wiring exists because PostToolUse alerts land mid-turn,
between tool executions; firing on prompt submit as well puts the alert at the
one moment the human can actually type `/compact`. The tier ladder debounces
across both events (shared state), so nothing fires twice.

Context-usage HUD + `/compact` nudges. This module saves no tokens by itself —
it makes the two decisions that do save tokens (when to `/compact`, what habit
to fix) timely and evidence-based.

## Behaviour

- **Tier alerts:** every 10% tier crossed upward emits one alert
  (`컨텍스트 30% 사용 중 (60k / 200k tok)`). Once per tier — silent until the
  next tier is crossed. When usage drops back down (compaction), the ladder
  re-arms automatically.
- **From 50% on:** the alert adds `— /compact 권장` plus attribution — the top
  3 context consumers since the last compaction boundary, each priced as a
  per-turn re-read **rent** (what keeping that pattern family in context bills
  every turn: `상위 소비: npm test ~$0.032/turn (4회) · git diff ~$0.008/turn (2회) · …`),
  computed from tool_use/tool_result pairs in the transcript. Unpriced models
  fall back to token estimates (`~9.2k tok`). Attribution streams the
  transcript on tier crossings and at most once per `REFRESH_SEC` in between,
  never unthrottled per event.
- **Boundary nudge (issue #21, baseline v2.1 in the issue comments):** a
  work-boundary moment gets a **copy-paste `/compact` instruction**, not just a
  reminder. Gate = boundary rule hit ∧ context ≥ `NUDGE_MIN_TOK` **absolute
  tokens** (NOT the % ladder — on a 1M window the old ≥50% gate silenced 85%
  of real boundaries; 40-session mining: boundary-time context median 312k) ∧
  one shared 5-minute cooldown (a cleanup cluster pull → branch -d → worktree
  add nudges once). Rules are a data table; each is segment-anchored (mere
  mentions don't fire) and requires positive success evidence on its **pinned
  stream** (live-verified 2026-07-07; note PostToolUse never fires for failed
  Bash calls, so failure noise is structurally absent):

  | Rule | Role | Evidence (stream) | Captures |
  | --- | --- | --- | --- |
  | `gh pr create` | terminal → fire | PR URL (stdout) | `PR #N` → assertive drop label |
  | `git pull` merge evidence | terminal → fire | `Updating a..b` / `Fast-forward` (stdout); `Already up to date` silent | none → genDone inheritance |
  | `git branch -d/-D` | terminal → fire | `Deleted branch` (stdout) | branch → drop label + genStart survival check |
  | `gh pr merge` | terminal → fire | segment match itself (= exit-0 evidence — PostToolUse never fires for failed Bash; gh prints its success line to stderr and only on a TTY, so a hook sees SILENCE — pinned against gh source + a real merge payload), last-segment only, `--disable-auto` excluded; dormant when agent merges are guard-denied | `PR #N` from argv |
  | `git checkout -b/-B` / `switch -c/-C/--create` | start → fire + mark | `Switched to a new branch` (**stderr**; excludes `-B` resets) | branch → genStart |
  | `git worktree add` | start → fire + mark | `Preparing worktree` (stdout) | branch from git's own `(new branch '…')` line (argv-parse-free — resolves unexpanded `"$BR"` to the real name), else path basename; quoted fragments/`$` tokens = capture failure → generic template |

  Sidechain (subagent) Bash calls carry `agent_id`/`agent_type` on the hook's
  stdin (pinned live) and are **excluded from boundary logic entirely** — a
  subagent's `git worktree add` is not a main-conversation work boundary and
  must not overwrite the main generation label. A single chained payload
  (`git pull && git branch -d … && git worktree add …`) fires ONE terminal
  nudge but still records the co-present start label and sees the full
  deletion list (lifetime rule 1 holds across chaining).

  **Templates (keep-first).** The instruction's real counterfactual value is
  the KEEP clause (a summarizer drops detail by default; what it can lose is
  your in-flight state), so keep is a template constant that cannot be
  omitted, and **no file path can ever appear** — the only dynamic fragments
  are sanitized labels. A mis-detected boundary therefore costs one harmless
  generic instruction. Terminal boundaries say "진행 중 작업 보존 + 방금 완료된
  작업(라벨) 축약"; start boundaries say "새 작업(라벨)의 목표·계획·직전 탐색
  보존 + **이미 완료·마무리된** 과거 작업 축약" (completion-scoped — harmless
  when other work is still in flight). Both end with an expiry line: the
  instruction (and its cost estimate) is priced for *now*; a late paste can
  cost up to ~3.5× (cold cache).
  - **genStart lifetime (generation-correct labels):** a start signal records
    `genStart` (always — even below the gate or inside the cooldown; a raw
    token containing `$` — an unexpanded shell variable — is a capture
    failure, not a label: 23% of mined start labels were `$WT`-style garbage).
    A FIRING terminal boundary consumes it unconditionally (sole survival:
    branch-del whose **full deletion list** provably excludes it — first-match
    only would mislabel on batch cleanups, real transcript 6d544728; basename
    labels are incomparable → consume), the consumed label moves to `genDone`
    and may only be reused in the **conditional** drop form ("…가 이미
    완료·마무리되었다면") — deliberate consumption can mislabel (hotfix without
    a start signal), and the conditional form makes that harmless. A
    suppressed (cooldown / below-floor) terminal match never touches genStart
    **unless its payload explicitly names it** (`gh pr create --head L`,
    `git push -u origin L`, L in the deletion list) — then it consumes
    silently: in a micro PR cycle (start → PR inside the cooldown) the
    finished label would otherwise linger and surface as a keep mislabel
    (Phase 0 replay: 2 real cases → 0 after this refinement, fire timing
    unchanged; a plain `git pull` names nothing, so the original protection —
    no label theft right after setup — is intact). TTL 6h; state loss costs
    one label-less generic nudge. Net effect of all this conservatism:
    terminal-template keep labels are in practice ~always generic — intended.
  - **Cost estimate segment:** `지금 압축 추정 ~$X(warm)` —
    `(ctx × input$/MTok × 0.1 + 3k × output$/MTok) / 1e6`, 1-decimal. Model and
    ctx come from the same last main-chain usage entry the gate used (zero
    extra reads); prices from `lib/pricing.mjs` (single source with analyze);
    unknown model → segment omitted (never guess). Warm holds at emit time
    (boundary = right after activity, inside the 5m cache TTL). API-list $ —
    on subscription plans it is a quota-burn reference, not a bill, and it is
    structurally unverifiable post-hoc (compaction calls record no usage).
  - **Nudge log:** every fired nudge appends one line to
    `$XDG_DATA_HOME/acp/ctx-budget/nudges.jsonl` (default
    `~/.local/share/acp/ctx-budget/`, override `ACP_CTX_BUDGET_DATA_DIR`) —
    `byteOffset` = transcript size at emit, template kind, labels, `estUsd`,
    `costShown` tri-state — the raw material for offline compliance
    measurement (nudge → manual `compact_boundary` within the match window)
    and the keep-mislabel audit. Persistent on purpose: the compliance verdict
    (#29) needs ≥20 samples over up to 30 days, which a tmpdir ledger would
    lose on every reboot (#31). Log failures never block the message.
  - **Forward-predicate ban (invariant):** every input to a firing decision is
    a fact that already exists at fire time (just-arrived payload evidence,
    current usage, recorded labels). No rule may wait on "no reappearance for
    K turns" — that timing contradiction killed the original design. This ban
    also binds the deferred file-ledger layer (L2 pre-contract in issue #21):
    if it ever ships, stale judgment must be backward-looking only.

## How it measures

Context size = `input + cache_read + cache_creation` from the last main-chain
(`isSidechain !== true`) assistant `usage` entry in the transcript; only the
file tail (~256KB) is read per event. Compaction boundaries are
`{"type":"system","subtype":"compact_boundary"}` entries. All transcript
format knowledge here was pinned against real transcripts (CC 2.1.198), not
guessed — the format is CC-internal, so re-verify against a live transcript
before extending any parsing, and always fail open.

## Config

| Env var | Default | Meaning |
| --- | --- | --- |
| `ACP_CTX_BUDGET_WINDOW` | `200000` | Context window in tokens. **Set this to your model's real window** — percentages are only as truthful as this value. |
| `ACP_CTX_BUDGET_COMPACT_PCT` | `50` | Hook-side gate: from this % on, tier alerts add the /compact recommendation + inline attribution. (The statusline advisory has its own ladder below.) |
| `ACP_CTX_BUDGET_STEP` | `10` | Tier width in percent. |
| `ACP_CTX_BUDGET_TOP_N` | `3` | Consumer families the alert lists and the HUD keeps. |
| `ACP_CTX_BUDGET_REFRESH_SEC` | `120` | Max HUD-cache staleness before an ordinary event refreshes it (keeps the HUD populated between tier crossings / right after a compaction). |
| `ACP_CTX_BUDGET_NUDGE_MIN_TOK` | `min(200000, WINDOW×COMPACT_PCT/100)` | Boundary-nudge absolute floor in tokens. The default preserves the old 50% behaviour on a 200k window and caps at 200k on big windows (below it, compacting is a net loss: summary cost + cache reset for ~no gain). |
| `ACP_CTX_BUDGET_NUDGE_COST` | on (`0` to disable) | ALL $ figures: the nudge cost segment AND the HUD costs/rents (one knob so the module never half-prices). |
| `ACP_CTX_BUDGET_SUMMARY_OUT_TOK` | `3000` | Summary-output approximation used by the compact-cost estimate (nudge segment and HUD advisory share it). |
| `ACP_CTX_BUDGET_DATA_DIR` | `$XDG_DATA_HOME/acp/ctx-budget`, else `~/.local/share/acp/ctx-budget` | Directory of the persistent nudge ledger (`nudges.jsonl`). The test harness pins this to a sandbox so `npm test` can never pollute the real ledger. |
| `ACP_CTX_BUDGET_ADVISE_PCT` | `8` | Statusline advisory: from this % on, `/compact 고려`. |
| `ACP_CTX_BUDGET_RECOMMEND_PCT` | `35` | Statusline advisory: from this % on, `/compact 권장`. |
| `ACP_CTX_BUDGET_URGENT_PCT` | `70` | Statusline advisory: from this % on, `곧 자동압축` (near where Claude Code auto-compacts). |

The advisory ladder is calibrated on 41 real 1M-window sessions (peaks are
bottom-heavy: p50≈16%, p75≈36%, max≈66%), so a flat 50% gate fired in only ~17%
of them; `8 / 35 / 70` covers roughly the top 75% and keeps each step meaningful.

State (last tier alerted, shared boundary cooldown, cached consumers +
turn/compact costs, `genStart`/`genDone` labels) lives per transcript at
`os.tmpdir()/acp/ctx-budget/<hash>.json` — ephemeral by design; losing it only
means one repeated alert or one label-less generic nudge. The nudge ledger is
the opposite: it is measurement data, so it lives in the persistent data dir
(see `ACP_CTX_BUDGET_DATA_DIR` above) and survives reboots. Losing it costs
measurement samples, never behaviour — writes stay fail-open. No rotation on
purpose: ~250 bytes per fired nudge under a 5-minute cooldown is ≲60 KB/year
at observed rates.

## Which channel says what

Three surfaces recommend `/compact` and they answer **different questions**,
so they can legitimately disagree at the same moment — on a 1M window at
~320k, the statusline advisory says `/compact 고려` in its mildest tone
(capacity view: 32% is size-worth-considering, not urgent) while a boundary
nudge says `적기` emphatically (opportunity view: a work unit just closed and
every later turn re-sends those tokens as cache reads). Both are correct.

| Channel | When | Question it answers |
| --- | --- | --- |
| statusline advisory (`여유`/`고려`/`권장`) | always-on | how full is the window (% — capacity), and what compacting now costs |
| tier alerts | on a tier crossing | what filled it (attribution) |
| **boundary nudge** | at a work boundary | is NOW a good moment, and what to keep (absolute tokens — opportunity) |
| CLAUDE.md `Compact Instructions` (below) | auto-compact fallback | static keep rules when no nudge was pasted |

## CLAUDE.md snippet (auto-compact fallback, opt-in)

Hooks cannot influence auto-compact (PreCompact can only block, and nothing
can trigger a compact programmatically), but Claude Code reads a static
`Compact Instructions` section from CLAUDE.md for every compaction. The plugin
never edits your files — if you want the generation-GC policy to survive an
auto-compact you never pasted a nudge for, add something like this yourself:

```markdown
## Compact Instructions

- 진행 중 작업의 결정사항·미완료 항목·다음 단계는 반드시 보존.
- 이미 완료·마무리된 과거 작업(머지된 PR·삭제된 브랜치)의 구현 상세·시행착오·
  툴 출력은 결론 한 줄로 축약.
```

## Statusline HUD (always-visible)

The tier alerts are push notifications at the moment you cross a line — they
scroll away. `statusline.mjs` complements them with an always-on one-liner in
the Claude Code status bar that also carries a **standing /compact advisory**,
so the recommendation persists instead of vanishing with the message:

```text
ctx 24% · /compact 고려 ($0.4) · ~$0.24/turn · 5h 41% · 7d 27% · top npm test ~$0.032/turn (4회)
```

- **`ctx`** — context-window %, straight from the statusline JSON's
  pre-computed `context_window.used_percentage` (no transcript parsing on the
  render path).
- **advisory** — an always-on, size-based `/compact` suggestion keyed off that
  same `ctx` %, worded as a recommendation, never a mandate. When the model is
  priced, the **one-time cost of compacting now** rides in parens — the same
  warm-cache estimate (and display precision) the boundary nudges print, so the
  two surfaces never quote different prices. Four steps (thresholds in Config):
  - `여유` — below 8%: too small to bother.
  - `/compact 고려 ($x)` — from 8%.
  - `/compact 권장 ($x)` — from 35%, a genuinely large session.
  - `/compact 권장 · 곧 자동압축 ($x)` — from 70%, near auto-compact.

  Shown only when `ctx` % is present (older Claude Code without the field →
  segment omitted, like the others). Boundary moments are the hook's job — it
  surfaces them as one-shot copy-paste instruction nudges (see Behaviour); a
  persistent "경계 지시문 대기" statusline segment stays deferred (open
  question in issue #21).
- **`~$y/turn`** — the whole-context **per-turn re-read cost**: what each
  message currently bills just to re-send the accumulated context (warm
  cache-read rate). Pairs with the advisory's compact cost — *spend `$x` once,
  or keep paying `$y` every turn*.
- **`5h` / `7d`** — plan-quota usage from `rate_limits.five_hour` /
  `rate_limits.seven_day`. These reflect your subscription's rolling limits,
  independent of context.
- **`top`** — the LEADING context consumer, as a per-turn **rent** (its share
  of the turn cost) with a call count, read back from the ctx-budget state file
  (refreshed on tier crossings + the `REFRESH_SEC` throttle; cleared on
  compaction, dropped after 1h). Leader only — one family answers "what is
  filling the window" at a glance; the full top-N list still appears in the
  ≥ 50% tier alerts. A consumer's *cumulative* $ is deliberately not shown: it
  would need each token's turn-age, which isn't tracked — the per-turn rate is
  the honest, decision-relevant figure. Unpriced models show token estimates
  instead.

Every segment is omitted when its field is absent, and any error prints a blank
line — it never crashes your status bar.

### Install

It is **not** a hook. Add it to your **`settings.json`** `statusLine` (the
plugin never edits your settings):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /ABSOLUTE/PATH/TO/agent-context-protector-plugin/core/ctx-budget/statusline.mjs"
  }
}
```

Point at a stable path — your repo clone (updates on `git pull`) or a copy you
keep somewhere fixed. The plugin **cache** path carries a version
(`.../agent-context-protector/<version>/...`) and changes on every upgrade, so
don't hardcode that one. The script is self-contained (node built-ins only), so
copying it anywhere works.

**Already have a status line?** Append this one's output to yours:

```bash
#!/usr/bin/env bash
input=$(cat)
line1=$(printf '%s' "$input" | your-existing-statusline)
line2=$(printf '%s' "$input" | node /ABSOLUTE/PATH/.../core/ctx-budget/statusline.mjs)
printf '%s | %s\n' "$line1" "$line2"
```

(Claude Code pipes the same JSON to whatever `statusLine.command` you set, so
fan it out to both.)

## Honest limits

- A nudge is indirect: it saves nothing if ignored — and **a bad instruction
  followed can be a net negative** (lost in-flight state + re-reads + cache
  reset; cache reads burn quota even on subscription plans). The design caps
  that downside structurally: the keep clause cannot be omitted, no file path
  can appear in a nudge, assertive drop labels come only from same-payload
  captures, and inherited labels are conditional-form only. The flip side of
  that conservatism: most terminal nudges carry a *generic* keep label —
  intended cost, not a bug.
- The cost estimate is a one-way approximation: compaction API calls record no
  usage in the transcript, so it can never be verified or calibrated post-hoc.
  Unknown models get no estimate at all.
- The `{"systemMessage": ...}` shape is confirmed against the official hooks
  docs (top-level field, exit 0, any event); actual display was verified live
  after install.
- Token figures are chars/4 approximations — ranking is robust, absolute
  values are rough. Usage lags by half a turn.
- Compliance (nudge → manual compact) is measurable from `nudges.jsonl` +
  `compactMetadata.trigger:"manual"`, but it is an upper-bound signal — the
  statusline advisory and tier alerts recommend /compact too, so judge it
  against the boundary-free base rate (analyze report — issue #29). Kill
  criteria live in issue #21 (≥20 nudges or 30 days: <10% → kill the
  instruction body, ≥30% → open the L2 file-ledger review); that measurement
  chain is NOT armed until #29 ships.

## Test locally

```bash
printf '%s\n' '{"type":"assistant","isSidechain":false,"message":{"usage":{"input_tokens":100,"cache_read_input_tokens":109900,"cache_creation_input_tokens":0}}}' > /tmp/cb-demo.jsonl
echo '{"tool_name":"Read","tool_input":{},"transcript_path":"/tmp/cb-demo.jsonl"}' \
  | node core/ctx-budget/ctx-budget.mjs
# -> {"systemMessage":"[ctx-budget] 컨텍스트 55% 사용 중 (110k / 200k tok) — /compact 권장"}
```
