# output-cap

**Event:** PostToolUse (matcher `Bash`) · **Mechanism:** `replaceToolOutput`
(updatedToolOutput) · **Never blocks.**

Shrinks oversized Bash `stdout` before it is committed to context. Keeps the head
and tail (where the signal usually sits) and drops the middle, replacing it with a
marker that records how much was cut. `stderr` and every other field are left
untouched, so errors and exit context survive.

Bash output is the single largest token sink in a session, and a capped result
keeps saving on every later turn (the whole context is re-sent each turn until
compaction). This module is the catch-all lever: it does not need to predict
which command misbehaves — it caps whatever comes back too large.

## Behaviour

- Only acts on `tool_name === "Bash"`; everything else passes untouched.
- Primary shape is the built-in object `{ stdout, stderr, interrupted, isImage }`
  — `stdout` and `stderr` are capped independently, other fields preserved. A
  bare-string result is handled as a defensive fallback.
- Image results (`isImage`) and non-string fields are left untouched.
- Output within budget is left untouched (no marker, no change).
- Never inflates: if the truncated result would not be smaller than the original,
  the output is left untouched.
- Slice boundaries never split a surrogate pair (no broken glyphs at the seam).
- On any internal error it fails open (no cap), so it can never wedge a session.

## Config

| Env var | Default | Meaning |
| --- | --- | --- |
| `ACP_OUTPUT_CAP_MAX` | `8000` | Max chars per field before capping. Must be a positive number; anything else (0, negative, non-numeric) falls back to `8000`. Head/tail kept are `0.7`/`0.2` of it. |

## Requirement

Claude Code `>= v2.1.121` for `updatedToolOutput` on built-in tools. On older
builds the replacement is ignored and this module is a harmless no-op.

## Test locally

```bash
# Triggers a cap (tiny threshold, long stdout):
printf '{"tool_name":"Bash","tool_input":{"command":"seq 1 100000"},"tool_response":{"stdout":"%s","stderr":"","interrupted":false,"isImage":false}}' \
  "$(seq 1 5000 | tr '\n' ' ')" \
  | ACP_OUTPUT_CAP_MAX=200 node core/output-cap/output-cap.mjs; echo "exit=$?"

# No cap (small output) -> no stdout, exit 0:
echo '{"tool_name":"Bash","tool_response":{"stdout":"hello","stderr":""}}' \
  | node core/output-cap/output-cap.mjs; echo "exit=$?"
```
