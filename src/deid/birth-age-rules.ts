/**
 * Birth-date and age rules for the structured walker.
 *
 *  - any scalar under a birth-ish key (`birthDate`, `birthTime`, `dob`...) or under an extension
 *    whose url names a birth/dob is reduced to its 4-digit year, or removed above age 89;
 *  - `birthPlace` extensions keep the country only;
 *  - Age quantities above 89 years (any unit) are reported as ">= 90".
 */
import { DROP, MAX_UNCAPPED_AGE, birthDateOutcome, type BirthOutcome } from './date-shifter.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export const MOTHERS_MAIDEN_RE = /mother.?s?.?maiden/i;
const BIRTH_RE = /birth|dob/i;
const MULTIPLE_BIRTH_RE = /^multipleBirth/i;
const BIRTH_PLACE_RE = /birthPlace/i;

/** `birthDate`, `birthTime`, `dob`, `dateOfBirth`... but not `multipleBirthInteger`. */
export const isBirthKey = (key: string): boolean => BIRTH_RE.test(key) && !MULTIPLE_BIRTH_RE.test(key);
export const isBirthExtensionUrl = (url: unknown): boolean => typeof url === 'string' && BIRTH_RE.test(url);
export const isBirthPlaceUrl = (url: unknown): boolean => typeof url === 'string' && BIRTH_PLACE_RE.test(url);
export const isScalar = (v: unknown): v is string | number => typeof v === 'string' || typeof v === 'number';

/** Safe Harbor reduction of one birth value: year only, nothing above 89, nothing unparsable. */
export function reduceBirth(v: unknown, now: Date): BirthOutcome {
  return isScalar(v) ? birthDateOutcome(String(v), now) : {};
}

/** The value members of a birth-related extension: the year, the country, or nothing. */
export function reduceBirthExtensionValue(url: unknown, key: string, v: unknown, now: Date): unknown {
  if (isBirthPlaceUrl(url)) {
    return key === 'valueAddress' && isObj(v) && typeof v.country === 'string' ? { country: v.country } : DROP;
  }
  return reduceBirth(v, now).year ?? DROP;
}

/* ---------------------------------- ages ---------------------------------- */

const UCUM = 'http://unitsofmeasure.org';
/** `onsetAge`, `abatementAge`, `valueAge`, `ageQuantity`, `age`; never `dosage` / `coverage`. */
const AGE_KEY_RE = /^(?:[a-z]+)?Age(?:Quantity)?$|^age(?:Quantity)?$/;
const YEARS_PER_UNIT: Readonly<Record<string, number>> = {
  a: 1, yr: 1, y: 1, year: 1, years: 1, mo: 1 / 12, month: 1 / 12, months: 1 / 12,
  wk: 1 / 52.18, week: 1 / 52.18, weeks: 1 / 52.18, d: 1 / 365.25, day: 1 / 365.25, days: 1 / 365.25,
};

export const isAgeKey = (key: string): boolean => AGE_KEY_RE.test(key);

function yearsOf(q: Obj): number | undefined {
  const raw = typeof q.value === 'number' ? q.value : typeof q.value === 'string' ? Number(q.value) : Number.NaN;
  if (!Number.isFinite(raw)) return undefined;
  const unit = String(q.code ?? q.unit ?? 'a').trim().toLowerCase();
  return raw * (YEARS_PER_UNIT[unit] ?? 1);
}

/** An Age above 89 years becomes `>= 90 a`; returns the same object when no cap is needed. */
export function capAgeQuantity(q: Obj): { value: Obj; capped: boolean } {
  const years = yearsOf(q);
  if (years === undefined || years <= MAX_UNCAPPED_AGE) return { value: q, capped: false };
  return { value: { value: 90, comparator: '>=', unit: 'years', system: UCUM, code: 'a' }, capped: true };
}

/* --------------------------- numeric leaves --------------------------- */

const STRUCTURAL_NUMBER_KEYS: ReadonlySet<string> = new Set([
  'sequence', 'rank', 'count', 'numberOfRepeatsAllowed', 'size', 'total', 'frequency', 'frequencyMax',
  'period', 'periodMax', 'duration', 'durationMax', 'countMax', 'offset', 'dimensions', 'factor',
  'lowerLimit', 'upperLimit', 'repetitions', 'order',
]);
const NUMERIC_TYPE_SUFFIX = /(?:Integer|Integer64|Decimal|PositiveInt|UnsignedInt)$/;
const QUANTITY_CONTAINER =
  /(?:Quantity|Age|Duration|Count|Distance|Money|Range|Ratio)$|^(?:quantity|low|high|numerator|denominator|origin|rate|dose|age|length)$/;

/**
 * A JSON number is clinical data only in numeric positions (Quantity.value and friends, typed
 * `value[x]`, ordinals). A number anywhere else could be an identifier or phone number written
 * without quotes: the caller coerces it to a string and scrubs it.
 */
export function isClinicalNumber(key: string, obj: Obj, container: string | undefined): boolean {
  if (STRUCTURAL_NUMBER_KEYS.has(key) || NUMERIC_TYPE_SUFFIX.test(key)) return true;
  if (key !== 'value') return false;
  const quantityLike = ['unit', 'code', 'system', 'comparator', 'currency'].some((k) => k in obj);
  return quantityLike || (container !== undefined && QUANTITY_CONTAINER.test(container));
}
