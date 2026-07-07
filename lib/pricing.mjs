// Model pricing — SINGLE SOURCE shared by core/analyze (cost reports) and
// core/ctx-budget (nudge cost-estimate segment). Extracted verbatim from
// analyze.mjs (PR #14 lineage); same single-source contract as gate-rules.mjs:
// a price change lands here once and every consumer follows.
//
// $/MTok base list prices (input, output). Derived rates: cache read 0.1x
// input, cache write 1.25x (5m TTL) / 2x (1h TTL). Model ids resolve by
// longest-prefix match so dated full ids ("claude-haiku-4-5-20251001") hit
// their alias row. Unknown models (e.g. "<synthetic>") are NEVER guessed:
// priceFor returns null and the caller must skip pricing (unpriced bucket in
// analyze, omitted cost segment in ctx-budget).
// NOTE: these are API list prices — for subscription (Max) usage the $ figures
// are an API-equivalent reference, not an actual bill.

export const PRICE_BASIS = "2026-06 list $/MTok";

export const PRICES = [
  ["claude-fable-5", { input: 10, output: 50 }],
  ["claude-mythos-5", { input: 10, output: 50 }],
  ["claude-opus-4-8", { input: 5, output: 25 }],
  ["claude-opus-4-7", { input: 5, output: 25 }],
  ["claude-opus-4-6", { input: 5, output: 25 }],
  ["claude-opus-4-5", { input: 5, output: 25 }],
  ["claude-opus-4-1", { input: 15, output: 75 }],
  ["claude-opus-4-0", { input: 15, output: 75 }],
  ["claude-opus-4-2", { input: 15, output: 75 }], // dated full id claude-opus-4-20250514
  ["claude-sonnet-5", { input: 3, output: 15 }], // intro $2/$10 through 2026-08-31; list price used
  ["claude-sonnet-4-6", { input: 3, output: 15 }],
  ["claude-sonnet-4-5", { input: 3, output: 15 }],
  ["claude-sonnet-4-2", { input: 3, output: 15 }], // dated full id claude-sonnet-4-20250514
  ["claude-sonnet-4-0", { input: 3, output: 15 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }],
].sort((a, b) => b[0].length - a[0].length); // longest prefix wins

const priceCache = new Map();

/** Resolve `{input, output}` $/MTok for a model id, or null when unknown. */
export function priceFor(model) {
  if (typeof model !== "string" || model === "") return null;
  if (priceCache.has(model)) return priceCache.get(model);
  const hit = PRICES.find(([k]) => model.startsWith(k));
  const p = hit ? hit[1] : null;
  priceCache.set(model, p);
  return p;
}

// Cache-read multiplier off the base input rate: context already in the window
// is re-sent every turn at this rate on a warm cache hit. Basis for ctx-budget's
// per-turn figures (whole-context turn cost, per-consumer rent); nudge.mjs's
// costSegment uses the same 0.1 inline (design v2.1) — keep them in agreement.
export const CACHE_READ_MULT = 0.1;

// Fine-grained $ for status-bar figures (per-turn rent can be $0.00x): 3
// decimals under $0.10, 2 under $10, 1 above. Returns null for anything not a
// finite non-negative number so callers can omit the segment (unpriced model).
export function fmtUsd(n) {
  if (!(typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  if (n < 0.1) return `$${n.toFixed(3)}`;
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(1)}`;
}
