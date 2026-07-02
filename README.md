# agent-context-protector

Claude Code hooks that shield the agent's context window from bloat — huge tool
outputs, whole-file reads, firehose commands — to cut token/context budget. Split
out of `claude-hooks` because context-budget protection is one cohesive concern.

The two hard levers this plugin relies on (see [DESIGN.md](DESIGN.md)):

- **PreToolUse `deny` gate** — stop bloat *before* it enters context.
- **PostToolUse `replaceToolOutput`** — shrink a result *after* the tool runs but
  before it is committed (CC >= v2.1.121).

It deliberately never uses PreToolUse `updatedInput` (unreliable under the
multi-hook condition and its auto-approve requirement), and prefers `deny` over
`ask` (whose reason never reaches the model). No hook can force `/compact`, so
compaction modules only remind or enable.

## Modules

`output-cap` is active; the remaining modules are planned per phase.

| Module | Event | Status | Purpose |
| --- | --- | --- | --- |
| `input-gate` | PreToolUse (Bash + Read) | 🚧 planned — Phase 1 | Deny firehose commands/reads (recursive traversal, unbounded logs, huge diffs, remote payloads, large/generated-file reads) with a bounded alternative in the reason |
| `output-cap` | PostToolUse (Bash) | ✅ active | Truncate oversized Bash stdout (head + tail, keep stderr) via `replaceToolOutput`; denoise TBD |
| `read-once` | PreToolUse (Read) | 🚧 planned — Phase 2 | Deny re-reading a file already in context (path + mtime + range, compaction-aware) |
| `ctx-budget` | PostToolUse + Stop | 🚧 planned — Phase 2 | Context HUD + tier reminders (50/70/90%) + top-consumer attribution; the gated `/compact` reminder lives here |
| `transcript-vault` | PreCompact | 🚧 planned — Phase 3 | Back up the transcript before compaction so aggressive compaction is safe |
| `frugal-directive` | SessionStart | 💭 optional | Inject a short token-frugality charter (version-dependent) |

## Layout

```text
agent-context-protector-plugin/
├── .claude-plugin/
│   ├── plugin.json        # plugin manifest
│   └── marketplace.json   # this repo doubles as a 1-plugin marketplace
├── hooks/
│   └── hooks.json         # central wiring: every hook, grouped by event
├── core/<module>/         # one self-contained module per hook (added per phase)
├── lib/hook-io.mjs        # shared stdin / decision / output helpers
├── AGENTS.md              # module contract — read before adding a hook
├── DESIGN.md              # strategy, verified constraints, do-not-build list
└── README.md
```

Adding a hook = create `core/<name>/`, then add one entry to `hooks/hooks.json`.
See [AGENTS.md](AGENTS.md). Modules reference their own bundled files via
`${CLAUDE_PLUGIN_ROOT}` and never touch the user's project config.

## Requirements

- **Node.js** on `PATH` (hooks are written as `.mjs`).
- Missing per-module tools cause that hook to **fail open** (log a note and do
  nothing), so a partial install never breaks a session.

## Install

Local (development / single machine):

```bash
claude --plugin-dir /path/to/agent-context-protector-plugin
# reload after edits within a session:
/reload-plugins
```

Via marketplace (other machines):

```bash
/plugin marketplace add ollybaysion/agent-context-protector-plugin
/plugin install agent-context-protector@agent-context-protector
```

## Hook semantics

- **Exit codes:** `exit 2` = blocking (stderr fed back to Claude); any other
  non-zero = *fail open*. Never mix `exit 2` with stdout JSON.
- **PreToolUse** can deny before a tool runs; **PostToolUse** runs after, so it
  shrinks results rather than preventing them.
- `denyPreToolUse` stays orthogonal to `claude-hooks` (`bash-guard`/`git-guard`
  already own grep→rg, find→fd, main protection, rm -rf).
