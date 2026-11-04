import { USD_PER_MILLION_INPUT_TOKENS, estimateTokens } from '../shared/token-estimate.js';
import type { TokenReport } from '../types/pipeline.js';

export { estimateTokens };

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Compare the raw-input token estimate with the compiled output; both use the same heuristic. */
export function buildTokenReport(inputTokens: number, outputText: string): TokenReport {
  const outputTokens = estimateTokens(outputText);
  const saved = Math.max(0, inputTokens - outputTokens);
  const reductionPct = inputTokens > 0 ? round((saved / inputTokens) * 100, 1) : 0;
  return {
    inputTokens,
    outputTokens,
    reductionPct,
    estimatedCostSavedUsd: round((saved / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS, 4),
    method: 'heuristic-chars-per-token',
  };
}
