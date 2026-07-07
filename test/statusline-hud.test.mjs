// Integration test for the always-on HUD showing the top-N consumers (not just
// the leader), including BELOW the /compact threshold. The real bug surface is
// the ctx-budget -> statusline state contract: ctx-budget must cache the full
// list under `tops` on every tier crossing, and statusline must read it back
// from the same per-transcript state path and render all of them. So this drives
// BOTH real scripts as subprocesses rather than unit-testing an extracted
// function — it verifies the handoff end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CTX = join(here, "..", "core", "ctx-budget", "ctx-budget.mjs");
const HUD = join(here, "..", "core", "ctx-budget", "statusline.mjs");
const WINDOW = 10000;

let seq = 0;
function transcriptPath() {
  const dir = join(tmpdir(), "acp-test", `hud-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `t-${seq++}.jsonl`);
}

const use = (id, name, input) =>
  JSON.stringify({ message: { content: [{ type: "tool_use", id, name, input }] } });
const res = (id, n) =>
  JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(n) }] } });

// Fire ctx-budget on a fresh transcript whose current context = `contextTokens`
// (so the pct = contextTokens/WINDOW picks the tier), then render the statusline
// against the same transcript. Returns { alert, hud } — alert is ctx-budget's
// emitted systemMessage, hud is the statusline line.
function run({ topN, contextTokens = 8000 } = {}) {
  const tp = transcriptPath();
  const lines = [
    use("a1", "Bash", { command: "npm test --verbose" }), res("a1", 1200),
    use("a2", "Bash", { command: "npm test" }), res("a2", 1200),
    use("b1", "Bash", { command: "git diff" }), res("b1", 800),
    use("c1", "Read", { file_path: "/a/x.md" }), res("c1", 300),
    JSON.stringify({ message: { usage: { input_tokens: contextTokens }, content: [{ type: "text", text: "ok" }] } }),
  ];
  writeFileSync(tp, lines.join("\n") + "\n");

  const env = { ...process.env, ACP_CTX_BUDGET_WINDOW: String(WINDOW) };
  if (topN != null) env.ACP_CTX_BUDGET_TOP_N = String(topN);

  const ctxOut = execFileSync("node", [CTX], {
    input: JSON.stringify({ transcript_path: tp, tool_name: "Read", tool_input: {}, tool_response: {} }),
    env,
  }).toString();
  const alert = ctxOut ? JSON.parse(ctxOut).systemMessage ?? "" : "";

  const hud = execFileSync("node", [HUD], {
    input: JSON.stringify({ transcript_path: tp, context_window: { used_percentage: Math.round((contextTokens / WINDOW) * 100) } }),
    env,
  })
    .toString()
    .trim();
  return { alert, hud };
}

test("HUD shows all three top consumers, and >=50% the alert lists them inline", () => {
  const { alert, hud } = run({ contextTokens: 8000 }); // 80%
  // HUD
  for (const fam of ["npm test", "git diff", "Read(*.md)"]) assert.ok(hud.includes(fam), hud);
  const tail = hud.slice(hud.indexOf("top "));
  assert.ok((tail.match(/·/g) || []).length >= 2, `expected 3 consumers: ${tail}`);
  // Alert text (>=50%): /compact rec + inline attribution
  assert.match(alert, /컨텍스트 80%/);
  assert.ok(alert.includes("/compact 권장"), alert);
  assert.ok(alert.includes("상위 소비"), alert);
});

test("below 50% the HUD still shows consumers, but the alert stays quiet about them", () => {
  const { alert, hud } = run({ contextTokens: 3000 }); // 30% — below COMPACT_PCT
  // HUD is populated below the /compact threshold (the point of this change).
  for (const fam of ["npm test", "git diff", "Read(*.md)"]) assert.ok(hud.includes(fam), hud);
  // Alert fires the tier line but must NOT recommend /compact or list consumers.
  assert.match(alert, /컨텍스트 30%/);
  assert.ok(!alert.includes("/compact"), alert);
  assert.ok(!alert.includes("상위 소비"), alert);
});

test("ACP_CTX_BUDGET_TOP_N caps how many consumers the HUD keeps", () => {
  const { hud } = run({ topN: 1 });
  assert.ok(hud.includes("npm test"), hud); // the leader survives
  assert.ok(!hud.includes("git diff"), hud); // capped out
  assert.ok(!hud.includes("Read(*.md)"), hud);
});

test("HUD stays silent when no attribution has been cached yet", () => {
  // A transcript that never triggered a tier crossing -> no state -> no top seg.
  const tp = transcriptPath();
  writeFileSync(tp, "");
  const hud = execFileSync("node", [HUD], {
    input: JSON.stringify({ transcript_path: tp, context_window: { used_percentage: 5 } }),
    env: process.env,
  })
    .toString()
    .trim();
  assert.equal(hud.includes("top "), false, hud);
  assert.match(hud, /ctx 5%/);
});
