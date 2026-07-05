// Unit tests for the pattern-family normalization shared by core/analyze and
// ctx-budget attribution (#8). The whole point of the feature is that varied
// invocations collapse to ONE canonical family label, so these pin the
// normalization rules that make accumulation meaningful.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bashPattern, toolPattern } from "../lib/patterns.mjs";

test("bashPattern: flags/args collapse to command + subcommand", () => {
  assert.equal(bashPattern("npm test --verbose -w pkg"), "npm test");
  assert.equal(bashPattern("npm test"), "npm test");
  assert.equal(bashPattern("git diff"), "git diff");
  assert.equal(bashPattern("git diff --stat HEAD~1"), "git diff");
  assert.equal(bashPattern("npm run build"), "npm run");
});

test("bashPattern: value-flags don't get mistaken for the subcommand", () => {
  assert.equal(bashPattern("git -C /some/path diff --stat"), "git diff");
  // Normalization is single-level: gh pr {create,merge,list} all fold to "gh pr".
  assert.equal(bashPattern("gh --repo o/r pr create --fill"), "gh pr");
});

test("bashPattern: env prefixes and toolchain pins are skipped", () => {
  assert.equal(bashPattern("FOO=bar npm run build"), "npm run");
  assert.equal(bashPattern("env npm test"), "npm test");
  assert.equal(bashPattern("cargo +nightly build --release"), "cargo build");
});

test("bashPattern: labels by the first segment that actually produces output", () => {
  // cd yields nothing, so a subshell's spend belongs to the real producer.
  assert.equal(bashPattern("(cd /x && gh pr create --fill)"), "gh pr");
  assert.equal(bashPattern("cd /repo && git status"), "git status");
});

test("bashPattern: non-subcommand commands stay as the bare command", () => {
  assert.equal(bashPattern("ls -la /tmp"), "ls");
  assert.equal(bashPattern("./scripts/deploy.sh --prod"), "deploy.sh");
});

test("bashPattern: empty / whitespace falls back to Bash", () => {
  assert.equal(bashPattern(""), "Bash");
  assert.equal(bashPattern("   "), "Bash");
  assert.equal(bashPattern(undefined), "Bash");
});

test("toolPattern: file tools bucket by extension", () => {
  assert.equal(toolPattern("Read", { file_path: "/a/b/foo.md" }), "Read(*.md)");
  assert.equal(toolPattern("Edit", { file_path: "/a/b/x.mjs" }), "Edit(*.mjs)");
  assert.equal(
    toolPattern("Write", { file_path: "/a/b/notes.txt" }),
    "Write(*.txt)",
  );
  assert.equal(
    toolPattern("Read", { file_path: "/repo/Makefile" }),
    "Read(*(no-ext))",
  );
});

test("toolPattern: Bash delegates to bashPattern", () => {
  assert.equal(toolPattern("Bash", { command: "git status" }), "git status");
});

test("toolPattern: non-file tools keep their name", () => {
  assert.equal(toolPattern("Grep", { pattern: "x" }), "Grep");
  assert.equal(toolPattern("WebFetch", {}), "WebFetch");
  assert.equal(toolPattern(undefined, {}), "unknown");
});
