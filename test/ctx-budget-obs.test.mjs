// End-to-end seam test (issue #32): drive the REAL ctx-budget.mjs hook to a
// firing boundary with the observability emit ENABLED, and assert it POSTs one
// NudgeFired to a throwaway in-process collector whose payload is byte-for-byte
// the ledger row it just wrote. Uses async spawn (NOT execFileSync): a sync
// spawn would freeze this process's event loop and the in-process collector
// could never answer, so the POST would time out unrecorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CTX = join(here, "..", "core", "ctx-budget", "ctx-budget.mjs");

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
    srv.listen(0, "127.0.0.1", () =>
      resolve({ srv, port: srv.address().port, received }),
    ),
  );
}

function runHookAsync(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CTX], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("firing boundary → collector receives one NudgeFired whose payload == the ledger row", async () => {
  const { srv, port, received } = await collector();
  try {
    const dir = join(tmpdir(), "acp-test", `obs-e2e-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const tp = join(dir, `t-${Date.now()}.jsonl`);
    // One main-chain assistant entry, 150k tokens > NUDGE_MIN_TOK (100k @ 200k window).
    writeFileSync(
      tp,
      JSON.stringify({
        message: {
          usage: { input_tokens: 150000 },
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "ok" }],
        },
      }) + "\n",
    );

    // Strip inherited ACP_*/OBS_* so the shell can't disarm the test, then pin
    // the knobs. ACP_CTX_BUDGET_OBS is deliberately UNSET → emit enabled.
    const base = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith("ACP_") && !k.startsWith("OBS_"),
      ),
    );
    const env = {
      ...base,
      ACP_CTX_BUDGET_WINDOW: "200000",
      ACP_CTX_BUDGET_STEP: "10",
      ACP_CTX_BUDGET_DATA_DIR: dir,
      OBS_HOST: "127.0.0.1",
      OBS_PORT: String(port),
      OBS_SOURCE_APP: "obs-e2e",
    };
    const payload = {
      session_id: "sess-e2e",
      transcript_path: tp,
      tool_name: "Bash",
      tool_input: { command: "gh pr create --head feat/x" },
      tool_response: {
        stdout: "https://github.com/o/r/pull/99\n",
        stderr: "",
        interrupted: false,
      },
    };

    const out = await runHookAsync(payload, env);
    // The nudge itself still reaches the user.
    assert.match(JSON.parse(out).systemMessage, /작업 경계 감지/);

    // Exactly one NudgeFired, and its payload is the ledger line verbatim.
    assert.equal(received.length, 1);
    const e = received[0];
    assert.equal(e.hook_event_type, "NudgeFired");
    assert.equal(e.session_id, "sess-e2e");
    assert.equal(e.source_app, "obs-e2e");
    const ledger = readFileSync(join(dir, "nudges.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(ledger.length, 1);
    assert.deepEqual(e.payload, ledger[0]); // event payload == ledger row
    assert.equal(e.timestamp, ledger[0].ts); // one shared instant
    assert.equal(e.payload.kind, "pr-create");
  } finally {
    srv.close();
  }
});

test("collector down → the nudge still fires (fail-open through the whole hook)", async () => {
  // A port nothing listens on: the hook must still emit its systemMessage.
  const { srv, port } = await collector();
  await new Promise((r) => srv.close(r));
  const dir = join(tmpdir(), "acp-test", `obs-e2e-down-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const tp = join(dir, `t-${Date.now()}.jsonl`);
  writeFileSync(
    tp,
    JSON.stringify({
      message: {
        usage: { input_tokens: 150000 },
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "ok" }],
      },
    }) + "\n",
  );
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("ACP_") && !k.startsWith("OBS_"),
    ),
  );
  const env = {
    ...base,
    ACP_CTX_BUDGET_WINDOW: "200000",
    ACP_CTX_BUDGET_DATA_DIR: dir,
    OBS_PORT: String(port),
    OBS_SOURCE_APP: "obs-e2e",
  };
  const out = await runHookAsync(
    {
      session_id: "s",
      transcript_path: tp,
      tool_name: "Bash",
      tool_input: { command: "gh pr create" },
      tool_response: { stdout: "https://github.com/o/r/pull/1\n", stderr: "", interrupted: false },
    },
    env,
  );
  assert.match(JSON.parse(out).systemMessage, /작업 경계 감지/);
  // And the ledger row was still written despite the dead collector.
  assert.equal(
    readFileSync(join(dir, "nudges.jsonl"), "utf8").trim().split("\n").length,
    1,
  );
});
