/** Unicode folding (NFKC, diacritics, apostrophes, case) with offset maps back to the source text. */

export interface Folded {
  text: string;
  /** Original start/end offset for every UTF-16 unit of `text`. */
  start: number[];
  end: number[];
}

const APOSTROPHES = /[’‘ʼʹ′`´]/g;

/**
 * Per-character fold cache. The alphabet seen in clinical text is small, so this stays bounded
 * in practice; the size cap guards against adversarial inputs that cycle through Unicode.
 */
const FOLD_CACHE = new Map<string, string>();
const FOLD_CACHE_MAX = 4096;

function foldCharSlow(ch: string): string {
  return ch
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(APOSTROPHES, "'");
}

function foldChar(ch: string): string {
  const code = ch.charCodeAt(0);
  // ASCII fast path (identical result to the slow path): only case and the backtick change.
  if (ch.length === 1 && code < 0x80) {
    if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 0x20);
    return code === 0x60 ? "'" : ch;
  }
  const cached = FOLD_CACHE.get(ch);
  if (cached !== undefined) return cached;
  const folded = foldCharSlow(ch);
  if (FOLD_CACHE.size < FOLD_CACHE_MAX) FOLD_CACHE.set(ch, folded);
  return folded;
}

/** Fold a whole string, remembering where every folded unit came from. */
export function foldWithMap(text: string): Folded {
  let out = '';
  const start: number[] = [];
  const end: number[] = [];
  let pos = 0;
  for (const ch of text) {
    const next = pos + ch.length;
    const f = foldChar(ch);
    if (f === '') {
      // Stripped combining mark: it belongs to the previous character.
      if (end.length > 0) end[end.length - 1] = next;
    } else {
      for (let i = 0; i < f.length; i += 1) {
        start.push(pos);
        end.push(next);
      }
      out += f;
    }
    pos = next;
  }
  return { text: out, start, end };
}

/**
 * Folded, whitespace-collapsed key for a name variant or part. Memoized: the same provider
 * names are folded again for every patient's matcher in a multi-patient export.
 */
const FOLD_KEY_CACHE = new Map<string, string>();
const FOLD_KEY_CACHE_MAX = 50_000;

export const foldKey = (s: string): string => {
  const cached = FOLD_KEY_CACHE.get(s);
  if (cached !== undefined) return cached;
  const key = foldWithMap(s.trim()).text.replace(/\s+/g, ' ');
  if (FOLD_KEY_CACHE.size >= FOLD_KEY_CACHE_MAX) FOLD_KEY_CACHE.clear();
  FOLD_KEY_CACHE.set(s, key);
  return key;
};
