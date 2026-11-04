/**
 * Integrity warnings are rebuilt from fixed templates: the normalizer's messages and details
 * embed raw dates, reference strings, display names and original-id prefixes, so nothing but
 * the code and a pseudonymized resource key is carried over.
 */
import type { IntegrityWarning, IntegrityWarningCode } from '../types/pipeline.js';

const MESSAGES: Readonly<Record<IntegrityWarningCode, string>> = {
  EXCLUDED_ENTERED_IN_ERROR: 'Resource is excluded from clinical facts (entered in error or refuted).',
  CODE_DISPLAY_MISMATCH: 'Coding display conflicts with the dictionary display for its RxNorm code.',
  UNRESOLVED_REFERENCE: 'A reference in this resource could not be resolved.',
  ID_SHORTENED: 'Resource id exceeded 64 characters and was shortened.',
  LAST_UPDATED_INFERRED: 'meta.lastUpdated was missing and has been inferred.',
  ATTACHMENT_DECODED: 'An embedded text attachment was decoded.',
  BINARY_ATTACHMENT_STRIPPED: 'An embedded binary attachment was removed.',
  DUPLICATE_RESOURCE: 'A duplicate of this resource was dropped.',
  INVALID_RESOURCE: 'An input entry was not a valid FHIR resource and was skipped.',
};

const KEY_SHAPE = /^[A-Z][A-Za-z]+\/[^/\s]+$/;
const RXCUI = /^\d{1,10}$/;

export interface WarningSanitizerDeps {
  /** Maps an original `Type/id` to its (possibly pseudonymized) de-identified key. */
  mapKey(key: string): string;
  /** Scrubs a free-text value (pseudonymizes names, identifiers, dates). */
  scrub(text: string): string;
}

function safeDetails(w: IntegrityWarning, deps: WarningSanitizerDeps): Record<string, unknown> | undefined {
  if (w.code !== 'CODE_DISPLAY_MISMATCH' || !w.details) return undefined;
  const { code, expected, display } = w.details;
  const out: Record<string, unknown> = {};
  if (typeof code === 'string' && RXCUI.test(code)) out.rxcui = code;
  if (typeof expected === 'string') out.expected = expected; // dictionary value, not input data
  if (typeof display === 'string') out.display = deps.scrub(display);
  return out;
}

export function sanitizeWarnings(
  warnings: readonly IntegrityWarning[],
  deps: WarningSanitizerDeps,
): IntegrityWarning[] {
  return warnings.map((w) => {
    const resourceKey = KEY_SHAPE.test(w.resourceKey) ? deps.mapKey(w.resourceKey) : '(input)';
    const details = safeDetails(w, deps);
    return {
      code: w.code,
      resourceKey,
      message: MESSAGES[w.code] ?? 'Integrity warning.',
      ...(details ? { details } : {}),
    };
  });
}
