// Tail-read + turn-shape analysis for the model-advisor Stop hook. Mirrors
// ctx-budget's tail-read pattern (openSync/fstatSync/readSync) so cost stays
// constant even on large sessions -- only the last `bytes` are ever read.

import { openSync, readSync, fstatSync, closeSync } from "node:fs";

const HEAVY_TOOLS = /^(Edit|Write|Task|Agent|Workflow|NotebookEdit)$/;

/** Read the last `bytes` of `path` as utf8. */
export function readTail(path, bytes = 262144) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function turnShape(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  let toolCalls = 0;
  let heavyTools = false;
  for (const block of content) {
    if (block?.type !== "tool_use") continue;
    toolCalls++;
    if (HEAVY_TOOLS.test(block?.name ?? "")) heavyTools = true;
  }
  return { toolCalls, heavyTools };
}

/**
 * Parse JSONL tail text into up to `window` most-recent mainline assistant
 * turns (oldest first). Excludes isSidechain entries (subagent pollution) and
 * "<synthetic>" model entries. Broken lines are skipped individually, never
 * fatal. `model` is the most recent real (non-synthetic) assistant model seen.
 */
export function analyzeTurns(tailText, window) {
  const lines = typeof tailText === "string" ? tailText.split("\n") : [];
  const turns = [];
  let model = null;

  for (let i = lines.length - 1; i >= 0 && turns.length < window; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // broken line -> skip
    }
    if (entry?.isSidechain === true) continue;
    const message = entry?.message;
    const isAssistant = entry?.type === "assistant" || message?.role === "assistant";
    if (!isAssistant || !message) continue;
    if (message.model === "<synthetic>") continue;

    if (model === null) model = message.model ?? null; // most recent real model
    turns.unshift(turnShape(message));
  }

  return { ok: turns.length >= window, model, perTurn: turns };
}
