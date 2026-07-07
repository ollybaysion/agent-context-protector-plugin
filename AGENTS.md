# Adding a hook to agent-context-protector

Read this before adding a new hook module. The plugin is a collection of
independent context-budget-protection hooks; adding one must not change any
existing module. Strategy and rationale live in [DESIGN.md](DESIGN.md).

## The contract (4 steps)

1. Create a self-contained module at `core/<name>/` with `<name>.mjs` (Node
   ESM), an optional `config/`, and a `README.md`.
2. Write the logic in `<name>.mjs` using the shared helpers from
   `lib/hook-io.mjs` — do not re-implement stdin parsing or exit-code handling.
3. Wire one entry into `hooks/hooks.json` under the right event, grouped with any
   existing matcher for that event (see the wiring example below).
4. Document it: write `core/<name>/README.md`, and add a row to the Modules table
   in the top-level `README.md`.

Reference bundled files relative to the script (`import.meta.url` + `node:path`),
never via absolute or project paths. `${CLAUDE_PLUGIN_ROOT}` is only for the
`command` string in `hooks.json`, and it changes on every plugin update — never
persist state under it. Disposable STATE (cooldowns, caches — losing it must be
harmless) goes to `os.tmpdir()`; durable MEASUREMENT data (samples an offline
report accumulates across reboots, e.g. ctx-budget's nudge ledger) goes to the
XDG data dir (`$XDG_DATA_HOME`, default `~/.local/share`).

### Wiring example

```json
{
  "type": "command",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/core/<name>/<name>.mjs\"",
  "timeout": 60
}
```

## Terminal helpers (call exactly one)

- `pass()` — exit 0; not applicable, or nothing to do. NOT an auto-approve.
- `denyPreToolUse(reason)` — PreToolUse: block before the tool runs; `reason`
  reaches the model. The primary budget lever.
- `askPreToolUse(reason)` — PreToolUse: confirmation gate. Does not survive
  bypass mode; prefer `deny` for budget.
- `replaceToolOutput(output)` — PostToolUse: swap the tool result for a smaller
  one. Clone the original result shape; a bare string is ignored (CC >= v2.1.121).
- `blockWithFeedback(msg)` — PostToolUse: `exit 2` + stderr correction loop.
- `emitSystemMessage(msg)` / `emitAdditionalContext(event, text)` — user-facing
  reminder / model-context injection.
- `failOpen(note)` — infrastructure error; non-blocking.

## Rules every module must follow

- Pick the event by what you need: block before it happens → PreToolUse
  (`denyPreToolUse` or `exit 2`); shrink a result after the fact → PostToolUse
  (`replaceToolOutput`).
- Exit-code discipline: only `exit 2` blocks. Any other non-zero fails open.
  Never mix `exit 2` with stdout JSON (on `exit 2`, stdout is discarded).
- NEVER use PreToolUse `updatedInput` — unreliable under multi-hook and requires
  auto-approve. Use `deny` + `replaceToolOutput` instead (DESIGN.md §4).
- Prefer `deny` over `ask` for budget: `ask`'s reason goes to the user only and
  is skipped in bypass mode.
- Scope tightly: filter on `tool_name` / path early and `pass()` for anything
  outside your module's concern. PostToolUse runs on many calls — keep it fast.
- Stay orthogonal to claude-hooks: `bash-guard`/`git-guard` already cover
  grep→rg, find→fd, main protection, and rm -rf. Do not duplicate their rules.
- Fail open on missing external tools so a partial install never breaks a session.

## Test locally before wiring

Drive the script directly with a synthetic event on stdin:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | node core/<name>/<name>.mjs; echo "exit=$?"
```

Cover: applicable-and-clean (exit 0), applicable-and-triggering (deny / replace),
not-applicable (exit 0), and error (fail open). Then load the whole plugin with
`claude --plugin-dir .` and `/reload-plugins`.
