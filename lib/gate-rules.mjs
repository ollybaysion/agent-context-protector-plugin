// Single source of truth for WHICH pattern families input-gate covers.
// Consumed by BOTH sides so they cannot drift:
//   - core/input-gate/input-gate.mjs builds its LOG_ARTIFACT_READ regex from
//     LOG_ARTIFACT_EXTS — adding an extension here changes the gate itself.
//   - core/analyze/analyze.mjs builds its proposal-exclusion set from
//     gatedFamilies() — the same edit silently updates the report, so a
//     freshly-gated family can never reappear as a ghost rule-candidate
//     (the Read(*.output) incident this file exists to prevent).
//
// Keep this file dependency-free and cheap (same contract as patterns.mjs):
// input-gate runs on the PreToolUse hot path.

// Build/run output logs: dump-once, low-signal-per-token, best queried with
// rg. `.output` is mining-proven (~10k tok/call); the rest are the same class
// and absent in the observed corpus, so adding them carries no false-positive
// risk. Deliberately excludes .md/.mjs/.js/.json/.txt — all normal reads
// (<2.5k tok/call in the mine) that a gate would only false-positive on.
export const LOG_ARTIFACT_EXTS = ["output", "log", "trace", "dump", "ndjson"];

// Generated-artifact extensions whose toolPattern label maps 1:1 to an
// input-gate ARTIFACT_READ match (.js.map -> Read(*.map), Cargo.lock ->
// Read(*.lock)). The rest of that regex (min.js, package-lock.json) shares
// labels with normal reads (Read(*.js), Read(*.json)) and is deliberately
// NOT listed — excluding those labels would also suppress proposals for
// ordinary js/json traffic.
export const ARTIFACT_LABEL_EXTS = ["map", "lock"];

// Bash command families covered by input-gate's FOLLOW/VOLUME rule tables.
// These CANNOT be derived from the rule regexes, so the contract is: add or
// remove a rule in input-gate.mjs -> update this list in the same commit
// (input-gate imports this file, so the reminder is one import away).
export const BASH_GATED_FAMILIES = [
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
];

/** Every gated pattern family, as toolPattern labels (analyze's view). */
export function gatedFamilies() {
  return new Set([
    ...BASH_GATED_FAMILIES,
    ...LOG_ARTIFACT_EXTS.map((e) => `Read(*.${e})`),
    ...ARTIFACT_LABEL_EXTS.map((e) => `Read(*.${e})`),
  ]);
}
