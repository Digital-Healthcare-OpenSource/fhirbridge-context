/**
 * Cue discovery: names that appear in free text only through a cue ("wife Karen", "Dr. Wilson",
 * "Name: Bob Smith", Japanese/Korean/Vietnamese cues) and are not in structured data.
 */
import { isEponymFollower, isEponymSurname, isMedicalTerm } from '../dictionaries/medical-eponyms.js';
import { compileMatcher, sweepNames, type Category, type NameEntry } from './name-matcher.js';
import {
  CREDENTIAL_NAME_RES,
  JA_CUE_RE,
  JA_HONORIFIC_RE,
  KO_CUE_RE,
  KO_HONORIFIC_RE,
  LABEL_CUE_RE,
  NAME_LIKE_STOP_WORDS,
  PERSON_TITLES,
  RELATION_CUE_RE,
  STOP_WORDS,
  TITLE_CUE_RE,
  VI_CUE_RE,
  WEAK_CUE_RE,
  isCjkStopWord,
} from './scrub-name-patterns.js';
import { bump, type Run } from './scrub-types.js';
import { canonicalName } from './vault-names.js';

interface Extent {
  strong: boolean;
  /** Vietnamese cues accept a capitalized stop word ("An") even as the first name word. */
  lenient: boolean;
}

function isNameWord(word: string, next: string | undefined, ext: Extent, consumed: number): boolean {
  const clean = word.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '');
  if (clean.length < 2) return false;
  const lower = clean.toLowerCase();
  if (STOP_WORDS.has(lower)) {
    // After a cue (and a first name word, or a Vietnamese cue) a capitalized "An" is a name.
    return NAME_LIKE_STOP_WORDS.has(lower) && /^\p{Lu}/u.test(clean) && (consumed > 0 || ext.lenient);
  }
  if (!isMedicalTerm(clean)) return true;
  if (!ext.strong || !isEponymSurname(clean)) return false;
  return !/['’]s$/i.test(clean) && !isEponymFollower(next);
}

/** End offset of the longest prefix of `raw` made of plausible name words (0 if none). */
function nameExtent(raw: string, ext: Extent): number {
  const words = [...raw.matchAll(/\S+/g)];
  let end = 0;
  let consumed = 0;
  for (const [i, w] of words.entries()) {
    const text = w[0];
    const wordEnd = (w.index ?? 0) + text.length;
    if (/^\p{Lu}\.$/u.test(text)) {
      if (i === 0) break;
      end = wordEnd;
    } else if (isNameWord(text, words[i + 1]?.[0], ext, consumed)) {
      end = wordEnd;
      consumed += 1;
    } else break;
  }
  return end;
}

type Pick = (cue: string) => { category: Category; strong: boolean; lenient?: boolean };

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
    const { category, strong, lenient } = pick(g.cue ?? '');
    const end = nameExtent(g.name, { strong, lenient: lenient === true });
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

function titleCategory(cue: string): Category {
  if (/^(?:mr|mrs|ms|miss)$/i.test(cue)) return 'PATIENT';
  return PERSON_TITLES.has(cue.toLowerCase().replace(/\.$/, '')) ? 'PERSON' : 'PROVIDER';
}

/** Replace cue-introduced names with tokens; discovered names are returned for a second sweep. */
export function cueNames(text: string, run: Run, found: NameEntry[]): string {
  let out = text;
  const credential = cueHandler(run, found, () => ({ category: 'PROVIDER', strong: true }));
  for (const re of CREDENTIAL_NAME_RES) out = out.replace(re, credential);
  out = out.replace(
    TITLE_CUE_RE,
    cueHandler(run, found, (cue) => ({ category: titleCategory(cue), strong: true })),
  );
  out = out.replace(
    WEAK_CUE_RE,
    cueHandler(run, found, (cue) => ({
      category: /^(?:patient|pt)/i.test(cue) ? 'PATIENT' : 'PROVIDER',
      strong: false,
    })),
  );
  out = out.replace(LABEL_CUE_RE, cueHandler(run, found, () => ({ category: 'PERSON', strong: false })));
  out = out.replace(RELATION_CUE_RE, cueHandler(run, found, () => ({ category: 'PERSON', strong: false })));
  out = out.replace(
    VI_CUE_RE,
    cueHandler(run, found, (cue) => ({
      category: /^(?:b[eệ]nh|bn)/i.test(cue) ? 'PATIENT' : 'PERSON',
      strong: false,
      lenient: true,
    })),
  );
  out = out.replace(JA_CUE_RE, runHandler(run, found, 'PERSON'));
  out = out.replace(KO_CUE_RE, runHandler(run, found, 'PATIENT'));
  out = out.replace(JA_HONORIFIC_RE, runHandler(run, found, 'PERSON'));
  out = out.replace(KO_HONORIFIC_RE, runHandler(run, found, 'PERSON'));
  // A name discovered once is replaced everywhere else in the same text (e.g. surname alone).
  return found.length > 0 ? sweepNames(out, compileMatcher(found), run) : out;
}
