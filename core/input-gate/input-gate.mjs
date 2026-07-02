#!/usr/bin/env node
// input-gate (PreToolUse / Bash + Read): deny firehose tool calls BEFORE they
// run, so their output never enters the context at all. Each deny reason
// carries a bounded alternative, so Claude retries with the narrow form.
//
// Rule categories (see README.md):
//   FOLLOW — commands that stream forever in a non-TTY shell (tail -f,
//            journalctl -f, docker/kubectl logs -f, pm2 logs). These hang the
//            tool call until timeout, so they are denied even when piped or
//            redirected.
//   VOLUME — commands whose stdout is unbounded (ls -R, tree, du, unbounded
//            logs, git log -p, oversized git diff, curl body). Skipped when
//            the command pipes or redirects anywhere (the output may be
//            bounded downstream — uncertain, so fail open).
//   READ   — whole-file Read of oversized or generated files without `limit`.
//
// Orthogonality: grep→rg / find→fd / cat→Read / sed -i / top / cd&& belong to
// claude-hooks' bash-guard; git branch protection belongs to git-guard. Only
// volume/stream rules live here — no duplication.
//
// It never blocks via exit 2; uncertain parsing and any internal error fail
// open. Tunables: ACP_INPUT_GATE_DIFF_MAX_LINES (default 1000),
// ACP_INPUT_GATE_READ_MAX_BYTES (262144), ACP_INPUT_GATE_ARTIFACT_MAX_BYTES
// (65536) — each must be a positive number, else the default is used.

import { statSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  readHookInput,
  denyPreToolUse,
  pass,
  failOpen,
} from "../../lib/hook-io.mjs";

function positiveEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const DIFF_MAX_LINES = positiveEnv("ACP_INPUT_GATE_DIFF_MAX_LINES", 1000);
const READ_MAX_BYTES = positiveEnv("ACP_INPUT_GATE_READ_MAX_BYTES", 262144);
const ARTIFACT_MAX_BYTES = positiveEnv(
  "ACP_INPUT_GATE_ARTIFACT_MAX_BYTES",
  65536,
);

// Same conservative split as bash-guard: ; && || | and newlines, so a
// firehose can't hide behind a clean prefix (`echo ok && ls -R /`).
function splitCommands(cmd) {
  return cmd
    .split(/(?:&&|\|\||[;\n|])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A real pipe (not ||) or any redirect means the output may be bounded or
// diverted downstream — uncertain, so VOLUME rules stand down. (`2>&1` alone
// still counts as a redirect here; that over-passes, which is the safe
// direction for a fail-open gate.)
const hasPipeOrRedirect = (cmd) => /(?<!\|)\|(?!\|)/.test(cmd) || /[<>]/.test(cmd);

// --- FOLLOW rules: checked on every segment, never skipped. -----------------
// [test(seg) -> boolean, reason]
// Flag regexes tolerate combined short options (-lRh, -ef, -ft): \w* on BOTH
// sides of the letter, since \b alone misses a letter followed by more flags.
const DOCKER_LOGS =
  /^docker(?:\s+(?:compose|container|service))?\s+logs\b|^docker-compose\s+logs\b/;

const FOLLOW_RULES = [
  [
    (s) => /^tail\b/.test(s) && /\s--follow\b|\s-\w*[fF]\w*\b/.test(s),
    "input-gate: tail -f/-F는 비-TTY 셸에서 타임아웃까지 멈춰 있는다. 파일 끝부분은 Read 도구(offset/limit)로 읽어라.",
  ],
  [
    (s) => /^journalctl\b/.test(s) && /\s(?:-\w*f\w*\b|--follow\b)/.test(s),
    "input-gate: journalctl --follow는 끝나지 않는다. 'journalctl -n 200 -u UNIT'처럼 -n으로 바운딩해라.",
  ],
  [
    (s) => DOCKER_LOGS.test(s) && /\s(?:-\w*f\w*\b|--follow\b)/.test(s),
    "input-gate: docker logs -f는 끝나지 않는다. 'docker logs --tail 200 CONTAINER'로 바운딩해라.",
  ],
  [
    (s) => /^kubectl\s+logs\b/.test(s) && /\s(?:-\w*f\w*\b|--follow\b)/.test(s),
    "input-gate: kubectl logs -f는 끝나지 않는다. 'kubectl logs --tail=200 POD'로 바운딩해라.",
  ],
  [
    (s) => /^pm2\s+logs\b/.test(s) && !/\s--nostream\b/.test(s),
    "input-gate: pm2 logs는 기본이 스트리밍이라 끝나지 않는다. 'pm2 logs --lines 200 --nostream'을 써라.",
  ],
];

// --- VOLUME rules: checked per segment, skipped when piped/redirected. ------
const VOLUME_RULES = [
  [
    (s) => /^ls\b/.test(s) && /\s-\w*R\w*\b|\s--recursive\b/.test(s),
    "input-gate: ls -R 전체 재귀 나열은 출력이 무제한이다. 한 단계는 'ls DIR', 구조 파악은 'fd -t d -d 2 DIR' 또는 'tree -L 2 DIR'.",
  ],
  [
    (s) => /^tree\b/.test(s) && !/\s-L\s*\d/.test(s),
    "input-gate: tree는 -L 없이 전체 깊이를 덤프한다. 'tree -L 2 DIR'처럼 깊이를 제한해라.",
  ],
  [
    (s) =>
      /^du\b/.test(s) &&
      !/\s(?:-\w*s\w*\b|--summarize\b|-d\s*\d|--max-depth)/.test(s),
    "input-gate: du는 -s/-d 없이 모든 하위 디렉토리를 나열한다. 합계는 'du -sh DIR', 한 단계 내역은 'du -h -d 1 DIR'.",
  ],
  [
    // -n\d* accepts the getopt no-space form (-n200), not just "-n 200".
    (s) => /^journalctl\b/.test(s) && !/\s(?:-n\d*\b|--lines\b)/.test(s),
    "input-gate: journalctl은 -n 없이 저널 전체를 덤프한다. 'journalctl -n 200 -u UNIT'으로 바운딩해라.",
  ],
  [
    (s) => DOCKER_LOGS.test(s) && !/\s(?:--tail\b|-n\d*\b)/.test(s),
    "input-gate: docker logs는 --tail 없이 컨테이너 로그 전체를 덤프한다. 'docker logs --tail 200 CONTAINER'.",
  ],
  [
    (s) =>
      /^kubectl\s+logs\b/.test(s) && !/\s(?:--tail\b|--since\b)/.test(s),
    "input-gate: kubectl logs는 --tail 없이 로그 전체를 덤프한다. 'kubectl logs --tail=200 POD'.",
  ],
  [
    (s) =>
      /^git(?:\s+-C\s+\S+)?\s+log\b/.test(s) &&
      /\s(?:-p\b|-u\b|--patch\b)/.test(s) &&
      !/\s(?:-n\s*\d|--max-count|-\d+\b)/.test(s),
    "input-gate: git log -p는 개수 제한 없이 전체 히스토리 패치를 덤프한다. 'git log --stat -n 20'으로 훑고 필요한 커밋만 'git show SHA'로 봐라.",
  ],
  [
    // -\w*[oOI] also catches combined flags like -sSLo / -sI.
    (s) =>
      /^curl\b/.test(s) &&
      !/\s(?:-\w*[oOI]\b|--output\b|--remote-name\b|--head\b|--max-filesize\b)/.test(
        s,
      ),
    "input-gate: curl 응답 body가 통째로 컨텍스트에 들어온다. '-o /tmp/resp.json'으로 저장 후 jq/rg로 필요한 부분만 보거나, '| jq .field'로 파이프해라(파이프하면 이 게이트는 통과).",
  ],
  [
    // wget saves to a file by default — only stdout mode (-O -) is a firehose.
    (s) => /^wget\b/.test(s) && /\s-\w*O\s*-(?:\s|$)|--output-document=-/.test(s),
    "input-gate: wget -O- 는 응답 body를 통째로 컨텍스트에 넣는다. 파일로 저장(기본 동작) 후 jq/rg로 필요한 부분만 봐라.",
  ],
];

// --- git diff: measure the ACTUAL diff size with --shortstat, deny only when
// it exceeds the budget. Only the simple standalone form is measured — any
// compound/expansion syntax is uncertain, so it passes untouched.
function oversizedGitDiff(cmd, cwd) {
  if (!/^\s*git(?:\s+-C\s+\S+)?\s+diff\b/.test(cmd)) return null;
  if (/[|;&<>`$\n]/.test(cmd)) return null; // compound / expansion -> uncertain
  if (/\s--(?:stat|shortstat|numstat|name-only|name-status|dirstat|summary)\b/.test(cmd))
    return null; // already bounded output
  // Anchored replace: a bare /\bdiff\b/ would hit a -C path containing the
  // word (git -C /tmp/diff-tools diff) and corrupt the measured command.
  const measured = cmd
    .replace(/\s(?:-p|-u|--patch)\b/g, "") // don't let -p re-add the patch body
    .replace(/^(\s*git(?:\s+-C\s+\S+)?\s+)diff\b/, "$1diff --shortstat");
  try {
    const out = execSync(measured, {
      cwd: cwd || process.cwd(),
      timeout: 5000,
      maxBuffer: 1 << 20,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const ins = out.match(/(\d+) insertion/);
    const del = out.match(/(\d+) deletion/);
    const lines = (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
    return lines > DIFF_MAX_LINES ? lines : null;
  } catch {
    return null; // not a repo / bad revision / timeout -> let git itself say so
  }
}

// Read gives these to the model as rendered pages/images, not raw text — the
// size heuristics below don't apply.
const VISUAL_READ = /\.(?:png|jpe?g|gif|webp|bmp|ico|pdf)$/i;

// Generated artifacts: near-zero signal per token; rg/jq beats reading them.
const ARTIFACT_READ =
  /(?:\.min\.(?:js|mjs|css)|\.(?:js|css)\.map|\.bundle\.js|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock))$/i;

function gateRead(input) {
  const p = input?.tool_input?.file_path;
  if (!p || typeof p !== "string") pass();
  if (input?.tool_input?.limit) pass(); // already a bounded read
  if (VISUAL_READ.test(p)) pass();

  let size;
  try {
    size = statSync(p).size;
  } catch {
    pass(); // missing/unreadable -> let Read report the real error
  }

  const kb = Math.round(size / 1024);
  if (ARTIFACT_READ.test(p) && size > ARTIFACT_MAX_BYTES) {
    denyPreToolUse(
      `input-gate: 생성물 파일(${kb}KB) 통읽기는 토큰 낭비다. 특정 키는 jq, 특정 문자열은 rg로 찾고, 정말 필요하면 offset/limit으로 부분만 읽어라.`,
    );
  }
  if (size > READ_MAX_BYTES) {
    denyPreToolUse(
      `input-gate: ${kb}KB 파일 통읽기는 컨텍스트를 크게 태운다. limit(예: 200)으로 페이지 읽기를 하거나, 필요한 부분을 rg로 먼저 찾아라.`,
    );
  }
  pass();
}

function gateBash(input) {
  const command = input?.tool_input?.command;
  if (!command || typeof command !== "string" || !command.trim()) pass();

  const segments = splitCommands(command);

  for (const seg of segments) {
    for (const [test, reason] of FOLLOW_RULES) {
      if (test(seg)) denyPreToolUse(reason);
    }
  }

  if (!hasPipeOrRedirect(command)) {
    for (const seg of segments) {
      for (const [test, reason] of VOLUME_RULES) {
        if (test(seg)) denyPreToolUse(reason);
      }
    }
    // Measure only a standalone `git diff` command: with a compound prefix
    // (`cd X && git diff`), input.cwd is not where the diff would actually
    // run, so the measurement could target the wrong repo — uncertain, pass.
    if (segments.length === 1) {
      const lines = oversizedGitDiff(segments[0], input?.cwd);
      if (lines !== null) {
        denyPreToolUse(
          `input-gate: 이 diff는 ${lines}줄(기준 ${DIFF_MAX_LINES}줄 초과)이다. 'git diff --stat'으로 훑은 뒤 필요한 파일만 'git diff -- PATH'로 봐라.`,
        );
      }
    }
  }

  pass();
}

try {
  const input = await readHookInput();
  if (input?.tool_name === "Bash") gateBash(input);
  if (input?.tool_name === "Read") gateRead(input);
  pass(); // any other tool -> not our concern
} catch (err) {
  failOpen(
    `[agent-context-protector/input-gate] internal error, skipping: ${err?.message ?? err}`,
  );
}
