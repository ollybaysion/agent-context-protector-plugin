#!/usr/bin/env node
// output-cap (PostToolUse / Bash): shrink oversized Bash output before it is
// committed to context, using replaceToolOutput (updatedToolOutput). Two-step
// pipeline (DESIGN.md §6.2): ① denoise — strip ANSI escapes, \r progress-bar
// overwrites and blank-line runs (what a terminal would not display anyway);
// ② if still over budget, keep the head and tail (where the signal usually
// is) and drop the middle, leaving a marker with how much was cut. stdout and
// stderr are shrunk independently; every other field is preserved.
//
// It never blocks (never exit 2); any error fails open. Requires Claude Code
// >= v2.1.121 for updatedToolOutput on built-in tools — older builds ignore it,
// so this degrades to a harmless no-op.
//
// Tunable: ACP_OUTPUT_CAP_MAX (chars, must be a positive number; otherwise the
// 8000 default is used). Head/tail kept are 0.7/0.2 of it, and a result that is
// not actually smaller than the input is never emitted, so capping can only ever
// shrink the payload.

import {
  readHookInput,
  replaceToolOutput,
  pass,
  failOpen,
} from "../../lib/hook-io.mjs";

const parsed = Number(process.env.ACP_OUTPUT_CAP_MAX);
const MAX_CHARS = Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
const HEAD_CHARS = Math.floor(MAX_CHARS * 0.7);
const TAIL_CHARS = Math.floor(MAX_CHARS * 0.2);

// Rough token estimate for the marker (~4 chars/token for English/code).
const approxTokens = (n) => Math.round(n / 4);

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;

// Take the first `n` UTF-16 units of `s` without ending on a dangling high
// surrogate (which would render as a broken glyph).
function headSlice(s, n) {
  let end = Math.min(n, s.length);
  if (end > 0 && isHighSurrogate(s.charCodeAt(end - 1))) end -= 1;
  return s.slice(0, end);
}

// Take the last `n` UTF-16 units of `s` without starting on a dangling low
// surrogate.
function tailSlice(s, n) {
  let start = Math.max(0, s.length - n);
  if (start < s.length && isLowSurrogate(s.charCodeAt(start))) start += 1;
  return s.slice(start);
}

// Step ① — lossless-ish denoise: strip what a terminal would not display
// anyway. ANSI escape sequences (colors, cursor moves, OSC titles), \r
// progress-bar overwrites (keep only what survives on screen: the text after
// the last \r of each line), and runs of blank lines. Only invoked once a
// field is over budget, so small outputs are never touched.
function denoise(text) {
  let t = text;
  // CSI (colors, cursor). Param bytes include ECMA-48's : < = > (truecolor SGR
  // variants, private sequences).
  t = t.replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g, "");
  // OSC (titles, links). The terminator (BEL or ST) is REQUIRED: with an
  // optional terminator an unterminated \x1b] (e.g. output killed mid-write)
  // would swallow everything to end-of-string — silent content loss.
  t = t.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  // Stray two-char escapes. The u flag makes . consume a full code point, so
  // ESC before an emoji cannot split its surrogate pair. A final sweep drops
  // any ESC left dangling (before \n / at EOF / unterminated OSC lead-in).
  t = t.replace(/\x1b./gu, "");
  t = t.replace(/\x1b/g, "");
  t = t
    .split("\n")
    .map((line) => {
      // CRLF line endings are not overwrites — drop the trailing \r first.
      const l = line.endsWith("\r") ? line.slice(0, -1) : line;
      // Approximates terminal rendering: overwritten progress frames drop out.
      // (Not exact when a later frame is shorter than an earlier one.)
      const i = l.lastIndexOf("\r");
      return i === -1 ? l : l.slice(i + 1);
    })
    .join("\n");
  t = t.replace(/\n{3,}/g, "\n\n"); // collapse blank-line runs
  return t;
}

// Step ② — head+tail truncation with a marker recording what was cut.
function capText(text) {
  const head = headSlice(text, HEAD_CHARS);
  const tail = tailSlice(text, TAIL_CHARS);
  const dropped = text.length - head.length - tail.length;
  const marker =
    `\n\n[... output-cap: dropped ${dropped} of ${text.length} chars ` +
    `(~${approxTokens(dropped)} tokens) from the middle. Re-run with a narrower ` +
    `command (rg, head -n, --tail) if you need the omitted part. ...]\n\n`;
  return head + marker + tail;
}

// Return a shrunk copy of `text`, or null if it is already within budget OR
// shrinking would not actually make it smaller (never inflate the payload).
// Pipeline per DESIGN.md §6.2: denoise first; truncate only if still too big.
function shrink(text) {
  if (typeof text !== "string" || text.length <= MAX_CHARS) return null;
  const denoised = denoise(text);
  const base = denoised.length < text.length ? denoised : text;
  const result = base.length > MAX_CHARS ? capText(base) : base;
  return result.length < text.length ? result : null;
}

try {
  const input = await readHookInput();
  if (input?.tool_name !== "Bash") pass(); // only Bash output

  const resp = input?.tool_response;

  // Bare-string result: cap the string directly. (Built-in Bash returns an
  // object, so this branch is a defensive fallback for string-shaped results.)
  if (typeof resp === "string") {
    const capped = shrink(resp);
    if (capped === null) pass();
    replaceToolOutput(capped);
  }

  // Object result (built-in Bash: { stdout, stderr, interrupted, isImage }).
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    if (resp.isImage) pass(); // never touch image payloads
    const cappedOut = shrink(resp.stdout);
    const cappedErr = shrink(resp.stderr);
    if (cappedOut === null && cappedErr === null) pass(); // both within budget
    const next = { ...resp };
    if (cappedOut !== null) next.stdout = cappedOut;
    if (cappedErr !== null) next.stderr = cappedErr;
    replaceToolOutput(next);
  }

  pass(); // unknown shape -> leave untouched
} catch (err) {
  failOpen(
    `[agent-context-protector/output-cap] internal error, skipping: ${err?.message ?? err}`,
  );
}
