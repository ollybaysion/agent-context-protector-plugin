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
// The one extra bit is the top context consumers, which Claude Code does NOT
// provide: ctx-budget caches them (the ACP_CTX_BUDGET_TOP_N pattern families,
// default 3) into its per-transcript state file on every 10% tier crossing (so
// they show below the /compact threshold too), and we read them back here by
// reproducing the same state path from transcript_path. The consumers segment
// is rendered LAST, so if the bar is too narrow and truncates, the ctx
// %/advisory ahead of it survive.
//
// Fail-open is absolute: any parse/read error prints an empty line and exits 0.
// A blank status line is the safe degradation — never crash the user's bar.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

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

// Compaction advisory thresholds. Share ACP_CTX_BUDGET_COMPACT_PCT with the
// ctx-budget hook so the always-on HUD and the tier alerts agree on when
// /compact starts being worth it; URGENT_PCT is HUD-only (default wording
// "곧 자동 압축" assumes Claude Code auto-compacts near the top of the window).
function positiveEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const COMPACT_PCT = positiveEnv("ACP_CTX_BUDGET_COMPACT_PCT", 50);
const URGENT_PCT = positiveEnv("ACP_CTX_BUDGET_URGENT_PCT", 80);

// Always-on /compact recommendation keyed off the live context %. The reason in
// parentheses is the whole point of this segment — it says WHY now (or why not),
// so the advisory persists in the bar instead of scrolling away like the hook's
// one-shot systemMessage. Wording ("절반 넘음") assumes the default 50% gate.
function recommend(pct) {
  if (pct >= URGENT_PCT) return "/compact 권장(곧 자동 압축)";
  if (pct >= COMPACT_PCT) return "/compact 권장(절반 넘음)";
  return "여유(컴팩트 불필요)";
}

function pctInt(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.round(v)
    : null;
}

function readTop(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
  try {
    const s = JSON.parse(readFileSync(statePath(transcriptPath), "utf8"));
    if (!s) return null;
    if (typeof s.topTs === "number" && Date.now() - s.topTs > TOP_MAX_AGE_MS)
      return null;
    // `tops` (full list) is what the HUD renders; fall back to the legacy `top`
    // leader for state written by a pre-top3 release still live in this session.
    if (Array.isArray(s.tops)) {
      const items = s.tops.filter((x) => typeof x === "string" && x !== "");
      if (items.length > 0) return items.join(" · ");
    }
    if (typeof s.top === "string" && s.top !== "") return s.top;
    return null;
  } catch {
    return null; // missing/corrupt state -> no top segment
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

  const segments = [];
  const ctx = pctInt(input?.context_window?.used_percentage);
  if (ctx !== null) {
    segments.push(`ctx ${ctx}%`);
    segments.push(recommend(ctx)); // always-on advisory whenever ctx% is known
  }

  const h5 = pctInt(input?.rate_limits?.five_hour?.used_percentage);
  if (h5 !== null) segments.push(`5h ${h5}%`);

  const d7 = pctInt(input?.rate_limits?.seven_day?.used_percentage);
  if (d7 !== null) segments.push(`7d ${d7}%`);

  const top = readTop(input?.transcript_path);
  if (top) segments.push(`top ${top}`);

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
