/**
 * Applies a per-patient day offset to every date field of a resource tree.
 *
 * Time of day and timezone are preserved (shiftFhirDate), so intervals between shifted
 * instants are exact. Inputs are never mutated; a new tree is returned.
 *
 * Age rule: when the patient is older than 89 at `now`, birthDate is replaced with
 * `1900-01-01` (compiler renders "90+") BEFORE any shifting.
 */
import { ageInYears, isFhirDate, shiftDatesInText, shiftFhirDate } from '../shared/fhir-date.js';
import type { Resource } from '../types/fhir.js';

export const AGE_CAPPED_BIRTH_DATE = '1900-01-01';
/** Ages strictly greater than this are capped. */
export const MAX_UNCAPPED_AGE = 89;

const DATE_KEY_SUFFIX = /(?:Date|DateTime|On|Instant)$/;
const EXPLICIT_DATE_KEYS: ReadonlySet<string> = new Set([
  'date', 'issued', 'lastUpdated', 'time', 'recorded', 'created', 'timestamp', 'creation',
  'whenHandedOver', 'whenPrepared', 'start', 'end',
]);
/** String fields that carry identifiers/encodings, never prose: left alone in text-date mode. */
const NON_PROSE_KEYS: ReadonlySet<string> = new Set([
  'id', 'url', 'reference', 'system', 'code', 'resourceType', 'data', 'contentType', 'hash',
  'fullUrl', 'version', 'versionId', 'source', 'profile', 'status',
]);

export interface DateShiftOptions {
  now?: Date;
  /** Also shift ISO dates found inside prose strings (default true). */
  shiftTextDates?: boolean;
  /** Called with every shifted date/dateTime (not the age-cap sentinel). */
  onShifted?: (shifted: string) => void;
}

export interface DateShiftResult<T> {
  resource: T;
  /** Number of date values (fields + in-text dates) shifted. */
  shifted: number;
  ageCapped: boolean;
}

interface Walk {
  days: number;
  now: Date;
  shiftText: boolean;
  onShifted?: (shifted: string) => void;
  shifted: number;
  ageCapped: boolean;
}

function isDateKey(key: string): boolean {
  return DATE_KEY_SUFFIX.test(key) || EXPLICIT_DATE_KEYS.has(key);
}

function isRealDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function shiftString(value: string, key: string | undefined, w: Walk): string {
  if (key === 'birthDate' && isFhirDate(value)) {
    const age = ageInYears(value, w.now);
    if (age !== undefined && age > MAX_UNCAPPED_AGE) {
      w.ageCapped = true;
      return AGE_CAPPED_BIRTH_DATE;
    }
  }
  if (key !== undefined && isDateKey(key) && isFhirDate(value)) {
    const out = shiftFhirDate(value, w.days);
    w.shifted += 1;
    if (value.trim().length >= 10) w.onShifted?.(out);
    return out;
  }
  if (w.shiftText && (key === undefined || !NON_PROSE_KEYS.has(key))) {
    return shiftDatesInText(value, w.days, (iso) => {
      if (!isRealDate(iso)) return false;
      w.shifted += 1;
      w.onShifted?.(shiftFhirDate(iso, w.days));
      return true;
    });
  }
  return value;
}

function walk(value: unknown, key: string | undefined, w: Walk): unknown {
  if (typeof value === 'string') return shiftString(value, key, w);
  if (Array.isArray(value)) return value.map((v) => walk(v, key, w));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, w)]));
  }
  return value;
}

export function shiftResourceDates<T extends Resource>(
  resource: T,
  days: number,
  opts: DateShiftOptions = {},
): DateShiftResult<T> {
  const w: Walk = {
    days,
    now: opts.now ?? new Date(),
    shiftText: opts.shiftTextDates ?? true,
    onShifted: opts.onShifted,
    shifted: 0,
    ageCapped: false,
  };
  const out = walk(resource, undefined, w) as T;
  return { resource: out, shifted: w.shifted, ageCapped: w.ageCapped };
}
