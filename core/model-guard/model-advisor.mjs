#!/usr/bin/env node
// model-advisor (Stop): judge whether the main session is running an
// expensive model (Fable/Opus by default) through a conversational-only
// streak, and record the verdict for the statusline HUD to render as an
// always-on segment (core/ctx-budget/statusline.mjs readModelAdvice). This
// hook cannot change the running session -- the main model has no
// programmatic override (unlike subagent spawns), so all it can do is write
// an advisory the status bar picks up. Deterministic only: no LLM calls, and
// never exit 2 -- on Stop that means "keep working", which this module must
// never trigger.
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
    saveAdvice(transcriptPath, null); // window underrun -> can't judge -> clear
    pass();
  }

  const light = perTurn.filter((t) => t.toolCalls <= 1 && !t.heavyTools).length;
  const isExpensive = expensive.some((e) => (model ?? "").includes(e));

  if (!(isExpensive && light >= threshold)) {
    saveAdvice(transcriptPath, null);
    pass();
  }

  const text = sanitize(`/model ${target} 권장(${window}중 ${light}턴 대화형)`);
  saveAdvice(transcriptPath, { text, model, ts: Date.now() });
  pass();
} catch (err) {
  failOpen(`[model-guard] internal error, skipping: ${err?.message ?? err}`);
}
