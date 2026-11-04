/**
 * Date handling for de-identification: default-deny by TYPE, not by key suffix.
 *
 * Every string that parses as a FHIR date/dateTime/instant is shifted (or generalized to its
 * year when the owner has no shift), wherever it sits, except inside known non-date string
 * fields (ids, references, codes, display/text, Identifier values...). A field that is
 * date-keyed (`*Date`, `*DateTime`, `*On`, `event`, `sent`...) but does not parse FAILS CLOSED:
 * the 4-digit year is kept when extractable, otherwise the field is removed.
 *
 * `birthDate` is special (Safe Harbor allows only the year): it becomes the real 4-digit year,
 * or is removed when the person is older than 89, and Patient resources gain an
 * age-at-deidentification extension ("64" or "90+").
 *
 * Time of day and timezone are preserved (shiftFhirDate), so intervals between shifted
 * instants are exact. Inputs are never mutated; a new tree is returned.
 */
import { shiftDatesInText, shiftFhirDate, parseFhirDate } from '../shared/fhir-date.js';
import type { Resource } from '../types/fhir.js';
import { isPlausibleFhirDate, looseAge, parseLooseDate } from './loose-date.js';

/** Ages strictly greater than this are capped. */
export const MAX_UNCAPPED_AGE = 89;
export const AGE_CAP_LABEL = '90+';
export const AGE_EXTENSION_URL =
  'https://fhirbridge.dev/fhir/StructureDefinition/age-at-deidentification';

const DATE_KEY_SUFFIX = /(?:Date|DateTime|On|Instant)$/;
const EXPLICIT_DATE_KEYS: ReadonlySet<string> = new Set([
  'date', 'issued', 'lastUpdated', 'time', 'recorded', 'created', 'timestamp', 'creation',
  'whenHandedOver', 'whenPrepared', 'start', 'end', 'dateAsserted', 'event', 'sent', 'received',
  'dateTime', 'lastModified', 'receivedTime', 'birthDate',
]);
/** String fields that are never dates: left alone by the date pass. */
const NON_DATE_KEYS: ReadonlySet<string> = new Set([
  'id', 'url', 'reference', 'system', 'code', 'version', 'versionId', 'display', 'text', 'value',
  'div', 'resourceType', 'data', 'contentType', 'hash', 'fullUrl', 'source', 'profile', 'status',
]);

export interface DateShiftOptions {
  now?: Date;
  /** Also shift ISO dates found inside prose strings (default true). */
  shiftTextDates?: boolean;
  /** Called with every shifted date/dateTime (not generalized years). */
  onShifted?: (shifted: string) => void;
}

export interface DateShiftResult<T> {
  resource: T;
  /** Number of date values (fields + in-text dates) shifted or generalized. */
  shifted: number;
  /** Persons whose age (> 89) was capped. */
  agesCapped: number;
}

/** Mutable counters shared by one walk. `days === undefined` means "generalize to year". */
export interface DateWalk {
  days: number | undefined;
  now: Date;
  onShifted?: (shifted: string) => void;
  shifted: number;
  agesCapped: number;
}

export const DROP = Symbol('drop');

export const isDateKey = (key: string): boolean =>
  DATE_KEY_SUFFIX.test(key) || EXPLICIT_DATE_KEYS.has(key);

const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** Year of an unparseable date-keyed value, or DROP when none can be recovered. */
function failClosed(value: string): string | typeof DROP {
  return (parseLooseDate(value)?.year.toString().padStart(4, '0')) ?? DROP;
}

/**
 * Date-pass decision for one string leaf under `key`. Returns the replacement, DROP to remove
 * the field, or null when the leaf is not a date (the caller continues with its own rules).
 */
export function dateLeaf(value: string, key: string | undefined, w: DateWalk): string | typeof DROP | null {
  if (key === undefined || key === 'birthDate' || NON_DATE_KEYS.has(key)) return null;
  const dateKeyed = isDateKey(key);
  const trimmed = value.trim();
  const parseable = isPlausibleFhirDate(trimmed);
  if (!parseable) return dateKeyed ? failClosed(value) : null;
  if (!dateKeyed && !FULL_DATE_RE.test(trimmed)) return null; // bare "2024" in a prose field
  w.shifted += 1;
  const parsed = parseFhirDate(trimmed);
  if (w.days === undefined) return String(parsed?.year ?? 0).padStart(4, '0');
  const out = shiftFhirDate(trimmed, w.days);
  if (trimmed.length >= 10) w.onShifted?.(out);
  return out;
}

export interface BirthOutcome {
  /** Real 4-digit year, or undefined when the field must be removed. */
  year?: string;
  /** Age at `now`, when determinable. */
  age?: number;
}

/** Safe Harbor birth date: year only; nothing at all when older than 89 or unparseable. */
export function birthDateOutcome(value: string, now: Date): BirthOutcome {
  const d = parseLooseDate(value);
  if (!d) return {};
  const age = looseAge(d, now);
  if (age > MAX_UNCAPPED_AGE) return { age };
  return { year: String(d.year).padStart(4, '0'), age };
}

export const ageLabel = (age: number): string => (age > MAX_UNCAPPED_AGE ? AGE_CAP_LABEL : String(age));

export function ageExtension(age: number): { url: string; valueString: string } {
  return { url: AGE_EXTENSION_URL, valueString: ageLabel(age) };
}

export const isAgeExtension = (e: unknown): boolean =>
  e !== null && typeof e === 'object' && (e as { url?: unknown }).url === AGE_EXTENSION_URL;

/* ----------------------------- standalone walker ----------------------------- */

type Obj = Record<string, unknown>;

interface Walk extends DateWalk {
  shiftText: boolean;
}

function walkString(value: string, key: string | undefined, w: Walk): string | typeof DROP {
  const leaf = dateLeaf(value, key, w);
  if (leaf !== null) return leaf;
  if (w.shiftText && w.days !== undefined && (key === undefined || !NON_DATE_KEYS.has(key))) {
    return shiftDatesInText(value, w.days, (iso) => {
      w.shifted += 1;
      w.onShifted?.(shiftFhirDate(iso, w.days ?? 0));
      return true;
    });
  }
  return value;
}

function walkObject(obj: Obj, w: Walk): Obj {
  const out: Obj = {};
  let age: number | undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'birthDate' && typeof v === 'string') {
      const b = birthDateOutcome(v, w.now);
      age = b.age;
      if (b.age !== undefined && b.age > MAX_UNCAPPED_AGE) w.agesCapped += 1;
      if (b.year !== undefined) out[k] = b.year;
      continue;
    }
    const r = walkValue(v, k, w);
    if (r !== DROP) out[k] = r;
  }
  if (obj.resourceType === 'Patient' && age !== undefined) {
    const existing = Array.isArray(out.extension) ? out.extension.filter((e) => !isAgeExtension(e)) : [];
    out.extension = [...existing, ageExtension(age)];
  }
  return out;
}

function walkValue(value: unknown, key: string | undefined, w: Walk): unknown {
  if (typeof value === 'string') return walkString(value, key, w);
  if (Array.isArray(value)) {
    return value.map((v) => walkValue(v, key, w)).filter((v) => v !== DROP);
  }
  if (value !== null && typeof value === 'object') return walkObject(value as Obj, w);
  return value;
}

/** Shift (or, with `days` undefined, generalize to year) every date in a resource tree. */
export function shiftResourceDates<T extends Resource>(
  resource: T,
  days: number | undefined,
  opts: DateShiftOptions = {},
): DateShiftResult<T> {
  const w: Walk = {
    days,
    now: opts.now ?? new Date(),
    shiftText: opts.shiftTextDates ?? true,
    onShifted: opts.onShifted,
    shifted: 0,
    agesCapped: 0,
  };
  const out = walkObject(resource as Obj, w) as T;
  return { resource: out, shifted: w.shifted, agesCapped: w.agesCapped };
}
