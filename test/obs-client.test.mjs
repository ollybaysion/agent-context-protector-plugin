// Tests for the vendored observability emitter (lib/obs-client.mjs, issue #32).
// A throwaway HTTP collector on an ephemeral port records what the emitter POSTs
// so we can assert the envelope, then the fail-open / kill-switch / fallback
// invariants. OBS_PORT is read at module-eval time, so each case cache-busts the
// import (?v=N) to re-read the env it just set. node --test runs this file in
// its own process, so these env mutations don't leak to other suites.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

function collector() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* record the raw miss */
      }
      received.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
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

// A representative ledger row (issue #31 schema) — the emit payload must be this
// object, unchanged.
const ENTRY = {
  ts: 1710000000000,
  transcriptHash: "abc123def4560789",
  kind: "branch-del",
  template: "terminal",
  keepLabel: "#32(feat/nudge-obs-emit)",
  dropLabel: "feat/nudge-obs-emit",
  dropForm: "assertive",
  ctxTokens: 236406,
  byteOffset: 4514857,
  estUsd: 0.4,
  model: "claude-opus-4-8",
  costShown: "on",
};

let vseq = 0;
function freshEmitter() {
  return import(`../lib/obs-client.mjs?v=${vseq++}`);
}

test("posts a NudgeFired envelope: payload == ledger row, timestamp == now, loopback Host", async () => {
  const { srv, port, received } = await collector();
  try {
    process.env.OBS_HOST = "127.0.0.1";
    process.env.OBS_PORT = String(port);
    process.env.OBS_SOURCE_APP = "test-app"; // pin: no tmux/cwd nondeterminism
    delete process.env.ACP_CTX_BUDGET_OBS;
    const { emitNudgeFired } = await freshEmitter();

    await emitNudgeFired({
      entry: ENTRY,
      input: { session_id: "sess-42", cwd: "/whatever" },
      now: 1710000000000,
    });

    assert.equal(received.length, 1);
    const { method, url, headers, body } = received[0];
    assert.equal(method, "POST");
    assert.equal(url, "/events");
    assert.equal(headers.host, "127.0.0.1");
    assert.equal(body.hook_event_type, "NudgeFired");
    assert.equal(body.session_id, "sess-42");
    assert.equal(body.source_app, "test-app");
    assert.equal(body.timestamp, 1710000000000); // == entry.ts, one shared instant
    assert.deepEqual(body.payload, ENTRY); // byte-for-byte the ledger row
  } finally {
    srv.close();
    delete process.env.OBS_SOURCE_APP;
  }
});

test("session_id falls back to 'unknown' when the hook input lacks it", async () => {
  const { srv, port, received } = await collector();
  try {
    process.env.OBS_PORT = String(port);
    process.env.OBS_SOURCE_APP = "test-app";
    delete process.env.ACP_CTX_BUDGET_OBS;
    const { emitNudgeFired } = await freshEmitter();
    await emitNudgeFired({ entry: ENTRY, input: {}, now: 1 });
    assert.equal(received[0].body.session_id, "unknown");
  } finally {
    srv.close();
    delete process.env.OBS_SOURCE_APP;
  }
});

test("kill switch ACP_CTX_BUDGET_OBS=0 sends nothing and still resolves", async () => {
  const { srv, port, received } = await collector();
  try {
    process.env.OBS_PORT = String(port);
    process.env.OBS_SOURCE_APP = "test-app";
    process.env.ACP_CTX_BUDGET_OBS = "0";
    const { emitNudgeFired } = await freshEmitter();
    const r = await emitNudgeFired({ entry: ENTRY, input: { session_id: "s" }, now: 1 });
    assert.equal(r, undefined); // resolved, no value
    assert.equal(received.length, 0); // no POST reached the collector
  } finally {
    srv.close();
    delete process.env.ACP_CTX_BUDGET_OBS;
    delete process.env.OBS_SOURCE_APP;
  }
});

test("fail-open: a down collector never rejects (ECONNREFUSED swallowed)", async () => {
  // Bind then close to get a port nothing listens on, and aim the emitter there.
  const { srv, port } = await collector();
  await new Promise((r) => srv.close(r));
  process.env.OBS_PORT = String(port);
  process.env.OBS_SOURCE_APP = "test-app";
  delete process.env.ACP_CTX_BUDGET_OBS;
  const { emitNudgeFired } = await freshEmitter();
  await assert.doesNotReject(
    emitNudgeFired({ entry: ENTRY, input: { session_id: "s" }, now: 1 }),
  );
  delete process.env.OBS_SOURCE_APP;
});

test("never throws even when the payload is not serializable", async () => {
  process.env.OBS_SOURCE_APP = "test-app";
  delete process.env.ACP_CTX_BUDGET_OBS;
  const { emitNudgeFired } = await freshEmitter();
  const circular = {};
  circular.self = circular; // JSON.stringify would throw
  await assert.doesNotReject(
    emitNudgeFired({ entry: circular, input: { session_id: "s" }, now: 1 }),
  );
  delete process.env.OBS_SOURCE_APP;
});
