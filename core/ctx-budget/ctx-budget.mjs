#!/usr/bin/env node
// ctx-budget (PostToolUse / * + UserPromptSubmit): context-usage HUD +
// /compact nudges. Purely observational — emits a user-facing systemMessage,
// never touches the model's context and never blocks. The UserPromptSubmit
// wiring makes tier alerts also fire at the one moment a human can actually
// type /compact; on that event there is no tool payload, so boundary rules
// simply don't apply and the tier ladder still debounces everything.
//
//   - Every 10% tier crossed upward -> one alert ("컨텍스트 N% 사용 중").
//   - From 50% on, the alert adds a /compact recommendation plus the top
//     context consumers since the last compaction boundary, grouped by pattern
//     family with cumulative tokens + call counts (attribution.mjs).
//   - A successful-looking `gh pr merge` at >=50% context gets its own nudge:
//     a merge is a clean semantic boundary, so it is the best /compact moment.
//   - After compaction (usage drops below the alerted tier) tiers reset, so
//     the ladder re-arms.
//
// Context size comes from the transcript: the last main-chain assistant entry
// carries `message.usage` (input + cache_read + cache_creation = what the last
// turn actually sent). Only the file TAIL (~256KB) is read per event; the full
// transcript is streamed only when an attribution alert actually fires.
// Compaction boundaries are `{"type":"system","subtype":"compact_boundary"}`
// entries (format pinned against a real compacted transcript).
//
// Tunables (positive numbers, else default): ACP_CTX_BUDGET_WINDOW (context
// window tokens, default 200000 — set this to your model's real window),
// ACP_CTX_BUDGET_COMPACT_PCT (default 50), ACP_CTX_BUDGET_STEP (default 10).

import {
  openSync,
  readSync,
  fstatSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHookInput,
  emitSystemMessage,
  pass,
  failOpen,
} from "../../lib/hook-io.mjs";
import { topConsumers, fmtK } from "./attribution.mjs";

function positiveEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const WINDOW = positiveEnv("ACP_CTX_BUDGET_WINDOW", 200000);
const COMPACT_PCT = positiveEnv("ACP_CTX_BUDGET_COMPACT_PCT", 50);
const STEP = positiveEnv("ACP_CTX_BUDGET_STEP", 10);

// ---- state (per transcript = per context) ----------------------------------
function statePath(transcriptPath) {
  const h = createHash("sha1")
    .update(transcriptPath)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), "acp", "ctx-budget", `${h}.json`);
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

// Latest main-chain usage = current context size. Sidechain (subagent) entries
// carry their own usage for a DIFFERENT context, so they are skipped.
function currentContextTokens(transcriptPath) {
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
      if (total > 0) return total;
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

  const tokens = currentContextTokens(transcriptPath);
  if (tokens === null) pass();

  const pct = Math.round((tokens / WINDOW) * 100);
  const tier = Math.floor(Math.min(pct, 100) / STEP) * STEP;

  const sp = statePath(transcriptPath);
  const state = loadState(sp);
  const lastTier = typeof state.lastTier === "number" ? state.lastTier : 0;
  const now = Date.now();
  const COOLDOWN = 300000;

  // Semantic-boundary nudge: moments when finished work makes /compact
  // cheapest. Rules are a data table (add a boundary = add one entry); every
  // command test is anchored to the start of a shell SEGMENT so mere mentions
  // (echo "gh pr merge ...") don't fire, and each requires positive evidence
  // of success in the output. All rules share the >=COMPACT_PCT gate and ONE
  // cooldown, so a post-merge cluster (pull -> branch -d -> next pr create)
  // nudges once, not three times. Frequencies from mining 29 local sessions:
  // pr create 33 · pull 13 · branch -d 11 · gh pr merge 4.
  const segments = (input?.tool_input?.command ?? "")
    .split(/(?:&&|\|\||[;\n|])/)
    .map((s) => s.trim());
  const stdout = input?.tool_response?.stdout ?? "";
  const stderr = input?.tool_response?.stderr ?? "";

  // [label for the message, test(segments, stdout, stderr)]
  const BOUNDARY_RULES = [
    [
      // In-session merge — dormant when agent merges are guard-denied
      // (PostToolUse never fires); kept for setups that do merge in-session.
      "PR 머지 감지",
      () =>
        segments.some((s) => /^gh\s+pr\s+merge\b/.test(s)) &&
        !/error|failed/i.test(stderr),
    ],
    [
      // Merge evidence: a pull that actually brought new commits. In a
      // human-merges workflow this is the reliable in-session signal.
      "머지 반영 감지(git pull 새 커밋)",
      () =>
        segments.some((s) => /^git(?:\s+-C\s+\S+)?\s+pull\b/.test(s)) &&
        (/Updating [0-9a-f]+\.\.+[0-9a-f]+/.test(stdout) ||
          /Fast-forward/.test(stdout)),
    ],
    [
      // PR created (top-frequency boundary): work is packaged for review,
      // implementation trial-and-error detail is now safe to compact away.
      "PR 생성 감지",
      () =>
        segments.some((s) => /^gh\s+pr\s+create\b/.test(s)) &&
        /github\.com\/\S+\/pull\/\d+/.test(stdout),
    ],
    [
      // Post-merge branch cleanup: the unit of work is formally closed.
      "브랜치 정리 감지",
      () =>
        segments.some((s) =>
          /^git(?:\s+-C\s+\S+)?\s+branch\s+(?:-[a-zA-Z]*[dD]\b|--delete\b)/.test(
            s,
          ),
        ) && /Deleted branch/.test(stdout),
    ],
  ];

  const boundary =
    input?.tool_name === "Bash"
      ? BOUNDARY_RULES.find(([, test]) => test())
      : undefined;

  let wantTier = tier > lastTier;
  let wantMerge =
    Boolean(boundary) &&
    pct >= COMPACT_PCT &&
    (!state.lastMergeTs || now - state.lastMergeTs > COOLDOWN);

  if (!wantTier && !wantMerge) {
    if (tier < lastTier) {
      state.lastTier = tier; // compaction dropped usage -> re-arm the ladder
      delete state.top; // pre-compaction consumers are no longer in context
      delete state.topTs;
      saveState(sp, state);
    }
    pass();
  }

  // Parallel tool calls spawn concurrent hook processes that all saw the same
  // stale state. Re-read just before claiming so only one of them alerts.
  const fresh = loadState(sp);
  const freshTier = typeof fresh.lastTier === "number" ? fresh.lastTier : 0;
  if (wantTier && freshTier >= tier) wantTier = false;
  if (wantMerge && fresh.lastMergeTs && now - fresh.lastMergeTs <= COOLDOWN)
    wantMerge = false;
  if (!wantTier && !wantMerge) pass();

  // Claim FIRST (atomic write), then do the expensive attribution + emit —
  // a racing sibling now sees the claimed tier and stands down.
  const next = { ...fresh };
  next.lastTier = wantTier ? tier : tier < freshTier ? tier : freshTier;
  if (wantMerge) next.lastMergeTs = now;
  saveState(sp, next);

  const messages = [];
  if (wantMerge) {
    messages.push(
      `[ctx-budget] ${boundary[0]} + 컨텍스트 ${pct}% — 의미 경계인 지금이 /compact 최적 타이밍입니다.`,
    );
  }
  if (wantTier) {
    let msg = `[ctx-budget] 컨텍스트 ${pct}% 사용 중 (${fmtK(tokens)} / ${fmtK(WINDOW)} tok)`;
    if (pct >= COMPACT_PCT) {
      msg += " — /compact 권장";
      try {
        const top = await topConsumers(transcriptPath);
        if (top.length > 0) {
          msg += `. 상위 소비: ${top.join(" · ")}`;
          // Cache the leader for the statusline HUD (statusline.mjs) — it can't
          // stream the transcript per render, so it reads this back. topConsumers
          // above can take a while; RE-READ before this second write so a sibling
          // that claimed a tier/merge in the meantime isn't clobbered by the
          // stale `next` (which would drop its lastMergeTs -> duplicate nudge).
          const cur = loadState(sp);
          saveState(sp, { ...cur, top: top[0], topTs: now });
        }
      } catch {
        // attribution is best-effort garnish; the alert still goes out
      }
    }
    messages.push(msg);
  }
  emitSystemMessage(messages.join("\n"));
} catch (err) {
  failOpen(
    `[agent-context-protector/ctx-budget] internal error, skipping: ${err?.message ?? err}`,
  );
}
