/**
 * Clinical free-text scrubber (HIPAA Safe Harbor).
 *
 * Pipeline: protect clinical fractions -> structured identifiers -> DOB / age>89 -> dates ->
 * names -> restore. Medical eponyms, devices, specialties and drug names are never treated
 * as person names. PRIVACY CRITICAL: when unsure about a PHI-shaped value, remove it.
 *
 * Without a date shift (no `dateShiftDays` and no shift registered for `patientKey`) dates
 * are generalized to their year (allowed by Safe Harbor) instead of being left intact.
 */
import { generalizeZip } from '../dictionaries/hipaa-zip3.js';
import { isEponymFollower, isEponymSurname, isMedicalTerm } from '../dictionaries/medical-eponyms.js';
import { ageInYears, shiftFhirDate } from '../shared/fhir-date.js';
import type { PhiCategory } from '../types/pipeline.js';
import type { SafeHarborVault } from './vault.js';

/* ---------------------------------- patterns ----------------------------------- */

const ci = (w: string): string =>
  [...w].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join('');

/** Clinical fractions/ratios that must never be read as dates. */
const FRACTION_RES: RegExp[] = [
  /\b\d{1,2}\/\d{1,2}\s*(?:cores?|nodes?|positive|biops(?:y|ies)|specimens?|fields?|hpfs?)\b/gi,
  /(?<![\d/])\b[0-5]\/5\b(?!\/\d)/g,
  /(?<![\d/])\b\d{1,2}\/10\b(?!\/\d)/g,
  /(?<![\d/])\b20\/\d{2,3}\b(?!\/\d)/g,
  /\bPEEP\s*\d+\/\d+\b/gi,
  /\b(?:BP|blood pressure)[:\s]*\d{2,3}\/\d{2,3}\b(?!\/\d)/gi,
  /\b7a-7p\b/gi,
  /(?<![\d/])\d+\/\d+\s*(?:mmHg|cmH2O)/gi,
];

interface IdRule {
  re: RegExp;
  category: PhiCategory | ((before: string) => PhiCategory);
  dropLabel?: boolean;
  trimTail?: boolean;
}

const LV = String.raw`(?<v>(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,})`;
const PHONE_NUM = String.raw`(?<v>\+?\d[\d\s().-]{5,}\d)`;
const labelled = (label: string, category: PhiCategory, value = LV): IdRule => ({
  re: new RegExp(String.raw`\b(?<lab>${label}[: #\t]*)${value}`, 'gi'),
  category,
});
const ID_RULES: IdRule[] = [
  { re: /(?<lab>)(?<v>[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g, category: 'EMAIL' },
  { re: /(?<lab>)(?<v>\b(?:https?:\/\/|www\.)[^\s<>"')\]]+)/gi, category: 'URL', trimTail: true },
  { re: /(?<lab>)(?<v>\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b)/g, category: 'IP' },
  { re: /(?<lab>)(?<v>(?<![\w:])(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}(?![\w:]))/g, category: 'IP' },
  {
    re: /(?<lab>)(?<v>(?<![\w:])(?:[A-Fa-f0-9]{1,4}:){1,7}:(?:[A-Fa-f0-9]{1,4}(?::[A-Fa-f0-9]{1,4}){0,6})?(?![\w:]))/g,
    category: 'IP',
  },
  labelled(String.raw`(?:SSN|social security(?: number| no\.?| #)?)`, 'SSN', String.raw`(?<v>\d{3}[ -]?\d{2}[ -]?\d{4})\b`),
  { re: /(?<lab>)(?<v>\b\d{3}-\d{2}-\d{4}\b)/g, category: 'SSN' },
  {
    re: /\b(?<lab>(?:MRN|medical record (?:number|no\.?|#))[-:# \t]*)(?<v>[A-Za-z0-9][A-Za-z0-9-]*)/gi,
    category: 'MRN',
    dropLabel: true,
  },
  labelled('NPI', 'ID', String.raw`(?<v>\d{10})\b`),
  labelled(String.raw`(?:acct|account)\s*(?:no\.?|number|num|#)?`, 'ACCOUNT'),
  labelled(String.raw`(?:member|policy|subscriber|beneficiary|insurance|medicare|medicaid)\s*(?:id|no\.?|number|#)?`, 'HEALTH_PLAN'),
  labelled(String.raw`(?:driver'?s?\s+)?licen[sc]e\s*(?:no\.?|number|#)?`, 'LICENSE'),
  labelled(String.raw`(?:VIN|license plate|plate(?: no\.?| number)?)`, 'VEHICLE'),
  labelled(String.raw`(?:serial(?: no\.?| number| #)?|device id|UDI)`, 'DEVICE'),
  {
    re: new RegExp(String.raw`\b(?<lab>fax(?: number| no\.?)?\b[:#.\s]*)${PHONE_NUM}`, 'gi'),
    category: 'FAX',
  },
  {
    re: new RegExp(
      String.raw`\b(?<lab>(?:phone|tel(?:ephone)?|cell|mobile|contact(?: number)?)\b[:#.\s]*)${PHONE_NUM}`,
      'gi',
    ),
    category: 'PHONE',
  },
  {
    re: /(?<lab>)(?<v>(?<![\w.])(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}\b)/g,
    category: (before) => (/fax\W*$/i.test(before) ? 'FAX' : 'PHONE'),
  },
  {
    re: /(?<lab>)(?<v>(?<![\w.+])\+\d{1,3}[\s.-]?\d{1,4}[\s.-]\d{2,4}[\s.-]\d{2,4}(?:[\s.-]\d{2,4})?\b)/g,
    category: 'PHONE',
  },
];

const STREET_SUFFIX =
  'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Lane|Ln|Court|Ct|Way|Place|Pl|Terrace|Highway|Hwy|Parkway|Pkwy';
const ADDRESS_RE = new RegExp(
  String.raw`\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:${STREET_SUFFIX})\b|\bP\.?\s?O\.?\s+Box\s+\d+\b`,
  'g',
);

const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const AMBIGUOUS_STATES = new Set(['IN', 'OR', 'ME', 'OK', 'HI', 'OH', 'LA', 'PA', 'MD', 'DE', 'ID', 'NE', 'MS', 'MI']);
const UNAMBIGUOUS_STATES = STATES.split('|').filter((s) => !AMBIGUOUS_STATES.has(s)).join('|');
const ZIP_VALUE = String.raw`(?<v>\d{5}(?:-\d{4})?)\b`;
const ZIP_RES: RegExp[] = [
  new RegExp(String.raw`\b(?<lab>zip(?:\s*code)?\s*[:#]?\s*)${ZIP_VALUE}`, 'gi'),
  new RegExp(String.raw`(?<lab>,\s*(?:${STATES})\s+)${ZIP_VALUE}`, 'g'),
  new RegExp(String.raw`(?<lab>\b(?:${UNAMBIGUOUS_STATES})\s+)${ZIP_VALUE}`, 'g'),
];

const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_PAT = String.raw`(?:\d{4}-\d{2}-\d{2}(?!\d)|\d{1,2}\/\d{1,2}\/\d{4}|${MONTH}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\.?,?\s+\d{4})`;
const DATE_RE = new RegExp(String.raw`(?<![\d/-])${DATE_PAT}(?![\d/])`, 'gi');
const DOB_RE = new RegExp(
  String.raw`\b(?<lab>(?:DOB|D\.O\.B\.?|date of birth|birth ?date|born(?: on)?)\s*[:-]?\s*)(?<v>${DATE_PAT})(?![\d/])`,
  'gi',
);
const AGE_RE =
  /(?<![\d.])(?<v>(?:9\d|1[0-4]\d))(?<suf>\s*-?\s*(?:years?|yrs?)[\s-]*old\b|\s*y\/o\b|\s*y\.o\.|\s*yo\b)/gi;
const MONTH_INDEX = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validIso(y: number, m: number, d: number): string | undefined {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

/** Parse ISO, US (M/D/YYYY) and month-name dates to `YYYY-MM-DD`. */
function parseAnyDate(s: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return validIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return validIso(Number(us[3]), Number(us[1]), Number(us[2]));
  const mon = /([A-Za-z]{3})[A-Za-z]*/.exec(s)?.[1]?.toLowerCase();
  const nums = s.replace(/[A-Za-z]+/g, ' ').match(/\d+/g);
  const idx = mon ? MONTH_INDEX.indexOf(mon) : -1;
  const day = nums?.find((n) => n.length <= 2);
  const year = nums?.find((n) => n.length === 4);
  if (idx < 0 || !day || !year) return undefined;
  return validIso(Number(year), idx + 1, Number(day));
}

/** Capitalized clinical/structural words that follow a cue but are not names. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'professor', 'a', 'an', 'the', 'and', 'or', 'of', 'with', 'without', 'for', 'to', 'in', 'on', 'at', 'is', 'was',
  'has', 'had', 'have', 'denies', 'reports', 'presents', 'presented', 'complains', 'states', 'history',
  'status', 'name', 'information', 'info', 'education', 'evaluation', 'eval', 'note', 'notes', 'report',
  'summary', 'visit', 'encounter', 'admitted', 'discharged', 'placed', 'seen', 'treated', 'referred',
  'transferred', 'diagnosed', 'noted', 'found', 'underwent', 'received', 'started', 'stopped', 'will',
  'should', 'would', 'could', 'can', 'did', 'does', 'not', 'no', 'yes', 'age', 'sex', 'male', 'female',
  'man', 'woman', 'boy', 'girl', 'child', 'infant', 'adult', 'elderly', 'family', 'chart', 'record',
  'records', 'number', 'id', 'dob', 'mrn', 'zip', 'phone', 'address', 'email', 'today', 'yesterday',
  'tomorrow', 'now', 'currently', 'recently', 'previously', 'follow', 'follows', 'plan', 'assessment',
  'diagnosis', 'procedure', 'medication', 'medications', 'allergies', 'vitals', 'exam', 'examination',
  'complaint', 'chief', 'reason', 'results', 'result', 'lab', 'labs', 'imaging', 'physical', 'therapy',
  'unit', 'floor', 'room', 'bed', 'department', 'hospital', 'clinic', 'center', 'service', 'team',
  'practitioner', 'doctor', 'nurse', 'physician', 'attending', 'resident', 'provider', 'patient',
]);

const NAME_WORD = String.raw`\p{Lu}[\p{L}'’-]*`;
const NAME_PAT = String.raw`(?:${NAME_WORD},\s+${NAME_WORD}(?:\s+\p{Lu}\.)?|${NAME_WORD}(?:\s+(?:\p{Lu}\.(?=\s)|${NAME_WORD})){0,2})`;
const TITLE_CUE_RE = new RegExp(
  String.raw`(?<pre>\b(?<cue>${['Dr', 'Doctor', 'Mrs', 'Mr', 'Ms', 'Miss', 'Professor', 'Prof'].map(ci).join('|')})\b\.?[ \t]*)(?<name>${NAME_PAT})`,
  'gu',
);
const BY_VERBS =
  'note|report|summary|signed|seen|dictated|reviewed|authored|performed|prescribed|referred|examined|entered|cosigned|transcribed|ordered|read|interpreted';
const WEAK_CUES = [
  `${ci('Patient')}(?:\\s+${ci('Name')})?`,
  ci('Pt'),
  `(?:${BY_VERBS.split('|').map(ci).join('|')})\\s+(?:${ci('electronically')}\\s+)?${ci('by')}`,
  ...['Attending', 'Provider', 'Physician', 'Author', 'Surgeon', 'Resident', 'Nurse', 'Referring', 'Ordering', 'Signed', 'PCP'].map(ci),
];
const WEAK_CUE_RE = new RegExp(
  String.raw`(?<pre>\b(?<cue>${WEAK_CUES.join('|')})\b[ \t]*[:-]?[ \t]*)(?<name>${NAME_PAT})`,
  'gu',
);
const CREDENTIAL = String.raw`(?=,?\s+(?:M\.?D\.?|D\.?O\.?|R\.?N\.?|N\.?P\.?|PA-C|Ph\.?D\.?|PharmD|DDS|DMD|MBBS|FACS|FACC)(?![\p{L}]))`;
const CREDENTIAL_NAME_RES: RegExp[] = [
  new RegExp(String.raw`(?<pre>)(?<name>${NAME_WORD},\s+${NAME_WORD}(?:\s+\p{Lu}\.)?)${CREDENTIAL}`, 'gu'),
  new RegExp(String.raw`(?<pre>)(?<name>${NAME_WORD}(?:\s+(?:\p{Lu}\.(?=\s)|${NAME_WORD})){0,2})${CREDENTIAL}`, 'gu'),
];

/* ----------------------------------- types ------------------------------------- */

export interface KnownName {
  category: 'PATIENT' | 'PROVIDER' | 'PERSON';
  variants: string[];
  /** Owner of a PATIENT name (defaults to the scrub context's patientKey). */
  patientKey?: string;
}

export interface ScrubContext {
  vault: SafeHarborVault;
  patientKey?: string;
  now?: Date;
  knownNames?: readonly KnownName[];
  dateShiftDays?: number;
}

export interface ScrubResult {
  text: string;
  counts: Partial<Record<PhiCategory, number>>;
  datesShifted: number;
  zip3Restricted: number;
  zip3Generalized: number;
}

const PH_OPEN = '';
const PH_CLOSE = '';
const PH_RE = /([a-z]+)/g;
const AGE_CAP_LABEL = '90+';

/** Holds finished output out of reach of later regex passes via private-use placeholders. */
class Shield {
  private readonly items: string[] = [];
  hold(value: string): string {
    let n = this.items.push(value) - 1;
    let code = '';
    do {
      code = String.fromCharCode(97 + (n % 26)) + code;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return `${PH_OPEN}${code}${PH_CLOSE}`;
  }
  restore(text: string): string {
    return text.replace(PH_RE, (_m, code: string) => {
      let n = 0;
      for (const ch of code) n = n * 26 + (ch.charCodeAt(0) - 96);
      return this.items[n - 1] ?? '';
    });
  }
}

type Acc = Omit<ScrubResult, 'text'>;

interface NameEntry {
  token: string;
  category: KnownName['category'];
  variants: string[];
}

interface Run {
  ctx: ScrubContext;
  acc: Acc;
  shield: Shield;
  now: Date;
  days: number | undefined;
}

const bump = (acc: Acc, category: PhiCategory): void => {
  acc.counts[category] = (acc.counts[category] ?? 0) + 1;
};

/* ---------------------------- structured identifiers --------------------------- */

function applyIdRules(text: string, run: Run): string {
  let out = text;
  for (const rule of ID_RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const groups = args[args.length - 1] as { lab?: string; v: string };
      const offset = args[args.length - 3] as number;
      const whole = args[args.length - 2] as string;
      const category =
        typeof rule.category === 'function'
          ? rule.category(whole.slice(Math.max(0, offset - 12), offset))
          : rule.category;
      const tail = rule.trimTail ? (/[.,;:!?]+$/.exec(groups.v)?.[0] ?? '') : '';
      const value = tail ? groups.v.slice(0, -tail.length) : groups.v;
      const token = run.ctx.vault.tokenFor(category, value, { patientKey: run.ctx.patientKey });
      bump(run.acc, category);
      return `${rule.dropLabel ? '' : (groups.lab ?? '')}${token}${tail}`;
    });
  }
  return out;
}

function applyAddressAndZip(text: string, run: Run): string {
  let out = text.replace(ADDRESS_RE, (m) => {
    bump(run.acc, 'ADDRESS');
    return run.ctx.vault.tokenFor('ADDRESS', m);
  });
  for (const re of ZIP_RES) {
    out = out.replace(re, (...args: unknown[]) => {
      const groups = args[args.length - 1] as { lab: string; v: string };
      const zip = generalizeZip(groups.v);
      if (zip.restricted) run.acc.zip3Restricted += 1;
      else run.acc.zip3Generalized += 1;
      return `${groups.lab}${run.shield.hold(zip.value)}`;
    });
  }
  return out;
}

/* ----------------------------------- dates ------------------------------------- */

function shiftedDateText(iso: string, run: Run): string {
  if (run.days === undefined) return iso.slice(0, 4);
  const shifted = shiftFhirDate(iso, run.days);
  run.acc.datesShifted += 1;
  if (run.ctx.patientKey) run.ctx.vault.recordShiftedDate(run.ctx.patientKey, shifted);
  return shifted;
}

function applyDobAndDates(text: string, run: Run): string {
  let out = text.replace(DOB_RE, (...args: unknown[]) => {
    const groups = args[args.length - 1] as { lab: string; v: string };
    const iso = parseAnyDate(groups.v);
    if (!iso) return args[0] as string;
    const age = ageInYears(iso, run.now);
    const replacement = age !== undefined && age > 89 ? AGE_CAP_LABEL : shiftedDateText(iso, run);
    return `${groups.lab}${run.shield.hold(replacement)}`;
  });
  out = out.replace(AGE_RE, (...args: unknown[]) => {
    const groups = args[args.length - 1] as { suf: string };
    return run.shield.hold(`${AGE_CAP_LABEL}${groups.suf}`);
  });
  return out.replace(DATE_RE, (m) => {
    const iso = parseAnyDate(m);
    return iso ? run.shield.hold(shiftedDateText(iso, run)) : m;
  });
}

/* ------------------------------------ names ------------------------------------ */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TITLE_SET = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'doctor', 'prof', 'md', 'rn', 'np', 'phd']);

interface Matcher {
  full: RegExp | null;
  part: RegExp | null;
  fullMap: Map<string, NameEntry>;
  partMap: Map<string, NameEntry>;
}

function nameParts(variant: string): string[] {
  return variant
    .split(/[\s,]+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter((w) => w.length >= 3 && !TITLE_SET.has(w.toLowerCase()) && !STOP_WORDS.has(w.toLowerCase()));
}

function buildAlternation(forms: string[], flags: string): RegExp | null {
  if (forms.length === 0) return null;
  const alt = forms.sort((a, b) => b.length - a.length).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, flags);
}

function compileMatcher(entries: readonly NameEntry[]): Matcher {
  const fullMap = new Map<string, NameEntry>();
  const partMap = new Map<string, NameEntry>();
  for (const e of entries) {
    for (const v of e.variants) {
      const key = v.trim().replace(/\s+/g, ' ').toLowerCase();
      if (key.length >= 2 && !fullMap.has(key)) fullMap.set(key, e);
      for (const p of nameParts(v)) if (!partMap.has(p.toLowerCase())) partMap.set(p.toLowerCase(), e);
    }
  }
  const fullForms = [...fullMap.keys()].map((k) => escapeRe(k).replace(/ /g, '\\s+'));
  const partForms = [...partMap.keys()].flatMap((k) => [
    escapeRe(k.charAt(0).toUpperCase() + k.slice(1)),
    escapeRe(k.toUpperCase()),
  ]);
  return {
    full: buildAlternation(fullForms, 'giu'),
    part: buildAlternation(partForms, 'gu'),
    fullMap,
    partMap,
  };
}

const matcherCache = new WeakMap<SafeHarborVault, WeakMap<readonly KnownName[], Matcher>>();

function matcherFor(run: Run, known: readonly KnownName[]): Matcher {
  let byList = matcherCache.get(run.ctx.vault);
  if (!byList) matcherCache.set(run.ctx.vault, (byList = new WeakMap()));
  let m = byList.get(known);
  if (!m) {
    const entries = known
      .filter((k) => k.variants.some((v) => v.trim()))
      .map((k) => ({
        ...k,
        token: run.ctx.vault.registerName(k.category, k.variants, {
          patientKey: k.patientKey ?? run.ctx.patientKey,
        }),
      }));
    byList.set(known, (m = compileMatcher(entries)));
  }
  return m;
}

/** A surname-eponym followed by a possessive or medical noun ("Wilson disease") is terminology. */
function isTerminologyUse(word: string, after: string): boolean {
  if (!isMedicalTerm(word)) return false;
  if (!isEponymSurname(word)) return true;
  if (/^['’]s\b/u.test(after)) return true;
  return isEponymFollower(/^\s+([\p{L}-]+)/u.exec(after)?.[1]);
}

function sweepNames(text: string, m: Matcher, run: Run): string {
  const replacer = (map: Map<string, NameEntry>) => (match: string, offset: number, whole: string) => {
    const entry = map.get(match.replace(/\s+/g, ' ').toLowerCase());
    if (!entry) return match;
    if (!/\s/.test(match) && isTerminologyUse(match, whole.slice(offset + match.length))) return match;
    bump(run.acc, entry.category);
    return entry.token;
  };
  let out = text;
  if (m.full) out = out.replace(m.full, replacer(m.fullMap));
  if (m.part) out = out.replace(m.part, replacer(m.partMap));
  return out;
}

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

function cueHandler(run: Run, found: NameEntry[], pick: (cue: string) => { category: KnownName['category']; strong: boolean }) {
  return (...args: unknown[]): string => {
    const g = args[args.length - 1] as { pre: string; name: string; cue?: string };
    const { category, strong } = pick(g.cue ?? '');
    const end = nameExtent(g.name, strong);
    let consumed = g.name.slice(0, end).replace(/,$/, '');
    if (!consumed) return args[0] as string;
    const possessive = /['’]s$/i.exec(consumed)?.[0] ?? '';
    consumed = possessive ? consumed.slice(0, -possessive.length) : consumed;
    const token = run.ctx.vault.tokenFor(category, consumed, { patientKey: run.ctx.patientKey });
    found.push({ token, category, variants: [consumed] });
    bump(run.acc, category);
    return `${g.pre}${token}${possessive}${g.name.slice(end)}`;
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
  return out.replace(
    WEAK_CUE_RE,
    cueHandler(run, found, (cue) => ({
      category: /^(?:patient|pt)/i.test(cue) ? 'PATIENT' : 'PROVIDER',
      strong: false,
    })),
  );
}

function scrubNames(text: string, run: Run): string {
  let out = text;
  if (run.ctx.knownNames?.length) out = sweepNames(out, matcherFor(run, run.ctx.knownNames), run);
  const found: NameEntry[] = [];
  out = cueNames(out, run, found);
  // A name discovered once is replaced everywhere else in the same text (e.g. surname alone).
  if (found.length > 0) out = sweepNames(out, compileMatcher(found), run);
  // "Torres, Michael" swept part-by-part would read "[PATIENT_1], [PATIENT_1]": collapse.
  return out.replace(/(\[[A-Z_]+_\d+\])(?:,?\s+\1)+/g, '$1');
}

/* ------------------------------------ entry ------------------------------------ */

export function scrubText(text: string, ctx: ScrubContext): ScrubResult {
  const acc: Acc = { counts: {}, datesShifted: 0, zip3Restricted: 0, zip3Generalized: 0 };
  const shield = new Shield();
  const days =
    ctx.dateShiftDays ?? (ctx.patientKey ? ctx.vault.dateShiftDaysFor(ctx.patientKey) : undefined);
  const run: Run = { ctx, acc, shield, now: ctx.now ?? new Date(), days };
  let t = text.replace(/[]/g, '');
  for (const re of FRACTION_RES) t = t.replace(re, (m) => shield.hold(m));
  t = applyIdRules(t, run);
  t = applyAddressAndZip(t, run);
  t = applyDobAndDates(t, run);
  t = scrubNames(t, run);
  return { text: shield.restore(t), ...acc };
}
