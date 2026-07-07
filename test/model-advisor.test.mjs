// Integration tests for the model-advisor Stop hook: synthetic JSONL
// transcripts drive the REAL script as a subprocess (statusline-hud.test.mjs
// style), and we assert on the advice state file it writes via the same
// advicePath() the statusline HUD reads from.
//
// The verdict is always-on: every judgeable turn records either a "적합" fit
// verdict or, in the one flaggable cell (expensive model × conversational
// streak), a downgrade recommendation. Only an unjudgeable tail (window
// underrun) or a disabled module writes nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { advicePath } from "../core/model-guard/lib/state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ADVISOR = join(here, "..", "core", "model-guard", "model-advisor.mjs");

let seq = 0;
function freshTranscriptPath() {
  const dir = join(tmpdir(), "acp-test", `advisor-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `t-${seq++}.jsonl`);
}

function assistantLine({ model = "claude-fable-5", tools = [], isSidechain = false, synthetic = false } = {}) {
  const content = tools.map((name, i) => ({ type: "tool_use", id: `tu${i}`, name, input: {} }));
  if (content.length === 0) content.push({ type: "text", text: "ok" });
  return JSON.stringify({
    type: "assistant",
    isSidechain,
    message: { role: "assistant", model: synthetic ? "<synthetic>" : model, content },
  });
}

const light = (model) => assistantLine({ model, tools: [] });
const heavy = (model) => assistantLine({ model, tools: ["Edit"] });

function runAdvisor(transcriptPath, cwd) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("ACP_")),
  );
  execFileSync(process.execPath, [ADVISOR], {
    input: JSON.stringify({ transcript_path: transcriptPath, session_id: "test", cwd }),
    env: base,
  });
}

function readAdvice(transcriptPath) {
  try {
    return JSON.parse(readFileSync(advicePath(transcriptPath), "utf8"))?.modelAdvice ?? null;
  } catch {
    return null;
  }
}

// --- Verdict matrix: model (expensive/cheap) × work mode (대화형/작업형) ---

test("expensive × conversational streak -> downgrade recommended", () => {
  const tp = freshTranscriptPath();
  const lines = [heavy("claude-fable-5"), heavy("claude-fable-5"), ...Array.from({ length: 6 }, () => light("claude-fable-5"))];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "expected a verdict");
  assert.equal(advice.model, "claude-fable-5");
  assert.match(advice.text, /\/model sonnet 권장\(대화형 8중 6\)/);
  assert.equal(typeof advice.ts, "number");
});

test("expensive × work streak -> fit(작업형), never a recommendation", () => {
  const tp = freshTranscriptPath();
  const lines = [...Array.from({ length: 5 }, () => heavy("claude-fable-5")), ...Array.from({ length: 3 }, () => light("claude-fable-5"))];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "always-on: a fit verdict is still recorded on an expensive model doing real work");
  assert.equal(advice.model, "claude-fable-5");
  assert.match(advice.text, /모델 적합\(작업형\)/);
  assert.doesNotMatch(advice.text, /권장/);
});

test("cheap × conversational -> fit(대화형)", () => {
  const tp = freshTranscriptPath();
  const lines = Array.from({ length: 8 }, () => light("claude-sonnet-5"));
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "always-on: cheap models still get a fit verdict (never silent)");
  assert.equal(advice.model, "claude-sonnet-5");
  assert.match(advice.text, /모델 적합\(대화형\)/);
  assert.doesNotMatch(advice.text, /권장/);
});

test("cheap × work streak -> fit(작업형)", () => {
  const tp = freshTranscriptPath();
  const lines = [...Array.from({ length: 5 }, () => heavy("claude-sonnet-5")), ...Array.from({ length: 3 }, () => light("claude-sonnet-5"))];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice);
  assert.equal(advice.model, "claude-sonnet-5");
  assert.match(advice.text, /모델 적합\(작업형\)/);
});

// --- Robustness ---

test("window underrun (3 entries) -> no verdict (can't judge)", () => {
  const tp = freshTranscriptPath();
  const lines = Array.from({ length: 3 }, () => light("claude-fable-5"));
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  assert.equal(readAdvice(tp), null);
});

test("isSidechain entries don't pollute the mainline judgment", () => {
  const tp = freshTranscriptPath();
  // Mainline is a pure conversational streak (8 light) -> filtered verdict = 권장.
  // A trailing block of 4 sidechain heavies sits at the tail; a naive impl that
  // doesn't filter isSidechain would count them in its window, drop the light
  // count below threshold, and downgrade the verdict to 적합(작업형). Asserting
  // 권장 makes the filter the thing under test.
  const mainline = Array.from({ length: 8 }, () => light("claude-fable-5"));
  const sidechainTail = Array.from({ length: 4 }, () => assistantLine({ model: "claude-fable-5", tools: ["Edit"], isSidechain: true }));
  const lines = [...mainline, ...sidechainTail];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice);
  assert.equal(advice.model, "claude-fable-5");
  assert.match(advice.text, /권장/, "sidechain noise must not downgrade the mainline verdict");
});

test("trailing <synthetic> entry is ignored, judged by the prior real model", () => {
  const tp = freshTranscriptPath();
  const lines = [heavy("claude-fable-5"), heavy("claude-fable-5"), ...Array.from({ length: 6 }, () => light("claude-fable-5")), assistantLine({ synthetic: true })];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "expected a verdict judged from the last real model");
  assert.equal(advice.model, "claude-fable-5");
  assert.match(advice.text, /권장/);
});

test("broken JSONL lines are skipped without crashing", () => {
  const tp = freshTranscriptPath();
  const goodLines = [heavy("claude-fable-5"), heavy("claude-fable-5"), ...Array.from({ length: 6 }, () => light("claude-fable-5"))];
  const lines = [goodLines[0], "{not valid json", goodLines[1], "", ...goodLines.slice(2)];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "expected a verdict despite broken lines in the tail");
  assert.equal(advice.model, "claude-fable-5");
});

test("config disabled -> no verdict", () => {
  const tp = freshTranscriptPath();
  const lines = Array.from({ length: 8 }, () => light("claude-fable-5"));
  writeFileSync(tp, lines.join("\n") + "\n");

  const cfgDir = join(tmpdir(), "acp-test", `advisor-cfg-${process.pid}-${seq++}`);
  mkdirSync(join(cfgDir, ".claude"), { recursive: true });
  writeFileSync(join(cfgDir, ".claude", "model-guard.json"), JSON.stringify({ disabled: true }));

  runAdvisor(tp, cfgDir);
  assert.equal(readAdvice(tp), null);
});

test("advisor.enabled:false -> no verdict", () => {
  const tp = freshTranscriptPath();
  const lines = Array.from({ length: 8 }, () => light("claude-fable-5"));
  writeFileSync(tp, lines.join("\n") + "\n");

  const cfgDir = join(tmpdir(), "acp-test", `advisor-cfg-${process.pid}-${seq++}`);
  mkdirSync(join(cfgDir, ".claude"), { recursive: true });
  writeFileSync(join(cfgDir, ".claude", "model-guard.json"), JSON.stringify({ advisor: { enabled: false } }));

  runAdvisor(tp, cfgDir);
  assert.equal(readAdvice(tp), null);
});
