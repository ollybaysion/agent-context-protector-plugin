# input-gate

**Event:** PreToolUse (matcher `Bash|Read`) · **Mechanism:** `permissionDecision:
"deny"` · **Never uses exit 2.**

Denies firehose tool calls *before* they run, so their output never enters the
context at all. Every deny reason carries a concrete bounded alternative, so
Claude retries with the narrow form in one round trip.

With `output-cap` active the worst case is already bounded (~8000 chars), so
this gate's added value is: (1) not wasting the execution itself — follow-mode
commands hang until the 2-minute tool timeout, full-journal scans are slow —
and (2) preserving semantics: `git diff --stat` reads better than a diff with
its middle dropped by a truncation marker.

## Rules

### FOLLOW — denied even when piped or redirected

These stream forever in a non-TTY shell and hang the tool call until timeout:

| Trigger | Suggested alternative |
| --- | --- |
| `tail -f` / `-F` / `--follow` | the Read tool (bash-guard steers `tail FILE` to Read anyway, so suggesting `tail -n` would just bounce off a second deny) |
| `journalctl -f` | `journalctl -n 200 -u UNIT` |
| `docker logs -f` (incl. `compose` / `container` / `service` forms) | `docker logs --tail 200` |
| `kubectl logs -f` | `kubectl logs --tail=200` |
| `pm2 logs` without `--nostream` (it streams **by default**) | `pm2 logs --lines 200 --nostream` |

Combined short options are recognized (`ls -lRh`, `journalctl -ef`,
`docker logs -ft`), and getopt no-space forms count as bounded
(`journalctl -n200`).

### VOLUME — skipped when the command pipes (`\|`) or redirects (`>`, `<`) anywhere

A pipe or redirect may bound the output downstream — uncertain, so the gate
fails open. Otherwise:

| Trigger | Suggested alternative |
| --- | --- |
| `ls -R` / `--recursive` | `ls DIR` (one level), `fd -t d -d 2`, `tree -L 2` |
| `tree` without `-L` | `tree -L 2 DIR` |
| `du` without `-s` / `-d` / `--max-depth` | `du -sh DIR`, `du -h -d 1 DIR` |
| `journalctl` without `-n` / `--lines` | `journalctl -n 200 -u UNIT` |
| `docker logs` without `--tail` / `-n` | `docker logs --tail 200` |
| `kubectl logs` without `--tail` / `--since` | `kubectl logs --tail=200` |
| `git log -p` without a count (`-n N` / `-N` / `--max-count`) | `git log --stat -n 20`, then `git show SHA` |
| `git diff` whose **measured** size exceeds the budget | `git diff --stat`, then `git diff -- PATH` |
| `curl` without `-o` / `-O` / `-I` / `--max-filesize` (combined flags like `-sSLo` are recognized) | save with `-o` then `jq`/`rg`, or pipe to `jq` |
| `wget -O-` (stdout mode only — default wget saves to a file and is left alone) | save to a file, then `jq`/`rg` |

`git diff` is the only measured rule: the hook reruns the diff as
`git diff --shortstat` (5s timeout, expansion-free simple commands only) and
denies only when insertions+deletions exceed `ACP_INPUT_GATE_DIFF_MAX_LINES`.
Anything compound (`$()`, backticks, `;`, `&&`…) is uncertain → passes.

### READ — whole-file reads

| Trigger | Suggested alternative |
| --- | --- |
| No `limit` and file > `ACP_INPUT_GATE_READ_MAX_BYTES` | `rg` first, or paged Read with `limit` |
| Generated artifact (`*.min.js`, `*.map`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, …) > `ACP_INPUT_GATE_ARTIFACT_MAX_BYTES` | `jq` a key / `rg` a string |

Visual reads (`.png`, `.jpg`, `.pdf`, …) always pass — Read renders those, the
size heuristics don't apply. A missing/unreadable file passes so Read itself
reports the real error.

## Config

| Env var | Default | Meaning |
| --- | --- | --- |
| `ACP_INPUT_GATE_DIFF_MAX_LINES` | `1000` | Max measured diff lines (insertions+deletions) before `git diff` is denied |
| `ACP_INPUT_GATE_READ_MAX_BYTES` | `262144` | Max file size for a whole-file Read |
| `ACP_INPUT_GATE_ARTIFACT_MAX_BYTES` | `65536` | Max file size for a generated-artifact Read |

Each must be a positive number; anything else falls back to the default.

## Deliberately out of scope

- `grep`→`rg`, `find`→`fd`, `cat`→Read, `sed -i`, `top`, `cd &&` — owned by
  claude-hooks `bash-guard`; branch protection by `git-guard` (orthogonality).
- `rg -uu` sweeps: whether an explicit narrow path is present can't be parsed
  reliably (quotes, globs, variables) — "uncertain → pass" wins over the rule.
- The DESIGN.md idea of suggesting `ls -R -L2` was dropped: `ls -L` dereferences
  symlinks, it is **not** a depth limit. Depth-limited alternatives are
  `fd -d` / `tree -L`.

## Test locally

```bash
# Denied (follow mode):
echo '{"tool_name":"Bash","tool_input":{"command":"tail -f /var/log/syslog"}}' \
  | node core/input-gate/input-gate.mjs

# Passes (bounded):
echo '{"tool_name":"Bash","tool_input":{"command":"tail -n 200 /var/log/syslog"}}' \
  | node core/input-gate/input-gate.mjs; echo "exit=$?"
```
