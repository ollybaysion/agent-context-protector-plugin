#!/usr/bin/env node
// core/analyze: human-invoked offline diagnostics over Claude Code transcript
// JSONL files. NOT a hook — no hooks.json wiring; run it yourself:
//
//   node core/analyze/analyze.mjs [--project <dir-name>] [--since <ISO>]
//                                 [--top N] [--json out.json] [--precise]
//                                 [--plugin-report]
//
// The DEFAULT report reads only what Claude Code itself writes, so it works
// on machines where this plugin's hooks were never installed (see also the
// npx path via the root package.json):
//   0. billed usage totals + $ cost estimate (per-model price table, by
//      day / session / model — API list rates; reference-only on Max plans)
//   1. per-pattern cumulative spend (calls, chars, ~tokens, share, sessions)
//   2. rule proposals — heavy ungated patterns (rule-candidate)
//   3. --precise: usage-delta token attribution (billed-token based) and its
//      deviation from the chars/4 estimate
//
// --plugin-report adds the plugin-effect sections (they read markers that
// only exist when the hooks were active in the period):
//   4. cap/deny ledger — output-cap markers and input-gate denies, with $
//      savings per cap event priced against the session's MEASURED remaining
//      turns (post-hoc: we can count how many main-chain turns actually
//      followed each event, so the re-read multiplier is not a guess)
//   5. inefficiency diagnostics — repeatedly-capped patterns (gate-promotion),
//      deny→retry tracking, and gated-family activity summary
//
// Totals are cumulative HISTORY spend (no compact-boundary reset — that
// matters for live-context attribution, not for "what has been costing us").
// Pattern totals include sidechain (subagent) traffic — it is real spend;
// --precise uses main-chain entries only, since usage deltas are per-context.

import {
  readdirSync,
  statSync,
  createReadStream,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { toolPattern } from "../../lib/patterns.mjs";

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = {
  project: null,
  since: null,
  top: 20,
  json: null,
  precise: false,
  full: false,
  pluginReport: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--project") opt.project = args[++i];
  else if (a === "--since") opt.since = new Date(args[++i]).getTime();
  else if (a === "--top") {
    const n = Number(args[++i]);
    opt.top = Number.isFinite(n) && n >= 0 ? n : 20; // 0 is a valid choice
  } else if (a === "--json") opt.json = args[++i];
  else if (a === "--precise") opt.precise = true;
  else if (a === "--full")
    opt.full = true; // every pattern row, no top-N cut
  else if (a === "--plugin-report")
    opt.pluginReport = true; // plugin-effect sections (cap/deny ledgers, savings, inefficiencies)
  else if (a === "--help" || a === "-h") {
    console.log(
      "usage: analyze.mjs [--project <dir-name>] [--since <ISO>] [--top N | --full] [--json out.json] [--precise] [--plugin-report]",
    );
    process.exit(0);
  } else {
    console.error(`unknown option: ${a}`);
    process.exit(1);
  }
}
if (opt.since !== null && Number.isNaN(opt.since)) {
  console.error("--since: unparseable date");
  process.exit(1);
}

// ---- collect transcript files -----------------------------------------------
// ACP_ANALYZE_ROOT overrides the transcript root (used by the test harness).
const ROOT =
  process.env.ACP_ANALYZE_ROOT || join(homedir(), ".claude", "projects");
const files = [];
try {
  for (const proj of readdirSync(ROOT)) {
    if (opt.project && proj !== opt.project) continue;
    const dir = join(ROOT, proj);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir))
      if (f.endsWith(".jsonl")) files.push(join(dir, f));
  }
} catch (err) {
  console.error(`cannot read ${ROOT}: ${err?.message ?? err}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(
    `no transcripts found${opt.project ? ` for project ${opt.project}` : ""}`,
  );
  process.exit(1);
}

// ---- accumulators -------------------------------------------------------------
// pattern -> { calls, chars, sessions:Set, preciseTokens }
const patterns = new Map();
// pattern -> { events, droppedChars }
const caps = new Map();
// rule head -> count
const denies = new Map();
let totalChars = 0;
// Per-event records for --plugin-report savings/inefficiency math. Main-chain
// only: the remaining-turn multiplier below counts main-chain turns, so mixing
// in sidechain events would price them against the wrong context lifetime.
// (The aggregate ledgers above still include sidechain traffic, unchanged.)
const capEvents = []; // {file, label, droppedChars, turnsAt, model}
const denyEvents = []; // {file, label, ruleKey, turnsAt, retried}
const finalTurns = new Map(); // file -> final main-chain turn count

const pat = (label) => {
  let e = patterns.get(label);
  if (!e)
    patterns.set(
      label,
      (e = { calls: 0, chars: 0, sessions: new Set(), preciseTokens: 0 }),
    );
  return e;
};

const CAP_MARKER = /output-cap: dropped (\d+) of \d+ chars/g;

// ---- cost estimation -----------------------------------------------------------
// $/MTok base list prices (input, output). Derived rates: cache read 0.1x input,
// cache write 1.25x (5m TTL) / 2x (1h TTL). Every transcript usage entry carries
// message.model (verified 6,007/6,007 on real data, 2026-07-04), so cost is
// applied per entry — mid-session model switches price correctly. Model ids
// resolve by longest-prefix match so dated full ids ("claude-haiku-4-5-20251001")
// hit their alias row. Unknown models (e.g. "<synthetic>") are NEVER guessed:
// they go to an unpriced bucket and are reported, not silently priced.
// NOTE: these are API list prices — for subscription (Max) usage the $ figures
// are an API-equivalent reference, not an actual bill.
const PRICE_BASIS = "2026-06 list $/MTok";
const PRICES = [
  ["claude-fable-5", { input: 10, output: 50 }],
  ["claude-mythos-5", { input: 10, output: 50 }],
  ["claude-opus-4-8", { input: 5, output: 25 }],
  ["claude-opus-4-7", { input: 5, output: 25 }],
  ["claude-opus-4-6", { input: 5, output: 25 }],
  ["claude-opus-4-5", { input: 5, output: 25 }],
  ["claude-opus-4-1", { input: 15, output: 75 }],
  ["claude-opus-4-0", { input: 15, output: 75 }],
  ["claude-opus-4-2", { input: 15, output: 75 }], // dated full id claude-opus-4-20250514
  ["claude-sonnet-5", { input: 3, output: 15 }], // intro $2/$10 through 2026-08-31; list price used
  ["claude-sonnet-4-6", { input: 3, output: 15 }],
  ["claude-sonnet-4-5", { input: 3, output: 15 }],
  ["claude-sonnet-4-2", { input: 3, output: 15 }], // dated full id claude-sonnet-4-20250514
  ["claude-sonnet-4-0", { input: 3, output: 15 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }],
].sort((a, b) => b[0].length - a[0].length); // longest prefix wins

const priceCache = new Map();
function priceFor(model) {
  if (typeof model !== "string" || model === "") return null;
  if (priceCache.has(model)) return priceCache.get(model);
  const hit = PRICES.find(([k]) => model.startsWith(k));
  const p = hit ? hit[1] : null;
  priceCache.set(model, p);
  return p;
}

// A corrupted transcript line must never poison totals (fail-open): one
// string/object/negative usage field would otherwise NaN every $ figure in
// the report — and JSON.stringify(NaN) -> null, masquerading as "unpriced".
// Treat any non-finite or negative field as 0.
const num = (v) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

// cache_creation split by TTL. Real transcripts (CC 2.1.198) always carry the
// {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens} object; if only the
// lump sum exists, price it all at the CHEAPER 5m rate (never overstate).
function ccSplit(u) {
  const cc = u.cache_creation;
  if (cc && typeof cc === "object") {
    const w5 = num(cc.ephemeral_5m_input_tokens);
    const w1 = num(cc.ephemeral_1h_input_tokens);
    if (w5 + w1 > 0 || !(num(u.cache_creation_input_tokens) > 0))
      return { w5, w1 };
  }
  return { w5: num(u.cache_creation_input_tokens), w1: 0 };
}

// $ for one usage entry, or null when the model has no price row.
function usageCost(u, p) {
  if (!p) return null;
  const { w5, w1 } = ccSplit(u);
  return (
    (num(u.input_tokens) * p.input +
      w5 * p.input * 1.25 +
      w1 * p.input * 2 +
      num(u.cache_read_input_tokens) * p.input * 0.1 +
      num(u.output_tokens) * p.output) /
    1e6
  );
}

// Billed-token totals from usage fields. One API response is logged as
// SEVERAL transcript entries (one per content block), each duplicating the
// same usage object — measured 182 usage entries vs 87 distinct message ids
// on a real session — so totals MUST dedupe by message id or they ~double.
const usageTotals = {
  main: { turns: 0, output: 0, freshIn: 0, cacheRead: 0, cost: 0 },
  subagent: { turns: 0, output: 0, freshIn: 0, cacheRead: 0, cost: 0 },
};
let peakContext = { tokens: 0, file: null };
const byDay = new Map(); // "YYYY-MM-DD" (local) -> {turns, output, freshIn, cacheRead, cost}
const bySession = []; // per transcript: {id, title, firstTs, lastTs, main, subagent, peak}
// model -> {turns, input, write5m, write1h, cacheRead, output, cost|null}
// Covers main + subagent traffic alike (it's all billed usage); cost === null
// marks an unpriced model whose tokens are counted but excluded from $ totals.
const byModel = new Map();

const emptyBucket = () => ({
  turns: 0,
  output: 0,
  freshIn: 0,
  cacheRead: 0,
  cost: 0,
});
const addUsage = (bucket, u, cost) => {
  bucket.turns++;
  bucket.output += num(u.output_tokens);
  bucket.freshIn += num(u.input_tokens) + num(u.cache_creation_input_tokens);
  bucket.cacheRead += num(u.cache_read_input_tokens);
  bucket.cost += cost ?? 0;
};
const localDay = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function resultText(block) {
  let t = "";
  if (typeof block.content === "string") t = block.content;
  else if (Array.isArray(block.content))
    for (const c of block.content) if (c?.type === "text") t += c.text ?? "";
  return t;
}

// ---- per-file pass ------------------------------------------------------------
async function scanFile(file) {
  const pending = new Map(); // tool_use_id -> {label, inputChars, sidechain}
  const seenMsgIds = new Set(); // dedupe split entries of one API response
  let lastMainModel = null; // model of the latest main-chain usage entry
  const awaitingRetry = new Map(); // label -> deny events awaiting a same-family retry
  const session = {
    id: file
      .split("/")
      .pop()
      .replace(/\.jsonl$/, ""),
    title: null,
    firstTs: null,
    lastTs: null,
    main: emptyBucket(),
    subagent: emptyBucket(),
    peak: 0,
  };
  // precise-mode event stream (main-chain only, file order)
  const events = []; // {kind:"usage", total, output} | {kind:"result", label, chars}
  await new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(file),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (line.includes('"ai-title"')) {
        try {
          const t = JSON.parse(line);
          if (t?.type === "ai-title" && typeof t.aiTitle === "string")
            session.title = t.aiTitle;
        } catch {}
        return;
      }
      if (!line.includes('"message"')) return;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (
        opt.since !== null &&
        j?.timestamp &&
        Date.parse(j.timestamp) < opt.since
      )
        return;
      const sidechain = j?.isSidechain === true;
      const content = j?.message?.content;

      if (j?.type === "assistant" && j?.message?.usage) {
        // No id at all -> treat as unique (never collapse distinct turns).
        const msgId = j.message.id ?? j.uuid ?? null;
        if (msgId === null || !seenMsgIds.has(msgId)) {
          if (msgId !== null) seenMsgIds.add(msgId);
          const u = j.message.usage;
          const model =
            typeof j.message.model === "string" && j.message.model !== ""
              ? j.message.model
              : "(unknown)";
          const price = priceFor(model);
          const cost = usageCost(u, price);
          if (!sidechain) lastMainModel = model;
          addUsage(
            sidechain ? usageTotals.subagent : usageTotals.main,
            u,
            cost,
          );
          addUsage(sidechain ? session.subagent : session.main, u, cost);
          {
            const { w5, w1 } = ccSplit(u);
            let bm = byModel.get(model);
            if (!bm)
              byModel.set(
                model,
                (bm = {
                  turns: 0,
                  input: 0,
                  write5m: 0,
                  write1h: 0,
                  cacheRead: 0,
                  output: 0,
                  cost: price ? 0 : null,
                }),
              );
            bm.turns++;
            bm.input += num(u.input_tokens);
            bm.write5m += w5;
            bm.write1h += w1;
            bm.cacheRead += num(u.cache_read_input_tokens);
            bm.output += num(u.output_tokens);
            if (bm.cost !== null) bm.cost += cost;
          }
          if (j.timestamp) {
            session.firstTs = session.firstTs ?? j.timestamp;
            session.lastTs = j.timestamp;
            const day = localDay(j.timestamp);
            if (day) {
              let d = byDay.get(day);
              if (!d) byDay.set(day, (d = emptyBucket()));
              addUsage(d, u, cost);
            }
          }
          const total =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
          if (!sidechain && total > session.peak) session.peak = total;
          if (!sidechain && total > peakContext.tokens)
            peakContext = { tokens: total, file };
          if (opt.precise && !sidechain && total > 0)
            events.push({ kind: "usage", total, output: u.output_tokens ?? 0 });
        }
      }

      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type === "tool_use") {
          pending.set(block.id, {
            label: toolPattern(block.name, block.input),
            inputChars: JSON.stringify(block.input ?? {}).length,
            sidechain,
          });
        }
        if (block?.type === "tool_result" && pending.has(block.tool_use_id)) {
          const {
            label,
            inputChars,
            sidechain: sc,
          } = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          const text = resultText(block);
          if (block.is_error) {
            const m = text.match(/^(input-gate|read-once): ([^.。\n]{0,60})/);
            // Normalize interpolated numbers ("293KB", "1523줄") so each RULE
            // aggregates to one ledger row instead of one row per invocation.
            if (m) {
              const key = m[0].replace(/\d+/g, "N");
              denies.set(key, (denies.get(key) ?? 0) + 1);
              if (!sc) {
                const ev = {
                  file,
                  label,
                  ruleKey: key,
                  turnsAt: session.main.turns,
                  retried: false,
                };
                denyEvents.push(ev);
                let w = awaitingRetry.get(label);
                if (!w) awaitingRetry.set(label, (w = []));
                w.push(ev);
              }
            }
            continue; // denied call cost ~nothing; don't count as spend
          }
          const chars = inputChars + text.length;
          const e = pat(label);
          e.calls++;
          e.chars += chars;
          e.sessions.add(file);
          totalChars += chars;
          // A later successful call of the same family means the deny's
          // suggested bounded alternative (or a narrower read) was taken —
          // the guidance worked rather than the task being abandoned.
          if (!sc && awaitingRetry.has(label)) {
            for (const ev of awaitingRetry.get(label)) ev.retried = true;
            awaitingRetry.delete(label);
          }
          CAP_MARKER.lastIndex = 0;
          let cm;
          while ((cm = CAP_MARKER.exec(text)) !== null) {
            let c = caps.get(label);
            if (!c) caps.set(label, (c = { events: 0, droppedChars: 0 }));
            c.events++;
            c.droppedChars += Number(cm[1]);
            if (!sc)
              capEvents.push({
                file,
                label,
                droppedChars: Number(cm[1]),
                turnsAt: session.main.turns,
                model: lastMainModel,
              });
          }
          if (opt.precise && !sc) events.push({ kind: "result", label, chars });
        }
      }
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });

  // ---- precise attribution: growth between consecutive usage snapshots,
  // minus the previous turn's own output, distributed over the tool results
  // that arrived in between (proportional to chars).
  if (opt.precise) {
    let prev = null;
    let bucket = [];
    for (const ev of events) {
      if (ev.kind === "result") {
        bucket.push(ev);
        continue;
      }
      if (prev !== null) {
        const growth = ev.total - prev.total;
        const attributable = growth - prev.output;
        if (growth > 0 && attributable > 0 && bucket.length > 0) {
          const bucketChars = bucket.reduce((s, r) => s + r.chars, 0);
          if (bucketChars > 0) {
            for (const r of bucket) {
              pat(r.label).preciseTokens +=
                (attributable * r.chars) / bucketChars;
            }
          }
        }
        // growth <= 0 means compaction/clear between snapshots -> skip pair
      }
      prev = ev;
      bucket = [];
    }
  }

  if (session.main.turns > 0 || session.subagent.turns > 0)
    bySession.push(session);
  finalTurns.set(file, session.main.turns);
}

for (const f of files) {
  try {
    await scanFile(f);
  } catch (err) {
    console.error(`skip ${f}: ${err?.message ?? err}`);
  }
}

// ---- rule proposals -----------------------------------------------------------
// Pattern families input-gate already covers (deny or measure). KEEP IN SYNC
// with core/input-gate/input-gate.mjs — Bash families come from its
// FOLLOW/VOLUME rules; Read families from LOG_ARTIFACT_READ / ARTIFACT_READ
// (extension-level only: package-lock.json and *.min.js normalize to
// Read(*.json) / Read(*.js), which we deliberately do NOT list — gating those
// labels would suppress proposals for normal json/js reads too).
const GATED = new Set([
  "tail",
  "tree",
  "du",
  "journalctl",
  "docker logs",
  "kubectl logs",
  "pm2 logs",
  "git log",
  "git diff",
  "curl",
  "wget",
  "ls",
  "Read(*.output)",
  "Read(*.log)",
  "Read(*.trace)",
  "Read(*.dump)",
  "Read(*.ndjson)",
  "Read(*.map)",
  "Read(*.lock)",
]);
// rule-candidate = a pattern worth gating in input-gate. The old trigger was
// "tokens / total-transcripts > 5000", which mis-ranked by dividing a pattern's
// spend across EVERY session including ones it never touched: it flagged broad,
// low-per-call patterns (Read(*.md) ~1k tok/call — normal doc reads, gating
// them just yields false positives) while missing few-call, high-per-call ones
// (Read(*.output) ~10k tok/call, the real gate targets) because 7 sessions of
// spend diluted over 30 fell under the bar. Trigger on PER-CALL cost instead —
// that's what "a ranged read would bound this" actually keys on — with a
// min-calls floor so a one-off heavy call doesn't propose a rule.
// Only a positive finite override wins; anything else (unset, "", whitespace,
// "0", negative, non-numeric) falls back to the default. Guarding >0 (not >=0)
// matters: Number("") === 0, so a blank env value would otherwise set the
// threshold to 0 and flood proposals with the very false positives this change
// removes. 0 is never a meaningful value for either knob.
const envNum = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const PROPOSE_PER_CALL_TOKENS = envNum(
  process.env.ACP_ANALYZE_PROPOSE_PER_CALL_TOKENS,
  4000,
);
const PROPOSE_MIN_CALLS = envNum(process.env.ACP_ANALYZE_PROPOSE_MIN_CALLS, 3);

const rows = [...patterns.entries()]
  .map(([label, e]) => ({
    label,
    calls: e.calls,
    chars: e.chars,
    tokens: Math.round(e.chars / 4),
    perCall: e.calls > 0 ? Math.round(e.chars / 4 / e.calls) : 0,
    preciseTokens: Math.round(e.preciseTokens),
    sessions: e.sessions.size,
    sharePct: totalChars ? Math.round((e.chars / totalChars) * 1000) / 10 : 0,
  }))
  .sort((a, b) => b.chars - a.chars);

const proposals = [];
for (const r of rows) {
  if (
    r.perCall >= PROPOSE_PER_CALL_TOKENS &&
    r.calls >= PROPOSE_MIN_CALLS &&
    !GATED.has(r.label)
  ) {
    proposals.push({
      kind: "rule-candidate",
      pattern: r.label,
      why: `~${Math.round(r.perCall / 1000)}k tok/call across ${r.calls} calls / ${r.sessions} session(s) — few calls burning a lot; a ranged read would bound it`,
    });
  }
}
// gate-promotion keys on cap events (plugin data), so it lives in the plugin
// report — printed there, but always present in --json (handoff shape).
const gatePromotions = [];
for (const [label, c] of caps) {
  if (c.events >= 2) {
    gatePromotions.push({
      kind: "gate-promotion",
      pattern: label,
      why: `output-cap fired ${c.events}x (~${Math.round(c.droppedChars / 4000)}k tok dropped) — a PreToolUse bound would avoid the runs entirely`,
    });
  }
}

// ---- plugin-effect math (savings, deny retries, gated-family activity) ---------
// Savings model per cap event: the dropped tokens would have been written to
// cache once (CC traffic is 1h TTL -> 2x base input) and then re-read at 0.1x
// on EVERY later turn of that session. Post-hoc we know the actual remaining
// main-chain turn count, so the multiplier is measured, not assumed. Priced
// by the model of the nearest preceding main-chain usage entry; events with
// no priceable model are counted but excluded from $ (never guessed).
// Denies have no recorded size (blocked before execution), so they are
// reported as counts only — deliberately not converted to $.
const capSavings = new Map(); // label -> {events, droppedTok, saved, unpriced}
let capSavedTotal = 0;
for (const ev of capEvents) {
  const remaining = Math.max(
    0,
    (finalTurns.get(ev.file) ?? ev.turnsAt) - ev.turnsAt,
  );
  const droppedTok = ev.droppedChars / 4;
  const p = priceFor(ev.model);
  let s = capSavings.get(ev.label);
  if (!s)
    capSavings.set(
      ev.label,
      (s = { events: 0, droppedTok: 0, saved: 0, unpriced: 0 }),
    );
  s.events++;
  s.droppedTok += droppedTok;
  if (p) {
    const usd = (droppedTok * (p.input * 2 + p.input * 0.1 * remaining)) / 1e6;
    s.saved += usd;
    capSavedTotal += usd;
  } else {
    s.unpriced++;
  }
}
const denyRetries = {
  total: denyEvents.length,
  retried: denyEvents.filter((e) => e.retried).length,
  abandoned: denyEvents.filter((e) => !e.retried),
};
// Activity per gated family: traffic without any intervention usually means
// calls stayed under the thresholds (the gate working silently) — but a
// consistently quiet rule with heavy traffic is worth a threshold check.
const ruleActivity = [...GATED]
  .map((fam) => ({
    family: fam,
    calls: patterns.get(fam)?.calls ?? 0,
    caps: caps.get(fam)?.events ?? 0,
    denies: denyEvents.filter((e) => e.label === fam).length,
  }))
  .filter((a) => a.calls > 0 || a.caps > 0 || a.denies > 0);
const pluginDataPresent = capEvents.length > 0 || denyEvents.length > 0;

// ---- output ---------------------------------------------------------------------
const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
const fmtUSD = (n) =>
  n >= 100
    ? `$${Math.round(n)}`
    : n >= 10
      ? `$${n.toFixed(1)}`
      : `$${n.toFixed(2)}`;
const pad = (s, w) => String(s).padEnd(w);

console.log(
  `transcripts: ${files.length}   total tool-result chars: ${fmtK(totalChars)} (~${fmtK(Math.round(totalChars / 4))} tok)\n`,
);

// Billed-token view: what the API actually metered, deduped by message id.
// freshIn = input + cache_creation (tokens entering context anew);
// cacheRead = context re-sent from cache each turn (the per-turn resend the
// whole plugin exists to shrink); output = generated tokens.
{
  const m = usageTotals.main;
  const s = usageTotals.subagent;
  console.log(
    "## usage totals (billed tokens from usage fields, deduped by message id)",
  );
  console.log(
    `main agent: ${m.turns} turns · output ${fmtK(m.output)} · fresh input ${fmtK(m.freshIn)} · cache reads ${fmtK(m.cacheRead)} · est ${fmtUSD(m.cost)}`,
  );
  if (s.turns > 0)
    console.log(
      `subagents : ${s.turns} turns · output ${fmtK(s.output)} · fresh input ${fmtK(s.freshIn)} · cache reads ${fmtK(s.cacheRead)} · est ${fmtUSD(s.cost)}`,
    );
  if (peakContext.tokens > 0)
    console.log(
      `peak context: ${fmtK(peakContext.tokens)} tok (${peakContext.file?.split("/").pop() ?? "?"})`,
    );
  console.log(
    `est. cost: ${fmtUSD(m.cost + s.cost)} (${PRICE_BASIS}; API-rate estimate — subscription plans are not billed per token)`,
  );
  console.log("");
}

if (byModel.size > 0) {
  console.log(
    `## cost by model (cache write 5m 1.25x / 1h 2x, read 0.1x of base input)`,
  );
  console.log(
    pad("model", 27) +
      pad("turns", 7) +
      pad("input", 9) +
      pad("w5m", 9) +
      pad("w1h", 9) +
      pad("reads", 10) +
      pad("output", 9) +
      "est",
  );
  const costRank = (b) => (b.cost === null ? -1 : b.cost);
  for (const [model, b] of [...byModel.entries()].sort(
    (x, y) => costRank(y[1]) - costRank(x[1]),
  ))
    console.log(
      pad(model.slice(0, 26), 27) +
        pad(b.turns, 7) +
        pad(fmtK(b.input), 9) +
        pad(fmtK(b.write5m), 9) +
        pad(fmtK(b.write1h), 9) +
        pad(fmtK(b.cacheRead), 10) +
        pad(fmtK(b.output), 9) +
        (b.cost === null
          ? "(no price row — excluded from est. cost)"
          : fmtUSD(b.cost)),
    );
  console.log("");
}

if (byDay.size > 0) {
  console.log("## by day");
  for (const [day, b] of [...byDay.entries()].sort())
    console.log(
      `${day}  turns ${pad(b.turns, 6)} output ${pad(fmtK(b.output), 8)} fresh ${pad(fmtK(b.freshIn), 8)} cache reads ${pad(fmtK(b.cacheRead), 9)} est ${fmtUSD(b.cost)}`,
    );
  console.log("");
}

bySession.sort((a, b) => (a.firstTs ?? "").localeCompare(b.firstTs ?? ""));
if (bySession.length > 0) {
  console.log("## by session (작업 단위, 시간순 전체)");
  for (const s of bySession) {
    const sub =
      s.subagent.turns > 0
        ? ` · sub ${fmtK(s.subagent.output + s.subagent.freshIn)}`
        : "";
    console.log(
      `${s.firstTs ? localDay(s.firstTs) : "????-??-??"}  ${s.id.slice(0, 8)}  ${pad(
        `"${(s.title ?? "(제목 없음)").slice(0, 30)}"`,
        34,
      )} turns ${pad(s.main.turns, 5)} output ${pad(fmtK(s.main.output), 8)} fresh ${pad(
        fmtK(s.main.freshIn),
        8,
      )} cache reads ${pad(fmtK(s.main.cacheRead), 9)} peak ${pad(fmtK(s.peak), 7)} est ${fmtUSD(
        s.main.cost + s.subagent.cost,
      )}${sub}`,
    );
  }
  console.log("");
}

console.log(
  `## patterns (${opt.full ? `all ${rows.length}` : `top ${opt.top}`})`,
);
console.log(
  pad("pattern", 28) +
    pad("calls", 7) +
    pad("~tok", 9) +
    (opt.precise ? pad("precise", 9) : "") +
    pad("share", 7) +
    "sessions",
);
for (const r of opt.full ? rows : rows.slice(0, opt.top)) {
  console.log(
    pad(r.label, 28) +
      pad(r.calls, 7) +
      pad(fmtK(r.tokens), 9) +
      (opt.precise ? pad(fmtK(r.preciseTokens), 9) : "") +
      pad(`${r.sharePct}%`, 7) +
      r.sessions,
  );
}

if (proposals.length > 0) {
  console.log(`\n## proposals`);
  for (const p of proposals) console.log(`[${p.kind}] ${p.pattern} — ${p.why}`);
}

// ---- plugin report (opt-in): hook-effect sections ------------------------------
if (opt.pluginReport) {
  if (!pluginDataPresent) {
    console.log(
      `\n## plugin report\n(no output-cap/deny markers in this period — agent-context-protector hooks appear inactive; plugin sections skipped)`,
    );
  } else {
    if (caps.size > 0) {
      console.log(
        `\n## output-cap ledger (saved $ = dropped tok x (1h write 2x + read 0.1x x measured remaining turns), main-chain)`,
      );
      for (const [label, c] of [...caps.entries()].sort(
        (a, b) => b[1].droppedChars - a[1].droppedChars,
      )) {
        const s = capSavings.get(label);
        const saved = s
          ? s.unpriced > 0 && s.saved === 0
            ? " → saved: (unpriced model)"
            : ` → est saved ${fmtUSD(s.saved)}`
          : ""; // sidechain-only pattern: ledger row without main-chain savings
        console.log(
          `${pad(label, 28)} capped ${c.events}x, dropped ~${fmtK(Math.round(c.droppedChars / 4))} tok${saved}`,
        );
      }
      if (capSavedTotal > 0)
        console.log(`output-cap subtotal: est saved ${fmtUSD(capSavedTotal)}`);
    }
    if (denies.size > 0) {
      console.log(
        `\n## deny ledger (input-gate; $ not quantified — blocked before execution, size unrecorded)`,
      );
      for (const [rule, n] of [...denies.entries()].sort((a, b) => b[1] - a[1]))
        console.log(`${pad(String(n) + "x", 6)}${rule}`);
      if (denyRetries.total > 0)
        console.log(
          `deny→retry: ${denyRetries.retried}/${denyRetries.total} denies followed by a same-family retry (retry = the suggested bounded alternative was taken)`,
        );
    }
    const hasIneff =
      gatePromotions.length > 0 ||
      denyRetries.abandoned.length > 0 ||
      ruleActivity.some((a) => a.calls > 0 && a.caps === 0 && a.denies === 0);
    if (hasIneff) {
      console.log(`\n## plugin inefficiencies`);
      for (const p of gatePromotions)
        console.log(`[${p.kind}] ${p.pattern} — ${p.why}`);
      for (const ev of denyRetries.abandoned)
        console.log(
          `[no-retry] ${ev.label} — denied (${ev.ruleKey.trim()}) and never retried in that session; the rule message may not offer a usable alternative, or the task was dropped`,
        );
      const quiet = ruleActivity.filter(
        (a) => a.calls > 0 && a.caps === 0 && a.denies === 0,
      );
      if (quiet.length > 0)
        console.log(
          `[quiet-rules] traffic but no intervention this period (bounded usage, or thresholds never reached): ${quiet
            .map((a) => `${a.family} (${a.calls} calls)`)
            .join(", ")}`,
        );
    }
  }
}
if (opt.precise) {
  const est = rows.reduce((s, r) => s + r.tokens, 0);
  const prec = rows.reduce((s, r) => s + r.preciseTokens, 0);
  if (prec > 0)
    console.log(
      `\n## precise-mode calibration\nchars/4 estimate ${fmtK(est)} tok vs usage-delta ${fmtK(prec)} tok -> ratio ${Math.round((prec / est) * 100) / 100} (main-chain only; deltas also carry user/system text, so treat as upper bound)`,
    );
}

if (opt.json) {
  try {
    writeFileSync(
      opt.json,
      JSON.stringify(
        {
          meta: {
            transcripts: files.length,
            totalChars,
            generatedAt: new Date().toISOString(),
            options: opt,
            priceBasis: PRICE_BASIS,
          },
          usage: { ...usageTotals, peakContext },
          costByModel: Object.fromEntries(byModel),
          byDay: Object.fromEntries([...byDay.entries()].sort()),
          bySession,
          patterns: rows,
          caps: Object.fromEntries(caps),
          denies: Object.fromEntries(denies),
          // both kinds, as before the report split (dashboard handoff shape)
          proposals: [...proposals, ...gatePromotions],
          // plugin-effect data is always computed (cheap) and always in the
          // JSON, regardless of --plugin-report — only console output is gated
          pluginReport: {
            capSavings: Object.fromEntries(capSavings),
            capSavedTotal,
            denyRetries: {
              total: denyRetries.total,
              retried: denyRetries.retried,
              abandoned: denyRetries.abandoned,
            },
            ruleActivity,
          },
        },
        null,
        2,
      ),
    );
    console.log(`\njson written: ${opt.json}`);
  } catch (err) {
    console.error(`cannot write ${opt.json}: ${err?.message ?? err}`);
    process.exit(1);
  }
}
