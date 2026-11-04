/**
 * FHIR date/dateTime shifting that preserves precision, time of day and timezone.
 *
 * Used by de-identification (shift by Δt) and rehydration (shift by −Δt), so both
 * directions are exact inverses.
 */

const MS_PER_DAY = 86_400_000;

/** FHIR date / dateTime grammar (subset sufficient for real exports). */
const FHIR_DATE_RE =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

/** ISO calendar dates inside free text: YYYY-MM-DD, optionally followed by a time. */
export const TEXT_ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})(?=$|[^\d])/g;

export interface ParsedFhirDate {
  year: number;
  month?: number;
  day?: number;
  /** Everything after the date part, e.g. `T14:30:00Z` (kept verbatim). */
  timePart: string;
}

export function parseFhirDate(value: string): ParsedFhirDate | undefined {
  const trimmed = value.trim();
  const m = FHIR_DATE_RE.exec(trimmed);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const datePartLength = 4 + (mo ? 3 : 0) + (d ? 3 : 0);
  return {
    year: Number(y),
    month: mo ? Number(mo) : undefined,
    day: d ? Number(d) : undefined,
    timePart: trimmed.slice(datePartLength),
  };
}

export function isFhirDate(value: string): boolean {
  return FHIR_DATE_RE.test(value.trim());
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * Shift a FHIR date/dateTime by `days` calendar days.
 *
 * - `YYYY-MM-DD[Thh:mm[:ss[.sss]][tz]]`: the calendar date moves; time and zone are untouched,
 *   so the interval between two shifted instants is preserved to the second.
 * - `YYYY-MM` / `YYYY`: shifted from the first day of the period, then truncated back to the
 *   original precision.
 * Returns the input unchanged if it is not a FHIR date.
 */
export function shiftFhirDate(value: string, days: number): string {
  const parsed = parseFhirDate(value);
  if (!parsed) return value;
  const base = Date.UTC(parsed.year, (parsed.month ?? 1) - 1, parsed.day ?? 1);
  const shifted = new Date(base + days * MS_PER_DAY);
  const y = pad(shifted.getUTCFullYear(), 4);
  if (parsed.month === undefined) return y;
  const mo = pad(shifted.getUTCMonth() + 1);
  if (parsed.day === undefined) return `${y}-${mo}`;
  return `${y}-${mo}-${pad(shifted.getUTCDate())}${parsed.timePart}`;
}

/** Whole days from `a` to `b` (FHIR dates, day precision or coarser). */
export function daysBetween(a: string, b: string): number {
  const pa = parseFhirDate(a);
  const pb = parseFhirDate(b);
  if (!pa || !pb) return Number.NaN;
  const ta = Date.UTC(pa.year, (pa.month ?? 1) - 1, pa.day ?? 1);
  const tb = Date.UTC(pb.year, (pb.month ?? 1) - 1, pb.day ?? 1);
  return Math.round((tb - ta) / MS_PER_DAY);
}

/** Age in completed years at `now`. */
export function ageInYears(birthDate: string, now: Date = new Date()): number | undefined {
  const p = parseFhirDate(birthDate);
  if (!p) return undefined;
  const month = (p.month ?? 1) - 1;
  const day = p.day ?? 1;
  let age = now.getUTCFullYear() - p.year;
  if (now.getUTCMonth() < month || (now.getUTCMonth() === month && now.getUTCDate() < day)) age -= 1;
  return age;
}

/** Shift every ISO calendar date (YYYY-MM-DD) in free text; `accept` can veto individual dates. */
export function shiftDatesInText(
  text: string,
  days: number,
  accept?: (isoDate: string) => boolean,
): string {
  return text.replace(TEXT_ISO_DATE_RE, (match) => {
    if (accept && !accept(match)) return match;
    return shiftFhirDate(match, days);
  });
}
