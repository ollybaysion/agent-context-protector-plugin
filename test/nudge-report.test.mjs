// Tests for the nudge compliance report (#29): window judgment (10 turns /
// 15 min / next-nudge early close), byteOffset-null ts fallback, base rate,
// keep-audit, and the NudgeOutcome push (ephemeral collector + kill switch).
// Fixtures are built in a per-run tmpdir; transcript hashes are computed from
// the FINAL fixture path, mirroring ctx-budget's sha1(path)[0:16].
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  WINDOW_TURNS,
  transcriptHash16,
  loadLedger,
  judgeTranscriptNudges,
  outsideWindowTally,
  auditKeepLabels,
  buildNudgeReport,
} from "../core/analyze/nudge-report.mjs";

const BASE = Date.parse("2026-07-07T15:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

// ---- fixture builders -----------------------------------------------------------

let mseq = 0;
const turnLine = (ts, mid) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp: iso(ts),
    uuid: `u${mseq}`,
    message: { id: mid ?? `m${mseq++}` },
  });
const sideLine = (ts) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: true,
    timestamp: iso(ts),
    message: { id: `side${mseq++}` },
  });
const manualLine = (ts) =>
  JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    timestamp: iso(ts),
    compactMetadata: { trigger: "manual", preTokens: 1 },
  });
const microLine = (ts) =>
  JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: iso(ts) });

/** Join lines into transcript text and return each line's start byte offset. */
function transcript(lines) {
  const offsets = [];
  let off = 0;
  for (const l of lines) {
    offsets.push(off);
    off += Buffer.byteLength(l, "utf8") + 1;
  }
  return { text: lines.join("\n") + "\n", offsets };
}

/** Parse fixture text through the same event extraction the report uses. */
async function eventsOf(dir, name, text) {
  const p = join(dir, name);
  writeFileSync(p, text);
  const { scanTranscriptEvents } = await import("../core/analyze/nudge-report.mjs");
  return scanTranscriptEvents(p);
}

const nudge = (over = {}) => ({
  ts: BASE,
  transcriptHash: "feedfeedfeedfeed",
  kind: "pr-create",
  template: "terminal",
  keepLabel: null,
  dropLabel: null,
  dropForm: null,
  ctxTokens: 100_000,
  byteOffset: 0,
  estUsd: 0.4,
  model: "claude-fable-5",
  costShown: "on",
  ...over,
});

// ---- pure judgment --------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "nudge-report-"));

test("complied: manual compact inside the window", async () => {
  const { text } = transcript([turnLine(BASE + MIN), turnLine(BASE + 2 * MIN), manualLine(BASE + 3 * MIN)]);
  const events = await eventsOf(scratch, "complied.jsonl", text);
  const { verdicts } = judgeTranscriptNudges(events, [nudge()]);
  assert.equal(verdicts[0].complied, true);
  assert.equal(verdicts[0].horizon, "compact");
});

test("micro/auto compactions (no trigger:manual) never count", async () => {
  const { text } = transcript([turnLine(BASE + MIN), microLine(BASE + 2 * MIN)]);
  const events = await eventsOf(scratch, "micro.jsonl", text);
  const { verdicts } = judgeTranscriptNudges(events, [nudge()]);
  assert.equal(verdicts[0].complied, false);
  assert.equal(verdicts[0].horizon, "eof");
});

test("window closes after 10 main-chain turns (distinct message.id, sidechains excluded)", async () => {
  const lines = [];
  for (let i = 0; i < WINDOW_TURNS; i++) {
    lines.push(turnLine(BASE + (i + 1) * 1000, `mid${i}`));
    lines.push(turnLine(BASE + (i + 1) * 1000, `mid${i}`)); // same id — one turn
    lines.push(sideLine(BASE + (i + 1) * 1000)); // sidechain — not a turn
  }
  lines.push(manualLine(BASE + 12_000)); // after the 10th turn: too late
  const events = await eventsOf(scratch, "turns.jsonl", transcript(lines).text);
  const { verdicts } = judgeTranscriptNudges(events, [nudge()]);
  assert.equal(verdicts[0].complied, false);
  assert.equal(verdicts[0].horizon, "turns");
  assert.equal(verdicts[0].turnsSeen, WINDOW_TURNS);
});

test("window closes after 15 minutes", async () => {
  const { text } = transcript([turnLine(BASE + MIN), manualLine(BASE + 16 * MIN)]);
  const events = await eventsOf(scratch, "time.jsonl", text);
  const { verdicts } = judgeTranscriptNudges(events, [nudge()]);
  assert.equal(verdicts[0].complied, false);
  assert.equal(verdicts[0].horizon, "time");
});

test("next nudge closes the previous window early — the later nudge owns the compact", async () => {
  const { text, offsets } = transcript([
    turnLine(BASE + MIN),
    turnLine(BASE + 2 * MIN),
    turnLine(BASE + 6 * MIN), // first event of nudge B's window
    manualLine(BASE + 7 * MIN),
  ]);
  const events = await eventsOf(scratch, "chain.jsonl", text);
  const a = nudge();
  const b = nudge({ ts: BASE + 5 * MIN, byteOffset: offsets[2] });
  const { verdicts } = judgeTranscriptNudges(events, [a, b]);
  assert.equal(verdicts[0].complied, false);
  assert.equal(verdicts[0].horizon, "next-nudge");
  assert.equal(verdicts[1].complied, true);
});

test("byteOffset null degrades to ts: an earlier compact must not count", async () => {
  const { text } = transcript([
    manualLine(BASE - 2 * MIN), // before the nudge — pre-existing compact
    turnLine(BASE + MIN),
    manualLine(BASE + 2 * MIN),
  ]);
  const events = await eventsOf(scratch, "nulloff.jsonl", text);
  const { verdicts } = judgeTranscriptNudges(events, [nudge({ byteOffset: null })]);
  assert.equal(verdicts[0].complied, true);
  assert.equal(verdicts[0].horizon, "compact");
});

test("base rate counts only manual compacts and turns OUTSIDE nudge windows", async () => {
  const { text } = transcript([
    turnLine(BASE + MIN),
    manualLine(BASE + 2 * MIN), // inside (complied)
    turnLine(BASE + 40 * MIN), // outside
    turnLine(BASE + 41 * MIN), // outside
    manualLine(BASE + 42 * MIN), // outside — base-rate evidence
  ]);
  const events = await eventsOf(scratch, "base.jsonl", text);
  const { verdicts, insideSpans } = judgeTranscriptNudges(events, [nudge()]);
  assert.equal(verdicts[0].complied, true);
  const tally = outsideWindowTally(events, insideSpans);
  assert.equal(tally.manuals, 1);
  assert.equal(tally.turns, 2);
});

test("keep-audit flags a complied keepLabel dropped shortly after (n1 tripwire)", async () => {
  const { text, offsets } = transcript([
    turnLine(BASE + MIN),
    manualLine(BASE + 2 * MIN),
    turnLine(BASE + 9 * MIN),
  ]);
  const events = await eventsOf(scratch, "keep.jsonl", text);
  const n1 = nudge({ keepLabel: "feat/issue-58" });
  const n2 = nudge({ ts: BASE + 10 * MIN, byteOffset: offsets[2], dropLabel: "Feat/Issue-58" });
  const { verdicts } = judgeTranscriptNudges(events, [n1, n2]);
  const mis = auditKeepLabels(verdicts);
  assert.equal(mis, 1);
  assert.deepEqual(verdicts[0].keepAudit, { audited: true, misassigned: true });
  assert.deepEqual(verdicts[1].keepAudit, { audited: false, misassigned: false }); // no keepLabel
});

// ---- ledger + full report ---------------------------------------------------------

test("loadLedger tolerates torn lines and honors --since", () => {
  const dir = mkdtempSync(join(tmpdir(), "nudge-ledger-"));
  writeFileSync(
    join(dir, "nudges.jsonl"),
    JSON.stringify(nudge()) + "\n{torn\n" + JSON.stringify(nudge({ ts: BASE + MIN })) + "\n",
  );
  assert.equal(loadLedger(dir).length, 2);
  assert.equal(loadLedger(dir, BASE + 1).length, 1);
  assert.equal(loadLedger("/nonexistent-dir").length, 0);
});

/** Full fixture world: a project root + a ledger, hashes bound to real paths. */
function fixtureWorld() {
  const root = mkdtempSync(join(tmpdir(), "nudge-root-"));
  const proj = join(root, "-home-user-proj");
  mkdirSync(proj);
  const ledger = mkdtempSync(join(tmpdir(), "nudge-ledger-"));

  const t1 = join(proj, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
  writeFileSync(
    t1,
    transcript([turnLine(BASE + MIN), manualLine(BASE + 2 * MIN), turnLine(BASE + 40 * MIN)]).text,
  );
  const t2 = join(proj, "aaaaaaaa-0000-0000-0000-000000000002.jsonl");
  writeFileSync(t2, transcript([turnLine(BASE + MIN)]).text);

  const rows = [
    nudge({ transcriptHash: transcriptHash16(t1) }), // complied
    nudge({ transcriptHash: transcriptHash16(t2), ts: BASE + MIN, template: "start", keepLabel: "feat/x" }), // eof, not complied
    nudge({ transcriptHash: "0000000000000000", ts: BASE + 2 * MIN }), // unmatched (deleted transcript)
  ];
  writeFileSync(join(ledger, "nudges.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { root, proj, ledger, files: [t1, t2], t1, t2 };
}

test("buildNudgeReport: aggregation, segments, unmatched, verdict gate", async () => {
  const w = fixtureWorld();
  const r = await buildNudgeReport({ files: w.files, env: { ACP_CTX_BUDGET_DATA_DIR: w.ledger } });
  assert.equal(r.fires, 3);
  assert.equal(r.judged, 2);
  assert.equal(r.unmatched, 1);
  assert.equal(r.complied, 1);
  assert.equal(r.verdict, "insufficient-sample"); // n 2/20, span ~0d
  assert.equal(r.verdicts.find((v) => v.sessionId.endsWith("1")).complied, true);
  assert.equal(r.verdicts.find((v) => v.sessionId.endsWith("2")).complied, false);
  const segKeys = r.segments.map((s) => s.key);
  assert.ok(segKeys.includes("terminal · generic · on"));
  assert.ok(segKeys.includes("start · labeled · on"));
  // base rate: t1 has 1 outside turn (+40m), 0 outside manuals -> 0
  assert.equal(r.baseRateWindow, 0);
});

test("buildNudgeReport returns null without a ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nudge-empty-"));
  const r = await buildNudgeReport({ files: [], env: { ACP_CTX_BUDGET_DATA_DIR: dir } });
  assert.equal(r, null);
});

// ---- CLI + NudgeOutcome push -------------------------------------------------------

const CLI = new URL("../core/analyze/analyze.mjs", import.meta.url).pathname;

const cliEnv = (w, extraEnv) => ({
  ...process.env,
  ACP_ANALYZE_ROOT: w.root,
  ACP_CTX_BUDGET_DATA_DIR: w.ledger,
  OBS_SOURCE_APP: "nudge-test",
  ...extraEnv,
});

function runCli(w, extraEnv = {}, extraArgs = []) {
  return spawnSync(process.execPath, [CLI, "--top", "0", "--nudge-report", ...extraArgs], {
    encoding: "utf8",
    env: cliEnv(w, extraEnv),
  });
}

// The push tests need the PARENT's event loop alive while the child posts to
// the in-test collector — spawnSync would freeze the accept loop and every
// POST would time out. Async spawn + await exit instead.
function runCliAsync(w, extraEnv = {}, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--top", "0", "--nudge-report", ...extraArgs], {
      env: cliEnv(w, extraEnv),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function collector() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push(null);
      }
      res.statusCode = 202;
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, received })),
  );
}

test("CLI --nudge-report prints the section and embeds it in --json", async () => {
  const w = fixtureWorld();
  const jsonOut = join(w.root, "out.json");
  const r = runCli(w, {}, ["--json", jsonOut]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## nudge compliance/);
  assert.match(r.stdout, /fires 3 · judged 2 · unmatched-transcript 1/);
  const parsed = JSON.parse((await import("node:fs")).readFileSync(jsonOut, "utf8"));
  assert.equal(parsed.nudges.judged, 2);
});

test("CLI --push-outcomes POSTs one NudgeOutcome per judged nudge (receiver contract shape)", async () => {
  const w = fixtureWorld();
  const { srv, port, received } = await collector();
  try {
    const r = await runCliAsync(w, { OBS_PORT: String(port), ACP_CTX_BUDGET_OBS: "" }, ["--push-outcomes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /NudgeOutcome push: 2 attempted/);
    assert.equal(received.length, 2);
    for (const env of received) {
      assert.equal(env.hook_event_type, "NudgeOutcome");
      assert.equal(env.source_app, "nudge-test");
      assert.match(env.session_id, /^aaaaaaaa-/); // transcript uuid, not "unknown"
      // the exact json_extract paths /stats/nudges reads (#63):
      assert.equal(typeof env.payload.ref.transcriptHash, "string");
      assert.ok("byteOffset" in env.payload.ref);
      assert.equal(typeof env.payload.ref.ts, "number");
      assert.equal(typeof env.payload.complied, "boolean");
      assert.equal(typeof env.payload.keepAudit.misassigned, "boolean");
      assert.ok("baseRateWindow" in env.payload);
    }
    const t1v = received.find((e) => e.session_id.endsWith("1"));
    assert.equal(t1v.payload.complied, true);
  } finally {
    srv.close();
  }
});

test("kill switch ACP_CTX_BUDGET_OBS=0 suppresses the push", async () => {
  const w = fixtureWorld();
  const { srv, port, received } = await collector();
  try {
    const r = await runCliAsync(w, { OBS_PORT: String(port), ACP_CTX_BUDGET_OBS: "0" }, ["--push-outcomes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /NudgeOutcome push: skipped/);
    assert.equal(received.length, 0);
  } finally {
    srv.close();
  }
});
