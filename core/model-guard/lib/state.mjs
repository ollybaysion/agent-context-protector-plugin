// Advice state: model-advisor.mjs is the SOLE writer, one file per transcript.
// Deliberately NOT ctx-budget's state file -- a second read-modify-write actor
// would break its internal claim-then-emit race guarantee (DESIGN.md §4.4).

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

// CONTRACT: must match advicePath() in core/ctx-budget/statusline.mjs exactly,
// or the HUD reads the wrong file and silently shows no advice segment.
export function advicePath(transcriptPath) {
  const h = createHash("sha1").update(transcriptPath).digest("hex").slice(0, 16);
  return join(tmpdir(), "acp", "model-guard", `${h}.json`);
}

/**
 * Atomically persist the model advice for `transcriptPath`, or clear it when
 * `advice` is null/undefined. `advice` shape: { text, model, ts }.
 */
export function saveAdvice(transcriptPath, advice) {
  const dir = join(tmpdir(), "acp", "model-guard");
  mkdirSync(dir, { recursive: true });
  const p = advicePath(transcriptPath);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(advice ? { modelAdvice: advice } : {}));
  renameSync(tmp, p);
}
