// core/analyze/nudge-report.mjs — ctx-budget nudge compliance report (#29).
//
// Reads the persistent nudge ledger (nudges.jsonl, issue #31) and matches each
// fired nudge against its transcript: did a MANUAL /compact follow inside the
// compliance window? The verdict logic lives here and ONLY here — the
// dashboard collector stores/aggregates NudgeOutcome events but never
// re-derives them (issue #32 §6: acp is the single source of truth).
//
// Compliance window (issue #29, design baseline v2.1 §계측):
//   from the nudge's byteOffset (file size at fire time), whichever ends first:
//     - 10 main-chain assistant turns (distinct message.id, sidechains excluded)
//     - 15 minutes (entry timestamp - nudge ts)
//     - the NEXT nudge in the same transcript (early close — the later nudge
//       owns any compact that follows it)
//   complied = a compact_boundary with compactMetadata.trigger === "manual"
//   inside that window. Auto/micro compactions carry no trigger:"manual" and
//   never count.
//
// Base rate: manual compacts also happen without a nudge (the statusline
// advisory and tier alerts recommend /compact too), so raw compliance is an
// upper bound. baseRateWindow = P(manual compact in a random nudge-free
// 10-turn stretch), estimated over the SAME matched transcripts:
//   (manual compacts outside every nudge window) / (main-chain turns outside
//   every nudge window) x 10, clamped to [0,1]. The kill/L2 gates judge the
//   base-rate-SUBTRACTED rate.
//
// keep-audit (n1 tripwire): for complied nudges that carried a keepLabel, a
// LATER ledger row in the same transcript whose dropLabel names the same ref
// (normalizeRef) within 30 minutes means the "keep" pointed at work that was
// actually finishing — one confirmed case is a lifetime-rule defect (issue
// #21). Heuristic evidence, not proof: it only sees completions the boundary
// rules captured.
//
// This module does its own streaming I/O (offset reads over a handful of
// matched transcripts); judgment itself is pure and unit-tested
// (judgeTranscriptNudges).

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { ledgerDir, normalizeRef } from "../ctx-budget/nudge.mjs";
import { postEnvelope, sourceApp } from "../../lib/obs-client.mjs";

export const WINDOW_TURNS = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const KEEP_AUDIT_MS = 30 * 60 * 1000;
export const KILL_N = 20; // judge only at >=20 outcomes …
export const KILL_DAYS = 30; // … or a >=30-day ledger span (issue #21 criteria)

// ---- ledger -------------------------------------------------------------------

/** sha1(path) first 16 hex chars — MUST mirror ctx-budget.mjs transcriptHash. */
export function transcriptHash16(transcriptPath) {
  return createHash("sha1").update(transcriptPath).digest("hex").slice(0, 16);
}

/** Load nudges.jsonl rows, tolerant of trailing garbage (fail open: a broken
 *  line loses one sample, never the report). Returns [] when the ledger is
 *  missing. `since` (ms) filters old rows out. */
export function loadLedger(dir, since = null) {
  let raw;
  try {
    raw = readFileSync(join(dir, "nudges.jsonl"), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && typeof e.ts === "number" && e.transcriptHash) {
        if (since === null || e.ts >= since) rows.push(e);
      }
    } catch {
      // tolerate — measurement data may be hand-edited or torn mid-append
    }
  }
  return rows;
}

// ---- transcript scan ------------------------------------------------------------

/** Stream one transcript into the minimal event list judgment needs:
 *  { off, ts, kind: "turn"|"manual", mid }  (byte offset of line start, entry
 *  timestamp in ms, main-chain assistant turn or manual compact_boundary).
 *  Torn/unparseable lines are skipped — same fail-open posture as the ledger. */
export async function scanTranscriptEvents(path) {
  const events = [];
  const stream = createReadStream(path);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let off = 0;
  for await (const line of rl) {
    const lineOff = off;
    off += Buffer.byteLength(line, "utf8") + 1; // +1 for the \n readline ate
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (e.type === "assistant" && e.isSidechain !== true) {
      events.push({
        off: lineOff,
        ts,
        kind: "turn",
        // one API response spans several lines sharing message.id — a "turn"
        // is the distinct id (PR #12 dedup precedent); fall back to the line
        // uuid so id-less entries still count once each
        mid: e.message?.id ?? e.uuid ?? `line:${lineOff}`,
      });
    } else if (
      e.type === "system" &&
      e.subtype === "compact_boundary" &&
      e.compactMetadata?.trigger === "manual"
    ) {
      events.push({ off: lineOff, ts, kind: "manual" });
    }
  }
  return events;
}

// ---- judgment (pure) ------------------------------------------------------------

/** Where a nudge's window starts inside the event list: byteOffset when the
 *  fire recorded one, else its ts (the receiver-side join uses the same
 *  degradation, issue #32 F3). */
const startsAfter = (ev, nudge) =>
  nudge.byteOffset != null ? ev.off >= nudge.byteOffset : ev.ts >= nudge.ts;

/**
 * Judge every nudge of ONE transcript against its event list. Pure.
 * Returns { verdicts, insideSpans } where verdicts[i] =
 *   { entry, complied, horizon: "compact"|"turns"|"time"|"next-nudge"|"eof",
 *     turnsSeen, minutes } and insideSpans marks [startIdx, endIdx) event
 * index ranges covered by any window (for the base-rate exclusion).
 * `nudges` must be the transcript's ledger rows; order is normalized here.
 */
export function judgeTranscriptNudges(events, nudges) {
  const sorted = [...nudges].sort((a, b) => a.ts - b.ts);
  const verdicts = [];
  const insideSpans = [];
  for (let i = 0; i < sorted.length; i++) {
    const nudge = sorted[i];
    const next = sorted[i + 1] ?? null;
    const startIdx = events.findIndex((ev) => startsAfter(ev, nudge));
    if (startIdx === -1) {
      // nothing recorded after the fire (session ended immediately)
      verdicts.push({ entry: nudge, complied: false, horizon: "eof", turnsSeen: 0, minutes: 0 });
      continue;
    }
    const turns = new Set();
    let complied = false;
    let horizon = "eof";
    let endIdx = events.length;
    let lastTs = nudge.ts;
    for (let j = startIdx; j < events.length; j++) {
      const ev = events[j];
      if (next && startsAfter(ev, next)) {
        horizon = "next-nudge";
        endIdx = j;
        break;
      }
      if (Number.isFinite(ev.ts)) {
        lastTs = ev.ts;
        if (ev.ts - nudge.ts > WINDOW_MS) {
          horizon = "time";
          endIdx = j;
          break;
        }
      }
      if (ev.kind === "manual") {
        complied = true;
        horizon = "compact";
        endIdx = j + 1; // the complied compact belongs to this window
        break;
      }
      turns.add(ev.mid);
      if (turns.size >= WINDOW_TURNS) {
        horizon = "turns";
        endIdx = j + 1;
        break;
      }
    }
    verdicts.push({
      entry: nudge,
      complied,
      horizon,
      turnsSeen: turns.size,
      minutes: Math.round((lastTs - nudge.ts) / 60000),
    });
    insideSpans.push([startIdx, endIdx]);
  }
  return { verdicts, insideSpans };
}

/** Base-rate tallies for ONE transcript: manual compacts / main-chain turns
 *  that fall OUTSIDE every nudge window. Pure. */
export function outsideWindowTally(events, insideSpans) {
  const inside = new Array(events.length).fill(false);
  for (const [s, e] of insideSpans) for (let i = s; i < e; i++) inside[i] = true;
  const turns = new Set();
  let manuals = 0;
  for (let i = 0; i < events.length; i++) {
    if (inside[i]) continue;
    if (events[i].kind === "manual") manuals++;
    else turns.add(events[i].mid);
  }
  return { manuals, turns: turns.size };
}

/** keep-audit over one transcript's complied verdicts (see header). Mutates
 *  verdicts in place (adds keepAudit) and returns the misassigned count. */
export function auditKeepLabels(verdicts) {
  let misassigned = 0;
  const rows = verdicts.map((v) => v.entry);
  for (const v of verdicts) {
    if (!v.complied || !v.entry.keepLabel) {
      v.keepAudit = { audited: false, misassigned: false };
      continue;
    }
    const keep = normalizeRef(v.entry.keepLabel);
    const hit = rows.some(
      (r) =>
        r.ts > v.entry.ts &&
        r.ts - v.entry.ts <= KEEP_AUDIT_MS &&
        r.dropLabel &&
        normalizeRef(r.dropLabel) === keep,
    );
    v.keepAudit = { audited: true, misassigned: hit };
    if (hit) misassigned++;
  }
  return misassigned;
}

// ---- report orchestration --------------------------------------------------------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const pct = (x) => `${Math.round(x * 1000) / 10}%`;

/**
 * Build the full compliance report. `files` = transcript paths already
 * discovered by analyze.mjs (its --project filter narrows matching — matched
 * nudges outside the filter surface as unmatched). Returns null when there is
 * no ledger to report on.
 */
export async function buildNudgeReport({ files, since = null, env = process.env, home = homedir() }) {
  const dir = ledgerDir(env, home);
  const entries = dir ? loadLedger(dir, since) : [];
  if (entries.length === 0) return null;

  const byHash = new Map();
  for (const f of files) {
    const h = transcriptHash16(f);
    if (!byHash.has(h)) byHash.set(h, f);
  }

  const groups = new Map(); // transcriptHash -> entries[]
  for (const e of entries) {
    if (!groups.has(e.transcriptHash)) groups.set(e.transcriptHash, []);
    groups.get(e.transcriptHash).push(e);
  }

  const verdicts = [];
  let unmatched = 0;
  let outsideManuals = 0;
  let outsideTurns = 0;
  let keepMisassigned = 0;
  let keepAudited = 0;
  for (const [hash, group] of groups) {
    const path = byHash.get(hash);
    if (!path) {
      unmatched += group.length;
      continue;
    }
    const events = await scanTranscriptEvents(path);
    const { verdicts: vs, insideSpans } = judgeTranscriptNudges(events, group);
    keepMisassigned += auditKeepLabels(vs);
    keepAudited += vs.filter((v) => v.keepAudit.audited).length;
    const tally = outsideWindowTally(events, insideSpans);
    outsideManuals += tally.manuals;
    outsideTurns += tally.turns;
    const sessionId = basename(path, ".jsonl");
    for (const v of vs) verdicts.push({ ...v, sessionId });
  }

  const judged = verdicts.length;
  const complied = verdicts.filter((v) => v.complied).length;
  const rate = judged > 0 ? complied / judged : null;
  const baseRateWindow =
    outsideTurns > 0 ? clamp01((outsideManuals / outsideTurns) * WINDOW_TURNS) : null;
  const adjusted =
    rate === null ? null : baseRateWindow === null ? rate : Math.max(0, rate - baseRateWindow);

  // segments: template x label presence x costShown
  const segments = new Map();
  for (const v of verdicts) {
    const e = v.entry;
    const key = `${e.template ?? "?"} · ${e.keepLabel ? "labeled" : "generic"} · ${e.costShown ?? "?"}`;
    let s = segments.get(key);
    if (!s) segments.set(key, (s = { key, judged: 0, complied: 0 }));
    s.judged++;
    if (v.complied) s.complied++;
  }

  const tss = entries.map((e) => e.ts);
  const spanDays = tss.length ? (Math.max(...tss) - Math.min(...tss)) / 86400000 : 0;
  const gateReached = judged >= KILL_N || spanDays >= KILL_DAYS;
  const verdict = !gateReached
    ? "insufficient-sample"
    : adjusted < 0.1
      ? "kill"
      : adjusted < 0.3
        ? "keep"
        : "L2-review";

  return {
    fires: entries.length,
    judged,
    unmatched,
    complied,
    rate,
    baseRateWindow,
    adjusted,
    spanDays: Math.round(spanDays * 10) / 10,
    gateReached,
    verdict,
    keepAudited,
    keepMisassigned,
    segments: [...segments.values()].sort((a, b) => b.judged - a.judged),
    verdicts,
  };
}

/** Console rendering (analyze.mjs style: pad columns, ## headers). */
export function renderNudgeReport(r) {
  const lines = [];
  const pad = (s, w) => String(s).padEnd(w);
  lines.push(`## nudge compliance (ctx-budget 넛지 순응률, #29)`);
  if (!r) {
    lines.push(`(no nudge ledger — ctx-budget has not fired yet, or ACP_CTX_BUDGET_DATA_DIR points elsewhere)`);
    return lines;
  }
  lines.push(
    `fires ${r.fires} · judged ${r.judged}${r.unmatched ? ` · unmatched-transcript ${r.unmatched}` : ""} · span ${r.spanDays}d`,
  );
  if (r.judged > 0) {
    lines.push(
      `complied ${r.complied}/${r.judged} (${pct(r.rate)})` +
        (r.baseRateWindow !== null
          ? ` · base rate ${pct(r.baseRateWindow)}/window · adjusted ${pct(r.adjusted)}`
          : ` · base rate n/a (no nudge-free turns)`),
    );
    lines.push(
      `keep-audit: ${r.keepMisassigned}/${r.keepAudited} misassigned (complied nudges whose keepLabel was dropped within 30m — 1+ means a lifetime-rule defect, issue #21)`,
    );
    for (const s of r.segments)
      lines.push(`  ${pad(s.key, 34)} judged ${pad(s.judged, 4)} complied ${s.complied}`);
    const horizons = {};
    for (const v of r.verdicts) horizons[v.horizon] = (horizons[v.horizon] ?? 0) + 1;
    lines.push(
      `window ends: ` +
        Object.entries(horizons)
          .sort((a, b) => b[1] - a[1])
          .map(([h, n]) => `${h} ${n}`)
          .join(" · "),
    );
  }
  lines.push(
    r.verdict === "insufficient-sample"
      ? `verdict: 표본 부족 (n ${r.judged}/${KILL_N} · ${r.spanDays}/${KILL_DAYS}d) — 판정 유보`
      : `verdict: ${r.verdict} (adjusted ${pct(r.adjusted)} — <10% kill / 10~30% keep / ≥30% L2-review)`,
  );
  return lines;
}

// ---- NudgeOutcome push (issue #32 §6, receiving side agentic-claude-hooks#63) ----

/** POST one NudgeOutcome per judged nudge to the local collector. The payload's
 *  json_extract paths ($.ref.*, $.complied, $.baseRateWindow,
 *  $.keepAudit.misassigned) are the receiver's contract — change both sides
 *  together. Re-running is idempotent for /stats/nudges: the receiver joins by
 *  (transcriptHash, byteOffset|ts) into a map, last write wins. postEnvelope
 *  always resolves, so the count is ATTEMPTS, not confirmations. */
export async function pushNudgeOutcomes(report) {
  if (!report || report.judged === 0) return 0;
  if (process.env.ACP_CTX_BUDGET_OBS === "0") return 0;
  const app = sourceApp(null); // once — it may spawn tmux (200ms budget)
  let sent = 0;
  for (const v of report.verdicts) {
    await postEnvelope({
      source_app: app,
      session_id: v.sessionId,
      hook_event_type: "NudgeOutcome",
      payload: {
        ref: {
          transcriptHash: v.entry.transcriptHash,
          byteOffset: v.entry.byteOffset ?? null,
          ts: v.entry.ts,
        },
        complied: v.complied,
        horizon: v.horizon,
        keepAudit: v.keepAudit,
        baseRateWindow: report.baseRateWindow,
      },
      timestamp: Date.now(),
    });
    sent++;
  }
  return sent;
}
