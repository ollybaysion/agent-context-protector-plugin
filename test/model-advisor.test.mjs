// Integration tests for the model-advisor Stop hook: synthetic JSONL
// transcripts drive the REAL script as a subprocess (statusline-hud.test.mjs
// style), and we assert on the advice state file it writes via the same
// advicePath() the statusline HUD reads from.

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

test("light streak (6+ of 8) on an expensive model -> advice recorded", () => {
  const tp = freshTranscriptPath();
  const lines = [heavy("claude-fable-5"), heavy("claude-fable-5"), ...Array.from({ length: 6 }, () => light("claude-fable-5"))];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "expected advice to be recorded");
  assert.equal(advice.model, "claude-fable-5");
  assert.match(advice.text, /\/model sonnet 권장\(8중 6턴 대화형\)/);
  assert.equal(typeof advice.ts, "number");
});

test("heavy session -> advice cleared", () => {
  const tp = freshTranscriptPath();
  const lines = [...Array.from({ length: 5 }, () => heavy("claude-fable-5")), ...Array.from({ length: 3 }, () => light("claude-fable-5"))];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  assert.equal(readAdvice(tp), null);
});

test("non-expensive model (sonnet) -> advice cleared", () => {
  const tp = freshTranscriptPath();
  const lines = Array.from({ length: 8 }, () => light("claude-sonnet-5"));
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  assert.equal(readAdvice(tp), null);
});

test("window underrun (3 entries) -> advice cleared (can't judge)", () => {
  const tp = freshTranscriptPath();
  const lines = Array.from({ length: 3 }, () => light("claude-fable-5"));
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  assert.equal(readAdvice(tp), null);
});

test("isSidechain entries don't pollute the mainline judgment", () => {
  const tp = freshTranscriptPath();
  const sidechainNoise = Array.from({ length: 4 }, () => assistantLine({ model: "claude-fable-5", tools: ["Edit"], isSidechain: true }));
  const mainline = [heavy("claude-fable-5"), heavy("claude-fable-5"), ...Array.from({ length: 6 }, () => light("claude-fable-5"))];
  // Interleave so a naive implementation that doesn't filter isSidechain would
  // see heavy tool calls within its window and wrongly clear the advice.
  const lines = [sidechainNoise[0], mainline[0], sidechainNoise[1], mainline[1], sidechainNoise[2], ...mainline.slice(2), sidechainNoise[3]];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "sidechain noise must not suppress the mainline advice");
  assert.equal(advice.model, "claude-fable-5");
});

test("trailing <synthetic> entry is ignored, judged by the prior real model", () => {
  const tp = freshTranscriptPath();
  const lines = [heavy("claude-fable-5"), heavy("claude-fable-5"), ...Array.from({ length: 6 }, () => light("claude-fable-5")), assistantLine({ synthetic: true })];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "expected advice judged from the last real model");
  assert.equal(advice.model, "claude-fable-5");
});

test("broken JSONL lines are skipped without crashing", () => {
  const tp = freshTranscriptPath();
  const goodLines = [heavy("claude-fable-5"), heavy("claude-fable-5"), ...Array.from({ length: 6 }, () => light("claude-fable-5"))];
  const lines = [goodLines[0], "{not valid json", goodLines[1], "", ...goodLines.slice(2)];
  writeFileSync(tp, lines.join("\n") + "\n");

  runAdvisor(tp, here);
  const advice = readAdvice(tp);
  assert.ok(advice, "expected advice despite broken lines in the tail");
  assert.equal(advice.model, "claude-fable-5");
});

test("config disabled -> advice cleared", () => {
  const tp = freshTranscriptPath();
  const lines = Array.from({ length: 8 }, () => light("claude-fable-5"));
  writeFileSync(tp, lines.join("\n") + "\n");

  const cfgDir = join(tmpdir(), "acp-test", `advisor-cfg-${process.pid}-${seq++}`);
  mkdirSync(join(cfgDir, ".claude"), { recursive: true });
  writeFileSync(join(cfgDir, ".claude", "model-guard.json"), JSON.stringify({ disabled: true }));

  runAdvisor(tp, cfgDir);
  assert.equal(readAdvice(tp), null);
});

test("advisor.enabled:false -> advice cleared", () => {
  const tp = freshTranscriptPath();
  const lines = Array.from({ length: 8 }, () => light("claude-fable-5"));
  writeFileSync(tp, lines.join("\n") + "\n");

  const cfgDir = join(tmpdir(), "acp-test", `advisor-cfg-${process.pid}-${seq++}`);
  mkdirSync(join(cfgDir, ".claude"), { recursive: true });
  writeFileSync(join(cfgDir, ".claude", "model-guard.json"), JSON.stringify({ advisor: { enabled: false } }));

  runAdvisor(tp, cfgDir);
  assert.equal(readAdvice(tp), null);
});
