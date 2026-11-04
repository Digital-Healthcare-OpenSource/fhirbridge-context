/**
 * Layer 2 entry point: patient-scoped HIPAA Safe Harbor de-identification.
 *
 * Order of operations:
 *   1. identifying resource ids are pseudonymized and every reference rewritten;
 *   2. per patient a deterministic date shift is assigned and names / identifiers are registered
 *      so structured fields and free text share pseudonyms;
 *   3. a discovery pass finds names that appear only through cues ("wife Karen"), then the real
 *      pass rewrites every resource and decoded document into a NEW graph with those names known;
 *   4. integrity warnings are rebuilt from fixed templates.
 * Inputs are never mutated.
 *
 * Resources that belong to no patient (Practitioner, Organization, Medication...) get their
 * identifiers/names/text scrubbed always; their dates follow the sole patient's offset when the
 * graph holds exactly one patient, otherwise every date is generalized to its year.
 *
 * `freeText: 'omit'` removes every free-text member and every decoded document instead of
 * scrubbing them: only structured codes, values and (shifted) dates remain.
 */
import type { Identifier, Patient, Resource } from '../types/fhir.js';
import { resourceKey } from '../types/fhir.js';
import type {
  NormalizedGraph,
  NormalizedMedication,
  ResourceIndex,
  DeidResult,
  SafeHarborSummary,
} from '../types/pipeline.js';
import { scrubText } from './clinical-text-scrubber.js';
import { MAX_DOCUMENT_CHARS, TRUNCATION_MARKER, deidDocument } from './document-deid.js';
import { createKeyMapper, type KeyMapper } from './id-pseudonymizer.js';
import { buildKnownNames } from './known-names.js';
import {
  SAFE_HARBOR_RULE_NAMES,
  applyStructuredRules,
  newRuleStats,
} from './safe-harbor-rules.js';
import type { FreeTextMode, KnownName } from './scrub-types.js';
import { scrub, type RulesContext } from './structured-handlers.js';
import { canonicalName } from './vault-names.js';
import type { SafeHarborVault } from './vault.js';
import { sanitizeWarnings } from './warning-sanitizer.js';

export { SafeHarborVault } from './vault.js';
export { scrubText } from './clinical-text-scrubber.js';
export type { KnownName, ScrubContext, ScrubResult } from './clinical-text-scrubber.js';
export type { FreeTextMode } from './scrub-types.js';
export { shiftResourceDates } from './date-shifter.js';
export {
  SAFE_HARBOR_RULE_NAMES,
  applyStructuredRules,
  collectNameVariants,
} from './safe-harbor-rules.js';
export { MAX_DOCUMENT_CHARS, TRUNCATION_MARKER };

export interface DeidOptions {
  vault: SafeHarborVault;
  /** Reference "now" for the age > 89 rule. Defaults to the current time. */
  now?: Date;
  /** `scrub` (default) pseudonymizes free text; `omit` removes it and every decoded document. */
  freeText?: FreeTextMode;
}

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

function buildIndex(resources: Resource[], original: ResourceIndex, mapper: KeyMapper): ResourceIndex {
  const byKey = new Map<string, Resource>();
  for (const r of resources) byKey.set(resourceKey(r), r);
  const resolve = (reference: string, from?: Resource): Resource | undefined => {
    if (reference.startsWith('#')) {
      return from?.contained?.find((c) => c.id === reference.slice(1));
    }
    const m = /([A-Za-z]+)\/([^/]+?)(?:\/_history\/[^/]+)?$/.exec(reference);
    const direct = m ? byKey.get(mapper.mapKey(`${m[1]}/${m[2]}`)) : undefined;
    if (direct) return direct;
    const orig = original.resolve(reference);
    return orig ? byKey.get(mapper.mapKey(resourceKey(orig))) : undefined;
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

type Discovered = Map<string, Map<string, KnownName>>;

function remember(found: Discovered, owner: string | undefined, name: KnownName): void {
  const bucket = found.get(owner ?? '') ?? new Map<string, KnownName>();
  const key = `${name.category}|${canonicalName(name.variants.join(' '))}`;
  if (!bucket.has(key)) bucket.set(key, name);
  found.set(owner ?? '', bucket);
}

/** In `omit` mode a medication keeps only dictionary-derived labels, never free-text ones. */
function omitMedication(m: NormalizedMedication, c: RulesContext): NormalizedMedication {
  const concept = applyStructuredRules(m.concept as unknown as Resource, c) as unknown as NormalizedMedication['concept'];
  const label = concept.coding?.find((x) => typeof x.display === 'string' && x.display.trim())?.display;
  const display = scrub(c, label ?? m.ingredient ?? 'Medication');
  const dedupeKey = m.rxnorm ? `rx:${m.rxnorm}` : m.ingredient ? m.dedupeKey : `unknown:${display.toLowerCase()}`;
  return { ...m, display, dedupeKey, concept, ...(m.ingredient !== undefined ? { ingredient: scrub(c, m.ingredient) } : {}) };
}

function deidMedication(m: NormalizedMedication, c: RulesContext): NormalizedMedication {
  if (c.freeText === 'omit') return omitMedication(m, c);
  return {
    ...m,
    display: scrub(c, m.display),
    dedupeKey: scrub(c, m.dedupeKey),
    ...(m.ingredient !== undefined ? { ingredient: scrub(c, m.ingredient) } : {}),
    concept: applyStructuredRules(m.concept as unknown as Resource, c) as unknown as NormalizedMedication['concept'],
  };
}

export function deidentify(graph: NormalizedGraph, opts: DeidOptions): DeidResult {
  const { vault } = opts;
  const now = opts.now ?? new Date();
  const freeText: FreeTextMode = opts.freeText ?? 'scrub';

  /* 1. pseudonymize identifying resource ids + rewrite references */
  const mapper = createKeyMapper(graph.resources, vault);
  const source = graph.resources.map((r) => mapper.mapResource(r));
  const patientOf = new Map([...graph.patientOf].map(([k, v]) => [mapper.mapKey(k), mapper.mapKey(v)]));

  /* 2. patients, date shifts, known names + identifiers */
  const patients = source.filter((r): r is Patient => r.resourceType === 'Patient');
  const patientKeys = patients.map(resourceKey);
  const soleKey = patientKeys.length === 1 ? patientKeys[0] : undefined;
  graph.resources.forEach((orig, i) => {
    const mapped = source[i];
    if (orig.resourceType === 'Patient' && mapped) {
      vault.assignDateShift(resourceKey(mapped), canonicalPatientId(orig as Patient));
    }
  });
  const ownerOf = (r: Resource): string | undefined =>
    r.resourceType === 'Patient' ? resourceKey(r) : (patientOf.get(resourceKey(r)) ?? soleKey);
  const registry = buildKnownNames(source, ownerOf, resourceKey);

  /* 3. discovery pass (throwaway stats) then the real pass */
  const pass = (found: Discovered, sink: Discovered | undefined) => {
    const stats = newRuleStats();
    const lists = new Map<string, readonly KnownName[]>();
    const scopeFor = (owner: string | undefined): readonly KnownName[] => {
      const key = owner ?? '';
      let list = lists.get(key);
      if (!list) {
        const own = owner ? registry.byPatient.get(owner) : undefined;
        const base = own ? [...own, ...registry.global] : registry.everyone;
        const discovered = [...(found.get(key)?.values() ?? [])];
        const shared = owner ? [...(found.get('')?.values() ?? [])] : [];
        list = [...base, ...discovered, ...shared];
        lists.set(key, list);
      }
      return list;
    };
    const ctxFor = (owner: string | undefined): RulesContext => ({
      vault,
      patientKey: owner,
      now,
      dateShiftDays: owner ? vault.dateShiftDaysFor(owner) : undefined,
      knownNames: scopeFor(owner),
      otherNames: owner && registry.byPatient.has(owner) ? registry.others : undefined,
      freeText,
      stats,
      onDiscovered: sink ? (n: KnownName) => remember(sink, owner, n) : undefined,
    });
    const resources = source.map((r) => applyStructuredRules(r, ctxFor(ownerOf(r))));
    const documents =
      freeText === 'omit'
        ? []
        : graph.documents.map((d) => {
            const owner = patientOf.get(mapper.mapKey(d.resourceKey)) ?? soleKey;
            const c = ctxFor(owner);
            const sctx = {
              vault,
              patientKey: owner,
              now,
              knownNames: c.knownNames,
              otherNames: c.otherNames,
              onDiscovered: c.onDiscovered,
            };
            return deidDocument(d, mapper, sctx, c.dateShiftDays, stats);
          });
    const medications = new Map<string, NormalizedMedication>(
      [...graph.medications].map(([key, m]) => {
        const mappedKey = mapper.mapKey(key);
        return [mappedKey, deidMedication(m, ctxFor(patientOf.get(mappedKey) ?? soleKey))];
      }),
    );
    return { resources, documents, medications, stats };
  };

  const discovered: Discovered = new Map();
  pass(new Map(), discovered);
  const final = pass(discovered, undefined);

  const warnings = sanitizeWarnings(graph.warnings, {
    mapKey: mapper.mapKey,
    scrub: (text) =>
      scrubText(text, {
        vault,
        patientKey: soleKey,
        now,
        knownNames: registry.everyone,
        dateShiftDays: soleKey ? vault.dateShiftDaysFor(soleKey) : undefined,
      }).text,
  });

  const summary: SafeHarborSummary = {
    enabled: true,
    replacements: final.stats.replacements,
    datesShifted: final.stats.datesShifted,
    patientsShifted: patientKeys.filter((k) => vault.dateShiftDaysFor(k) !== undefined).length,
    agesCapped: final.stats.agesCapped,
    zip3Restricted: final.stats.zip3Restricted,
    zip3Generalized: final.stats.zip3Generalized,
    rulesApplied: [...SAFE_HARBOR_RULE_NAMES],
  };

  return {
    graph: {
      resources: final.resources,
      index: buildIndex(final.resources, graph.index, mapper),
      status: mapper.remapKeyed(graph.status),
      patientOf,
      members: new Map([...graph.members].map(([k, v]) => [mapper.mapKey(k), v.map(mapper.mapKey)])),
      medications: final.medications,
      documents: final.documents,
      warnings,
      excluded: graph.excluded.map(mapper.mapKey),
      idMap: mapper.mapIdMap(graph.idMap),
      stats: { ...graph.stats },
    },
    summary,
  };
}
