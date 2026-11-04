/**
 * Structured-field Safe Harbor rules: walks one resource tree and pseudonymizes names,
 * telecom, addresses, identifiers and free text. Dates are handled separately by
 * date-shifter.ts. Never mutates its input.
 */
import { generalizeZip } from '../dictionaries/hipaa-zip3.js';
import type { HumanName, Resource } from '../types/fhir.js';
import type { PhiCategory } from '../types/pipeline.js';
import { scrubText, type KnownName, type ScrubContext } from './clinical-text-scrubber.js';
import type { SafeHarborVault } from './vault.js';

/** 45 CFR 164.514(b)(2)(i)(A)-(R): the 18 identifier classes enforced by the engine. */
export const SAFE_HARBOR_RULE_NAMES: readonly string[] = [
  'A. Names -> [PATIENT_n]/[PROVIDER_n]/[PERSON_n]/[ORG_n] with canonical entity consolidation',
  'B. Geographic subdivisions smaller than a state (street, city, district, ZIP3 / 00000 for <20k areas)',
  'C. Dates (except year) shifted by a per-patient offset; ages over 89 capped to 90+',
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

export interface RuleStats {
  replacements: Partial<Record<PhiCategory, number>>;
  datesShifted: number;
  zip3Restricted: number;
  zip3Generalized: number;
}

export const newRuleStats = (): RuleStats => ({
  replacements: {},
  datesShifted: 0,
  zip3Restricted: 0,
  zip3Generalized: 0,
});

export interface RulesContext {
  vault: SafeHarborVault;
  patientKey?: string;
  now: Date;
  dateShiftDays?: number;
  knownNames: readonly KnownName[];
  stats: RuleStats;
}

const ORIGINAL_ID_URL = 'https://fhirbridge.dev/fhir/StructureDefinition/original-id';
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'text', 'description', 'conclusion', 'comment', 'valueString', 'patientInstruction', 'title', 'note',
  'markdown', 'reasonText',
]);
const PERSON_CATEGORY: Readonly<Record<string, KnownName['category']>> = {
  Patient: 'PATIENT',
  Practitioner: 'PROVIDER',
  PractitionerRole: 'PROVIDER',
  RelatedPerson: 'PERSON',
  Person: 'PERSON',
};
const REF_CATEGORY: Readonly<Record<string, PhiCategory>> = {
  Patient: 'PATIENT',
  Practitioner: 'PROVIDER',
  PractitionerRole: 'PROVIDER',
  RelatedPerson: 'PERSON',
  Person: 'PERSON',
  Organization: 'ORG',
  Location: 'ORG',
  HealthcareService: 'ORG',
};
const ORG_NAME_TYPES: ReadonlySet<string> = new Set(['Organization', 'Location', 'HealthcareService']);

type Obj = Record<string, unknown>;
const DROP = Symbol('drop');
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const bump = (ctx: RulesContext, c: PhiCategory): void => {
  ctx.stats.replacements[c] = (ctx.stats.replacements[c] ?? 0) + 1;
};

function tokenize(ctx: RulesContext, category: PhiCategory, raw: string): string {
  bump(ctx, category);
  return ctx.vault.tokenFor(category, raw, { patientKey: ctx.patientKey });
}

/** All spellings of the person names in a HumanName[] (for consolidation + text sweeps). */
export function collectNameVariants(names: HumanName[] | undefined): string[] {
  const out: string[] = [];
  for (const n of names ?? []) {
    const given = (n.given ?? []).join(' ').trim();
    const family = (n.family ?? '').trim();
    const full = `${given} ${family}`.trim();
    for (const v of [n.text, full, family && given ? `${family}, ${given}` : '', family, ...(n.given ?? [])]) {
      if (v && v.trim() && !out.includes(v.trim())) out.push(v.trim());
    }
  }
  return out;
}

function scrub(ctx: RulesContext, text: string): string {
  // Normalizer marker for stripped binaries: metadata only, not PHI.
  if (text.startsWith('[BINARY_ATTACHMENT')) return text;
  const sctx: ScrubContext = {
    vault: ctx.vault,
    patientKey: ctx.patientKey,
    now: ctx.now,
    knownNames: ctx.knownNames,
    dateShiftDays: ctx.dateShiftDays,
  };
  const r = scrubText(text, sctx);
  for (const [k, n] of Object.entries(r.counts)) {
    const c = k as PhiCategory;
    ctx.stats.replacements[c] = (ctx.stats.replacements[c] ?? 0) + (n ?? 0);
  }
  ctx.stats.datesShifted += r.datesShifted;
  ctx.stats.zip3Restricted += r.zip3Restricted;
  ctx.stats.zip3Generalized += r.zip3Generalized;
  return r.text;
}

function mapItems(v: unknown, fn: (o: Obj) => unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (isObj(x) ? fn(x) : x));
  return isObj(v) ? fn(v) : v;
}

/* ------------------------------ field handlers ------------------------------ */

function personNames(ctx: RulesContext, v: unknown, category: KnownName['category']): unknown {
  if (!Array.isArray(v)) return v;
  const names = v.filter(isObj) as HumanName[];
  const variants = collectNameVariants(names);
  if (variants.length === 0) return [];
  bump(ctx, category);
  const token = ctx.vault.registerName(category, variants, { patientKey: ctx.patientKey });
  const use = names[0]?.use;
  return [{ ...(use ? { use } : {}), text: token, family: token }];
}

function contactPoint(ctx: RulesContext, cp: Obj): Obj {
  if (typeof cp.value !== 'string' || !cp.value) return cp;
  const sys = typeof cp.system === 'string' ? cp.system : '';
  let category: PhiCategory = 'PHONE';
  if (sys === 'fax') category = 'FAX';
  else if (sys === 'email' || (sys !== 'phone' && cp.value.includes('@'))) category = 'EMAIL';
  else if (sys === 'url') category = 'URL';
  return { ...cp, value: tokenize(ctx, category, cp.value) };
}

function address(ctx: RulesContext, a: Obj): Obj {
  const out: Obj = { ...a };
  if (typeof a.text === 'string') out.text = tokenize(ctx, 'ADDRESS', a.text);
  if (Array.isArray(a.line)) {
    out.line = a.line.map((l) => (typeof l === 'string' && l.trim() ? tokenize(ctx, 'ADDRESS', l) : l));
  }
  for (const k of ['city', 'district'] as const) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) out[k] = tokenize(ctx, 'ADDRESS', v);
  }
  if (typeof a.postalCode === 'string') {
    const z = generalizeZip(a.postalCode);
    if (z.restricted) ctx.stats.zip3Restricted += 1;
    else ctx.stats.zip3Generalized += 1;
    out.postalCode = z.value;
  }
  return out;
}

function identifierCategory(id: Obj, resourceType: string | undefined): PhiCategory {
  const type = isObj(id.type) ? id.type : {};
  const codes = (Array.isArray(type.coding) ? type.coding : [])
    .map((c) => (isObj(c) && typeof c.code === 'string' ? c.code.toUpperCase() : ''))
    .filter(Boolean);
  const hay = `${typeof id.system === 'string' ? id.system : ''} ${typeof type.text === 'string' ? type.text : ''}`.toLowerCase();
  const has = (...c: string[]): boolean => c.some((x) => codes.includes(x));
  if (has('MR') || /mrn|medical.?record/.test(hay)) return 'MRN';
  if (has('SS', 'SSN') || /ssn|social.?security/.test(hay)) return 'SSN';
  if (has('NPI') || /\bnpi\b|us-npi/.test(hay)) return 'ID';
  if (has('MB', 'SN', 'BEN') || /member|plan|insurance|beneficiary|payer/.test(hay)) return 'HEALTH_PLAN';
  if (has('AN', 'ACSN') || /account/.test(hay)) return 'ACCOUNT';
  if (has('DL', 'LN') || /licen[sc]e|driver/.test(hay)) return 'LICENSE';
  if (/\bvin\b|plate|vehicle/.test(hay)) return 'VEHICLE';
  if (has('SNO', 'SER') || /serial|udi|device/.test(hay) || resourceType === 'Device') return 'DEVICE';
  return 'ID';
}

function identifier(ctx: RulesContext, id: Obj, rt: string | undefined): Obj {
  if (typeof id.value !== 'string' || !id.value) return id;
  return { ...id, value: tokenize(ctx, identifierCategory(id, rt), id.value) };
}

function refTypeOf(o: Obj): string | undefined {
  if (typeof o.reference === 'string') {
    const m = /(?:^|\/)([A-Z][A-Za-z]+)\/[^/]+(?:\/_history\/[^/]+)?$/.exec(o.reference);
    if (m?.[1]) return m[1];
  }
  return typeof o.type === 'string' ? o.type : undefined;
}

function referenceDisplay(ctx: RulesContext, o: Obj, display: string): string {
  const category = REF_CATEGORY[refTypeOf(o) ?? ''];
  return category ? tokenize(ctx, category, display) : scrub(ctx, display);
}

function isOriginalIdExtension(v: unknown): boolean {
  return isObj(v) && v.url === ORIGINAL_ID_URL;
}

/* ---------------------------------- walker ---------------------------------- */

function walkProp(ctx: RulesContext, key: string, v: unknown, parent: Obj, rt: string | undefined): unknown {
  if (key === 'photo' || key === 'div') return DROP;
  if (key === 'position' && rt === 'Location') return DROP;
  if (key === 'data' && typeof parent.contentType === 'string') return DROP;
  if (key === 'text' && isObj(v)) return DROP; // Narrative
  if (key === 'telecom') return mapItems(v, (o) => contactPoint(ctx, o));
  if (key === 'address') return mapItems(v, (o) => address(ctx, o));
  if (key === 'identifier') return mapItems(v, (o) => identifier(ctx, o, rt));
  if (key === 'extension') {
    return Array.isArray(v) ? walk(ctx, v.filter((e) => !isOriginalIdExtension(e)), key, rt) : walk(ctx, v, key, rt);
  }
  if (key === 'name') {
    const category = rt ? PERSON_CATEGORY[rt] : undefined;
    if (category && Array.isArray(v)) return personNames(ctx, v, category);
    if (typeof v === 'string' && rt && ORG_NAME_TYPES.has(rt)) return tokenize(ctx, 'ORG', v);
  }
  if (key === 'authorString' && typeof v === 'string') return tokenize(ctx, 'PROVIDER', v);
  if (key === 'display' && typeof v === 'string' && !('code' in parent)) return referenceDisplay(ctx, parent, v);
  if (key === 'url' && typeof v === 'string' && typeof parent.contentType === 'string') {
    return tokenize(ctx, 'URL', v);
  }
  if (typeof v === 'string' && FREE_TEXT_KEYS.has(key)) return scrub(ctx, v);
  return walk(ctx, v, key, rt);
}

function walk(ctx: RulesContext, value: unknown, key: string | undefined, rt: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((x) => walk(ctx, x, key, rt));
  if (!isObj(value)) return value;
  const here = typeof value.resourceType === 'string' ? value.resourceType : rt;
  const entries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(value)) {
    const out = walkProp(ctx, k, v, value, here);
    if (out !== DROP) entries.push([k, out]);
  }
  return Object.fromEntries(entries);
}

/** Return a de-identified copy of `resource` (structured fields + free text; no date shifting). */
export function applyStructuredRules<T extends Resource>(resource: T, ctx: RulesContext): T {
  return walk(ctx, resource, undefined, undefined) as T;
}
