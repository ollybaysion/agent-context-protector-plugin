#!/usr/bin/env node
// model-advisor (Stop): on every turn, judge whether the current model fits
// the recent work and record an ALWAYS-ON verdict for the statusline HUD to
// render (core/ctx-budget/statusline.mjs readModelAdvice) -- "모델 적합(...)"
// when the model is fine, "⚠ /model sonnet 권장(...)" only in the one case
// worth flagging: an expensive model (Fable/Opus) running a conversational
// streak. Budget-only, so it only ever recommends a DOWNGRADE; judging that a
// cheap model is under-powered (upgrade) is out of scope -- that's analyze
// model-fit's job (#22). This hook cannot change the running session -- the
// main model has no programmatic override (unlike subagent spawns), so all it
// can do is write an advisory the status bar picks up. Deterministic only: no
// LLM calls, and never exit 2 -- on Stop that means "keep working", which this
// module must never trigger.
//
// Cost is deliberately asymmetric with the statusline hot path (DESIGN.md
// §4.1): Stop runs once per turn and can afford the ~256KB transcript
// tail-read + turn-shape analysis; statusline just re-validates the
// already-computed verdict on every render.
//
// Every Stop re-evaluates from scratch, so a heavy turn clears the advice on
// its own next Stop -- no cooldown ledger needed.

import { readHookInput, pass, failOpen } from "../../lib/hook-io.mjs";
import { loadConfig } from "./lib/config.mjs";
import { readTail, analyzeTurns } from "./lib/transcript.mjs";
import { saveAdvice } from "./lib/state.mjs";

function sanitize(text) {
  return text.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
}

try {
  const input = await readHookInput();
  const transcriptPath = input?.transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath === "") pass();

  const cfg = loadConfig(input?.cwd);
  if (cfg.disabled || !cfg.advisor.enabled) {
    saveAdvice(transcriptPath, null);
    pass();
  }

  const { window, threshold, expensive, target } = cfg.advisor;
  const { ok, model, perTurn } = analyzeTurns(readTail(transcriptPath), window);

  if (!ok) {
    saveAdvice(transcriptPath, null); // window underrun -> can't judge -> no segment
    pass();
  }

  // Always write a verdict (the segment is always-on): "적합" unless the one
  // flaggable case holds -- an expensive model on a conversational streak, the
  // only cell that recommends a downgrade.
  const light = perTurn.filter((t) => t.toolCalls <= 1 && !t.heavyTools).length;
  const isExpensive = expensive.some((e) => (model ?? "").includes(e));
  const mode = light >= threshold ? "대화형" : "작업형";

  const text =
    isExpensive && light >= threshold
      ? sanitize(`⚠ /model ${target} 권장(${mode} ${window}중 ${light})`)
      : sanitize(`모델 적합(${mode})`);

  saveAdvice(transcriptPath, { text, model, ts: Date.now() });
  pass();
} catch (err) {
  failOpen(`[model-guard] internal error, skipping: ${err?.message ?? err}`);
}
