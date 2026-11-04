/**
 * Registered-name matcher.
 *
 * Registered names (from structured data) are matched after NFKC + diacritic + apostrophe +
 * case folding, with offsets mapped back to the original text. They are NEVER exempted as
 * medical terminology. Cue-discovered ("heuristic") names are, so "Dr. Wilson ... Wilson
 * disease" keeps the disease. A name part shared by several registered entities becomes its
 * own token holding only that word, never silently resolving to one of them.
 *
 * Two engines share one slot table: a bounded alternation regex (the record owner's names, place
 * terms, discovered names) and a word-window lookup that scales to every patient's names at once.
 */
import { isEponymFollower, isEponymSurname, isMedicalTerm } from '../dictionaries/medical-eponyms.js';
import { foldKey, foldWithMap, type Folded } from './name-folding.js';
import { HAS_CJK, STOP_WORDS } from './scrub-name-patterns.js';
import { PH_CLOSE, PH_OPEN, bump, type KnownName, type Run } from './scrub-types.js';
import { canonicalName } from './vault-names.js';

export type Category = Exclude<KnownName['category'], 'IDENTIFIER'>;

export interface NameEntry {
  token: string;
  category: Category;
  variants: string[];
  heuristic: boolean;
  /** Match the whole variant only (place terms): no per-word parts. */
  wholeOnly?: boolean;
}

interface Slot {
  entry: NameEntry;
  ambiguous: boolean;
}

export interface Matcher {
  latin: RegExp | null;
  cjk: RegExp | null;
  slots: Map<string, Slot>;
  /** Word-window index (normalized keys) used instead of `latin` for the all-patients matcher. */
  words: Map<string, Slot> | null;
  maxWords: number;
  /** Keys that may carry a plural "s" ("the Zarbowskis"). */
  plural: ReadonlySet<string>;
}

const TITLE_SET = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'doctor', 'prof', 'md', 'rn', 'np', 'phd']);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_CHARS = String.raw`\p{L}\p{N}${PH_OPEN}${PH_CLOSE}`;
const WORD_RE = new RegExp(`[${WORD_CHARS}][${WORD_CHARS}']*`, 'gu');
const MIN_PLURAL_KEY = 4;
const MAX_WORD_WINDOW = 4;
const stripEdges = (w: string): string => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');

/** Words of a variant that may stand alone ("Zarbowski-Smith" -> whole, "Zarbowski", "Smith"). */
export function nameParts(variant: string): string[] {
  const out: string[] = [];
  for (const raw of variant.split(/[\s,]+/)) {
    const w = stripEdges(raw);
    const pieces = w.includes('-') ? [w, ...w.split('-').map(stripEdges)] : [w];
    for (const p of pieces) {
      const min = HAS_CJK.test(p) ? 2 : 3;
      const key = p.toLowerCase();
      if (p.length >= min && !TITLE_SET.has(key) && !STOP_WORDS.has(key)) out.push(p);
    }
  }
  return out;
}

function alternation(forms: string[], bounded: boolean, plural: ReadonlySet<string>): RegExp | null {
  if (forms.length === 0) return null;
  const alt = [...forms]
    .sort((a, b) => b.length - a.length)
    .map((k) => escapeRe(k).replace(/ /g, '\\s+') + (plural.has(k) ? 's?' : ''))
    .join('|');
  const src = bounded ? `(?<![${WORD_CHARS}])(?:${alt})(?![${WORD_CHARS}])` : `(?:${alt})`;
  return new RegExp(src, 'gu');
}

function addSlot(slots: Map<string, Slot>, key: string, entry: NameEntry): void {
  const minLength = HAS_CJK.test(key) ? 1 : 2;
  if (key.length < minLength) return;
  const slot = slots.get(key);
  if (!slot) slots.set(key, { entry, ambiguous: false });
  else if (slot.entry.token !== entry.token) slots.set(key, { entry: slot.entry, ambiguous: true });
}

function buildSlots(entries: readonly NameEntry[]): { slots: Map<string, Slot>; plural: Set<string> } {
  const slots = new Map<string, Slot>();
  const plural = new Set<string>();
  for (const e of entries) {
    for (const v of e.variants) {
      addSlot(slots, foldKey(v), e);
      if (e.wholeOnly) continue;
      for (const p of nameParts(v)) {
        const key = foldKey(p);
        addSlot(slots, key, e);
        if (key.length >= MIN_PLURAL_KEY && /^\p{L}+$/u.test(key)) plural.add(key);
      }
    }
  }
  return { slots, plural };
}

/** Regex matcher: bounded alternation over folded keys (owner names, place terms, discoveries). */
export function compileMatcher(entries: readonly NameEntry[]): Matcher {
  const { slots, plural } = buildSlots(entries);
  const keys = [...slots.keys()];
  return {
    latin: alternation(keys.filter((k) => !HAS_CJK.test(k)), true, plural),
    cjk: alternation(keys.filter((k) => HAS_CJK.test(k)), false, new Set()),
    slots,
    words: null,
    maxWords: 0,
    plural,
  };
}

/** Word-window matcher: O(text) lookups regardless of how many names are registered. */
export function compileWordMatcher(entries: readonly NameEntry[]): Matcher {
  const { slots, plural } = buildSlots(entries);
  const words = new Map<string, Slot>();
  let maxWords = 1;
  for (const [key, slot] of slots) {
    if (HAS_CJK.test(key)) continue;
    const norm = key.replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (norm.length < 2) continue;
    const count = norm.split(' ').length;
    if (count > MAX_WORD_WINDOW) continue;
    maxWords = Math.max(maxWords, count);
    const old = words.get(norm);
    if (!old) words.set(norm, slot);
    else if (old.entry.token !== slot.entry.token) words.set(norm, { entry: old.entry, ambiguous: true });
  }
  const cjkKeys = [...slots.keys()].filter((k) => HAS_CJK.test(k));
  return { latin: null, cjk: alternation(cjkKeys, false, new Set()), slots, words, maxWords, plural };
}

const matcherCache = new WeakMap<object, WeakMap<readonly KnownName[], Matcher>>();

/** Compiled (and cached per vault + list identity) matcher for a list of registered names. */
export function matcherFor(run: Run, known: readonly KnownName[], mode: 'regex' | 'words'): Matcher {
  let byList = matcherCache.get(run.ctx.vault);
  if (!byList) matcherCache.set(run.ctx.vault, (byList = new WeakMap()));
  let m = byList.get(known);
  if (!m) {
    const entries: NameEntry[] = [];
    for (const k of known) {
      if (k.category === 'IDENTIFIER') continue;
      if (k.category === 'ADDRESS') {
        for (const v of k.variants.map((x) => x.trim()).filter((x) => x.length >= 3)) {
          const token = run.ctx.vault.tokenFor('ADDRESS', v);
          entries.push({ token, category: 'ADDRESS', variants: [v], heuristic: false, wholeOnly: true });
        }
        continue;
      }
      const variants = k.variants.filter((v) => canonicalName(v).length > 0);
      if (variants.length === 0) continue; // single-letter / empty names are skipped
      const token = run.ctx.vault.registerName(k.category, variants, {
        patientKey: k.patientKey ?? run.ctx.patientKey,
      });
      entries.push({ token, category: k.category, variants, heuristic: k.heuristic === true });
    }
    byList.set(known, (m = mode === 'words' ? compileWordMatcher(entries) : compileMatcher(entries)));
  }
  return m;
}

/* ---------------------------------- sweep ---------------------------------- */

/** A surname-eponym followed by a possessive or medical noun ("Wilson disease") is terminology. */
function isTerminologyUse(word: string, after: string): boolean {
  if (!isMedicalTerm(word)) return false;
  if (!isEponymSurname(word)) return true;
  if (/^['’]s\b/u.test(after)) return true;
  return isEponymFollower(/^\s+([\p{L}-]+)/u.exec(after)?.[1]);
}

interface Hit {
  from: number;
  to: number;
  replacement: string;
}

function slotFor(m: Matcher, key: string): Slot | undefined {
  const exact = m.slots.get(key);
  if (exact) return exact;
  const bare = key.endsWith('s') ? key.slice(0, -1) : '';
  return bare && m.plural.has(bare) ? m.slots.get(bare) : undefined;
}

function hitFor(text: string, from: number, to: number, slot: Slot, run: Run): Hit | undefined {
  const original = text.slice(from, to);
  if (slot.entry.heuristic && !/\s/.test(original) && isTerminologyUse(original, text.slice(to))) return undefined;
  bump(run.acc, slot.entry.category);
  const token = slot.ambiguous
    ? run.ctx.vault.tokenFor(slot.entry.category, original, { ambiguous: true })
    : slot.entry.token;
  return { from, to, replacement: token };
}

function collectRegexHits(text: string, folded: Folded, re: RegExp, m: Matcher, run: Run): Hit[] {
  const hits: Hit[] = [];
  re.lastIndex = 0;
  for (let match = re.exec(folded.text); match !== null; match = re.exec(folded.text)) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const from = folded.start[match.index];
    const to = folded.end[match.index + match[0].length - 1];
    const slot = slotFor(m, match[0].replace(/\s+/g, ' '));
    if (from === undefined || to === undefined || !slot) continue;
    const hit = hitFor(text, from, to, slot, run);
    if (hit) hits.push(hit);
  }
  return hits;
}

const GAP_RE = /^[\s,-]{1,3}$/;

function collectWordHits(text: string, folded: Folded, m: Matcher, run: Run): Hit[] {
  const words = [...folded.text.matchAll(WORD_RE)].map((w) => ({ at: w.index ?? 0, word: w[0] }));
  const index = m.words;
  const hits: Hit[] = [];
  if (!index) return hits;
  for (let i = 0; i < words.length; ) {
    let consumed = 0;
    for (let n = Math.min(m.maxWords, words.length - i); n >= 1 && consumed === 0; n -= 1) {
      const last = words[i + n - 1];
      const first = words[i];
      if (!first || !last) continue;
      let joined = first.word;
      let contiguous = true;
      for (let k = 1; k < n && contiguous; k += 1) {
        const prev = words[i + k - 1];
        const cur = words[i + k];
        if (!prev || !cur) break;
        contiguous = GAP_RE.test(folded.text.slice(prev.at + prev.word.length, cur.at));
        joined += ` ${cur.word}`;
      }
      if (!contiguous) continue;
      const slot = index.get(joined) ?? (n === 1 && joined.endsWith('s') && m.plural.has(joined.slice(0, -1)) ? index.get(joined.slice(0, -1)) : undefined);
      const from = folded.start[first.at];
      const to = folded.end[last.at + last.word.length - 1];
      if (!slot || from === undefined || to === undefined) continue;
      const hit = hitFor(text, from, to, slot, run);
      if (hit) hits.push(hit);
      consumed = n;
    }
    i += Math.max(consumed, 1);
  }
  return hits;
}

export function sweepNames(text: string, m: Matcher, run: Run): string {
  if (!m.latin && !m.words && !m.cjk) return text;
  const folded = foldWithMap(text);
  const hits = [
    ...(m.latin ? collectRegexHits(text, folded, m.latin, m, run) : []),
    ...(m.words ? collectWordHits(text, folded, m, run) : []),
    ...(m.cjk ? collectRegexHits(text, folded, m.cjk, m, run) : []),
  ].sort((a, b) => a.from - b.from || b.to - a.to);
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    if (h.from < cursor) continue; // overlaps an earlier (longer-first) hit
    out += text.slice(cursor, h.from) + h.replacement;
    cursor = h.to;
  }
  return out + text.slice(cursor);
}
