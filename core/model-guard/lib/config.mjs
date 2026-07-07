// model-guard config: zero-config, <project>/.claude/model-guard.json shallow-
// merged over built-in defaults. Read ONLY by the Stop hook (model-advisor.mjs)
// -- statusline never opens this file (hot-path no-I/O rule, DESIGN.md §4.1).

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  disabled: false,
  advisor: {
    enabled: true,
    window: 8, // recent N assistant turns observed
    threshold: 6, // how many of them must be "light" to speak up
    expensive: ["fable", "opus"], // substring match against message.model
    target: "sonnet", // model name to recommend
  },
};

/** Load model-guard config for `cwd`, falling back to defaults on any error. */
export function loadConfig(cwd) {
  const merged = { ...DEFAULTS, advisor: { ...DEFAULTS.advisor } };
  if (typeof cwd !== "string" || cwd === "") return merged;
  try {
    const user = JSON.parse(
      readFileSync(join(cwd, ".claude", "model-guard.json"), "utf8"),
    );
    if (user && typeof user === "object") {
      if (typeof user.disabled === "boolean") merged.disabled = user.disabled;
      if (user.advisor && typeof user.advisor === "object") {
        Object.assign(merged.advisor, user.advisor);
      }
    }
  } catch {
    // missing/unreadable/invalid -> built-in defaults (fail open)
  }
  return merged;
}
