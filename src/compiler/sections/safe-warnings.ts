import type { IntegrityWarning, NormalizedGraph } from '../../types/pipeline.js';

/** The only `details` fields of a CODE_DISPLAY_MISMATCH that may reach LLM-facing output. */
export interface CodeMismatchDetails {
  rxcui?: string;
  expected?: string;
  display?: string;
}

/** Allow-listed projection of an integrity warning: nothing else is ever rendered. */
export interface SafeWarning {
  code: IntegrityWarning['code'];
  resourceKey: string;
  message: string;
  details?: CodeMismatchDetails;
}

function pick(details: Record<string, unknown> | undefined, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = details?.[name];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function mismatchDetails(w: IntegrityWarning): CodeMismatchDetails | undefined {
  if (w.code !== 'CODE_DISPLAY_MISMATCH') return undefined;
  const rxcui = pick(w.details, 'rxcui', 'rxnorm', 'code');
  const expected = pick(w.details, 'expected', 'rxnormName');
  const display = pick(w.details, 'display');
  const out: CodeMismatchDetails = {
    ...(rxcui !== undefined && { rxcui }),
    ...(expected !== undefined && { expected }),
    ...(display !== undefined && { display }),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Warnings of a DE-IDENTIFIED graph reduced to code, resource key, sanitized message and (for
 * code/display conflicts) rxcui/expected/display. Never call this with a pre-de-identification
 * graph: its warnings carry raw values.
 */
export function safeWarnings(deidGraph: NormalizedGraph): SafeWarning[] {
  return deidGraph.warnings.map((w) => {
    const details = mismatchDetails(w);
    return {
      code: w.code,
      resourceKey: w.resourceKey,
      message: w.message,
      ...(details && { details }),
    };
  });
}
