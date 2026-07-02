// Shared I/O helpers for agent-context-protector command hooks.
// Hooks receive a JSON event on stdin and signal decisions via exit code + stdout/stderr.
// Exit-code contract:
//   exit 2          -> blocking; stderr is fed back to Claude (correction loop)
//   exit 0          -> pass; stdout (if any) is processed as a decision/output
//   any other non-0 -> "fail open" (non-blocking); stderr only lands in transcript
// IMPORTANT: never mix `exit 2` with stdout JSON — when exiting 2, stdout is ignored.
//
// This plugin's lever set (see DESIGN.md): PreToolUse `deny` gates BEFORE bloat
// enters context (denyPreToolUse), and PostToolUse output replacement AFTER a
// tool runs but before its result is committed (replaceToolOutput). It never
// uses PreToolUse `updatedInput` (unreliable under multi-hook + auto-approve).

import { writeSync } from "node:fs";

/** Read the full hook event from stdin and parse it as JSON. */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Path of the file a Write/Edit/MultiEdit tool acted on, or undefined. */
export function toolFilePath(input) {
  return input?.tool_input?.file_path;
}

/**
 * Write `text` to a file descriptor SYNCHRONOUSLY, then exit with `code`.
 * Synchronous write is load-bearing: `process.stdout.write(x); process.exit()`
 * drops everything past the OS pipe buffer (~64KB on Linux) because the async
 * write has not drained when the process exits — which would hand Claude Code a
 * truncated, invalid JSON object. `writeSync` guarantees the full payload lands
 * before exit, which matters for `replaceToolOutput` (large payloads).
 */
function emitAndExit(fd, text, code) {
  writeSync(fd, text);
  process.exit(code);
}

/**
 * Block the current step and feed `message` back to Claude as a correction
 * instruction. The trailing imperative is load-bearing: without an explicit
 * "fix it" line, Claude tends to read the errors and move on.
 */
export function blockWithFeedback(message) {
  emitAndExit(2, message.endsWith("\n") ? message : message + "\n", 2);
}

/** Pass silently (no findings, or not applicable to this hook). */
export function pass() {
  process.exit(0);
}

/**
 * PreToolUse-only structured denial: refuse the tool call before it runs and
 * hand Claude a typed reason. Emitted as stdout JSON with exit 0 — do NOT mix
 * with `exit 2` (when exiting 2, stdout is discarded). A silent `pass()` is the
 * opposite of this: it is NOT an auto-approve, it just defers to the normal
 * permission flow. `permissionDecision` must be exactly allow|deny|ask.
 */
export function denyPreToolUse(reason) {
  emitDecision("deny", reason);
}

/**
 * PreToolUse-only: route the tool call to the user for confirmation instead of
 * auto-allowing it. For destructive-but-sometimes-legitimate actions where a
 * hard `deny` would be too blunt. Note: unlike `deny`, an `ask` does not survive
 * bypass-permissions mode — it is a confirmation gate, not a hard block. For
 * budget purposes prefer `deny` (its reason reaches the model). stdout JSON + exit 0.
 */
export function askPreToolUse(reason) {
  emitDecision("ask", reason);
}

/** Shared emitter for PreToolUse permission decisions (allow|deny|ask). */
function emitDecision(decision, reason) {
  emitAndExit(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
    0,
  );
}

/**
 * PostToolUse-only: replace the tool result the model sees with a smaller one
 * (e.g. a truncated / denoised version of huge stdout). stdout JSON + exit 0 —
 * do NOT mix with `exit 2` (on exit 2, stdout is discarded). `output` must mirror
 * the tool's own result shape: built-in Bash returns an OBJECT ({stdout, stderr,
 * ...}), so clone the original and shrink only the string fields — a bare string
 * is ignored. Requires Claude Code >= v2.1.121; older builds ignore
 * updatedToolOutput for built-in tools, so this degrades to a harmless no-op.
 */
export function replaceToolOutput(output) {
  emitAndExit(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: output,
      },
    }),
    0,
  );
}

/**
 * Surface a one-line message to the USER in the UI (it is NOT sent to the model).
 * stdout JSON + exit 0. Use for budget / tier reminders. Capped ~10k chars.
 */
export function emitSystemMessage(message) {
  emitAndExit(1, JSON.stringify({ systemMessage: message }), 0);
}

/**
 * Inject text INTO THE MODEL's context for this turn. `eventName` must be the
 * current hook event (e.g. "UserPromptSubmit", "SessionStart", "PostToolUse").
 * stdout JSON + exit 0. NOTE: plugin-scoped additionalContext delivery is event-
 * and version-dependent (see DESIGN.md §4/§9) — verify it reaches the model
 * before relying on it. Capped ~10k chars.
 */
export function emitAdditionalContext(eventName, text) {
  emitAndExit(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: text,
      },
    }),
    0,
  );
}

/**
 * Fail open: an infrastructure problem (missing tool, internal error) that
 * should NOT block the user. Note is recorded in the transcript only.
 */
export function failOpen(note) {
  if (note) writeSync(2, note.endsWith("\n") ? note : note + "\n");
  process.exit(0);
}
