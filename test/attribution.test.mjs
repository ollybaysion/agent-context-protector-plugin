// Tests for ctx-budget attribution (#8): the scan must fold tool calls into
// pattern families and report a CUMULATIVE token total + CALL COUNT per family,
// biggest first, resetting at each compaction boundary. These drive the real
// streaming scan against temp JSONL transcripts (no hook stdin plumbing).

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { topConsumers } from "../core/ctx-budget/attribution.mjs";

let seq = 0;
function writeTranscript(lines) {
  const dir = join(tmpdir(), "acp-test", `attr-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `t-${seq++}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const toolUse = (id, name, input, extra = {}) =>
  JSON.stringify({
    ...extra,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const toolResult = (id, content, extra = {}) =>
  JSON.stringify({
    ...extra,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
const boundary = () =>
  JSON.stringify({ type: "system", subtype: "compact_boundary" });

// One call = a tool_use line followed by its tool_result line.
function call(id, name, input, resultLen, extra) {
  return [
    toolUse(id, name, input, extra),
    toolResult(id, "x".repeat(resultLen), extra),
  ];
}

test("folds invocations into pattern families with cumulative tokens + counts", async () => {
  const lines = [
    ...call("a1", "Bash", { command: "npm test --verbose" }, 900),
    ...call("a2", "Bash", { command: "npm test -w pkg" }, 900),
    ...call("a3", "Bash", { command: "npm test" }, 900),
    ...call("a4", "Bash", { command: "npm test --coverage" }, 900),
    ...call("b1", "Bash", { command: "git -C /r diff --stat" }, 900),
    ...call("b2", "Bash", { command: "git diff" }, 900),
    ...call("c1", "Read", { file_path: "/a/one.md" }, 200),
    ...call("c2", "Read", { file_path: "/a/two.md" }, 200),
    ...call("c3", "Read", { file_path: "/a/three.md" }, 200),
  ];
  const top = await topConsumers(writeTranscript(lines));

  assert.equal(top.length, 3);
  // Sorted by cumulative chars: npm test (4×900) > git diff (2×900) > Read (3×200).
  assert.deepEqual(
    top.map((t) => [t.label, t.calls]),
    [
      ["npm test", 4],
      ["git diff", 2],
      ["Read(*.md)", 3],
    ],
  );
  assert.ok(top[0].tokens > top[1].tokens && top[1].tokens > top[2].tokens);
});

test("respects topN", async () => {
  const lines = [
    ...call("a1", "Bash", { command: "npm test" }, 900),
    ...call("b1", "Bash", { command: "git diff" }, 500),
    ...call("c1", "Read", { file_path: "/a/x.md" }, 100),
  ];
  const top = await topConsumers(writeTranscript(lines), 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].label, "npm test");
  assert.equal(top[1].label, "git diff");
});

test("resets at a compaction boundary — pre-boundary spend is gone", async () => {
  const lines = [
    ...call("a1", "Bash", { command: "npm test" }, 5000), // dropped by boundary
    boundary(),
    ...call("b1", "Bash", { command: "git diff" }, 400),
  ];
  const top = await topConsumers(writeTranscript(lines));
  assert.equal(top.length, 1);
  assert.equal(top[0].label, "git diff");
});

test("skips sidechain (subagent) entries", async () => {
  const sc = { isSidechain: true };
  const lines = [
    ...call("s1", "Bash", { command: "npm test" }, 5000, sc), // subagent -> ignored
    ...call("m1", "Bash", { command: "git diff" }, 400),
  ];
  const top = await topConsumers(writeTranscript(lines));
  assert.equal(top.length, 1);
  assert.equal(top[0].label, "git diff");
});

test("token math is exact", async () => {
  // input {} -> 2 chars; result 3998 -> total 4000 chars -> 1000 tok.
  const lines = call("w1", "WebFetch", {}, 3998);
  const top = await topConsumers(writeTranscript(lines));
  assert.deepEqual(top, [{ label: "WebFetch", tokens: 1000, calls: 1 }]);
});

test("control chars in a model-supplied label are sanitized", async () => {
  const lines = call("e1", "Bash", { command: "./ev\x1bil.sh --now" }, 40);
  const [item] = await topConsumers(writeTranscript(lines));
  assert.ok(
    !/[\x00-\x1f\x7f]/.test(item.label),
    "no raw control chars in HUD label",
  );
  assert.ok(item.label.startsWith("ev il.sh"));
});
