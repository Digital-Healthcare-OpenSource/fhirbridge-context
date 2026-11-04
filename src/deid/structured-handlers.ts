/** Per-datatype Safe Harbor handlers used by the structured walker (safe-harbor-rules.ts). */
import { generalizeZip } from '../dictionaries/hipaa-zip3.js';
import type { PhiCategory } from '../types/pipeline.js';
import { collectNameVariants, isHumanName } from './name-collect.js';
import { scrubText } from './clinical-text-scrubber.js';
import type { KnownName, NameCategory, ScrubContext } from './scrub-types.js';
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

/** HumanName / HumanName[] -> one pseudonymous name (undefined when nothing usable remains). */
export function humanNames(ctx: RulesContext, v: unknown, category: NameCategory): unknown {
  const items = (Array.isArray(v) ? v : [v]).filter(isObj);
  const variants = collectNameVariants(items as never);
  if (variants.every((x) => canonicalName(x).length === 0)) return Array.isArray(v) ? [] : undefined;
  bump(ctx, category);
  const token = ctx.vault.registerName(category, variants, { patientKey: ctx.patientKey });
  const use = items[0]?.use;
  const one = { ...(typeof use === 'string' ? { use } : {}), text: token, family: token };
  return Array.isArray(v) ? [one] : one;
}

export const looksLikeHumanNames = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 && v.every(isHumanName) : isHumanName(v);

export function contactPointValue(ctx: RulesContext, cp: Obj): unknown {
  if (typeof cp.value !== 'string' || !cp.value) return cp.value;
  const sys = typeof cp.system === 'string' ? cp.system : '';
  let category: PhiCategory = 'PHONE';
  if (sys === 'fax') category = 'FAX';
  else if (sys === 'email' || (sys !== 'phone' && cp.value.includes('@'))) category = 'EMAIL';
  else if (sys === 'url') category = 'URL';
  return tokenize(ctx, category, cp.value);
}

/** Overrides for Address members; every other member goes through the generic walker. */
export function addressOverride(ctx: RulesContext, key: string, v: unknown): unknown {
  if (key === 'text' && typeof v === 'string') return tokenize(ctx, 'ADDRESS', v);
  if (key === 'line' && Array.isArray(v)) {
    return v.map((l) => (typeof l === 'string' && l.trim() ? tokenize(ctx, 'ADDRESS', l) : l));
  }
  if ((key === 'city' || key === 'district') && typeof v === 'string' && v.trim()) {
    return tokenize(ctx, 'ADDRESS', v);
  }
  if (key === 'postalCode' && typeof v === 'string') {
    const z = generalizeZip(v);
    if (z.restricted) ctx.stats.zip3Restricted += 1;
    else ctx.stats.zip3Generalized += 1;
    return z.value;
  }
  return undefined;
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
  lotNumber: 'DEVICE',
  alias: 'ORG',
};
