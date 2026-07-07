// Unit tests for lib/pricing.mjs — the single price source shared by analyze
// (cost reports), ctx-budget nudges (costSegment), and the statusline HUD
// (per-turn rent + turn cost). analyze-pricing.test.mjs covers the analyze
// integration; these pin the resolver + the HUD helpers directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFor, fmtUsd, CACHE_READ_MULT } from "../lib/pricing.mjs";

test("priceFor: longest-prefix match, dated ids, and unpriced", () => {
  assert.deepEqual(priceFor("claude-fable-5"), { input: 10, output: 50 });
  // dated full id resolves via its alias prefix row
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), { input: 1, output: 5 });
  assert.deepEqual(priceFor("claude-opus-4-8"), { input: 5, output: 25 });
  // unknown / empty / non-string -> null (never guessed)
  assert.equal(priceFor("<synthetic>"), null);
  assert.equal(priceFor(""), null);
  assert.equal(priceFor(undefined), null);
});

test("fmtUsd: fine granularity for small rents, null for non-numbers", () => {
  assert.equal(fmtUsd(0.008), "$0.008"); // 3 decimals under $0.10
  assert.equal(fmtUsd(0.24), "$0.24"); // 2 decimals under $10
  assert.equal(fmtUsd(1.2), "$1.20");
  assert.equal(fmtUsd(42), "$42.0"); // 1 decimal at/above $10
  assert.equal(fmtUsd(0), "$0.000");
  assert.equal(fmtUsd(NaN), null);
  assert.equal(fmtUsd(-1), null);
  assert.equal(fmtUsd("x"), null);
});

test("CACHE_READ_MULT is the 0.1x warm re-read rate (matches costSegment's inline 0.1)", () => {
  assert.equal(CACHE_READ_MULT, 0.1);
});
