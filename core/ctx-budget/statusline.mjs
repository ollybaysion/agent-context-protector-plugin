#!/usr/bin/env node
// ctx-budget statusline HUD: an always-visible one-liner for the Claude Code
// status bar. NOT a hook — Claude Code invokes it via the user's settings.json
// `statusLine` command (see README), passing the statusline JSON on stdin.
//
// It reads only pre-calculated fields Claude Code already computes, so it does
// NO transcript parsing on the hot render path:
//   context_window.used_percentage        -> ctx %
//   rate_limits.five_hour.used_percentage -> 5h session-quota %
//   rate_limits.seven_day.used_percentage -> 7d weekly-quota %
// The extra bits Claude Code does NOT provide come from ctx-budget's per-
// transcript state file (written on tier crossings + a throttled refresh, read
// back here by reproducing the same state path from transcript_path):
//   - the LEADING consumer, as a per-CALL $ "rent" (what re-sending that pattern
//     family bills on each assistant API call) — or a bare token estimate when
//     the model is unpriced. Leader only (the full top-N list lives in the >=50%
//     alerts); rendered LAST so a narrow bar truncates it, not the ctx
//     %/advisory ahead of it.
//   - callCost / compactCost: the whole-context per-call re-read cost and the
//     one-time cost of compacting now. The compact cost rides inline with the
//     advisory ("/compact 고려 ($0.4)"); the call cost is its own segment
//     ("~$0.24/call").
//
// Fail-open is absolute: any parse/read error prints an empty line and exits 0.
// A blank status line is the safe degradation — never crash the user's bar.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fmtUsd } from "../../lib/pricing.mjs";

// CONTRACT: must match statePath() in ctx-budget.mjs exactly, or the HUD reads
// the wrong file and silently shows no top consumer.
function statePath(transcriptPath) {
  const h = createHash("sha1")
    .update(transcriptPath)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), "acp", "ctx-budget", `${h}.json`);
}

// Cached top consumer goes stale between alerts; drop it once it's older than
// this so the HUD never shows an ancient attribution. Generous because it's a
// per-session (per-transcript) file that ctx-budget clears on compaction.
const TOP_MAX_AGE_MS = 60 * 60 * 1000;

// Size-based /compact advisory thresholds (ctx %). Calibrated on 41 real 1M-
// window sessions: peaks are bottom-heavy (p50≈16%, p75≈36%, max≈66%), so the
// old 50% gate fired in only ~17% of them. These cover ~top-75%: ADVISE≈8% first
// nudges (~70% of sessions reach it), RECOMMEND≈35% is a genuinely big session
// (~top quartile), URGENT≈70% is near where Claude Code auto-compacts. Wording is
// size-based and non-mandatory ("고려"→"권장") — the compact $ rides alongside.

// Same staleness idea for model-guard's advisory: if the user stepped away
// long enough that Stop hasn't re-judged in a while, don't keep recommending
// a possibly-outdated model switch.
const ADVICE_MAX_AGE_MS = positiveEnv("ACP_MODEL_ADVICE_MAX_AGE_MS", 60 * 60 * 1000);

// CONTRACT: must match advicePath() in core/model-guard/lib/state.mjs, or the
// HUD reads the wrong file and silently shows no advice segment.
function advicePath(transcriptPath) {
  const h = createHash("sha1").update(transcriptPath).digest("hex").slice(0, 16);
  return join(tmpdir(), "acp", "model-guard", `${h}.json`);
}

// Read the already-decided model-advice verdict (model-advisor.mjs, Stop
// hook) and re-validate it with 3 cheap checks -- no transcript parsing, no
// config load here (hot-path no-I/O rule, DESIGN.md §4.1):
//   ① exists  ② fresh  ③ self-erase: the live model has moved on from the one
//   the advice was judged against (e.g. right after `/model sonnet`), so drop
//   it immediately instead of waiting for the next Stop to notice.
// `liveModelId` absent (older Claude Code, no `model.id` on stdin) -> skip ③
// and let the next Stop's re-judgment clear it instead (one-turn lag).
//
// ③ compares NORMALIZED ids. statusline stdin reports the 1M variant with a
// trailing marker (`claude-opus-4-8[1m]`, live-captured) while the transcript
// records the bare id (`claude-opus-4-8`) the advice was written with, so a raw
// `!==` self-erases forever on `[1m]` sessions. Stripping the trailing `[...]`
// marker off both sides fixes the false erase while a genuine switch (opus ->
// sonnet) still erases, since the base ids differ.
const normModelId = (m) => (typeof m === "string" ? m.replace(/\[[^\]]*\]$/, "") : m);

function readModelAdvice(transcriptPath, liveModelId) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
  try {
    const a = JSON.parse(readFileSync(advicePath(transcriptPath), "utf8"))?.modelAdvice;
    if (!a || typeof a.text !== "string" || a.text === "") return null; // ① exists
    if (typeof a.ts !== "number" || Date.now() - a.ts > ADVICE_MAX_AGE_MS)
      return null; // ② fresh
    if (typeof liveModelId === "string" && normModelId(liveModelId) !== normModelId(a.model))
      return null; // ③ self-erase (normalized; see above)
    return a.text;
  } catch {
    return null; // missing/corrupt state -> no segment
  }
}
function positiveEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const ADVISE_PCT = positiveEnv("ACP_CTX_BUDGET_ADVISE_PCT", 8);
const RECOMMEND_PCT = positiveEnv("ACP_CTX_BUDGET_RECOMMEND_PCT", 35);
const URGENT_PCT = positiveEnv("ACP_CTX_BUDGET_URGENT_PCT", 70);

// The cached compactCost is nudge.mjs costSegment's estUsd — already rounded to
// its display rule (1 decimal, 2 below $0.095). Re-apply the same rule here so
// the HUD and the boundary nudge quote the SAME price for the same action
// (fmtUsd's finer grid would render $0.2 as $0.20 and diverge from the nudge).
const fmtCompactUsd = (n) => `$${n < 0.095 ? n.toFixed(2) : n.toFixed(1)}`;

// Always-on advisory keyed off the LIVE context %. The one-time compact cost (if
// cached & priced) rides in parens — "spend this once" — paired across the bar
// with each consumer's per-call rent ("keep paying this"). Below ADVISE_PCT the
// session is small enough that compaction isn't worth mentioning.
function recommend(pct, compactCost) {
  const c = compactCost != null ? ` (${fmtCompactUsd(compactCost)})` : "";
  if (pct >= URGENT_PCT) return `/compact 권장 · 곧 자동압축${c}`;
  if (pct >= RECOMMEND_PCT) return `/compact 권장${c}`;
  if (pct >= ADVISE_PCT) return `/compact 고려${c}`;
  return "여유";
}

function pctInt(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.round(v)
    : null;
}

const EMPTY_HUD = { topStr: null, callCost: null, compactCost: null };

// Read ctx-budget's cached HUD state: the top-consumer string plus the whole-
// context call/compact costs. All three are gated on ONE freshness stamp
// (topTs) because ctx-budget writes them together — a missing/stale stamp means
// stale or foreign state, so we trust none of it (the HUD self-heals).
function readHud(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "")
    return EMPTY_HUD;
  try {
    const s = JSON.parse(readFileSync(statePath(transcriptPath), "utf8"));
    if (!s) return EMPTY_HUD;
    if (typeof s.topTs !== "number" || Date.now() - s.topTs > TOP_MAX_AGE_MS)
      return EMPTY_HUD;
    // The HUD renders the LEADER only — one consumer is enough to answer "what
    // is filling the window" at a glance, and the bar is width-constrained now
    // that the cost segments ride ahead of it. The full top-N list still
    // surfaces in the >=50% tier alerts (ctx-budget caches it under `tops`).
    let topStr = null;
    if (typeof s.top === "string" && s.top !== "") topStr = s.top;
    if (!topStr && Array.isArray(s.tops)) {
      const items = s.tops.filter((x) => typeof x === "string" && x !== "");
      if (items.length > 0) topStr = items[0];
    }
    const numOrNull = (v) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    return {
      topStr,
      callCost: numOrNull(s.callCost),
      compactCost: numOrNull(s.compactCost),
    };
  } catch {
    return EMPTY_HUD; // missing/corrupt state -> no HUD extras
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const hud = readHud(input?.transcript_path);
  const segments = [];
  const ctx = pctInt(input?.context_window?.used_percentage);
  if (ctx !== null) {
    segments.push(`ctx ${ctx}%`);
    // always-on advisory (+ inline one-time compact $ when cached) keyed off ctx%
    segments.push(recommend(ctx, hud.compactCost));
  }
  // whole-context per-call re-read cost: what each assistant API call currently
  // bills just to re-send the context. Right after the advisory, both being
  // "should I compact?" signals.
  if (hud.callCost != null) segments.push(`~${fmtUsd(hud.callCost)}/call`);

  const h5 = pctInt(input?.rate_limits?.five_hour?.used_percentage);
  if (h5 !== null) segments.push(`5h ${h5}%`);

  const d7 = pctInt(input?.rate_limits?.seven_day?.used_percentage);
  if (d7 !== null) segments.push(`7d ${d7}%`);

  // Pushed BEFORE `top` so a too-narrow bar truncates the consumer list first,
  // not this advisory.
  const advice = readModelAdvice(input?.transcript_path, input?.model?.id);
  if (advice) segments.push(advice);

  if (hud.topStr) segments.push(`top ${hud.topStr}`);

  // Nothing to show (e.g. an older Claude Code without these fields) -> stay
  // silent rather than print a bare prefix. Defensive control-char strip at the
  // single output choke point: the cached `top` is model-derived, and a stray
  // newline/ESC here would split or hijack the status bar (ctx-budget already
  // sanitizes, but the HUD must not trust state written by any other version).
  const line = segments.length ? segments.join(" · ") : "";
  process.stdout.write(line.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim());
} catch {
  process.stdout.write(""); // fail-open: blank line, never crash the status bar
}
