/**
 * Layer 2 entry point: patient-scoped HIPAA Safe Harbor de-identification.
 *
 * Per patient: a deterministic date shift is assigned, names are registered so structured
 * fields and free text share the same pseudonyms, then every resource and decoded document
 * is rewritten into a NEW graph. Inputs are never mutated.
 *
 * Resources that belong to no patient (Practitioner, Organization, Medication...) get their
 * identifiers/names/text scrubbed always; their dates are shifted only when the graph holds
 * exactly one patient (that patient's offset is used). In a multi-patient graph their dates
 * stay as-is, except `birthDate`, which is reduced to its year.
 */
import { isFhirDate } from '../shared/fhir-date.js';
import type { Identifier, Patient, Resource } from '../types/fhir.js';
import { resourceKey } from '../types/fhir.js';
import type {
  DecodedDocument,
  DeidResult,
  NormalizedGraph,
  ResourceIndex,
  SafeHarborSummary,
} from '../types/pipeline.js';
import { scrubText, type KnownName } from './clinical-text-scrubber.js';
import { shiftResourceDates } from './date-shifter.js';
import {
  SAFE_HARBOR_RULE_NAMES,
  applyStructuredRules,
  collectNameVariants,
  newRuleStats,
  type RuleStats,
} from './safe-harbor-rules.js';
import type { SafeHarborVault } from './vault.js';

export { SafeHarborVault } from './vault.js';
export { scrubText } from './clinical-text-scrubber.js';
export type { KnownName, ScrubContext, ScrubResult } from './clinical-text-scrubber.js';
export { shiftResourceDates } from './date-shifter.js';
export {
  SAFE_HARBOR_RULE_NAMES,
  applyStructuredRules,
  collectNameVariants,
} from './safe-harbor-rules.js';

export interface DeidOptions {
  vault: SafeHarborVault;
  /** Reference "now" for the age > 89 rule. Defaults to the current time. */
  now?: Date;
}

const MAX_CHUNK = 4000;

/** Patient MRN identifier value if present, else Patient.id. */
export function canonicalPatientId(p: Patient): string {
  const ids = (p.identifier ?? []) as Identifier[];
  const mrn = ids.find(
    (i) =>
      i.value &&
      (i.type?.coding?.some((c) => c.code === 'MR') || (i.system ?? '').toLowerCase().includes('mrn')),
  );
  return mrn?.value ?? p.id ?? resourceKey(p);
}

function buildIndex(resources: Resource[], original: ResourceIndex): ResourceIndex {
  const byKey = new Map<string, Resource>();
  for (const r of resources) byKey.set(resourceKey(r), r);
  const resolve = (reference: string, from?: Resource): Resource | undefined => {
    if (reference.startsWith('#')) {
      return from?.contained?.find((c) => c.id === reference.slice(1));
    }
    const m = /([A-Za-z]+)\/([^/]+?)(?:\/_history\/[^/]+)?$/.exec(reference);
    const direct = m ? byKey.get(`${m[1]}/${m[2]}`) : undefined;
    if (direct) return direct;
    const orig = original.resolve(reference);
    return orig ? byKey.get(resourceKey(orig)) : undefined;
  };
  return {
    resolve,
    get: (key) => byKey.get(key),
    has: (key) => byKey.has(key),
    all: () => [...byKey.values()],
    byType: <T extends Resource = Resource>(t: string) =>
      [...byKey.values()].filter((r) => r.resourceType === t) as T[],
  };
}

interface Scope {
  known: readonly KnownName[];
}

function deidDocument(
  doc: DecodedDocument,
  owner: string | undefined,
  scope: Scope,
  vault: SafeHarborVault,
  now: Date,
  stats: RuleStats,
): DecodedDocument {
  const dateShiftDays = owner ? vault.dateShiftDaysFor(owner) : undefined;
  const run = (text: string): string => {
    const r = scrubText(text, { vault, patientKey: owner, now, knownNames: scope.known, dateShiftDays });
    for (const [k, n] of Object.entries(r.counts)) {
      const c = k as keyof RuleStats['replacements'];
      stats.replacements[c] = (stats.replacements[c] ?? 0) + (n ?? 0);
    }
    stats.datesShifted += r.datesShifted;
    stats.zip3Restricted += r.zip3Restricted;
    stats.zip3Generalized += r.zip3Generalized;
    return r.text;
  };
  const joined = doc.chunks.join('');
  // Chunks are hard slices of the full text: scrub it whole so names are not split across chunks.
  if (doc.chunks.length > 0 && joined.startsWith(doc.text)) {
    const clean = run(joined);
    const chunks: string[] = [];
    for (let i = 0; i < clean.length; i += MAX_CHUNK) chunks.push(clean.slice(i, i + MAX_CHUNK));
    return { ...doc, text: clean.slice(0, MAX_CHUNK), chunks };
  }
  return { ...doc, text: run(doc.text), chunks: doc.chunks.map(run) };
}

export function deidentify(graph: NormalizedGraph, opts: DeidOptions): DeidResult {
  const { vault } = opts;
  const now = opts.now ?? new Date();
  const stats = newRuleStats();
  let agesCapped = 0;

  const patients = graph.resources.filter((r): r is Patient => r.resourceType === 'Patient');
  const patientKeys = patients.map(resourceKey);
  const soleKey = patientKeys.length === 1 ? patientKeys[0] : undefined;
  for (const p of patients) vault.assignDateShift(resourceKey(p), canonicalPatientId(p));

  // Known-name registry: patient + related persons per patient, all practitioners globally.
  const named = (category: KnownName['category'], r: Resource): KnownName[] => {
    const variants = collectNameVariants(r.name as never);
    return variants.length > 0
      ? [{ category, variants, ...(category === 'PATIENT' ? { patientKey: resourceKey(r) } : {}) }]
      : [];
  };
  const practitioners = graph.resources
    .filter((r) => r.resourceType === 'Practitioner')
    .flatMap((r) => named('PROVIDER', r));
  const ownerOf = (r: Resource): string | undefined =>
    r.resourceType === 'Patient' ? resourceKey(r) : (graph.patientOf.get(resourceKey(r)) ?? soleKey);
  const perPatient = new Map<string, KnownName[]>();
  for (const key of patientKeys) {
    const own = patients.filter((p) => resourceKey(p) === key).flatMap((p) => named('PATIENT', p));
    const related = graph.resources
      .filter((r) => r.resourceType === 'RelatedPerson' && ownerOf(r) === key)
      .flatMap((r) => named('PERSON', r));
    perPatient.set(key, [...own, ...related, ...practitioners]);
  }
  const everyone: KnownName[] = [
    ...patients.flatMap((p) => named('PATIENT', p)),
    ...practitioners,
  ];
  const scopeFor = (owner: string | undefined): Scope => ({
    known: (owner ? perPatient.get(owner) : undefined) ?? everyone,
  });

  const resources = graph.resources.map((r) => {
    const owner = ownerOf(r);
    const days = owner ? vault.dateShiftDaysFor(owner) : undefined;
    const scrubbed = applyStructuredRules(r, {
      vault,
      patientKey: owner,
      now,
      dateShiftDays: days,
      knownNames: scopeFor(owner).known,
      stats,
    });
    if (days === undefined || !owner) return reduceBirthDate(scrubbed);
    const shifted = shiftResourceDates(scrubbed, days, {
      now,
      shiftTextDates: false,
      onShifted: (d) => vault.recordShiftedDate(owner, d),
    });
    stats.datesShifted += shifted.shifted;
    if (shifted.ageCapped) agesCapped += 1;
    return shifted.resource;
  });

  const documents = graph.documents.map((d) => {
    const owner = graph.patientOf.get(d.resourceKey) ?? soleKey;
    return deidDocument(d, owner, scopeFor(owner), vault, now, stats);
  });

  const dateShiftDays: Record<string, number> = {};
  for (const key of patientKeys) {
    const d = vault.dateShiftDaysFor(key);
    if (d !== undefined) dateShiftDays[key] = d;
  }

  const summary: SafeHarborSummary = {
    enabled: true,
    replacements: stats.replacements,
    datesShifted: stats.datesShifted,
    dateShiftDays,
    agesCapped,
    zip3Restricted: stats.zip3Restricted,
    zip3Generalized: stats.zip3Generalized,
    rulesApplied: [...SAFE_HARBOR_RULE_NAMES],
  };

  return {
    graph: {
      resources,
      index: buildIndex(resources, graph.index),
      status: new Map(graph.status),
      patientOf: new Map(graph.patientOf),
      members: new Map(graph.members),
      medications: new Map(graph.medications),
      documents,
      warnings: graph.warnings,
      excluded: [...graph.excluded],
      idMap: new Map(graph.idMap),
      stats: { ...graph.stats },
    },
    summary,
  };
}

/** Unscoped resource without a date shift: keep only the birth year. */
function reduceBirthDate<T extends Resource>(resource: T): T {
  const b = resource.birthDate;
  if (typeof b !== 'string' || !isFhirDate(b)) return resource;
  return { ...resource, birthDate: b.slice(0, 4) };
}
