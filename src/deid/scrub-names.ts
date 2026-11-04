/**
 * Name pass of the free-text scrubber.
 *
 * Registered names (from structured data) are matched after NFKC + diacritic + apostrophe +
 * case folding, with offsets mapped back to the original text. They are NEVER exempted as
 * medical terminology. Cue-discovered ("heuristic") names are, so "Dr. Wilson ... Wilson
 * disease" keeps the disease. A name part shared by several registered entities becomes its
 * own token holding only that word, never silently resolving to one of them.
 */
import { isEponymFollower, isEponymSurname, isMedicalTerm } from '../dictionaries/medical-eponyms.js';
import {
  CREDENTIAL_NAME_RES,
  HAS_CJK,
  JA_CUE_RE,
  JA_HONORIFIC_RE,
  KO_CUE_RE,
  KO_HONORIFIC_RE,
  RELATION_CUE_RE,
  STOP_WORDS,
  TITLE_CUE_RE,
  VI_CUE_RE,
  WEAK_CUE_RE,
  isCjkStopWord,
} from './scrub-name-patterns.js';
import { PH_CLOSE, PH_OPEN, bump, type KnownName, type Run } from './scrub-types.js';
import { canonicalName } from './vault-names.js';

type Category = KnownName['category'];

interface NameEntry {
  token: string;
  category: Category;
  variants: string[];
  heuristic: boolean;
  /** Match the whole variant only (place terms): no per-word parts. */
  wholeOnly?: boolean;
}

/* --------------------------------- folding --------------------------------- */

interface Folded {
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

const foldKey = (s: string): string => {
  const cached = FOLD_KEY_CACHE.get(s);
  if (cached !== undefined) return cached;
  const key = foldWithMap(s.trim()).text.replace(/\s+/g, ' ');
  if (FOLD_KEY_CACHE.size >= FOLD_KEY_CACHE_MAX) FOLD_KEY_CACHE.clear();
  FOLD_KEY_CACHE.set(s, key);
  return key;
};

/* --------------------------------- matcher --------------------------------- */

interface Slot {
  entry: NameEntry;
  ambiguous: boolean;
}

interface Matcher {
  latin: RegExp | null;
  cjk: RegExp | null;
  slots: Map<string, Slot>;
}

const TITLE_SET = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'doctor', 'prof', 'md', 'rn', 'np', 'phd']);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_CHARS = String.raw`\p{L}\p{N}${PH_OPEN}${PH_CLOSE}`;

function nameParts(variant: string): string[] {
  return variant
    .split(/[\s,]+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter((w) => {
      const min = HAS_CJK.test(w) ? 2 : 3;
      const key = w.toLowerCase();
      return w.length >= min && !TITLE_SET.has(key) && !STOP_WORDS.has(key);
    });
}

function alternation(forms: string[], bounded: boolean): RegExp | null {
  if (forms.length === 0) return null;
  const alt = [...forms].sort((a, b) => b.length - a.length).map((k) => escapeRe(k).replace(/ /g, '\\s+')).join('|');
  const src = bounded ? `(?<![${WORD_CHARS}])(?:${alt})(?![${WORD_CHARS}])` : `(?:${alt})`;
  return new RegExp(src, 'gu');
}

function compileMatcher(entries: readonly NameEntry[]): Matcher {
  const slots = new Map<string, Slot>();
  const add = (key: string, entry: NameEntry): void => {
    if (key.length < 2) return;
    const slot = slots.get(key);
    if (!slot) slots.set(key, { entry, ambiguous: false });
    else if (slot.entry.token !== entry.token) slots.set(key, { entry: slot.entry, ambiguous: true });
  };
  for (const e of entries) {
    for (const v of e.variants) {
      add(foldKey(v), e);
      if (!e.wholeOnly) for (const p of nameParts(v)) add(foldKey(p), e);
    }
  }
  const keys = [...slots.keys()];
  return {
    latin: alternation(keys.filter((k) => !HAS_CJK.test(k)), true),
    cjk: alternation(keys.filter((k) => HAS_CJK.test(k)), false),
    slots,
  };
}

const matcherCache = new WeakMap<object, WeakMap<readonly KnownName[], Matcher>>();

function matcherFor(run: Run, known: readonly KnownName[]): Matcher {
  let byList = matcherCache.get(run.ctx.vault);
  if (!byList) matcherCache.set(run.ctx.vault, (byList = new WeakMap()));
  let m = byList.get(known);
  if (!m) {
    const entries: NameEntry[] = [];
    for (const k of known) {
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
    byList.set(known, (m = compileMatcher(entries)));
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

function collectHits(text: string, folded: Folded, re: RegExp, m: Matcher, run: Run): Hit[] {
  const hits: Hit[] = [];
  re.lastIndex = 0;
  for (let match = re.exec(folded.text); match !== null; match = re.exec(folded.text)) {
    const first = match.index;
    const last = first + match[0].length - 1;
    const from = folded.start[first];
    const to = folded.end[last];
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const slot = m.slots.get(match[0].replace(/\s+/g, ' '));
    if (from === undefined || to === undefined || !slot) continue;
    const original = text.slice(from, to);
    if (slot.entry.heuristic && !/\s/.test(original) && isTerminologyUse(original, text.slice(to))) continue;
    bump(run.acc, slot.entry.category);
    const token = slot.ambiguous
      ? run.ctx.vault.tokenFor(slot.entry.category, original, { ambiguous: true })
      : slot.entry.token;
    hits.push({ from, to, replacement: token });
  }
  return hits;
}

function sweepNames(text: string, m: Matcher, run: Run): string {
  if (!m.latin && !m.cjk) return text;
  const folded = foldWithMap(text);
  const hits = [
    ...(m.latin ? collectHits(text, folded, m.latin, m, run) : []),
    ...(m.cjk ? collectHits(text, folded, m.cjk, m, run) : []),
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

/* ------------------------------- cue discovery ------------------------------- */

function isNameWord(word: string, next: string | undefined, strong: boolean): boolean {
  const clean = word.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '');
  if (clean.length < 2 || STOP_WORDS.has(clean.toLowerCase())) return false;
  if (!isMedicalTerm(clean)) return true;
  if (!strong || !isEponymSurname(clean)) return false;
  return !/['’]s$/i.test(clean) && !isEponymFollower(next);
}

/** End offset of the longest prefix of `raw` made of plausible name words (0 if none). */
function nameExtent(raw: string, strong: boolean): number {
  const words = [...raw.matchAll(/\S+/g)];
  let end = 0;
  for (const [i, w] of words.entries()) {
    const text = w[0];
    const wordEnd = (w.index ?? 0) + text.length;
    if (/^\p{Lu}\.$/u.test(text)) {
      if (i === 0) break;
      end = wordEnd;
    } else if (isNameWord(text, words[i + 1]?.[0], strong)) {
      end = wordEnd;
    } else break;
  }
  return end;
}

type Pick = (cue: string) => { category: Category; strong: boolean };

function record(run: Run, found: NameEntry[], category: Category, name: string): string {
  const token = run.ctx.vault.tokenFor(category, name, { patientKey: run.ctx.patientKey });
  found.push({ token, category, variants: [name], heuristic: true });
  run.ctx.onDiscovered?.({
    category,
    variants: [name],
    patientKey: category === 'PATIENT' ? run.ctx.patientKey : undefined,
    heuristic: true,
  });
  bump(run.acc, category);
  return token;
}

function cueHandler(run: Run, found: NameEntry[], pick: Pick) {
  return (...args: unknown[]): string => {
    const g = args[args.length - 1] as { pre: string; name: string; cue?: string };
    const { category, strong } = pick(g.cue ?? '');
    const end = nameExtent(g.name, strong);
    let consumed = g.name.slice(0, end).replace(/,$/, '');
    if (!consumed || canonicalName(consumed).length === 0) return args[0] as string;
    const possessive = /['’]s$/i.exec(consumed)?.[0] ?? '';
    consumed = possessive ? consumed.slice(0, -possessive.length) : consumed;
    return `${g.pre}${record(run, found, category, consumed)}${possessive}${g.name.slice(end)}`;
  };
}

/** Handler for CJK/Hangul runs: the whole run is the name unless it is a clinical word. */
function runHandler(run: Run, found: NameEntry[], category: Category) {
  return (...args: unknown[]): string => {
    const g = args[args.length - 1] as { pre: string; name: string };
    if (isCjkStopWord(g.name)) return args[0] as string;
    return `${g.pre}${record(run, found, category, g.name)}`;
  };
}

function cueNames(text: string, run: Run, found: NameEntry[]): string {
  let out = text;
  const credential = cueHandler(run, found, () => ({ category: 'PROVIDER', strong: true }));
  for (const re of CREDENTIAL_NAME_RES) out = out.replace(re, credential);
  out = out.replace(
    TITLE_CUE_RE,
    cueHandler(run, found, (cue) => ({
      category: /^(?:mr|mrs|ms|miss)$/i.test(cue) ? 'PATIENT' : 'PROVIDER',
      strong: true,
    })),
  );
  out = out.replace(
    WEAK_CUE_RE,
    cueHandler(run, found, (cue) => ({
      category: /^(?:patient|pt)/i.test(cue) ? 'PATIENT' : 'PROVIDER',
      strong: false,
    })),
  );
  out = out.replace(RELATION_CUE_RE, cueHandler(run, found, () => ({ category: 'PERSON', strong: false })));
  out = out.replace(
    VI_CUE_RE,
    cueHandler(run, found, (cue) => ({
      category: /^(?:b[eệ]nh|bn)/i.test(cue) ? 'PATIENT' : 'PERSON',
      strong: false,
    })),
  );
  out = out.replace(JA_CUE_RE, runHandler(run, found, 'PERSON'));
  out = out.replace(KO_CUE_RE, runHandler(run, found, 'PATIENT'));
  out = out.replace(JA_HONORIFIC_RE, runHandler(run, found, 'PERSON'));
  return out.replace(KO_HONORIFIC_RE, runHandler(run, found, 'PERSON'));
}

/** Shield tokens already issued so name sweeps cannot touch them. */
const TOKEN_RE = /\[[A-Z_]+_\d+\]/g;

export function scrubNames(text: string, run: Run): string {
  let out = text.replace(TOKEN_RE, (m) => run.shield.hold(m));
  if (run.ctx.knownNames?.length) out = sweepNames(out, matcherFor(run, run.ctx.knownNames), run);
  const found: NameEntry[] = [];
  out = cueNames(out, run, found);
  // A name discovered once is replaced everywhere else in the same text (e.g. surname alone).
  if (found.length > 0) out = sweepNames(out, compileMatcher(found), run);
  // "Torres, Michael" swept part-by-part would read "[PATIENT_1], [PATIENT_1]": collapse.
  return out.replace(/(\[[A-Z_]+_\d+\])(?:,?\s+\1)+/g, '$1');
}
