// Attribution: the top context consumers since the last compact boundary,
// grouped by pattern FAMILY (lib/patterns.mjs). Individual invocations vary
// endlessly ("npm test --verbose -w pkg" vs "npm test"), so per-invocation
// lines hide repetition; folding them into one canonical label with a
// CUMULATIVE token total and a CALL COUNT makes a repeated habit visible
// ("npm test ~31k tok (4회)") instead of four scattered ~8k lines (#8).
//
// Kept in its own module so the scan + aggregation is unit-testable without the
// hook's stdin plumbing. The hot path is unchanged: this streams the transcript
// only when an alert actually fires, never on the per-event fast path.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { toolPattern } from "../../lib/patterns.mjs";

export const fmtK = (n) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);

// Pattern labels derive from model-controlled command text / file paths and
// flow into a user-facing systemMessage AND the statusline HUD, so collapse
// every run of whitespace-or-control into one space — a plain \s+ collapse
// leaves ESC and other C0 control chars intact, a terminal-injection vector
// into the HUD. (toolPattern's Bash subcommands are already charset-restricted,
// but an unknown-command basename or file extension can still carry them.)
export const cleanLabel = (s) => s.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();

// Scan the transcript and return up to `topN` pattern families, biggest first,
// each as { label, tokens (cumulative estimate), calls }. Formatting (tok vs
// per-turn $) is the caller's job — ctx-budget prices it against the model; a
// bare token estimate is the fallback when the model is unpriced.
export async function topConsumers(transcriptPath, topN = 3) {
  const pending = new Map(); // tool_use_id -> {label, inputChars}
  let sums = new Map(); // pattern label -> {chars, calls}
  await new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(transcriptPath),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (j?.type === "system" && j?.subtype === "compact_boundary") {
        sums = new Map(); // content before the boundary is no longer in context
        pending.clear();
        return;
      }
      if (j?.isSidechain === true) return;
      const content = j?.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type === "tool_use") {
          const inputChars = JSON.stringify(block.input ?? {}).length;
          pending.set(block.id, {
            label: cleanLabel(toolPattern(block.name, block.input)),
            inputChars,
          });
        }
        if (block?.type === "tool_result" && pending.has(block.tool_use_id)) {
          const { label, inputChars } = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          let chars = inputChars;
          if (typeof block.content === "string") chars += block.content.length;
          else if (Array.isArray(block.content))
            for (const c of block.content)
              if (c?.type === "text") chars += (c.text ?? "").length;
          const e = sums.get(label) ?? { chars: 0, calls: 0 };
          e.chars += chars;
          e.calls += 1;
          sums.set(label, e);
        }
      }
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
  return [...sums.entries()]
    .sort((a, b) => b[1].chars - a[1].chars)
    .slice(0, topN)
    .map(([label, { chars, calls }]) => ({
      label,
      tokens: Math.round(chars / 4),
      calls,
    }));
}
