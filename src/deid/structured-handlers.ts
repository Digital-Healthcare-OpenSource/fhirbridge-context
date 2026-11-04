/** Per-datatype Safe Harbor handlers used by the structured walker (safe-harbor-rules.ts). */
import { generalizeZip } from '../dictionaries/hipaa-zip3.js';
import type { PhiCategory } from '../types/pipeline.js';
import { DROP } from './date-shifter.js';
import { collectNameVariants, isHumanName, normalizeNames } from './name-collect.js';
import { scrubText } from './clinical-text-scrubber.js';
import type { FreeTextMode, KnownName, NameCategory, ScrubContext } from './scrub-types.js';
import { canonicalName } from './vault-names.js';
import type { SafeHarborVault } from './vault.js';

export interface RuleStats {
  replacements: Partial<Record<PhiCategory, number>>;
  datesShifted: number;
  zip3Restricted: number;
  zip3Generalized: number;
  agesCapped: number;
}

export const newRuleStats = (): RuleStats => ({
  replacements: {},
  datesShifted: 0,
  zip3Restricted: 0,
  zip3Generalized: 0,
  agesCapped: 0,
});

export interface RulesContext {
  vault: SafeHarborVault;
  patientKey?: string;
  now: Date;
  /** Day offset for this resource's owner; undefined generalizes every date to its year. */
  dateShiftDays?: number;
  knownNames: readonly KnownName[];
  /** Names of the other patients in the graph (see ScrubContext.otherNames). */
  otherNames?: readonly KnownName[];
  /** `omit` removes every free-text field instead of scrubbing it. Defaults to `scrub`. */
  freeText?: FreeTextMode;
  stats: RuleStats;
  onDiscovered?: ScrubContext['onDiscovered'];
}

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export const REF_CATEGORY: Readonly<Record<string, PhiCategory>> = {
  Patient: 'PATIENT',
  Practitioner: 'PROVIDER',
  PractitionerRole: 'PROVIDER',
  RelatedPerson: 'PERSON',
  Person: 'PERSON',
  Organization: 'ORG',
  Location: 'ORG',
  HealthcareService: 'ORG',
  Device: 'DEVICE',
};
export const PERSON_CATEGORY: Readonly<Record<string, NameCategory>> = {
  Patient: 'PATIENT',
  Practitioner: 'PROVIDER',
  PractitionerRole: 'PROVIDER',
  RelatedPerson: 'PERSON',
  Person: 'PERSON',
};
export const ORG_NAME_TYPES: ReadonlySet<string> = new Set(['Organization', 'Location', 'HealthcareService']);

export const bump = (ctx: RulesContext, c: PhiCategory): void => {
  ctx.stats.replacements[c] = (ctx.stats.replacements[c] ?? 0) + 1;
};

export function tokenize(ctx: RulesContext, category: PhiCategory, raw: string): string {
  bump(ctx, category);
  return ctx.vault.tokenFor(category, raw, { patientKey: ctx.patientKey });
}

/** Scrub free text; counts are folded into the rule stats. */
export function scrub(ctx: RulesContext, text: string): string {
  // Normalizer marker for stripped binaries: metadata only, not PHI.
  if (text.startsWith('[BINARY_ATTACHMENT')) return text;
  const r = scrubText(text, {
    vault: ctx.vault,
    patientKey: ctx.patientKey,
    now: ctx.now,
    knownNames: ctx.knownNames,
    otherNames: ctx.otherNames,
    dateShiftDays: ctx.dateShiftDays,
    onDiscovered: ctx.onDiscovered,
  });
  for (const [k, n] of Object.entries(r.counts)) {
    const c = k as PhiCategory;
    ctx.stats.replacements[c] = (ctx.stats.replacements[c] ?? 0) + (n ?? 0);
  }
  ctx.stats.datesShifted += r.datesShifted;
  ctx.stats.zip3Restricted += r.zip3Restricted;
  ctx.stats.zip3Generalized += r.zip3Generalized;
  return r.text;
}

/**
 * Apply `fn` to every scalar of a PHI-typed member. Scalars are coerced to strings (a phone number
 * written as a JSON number is still a phone number), arrays are mapped element-wise, and any
 * other shape (object, boolean, null) is DROPPED: a PHI member is never passed through raw.
 */
export function mapPhi(v: unknown, fn: (s: string) => unknown, depth = 0): unknown {
  if (depth > MAX_PHI_DEPTH) return DROP;
  if (typeof v === 'string') return v.trim() ? fn(v) : v;
  if (typeof v === 'number' || typeof v === 'bigint') return fn(String(v));
  if (Array.isArray(v)) return v.map((e) => mapPhi(e, fn, depth + 1)).filter((e) => e !== DROP);
  return DROP;
}
const MAX_PHI_DEPTH = 6;

/**
 * HumanName / HumanName[] / string / nested arrays -> one pseudonymous name. Returns DROP when
 * nothing usable remains. `asArray` keeps the FHIR cardinality of the member being rewritten.
 */
export function humanNames(ctx: RulesContext, v: unknown, category: NameCategory, asArray: boolean): unknown {
  const items = normalizeNames(v);
  const variants = collectNameVariants(items);
  if (variants.every((x) => canonicalName(x).length === 0)) return DROP;
  bump(ctx, category);
  const token = ctx.vault.registerName(category, variants, { patientKey: ctx.patientKey });
  const use = isObj(v) ? v.use : Array.isArray(v) && isObj(v[0]) ? v[0].use : undefined;
  const one = { ...(typeof use === 'string' ? { use } : {}), text: token, family: token };
  return asArray ? [one] : one;
}

export const looksLikeHumanNames = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 && v.every(isHumanName) : isHumanName(v);

export function contactCategory(system: string, value: string): PhiCategory {
  if (system === 'fax') return 'FAX';
  if (system === 'email' || (system !== 'phone' && value.includes('@'))) return 'EMAIL';
  return system === 'url' ? 'URL' : 'PHONE';
}

export function contactPointValue(ctx: RulesContext, cp: Obj): unknown {
  const sys = typeof cp.system === 'string' ? cp.system : '';
  return mapPhi(cp.value, (s) => tokenize(ctx, contactCategory(sys, s), s));
}

/** Overrides for Address members; every other member goes through the generic walker. */
export function addressOverride(ctx: RulesContext, key: string, v: unknown): unknown {
  if (key === 'postalCode') {
    return mapPhi(v, (s) => {
      const z = generalizeZip(s);
      if (z.restricted) ctx.stats.zip3Restricted += 1;
      else ctx.stats.zip3Generalized += 1;
      return z.value;
    });
  }
  return mapPhi(v, (s) => tokenize(ctx, 'ADDRESS', s));
}

/** Identifier.value / Coverage.class.value: tokenized whatever JSON type it arrives as. */
export function tokenizedValue(ctx: RulesContext, category: PhiCategory, v: unknown): unknown {
  return mapPhi(v, (s) => tokenize(ctx, category, s));
}

export function identifierCategory(id: Obj, resourceType: string | undefined): PhiCategory {
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

export function refTypeOf(o: Obj): string | undefined {
  if (typeof o.reference === 'string') {
    const m = /(?:^|\/)([A-Z][A-Za-z]+)\/[^/]+(?:\/_history\/[^/]+)?$/.exec(o.reference);
    if (m?.[1]) return m[1];
  }
  return typeof o.type === 'string' ? o.type : undefined;
}

/** Reference.display: a name of unknown kind is still a person-like identifier -> PERSON. */
export function referenceDisplay(ctx: RulesContext, o: Obj, display: string): string {
  if (!display.trim()) return display;
  const category = REF_CATEGORY[refTypeOf(o) ?? ''] ?? 'PERSON';
  return tokenize(ctx, category, display);
}

/** Scalar members whose whole value is an identifier of a fixed category. */
export const KEY_CATEGORY: Readonly<Record<string, PhiCategory>> = {
  authorString: 'PROVIDER',
  subscriberId: 'HEALTH_PLAN',
  serialNumber: 'DEVICE',
  deviceIdentifier: 'DEVICE',
  carrierHRF: 'DEVICE',
  carrierAIDC: 'DEVICE',
  lotNumber: 'DEVICE',
  alias: 'ORG',
};
