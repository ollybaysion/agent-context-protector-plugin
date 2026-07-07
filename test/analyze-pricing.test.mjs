// Regression guard for the lib/pricing.mjs extraction (issue #21 / review f9):
// drive the REAL analyze CLI over a fixture transcript and assert the $ report
// still prices through the shared table — a broken import chain, a renamed
// PRICE_BASIS or a silently edited price row must all turn this red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PRICE_BASIS, priceFor } from "../lib/pricing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ANALYZE = join(here, "..", "core", "analyze", "analyze.mjs");

test("analyze cost report prices via lib/pricing.mjs after the extraction", () => {
  const root = join(tmpdir(), "acp-test", `analyze-${process.pid}-${Date.now()}`);
  const proj = join(root, "-home-user-fixture-proj");
  mkdirSync(proj, { recursive: true });
  const inputTokens = 2_000_000; // fresh input only -> est = 2M/1e6 * input rate
  writeFileSync(
    join(proj, "s1.jsonl"),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_fixture_1",
        model: "claude-fable-5",
        usage: { input_tokens: inputTokens },
        content: [{ type: "text", text: "ok" }],
      },
    }) + "\n",
  );
  const out = execFileSync(process.execPath, [ANALYZE], {
    env: { ...process.env, ACP_ANALYZE_ROOT: root },
    encoding: "utf8",
  });
  assert.ok(out.includes(PRICE_BASIS), "PRICE_BASIS string missing from report");
  const expected = (inputTokens * priceFor("claude-fable-5").input) / 1e6; // $20
  assert.ok(
    out.includes(`$${expected}`),
    `expected $${expected} in:\n` +
      out
        .split("\n")
        .filter((l) => l.includes("$"))
        .join("\n"),
  );
});
