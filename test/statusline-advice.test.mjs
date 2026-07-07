// Integration tests for the statusline HUD's model-advice segment: writes the
// advice state file directly (the shape model-advisor.mjs would have written)
// then drives the REAL statusline.mjs as a subprocess, statusline-hud.test.mjs
// style — this verifies the handoff contract, not an extracted function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { advicePath, saveAdvice } from "../core/model-guard/lib/state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HUD = join(here, "..", "core", "ctx-budget", "statusline.mjs");

let seq = 0;
function freshTranscriptPath() {
  const dir = join(tmpdir(), "acp-test", `advice-hud-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `t-${seq++}.jsonl`);
}

function runHud(input) {
  return execFileSync(process.execPath, [HUD], {
    input: JSON.stringify(input),
    env: process.env,
  })
    .toString()
    .trim();
}

test("valid advice + no model field on stdin -> segment shown", () => {
  const tp = freshTranscriptPath();
  saveAdvice(tp, { text: "/model sonnet 권장(8중 6턴 대화형)", model: "claude-fable-5", ts: Date.now() });

  const hud = runHud({ transcript_path: tp });
  assert.ok(hud.includes("/model sonnet 권장(8중 6턴 대화형)"), hud);
});

test("valid advice + live model matches advice.model -> shown", () => {
  const tp = freshTranscriptPath();
  saveAdvice(tp, { text: "/model sonnet 권장(8중 6턴 대화형)", model: "claude-fable-5", ts: Date.now() });

  const hud = runHud({ transcript_path: tp, model: { id: "claude-fable-5" } });
  assert.ok(hud.includes("/model sonnet 권장"), hud);
});

test("valid advice + live model diverges from advice.model -> hidden (self-erase)", () => {
  const tp = freshTranscriptPath();
  saveAdvice(tp, { text: "/model sonnet 권장(8중 6턴 대화형)", model: "claude-fable-5", ts: Date.now() });

  const hud = runHud({ transcript_path: tp, model: { id: "claude-sonnet-5" } });
  assert.ok(!hud.includes("/model"), hud);
});

test("expired advice -> hidden", () => {
  const tp = freshTranscriptPath();
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  saveAdvice(tp, { text: "/model sonnet 권장(8중 6턴 대화형)", model: "claude-fable-5", ts: twoHoursAgo });

  const hud = runHud({ transcript_path: tp });
  assert.ok(!hud.includes("/model"), hud);
});

test("missing advice file -> hidden, other segments render normally", () => {
  const tp = freshTranscriptPath(); // never written
  const hud = runHud({ transcript_path: tp, context_window: { used_percentage: 5 } });
  assert.ok(!hud.includes("/model"), hud);
  assert.match(hud, /ctx 5%/);
});

test("corrupt advice file -> hidden, other segments render normally", () => {
  const tp = freshTranscriptPath();
  mkdirSync(dirname(advicePath(tp)), { recursive: true });
  writeFileSync(advicePath(tp), "{not valid json");

  const hud = runHud({ transcript_path: tp, context_window: { used_percentage: 5 } });
  assert.ok(!hud.includes("/model"), hud);
  assert.match(hud, /ctx 5%/);
});

test("control characters in advice.text are stripped from the rendered line", () => {
  const tp = freshTranscriptPath();
  saveAdvice(tp, { text: "/model sonnet\n권장\x1b[31m(주입)", model: "claude-fable-5", ts: Date.now() });

  const hud = runHud({ transcript_path: tp });
  assert.ok(!/[\x00-\x1f\x7f]/.test(hud), hud);
});
