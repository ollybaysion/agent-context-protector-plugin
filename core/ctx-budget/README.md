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
  3 context consumers since the last compaction boundary
  (`상위 소비: Bash(npm test…) ~9.2k tok · Read(DESIGN.md) ~3.1k tok · …`),
  computed from tool_use/tool_result pairs in the transcript. Attribution runs
  only when an alert actually fires.
- **Boundary nudge:** while context ≥ 50%, a semantic-boundary moment —
  finished work whose detail is now safe to compact away — gets its own
  message. Rules are a data table (adding a boundary = one entry); each is
  segment-anchored (mere mentions don't fire) and requires positive success
  evidence in the output. Frequencies from mining 29 local sessions in
  parentheses:

  | Boundary rule | Evidence required | Mined freq |
  | --- | --- | --- |
  | PR created (`gh pr create`) | PR URL in stdout | 33 |
  | Merge evidence (`git pull`) | `Updating a1b..d4e` / `Fast-forward`; `Already up to date` is silent | 13 |
  | Branch cleanup (`git branch -d/-D`) | `Deleted branch` in stdout | 11 |
  | In-session `gh pr merge` | no error in stderr; dormant when agent merges are guard-denied | 4 |

  Below the threshold: silence (compacting a small context is a net loss:
  summary cost + cache reset for ~no gain). One shared 5-minute cooldown, so
  a post-merge cluster (pull → branch -d → next pr create) nudges once.

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
| `ACP_CTX_BUDGET_COMPACT_PCT` | `50` | From this % on, alerts add the /compact recommendation + attribution, and merge nudges arm. |
| `ACP_CTX_BUDGET_STEP` | `10` | Tier width in percent. |

State (last tier alerted, merge cooldown, cached top consumer) lives per
transcript at `os.tmpdir()/acp/ctx-budget/<hash>.json` — ephemeral by design;
losing it only means one repeated alert.

## Statusline HUD (always-visible)

The tier alerts are push notifications at the moment you cross a line.
`statusline.mjs` complements them with an always-on one-liner in the Claude
Code status bar:

```text
ctx 62% · 5h 41% · 7d 27% · top Bash(npm test…) ~31k tok
```

- **`ctx`** — context-window %, straight from the statusline JSON's
  pre-computed `context_window.used_percentage` (no transcript parsing on the
  render path).
- **`5h` / `7d`** — plan-quota usage from `rate_limits.five_hour` /
  `rate_limits.seven_day`. These reflect your subscription's rolling limits,
  independent of context.
- **`top`** — the leading context consumer, read back from the ctx-budget
  state file (populated once an attribution alert fires, i.e. ≥ 50% context;
  cleared on compaction, dropped after 1h).

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

- A nudge is indirect: it saves nothing if ignored.
- The `{"systemMessage": ...}` shape is confirmed against the official hooks
  docs (top-level field, exit 0, any event); actual display was verified live
  after install.
- Token figures are chars/4 approximations — ranking is robust, absolute
  values are rough. Usage lags by half a turn.

## Test locally

```bash
printf '%s\n' '{"type":"assistant","isSidechain":false,"message":{"usage":{"input_tokens":100,"cache_read_input_tokens":109900,"cache_creation_input_tokens":0}}}' > /tmp/cb-demo.jsonl
echo '{"tool_name":"Read","tool_input":{},"transcript_path":"/tmp/cb-demo.jsonl"}' \
  | node core/ctx-budget/ctx-budget.mjs
# -> {"systemMessage":"[ctx-budget] 컨텍스트 55% 사용 중 (110k / 200k tok) — /compact 권장"}
```
