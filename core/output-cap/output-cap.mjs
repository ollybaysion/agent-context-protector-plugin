#!/usr/bin/env node
// output-cap (PostToolUse / Bash): shrink oversized Bash output before it is
// committed to context, using replaceToolOutput (updatedToolOutput). Keeps the
// head and tail (where the signal usually is) and drops the middle, leaving a
// marker with how much was cut. stdout and stderr are capped independently;
// every other field is preserved.
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

// Return a capped copy of `text`, or null if it is already within budget OR the
// capped result would not actually be smaller (never inflate the payload).
function capText(text) {
  if (typeof text !== "string" || text.length <= MAX_CHARS) return null;
  const head = headSlice(text, HEAD_CHARS);
  const tail = tailSlice(text, TAIL_CHARS);
  const dropped = text.length - head.length - tail.length;
  const marker =
    `\n\n[... output-cap: dropped ${dropped} of ${text.length} chars ` +
    `(~${approxTokens(dropped)} tokens) from the middle. Re-run with a narrower ` +
    `command (rg, head -n, --tail) if you need the omitted part. ...]\n\n`;
  const capped = head + marker + tail;
  return capped.length < text.length ? capped : null;
}

try {
  const input = await readHookInput();
  if (input?.tool_name !== "Bash") pass(); // only Bash output

  const resp = input?.tool_response;

  // Bare-string result: cap the string directly. (Built-in Bash returns an
  // object, so this branch is a defensive fallback for string-shaped results.)
  if (typeof resp === "string") {
    const capped = capText(resp);
    if (capped === null) pass();
    replaceToolOutput(capped);
  }

  // Object result (built-in Bash: { stdout, stderr, interrupted, isImage }).
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    if (resp.isImage) pass(); // never touch image payloads
    const cappedOut = capText(resp.stdout);
    const cappedErr = capText(resp.stderr);
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
