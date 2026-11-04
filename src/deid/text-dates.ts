/**
 * Dates and ages inside free text (HIPAA Safe Harbor C).
 *
 *  - full dates (ISO, M/D/Y, D.M.Y, 2-digit years, compact YYYYMMDD, "5 Mar 2024", CJK...) are
 *    shifted by the owner's offset, or reduced to their year when the owner has none;
 *  - partial dates ("March 2020", "2024-03") are generalized to the year; month-day without a
 *    year becomes [DATE];
 *  - any date-ish token shortly after a birth cue (DOB, born, 生年月日...) becomes the 4-digit
 *    year, "90+" above age 89, or [DATE] when it cannot be parsed (fail closed);
 *  - ages above 89 in any common phrasing become "90+".
 * Every quantifier is bounded so pathological input stays linear.
 */
import { shiftFhirDate } from '../shared/fhir-date.js';
import { AGE_CAP_LABEL } from './date-shifter.js';
import { looseAge } from './loose-date.js';
import type { Run } from './scrub-types.js';

interface Parsed {
  year: number;
  month?: number;
  day?: number;
  /** Month and day without a year. */
  noYear?: boolean;
}
type Groups = Record<string, string | undefined>;
interface DateForm {
  re: RegExp;
  parse(g: Groups, now: Date): Parsed | undefined;
}

const MONTH_NAMES =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const MON = `(?:${MONTH_NAMES})`;
/** Capitalized or ALL-CAPS month names only: "may"/"mar" in lower case are ordinary words. */
const MON_CAP = `(?:${MONTH_NAMES.split('|').flatMap((m) => [m, m.toUpperCase()]).join('|')})`;
const MONTH_INDEX = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY = String.raw`(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]{0,6}\.?,?\s{1,2})?`;
const ORD = String.raw`(?:st|nd|rd|th)?`;
const GUARD_BEFORE = String.raw`(?<![\d/.-])`;
const GUARD_AFTER = String.raw`(?![\d/])`;

const monthOf = (name: string | undefined): number => MONTH_INDEX.indexOf((name ?? '').slice(0, 3).toLowerCase()) + 1;

function valid(year: number, month: number, day: number): Parsed | undefined {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return undefined;
  return { year, month, day };
}

export function twoDigitYear(yy: number, now: Date): number {
  const full = 2000 + yy;
  return full > now.getUTCFullYear() ? 1900 + yy : full;
}

/** "a/b/yyyy": month first unless that is impossible (or the separator is "." = day first). */
function dayMonth(a: number, b: number, year: number, sep: string | undefined): Parsed | undefined {
  const dmy = valid(year, b, a);
  const mdy = valid(year, a, b);
  if (sep === '.' || a > 12) return dmy ?? mdy;
  return mdy ?? dmy;
}

const num = (s: string | undefined): number => Number(s ?? '');

const FORMS: DateForm[] = [
  {
    re: new RegExp(String.raw`${GUARD_BEFORE}(?<y>\d{4})(?<s>[-/.])(?<m>\d{1,2})\k<s>(?<d>\d{1,2})${GUARD_AFTER}`, 'g'),
    parse: (g) => valid(num(g.y), num(g.m), num(g.d)),
  },
  {
    re: new RegExp(String.raw`${GUARD_BEFORE}(?<a>\d{1,2})(?<s>[-/.])(?<b>\d{1,2})\k<s>(?<y>\d{4})${GUARD_AFTER}`, 'g'),
    parse: (g) => dayMonth(num(g.a), num(g.b), num(g.y), g.s),
  },
  {
    re: new RegExp(String.raw`${GUARD_BEFORE}(?<a>\d{1,2})(?<s>[-/])(?<b>\d{1,2})\k<s>(?<y>\d{2})(?![\d/]|\.\d)`, 'g'),
    parse: (g, now) => dayMonth(num(g.a), num(g.b), twoDigitYear(num(g.y), now), g.s),
  },
  {
    re: /(?<![\d.])(?<y>(?:19|20)\d{2})(?<m>0[1-9]|1[0-2])(?<d>0[1-9]|[12]\d|3[01])(?!\d)/g,
    parse: (g) => valid(num(g.y), num(g.m), num(g.d)),
  },
  {
    re: new RegExp(
      String.raw`(?<![\p{L}\d])${WEEKDAY}(?<mon>${MON})\.?\s{0,3}(?<d>\d{1,2})${ORD},?\s{0,3}(?<y>\d{4})${GUARD_AFTER}`,
      'giu',
    ),
    parse: (g) => valid(num(g.y), monthOf(g.mon), num(g.d)),
  },
  {
    re: new RegExp(
      String.raw`(?<![\p{L}\d])${WEEKDAY}(?<d>\d{1,2})${ORD}(?:\s{1,3}of)?[-\s/.]{0,3}(?<mon>${MON})\.?,?[-\s/.]{0,3}(?<y>\d{4})${GUARD_AFTER}`,
      'giu',
    ),
    parse: (g) => valid(num(g.y), monthOf(g.mon), num(g.d)),
  },
  {
    re: /(?<![\d])(?<y>\d{4})年\s?(?<m>\d{1,2})月\s?(?<d>\d{1,2})日?/g,
    parse: (g) => valid(num(g.y), num(g.m), num(g.d)),
  },
  {
    re: /(?<![\d])(?<y>\d{4})年\s?(?<m>\d{1,2})月/g,
    parse: (g) => (num(g.m) >= 1 && num(g.m) <= 12 ? { year: num(g.y) } : undefined),
  },
  {
    re: /(?<![\d/.-])(?<y>(?:19|20)\d{2})-(?:0[1-9]|1[0-2])(?![\d-])/g,
    parse: (g) => ({ year: num(g.y) }),
  },
  {
    re: new RegExp(String.raw`(?<![\p{L}\d])(?<mon>${MON_CAP})\.?(?:\s{0,3}of|,)?\s{1,3}(?<y>(?:19|20)\d{2})(?![\d])`, 'gu'),
    parse: (g) => ({ year: num(g.y) }),
  },
  {
    re: new RegExp(
      String.raw`(?<![\p{L}\d])${WEEKDAY}(?<mon>${MON_CAP})\.?\s{1,3}(?<d>\d{1,2})${ORD}(?![\d:/-]|\s?(?:%|mg|mcg|ml|mL|mm|cm|kg|units?|times|years?|months?|days?|weeks?)\b)`,
      'gu',
    ),
    parse: (g) => (num(g.d) >= 1 && num(g.d) <= 31 && monthOf(g.mon) > 0 ? { year: 0, noYear: true } : undefined),
  },
  {
    re: new RegExp(
      String.raw`(?<![\p{L}\d/.-])(?<d>\d{1,2})${ORD}\s{1,3}(?:of\s{1,3})?(?<mon>${MON_CAP})(?![\p{L}\d])`,
      'gu',
    ),
    parse: (g) => (num(g.d) >= 1 && num(g.d) <= 31 && monthOf(g.mon) > 0 ? { year: 0, noYear: true } : undefined),
  },
];

const DATE_CUE_PLACEHOLDER = '[DATE]';
const yearText = (year: number): string => String(year).padStart(4, '0');

function isoOf(p: Parsed): string {
  return `${yearText(p.year)}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function renderDate(p: Parsed, run: Run): string {
  if (p.noYear) return DATE_CUE_PLACEHOLDER;
  if (p.month === undefined || p.day === undefined) return yearText(p.year);
  if (run.days === undefined) return yearText(p.year);
  const shifted = shiftFhirDate(isoOf(p), run.days);
  run.acc.datesShifted += 1;
  if (run.ctx.patientKey) run.ctx.vault.recordShiftedDate(run.ctx.patientKey, shifted);
  return shifted;
}

/** Shift / generalize every date found in free text. */
export function applyTextDates(text: string, run: Run): string {
  let out = text;
  for (const form of FORMS) {
    form.re.lastIndex = 0;
    out = out.replace(form.re, (...args: unknown[]) => {
      const groups = args[args.length - 1] as Groups;
      const parsed = form.parse(groups, run.now);
      return parsed ? run.shield.hold(renderDate(parsed, run)) : (args[0] as string);
    });
  }
  return out;
}

/* ------------------------------- birth-date cues ------------------------------- */

const DOB_CUE_RE =
  /(?<![\p{L}\d])(?:D\.\s?O\.\s?B\.?|DOB|date\s{1,2}of\s{1,2}birth|birth\s?date|birthday|born(?:\s{1,2}on)?|生年月日|생년월일|ngày\s{1,2}sinh)(?![\p{L}])/giu;
const CUE_WINDOW = 20;
const SCAN_WINDOW = 90;
const BARE_YEAR = /(?<![\d.])(?:1[89]|20)\d{2}(?![\d])/g;

interface Found {
  from: number;
  to: number;
  parsed: Parsed | null;
}

function earliestDate(window: string, now: Date): Found | undefined {
  let best: Found | undefined;
  const consider = (re: RegExp, parse: (g: Groups) => Parsed | undefined): void => {
    re.lastIndex = 0;
    const m = re.exec(window);
    if (!m || m.index > CUE_WINDOW || (best && best.from <= m.index)) return;
    best = { from: m.index, to: m.index + m[0].length, parsed: parse(m.groups ?? {}) ?? null };
  };
  for (const form of FORMS) consider(form.re, (g) => form.parse(g, now));
  BARE_YEAR.lastIndex = 0;
  const bare = BARE_YEAR.exec(window);
  if (bare && bare.index <= CUE_WINDOW && (!best || best.from > bare.index)) {
    best = { from: bare.index, to: bare.index + bare[0].length, parsed: { year: Number(bare[0]) } };
  }
  return best;
}

function birthReplacement(found: Found | undefined, window: string, run: Run): { from: number; to: number; text: string } | undefined {
  // Digits between the cue and the recognized token ("5th of Mrch 1960") are part of the date.
  const stray = found ? /\d/.exec(window.slice(0, found.from)) : null;
  if (found && stray) return { from: stray.index, to: found.to, text: DATE_CUE_PLACEHOLDER };
  if (found?.parsed && !found.parsed.noYear) {
    const p = found.parsed;
    const age = looseAge({ year: p.year, month: p.month, day: p.day }, run.now);
    return { from: found.from, to: found.to, text: age > 89 ? AGE_CAP_LABEL : yearText(p.year) };
  }
  if (found) return { from: found.from, to: found.to, text: DATE_CUE_PLACEHOLDER };
  const digit = /\d[\w./-]{0,24}/.exec(window.slice(0, CUE_WINDOW + 4));
  if (!digit || digit.index > CUE_WINDOW) return undefined;
  return { from: digit.index, to: digit.index + digit[0].length, text: DATE_CUE_PLACEHOLDER };
}

/** A date-ish token after a birth cue keeps only its year (or 90+); unparsable -> [DATE]. */
export function applyBirthCues(text: string, run: Run): string {
  let out = '';
  let cursor = 0;
  DOB_CUE_RE.lastIndex = 0;
  for (const m of text.matchAll(DOB_CUE_RE)) {
    const cueEnd = (m.index ?? 0) + m[0].length;
    if (cueEnd < cursor) continue;
    const window = text.slice(cueEnd, cueEnd + SCAN_WINDOW);
    const hit = birthReplacement(earliestDate(window, run.now), window, run);
    if (!hit) continue;
    out += text.slice(cursor, cueEnd + hit.from) + run.shield.hold(hit.text);
    cursor = cueEnd + hit.to;
  }
  return out + text.slice(cursor);
}

/* ----------------------------------- ages ----------------------------------- */

const AGE_NUM = String.raw`(?<![\d.])(?:9\d|1[0-4]\d)`;
const AGE_SUFFIX = String.raw`(?:\s{0,2}-?\s{0,2}(?:years?|yrs?)[\s-]{0,3}(?:old|of\s{1,2}age)\b|\s{0,2}y\/o\b|\s{0,2}y\.o\.|\s{0,2}yo\b)`;
const TENS_ONES = 'one|two|three|four|five|six|seven|eight|nine';
const SPELLED = String.raw`(?:ninety|one[\s-]hundred|a[\s-]hundred)(?:[\s-]{1,2}(?:and[\s-]{1,2})?(?:(?:${TENS_ONES}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)|(?:twenty|thirty|forty)(?:[\s-]{1,2}(?:${TENS_ONES}))?))?`;

const TEMPERATURE_CONTEXT = /(?:temp(?:erature)?|fever|febrile|afebrile|°|\bT\s?[:=]?)\W{0,3}$/i;

type AgeRule = { re: RegExp; label: (g: Groups, before: string) => string | undefined };
const AGE_RULES: AgeRule[] = [
  { re: new RegExp(String.raw`${AGE_NUM}(?<suf>${AGE_SUFFIX})`, 'gi'), label: (g) => `${AGE_CAP_LABEL}${g.suf ?? ''}` },
  {
    re: new RegExp(String.raw`\b(?<lab>(?:aged?|age\s{1,2}of|turn(?:ed|s|ing)|at\s{1,2}age)\s{0,2}[:=]?\s{0,2})${AGE_NUM}(?![\d.]|\s?%)`, 'gi'),
    label: (g) => `${g.lab ?? ''}${AGE_CAP_LABEL}`,
  },
  { re: new RegExp(String.raw`${AGE_NUM}(?=\s?\/\s?[MFmf]\b)`, 'g'), label: () => AGE_CAP_LABEL },
  {
    re: new RegExp(String.raw`${AGE_NUM}\s?(?<g>[MF])\b`, 'g'),
    label: (g, before) => (g.g === 'F' && TEMPERATURE_CONTEXT.test(before) ? undefined : `${AGE_CAP_LABEL}${g.g === 'F' ? ' F' : ' M'}`),
  },
  {
    re: /\b(?:his|her|their)\s{1,2}(?:(?:early|mid|late)[-\s]{1,2})?(?:9\d|1[0-4]\d)['’]?s\b/gi,
    label: () => `their ${AGE_CAP_LABEL}`,
  },
  { re: /\b(?:nonagenarian|centenarian|supercentenarian)s?\b/gi, label: () => `${AGE_CAP_LABEL} year old` },
  {
    re: new RegExp(String.raw`\b${SPELLED}(?=${AGE_SUFFIX})`, 'gi'),
    label: () => AGE_CAP_LABEL,
  },
  {
    re: new RegExp(String.raw`(?<=\b(?:aged?|age\s{1,2}of|turned)\s{1,2})${SPELLED}\b`, 'gi'),
    label: () => AGE_CAP_LABEL,
  },
];

/** Ages above 89 are reported as "90+" (Safe Harbor). */
export function applyAges(text: string, run: Run): string {
  let out = text;
  for (const rule of AGE_RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args: unknown[]) => {
      const last = args[args.length - 1];
      const hasGroups = typeof last === 'object' && last !== null;
      const offset = args[args.length - (hasGroups ? 3 : 2)] as number;
      const whole = args[args.length - (hasGroups ? 2 : 1)] as string;
      const groups = (hasGroups ? last : {}) as Groups;
      const label = rule.label(groups, whole.slice(Math.max(0, offset - 24), offset));
      return label === undefined ? (args[0] as string) : run.shield.hold(label);
    });
  }
  return out;
}
