#!/usr/bin/env node
// ctx-budget (PostToolUse / *): context-usage HUD + /compact nudges. Purely
// observational — emits a user-facing systemMessage, never touches the model's
// context and never blocks.
//
//   - Every 10% tier crossed upward -> one alert ("컨텍스트 N% 사용 중").
//   - From 50% on, the alert adds a /compact recommendation plus the top
//     context consumers since the last compaction boundary (attribution).
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
  createReadStream,
} from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHookInput, emitSystemMessage, pass, failOpen } from "../../lib/hook-io.mjs";

function positiveEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const WINDOW = positiveEnv("ACP_CTX_BUDGET_WINDOW", 200000);
const COMPACT_PCT = positiveEnv("ACP_CTX_BUDGET_COMPACT_PCT", 50);
const STEP = positiveEnv("ACP_CTX_BUDGET_STEP", 10);

const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

// ---- state (per transcript = per context) ----------------------------------
function statePath(transcriptPath) {
  const h = createHash("sha1").update(transcriptPath).digest("hex").slice(0, 16);
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

// ---- attribution: top context consumers since the last compact boundary ----
function toolLabel(name, input) {
  if (name === "Bash" && typeof input?.command === "string") {
    const c = input.command.replace(/\s+/g, " ").trim();
    return `Bash(${c.length > 28 ? c.slice(0, 28) + "…" : c})`;
  }
  const p = input?.file_path;
  if (typeof p === "string") return `${name}(${p.split("/").pop()})`;
  return name;
}

async function topConsumers(transcriptPath, topN = 3) {
  const pending = new Map(); // tool_use_id -> {label, inputChars}
  let sums = new Map(); // label -> chars
  await new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(transcriptPath),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (j?.type === "system" && j?.subtype === "compact_boundary") {
        sums = new Map(); // content before the boundary is no longer in context
        pending.clear();
        return;
      }
      if (j?.isSidechain === true) return;
      const content = j?.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type === "tool_use") {
          const inputChars = JSON.stringify(block.input ?? {}).length;
          pending.set(block.id, { label: toolLabel(block.name, block.input), inputChars });
        }
        if (block?.type === "tool_result" && pending.has(block.tool_use_id)) {
          const { label, inputChars } = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          let chars = inputChars;
          if (typeof block.content === "string") chars += block.content.length;
          else if (Array.isArray(block.content))
            for (const c of block.content) if (c?.type === "text") chars += (c.text ?? "").length;
          sums.set(label, (sums.get(label) ?? 0) + chars);
        }
      }
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
  return [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([label, chars]) => `${label} ~${fmtK(Math.round(chars / 4))} tok`);
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

  // Merge nudge: a clean semantic boundary while context is heavy. Two
  // detection paths, both anchored to the start of a command SEGMENT so mere
  // mentions (echo "gh pr merge ...") don't fire:
  //  (a) an in-session `gh pr merge` — mostly dormant in an agent-merges-
  //      banned workflow (a git-guard deny means PostToolUse never fires),
  //      kept for setups where merges do run in-session;
  //  (b) merge EVIDENCE: a `git pull` that actually brought new commits
  //      (stdout shows "Updating a1b2c3..d4e5f6" / "Fast-forward"). In a
  //      human-merges workflow this is the reliable in-session signal — the
  //      agent pulls right after the user merges. "Already up to date" stays
  //      silent.
  const segments = (input?.tool_input?.command ?? "")
    .split(/(?:&&|\|\||[;\n|])/)
    .map((s) => s.trim());
  const stdout = input?.tool_response?.stdout ?? "";
  const isBash = input?.tool_name === "Bash";
  const isMergeCmd =
    isBash &&
    segments.some((s) => /^gh\s+pr\s+merge\b/.test(s)) &&
    !/error|failed/i.test(input?.tool_response?.stderr ?? "");
  const isMergeEvidence =
    isBash &&
    segments.some((s) => /^git(?:\s+-C\s+\S+)?\s+pull\b/.test(s)) &&
    (/Updating [0-9a-f]+\.\.+[0-9a-f]+/.test(stdout) || /Fast-forward/.test(stdout));
  const isMerge = isMergeCmd || isMergeEvidence;

  let wantTier = tier > lastTier;
  let wantMerge =
    isMerge && pct >= COMPACT_PCT && (!state.lastMergeTs || now - state.lastMergeTs > COOLDOWN);

  if (!wantTier && !wantMerge) {
    if (tier < lastTier) {
      state.lastTier = tier; // compaction dropped usage -> re-arm the ladder
      saveState(sp, state);
    }
    pass();
  }

  // Parallel tool calls spawn concurrent hook processes that all saw the same
  // stale state. Re-read just before claiming so only one of them alerts.
  const fresh = loadState(sp);
  const freshTier = typeof fresh.lastTier === "number" ? fresh.lastTier : 0;
  if (wantTier && freshTier >= tier) wantTier = false;
  if (wantMerge && fresh.lastMergeTs && now - fresh.lastMergeTs <= COOLDOWN) wantMerge = false;
  if (!wantTier && !wantMerge) pass();

  // Claim FIRST (atomic write), then do the expensive attribution + emit —
  // a racing sibling now sees the claimed tier and stands down.
  const next = { ...fresh };
  next.lastTier = wantTier ? tier : tier < freshTier ? tier : freshTier;
  if (wantMerge) next.lastMergeTs = now;
  saveState(sp, next);

  const messages = [];
  if (wantMerge) {
    const src = isMergeCmd ? "PR 머지 감지" : "머지 반영 감지(git pull 새 커밋)";
    messages.push(
      `[ctx-budget] ${src} + 컨텍스트 ${pct}% — 의미 경계인 지금이 /compact 최적 타이밍입니다.`,
    );
  }
  if (wantTier) {
    let msg = `[ctx-budget] 컨텍스트 ${pct}% 사용 중 (${fmtK(tokens)} / ${fmtK(WINDOW)} tok)`;
    if (pct >= COMPACT_PCT) {
      msg += " — /compact 권장";
      try {
        const top = await topConsumers(transcriptPath);
        if (top.length > 0) msg += `. 상위 소비: ${top.join(" · ")}`;
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
