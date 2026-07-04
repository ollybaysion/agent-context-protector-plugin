#!/usr/bin/env node
// core/analyze: human-invoked offline diagnostics over Claude Code transcript
// JSONL files. NOT a hook — no hooks.json wiring; run it yourself:
//
//   node core/analyze/analyze.mjs [--project <dir-name>] [--since <ISO>]
//                                 [--top N] [--json out.json] [--precise]
//
// Reports (all read-only over ~/.claude/projects/*/*.jsonl):
//   1. per-pattern cumulative spend (calls, chars, ~tokens, share, sessions)
//   2. cap/deny ledger — output-cap markers and input-gate denies per pattern
//   3. rule proposals — heavy ungated patterns and repeatedly-capped patterns
//   4. --precise: usage-delta token attribution (billed-token based) and its
//      deviation from the chars/4 estimate
//
// Totals are cumulative HISTORY spend (no compact-boundary reset — that
// matters for live-context attribution, not for "what has been costing us").
// Pattern totals include sidechain (subagent) traffic — it is real spend;
// --precise uses main-chain entries only, since usage deltas are per-context.

import { readdirSync, statSync, createReadStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { toolPattern } from "../../lib/patterns.mjs";

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = { project: null, since: null, top: 20, json: null, precise: false, full: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--project") opt.project = args[++i];
  else if (a === "--since") opt.since = new Date(args[++i]).getTime();
  else if (a === "--top") {
    const n = Number(args[++i]);
    opt.top = Number.isFinite(n) && n >= 0 ? n : 20; // 0 is a valid choice
  }
  else if (a === "--json") opt.json = args[++i];
  else if (a === "--precise") opt.precise = true;
  else if (a === "--full") opt.full = true; // every pattern row, no top-N cut
  else if (a === "--help" || a === "-h") {
    console.log(
      "usage: analyze.mjs [--project <dir-name>] [--since <ISO>] [--top N | --full] [--json out.json] [--precise]",
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
const ROOT = process.env.ACP_ANALYZE_ROOT || join(homedir(), ".claude", "projects");
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
    for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) files.push(join(dir, f));
  }
} catch (err) {
  console.error(`cannot read ${ROOT}: ${err?.message ?? err}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`no transcripts found${opt.project ? ` for project ${opt.project}` : ""}`);
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

const pat = (label) => {
  let e = patterns.get(label);
  if (!e) patterns.set(label, (e = { calls: 0, chars: 0, sessions: new Set(), preciseTokens: 0 }));
  return e;
};

const CAP_MARKER = /output-cap: dropped (\d+) of \d+ chars/g;

// Billed-token totals from usage fields. One API response is logged as
// SEVERAL transcript entries (one per content block), each duplicating the
// same usage object — measured 182 usage entries vs 87 distinct message ids
// on a real session — so totals MUST dedupe by message id or they ~double.
const usageTotals = {
  main: { turns: 0, output: 0, freshIn: 0, cacheRead: 0 },
  subagent: { turns: 0, output: 0, freshIn: 0, cacheRead: 0 },
};
let peakContext = { tokens: 0, file: null };
const byDay = new Map(); // "YYYY-MM-DD" (local) -> {turns, output, freshIn, cacheRead}
const bySession = []; // per transcript: {id, title, firstTs, lastTs, main, subagent, peak}

const emptyBucket = () => ({ turns: 0, output: 0, freshIn: 0, cacheRead: 0 });
const addUsage = (bucket, u) => {
  bucket.turns++;
  bucket.output += u.output_tokens ?? 0;
  bucket.freshIn += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  bucket.cacheRead += u.cache_read_input_tokens ?? 0;
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
  const session = {
    id: file.split("/").pop().replace(/\.jsonl$/, ""),
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
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.includes('"ai-title"')) {
        try {
          const t = JSON.parse(line);
          if (t?.type === "ai-title" && typeof t.aiTitle === "string") session.title = t.aiTitle;
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
      if (opt.since !== null && j?.timestamp && Date.parse(j.timestamp) < opt.since) return;
      const sidechain = j?.isSidechain === true;
      const content = j?.message?.content;

      if (j?.type === "assistant" && j?.message?.usage) {
        // No id at all -> treat as unique (never collapse distinct turns).
        const msgId = j.message.id ?? j.uuid ?? null;
        if (msgId === null || !seenMsgIds.has(msgId)) {
          if (msgId !== null) seenMsgIds.add(msgId);
          const u = j.message.usage;
          addUsage(sidechain ? usageTotals.subagent : usageTotals.main, u);
          addUsage(sidechain ? session.subagent : session.main, u);
          if (j.timestamp) {
            session.firstTs = session.firstTs ?? j.timestamp;
            session.lastTs = j.timestamp;
            const day = localDay(j.timestamp);
            if (day) {
              let d = byDay.get(day);
              if (!d) byDay.set(day, (d = emptyBucket()));
              addUsage(d, u);
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
          const { label, inputChars, sidechain: sc } = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          const text = resultText(block);
          if (block.is_error) {
            const m = text.match(/^(input-gate|read-once): ([^.。\n]{0,60})/);
            // Normalize interpolated numbers ("293KB", "1523줄") so each RULE
            // aggregates to one ledger row instead of one row per invocation.
            if (m) {
              const key = m[0].replace(/\d+/g, "N");
              denies.set(key, (denies.get(key) ?? 0) + 1);
            }
            continue; // denied call cost ~nothing; don't count as spend
          }
          const chars = inputChars + text.length;
          const e = pat(label);
          e.calls++;
          e.chars += chars;
          e.sessions.add(file);
          totalChars += chars;
          CAP_MARKER.lastIndex = 0;
          let cm;
          while ((cm = CAP_MARKER.exec(text)) !== null) {
            let c = caps.get(label);
            if (!c) caps.set(label, (c = { events: 0, droppedChars: 0 }));
            c.events++;
            c.droppedChars += Number(cm[1]);
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
              pat(r.label).preciseTokens += (attributable * r.chars) / bucketChars;
            }
          }
        }
        // growth <= 0 means compaction/clear between snapshots -> skip pair
      }
      prev = ev;
      bucket = [];
    }
  }

  if (session.main.turns > 0 || session.subagent.turns > 0) bySession.push(session);
}

for (const f of files) {
  try {
    await scanFile(f);
  } catch (err) {
    console.error(`skip ${f}: ${err?.message ?? err}`);
  }
}

// ---- rule proposals -----------------------------------------------------------
// Pattern families input-gate already covers (deny or measure).
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
]);
const PROPOSE_TOKENS_PER_SESSION = 5000;

const rows = [...patterns.entries()]
  .map(([label, e]) => ({
    label,
    calls: e.calls,
    chars: e.chars,
    tokens: Math.round(e.chars / 4),
    preciseTokens: Math.round(e.preciseTokens),
    sessions: e.sessions.size,
    sharePct: totalChars ? Math.round((e.chars / totalChars) * 1000) / 10 : 0,
  }))
  .sort((a, b) => b.chars - a.chars);

const proposals = [];
for (const r of rows) {
  const perSession = r.tokens / files.length;
  if (perSession > PROPOSE_TOKENS_PER_SESSION && !GATED.has(r.label)) {
    proposals.push({
      kind: "rule-candidate",
      pattern: r.label,
      why: `~${Math.round(perSession / 1000)}k tok/session across ${r.sessions} session(s), no input-gate rule`,
    });
  }
}
for (const [label, c] of caps) {
  if (c.events >= 2) {
    proposals.push({
      kind: "gate-promotion",
      pattern: label,
      why: `output-cap fired ${c.events}x (~${Math.round(c.droppedChars / 4000)}k tok dropped) — a PreToolUse bound would avoid the runs entirely`,
    });
  }
}

// ---- output ---------------------------------------------------------------------
const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
const pad = (s, w) => String(s).padEnd(w);

console.log(`transcripts: ${files.length}   total tool-result chars: ${fmtK(totalChars)} (~${fmtK(Math.round(totalChars / 4))} tok)\n`);

// Billed-token view: what the API actually metered, deduped by message id.
// freshIn = input + cache_creation (tokens entering context anew);
// cacheRead = context re-sent from cache each turn (the per-turn resend the
// whole plugin exists to shrink); output = generated tokens.
{
  const m = usageTotals.main;
  const s = usageTotals.subagent;
  console.log("## usage totals (billed tokens from usage fields, deduped by message id)");
  console.log(
    `main agent: ${m.turns} turns · output ${fmtK(m.output)} · fresh input ${fmtK(m.freshIn)} · cache reads ${fmtK(m.cacheRead)}`,
  );
  if (s.turns > 0)
    console.log(
      `subagents : ${s.turns} turns · output ${fmtK(s.output)} · fresh input ${fmtK(s.freshIn)} · cache reads ${fmtK(s.cacheRead)}`,
    );
  if (peakContext.tokens > 0)
    console.log(
      `peak context: ${fmtK(peakContext.tokens)} tok (${peakContext.file?.split("/").pop() ?? "?"})`,
    );
  console.log("");
}

if (byDay.size > 0) {
  console.log("## by day");
  for (const [day, b] of [...byDay.entries()].sort())
    console.log(
      `${day}  turns ${pad(b.turns, 6)} output ${pad(fmtK(b.output), 8)} fresh ${pad(fmtK(b.freshIn), 8)} cache reads ${fmtK(b.cacheRead)}`,
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
      )} cache reads ${pad(fmtK(s.main.cacheRead), 9)} peak ${fmtK(s.peak)}${sub}`,
    );
  }
  console.log("");
}

console.log(`## patterns (${opt.full ? `all ${rows.length}` : `top ${opt.top}`})`);
console.log(pad("pattern", 28) + pad("calls", 7) + pad("~tok", 9) + (opt.precise ? pad("precise", 9) : "") + pad("share", 7) + "sessions");
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

if (caps.size > 0) {
  console.log(`\n## output-cap ledger`);
  for (const [label, c] of [...caps.entries()].sort((a, b) => b[1].droppedChars - a[1].droppedChars))
    console.log(`${pad(label, 28)} capped ${c.events}x, dropped ~${fmtK(Math.round(c.droppedChars / 4))} tok`);
}
if (denies.size > 0) {
  console.log(`\n## deny ledger`);
  for (const [rule, n] of [...denies.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`${pad(String(n) + "x", 6)}${rule}`);
}
if (proposals.length > 0) {
  console.log(`\n## proposals`);
  for (const p of proposals) console.log(`[${p.kind}] ${p.pattern} — ${p.why}`);
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
          meta: { transcripts: files.length, totalChars, generatedAt: new Date().toISOString(), options: opt },
          usage: { ...usageTotals, peakContext },
          byDay: Object.fromEntries([...byDay.entries()].sort()),
          bySession,
          patterns: rows,
          caps: Object.fromEntries(caps),
          denies: Object.fromEntries(denies),
          proposals,
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
