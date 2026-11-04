/**
 * Regex catalogue for structured identifiers, addresses, postal codes and dates in free text.
 * Every quantifier on a user-controlled run is bounded so pathological input stays linear.
 */
import type { PhiCategory } from '../types/pipeline.js';

export const ci = (w: string): string =>
  [...w].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join('');

/** Clinical fractions/ratios that must never be read as dates. */
export const FRACTION_RES: RegExp[] = [
  /\b\d{1,2}\/\d{1,2}\s*(?:cores?|nodes?|positive|biops(?:y|ies)|specimens?|fields?|hpfs?)\b/gi,
  /(?<![\d/])\b[0-5]\/5\b(?!\/\d)/g,
  /(?<![\d/])\b\d{1,2}\/10\b(?!\/\d)/g,
  /(?<![\d/])\b20\/\d{2,3}\b(?!\/\d)/g,
  /\bPEEP\s*\d+\/\d+\b/gi,
  /\b(?:BP|blood pressure)[:\s]*\d{2,3}\/\d{2,3}\b(?!\/\d)/gi,
  /\b7a-7p\b/gi,
  /(?<![\d/])\d+\/\d+\s*(?:mmHg|cmH2O)/gi,
];

export interface IdRule {
  re: RegExp;
  category: PhiCategory | ((before: string) => PhiCategory);
  dropLabel?: boolean;
  trimTail?: boolean;
}

const LV = String.raw`(?<v>(?=[A-Za-z0-9-]{0,64}\d)[A-Za-z0-9-]{4,64})`;
const PHONE_NUM = String.raw`(?<v>\+?\d[\d\s().-]{5,30}\d)`;
const labelled = (label: string, category: PhiCategory, value = LV): IdRule => ({
  re: new RegExp(String.raw`\b(?<lab>${label}[: #\t]{0,4})${value}`, 'gi'),
  category,
});

export const ID_RULES: IdRule[] = [
  {
    re: /(?<lab>)(?<v>[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24})/g,
    category: 'EMAIL',
  },
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
    re: /\b(?<lab>(?:MRN|medical record (?:number|no\.?|#))[-:# \t]{0,4})(?<v>[A-Za-z0-9][A-Za-z0-9-]{0,63})/gi,
    category: 'MRN',
    dropLabel: true,
  },
  labelled('NPI', 'ID', String.raw`(?<v>\d{10})\b`),
  labelled(String.raw`(?:acct|account)\s{0,2}(?:no\.?|number|num|#)?`, 'ACCOUNT'),
  labelled(String.raw`(?:member|policy|subscriber|beneficiary|insurance|medicare|medicaid)\s{0,2}(?:id|no\.?|number|#)?`, 'HEALTH_PLAN'),
  labelled(String.raw`(?:driver'?s?\s{1,2})?licen[sc]e\s{0,2}(?:no\.?|number|#)?`, 'LICENSE'),
  labelled(String.raw`(?:VIN|license plate|plate(?: no\.?| number)?)`, 'VEHICLE'),
  labelled(String.raw`(?:serial(?: no\.?| number| #)?|device id|UDI)`, 'DEVICE'),
  {
    re: new RegExp(String.raw`\b(?<lab>fax(?: number| no\.?)?\b[:#.\s]{0,4})${PHONE_NUM}`, 'gi'),
    category: 'FAX',
  },
  {
    re: new RegExp(
      String.raw`\b(?<lab>(?:phone|tel(?:ephone)?|cell|mobile|contact(?: number)?)\b[:#.\s]{0,4})${PHONE_NUM}`,
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
export const ADDRESS_RE = new RegExp(
  String.raw`\b\d{1,5}\s+(?:[A-Z][a-z]{1,30}\s+){1,3}(?:${STREET_SUFFIX})\b|\bP\.?\s?O\.?\s+Box\s+\d+\b`,
  'g',
);

const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const AMBIGUOUS_STATES = new Set(['IN', 'OR', 'ME', 'OK', 'HI', 'OH', 'LA', 'PA', 'MD', 'DE', 'ID', 'NE', 'MS', 'MI']);
const UNAMBIGUOUS_STATES = STATES.split('|').filter((s) => !AMBIGUOUS_STATES.has(s)).join('|');
const ZIP_VALUE = String.raw`(?<v>\d{5}(?:-\d{4})?)\b`;
export const ZIP_RES: RegExp[] = [
  new RegExp(String.raw`\b(?<lab>zip(?:\s{0,2}code)?\s{0,2}[:#]?\s{0,2})${ZIP_VALUE}`, 'gi'),
  new RegExp(String.raw`(?<lab>,\s{0,2}(?:${STATES})\s{1,3})${ZIP_VALUE}`, 'g'),
  new RegExp(String.raw`(?<lab>\b(?:${UNAMBIGUOUS_STATES})\s{1,3})${ZIP_VALUE}`, 'g'),
];

/** Labelled international postal codes (UK, CA, JP, generic 4-6 digits) -> [ADDRESS_n]. */
const POSTAL_LABEL = String.raw`(?:post\s?code|postal\s{1,2}code|PLZ|〒|우편번호|郵便番号)`;
const POSTAL_VALUE = String.raw`(?<v>[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}|[A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{3}-\d{4}|\d{4,6})(?![A-Za-z0-9])`;
export const POSTAL_RE = new RegExp(String.raw`(?<lab>${POSTAL_LABEL}\s{0,2}[:#]?\s{0,2})${POSTAL_VALUE}`, 'gi');

/* ----------------------------------- dates ------------------------------------- */

const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
export const DATE_PAT = String.raw`(?:\d{4}-\d{2}-\d{2}(?!\d)|\d{1,2}\/\d{1,2}\/\d{4}|${MONTH}\.?\s{1,3}\d{1,2}(?:st|nd|rd|th)?,?\s{1,3}\d{4}|\d{1,2}(?:st|nd|rd|th)?\s{1,3}(?:of\s{1,3})?${MONTH}\.?,?\s{1,3}\d{4})`;
export const DATE_RE = new RegExp(String.raw`(?<![\d/-])${DATE_PAT}(?![\d/])`, 'gi');
export const DOB_RE = new RegExp(
  String.raw`\b(?<lab>(?:DOB|D\.O\.B\.?|date of birth|birth ?date|born(?: on)?)\s{0,3}[:-]?\s{0,3})(?<v>${DATE_PAT})(?![\d/])`,
  'gi',
);
export const AGE_RE =
  /(?<![\d.])(?<v>(?:9\d|1[0-4]\d))(?<suf>\s{0,2}-?\s{0,2}(?:years?|yrs?)[\s-]{0,3}old\b|\s{0,2}y\/o\b|\s{0,2}y\.o\.|\s{0,2}yo\b)/gi;
const MONTH_INDEX = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validIso(y: number, m: number, d: number): string | undefined {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

/** Parse ISO, US (M/D/YYYY) and month-name dates to `YYYY-MM-DD`. */
export function parseAnyDate(s: string): string | undefined {
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
