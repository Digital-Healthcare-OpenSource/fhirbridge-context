/**
 * Canonical forms for vault index keys. Two spellings of one identifier must map to the same
 * canonical string so they share a token; two different people must never collapse together.
 */
import type { PhiCategory } from '../types/pipeline.js';

export const NAME_CATEGORIES: ReadonlySet<PhiCategory> = new Set(['PATIENT', 'PROVIDER', 'PERSON']);

/** Honorifics/credentials only. Generational suffixes (jr, sr, ii...) are deliberately NOT here. */
const TITLE_WORDS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'professor', 'md', 'do', 'rn', 'np',
  'pa', 'pac', 'phd', 'dds', 'dmd', 'pharmd', 'mbbs',
]);
const DIGITS_ONLY: ReadonlySet<PhiCategory> = new Set(['PHONE', 'FAX', 'SSN']);
const ALNUM_ONLY: ReadonlySet<PhiCategory> = new Set([
  'MRN', 'HEALTH_PLAN', 'ACCOUNT', 'LICENSE', 'VEHICLE', 'DEVICE', 'BIOMETRIC', 'PHOTO', 'ID',
]);

/** Memo for canonicalName (pure). Cleared when full so memory stays bounded on huge inputs. */
const CANONICAL_CACHE = new Map<string, string>();
const CANONICAL_CACHE_MAX = 50_000;

/** Canonical form of a name: titles/punctuation/initials stripped, "Last, First" flipped, sorted. */
export function canonicalName(raw: string): string {
  const cached = CANONICAL_CACHE.get(raw);
  if (cached !== undefined) return cached;
  const result = computeCanonicalName(raw);
  if (CANONICAL_CACHE.size >= CANONICAL_CACHE_MAX) CANONICAL_CACHE.clear();
  CANONICAL_CACHE.set(raw, result);
  return result;
}

function computeCanonicalName(raw: string): string {
  const folded = raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const comma = folded.indexOf(',');
  const ordered = comma >= 0 ? `${folded.slice(comma + 1)} ${folded.slice(0, comma)}` : folded;
  const words = ordered
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 1 && !TITLE_WORDS.has(w));
  return [...new Set(words)].sort().join(' ');
}

export function canonicalize(category: PhiCategory, raw: string): string {
  const trimmed = raw.trim();
  let out: string;
  if (NAME_CATEGORIES.has(category)) out = canonicalName(trimmed);
  else if (DIGITS_ONLY.has(category)) {
    out = trimmed.replace(/\D/g, '');
    if (category !== 'SSN' && out.length === 11 && out.startsWith('1')) out = out.slice(1);
  } else if (ALNUM_ONLY.has(category)) {
    out = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
    // "MRN-4471902" (structured) and "4471902" (free text after the label) are the same record number.
    if (category === 'MRN' && /^mrn\d/.test(out)) out = out.slice(3);
  } else if (category === 'EMAIL' || category === 'IP') out = trimmed.toLowerCase();
  else if (category === 'URL') out = trimmed.toLowerCase().replace(/\/+$/, '');
  else out = trimmed.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return out || trimmed.toLowerCase();
}
