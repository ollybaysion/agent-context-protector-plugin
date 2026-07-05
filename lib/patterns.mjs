// Pattern-family normalization for tool calls: individual invocations vary
// endlessly ("npm test --verbose -w pkg" vs "npm test"), but token spend
// clusters by FAMILY. One canonical label per family makes accumulation
// meaningful. Shared by core/analyze (offline reports) and ctx-budget
// attribution (core/ctx-budget/attribution.mjs) — keep it dependency-free
// and cheap.

// Commands whose first non-flag argument is a meaningful subcommand.
const SUBCOMMAND_CMDS = new Set([
  "git",
  "gh",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "docker",
  "kubectl",
  "pm2",
  "cargo",
  "pip",
  "pip3",
  "uv",
  "apt",
  "apt-get",
  "brew",
  "systemctl",
  "poetry",
  "conda",
  "make",
]);

// Flags that consume the NEXT token as a value (so it must not be mistaken
// for a subcommand): `git -C /path diff` -> "git diff", `kubectl --context x
// get` -> "kubectl get". Deliberately NOT here: boolean flags like apt's -f
// (--fix-broken) — listing those would swallow the real subcommand.
const VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "-R",
  "-n",
  "-H",
  "--repo",
  "--context",
  "--namespace",
  "--cluster",
  "--profile",
  "--project",
  "--kubeconfig",
]);

const basename = (p) => p.split("/").pop() ?? p;

/** Canonical pattern label for a Bash command string. */
export function bashPattern(command) {
  if (typeof command !== "string" || !command.trim()) return "Bash";
  // Walk segments and label by the first one that actually PRODUCES output:
  // `cd` yields nothing, so `(cd /x && gh pr create …)` is gh's spend, not cd's.
  const segs = command.split(/(?:&&|\|\||[;\n|])/);
  let fallback = null;
  for (const rawSeg of segs) {
    const seg = rawSeg.trim().replace(/^[($\s]+/, ""); // strip subshell parens
    if (!seg) continue;
    const words = seg.split(/\s+/);
    let i = 0;
    // skip VAR=value prefixes and `env`
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (words[i] === "env") i++;
    const cmd = basename(words[i] ?? "");
    if (!cmd) continue;
    const label = SUBCOMMAND_CMDS.has(cmd) ? withSubcommand(cmd, words, i) : cmd;
    if (cmd === "cd") {
      fallback = fallback ?? label;
      continue; // silent segment -> keep looking for the real producer
    }
    return label;
  }
  return fallback ?? "Bash";
}

function withSubcommand(cmd, words, i) {
  // find the first non-flag token after the command
  let j = i + 1;
  while (j < words.length) {
    const w = words[j];
    if (w.startsWith("+")) {
      j++; // toolchain pin (cargo +nightly build) -> not a subcommand
      continue;
    }
    if (w.startsWith("-")) {
      if (VALUE_FLAGS.has(w)) j++; // its value is not a subcommand either
      j++;
      continue;
    }
    if (/^[a-z][a-z0-9-]*$/i.test(w)) return `${cmd} ${w}`;
    break; // first non-flag token isn't subcommand-shaped -> command only
  }
  return cmd;
}

/** Canonical pattern label for any tool call. */
export function toolPattern(name, input) {
  if (name === "Bash") return bashPattern(input?.command);
  const p = input?.file_path;
  if (typeof p === "string" && ["Read", "Write", "Edit", "NotebookEdit"].includes(name)) {
    const base = basename(p);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot) : "(no-ext)";
    return `${name}(*${ext})`;
  }
  return name ?? "unknown";
}
