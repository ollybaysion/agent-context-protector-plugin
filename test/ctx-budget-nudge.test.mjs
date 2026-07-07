// Boundary-nudge tests (issue #21, baseline v2.1) — the numbered groups ①~⑭
// from the issue's acceptance criteria. Unit tests import nudge.mjs directly
// (pure functions); integration tests drive the real ctx-budget.mjs hook as a
// subprocess, statusline-hud.test.mjs style.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchBoundary,
  recordGenStart,
  consumeOnTerminalFire,
  suppressedNamedConsume,
  costSegment,
  terminalMessage,
  startMessage,
  sanitizeLabel,
  ledgerDir,
  GEN_TTL_MS,
} from "../core/ctx-budget/nudge.mjs";
import { priceFor } from "../lib/pricing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CTX = join(here, "..", "core", "ctx-budget", "ctx-budget.mjs");

// ---- helpers ------------------------------------------------------------------

const mb = (cmd, out = "", err = "") => matchBoundary("Bash", cmd, out, err);

let seq = 0;
function freshTranscript(tokens, model = "claude-fable-5") {
  const dir = join(tmpdir(), "acp-test", `nudge-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const tp = join(dir, `t-${seq++}-${Date.now()}.jsonl`);
  writeFileSync(
    tp,
    JSON.stringify({
      message: {
        usage: { input_tokens: tokens },
        model,
        content: [{ type: "text", text: "ok" }],
      },
    }) + "\n",
  );
  return tp;
}

// Every hook subprocess gets the ledger pinned into a per-run sandbox: without
// this, each `npm test` run would append its fixture nudges to the REAL
// persistent ledger and poison the compliance measurement (issue #31 — the
// live ledger was 223/224 fixture lines before this pin existed).
const DATA_DIR = join(tmpdir(), "acp-test", `nudge-data-${process.pid}`);

function runHook(tp, { command, stdout = "", stderr = "", env = {}, event } = {}) {
  const payload = event ?? {
    transcript_path: tp,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout, stderr, interrupted: false },
  };
  // Strip any ACP_* leaking from the invoking shell, then pin the knobs the
  // assertions depend on — a stray ACP_CTX_BUDGET_STEP=5 in the environment
  // must not silently disarm a regression guard (review f5).
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("ACP_")),
  );
  const raw = execFileSync(process.execPath, [CTX], {
    input: JSON.stringify(payload),
    env: {
      ...base,
      ACP_CTX_BUDGET_WINDOW: "1000000",
      ACP_CTX_BUDGET_STEP: "10",
      ACP_CTX_BUDGET_DATA_DIR: DATA_DIR,
      // Kill the NudgeFired emit so `npm test` can never inject fixture events
      // into a live collector on 127.0.0.1:4090 (issue #32 F1 — the DATA_DIR
      // pin above guards the ledger; this guards the OTHER measurement channel).
      ACP_CTX_BUDGET_OBS: "0",
      ...env,
    },
    encoding: "utf8",
  });
  if (!raw.trim()) return null;
  return JSON.parse(raw).systemMessage ?? null;
}

const stateFile = (tp) =>
  join(
    tmpdir(),
    "acp",
    "ctx-budget",
    `${createHash("sha1").update(tp).digest("hex").slice(0, 16)}.json`,
  );
const readState = (tp) => JSON.parse(readFileSync(stateFile(tp), "utf8"));

// ---- ① rule evidence, positive/negative ----------------------------------------

test("① pr-create fires on PR URL, silent without it", () => {
  assert.ok(mb("gh pr create --title x", "https://github.com/o/r/pull/60\n"));
  assert.equal(mb("gh pr create --title x", "some other output"), null);
});

test("① git-pull fires on Fast-forward/Updating, silent on Already up to date", () => {
  assert.ok(mb("git pull", "Updating a1b2c3..d4e5f6\nFast-forward\n"));
  assert.ok(mb("git pull origin main", "Fast-forward\n"));
  assert.equal(mb("git pull", "Already up to date.\n"), null);
});

test("① branch-del fires on Deleted branch and captures the name", () => {
  const m = mb("git branch -d feat/issue-57", "Deleted branch feat/issue-57 (was c7ed6f7).\n");
  assert.ok(m);
  assert.equal(m.capture.drop, "feat/issue-57");
  assert.deepEqual(m.capture.deletedBranches, ["feat/issue-57"]);
  assert.equal(mb("git branch -d feat/x", "error: branch not found"), null);
  // batch deletion captures the FULL list (Phase 0 (d)② repair 2)
  const batch = mb(
    "git branch -D feat/a && git branch -D feat/y",
    "Deleted branch feat/a (was 111).\nDeleted branch feat/y (was 222).\n",
  );
  assert.deepEqual(batch.capture.deletedBranches, ["feat/a", "feat/y"]);
});

test("① checkout-b/switch -c evidence lives on STDERR (pinned live)", () => {
  const m = mb("git checkout -b feat/issue-58", "", "Switched to a new branch 'feat/issue-58'\n");
  assert.ok(m);
  assert.equal(m.rule.kind, "start");
  assert.deepEqual(m.capture.gen, { label: "feat/issue-58", src: "branch" });
  // same text on stdout must NOT fire — stream discipline
  assert.equal(mb("git checkout -b feat/issue-58", "Switched to a new branch 'feat/issue-58'\n", ""), null);
  assert.ok(mb("git switch -c feat/issue-59", "", "Switched to a new branch 'feat/issue-59'\n"));
});

test("① worktree-add fires on stdout evidence; -b branch beats path basename", () => {
  const withB = mb(
    "git -C /home/u/repo worktree add ../repo-analyze -b feat/analyze",
    "Preparing worktree (new branch 'feat/analyze')\n",
  );
  assert.deepEqual(withB.capture.gen, { label: "feat/analyze", src: "branch" });
  const noB = mb("git worktree add ../repo-hotfix", "Preparing worktree (checking out 'main')\n");
  assert.deepEqual(noB.capture.gen, { label: "repo-hotfix", src: "basename" });
  // unexpanded shell vars: stdout-first capture resolves them to the REAL
  // branch git announced (Phase 0 (d)① artifact fixed at the source)
  const dollar = mb('git worktree add "$WT" -b "$BR"', "Preparing worktree (new branch 'feat/real')\n");
  assert.deepEqual(dollar.capture.gen, { label: "feat/real", src: "branch" });
  // argv fallback (no new-branch line): value-flags skipped, quoted fragments
  // refused -> capture failure, never a 'temp' garbage label (review f8)
  const flags = mb(
    'git worktree add --lock --reason "temp work" ../wt-x',
    "Preparing worktree (checking out 'main')\n",
  );
  assert.ok(flags);
  assert.equal(flags.capture.gen, undefined);
});

// ---- ② pr-merge: exit-0 + last-segment evidence (gh is SILENT on success in
// a non-TTY hook subprocess — pinned against gh source + a real merge payload;
// review f2) --------------------------------------------------------------------

test("② pr-merge fires on empty output when it is the last segment", () => {
  const m = mb("gh pr merge 60 --squash", "", ""); // realistic payload: silence
  assert.ok(m);
  assert.equal(m.capture.drop, "PR #60"); // captured from argv, not output
  // not the last segment -> the exit code no longer proves the merge -> silent
  assert.equal(mb("gh pr merge 60; echo done", "done\n"), null);
  // auto-merge toggle-OFF is not a merge
  assert.equal(mb("gh pr merge 61 --disable-auto", ""), null);
  // URL argument capture
  const url = mb("gh pr merge https://github.com/o/r/pull/62 --merge", "");
  assert.equal(url.capture.drop, "PR #62");
});

// ---- ③ git -C forms -------------------------------------------------------------

test("③ git -C DIR forms are detected (mined trap: 0 detections without it)", () => {
  assert.ok(mb("git -C /home/u/repo pull", "Fast-forward\n"));
  assert.ok(mb("git -C /home/u/repo branch -D feat/x", "Deleted branch feat/x (was abc).\n"));
  // quoted -C path with spaces must not cut the prefix match (review f7)
  assert.ok(mb('git -C "/home/my repo" pull', "Fast-forward\n"));
});

test("③′ start-rule spelling variants: checkout -B, switch --create (review f7)", () => {
  assert.ok(mb("git checkout -B feat/x", "", "Switched to a new branch 'feat/x'\n"));
  assert.ok(mb("git switch --create feat/y", "", "Switched to a new branch 'feat/y'\n"));
  // -B onto an EXISTING branch prints "Switched to and reset" -> evidence gate holds
  assert.equal(mb("git checkout -B feat/x", "", "Switched to and reset branch 'feat/x'\n"), null);
});

// ---- ④ segment anchor -----------------------------------------------------------

test("④ quoted mentions do not fire (segment-anchored)", () => {
  assert.equal(mb('echo "gh pr create is fun"', "https://github.com/o/r/pull/9"), null);
  // but a real segment after && does
  assert.ok(mb("git add -A && gh pr create", "https://github.com/o/r/pull/9"));
});

// ---- ⑩ genStart lifetime rules ---------------------------------------------------

test("⑩(a) standard cycle: keep never names completed work; genDone inherits to drop", () => {
  const t = 1_000_000;
  let s = recordGenStart({}, { label: "feat/issue-57", src: "branch" }, t);
  assert.equal(s.genStart.label, "feat/issue-57");

  // pr-create fires: unconditional consume -> keep generic, drop captured
  let r = consumeOnTerminalFire(s, { drop: "PR #60" }, t + 1000);
  assert.equal(r.keepLabel, null); // never "feat/issue-57" — that work just ended
  assert.deepEqual(r.drop, { label: "PR #60", form: "captured" });
  assert.equal(r.state.genStart, undefined);
  assert.equal(r.state.genDone.label, "feat/issue-57");

  // cleanup pull fires: no capture -> inherited CONDITIONAL drop
  r = consumeOnTerminalFire(r.state, {}, t + 2000);
  assert.equal(r.keepLabel, null);
  assert.deepEqual(r.drop, { label: "feat/issue-57", form: "inherited" });

  // next setup -> new generation
  s = recordGenStart(r.state, { label: "feat/issue-58", src: "branch" }, t + 3000);
  r = consumeOnTerminalFire(s, { drop: "PR #61" }, t + 4000);
  assert.equal(r.keepLabel, null);
  assert.equal(r.state.genDone.label, "feat/issue-58");
});

test("⑩(b) branch-del mismatch survival — branch-sourced only", () => {
  const t = 1_000_000;
  const s = recordGenStart({}, { label: "feat/issue-58", src: "branch" }, t);
  // deleting a DIFFERENT branch: the only positive evidence of another unit
  let r = consumeOnTerminalFire(
    s,
    { drop: "feat/issue-57", deletedBranches: ["feat/issue-57"] },
    t + 1000,
  );
  assert.equal(r.keepLabel, "feat/issue-58"); // survives -> named keep
  assert.equal(r.state.genStart.label, "feat/issue-58");
  // basename-sourced label is incomparable -> consume (conservative)
  const sb = recordGenStart({}, { label: "repo-analyze", src: "basename" }, t);
  r = consumeOnTerminalFire(sb, { drop: "feat/x", deletedBranches: ["feat/x"] }, t + 1000);
  assert.equal(r.keepLabel, null);
  assert.equal(r.state.genStart, undefined);
});

test("⑩(h) batch deletion containing genStart forbids survival (repair 2)", () => {
  const t = 1_000_000;
  const s = recordGenStart({}, { label: "feat/issue-58", src: "branch" }, t);
  const r = consumeOnTerminalFire(
    s,
    { drop: "feat/a", deletedBranches: ["feat/a", "feat/issue-58"] },
    t + 1000,
  );
  assert.equal(r.keepLabel, null); // real transcript 6d544728 regression guard
  assert.equal(r.state.genStart, undefined);
  assert.equal(r.state.genDone.label, "feat/issue-58");
});

test("⑩(g) suppressed-named-consume (repair 1): naming payload consumes silently, pull cannot", () => {
  const t = 1_000_000;
  const s = recordGenStart({}, { label: "feat/issue-58", src: "branch" }, t);
  // pr-create names the branch via --head / push -u
  const m = mb(
    "git push -u origin feat/issue-58 && gh pr create --head feat/issue-58",
    "https://github.com/o/r/pull/40\n",
  );
  assert.ok(m.capture.namedRefs.includes("feat/issue-58"));
  let r = suppressedNamedConsume(s, m.capture, t + 1000);
  assert.equal(r.consumed, true);
  assert.equal(r.state.genStart, undefined);
  assert.equal(r.state.genDone.label, "feat/issue-58");
  // a plain pull names nothing -> rule 3's original protection intact
  const pull = mb("git pull", "Fast-forward\n");
  r = suppressedNamedConsume(s, pull.capture, t + 1000);
  assert.equal(r.consumed, false);
  assert.equal(r.state.genStart.label, "feat/issue-58");
});

test("⑩(d) TTL: stale genStart/genDone are ignored and dropped", () => {
  const t = 10 * GEN_TTL_MS;
  const s = { genStart: { label: "feat/old", src: "branch", ts: t - GEN_TTL_MS - 1 } };
  const r = consumeOnTerminalFire(s, {}, t);
  assert.equal(r.keepLabel, null);
  assert.equal(r.state.genStart, undefined);
  assert.equal(r.state.genDone, undefined); // expired label is NOT inherited
  assert.equal(r.drop, null); // -> generic sentence
});

test("⑩(e) label sanitize + overwrite by newer signal", () => {
  assert.equal(sanitizeLabel("feat/issue-58"), "feat/issue-58");
  assert.equal(sanitizeLabel("evil `rm -rf`[31m label"), "evilrm-rf31mlabel");
  assert.equal(sanitizeLabel("x".repeat(60))?.length, 40);
  const s1 = recordGenStart({}, { label: "feat/a", src: "branch" }, 1000);
  const s2 = recordGenStart(s1, { label: "feat/b", src: "branch" }, 2000);
  assert.equal(s2.genStart.label, "feat/b");
});

test("⑩(f) n3 hotfix interleave: mis-consumed genDone only ever drops CONDITIONALLY", () => {
  const t = 1_000_000;
  // setup #58 in progress; a hotfix PR (no start signal) consumes it
  let s = recordGenStart({}, { label: "feat/issue-58", src: "branch" }, t);
  let r = consumeOnTerminalFire(s, { drop: "PR #99" }, t + 1000);
  assert.equal(r.state.genDone.label, "feat/issue-58"); // mislabeled: #58 still running
  // the later pull may only use it in the conditional form — never assertive
  r = consumeOnTerminalFire(r.state, {}, t + 2000);
  assert.equal(r.drop.form, "inherited");
  const msg = terminalMessage({
    ruleLabel: "머지 반영 감지(git pull 새 커밋)",
    ctxTokens: 320000,
    cost: "",
    keepLabel: r.keepLabel,
    drop: r.drop,
  });
  assert.ok(msg.includes("feat/issue-58 작업이 이미 완료·마무리되었다면"));
  assert.ok(!msg.includes("방금 완료된 작업 feat/issue-58"));
});

test("f4: a chained cleanup one-liner fires ONE terminal nudge yet still marks the new generation", () => {
  const chain =
    "git pull && git branch -d feat/issue-57 && git worktree add ../wt-58 -b feat/issue-58";
  const out =
    "Fast-forward\nDeleted branch feat/issue-57 (was abc).\nPreparing worktree (new branch 'feat/issue-58')\n";
  const m = mb(chain, out);
  assert.equal(m.rule.key, "git-pull"); // first terminal rule wins the fire
  assert.deepEqual(m.capture.deletedBranches, ["feat/issue-57"]); // merged evidence
  assert.deepEqual(m.startGen, { label: "feat/issue-58", src: "branch" }); // rule 1 held
});

test("f4 e2e: chained one-liner — consume old, then record new (order matters)", () => {
  const tp = freshTranscript(300000);
  // establish generation 57 first (below-cooldown marking is fine)
  runHook(tp, {
    command: "git checkout -b feat/issue-57",
    stderr: "Switched to a new branch 'feat/issue-57'\n",
    env: { ACP_CTX_BUDGET_NUDGE_MIN_TOK: "999999999" }, // marking only, no fire
  });
  assert.equal(readState(tp).genStart.label, "feat/issue-57");
  const msg = runHook(tp, {
    command:
      "git pull && git branch -d feat/issue-57 && git worktree add ../wt-58 -b feat/issue-58",
    stdout:
      "Fast-forward\nDeleted branch feat/issue-57 (was abc).\nPreparing worktree (new branch 'feat/issue-58')\n",
  });
  assert.ok(msg.includes("작업 경계 감지")); // ONE terminal nudge
  assert.ok(!msg.includes("진행 중 작업 #57")); // consumed 57 never surfaces as keep
  const st = readState(tp);
  assert.equal(st.genStart.label, "feat/issue-58"); // new gen survived its own fire
  assert.equal(st.genDone.label, "feat/issue-57");
});

test("f3: sidechain (agent_id on stdin) never touches boundary logic or genStart", () => {
  const tp = freshTranscript(320000);
  const msg = runHook(tp, {
    event: {
      transcript_path: tp,
      tool_name: "Bash",
      agent_id: "a1234567890abcdef",
      agent_type: "workflow-subagent",
      tool_input: { command: "git worktree add ../x -b feat/sub" },
      tool_response: { stdout: "Preparing worktree (new branch 'feat/sub')\n", stderr: "" },
    },
  });
  assert.ok(msg === null || !msg.includes("새 작업 시작 감지"));
  assert.ok(!existsSync(stateFile(tp)) || readState(tp).genStart === undefined);
});

test("f6: no readable usage entry still records a start signal (rule 1)", () => {
  const dir = join(tmpdir(), "acp-test", `nudge-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const tp = join(dir, `t-nousage-${Date.now()}.jsonl`);
  writeFileSync(tp, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  const msg = runHook(tp, {
    command: "git checkout -b feat/quiet-start",
    stderr: "Switched to a new branch 'feat/quiet-start'\n",
  });
  assert.equal(msg, null); // gate unjudgeable -> no nudge
  assert.equal(readState(tp).genStart.label, "feat/quiet-start"); // but marked
});

// ---- ⑦⑧⑨ template invariants ---------------------------------------------------

test("⑦ keep clause is present in both templates (structural constant)", () => {
  const tm = terminalMessage({ ruleLabel: "PR 생성 감지", ctxTokens: 300000, cost: "", keepLabel: null, drop: null });
  assert.ok(tm.includes("그대로 보존"));
  assert.ok(tm.includes("/compact 진행 중 작업의"));
  const sm = startMessage({ genLabel: "feat/issue-99", ruleLabel: "x", ctxTokens: 300000, cost: "" });
  assert.ok(sm.includes("그대로 보존"));
  assert.ok(sm.includes("#99(feat/issue-99)"));
});

test("⑧ no file path from tool output can reach the message (label slots only)", () => {
  // a pull whose stdout is full of file paths — none may leak into the nudge
  const m = mb("git pull", "Fast-forward\n src/core/deep/file.mjs | 10 ++\n lib/other.mjs | 2 -\n");
  assert.ok(m);
  const msg = terminalMessage({ ruleLabel: m.rule.label, ctxTokens: 320000, cost: "", keepLabel: null, drop: null });
  assert.ok(!msg.includes("file.mjs"));
  assert.ok(!msg.includes("src/core"));
});

test("⑨ capture failure falls back to a complete generic sentence", () => {
  const sm = startMessage({ genLabel: null, ruleLabel: "새 워크트리 시작 감지", ctxTokens: 250000, cost: "" });
  assert.ok(sm.includes("새 작업 시작 감지 (새 워크트리 시작 감지)"));
  assert.ok(sm.includes("/compact 새 작업의 목표"));
});

// ---- ⑭ cost segment --------------------------------------------------------------

test("⑭ cost math: fable-5 @320k warm ≈ ~$0.5, 1-decimal display", () => {
  const c = costSegment({ tokens: 320000, model: "claude-fable-5", priceFor, summaryOutTok: 3000, enabled: true });
  assert.equal(c.costShown, "on");
  assert.equal(c.estUsd, 0.5); // (320k*10*0.1 + 3k*50)/1e6 = 0.47 -> 0.5
  assert.ok(c.segment.includes("~$0.5(warm)"));
});

test("⑭ below $0.10 the display gains a decimal instead of showing ~$0.0", () => {
  const c = costSegment({ tokens: 27000, model: "claude-haiku-4-5-20251001", priceFor, summaryOutTok: 3000, enabled: true });
  assert.equal(c.costShown, "on");
  assert.ok(!c.segment.includes("$0.0(warm)"));
  assert.ok(/\$0\.0\d\(warm\)/.test(c.segment)); // e.g. ~$0.02(warm)
});

test("⑭ unpriced model omits the segment entirely (never guess)", () => {
  const c = costSegment({ tokens: 320000, model: "<synthetic>", priceFor, summaryOutTok: 3000, enabled: true });
  assert.equal(c.costShown, "unpriced");
  assert.equal(c.segment, "");
  assert.equal(c.estUsd, null);
});

test("⑭ env off omits the segment", () => {
  const c = costSegment({ tokens: 320000, model: "claude-fable-5", priceFor, summaryOutTok: 3000, enabled: false });
  assert.equal(c.costShown, "env_off");
  assert.equal(c.segment, "");
});

// ---- ⑤⑥⑪⑫ integration (real hook subprocess) ------------------------------------

test("⑤ absolute floor: 250k fires on a 1M window (old 50% gate would silence it)", () => {
  const tp = freshTranscript(250000);
  const msg = runHook(tp, { command: "gh pr create", stdout: "https://github.com/o/r/pull/60\n" });
  assert.ok(msg.includes("작업 경계 감지 (PR 생성 감지)"));
  assert.ok(msg.includes("~$")); // cost segment on by default for fable-5
  assert.ok(msg.includes("복붙용"));
});

test("⑤ below the floor stays silent on the boundary channel", () => {
  const tp = freshTranscript(150000);
  const msg = runHook(tp, { command: "gh pr create", stdout: "https://github.com/o/r/pull/61\n" });
  // tier alert may fire (15% -> tier 10) but no boundary nudge
  assert.ok(msg === null || !msg.includes("작업 경계 감지"));
});

test("⑤ 200k-window default floor preserves the old 50% behaviour", () => {
  const tp = freshTranscript(120000);
  const msg = runHook(tp, {
    command: "gh pr create",
    stdout: "https://github.com/o/r/pull/62\n",
    env: { ACP_CTX_BUDGET_WINDOW: "200000" },
  });
  assert.ok(msg.includes("작업 경계 감지")); // 120k >= min(200k, 100k)
});

test("⑥ shared cooldown collapses a cluster to one nudge — and a suppressed terminal match must NOT consume genStart (rule 3)", () => {
  const tp = freshTranscript(300000);
  // 1st: worktree add fires the start template and records genStart
  const m1 = runHook(tp, {
    command: "git worktree add ../repo-issue-77 -b feat/issue-77",
    stdout: "Preparing worktree (new branch 'feat/issue-77')\n",
  });
  assert.ok(m1.includes("새 작업 시작 감지 (feat/issue-77)"));
  assert.equal(readState(tp).genStart.label, "feat/issue-77");
  // 2nd within cooldown: pull matches but is suppressed -> genStart untouched
  const m2 = runHook(tp, { command: "git pull", stdout: "Fast-forward\n" });
  assert.ok(m2 === null || !m2.includes("작업 경계 감지"));
  assert.equal(readState(tp).genStart.label, "feat/issue-77");
});

test("⑩(g) e2e: micro PR cycle — suppressed pr-create consumes genStart, later branch-del cannot mislabel keep", () => {
  const tp = freshTranscript(300000);
  // start fires (cooldown opens) and records genStart
  runHook(tp, {
    command: "git checkout -b feat/issue-58",
    stderr: "Switched to a new branch 'feat/issue-58'\n",
  });
  assert.equal(readState(tp).genStart.label, "feat/issue-58");
  // within the cooldown: pr-create naming the branch — suppressed but consumes
  const m2 = runHook(tp, {
    command: "git push -u origin feat/issue-58 && gh pr create --head feat/issue-58",
    stdout: "https://github.com/o/r/pull/40\n",
  });
  assert.ok(m2 === null || !m2.includes("작업 경계 감지"));
  const st = readState(tp);
  assert.equal(st.genStart, undefined); // consumed (real transcripts 099c99db/6d544728 regression)
  assert.equal(st.genDone.label, "feat/issue-58");
});

test("⑥′ terminal-first order: a suppressed start match still records genStart (rule 1)", () => {
  const tp = freshTranscript(300000);
  const m1 = runHook(tp, { command: "git pull", stdout: "Fast-forward\n" });
  assert.ok(m1.includes("작업 경계 감지")); // terminal fires first, cooldown opens
  const m2 = runHook(tp, {
    command: "git worktree add ../wt-90 -b feat/issue-90",
    stdout: "Preparing worktree (new branch 'feat/issue-90')\n",
  });
  assert.ok(m2 === null || !m2.includes("새 작업 시작 감지")); // suppressed...
  assert.equal(readState(tp).genStart.label, "feat/issue-90"); // ...but marked
});

test("⑫′ log path unwritable: nudge still goes out (fail-open, review f5)", () => {
  const iso = join(tmpdir(), "acp-test", `nudge-failopen-${process.pid}-${Date.now()}`);
  // occupy the ledger FILE path with a DIRECTORY -> appendFileSync EISDIR
  mkdirSync(join(iso, "nudges.jsonl"), { recursive: true });
  const tp = freshTranscript(320000);
  const msg = runHook(tp, {
    command: "gh pr create",
    stdout: "https://github.com/o/r/pull/70\n",
    env: { ACP_CTX_BUDGET_DATA_DIR: iso },
  });
  assert.ok(msg.includes("작업 경계 감지")); // message survives the log failure
});

test("⑪ start template: keep = new label, drop is completion-scoped generic", () => {
  const tp = freshTranscript(280000);
  const msg = runHook(tp, {
    command: "git checkout -b feat/issue-91",
    stderr: "Switched to a new branch 'feat/issue-91'\n",
  });
  assert.ok(msg.includes("새 작업 시작 감지 (feat/issue-91)"));
  assert.ok(msg.includes("#91(feat/issue-91)"));
  assert.ok(msg.includes("직전 탐색 내용은 그대로 보존"));
  assert.ok(msg.includes("이미 완료·마무리된 과거 작업"));
});

test("⑪ start marking happens even below the firing floor (lifetime rule 1)", () => {
  const tp = freshTranscript(50000); // far below 200k -> no nudge
  const msg = runHook(tp, {
    command: "git checkout -b feat/quiet",
    stderr: "Switched to a new branch 'feat/quiet'\n",
  });
  assert.ok(msg === null || !msg.includes("작업 경계 감지"));
  assert.equal(readState(tp).genStart.label, "feat/quiet");
});

test("⑫ nudge log line lands with byteOffset + cost fields (fail-open elsewhere)", () => {
  const tp = freshTranscript(320000);
  runHook(tp, { command: "gh pr create", stdout: "https://github.com/o/r/pull/63\n" });
  const hash = createHash("sha1").update(tp).digest("hex").slice(0, 16);
  const log = readFileSync(join(DATA_DIR, "nudges.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.transcriptHash === hash);
  assert.equal(log.length, 1);
  const e = log[0];
  assert.equal(e.kind, "pr-create");
  assert.equal(e.template, "terminal");
  assert.equal(e.dropLabel, "PR #63");
  assert.equal(e.dropForm, "captured");
  assert.ok(e.byteOffset > 0);
  assert.equal(e.costShown, "on");
  assert.equal(e.estUsd, 0.5);
  assert.equal(e.model, "claude-fable-5");
});

// ---- ledger location (issue #31) --------------------------------------------

test("ledger dir resolution: override > XDG_DATA_HOME > ~/.local/share > null", () => {
  assert.equal(ledgerDir({ ACP_CTX_BUDGET_DATA_DIR: "/x/y" }, "/home/u"), "/x/y");
  assert.equal(
    ledgerDir({ XDG_DATA_HOME: "/xdg" }, "/home/u"),
    join("/xdg", "acp", "ctx-budget"),
  );
  assert.equal(
    ledgerDir({}, "/home/u"),
    join("/home/u", ".local", "share", "acp", "ctx-budget"),
  );
  // empty strings are "unset", never a relative-path ledger
  assert.equal(
    ledgerDir({ ACP_CTX_BUDGET_DATA_DIR: "", XDG_DATA_HOME: "" }, "/home/u"),
    join("/home/u", ".local", "share", "acp", "ctx-budget"),
  );
  // relative values are ignored like unset ones (XDG spec) — no cwd-relative ledger
  assert.equal(
    ledgerDir({ ACP_CTX_BUDGET_DATA_DIR: "rel/dir", XDG_DATA_HOME: "also-rel" }, "/home/u"),
    join("/home/u", ".local", "share", "acp", "ctx-budget"),
  );
  assert.equal(ledgerDir({}, ""), null); // nowhere to write -> caller skips
});

test("ledger default path e2e: without the override the XDG data dir is used", () => {
  const xdg = join(tmpdir(), "acp-test", `nudge-xdg-${process.pid}-${Date.now()}`);
  const tp = freshTranscript(320000);
  runHook(tp, {
    command: "gh pr create",
    stdout: "https://github.com/o/r/pull/65\n",
    env: { ACP_CTX_BUDGET_DATA_DIR: "", XDG_DATA_HOME: xdg },
  });
  const hash = createHash("sha1").update(tp).digest("hex").slice(0, 16);
  const lines = readFileSync(join(xdg, "acp", "ctx-budget", "nudges.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.transcriptHash === hash);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].dropLabel, "PR #65");
});

test("⑭ env ACP_CTX_BUDGET_NUDGE_COST=0 removes the cost segment end-to-end", () => {
  const tp = freshTranscript(320000);
  const msg = runHook(tp, {
    command: "gh pr create",
    stdout: "https://github.com/o/r/pull/64\n",
    env: { ACP_CTX_BUDGET_NUDGE_COST: "0" },
  });
  assert.ok(msg.includes("작업 경계 감지"));
  assert.ok(!msg.includes("압축 추정"));
});

test("UserPromptSubmit (no tool payload) never touches boundary logic", () => {
  const tp = freshTranscript(320000);
  const msg = runHook(tp, {
    event: { transcript_path: tp, hook_event_name: "UserPromptSubmit", prompt: "gh pr create 라니까" },
  });
  assert.ok(msg === null || !msg.includes("작업 경계 감지"));
});
