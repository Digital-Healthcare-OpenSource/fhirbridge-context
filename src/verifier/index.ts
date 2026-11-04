import type {
  CitationAuditReport,
  NormalizedGraph,
  RehydrateOptions,
  VaultReader,
} from '../types/pipeline.js';
import { auditCitations } from './citation-auditor.js';
import { rehydrate } from './stream-rehydrator.js';

export { auditCitations, extractNumbers } from './citation-auditor.js';
export { splitSentences } from './sentence-splitter.js';
export { StreamRehydrator, extractTokens, rehydrate } from './stream-rehydrator.js';

export interface VerifyResult {
  report: CitationAuditReport;
  /** Present only when a vault was supplied. */
  rehydrated?: string;
}

/**
 * Audit citations against the graph and, when a vault is given, restore real names and dates.
 * The audit runs on the text as the LLM wrote it (tokens and shifted dates), the same frame the
 * graph is in.
 */
export function verify(
  text: string,
  graph: NormalizedGraph,
  vault?: VaultReader,
  opts?: RehydrateOptions,
): VerifyResult {
  const report = auditCitations(text, graph, vault);
  return vault ? { report, rehydrated: rehydrate(text, vault, opts) } : { report };
}
