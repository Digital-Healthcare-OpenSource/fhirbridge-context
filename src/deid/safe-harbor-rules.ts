/**
 * Structured-field Safe Harbor rules: walks one resource tree DEFAULT-DENY. Every string
 * leaf is either (a) a date, handled by date-shifter.ts, (b) a known non-PHI member
 * (code/system/reference/status...), (c) a typed identifier member, or (d) scrubbed as free
 * text. Typed datatypes (HumanName, Address, ContactPoint, Identifier) are recognised by the
 * member that holds them, including `value[x]` and extensions. Never mutates its input.
 */
import {
  DROP,
  MAX_UNCAPPED_AGE,
  ageExtension,
  birthDateOutcome,
  dateLeaf,
  isAgeExtension,
  type DateWalk,
} from './date-shifter.js';
import {
  KEY_CATEGORY,
  ORG_NAME_TYPES,
  PERSON_CATEGORY,
  addressOverride,
  contactPointValue,
  humanNames,
  identifierCategory,
  isObj,
  looksLikeHumanNames,
  referenceDisplay,
  scrub,
  tokenize,
  type Obj,
  type RulesContext,
} from './structured-handlers.js';
import type { Resource } from '../types/fhir.js';

export { collectNameVariants } from './name-collect.js';
export { newRuleStats, type RuleStats, type RulesContext } from './structured-handlers.js';

/** 45 CFR 164.514(b)(2)(i)(A)-(R): the 18 identifier classes enforced by the engine. */
export const SAFE_HARBOR_RULE_NAMES: readonly string[] = [
  'A. Names -> [PATIENT_n]/[PROVIDER_n]/[PERSON_n]/[ORG_n] with canonical entity consolidation',
  'B. Geographic subdivisions smaller than a state (street, city, district, ZIP3 / 00000 for <20k areas)',
  'C. Dates (except year) shifted by a per-patient offset; birth date reduced to its year; ages over 89 capped to 90+',
  'D. Telephone numbers -> [PHONE_n]',
  'E. Fax numbers -> [FAX_n]',
  'F. Email addresses -> [EMAIL_n]',
  'G. Social Security numbers -> [SSN_n]',
  'H. Medical record numbers -> [MRN_n]',
  'I. Health plan beneficiary numbers -> [HEALTH_PLAN_n]',
  'J. Account numbers -> [ACCOUNT_n]',
  'K. Certificate/license numbers -> [LICENSE_n]',
  'L. Vehicle identifiers and license plates -> [VEHICLE_n]',
  'M. Device identifiers and serial numbers -> [DEVICE_n]',
  'N. URLs -> [URL_n]',
  'O. IP addresses -> [IP_n]',
  'P. Biometric identifiers (embedded attachment payloads removed)',
  'Q. Full-face photographs and comparable images (photo removed)',
  'R. Any other unique identifying number or code -> [ID_n]',
];

const ORIGINAL_ID_URL = 'https://fhirbridge.dev/fhir/StructureDefinition/original-id';
/** String members that are structural codes/ids, never PHI: passed through untouched. */
const NON_PHI_KEYS: ReadonlySet<string> = new Set([
  'resourceType', 'id', 'reference', 'system', 'code', 'version', 'versionId', 'status', 'intent',
  'use', 'gender', 'unit', 'contentType', 'language', 'criticality', 'severity', 'comparator',
  'profile', 'fullUrl', 'valueCode', 'priority', 'type',
]);
const MOTHERS_MAIDEN = /mother.?s?.?maiden/i;

interface State {
  ctx: RulesContext;
  dates: DateWalk;
}

type Overrides = Record<string, (v: unknown) => unknown>;

const isIdentifierMember = (key: string | undefined): boolean =>
  key === 'identifier' || (key !== undefined && key.endsWith('Identifier'));
const isOriginalId = (e: unknown): boolean => isObj(e) && e.url === ORIGINAL_ID_URL;
const isExtensionKey = (key: string | undefined): boolean => key === 'extension' || key === 'modifierExtension';

/** Members of typed datatypes that carry PHI, chosen by the member that holds the datatype. */
function overridesFor(s: State, obj: Obj, container: string | undefined, rt: string | undefined): Overrides {
  if (container === 'telecom' || container === 'valueContactPoint') {
    return { value: () => contactPointValue(s.ctx, obj) };
  }
  if (container === 'address' || container === 'valueAddress') {
    return Object.fromEntries(
      ['text', 'line', 'city', 'district', 'postalCode'].map((k) => [k, (v: unknown) => addressOverride(s.ctx, k, v) ?? v]),
    );
  }
  if (isIdentifierMember(container)) {
    return { value: (v) => (typeof v === 'string' && v ? tokenize(s.ctx, identifierCategory(obj, rt), v) : v) };
  }
  if (isExtensionKey(container) && MOTHERS_MAIDEN.test(String(obj.url ?? ''))) {
    return { valueString: (v) => (typeof v === 'string' && v.trim() ? tokenize(s.ctx, 'PERSON', v) : v) };
  }
  return {};
}

function walkString(s: State, key: string, v: string, obj: Obj, container: string | undefined, rt: string | undefined): unknown {
  const date = dateLeaf(v, key, s.dates);
  if (date !== null) return date;
  if (key === 'url') {
    if (typeof obj.contentType === 'string') return tokenize(s.ctx, 'URL', v); // Attachment.url
    const extensionLike = isExtensionKey(container) || Object.keys(obj).some((k) => k.startsWith('value'));
    return extensionLike ? v : scrub(s.ctx, v);
  }
  if (NON_PHI_KEYS.has(key)) return v;
  const category = KEY_CATEGORY[key];
  if (category && v.trim()) return tokenize(s.ctx, category, v);
  if (key === 'name' && v.trim()) {
    if (container === 'deviceName') return tokenize(s.ctx, 'DEVICE', v);
    if (rt && ORG_NAME_TYPES.has(rt) && typeof obj.resourceType === 'string') return tokenize(s.ctx, 'ORG', v);
  }
  if (key === 'display') {
    const isCoding = container === 'coding' || 'code' in obj || 'system' in obj || 'version' in obj;
    return isCoding ? scrub(s.ctx, v) : referenceDisplay(s.ctx, obj, v);
  }
  return scrub(s.ctx, v);
}

/** Walk one member value (string / array / object / scalar). */
function walkMember(s: State, key: string, v: unknown, obj: Obj, rt: string | undefined, container: string | undefined): unknown {
  if (typeof v === 'string') return walkString(s, key, v, obj, container, rt);
  if (Array.isArray(v)) {
    const items = isExtensionKey(key) ? v.filter((e) => !isOriginalId(e) && !isAgeExtension(e)) : v;
    return items.map((el) => {
      if (typeof el === 'string') return walkString(s, key, el, obj, container, rt);
      return isObj(el) ? walkObject(s, el, rt, key) : el;
    });
  }
  return isObj(v) ? walkObject(s, v, rt, key) : v;
}

function walkProp(s: State, key: string, v: unknown, obj: Obj, rt: string | undefined, container: string | undefined, over: Overrides): unknown {
  if (key === 'photo' || key === 'div') return DROP;
  if (key === 'position' && rt === 'Location' && typeof obj.resourceType === 'string') return DROP;
  if (key === 'data' && typeof obj.contentType === 'string') return DROP;
  if (key === 'text' && isObj(v)) return DROP; // Narrative
  const override = over[key];
  if (override) return override(v);
  if ((key === 'name' || key === 'valueHumanName') && looksLikeHumanNames(v)) {
    const isResource = typeof obj.resourceType === 'string';
    const category = (isResource && rt ? PERSON_CATEGORY[rt] : undefined) ?? 'PERSON';
    return humanNames(s.ctx, v, category) ?? DROP;
  }
  return walkMember(s, key, v, obj, rt, container);
}

function walkObject(s: State, obj: Obj, rt: string | undefined, container: string | undefined): Obj {
  const here = typeof obj.resourceType === 'string' ? obj.resourceType : rt;
  const over = overridesFor(s, obj, container, here);
  const out: Obj = {};
  let age: number | undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'birthDate') {
      // Safe Harbor: the year only, and nothing above age 89.
      const b = typeof v === 'string' ? birthDateOutcome(v, s.ctx.now) : {};
      age = b.age;
      if (b.age !== undefined && b.age > MAX_UNCAPPED_AGE) s.ctx.stats.agesCapped += 1;
      if (b.year !== undefined) out[k] = b.year;
      continue;
    }
    const r = walkProp(s, k, v, obj, here, container, over);
    if (r !== DROP) out[k] = r;
  }
  if (obj.resourceType === 'Patient' && age !== undefined) {
    const existing = Array.isArray(out.extension) ? out.extension : [];
    out.extension = [...existing, ageExtension(age)];
  }
  return out;
}

/** Return a de-identified copy of `resource` (structured fields, free text and dates). */
export function applyStructuredRules<T extends Resource>(resource: T, ctx: RulesContext): T {
  const dates: DateWalk = {
    days: ctx.dateShiftDays,
    now: ctx.now,
    onShifted: (shifted) => {
      if (ctx.patientKey) ctx.vault.recordShiftedDate(ctx.patientKey, shifted);
    },
    shifted: 0,
    agesCapped: 0,
  };
  const out = walkObject({ ctx, dates }, resource as Obj, undefined, undefined);
  ctx.stats.datesShifted += dates.shifted;
  return capAgeObservation(out) as T;
}

const AGE_LOINC = '30525-0';

/** An Age observation above 89 is reported as "90 or more" (Safe Harbor: ages over 89). */
function capAgeObservation(resource: Obj): Obj {
  if (resource.resourceType !== 'Observation' || !isObj(resource.valueQuantity)) return resource;
  const code = isObj(resource.code) ? resource.code : {};
  const codings = Array.isArray(code.coding) ? code.coding : [];
  const isAge =
    codings.some((c) => isObj(c) && c.code === AGE_LOINC) || /^\s*age\s*$/i.test(String(code.text ?? ''));
  const value = resource.valueQuantity.value;
  if (!isAge || typeof value !== 'number' || value <= MAX_UNCAPPED_AGE) return resource;
  return { ...resource, valueQuantity: { ...resource.valueQuantity, value: 90, comparator: '>=' } };
}
