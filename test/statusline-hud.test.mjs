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
function run({ topN, contextTokens = 8000, model = "claude-fable-5" } = {}) {
  const tp = transcriptPath();
  const lines = [
    use("a1", "Bash", { command: "npm test --verbose" }), res("a1", 1200),
    use("a2", "Bash", { command: "npm test" }), res("a2", 1200),
    use("b1", "Bash", { command: "git diff" }), res("b1", 800),
    use("c1", "Read", { file_path: "/a/x.md" }), res("c1", 300),
    JSON.stringify({ message: { model, usage: { input_tokens: contextTokens }, content: [{ type: "text", text: "ok" }] } }),
  ];
  writeFileSync(tp, lines.join("\n") + "\n");

  // Pin the nudge-ledger dir even though these Read-only fixtures can never
  // reach a boundary today: this file spawns the REAL ctx-budget.mjs, so a
  // future Bash fixture here would otherwise write to the real persistent
  // ledger (issue #31 — same pin as ctx-budget-nudge.test.mjs).
  const env = {
    ...process.env,
    ACP_CTX_BUDGET_WINDOW: String(WINDOW),
    ACP_CTX_BUDGET_DATA_DIR: join(tmpdir(), "acp-test", `hud-data-${process.pid}`),
  };
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

test("HUD shows the LEADER as per-turn rent + turn/compact costs; the alert lists all three", () => {
  const { alert, hud } = run({ contextTokens: 8000 }); // 80%
  // HUD: leader only, priced as per-turn rent — the bar is width-constrained.
  assert.ok(hud.includes("npm test"), hud);
  assert.ok(!hud.includes("git diff"), `HUD is leader-only: ${hud}`);
  assert.ok(!hud.includes("Read(*.md)"), `HUD is leader-only: ${hud}`);
  const tail = hud.slice(hud.indexOf("top "));
  assert.ok(/\/turn/.test(tail), `leader should be per-turn $ rent: ${tail}`);
  // Advisory at 80% is the urgent tier, and carries the one-time compact $.
  assert.ok(hud.includes("/compact 권장"), hud);
  assert.ok(hud.includes("곧 자동압축"), hud);
  assert.match(hud, /\/compact 권장.*\(\$[\d.]+\)/, hud); // inline compact cost
  assert.match(hud, /~\$[\d.]+\/turn/, hud); // whole-context per-turn cost segment
  // Alert text (>=COMPACT_PCT): /compact rec + the FULL top-N attribution.
  assert.match(alert, /컨텍스트 80%/);
  assert.ok(alert.includes("/compact 권장"), alert);
  assert.ok(alert.includes("상위 소비"), alert);
  for (const fam of ["npm test", "git diff", "Read(*.md)"]) assert.ok(alert.includes(fam), alert);
});

test("below the recommend gate the HUD advises '고려' (not 권장) and stays priced", () => {
  const { alert, hud } = run({ contextTokens: 3000 }); // 30% — advise tier
  assert.ok(hud.includes("npm test"), hud); // leader present
  assert.ok(hud.includes("/compact 고려"), hud); // size-based, non-mandatory
  assert.ok(!hud.includes("권장"), hud); // not yet the recommend tier
  assert.match(hud, /\(\$[\d.]+\)/, hud); // compact cost still shown
  assert.match(hud, /~\$[\d.]+\/turn/, hud);
  // Alert fires the tier line but must NOT recommend /compact or list consumers
  // (the HOOK's COMPACT_PCT gate is unchanged at 50%).
  assert.match(alert, /컨텍스트 30%/);
  assert.ok(!alert.includes("/compact"), alert);
  assert.ok(!alert.includes("상위 소비"), alert);
});

test("unpriced model: consumers fall back to token estimates, no $ anywhere", () => {
  const { hud } = run({ contextTokens: 8000, model: "<synthetic>" });
  assert.ok(hud.includes("npm test"), hud);
  assert.ok(/~[\d.]+k? tok/.test(hud), `token estimate fallback: ${hud}`);
  assert.ok(!hud.includes("$"), `no $ for unpriced model: ${hud}`);
  assert.ok(!hud.includes("/turn"), hud);
  assert.ok(hud.includes("/compact 권장"), hud); // advisory still fires, sans cost
});

test("ACP_CTX_BUDGET_TOP_N caps how many consumers the alert lists", () => {
  const { alert, hud } = run({ topN: 1 }); // 80% -> alert carries 상위 소비
  assert.ok(hud.includes("npm test"), hud); // the leader survives in the HUD
  assert.ok(alert.includes("npm test"), alert);
  assert.ok(!alert.includes("git diff"), alert); // capped out of the alert list
  assert.ok(!alert.includes("Read(*.md)"), alert);
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

test("compaction clears the stale cache, then the HUD repopulates from post-boundary work", () => {
  const tp = transcriptPath();
  const pre = [
    use("a1", "Bash", { command: "npm test" }), res("a1", 1200),
    use("b1", "Bash", { command: "git diff" }), res("b1", 800),
  ];
  const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary" });
  const usage = (t) => JSON.stringify({ message: { usage: { input_tokens: t }, content: [{ type: "text", text: "ok" }] } });
  const env = {
    ...process.env,
    ACP_CTX_BUDGET_WINDOW: String(WINDOW),
    ACP_CTX_BUDGET_STEP: "10",
    // same ledger-sandbox pin as run() — this spawns the real ctx-budget.mjs
    ACP_CTX_BUDGET_DATA_DIR: join(tmpdir(), "acp-test", `hud-data-${process.pid}`),
  };
  const fireCtx = () => execFileSync("node", [CTX], {
    input: JSON.stringify({ transcript_path: tp, tool_name: "Read", tool_input: {}, tool_response: {} }),
    env,
  });
  const hudAt = (pct) => execFileSync("node", [HUD], {
    input: JSON.stringify({ transcript_path: tp, context_window: { used_percentage: pct } }),
    env,
  }).toString().trim();

  // 1) high usage -> caches pre-boundary tops, lastTier high
  writeFileSync(tp, [...pre, usage(8000)].join("\n") + "\n"); // 80%
  fireCtx();
  assert.ok(hudAt(80).includes("npm test"), "precondition: HUD should show consumers");

  // 2) compaction: a real transcript inserts a compact_boundary and usage drops.
  //    The pre-boundary consumers leave context, so the cache must clear; with no
  //    NEW tool calls after the boundary yet, the repopulate finds nothing and
  //    the HUD goes blank (not the stale pre-compaction list).
  writeFileSync(tp, [...pre, boundary, usage(2000)].join("\n") + "\n"); // 20% < lastTier 80
  fireCtx();
  assert.equal(hudAt(20).includes("top "), false, "blank right after compaction");

  // 3) new work after the boundary, still inside the SAME tier band (no upward
  //    crossing). The time-based refresh must repopulate the HUD with the new
  //    post-boundary consumer — and not resurrect the pre-boundary ones.
  const post = [use("c1", "Read", { file_path: "/z/notes.md" }), res("c1", 2000)];
  writeFileSync(tp, [...pre, boundary, ...post, usage(2100)].join("\n") + "\n"); // 21%, tier still 20
  fireCtx();
  const h = hudAt(21);
  assert.ok(h.includes("Read(*.md)"), `post-boundary consumer should show: ${h}`);
  assert.ok(!h.includes("npm test"), `pre-boundary consumer must stay gone: ${h}`);
});

test("HUD populates without a tier crossing (fresh cache, usage below the first tier)", () => {
  // The gap the time-based refresh closes: usage sits below the first crossing
  // (tier 0, nothing has ever crossed), so the old crossing-only cache never
  // filled and the HUD stayed blank. Now an ordinary tool call tops it up.
  const tp = transcriptPath();
  writeFileSync(tp, [
    use("a1", "Bash", { command: "npm test" }), res("a1", 1200),
    JSON.stringify({ message: { usage: { input_tokens: 500 }, content: [{ type: "text", text: "ok" }] } }), // 5%
  ].join("\n") + "\n");
  const env = {
    ...process.env,
    ACP_CTX_BUDGET_WINDOW: String(WINDOW),
    ACP_CTX_BUDGET_STEP: "10",
    // same ledger-sandbox pin as run() — this spawns the real ctx-budget.mjs
    ACP_CTX_BUDGET_DATA_DIR: join(tmpdir(), "acp-test", `hud-data-${process.pid}`),
  };
  execFileSync("node", [CTX], {
    input: JSON.stringify({ transcript_path: tp, tool_name: "Read", tool_input: {}, tool_response: {} }),
    env,
  });
  const hud = execFileSync("node", [HUD], {
    input: JSON.stringify({ transcript_path: tp, context_window: { used_percentage: 5 } }),
    env,
  }).toString().trim();
  assert.ok(hud.includes("npm test"), `populated with no crossing, well below COMPACT_PCT: ${hud}`);
});
