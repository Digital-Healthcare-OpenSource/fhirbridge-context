/** De-identification of decoded attachment documents (free text pulled out of DocumentReference). */
import type { DecodedDocument } from '../types/pipeline.js';
import { scrubText } from './clinical-text-scrubber.js';
import type { KeyMapper } from './id-pseudonymizer.js';
import type { RuleStats } from './safe-harbor-rules.js';
import type { ScrubContext, ScrubResult } from './scrub-types.js';

const MAX_CHUNK = 4000;
/** Decoded document text beyond this many characters is dropped (bounds scrub time). */
export const MAX_DOCUMENT_CHARS = 200_000;
export const TRUNCATION_MARKER = '[TRUNCATED]';

export function addStats(stats: RuleStats, r: ScrubResult): void {
  for (const [k, n] of Object.entries(r.counts)) {
    const c = k as keyof RuleStats['replacements'];
    stats.replacements[c] = (stats.replacements[c] ?? 0) + (n ?? 0);
  }
  stats.datesShifted += r.datesShifted;
  stats.zip3Restricted += r.zip3Restricted;
  stats.zip3Generalized += r.zip3Generalized;
}

export function deidDocument(
  doc: DecodedDocument,
  mapper: KeyMapper,
  ctx: Omit<ScrubContext, 'dateShiftDays'>,
  days: number | undefined,
  stats: RuleStats,
): DecodedDocument {
  const run = (text: string): string => {
    const r = scrubText(text, { ...ctx, dateShiftDays: days });
    addStats(stats, r);
    return r.text;
  };
  const capped = (t: string): string =>
    t.length > MAX_DOCUMENT_CHARS ? `${run(t.slice(0, MAX_DOCUMENT_CHARS))}${TRUNCATION_MARKER}` : run(t);
  const resourceKeyOut = mapper.mapKey(doc.resourceKey);
  const joined = doc.chunks.join('');
  // Chunks are hard slices of the full text: scrub it whole so names are not split across chunks.
  if (doc.chunks.length > 0 && joined.startsWith(doc.text)) {
    const clean = capped(joined);
    const chunks: string[] = [];
    for (let i = 0; i < clean.length; i += MAX_CHUNK) chunks.push(clean.slice(i, i + MAX_CHUNK));
    return {
      ...doc,
      resourceKey: resourceKeyOut,
      text: clean.slice(0, MAX_CHUNK),
      chunks,
      truncated: doc.truncated || joined.length > MAX_DOCUMENT_CHARS,
    };
  }
  return {
    ...doc,
    resourceKey: resourceKeyOut,
    text: capped(doc.text),
    chunks: doc.chunks.map(capped),
    truncated: doc.truncated || joined.length > MAX_DOCUMENT_CHARS,
  };
}
