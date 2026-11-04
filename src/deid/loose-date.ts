/**
 * Best-effort parsing of dates that are NOT valid FHIR date strings (MM/DD/YYYY,
 * "YYYY-MM-DD hh:mm", YYYYMMDD ...). Used only to fail closed: a malformed date is never
 * passed through; we keep at most its year, or drop it.
 */
import { parseFhirDate } from '../shared/fhir-date.js';

export interface LooseDate {
  year: number;
  month?: number;
  day?: number;
}

const YEAR_RE = /\b(1[89]\d\d|20\d\d)\b/;
const US_RE = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/;
const ISO_SPACE_RE = /^\s*(\d{4})-(\d{2})-(\d{2})[\sT]/;
const COMPACT_RE = /^\s*(\d{4})(\d{2})(\d{2})(?:T?\d{4,6})?\s*$/;

const validMonth = (m: number): boolean => m >= 1 && m <= 12;
const validDay = (d: number): boolean => d >= 1 && d <= 31;

export function isPlausibleFhirDate(value: string): boolean {
  const p = parseFhirDate(value);
  if (!p) return false;
  if (p.month !== undefined && !validMonth(p.month)) return false;
  return p.day === undefined || validDay(p.day);
}

export function parseLooseDate(value: string): LooseDate | undefined {
  if (isPlausibleFhirDate(value)) {
    const p = parseFhirDate(value);
    if (p) return { year: p.year, month: p.month, day: p.day };
  }
  const us = US_RE.exec(value);
  if (us) {
    const a = Number(us[1]);
    const b = Number(us[2]);
    // MM/DD/YYYY unless the first field cannot be a month (then DD/MM/YYYY).
    const [month, day] = validMonth(a) ? [a, b] : [b, a];
    if (validMonth(month) && validDay(day)) return { year: Number(us[3]), month, day };
  }
  const iso = ISO_SPACE_RE.exec(value) ?? COMPACT_RE.exec(value);
  if (iso) {
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (validMonth(month) && validDay(day)) return { year: Number(iso[1]), month, day };
  }
  const year = YEAR_RE.exec(value)?.[1];
  return year ? { year: Number(year) } : undefined;
}

/** Completed years at `now`; missing month/day count as 1 January (errs towards older). */
export function looseAge(d: LooseDate, now: Date): number {
  const month = (d.month ?? 1) - 1;
  const day = d.day ?? 1;
  let age = now.getUTCFullYear() - d.year;
  if (now.getUTCMonth() < month || (now.getUTCMonth() === month && now.getUTCDate() < day)) age -= 1;
  return age;
}
