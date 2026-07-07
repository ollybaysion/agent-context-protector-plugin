// Boundary-nudge logic for ctx-budget (issue #21, design baseline v2.1 in the
// issue comments): boundary rule table (terminal/start roles + parameter
// capture), the genStart lifetime rules that keep keep/drop labels
// generation-correct, the two /compact instruction templates, and the
// warm-cache cost-estimate segment. Pure functions only — ctx-budget.mjs owns
// all I/O (state file, transcript, emit), so everything here is unit-testable.
//
// Safety invariants (tested, do not relax):
//   - The keep clause is a template CONSTANT — it cannot be omitted.
//   - No file path ever appears in a nudge: the only dynamic fragments are
//     sanitized labels (branch names / "PR #N") and numbers. A mis-detected
//     boundary therefore costs one harmless generic instruction, nothing worse.
//   - An inherited (genDone) drop label is only ever used in the CONDITIONAL
//     "…가 이미 완료·마무리되었다면" form: consumption is deliberately
//     undiscriminating (rule 2), so genDone may name still-running work — the
//     conditional form makes that mislabel harmless (the summarizer sees the
//     work is unfinished and skips). Only same-payload captures ("PR #60",
//     deleted branch) may use the assertive form.

import { isAbsolute, join } from "node:path";

// ---- labels -----------------------------------------------------------------

// Branch names / PR labels only — anything outside this class is dropped so a
// hostile or degenerate label can never smuggle spaces, quotes or ANSI into
// the nudge (statusline.cleanLabel precedent).
export function sanitizeLabel(s) {
  if (typeof s !== "string") return null;
  const out = s.replace(/[^\w.#/-]/g, "").slice(0, 40);
  return out.length > 0 ? out : null;
}

// branch-del survival comparison (lifetime rule 2): normalize both sides so
// "refs/heads/Feat/X" and "feat/x" compare equal. Only branch-sourced labels
// are comparable — a worktree path basename lives in a different namespace,
// so it is treated as incomparable (-> consume, the conservative direction).
export function normalizeRef(s) {
  return typeof s === "string"
    ? s.replace(/^refs\/heads\//, "").toLowerCase()
    : "";
}

// "#58(feat/issue-58)" when the label carries an issue number, else the label.
function formatWorkLabel(label) {
  const m = /(?:issue[-/]?|#)(\d+)/i.exec(label);
  return m ? `#${m[1]}(${label})` : label;
}

// ---- boundary rule table ------------------------------------------------------
// Evidence streams pinned live 2026-07-07 (Phase 0 step-0):
//   - checkout -b / switch -c success goes to STDERR ("Switched to a new branch"),
//     worktree add ("Preparing worktree") and branch -d ("Deleted branch") to STDOUT.
//   - hook stdin tool_response carries ONLY {stdout, stderr, interrupted,
//     isImage, noOutputExpected} — no is_error. Moreover PostToolUse does not
//     fire at all for failed (non-zero exit) Bash calls, so every rule keeps a
//     POSITIVE success pattern as its evidence (double safety, and the reason
//     pr-merge checks stdout instead of the old stderr /error|failed/ scan).
// Each rule: { key, label, kind: "terminal"|"start", test(seg, out, err),
//              capture(seg, out, err) -> { drop?, delBranch?, gen? } }
// -C accepts a quoted path (spaces!) — plain \S+ would cut the match and
// silence EVERY git rule in a spaces-in-path session (review f7).
const GIT = String.raw`^git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+`;

export const BOUNDARY_RULES = [
  {
    key: "pr-create",
    label: "PR 생성 감지",
    kind: "terminal",
    test: (segs, out) =>
      segs.some((s) => /^gh\s+pr\s+create\b/.test(s)) &&
      /github\.com\/\S+\/pull\/\d+/.test(out),
    capture: (segs, out) => {
      const m = /github\.com\/\S+?\/pull\/(\d+)/.exec(out);
      // Refs this payload explicitly names (suppressed-named-consume, Phase 0
      // (d)② repair 1): `gh pr create --head L` / `git push -u origin L` in
      // the same command prove generation L just ended even when the nudge
      // itself is cooldown-suppressed.
      const named = [];
      for (const s of segs) {
        let mm = /--head[= ]+(\S+)/.exec(s);
        if (mm) named.push(mm[1]);
        mm = /push\s+(?:\S+\s+)*(?:-u|--set-upstream)\s+\S+\s+(\S+)/.exec(s);
        if (mm) named.push(mm[1]);
      }
      const namedRefs = named.map(sanitizeLabel).filter(Boolean);
      return {
        ...(m ? { drop: `PR #${m[1]}` } : {}),
        ...(namedRefs.length ? { namedRefs } : {}),
      };
    },
  },
  {
    key: "git-pull",
    label: "머지 반영 감지(git pull 새 커밋)",
    kind: "terminal",
    test: (segs, out) =>
      segs.some((s) => new RegExp(GIT + String.raw`pull\b`).test(s)) &&
      (/Updating [0-9a-f]+\.\.+[0-9a-f]+/.test(out) || /Fast-forward/.test(out)),
    capture: () => ({}), // no per-payload unit -> drop falls back to genDone inheritance
  },
  {
    key: "branch-del",
    label: "브랜치 정리 감지",
    kind: "terminal",
    test: (segs, out) =>
      segs.some((s) =>
        new RegExp(GIT + String.raw`branch\s+(?:-[a-zA-Z]*[dD]\b|--delete\b)`).test(s),
      ) && /Deleted branch/.test(out),
    capture: (segs, out) => {
      // ALL deletions, not just the first (Phase 0 (d)② repair 2): a batch
      // cleanup loop prints many "Deleted branch" lines — the survival check
      // must see the full list or a same-batch deletion of genStart hides
      // behind the first match and mislabels keep (real transcript 6d544728).
      const all = [...out.matchAll(/Deleted branch (\S+?)(?:\s|$)/g)]
        .map((mm) => sanitizeLabel(mm[1]))
        .filter(Boolean);
      return all.length > 0 ? { drop: all[0], deletedBranches: all } : {};
    },
  },
  {
    key: "pr-merge",
    label: "PR 머지 감지",
    kind: "terminal",
    // Dormant when agent merges are guard-denied (hook never fires); kept for
    // setups that do merge in-session. Evidence (review f2, pinned against gh
    // source + a real in-session merge payload): gh prints its success line
    // to STDERR and only on a TTY — a hook subprocess sees EMPTY output on
    // success, so no output pattern can ever match. The success evidence is
    // PostToolUse itself (it never fires for non-zero Bash), provided the
    // merge is the LAST segment (it decides the exit code) and isn't the
    // auto-merge toggle-off form.
    test: (segs) => {
      const last = [...segs].reverse().find((s) => s.length > 0) ?? "";
      return /^gh\s+pr\s+merge\b/.test(last) && !/--disable-auto\b/.test(last);
    },
    capture: (segs) => {
      const seg = [...segs].reverse().find((s) => /^gh\s+pr\s+merge\b/.test(s)) ?? "";
      const m =
        /github\.com\/\S+?\/pull\/(\d+)/.exec(seg) ?? /\s#?(\d+)(?:\s|$)/.exec(seg);
      return m ? { drop: `PR #${m[1]}` } : {};
    },
  },
  {
    key: "checkout-b",
    label: "새 브랜치 시작 감지",
    kind: "start",
    test: (segs, out, err) =>
      segs.some((s) =>
        new RegExp(
          GIT +
            String.raw`(?:checkout\s+-[a-zA-Z]*[bB]\b|switch\s+(?:\S+\s+)*(?:-[cC]\b|--create\b))`,
        ).test(s),
      ) && /Switched to a new branch/.test(err), // stderr — pinned live; the
    // evidence gate already excludes -B resets ("Switched to and reset")
    capture: (segs, out, err) => {
      const m = /Switched to a new branch '([^']+)'/.exec(err);
      const label = m ? sanitizeLabel(m[1]) : null;
      return label ? { gen: { label, src: "branch" } } : {};
    },
  },
  {
    key: "worktree-add",
    label: "새 워크트리 시작 감지",
    kind: "start",
    test: (segs, out) =>
      segs.some((s) => new RegExp(GIT + String.raw`worktree\s+add\b`).test(s)) &&
      /Preparing worktree/.test(out),
    capture: (segs, out) => {
      // stdout-first (review f8): the branch git itself announces is
      // authoritative and sidesteps argv parsing entirely — it also resolves
      // unexpanded `-b "$BR"` to the REAL branch name (Phase 0 (d)① artifact:
      // 23% of mined start labels were `$WT`-style garbage).
      const nb = /Preparing worktree \(new branch '([^']+)'\)/.exec(out);
      if (nb) {
        const label = sanitizeLabel(nb[1]);
        if (label) return { gen: { label, src: "branch" } };
      }
      // argv fallback (existing-branch checkouts print no branch line):
      // skip value-taking flags, refuse quoted fragments / unexpanded vars
      // (capture failure -> generic template, sentence stays complete).
      const seg = segs.find((s) =>
        new RegExp(GIT + String.raw`worktree\s+add\b`).test(s),
      );
      if (!seg) return {};
      const toks = seg.split(/\s+/);
      const at = toks.findIndex((t) => t === "add");
      let path = null;
      for (let i = at + 1; i < toks.length; i++) {
        const t = toks[i];
        if (t === "-b" || t === "-B" || t === "--reason" || t === "--orphan") {
          i++; // value-taking flag
          continue;
        }
        if (t.startsWith("-")) continue;
        path = t;
        break;
      }
      if (!path || /[$"']/.test(path)) return {};
      const base = path.replace(/\/+$/, "").split("/").pop();
      const label = sanitizeLabel(base);
      return label ? { gen: { label, src: "basename" } } : {};
    },
  },
];

/** Split a Bash command into shell segments (anchored matching — mere mentions
 *  inside quotes/echo don't fire). Same splitter the tier path always used. */
export function shellSegments(command) {
  return String(command ?? "")
    .split(/(?:&&|\|\||[;\n|])/)
    .map((s) => s.trim());
}

/**
 * First matching boundary rule + its captures, or null. A single payload can
 * carry SEVERAL boundaries (a chained `git pull && git branch -d … &&
 * git worktree add …` cleanup one-liner), so beyond the firing rule this also
 * returns (review f4):
 *   - `startGen`: the last matching start-rule's label — lifetime rule 1
 *     ("record on match, always") must hold even when a terminal rule wins
 *     the fire;
 *   - merged `deletedBranches` from a co-present branch-del — the survival
 *     check and suppressed-named-consume must see the full deletion evidence
 *     regardless of which rule fires.
 */
export function matchBoundary(toolName, command, stdout, stderr) {
  if (toolName !== "Bash") return null;
  const segs = shellSegments(command);
  const out = String(stdout ?? "");
  const err = String(stderr ?? "");
  const rule = BOUNDARY_RULES.find((r) => r.test(segs, out, err));
  if (!rule) return null;
  const capture = rule.capture(segs, out, err) ?? {};

  let startGen = capture.gen ?? null;
  for (const r of BOUNDARY_RULES) {
    if (r.kind !== "start" || r === rule) continue;
    if (r.test(segs, out, err)) {
      const c = r.capture(segs, out, err);
      if (c?.gen) startGen = c.gen; // newer signal overwrites (rule 1)
    }
  }
  if (rule.key !== "branch-del") {
    const bd = BOUNDARY_RULES.find((r) => r.key === "branch-del");
    if (bd.test(segs, out, err)) {
      const c = bd.capture(segs, out, err);
      if (c?.deletedBranches) capture.deletedBranches = c.deletedBranches;
    }
  }
  return { rule, capture, startGen };
}

// ---- genStart lifetime (design §genStart 수명 규칙) ---------------------------

export const GEN_TTL_MS = 6 * 3600 * 1000;

const validGen = (g, now) =>
  g && typeof g.label === "string" && typeof g.ts === "number" && now - g.ts <= GEN_TTL_MS
    ? g
    : null;

/**
 * Record a start signal (lifetime rule 1). Always called on a start-rule MATCH,
 * independent of firing/cooldown. Returns a new state object.
 */
export function recordGenStart(state, gen, now) {
  if (!gen?.label) return state;
  return { ...state, genStart: { label: gen.label, src: gen.src, ts: now } };
}

/**
 * Lifetime rules 2/4/5 at a FIRING terminal boundary (a cooldown-suppressed
 * match must NOT call this — rule 3). Returns:
 *   { state, keepLabel, drop: { label, form: "captured"|"inherited" } | null }
 * Consumption is unconditional except the branch-del mismatch survival; a
 * consumed label is inherited by genDone and may only be used in the
 * conditional drop form (rule 5 / n3).
 */
export function consumeOnTerminalFire(state, capture, now) {
  const next = { ...state };
  const gs = validGen(next.genStart, now);
  if (next.genStart && !gs) delete next.genStart; // expired -> silently drop

  // Survival requires positive evidence that a DIFFERENT unit ended: some
  // branch was deleted AND genStart is not anywhere in the deletion list
  // (full list, not first match — Phase 0 (d)② repair 2). Basename-sourced
  // labels are incomparable -> consume (conservative).
  const deleted = capture?.deletedBranches ?? [];
  let survived = false;
  if (
    gs &&
    deleted.length > 0 &&
    gs.src === "branch" &&
    !deleted.some((b) => normalizeRef(b) === normalizeRef(gs.label))
  ) {
    survived = true;
  }

  if (gs && !survived) {
    next.genDone = { label: gs.label, ts: now };
    delete next.genStart;
  }

  const keepLabel = survived ? gs.label : null;
  const gd = validGen(next.genDone, now);
  if (next.genDone && !gd) delete next.genDone;

  const drop = capture?.drop
    ? { label: capture.drop, form: "captured" }
    : gd
      ? { label: gd.label, form: "inherited" }
      : null;

  return { state: next, keepLabel, drop };
}

/**
 * Lifetime rule 3 refinement (Phase 0 (d)② repair 1, "억제-실명-소비"): a
 * SUPPRESSED terminal match (cooldown / below the floor) may still consume
 * genStart — silently, no nudge — when its payload EXPLICITLY NAMES that
 * label (`gh pr create --head L`, `git push -u origin L`, or L in the
 * deletion list). Without this, a micro PR cycle (start → PR within the
 * cooldown) leaves the finished label in genStart and the branch-del survival
 * exception later surfaces it as a keep mislabel (real transcripts 099c99db,
 * 6d544728). Rule 3's original protection is intact: a plain `git pull`
 * names nothing and still cannot steal a fresh label.
 */
export function suppressedNamedConsume(state, capture, now) {
  const gs = validGen(state.genStart, now);
  if (!gs) return { state, consumed: false };
  const named = [...(capture?.namedRefs ?? []), ...(capture?.deletedBranches ?? [])];
  if (!named.some((r) => normalizeRef(r) === normalizeRef(gs.label)))
    return { state, consumed: false };
  const next = { ...state, genDone: { label: gs.label, ts: now } };
  delete next.genStart;
  return { state: next, consumed: true };
}

// ---- cost-estimate segment (v2.1) --------------------------------------------

/**
 * Warm-cache compact cost estimate. `tokens` and `model` MUST come from the
 * same last main-chain usage entry the firing gate used (no extra I/O). The
 * warm premise holds at emit time only (the nudge fires right after activity,
 * inside the 5m cache TTL); the expiry line in the template doubles as the
 * estimate's shelf life. Post-hoc verification is structurally impossible
 * (compaction calls record no usage), hence "추정".
 */
export function costSegment({ tokens, model, priceFor, summaryOutTok, enabled }) {
  if (!enabled) return { segment: "", estUsd: null, costShown: "env_off" };
  const p = priceFor(model);
  if (!p) return { segment: "", estUsd: null, costShown: "unpriced" }; // never guess
  const est = (tokens * p.input * 0.1 + summaryOutTok * p.output) / 1e6;
  // 1 decimal per the design; below $0.10 fall back to 2 decimals so a small
  // context doesn't display a misleading "~$0.0" (live-verify finding).
  const shown = est < 0.095 ? est.toFixed(2) : est.toFixed(1);
  return {
    segment: ` · 지금 압축 추정 ~$${shown}(warm)`,
    estUsd: Number(shown),
    costShown: "on",
  };
}

// ---- message templates ---------------------------------------------------------

const EXPIRY = "(이 지시문은 지금 시점 기준 — 다음 경계 알림이 오면 그것으로 대체하세요.)";
const DROP_TAIL = "구현 상세·시행착오·툴 출력은 결론 한 줄로 축약.";

function dropSentence(drop) {
  if (drop?.form === "captured")
    return `방금 완료된 작업 ${drop.label}의 ${DROP_TAIL}`;
  if (drop?.form === "inherited")
    return `${drop.label} 작업이 이미 완료·마무리되었다면 그 ${DROP_TAIL}`;
  return `이미 완료·마무리된 과거 작업의 ${DROP_TAIL}`;
}

// ---- ledger location --------------------------------------------------------

/** Where the append-only nudge ledger (nudges.jsonl) lives. Unlike the
 *  per-transcript STATE (cooldowns, genStart labels — ephemeral by design,
 *  tmpdir), the ledger is MEASUREMENT data: the compliance verdict (issue #29)
 *  needs >=20 samples over up to 30 days, so it must survive reboots.
 *  Resolution: ACP_CTX_BUDGET_DATA_DIR > $XDG_DATA_HOME/acp/ctx-budget >
 *  ~/.local/share/acp/ctx-budget. Relative values are ignored like unset ones
 *  (the XDG spec mandates this for XDG_DATA_HOME; a cwd-relative ledger would
 *  scatter one file per project). Returns null when nothing resolves
 *  (no home) — the caller skips logging, fail open. */
export function ledgerDir(env, home) {
  const override = env.ACP_CTX_BUDGET_DATA_DIR;
  if (override && isAbsolute(override)) return override;
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : "";
  const base = xdg || (home ? join(home, ".local", "share") : "");
  return base ? join(base, "acp", "ctx-budget") : null;
}

/** Terminal-boundary nudge. keep clause is a constant — never omitted. */
export function terminalMessage({ ruleLabel, ctxTokens, cost, keepLabel, drop }) {
  const keep = keepLabel ? `진행 중 작업 ${formatWorkLabel(keepLabel)}` : "진행 중 작업";
  const head = `[ctx-budget] 작업 경계 감지 (${ruleLabel}) · 컨텍스트 ~${Math.round(ctxTokens / 1000)}k tok${cost} — /compact 적기. 복붙용:`;
  return `${head}\n/compact ${keep}의 결정사항·미완료 항목·다음 단계는 그대로 보존. ${dropSentence(drop)}\n${EXPIRY}`;
}

/** Start-boundary nudge (n2): keep = the just-captured label, drop is the
 *  completion-scoped generic sentence — harmless if other work is in flight.
 *  A failed label capture degrades to the generic subject (sentence stays
 *  complete — capture-failure invariant). */
export function startMessage({ genLabel, ruleLabel, ctxTokens, cost }) {
  const head = `[ctx-budget] 새 작업 시작 감지 (${genLabel ?? ruleLabel}) · 컨텍스트 ~${Math.round(ctxTokens / 1000)}k tok${cost} — /compact 적기. 복붙용:`;
  const subject = genLabel ? `새 작업 ${formatWorkLabel(genLabel)}` : "새 작업";
  return `${head}\n/compact ${subject}의 목표·계획·결정사항과 직전 탐색 내용은 그대로 보존. ${dropSentence(null)}\n${EXPIRY}`;
}
