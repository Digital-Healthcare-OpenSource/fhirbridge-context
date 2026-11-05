/**
 * Split a FHIR reference into `prefix` + `Type/id` + optional `/_history/n`, in linear time.
 *
 *   "Patient/1"                                → { prefix: '', type: 'Patient', id: '1', history: '' }
 *   "https://x/fhir/Observation/o1/_history/2" → { prefix: 'https://x/fhir/', type: 'Observation', … }
 *
 * Implemented with `split('/')` instead of an unanchored regex: patterns such as
 * `([A-Za-z]+)\/(…)$` re-scan from every start position and go quadratic on long inputs.
 */
export interface ReferenceTail {
  prefix: string;
  type: string;
  id: string;
  history: string;
}

const TYPE_RE = /^[A-Za-z]+$/;
const MAX_REFERENCE_LENGTH = 4096;

export function parseReferenceTail(reference: string): ReferenceTail | undefined {
  if (reference.length === 0 || reference.length > MAX_REFERENCE_LENGTH) return undefined;
  const parts = reference.split('/');
  let end = parts.length;
  let history = '';
  if (end >= 4 && parts[end - 2] === '_history' && (parts[end - 1] ?? '') !== '') {
    history = `/_history/${parts[end - 1]}`;
    end -= 2;
  }
  if (end < 2) return undefined;
  const type = parts[end - 2] ?? '';
  const id = parts[end - 1] ?? '';
  if (!TYPE_RE.test(type) || id === '' || id.includes('?') || id.includes('#')) return undefined;
  const prefixParts = parts.slice(0, end - 2);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join('/')}/` : '';
  return { prefix, type, id, history };
}
