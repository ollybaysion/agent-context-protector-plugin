#!/usr/bin/env node
// ctx-budget (PostToolUse / * + UserPromptSubmit): context-usage HUD +
// /compact nudges. Purely observational — emits a user-facing systemMessage,
// never touches the model's context and never blocks. The UserPromptSubmit
// wiring makes tier alerts also fire at the one moment a human can actually
// type /compact; on that event there is no tool payload, so boundary rules
// simply don't apply and the tier ladder still debounces everything.
//
//   - Every 10% tier crossed upward -> one alert ("컨텍스트 N% 사용 중"). Each
//     crossing also refreshes the cache the always-on statusline HUD reads:
//     top pattern families since the last compaction boundary (attribution.mjs),
//     each priced as a per-CALL re-read "rent", plus the whole-context per-call
//     cost and the one-time compact cost (same costSegment estimate the nudges
//     print) — so the HUD shows what context is costing below the /compact
//     threshold too. Unpriced models fall back to bare token estimates.
//   - From 50% on, the alert TEXT additionally spells out a /compact
//     recommendation plus that same top-consumers list inline.
//   - Work-boundary nudges (issue #21, baseline v2.1 in the issue comments):
//     a terminal boundary (PR created / merge landed / branch deleted /
//     in-session merge) or a start boundary (checkout -b / worktree add) at
//     >= NUDGE_MIN_TOK ABSOLUTE context tokens emits a copy-paste /compact
//     instruction — keep-first templates, generation-correct labels via the
//     genStart lifetime rules, warm-cache cost estimate (all in nudge.mjs).
//     Absolute floor, deliberately NOT the % ladder: on a 1M window the old
//     >=50% gate (=500k) silenced 85% of real boundaries (40-session mining);
//     the payoff of compacting is absolute (per-turn cache-read quota), so the
//     gate is too. Every nudge appends one line to nudges.jsonl so compliance
//     (nudge -> manual compact within the match window) is measurable offline.
//   - Sidechain (subagent) tool calls fire this hook too, with the MAIN
//     session's transcript_path but their own agent_id/agent_type on stdin
//     (pinned live against collector raw payloads, CC 2.1.x). Their git
//     activity is not a main-conversation work boundary: boundary logic is
//     skipped entirely for them (fail-open — absent fields on older CC keep
//     current behavior). Tier alerts still run (main-chain usage is filtered
//     inside currentContext regardless of who triggered the event).
//   - After compaction (usage drops below the alerted tier) tiers reset and the
//     stale HUD cache is cleared, so the ladder re-arms; the HUD is then
//     repopulated from the post-compaction transcript on that same event.
//   - Between crossings the HUD cache is topped up on a time throttle
//     (ACP_CTX_BUDGET_REFRESH_SEC), so it survives a compaction/reload and long
//     stretches inside one tier band instead of only refreshing on an upward
//     crossing (the gap that used to leave it blank at low ctx%).
//
// Context size comes from the transcript: the last main-chain assistant entry
// carries `message.usage` (input + cache_read + cache_creation = what the last
// turn actually sent) and `message.model` (reused for the cost estimate — same
// entry, no extra read). Only the file TAIL (~256KB) is read per event. The
// full transcript is streamed to refresh the HUD cache on a new-tier crossing
// and, at most once per REFRESH_MS, between crossings — never unthrottled on
// the per-event fast path.
// Compaction boundaries are `{"type":"system","subtype":"compact_boundary"}`
// entries (format pinned against a real compacted transcript).
//
// Tunables (positive numbers, else default): ACP_CTX_BUDGET_WINDOW (context
// window tokens, default 200000 — set this to your model's real window),
// ACP_CTX_BUDGET_COMPACT_PCT (default 50), ACP_CTX_BUDGET_STEP (default 10),
// ACP_CTX_BUDGET_NUDGE_MIN_TOK (boundary-nudge absolute floor, default
// min(200000, WINDOW*COMPACT_PCT/100) — preserves the old 50% behaviour on a
// 200k window), ACP_CTX_BUDGET_NUDGE_COST (ALL $ figures on/off — nudge segment
// AND the HUD costs/rents, default on), ACP_CTX_BUDGET_SUMMARY_OUT_TOK
// (summary-output approximation for the cost estimate, default 3000),
// ACP_CTX_BUDGET_TOP_N (consumer count, default 3), ACP_CTX_BUDGET_REFRESH_SEC
// (max HUD staleness, default 120), ACP_CTX_BUDGET_DATA_DIR (nudge-ledger
// directory, default $XDG_DATA_HOME/acp/ctx-budget or
// ~/.local/share/acp/ctx-budget — persistent, unlike the tmpdir state). The
// statusline advisory has its own thresholds (ADVISE/RECOMMEND/URGENT_PCT) —
// see statusline.mjs.

import {
  openSync,
  readSync,
  fstatSync,
  closeSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHookInput,
  emitSystemMessage,
  pass,
  failOpen,
} from "../../lib/hook-io.mjs";
import { topConsumers, fmtK } from "./attribution.mjs";
import { priceFor, CACHE_READ_MULT, fmtUsd } from "../../lib/pricing.mjs";
import {
  matchBoundary,
  recordGenStart,
  consumeOnTerminalFire,
  suppressedNamedConsume,
  costSegment,
  terminalMessage,
  startMessage,
  ledgerDir,
} from "./nudge.mjs";

function positiveEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const WINDOW = positiveEnv("ACP_CTX_BUDGET_WINDOW", 200000);
const COMPACT_PCT = positiveEnv("ACP_CTX_BUDGET_COMPACT_PCT", 50);
const STEP = positiveEnv("ACP_CTX_BUDGET_STEP", 10);
// How many consumer families the alert lists AND the statusline HUD keeps
// always-on. Same N for both so the momentary alert and the persistent HUD
// agree; dial down if the HUD line runs too wide for your terminal.
const TOP_N = positiveEnv("ACP_CTX_BUDGET_TOP_N", 3);
const NUDGE_MIN_TOK = positiveEnv(
  "ACP_CTX_BUDGET_NUDGE_MIN_TOK",
  Math.min(200000, (WINDOW * COMPACT_PCT) / 100),
);
const NUDGE_COST = process.env.ACP_CTX_BUDGET_NUDGE_COST !== "0";
const SUMMARY_OUT_TOK = positiveEnv("ACP_CTX_BUDGET_SUMMARY_OUT_TOK", 3000);
// Max staleness of the HUD cache before an ordinary event refreshes it (even
// without a tier crossing). This is what keeps the HUD populated after a
// compaction / reload / while sitting inside one tier band, instead of only on
// an upward crossing. Throttled so the transcript is streamed at most once per
// this interval, never per event.
const REFRESH_MS = positiveEnv("ACP_CTX_BUDGET_REFRESH_SEC", 120) * 1000;

// ---- state (per transcript = per context) ----------------------------------
function transcriptHash(transcriptPath) {
  return createHash("sha1").update(transcriptPath).digest("hex").slice(0, 16);
}

function statePath(transcriptPath) {
  return join(tmpdir(), "acp", "ctx-budget", `${transcriptHash(transcriptPath)}.json`);
}

function loadState(p) {
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {}; // missing/corrupt -> start fresh (fail open)
  }
}

// Atomic write (tmp + rename): parallel tool calls each spawn their own hook
// process, so plain overwrites could race. rename is atomic on POSIX.
function saveState(p, state) {
  mkdirSync(join(tmpdir(), "acp", "ctx-budget"), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p);
}

// Append-only nudge log — the raw material for offline compliance measurement
// (analyze matches byteOffset -> later compact_boundary entries). Unlike the
// tmpdir state files above, this is MEASUREMENT data (>=20 samples over up to
// 30 days, issue #29/#31), so it lives in the XDG data dir and must survive
// reboots. Write failures are swallowed: the nudge itself must still go out
// (fail open).
function logNudge(entry) {
  try {
    const dir = ledgerDir(process.env, homedir());
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "nudges.jsonl"), JSON.stringify(entry) + "\n");
  } catch {
    // measurement is garnish; never block the message
  }
}

// ---- statusline HUD cache -----------------------------------------------------
// What the always-on statusline reads back: top consumers plus the whole-context
// costs. Consumers are priced as a per-CALL re-read "rent" (tokens × cache-read
// rate — what re-sending that family bills on each assistant API call; a "turn"
// can be several calls, so /call is the precise unit). A consumer's CUMULATIVE $
// is deliberately not shown: it would need each token's call-age, which isn't
// tracked — the per-call rate is the honest, definable figure, and it pairs with
// the one-time compact cost ("spend $X once vs keep paying $Y per call"). The
// compact cost reuses nudge.mjs's costSegment — the SAME warm-cache estimate the
// boundary nudges print, gated by the same ACP_CTX_BUDGET_NUDGE_COST knob — so
// the HUD and the nudge never quote different prices for the same action.
// Unpriced models fall back to bare token estimates and omit both costs.
async function hudPatch(transcriptPath, tokens, model) {
  const items = await topConsumers(transcriptPath, TOP_N);
  if (items.length === 0) return null;
  const rates = NUDGE_COST ? priceFor(model) : null;
  const tops = items.map((it) =>
    rates
      ? `${it.label} ~${fmtUsd((it.tokens * rates.input * CACHE_READ_MULT) / 1e6)}/call (${it.calls}회)`
      : `${it.label} ~${fmtK(it.tokens)} tok (${it.calls}회)`,
  );
  const patch = { top: tops[0], tops };
  if (rates) {
    patch.callCost = (tokens * rates.input * CACHE_READ_MULT) / 1e6;
    patch.compactCost = costSegment({
      tokens,
      model,
      priceFor,
      summaryOutTok: SUMMARY_OUT_TOK,
      enabled: true, // NUDGE_COST already gated via `rates`
    }).estUsd;
  }
  return patch;
}

// Persist a HUD patch onto the LATEST state (a racing sibling may have claimed
// a tier/boundary meanwhile — merge, don't clobber). Costs are deleted before
// the merge so a model switch to an unpriced id can't leave stale $ behind.
function saveHudPatch(sp, patch, now) {
  const latest = loadState(sp);
  delete latest.callCost;
  delete latest.compactCost;
  saveState(sp, { ...latest, ...patch, topTs: now });
}

// Recompute the HUD cache from the transcript, at most once per REFRESH_MS
// (unless `force`). Tier crossings alone can strand the HUD blank: right after
// a compaction/reload the cache is empty, and inside a wide tier band nothing
// crosses for a long time — so an ordinary tool call (or a UserPromptSubmit)
// tops it up here. Streams the full transcript, so the throttle is what keeps
// this off the per-event fast path. Best-effort: any failure — or an empty
// result (no tool calls since the last boundary yet) — leaves the cache as-is.
async function refreshHud(sp, transcriptPath, now, force, tokens, model) {
  const cur = loadState(sp);
  if (!force && typeof cur.topTs === "number" && now - cur.topTs < REFRESH_MS)
    return;
  try {
    const patch = await hudPatch(transcriptPath, tokens, model);
    if (patch) saveHudPatch(sp, patch, now);
  } catch {
    // best-effort garnish; keep whatever's cached
  }
}

// ---- context size from the transcript tail ---------------------------------
function readTail(file, bytes = 262144) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Latest main-chain usage = current context size; the SAME entry's
// message.model feeds the cost estimate (design v2.1: one entry, zero extra
// reads). Sidechain (subagent) entries carry their own usage for a DIFFERENT
// context, so they are skipped.
function currentContext(transcriptPath) {
  const lines = readTail(transcriptPath).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"')) continue;
    try {
      const j = JSON.parse(line);
      if (j?.isSidechain === true) continue;
      const u = j?.message?.usage;
      if (!u) continue;
      const total =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      if (total > 0)
        return { tokens: total, model: j?.message?.model ?? null };
    } catch {
      // partial first line of the tail window, or a non-JSON line -> skip
    }
  }
  return null;
}

// ---- main -------------------------------------------------------------------
try {
  const input = await readHookInput();
  const transcriptPath = input?.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== "string") pass();

  const sp = statePath(transcriptPath);
  const now = Date.now();
  const COOLDOWN = 300000;

  // Work-boundary detection runs BEFORE the usage gate: lifetime rule 1
  // (record a start signal on match, always) must hold even when no usage
  // entry is readable. Sidechain calls skip boundary logic entirely (header
  // note). UserPromptSubmit has no tool payload -> matchBoundary is null and
  // only the tier ladder applies.
  const sidechain = Boolean(input?.agent_id || input?.agent_type);
  const found = sidechain
    ? null
    : matchBoundary(
        input?.tool_name,
        input?.tool_input?.command,
        input?.tool_response?.stdout,
        input?.tool_response?.stderr,
      );
  const isStart = found?.rule.kind === "start";
  const needGenMark = Boolean(found?.startGen);

  // Lifetime bookkeeping that must run even when the nudge itself cannot
  // fire: suppressed-named-consume of the OLD label first, then the NEW
  // start marking — a chained payload can carry both, in that order.
  const lifetimeBookkeeping = (st) => {
    let upd = st;
    let dirty = false;
    if (found && !isStart) {
      const r = suppressedNamedConsume(upd, found.capture, now);
      if (r.consumed) {
        upd = r.state;
        dirty = true;
      }
    }
    if (needGenMark) {
      upd = recordGenStart(upd, found.startGen, now);
      dirty = true;
    }
    return { upd, dirty };
  };

  const ctx = currentContext(transcriptPath);
  if (ctx === null) {
    // No readable main-chain usage (tail-window edge case) — the gate cannot
    // be judged so nothing fires, but rule-1 marking / named consumption
    // still run (review f6).
    const { upd, dirty } = lifetimeBookkeeping({ ...loadState(sp) });
    if (dirty) saveState(sp, upd);
    pass();
  }
  const { tokens, model } = ctx;

  const pct = Math.round((tokens / WINDOW) * 100);
  const tier = Math.floor(Math.min(pct, 100) / STEP) * STEP;

  const state = loadState(sp);
  const lastTier = typeof state.lastTier === "number" ? state.lastTier : 0;

  let wantTier = tier > lastTier;
  let wantBoundary =
    Boolean(found) &&
    tokens >= NUDGE_MIN_TOK &&
    (!state.lastMergeTs || now - state.lastMergeTs > COOLDOWN);

  if (!wantTier && !wantBoundary) {
    // Re-read before writing so a sibling's claim isn't clobbered.
    const cur = loadState(sp);
    let { upd, dirty } = lifetimeBookkeeping({ ...cur });
    const curTier = typeof cur.lastTier === "number" ? cur.lastTier : 0;
    const compacted = tier < curTier;
    if (compacted) {
      upd.lastTier = tier; // compaction dropped usage -> re-arm the ladder
      // pre-compaction consumers are no longer in context -> clear the whole
      // HUD cache together (consumers, costs, freshness stamp), so it goes
      // blank instead of showing a stale list/price until the next tier.
      delete upd.top;
      delete upd.tops;
      delete upd.topTs;
      delete upd.callCost;
      delete upd.compactCost;
      dirty = true;
    }
    if (dirty) saveState(sp, upd);
    // Compaction drop -> repopulate immediately from the post-boundary
    // transcript (topConsumers resets at the compact boundary), instead of
    // sitting blank at low ctx% until the next upward crossing. Otherwise a
    // throttled top-up keeps the HUD alive across reloads and long stretches
    // inside one tier band.
    await refreshHud(sp, transcriptPath, now, compacted, tokens, model);
    pass();
  }

  // Parallel tool calls spawn concurrent hook processes that all saw the same
  // stale state. Re-read just before claiming so only one of them alerts.
  const fresh = loadState(sp);
  const freshTier = typeof fresh.lastTier === "number" ? fresh.lastTier : 0;
  if (wantTier && freshTier >= tier) wantTier = false;
  if (wantBoundary && fresh.lastMergeTs && now - fresh.lastMergeTs <= COOLDOWN)
    wantBoundary = false;
  if (!wantTier && !wantBoundary) {
    const { upd, dirty } = lifetimeBookkeeping({ ...fresh });
    if (dirty) saveState(sp, upd);
    pass();
  }

  // Claim FIRST (atomic write), then do the expensive attribution + emit —
  // a racing sibling now sees the claimed tier and stands down.
  let next = { ...fresh };
  next.lastTier = wantTier ? tier : tier < freshTier ? tier : freshTier;
  if (wantBoundary) next.lastMergeTs = now; // field name kept for state compat

  // Lifetime rules 2/4/5 apply only on a FIRING terminal boundary; a
  // suppressed match was handled in the standdown paths above (rule 3 +
  // named-consume refinement). Consumption runs BEFORE the new start marking
  // so a same-payload start label isn't eaten by its own fire (review f4).
  let keepLabel = null;
  let drop = null;
  if (wantBoundary && !isStart) {
    ({ state: next, keepLabel, drop } = consumeOnTerminalFire(
      next,
      found.capture,
      now,
    ));
  }
  if (needGenMark) next = recordGenStart(next, found.startGen, now);
  saveState(sp, next);

  const messages = [];
  if (wantBoundary) {
    const cost = costSegment({
      tokens,
      model,
      priceFor,
      summaryOutTok: SUMMARY_OUT_TOK,
      enabled: NUDGE_COST,
    });
    const genLabel = isStart ? (found.capture.gen?.label ?? null) : null;
    messages.push(
      isStart
        ? startMessage({ genLabel, ruleLabel: found.rule.label, ctxTokens: tokens, cost: cost.segment })
        : terminalMessage({
            ruleLabel: found.rule.label,
            ctxTokens: tokens,
            cost: cost.segment,
            keepLabel,
            drop,
          }),
    );
    let byteOffset = null;
    try {
      byteOffset = statSync(transcriptPath).size;
    } catch {
      // offset is measurement garnish too
    }
    logNudge({
      ts: now,
      transcriptHash: transcriptHash(transcriptPath),
      kind: found.rule.key,
      template: isStart ? "start" : "terminal",
      keepLabel: isStart ? genLabel : keepLabel,
      dropLabel: drop?.label ?? null,
      dropForm: drop?.form ?? null,
      ctxTokens: tokens,
      byteOffset,
      estUsd: cost.estUsd,
      model,
      costShown: cost.costShown,
    });
  }
  if (wantTier) {
    let msg = `[ctx-budget] 컨텍스트 ${pct}% 사용 중 (${fmtK(tokens)} / ${fmtK(WINDOW)} tok)`;
    const compactHint = pct >= COMPACT_PCT;
    if (compactHint) msg += " — /compact 권장";
    // Refresh the HUD cache on EVERY tier crossing, not just from COMPACT_PCT
    // up, so the always-on HUD (statusline.mjs) can surface top consumers below
    // the /compact threshold too — you often want to see what's filling the
    // window well before it's time to compact. hudPatch streams the transcript,
    // but only on a NEW-tier crossing (the tier ladder + claim-then-emit
    // debounce it to ~once per band) or via the throttled refresh, never
    // unthrottled on the per-event fast path. The list is APPENDED to the alert
    // TEXT only when compactHint holds, where a "here's what to compact" list is
    // actionable; below that it silently feeds the HUD. `tops` is the full list
    // the HUD renders; `top` (the leader) stays written for backward compat with
    // a pre-top3 statusline still reading it mid-session. saveHudPatch RE-READS
    // before this second write so a sibling that claimed a tier/boundary
    // meanwhile isn't clobbered by the stale `next` (which would drop its
    // lastMergeTs -> duplicate nudge).
    try {
      const patch = await hudPatch(transcriptPath, tokens, model);
      if (patch) {
        if (compactHint) msg += `. 상위 소비: ${patch.tops.join(" · ")}`;
        saveHudPatch(sp, patch, now);
      }
    } catch {
      // attribution is best-effort garnish; the alert still goes out
    }
    messages.push(msg);
  }
  emitSystemMessage(messages.join("\n"));
} catch (err) {
  failOpen(
    `[agent-context-protector/ctx-budget] internal error, skipping: ${err?.message ?? err}`,
  );
}
