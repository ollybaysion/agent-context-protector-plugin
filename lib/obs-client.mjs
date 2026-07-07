// Observability emitter for the local agent-dashboard collector (the SENDING
// side of the nudge → dashboard link, issue #32). This is a hand-kept COPY of
// claude-hooks' lib/obs-client.mjs (stage 9): the collector integration is a
// WIRE contract — an HTTP POST to a loopback port — NOT a shared module. acp
// and claude-hooks are separate plugins with no shared import path, so the
// ~40-line emitter is duplicated rather than imported. Source of truth for the
// contract (keep the two copies in sync by hand):
//   ollybaysion/agentic-claude-hooks  lib/obs-client.mjs  (postEnvelope, sourceApp)
//
// Invariants copied verbatim — DO NOT relax:
//   - never throws; a slow/absent/broken collector can never change a nudge.
//   - writes NOTHING to stdout/stderr (a hook's stdout is its decision JSON).
//   - bounded by a timeout; resolves on EVERY outcome, incl. ECONNREFUSED
//     (collector down) — which resolves immediately, so the common down/up
//     cases add ~0 latency and only a wedged (accepts-but-hangs) collector can
//     cost the full timeout.
// The NudgeFired builder below is acp-specific, mirroring claude-hooks'
// emitGuardDecision. Callers MUST await it before the process exits: the hook's
// emitSystemMessage() does a sync write + process.exit(), which would truncate
// a detached POST (issue #32 F2).

import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOST = process.env.OBS_HOST || "127.0.0.1";
const PORT =
  Number.isInteger(Number(process.env.OBS_PORT)) && Number(process.env.OBS_PORT) > 0
    ? Number(process.env.OBS_PORT)
    : 4090;

// tmux window name for the current pane, or null. Several claude sessions often
// run from the SAME directory: basename(cwd) collapses them into one label,
// while the tmux window name is per task. Best-effort — any failure (no tmux,
// dead pane, timeout) falls through silently.
function tmuxWindowName() {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return null;
  try {
    const r = spawnSync(
      "tmux",
      ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{window_name}"],
      { encoding: "utf8", timeout: 200 },
    );
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

// Human-friendly source label: explicit override, else the tmux window name,
// else the project directory name, else a constant. Same scheme as claude-hooks
// so a session's NudgeFired rows carry the SAME app label as its other events.
export function sourceApp(input) {
  if (process.env.OBS_SOURCE_APP) return process.env.OBS_SOURCE_APP;
  const win = tmuxWindowName();
  if (win) return win;
  const cwd =
    input && typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  return path.basename(cwd) || "claude-code";
}

// POST one envelope to the collector. Resolves ALWAYS (never rejects): on the
// end of the response, on any socket error (ECONNREFUSED when the collector is
// down), or on timeout. Writes nothing to stdout/stderr.
export function postEnvelope(envelope, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let body;
    try {
      body = JSON.stringify(envelope);
    } catch {
      return resolve();
    }
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Host: "127.0.0.1", // collector requires a loopback Host (421 otherwise)
    };
    if (process.env.OBS_TOKEN) headers.Authorization = `Bearer ${process.env.OBS_TOKEN}`;
    const req = http.request(
      { host: HOST, port: PORT, path: "/events", method: "POST", headers, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("error", resolve);
      },
    );
    req.on("error", resolve); // ECONNREFUSED (collector down) etc. — swallow
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

// Emit a NudgeFired event when a boundary nudge fires (issue #32). Mirrors
// claude-hooks' emitGuardDecision: the envelope is built from the hook `input`
// (session_id, source label) plus the ledger `entry` — the SAME object appended
// to nudges.jsonl, so the dashboard row and the ledger row are the identical
// payload and the collector can join NudgeFired ↔ NudgeOutcome on
// (transcriptHash, byteOffset). `timestamp` reuses the caller's `now`, which is
// entry.ts, so event and ledger share one instant. Fully swallowed — an emit
// bug must NEVER wedge a nudge. Kill switch: ACP_CTX_BUDGET_OBS=0 short-circuits
// BEFORE any work (including the tmux spawn in sourceApp).
export function emitNudgeFired({ entry, input, now, timeoutMs = 2000 } = {}) {
  if (process.env.ACP_CTX_BUDGET_OBS === "0") return Promise.resolve();
  try {
    const envelope = {
      source_app: sourceApp(input),
      session_id:
        typeof input?.session_id === "string" && input.session_id
          ? input.session_id
          : "unknown",
      hook_event_type: "NudgeFired",
      payload: entry,
      timestamp: typeof now === "number" ? now : entry?.ts,
    };
    return postEnvelope(envelope, { timeoutMs });
  } catch {
    return Promise.resolve(); // an emit bug must never wedge a nudge
  }
}
