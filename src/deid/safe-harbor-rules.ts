/**
 * Structured-field Safe Harbor rules: walks one resource tree DEFAULT-DENY. Every string
 * leaf is either (a) a date, handled by date-shifter.ts, (b) a structural member (code, system,
 * unit, status...) that must pass a strict shape check, (c) a typed identifier member, or
 * (d) scrubbed as free text. Typed datatypes (HumanName, Address, ContactPoint, Identifier) are
 * recognised by the member that holds them, including `value[x]` and extensions, and are handled
 * for EVERY JSON type (string, number, array, object): an unexpected shape is dropped, never
 * passed through raw. Never mutates its input.
 */
import {
  isAgeKey,
  capAgeQuantity,
  isBirthExtensionUrl,
  isBirthKey,
  isClinicalNumber,
  MOTHERS_MAIDEN_RE,
  reduceBirth,
  reduceBirthExtensionValue,
} from './birth-age-rules.js';
import {
  DROP,
  MAX_UNCAPPED_AGE,
  ageExtension,
  dateLeaf,
  isAgeExtension,
  type DateWalk,
} from './date-shifter.js';
import { validateReference, validateStructural, validateUri } from './leaf-validators.js';
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
  mapPhi,
  referenceDisplay,
  scrub,
  tokenize,
  tokenizedValue,
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
export const BINARY_REMOVED = '[BINARY_REMOVED]';
const BASE64_MIN_LENGTH = 64;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;
/** Members that hold free text; `omit` mode removes them (CodeableConcept.text is handled apart). */
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'note', 'description', 'conclusion', 'comment', 'summary', 'valueString', 'contentString',
  'patientInstruction', 'reasonText', 'valueMarkdown',
]);
const SAMPLED_DATA = /^[\d\s.eE+\-LU]*$/;

interface State {
  ctx: RulesContext;
  dates: DateWalk;
}

type Overrides = Record<string, (v: unknown) => unknown>;

const isIdentifierMember = (key: string | undefined): boolean =>
  key === 'identifier' || (key !== undefined && key.endsWith('Identifier'));
const isOriginalId = (e: unknown): boolean => isObj(e) && e.url === ORIGINAL_ID_URL;
const isExtensionKey = (key: string | undefined): boolean => key === 'extension' || key === 'modifierExtension';
const isResource = (obj: Obj): boolean => typeof obj.resourceType === 'string';

/** A long run of base64 characters is an embedded payload, whatever member carries it. */
function looksLikeBase64(v: string): boolean {
  if (v.length < BASE64_MIN_LENGTH) return false;
  const body = v.replace(/[\r\n]/g, '');
  return BASE64_BODY.test(body) && body.length % 4 !== 1;
}

/** Members of typed datatypes that carry PHI, chosen by the member that holds the datatype. */
function overridesFor(s: State, obj: Obj, container: string | undefined, rt: string | undefined): Overrides {
  if (container === 'telecom' || container === 'valueContactPoint') {
    return { value: () => contactPointValue(s.ctx, obj) };
  }
  if (container === 'address' || container === 'valueAddress') {
    return Object.fromEntries(
      ['text', 'line', 'city', 'district', 'postalCode'].map((k) => [k, (v: unknown) => addressOverride(s.ctx, k, v)]),
    );
  }
  if (isIdentifierMember(container)) {
    return { value: (v) => tokenizedValue(s.ctx, identifierCategory(obj, rt), v) };
  }
  if (container === 'class' && rt === 'Coverage') {
    return { value: (v) => tokenizedValue(s.ctx, 'HEALTH_PLAN', v) };
  }
  if (isExtensionKey(container) && MOTHERS_MAIDEN_RE.test(String(obj.url ?? ''))) {
    return { valueString: (v) => mapPhi(v, (x) => tokenize(s.ctx, 'PERSON', x)) };
  }
  return {};
}

function walkUrl(s: State, v: string, obj: Obj, container: string | undefined): string {
  if (typeof obj.contentType === 'string') return tokenize(s.ctx, 'URL', v); // Attachment.url
  const extensionLike = isExtensionKey(container) || Object.keys(obj).some((k) => k.startsWith('value'));
  return extensionLike ? validateUri(s.ctx, v) : scrub(s.ctx, v);
}

function walkString(s: State, key: string, v: string, obj: Obj, container: string | undefined, rt: string | undefined): unknown {
  if (looksLikeBase64(v)) return BINARY_REMOVED;
  const date = dateLeaf(v, key, s.dates);
  if (date !== null) return date;
  if (key === 'url') return walkUrl(s, v, obj, container);
  if (key === 'resourceType' || key === 'id') return v;
  if (key === 'reference') return validateReference(s.ctx, v);
  const structural = validateStructural(s.ctx, key, v, container);
  if (structural !== undefined) return structural;
  const category = KEY_CATEGORY[key];
  if (category && v.trim()) return tokenize(s.ctx, category, v);
  if (key === 'name' && v.trim()) {
    if (container === 'deviceName') return tokenize(s.ctx, 'DEVICE', v);
    if (rt && ORG_NAME_TYPES.has(rt) && isResource(obj)) return tokenize(s.ctx, 'ORG', v);
  }
  if (key === 'display') {
    const isCoding = container === 'coding' || 'code' in obj || 'system' in obj || 'version' in obj;
    return isCoding ? scrub(s.ctx, v) : referenceDisplay(s.ctx, obj, v);
  }
  return scrub(s.ctx, v);
}

/** One array element or scalar member: strings, numbers, nested arrays and objects. */
function walkElement(s: State, key: string, v: unknown, obj: Obj, rt: string | undefined, container: string | undefined): unknown {
  if (typeof v === 'string') return walkString(s, key, v, obj, container, rt);
  if (typeof v === 'number' || typeof v === 'bigint') {
    return typeof v === 'number' && isClinicalNumber(key, obj, container)
      ? v
      : walkString(s, key, String(v), obj, container, rt);
  }
  if (Array.isArray(v)) return v.map((e) => walkElement(s, key, e, obj, rt, container)).filter((e) => e !== DROP);
  return isObj(v) ? walkObject(s, v, rt, key) : v;
}

/** Walk one member value (string / array / object / scalar). */
function walkMember(s: State, key: string, v: unknown, obj: Obj, rt: string | undefined, container: string | undefined): unknown {
  if (Array.isArray(v) && isExtensionKey(key)) {
    const kept = v.filter((e) => !isOriginalId(e) && !isAgeExtension(e));
    return kept.map((e) => walkElement(s, key, e, obj, rt, container)).filter((e) => e !== DROP);
  }
  return walkElement(s, key, v, obj, rt, container);
}

/** SampledData.data is a clinical waveform (numbers only); every other `data` is a payload. */
const keepsData = (obj: Obj, v: unknown): boolean =>
  'dimensions' in obj && typeof v === 'string' && SAMPLED_DATA.test(v);

function keepsCodeableText(obj: Obj, text: string): boolean {
  const wanted = text.trim().toLowerCase();
  const codings = Array.isArray(obj.coding) ? obj.coding : [];
  return codings.some((c) => isObj(c) && typeof c.display === 'string' && c.display.trim().toLowerCase() === wanted);
}

/** `omit` mode: free-text members are removed; CodeableConcept.text survives only as a display. */
function isOmittedFreeText(s: State, key: string, v: unknown, obj: Obj): boolean {
  if (s.ctx.freeText !== 'omit') return false;
  if (FREE_TEXT_KEYS.has(key)) return true;
  return key === 'text' && !(typeof v === 'string' && keepsCodeableText(obj, v));
}

function personCategoryOf(obj: Obj, rt: string | undefined) {
  return isResource(obj) && rt ? PERSON_CATEGORY[rt] : undefined;
}

function walkName(s: State, key: string, v: unknown, obj: Obj, rt: string | undefined, container: string | undefined): unknown {
  const personal = personCategoryOf(obj, rt);
  if (key === 'name' && personal) return humanNames(s.ctx, v, personal, true); // any shape: Patient.name
  if ((key === 'name' || key === 'valueHumanName') && looksLikeHumanNames(v)) {
    return humanNames(s.ctx, v, 'PERSON', Array.isArray(v));
  }
  if (key === 'name' && typeof v === 'string' && container === 'contact') return humanNames(s.ctx, v, 'PERSON', false);
  return undefined;
}

function walkProp(s: State, key: string, v: unknown, obj: Obj, rt: string | undefined, container: string | undefined, over: Overrides): unknown {
  if (key === 'photo' || key === 'div') return DROP;
  if (key === 'position' && rt === 'Location' && isResource(obj)) return DROP;
  if (key === 'data') return keepsData(obj, v) ? v : DROP;
  if (key.startsWith('_') && isBirthKey(key.slice(1))) return DROP;
  if (key === 'id' && !isResource(obj)) return DROP; // element ids: only Resource.id (and contained ids) survive
  if (key === 'text' && isObj(v)) return DROP; // Narrative
  if (isOmittedFreeText(s, key, v, obj)) return DROP;
  const override = over[key];
  if (override) return override(v);
  const named = walkName(s, key, v, obj, rt, container);
  if (named !== undefined) return named;
  if (isAgeKey(key) && isObj(v)) {
    const { value, capped } = capAgeQuantity(v);
    if (capped) s.ctx.stats.agesCapped += 1;
    return walkMember(s, key, value, obj, rt, container);
  }
  return walkMember(s, key, v, obj, rt, container);
}

function walkObject(s: State, obj: Obj, rt: string | undefined, container: string | undefined): Obj {
  const here = typeof obj.resourceType === 'string' ? obj.resourceType : rt;
  const over = overridesFor(s, obj, container, here);
  const birthExtension = isBirthExtensionUrl(obj.url);
  const out: Obj = {};
  let age: number | undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (isBirthKey(k) && !k.startsWith('_') && k !== 'url') {
      // Safe Harbor: the year only, and nothing above age 89; any non-scalar shape is dropped.
      const b = reduceBirth(v, s.ctx.now);
      if (k === 'birthDate') age = b.age;
      if (b.age !== undefined && b.age > MAX_UNCAPPED_AGE) s.ctx.stats.agesCapped += 1;
      if (b.year !== undefined) out[k] = b.year;
      continue;
    }
    if (birthExtension && k.startsWith('value')) {
      const r = reduceBirthExtensionValue(obj.url, k, v, s.ctx.now);
      if (r !== DROP) out[k] = r;
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
