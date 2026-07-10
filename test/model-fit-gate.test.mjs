// Red-Green gate for the model-fit criteria (model-advisor).
//
// Ground truth: core/model-guard/gate/model-fit-windows.json — 35 real 12-turn windows sampled
// from 16 sessions, each independently labeled by 3 raters into {구현/설계/단순질문/모호};
// `consensus` is the majority label (14 구현 / 20 설계 / 1 모호, Fleiss κ = 0.926). Each window
// carries the deterministic `features` a hook can compute from the transcript tail.
//
// The gate scores a features->verdict classifier against the human consensus on three boundaries.
// RED (an assertion fails) = the criteria change regressed and must be blocked; GREEN = all pass.
// See core/model-guard/gate/README.md and core/model-guard/docs/model-fit-criteria.md §9.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "core", "model-guard", "gate", "model-fit-windows.json");
const windows = JSON.parse(readFileSync(FIXTURE, "utf8"));

// Option-1 reference classifier — the decision this gate locks in. Route work vs non-work by
// toolShare, and NEVER nag a downgrade on the non-work bucket: the gate corpus showed that bucket
// is ~all 설계 (strong-model-earned) with ~0 detectable 단순질문, so a downgrade there is ~95%
// wrong and ~0% useful. A future criteria change is scored by swapping this function.
const WORK_FLOOR = 0.55;
function classify(features) {
  const work = features.toolShare >= WORK_FLOOR;
  return { mode: work ? "작업형" : "대화형", downgrade: false };
}

const impl = windows.filter((w) => w.consensus === "구현");
const design = windows.filter((w) => w.consensus === "설계");

test("frozen consensus truth: 14 구현 / 20 설계 / 1 모호 (35 windows)", () => {
  assert.equal(windows.length, 35);
  assert.equal(impl.length, 14);
  assert.equal(design.length, 20);
});

test("BOUNDARY 1 — routing: 구현 recall >= 0.95 AND 설계 recall >= 0.85", () => {
  const implRecall = impl.filter((w) => classify(w.features).mode === "작업형").length / impl.length;
  const designRecall = design.filter((w) => classify(w.features).mode === "대화형").length / design.length;
  assert.ok(implRecall >= 0.95, `구현 recall ${implRecall.toFixed(3)} < 0.95 (RED — work misdetected)`);
  assert.ok(designRecall >= 0.85, `설계 recall ${designRecall.toFixed(3)} < 0.85 (RED — routing regressed)`);
});

test("BOUNDARY 2 — §8-d no-nag: <= 1 of the 20 설계 windows gets a downgrade nag", () => {
  const nagged = design.filter((w) => classify(w.features).downgrade).length;
  assert.ok(nagged <= 1, `${nagged}/20 설계 windows nagged a downgrade (RED — the §8-d false-nag returned)`);
});

test("BOUNDARY 3 — do-no-harm: zero downgrades on the non-구현 bucket", () => {
  const nonImpl = windows.filter((w) => w.consensus !== "구현");
  const nags = nonImpl.filter((w) => classify(w.features).downgrade).length;
  assert.equal(nags, 0, `${nags} non-구현 downgrade nags — no 단순질문 exists in truth to justify one`);
});
