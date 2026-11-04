/**
 * Heuristic token estimator (≈4 UTF-8 bytes per token, the common rule of thumb for
 * BPE tokenizers on English/JSON). Both "before" and "after" figures use this same
 * function, so the reported reduction ratio is internally consistent; absolute counts
 * are estimates, not tokenizer-exact.
 */
export const CHARS_PER_TOKEN = 4;

/** Input-token price used for the "cost saved" figure (USD per 1M tokens). */
export const USD_PER_MILLION_INPUT_TOKENS = 3;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / CHARS_PER_TOKEN);
}
