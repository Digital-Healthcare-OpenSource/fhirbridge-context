/**
 * Lookup of the registered PHI of one scrub scope (name parts, identifier digits/literals), used
 * to validate "structural" string members (codes, systems, units) that must never carry them.
 * Substring checks go through a prefix index so a value is checked in O(length), however many
 * names the scope holds.
 */
import { foldKey } from './name-folding.js';
import { nameParts } from './name-matcher.js';
import type { KnownName } from './scrub-types.js';

/** Terms indexed by their first `width` characters. */
class PrefixIndex {
  private readonly byPrefix = new Map<string, string[]>();
  constructor(
    readonly width: number,
    terms: Iterable<string>,
  ) {
    for (const t of terms) {
      if (t.length < width) continue;
      const key = t.slice(0, width);
      this.byPrefix.set(key, [...(this.byPrefix.get(key) ?? []), t]);
    }
  }
  /** True when `text` contains any indexed term as a substring. */
  occursIn(text: string): boolean {
    for (let i = 0; i + this.width <= text.length; i += 1) {
      const candidates = this.byPrefix.get(text.slice(i, i + this.width));
      if (candidates?.some((c) => text.startsWith(c, i))) return true;
    }
    return false;
  }
}

export interface RegisteredTerms {
  /** Folded name parts (3+ letters), matched as whole words. */
  names: ReadonlySet<string>;
  /** Name parts of 6+ letters, matched as substrings ("ZarbowskiFamily"). */
  longNames: PrefixIndex;
  /** Digit-only forms of registered identifiers (5+ digits). */
  digits: PrefixIndex;
  /** Alphanumeric-only lower-case forms of registered identifiers (6+ chars). */
  literals: PrefixIndex;
}

const MIN_LONG_NAME = 6;
const MIN_LITERAL = 6;
const MIN_DIGITS = 5;
const asciiAlnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const EMPTY: RegisteredTerms = {
  names: new Set(),
  longNames: new PrefixIndex(MIN_LONG_NAME, []),
  digits: new PrefixIndex(MIN_DIGITS, []),
  literals: new PrefixIndex(MIN_LITERAL, []),
};
const cache = new WeakMap<readonly KnownName[], RegisteredTerms>();

export function termsFor(known: readonly KnownName[] | undefined): RegisteredTerms {
  if (!known || known.length === 0) return EMPTY;
  const hit = cache.get(known);
  if (hit) return hit;
  const names = new Set<string>();
  const digits = new Set<string>();
  const literals = new Set<string>();
  for (const k of known) {
    if (k.category === 'IDENTIFIER') {
      for (const v of k.variants) {
        const d = v.replace(/\D/g, '');
        if (d.length >= MIN_DIGITS) digits.add(d);
        const a = asciiAlnum(v);
        if (a.length >= MIN_LITERAL) literals.add(a);
      }
    } else if (k.category !== 'ADDRESS') {
      for (const v of k.variants) for (const p of nameParts(v)) names.add(foldKey(p));
    }
  }
  const terms: RegisteredTerms = {
    names,
    longNames: new PrefixIndex(MIN_LONG_NAME, [...names].map(asciiAlnum)),
    digits: new PrefixIndex(MIN_DIGITS, digits),
    literals: new PrefixIndex(MIN_LITERAL, literals),
  };
  cache.set(known, terms);
  return terms;
}

/** Split camelCase, strip diacritics, lower-case, cut on every non-alphanumeric. */
function wordsOf(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** True when `value` contains a registered name part or identifier. */
export function mentionsRegistered(value: string, t: RegisteredTerms): boolean {
  if (t === EMPTY) return false;
  const flat = asciiAlnum(value);
  return (
    wordsOf(value).some((w) => t.names.has(w)) ||
    t.longNames.occursIn(flat) ||
    t.digits.occursIn(value.replace(/\D/g, '')) ||
    t.literals.occursIn(flat)
  );
}
