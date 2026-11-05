/**
 * Clinical status gate, medication normalization (brand → ingredient) and RxNorm code/display linter.
 */
import type { CodeableConcept, Coding, Resource } from '../types/fhir.js';
import { resourceKey } from '../types/fhir.js';
import type { IntegrityWarning, NormalizedMedication, StatusClass } from '../types/pipeline.js';
import {
  KNOWN_CODE_DISPLAY_CONFLICTS,
  RXNORM_SYSTEM,
  findIngredient,
  ingredientRxcui,
  productRxcui,
  textNamesIngredient,
} from '../dictionaries/rxnorm-core.js';
import { MEDICATION_USAGE_TYPES } from './graph-resolver.js';

/* ------------------------------ status gate ------------------------------ */

const EXCLUDED_VERIFICATION: ReadonlySet<string> = new Set(['entered-in-error', 'refuted']);

const MED_ACTIVE: ReadonlySet<string> = new Set(['active', 'intended', 'in-progress', 'preparation']);
// `on-hold` is deliberately historical: a held medication is not currently being taken.
const MED_HISTORICAL: ReadonlySet<string> = new Set([
  'on-hold', 'completed', 'stopped', 'cancelled', 'not-taken', 'declined', 'ended', 'inactive',
]);

const PROBLEM_ACTIVE: ReadonlySet<string> = new Set(['active', 'recurrence', 'relapse']);
const PROBLEM_HISTORICAL: ReadonlySet<string> = new Set(['inactive', 'remission', 'resolved']);

const RESULT_ACTIVE: ReadonlySet<string> = new Set([
  'final', 'amended', 'corrected', 'preliminary', 'registered',
]);

const GENERIC_ACTIVE: ReadonlySet<string> = new Set([
  'active', 'completed', 'final', 'amended', 'corrected', 'confirmed', 'in-progress',
  'finished', 'current', 'accepted', 'booked', 'arrived', 'planned', 'preliminary', 'registered',
]);
const GENERIC_HISTORICAL: ReadonlySet<string> = new Set([
  'stopped', 'cancelled', 'inactive', 'resolved', 'ended', 'revoked', 'expired', 'superseded', 'not-done',
]);

/** First code found in a CodeableConcept (any coding), lowercased. */
function conceptCodes(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const coding = (value as CodeableConcept).coding;
  if (!Array.isArray(coding)) return [];
  return coding.map((c) => c?.code?.toLowerCase()).filter((c): c is string => !!c);
}

function lookup(code: string | undefined, active: ReadonlySet<string>, historical: ReadonlySet<string>): StatusClass {
  if (!code) return 'unknown';
  if (active.has(code)) return 'active';
  if (historical.has(code)) return 'historical';
  return 'unknown';
}

function statusString(resource: Resource): string | undefined {
  const status = resource['status'];
  return typeof status === 'string' ? status.toLowerCase() : undefined;
}

export function classifyStatus(resource: Resource): StatusClass {
  const status = statusString(resource);
  if (status === 'entered-in-error') return 'excluded';
  if (conceptCodes(resource['verificationStatus']).some((c) => EXCLUDED_VERIFICATION.has(c))) {
    return 'excluded';
  }

  const type = resource.resourceType;
  if (MEDICATION_USAGE_TYPES.has(type)) return lookup(status, MED_ACTIVE, MED_HISTORICAL);
  if (type === 'Condition' || type === 'AllergyIntolerance') {
    const [code] = conceptCodes(resource['clinicalStatus']);
    return lookup(code, PROBLEM_ACTIVE, PROBLEM_HISTORICAL);
  }
  if (type === 'Observation' || type === 'DiagnosticReport') {
    return lookup(status, RESULT_ACTIVE, new Set(['cancelled']));
  }
  if (type === 'Patient' && resource['active'] === false) return 'historical';
  return lookup(status, GENERIC_ACTIVE, GENERIC_HISTORICAL);
}

export interface StatusGate {
  status: Map<string, StatusClass>;
  excluded: string[];
  warnings: IntegrityWarning[];
}

export function buildStatusGate(resources: readonly Resource[]): StatusGate {
  const status = new Map<string, StatusClass>();
  const excluded: string[] = [];
  const warnings: IntegrityWarning[] = [];
  for (const resource of resources) {
    const key = resourceKey(resource);
    const cls = classifyStatus(resource);
    status.set(key, cls);
    if (cls !== 'excluded') continue;
    excluded.push(key);
    warnings.push({
      code: 'EXCLUDED_ENTERED_IN_ERROR',
      resourceKey: key,
      message: `${key} is entered-in-error/refuted and is excluded from the clinical context`,
    });
  }
  return { status, excluded, warnings };
}

/* ------------------------------ RxNorm linter ------------------------------ */

const isRxNorm = (coding: Coding): boolean => (coding.system ?? '').toLowerCase().includes('rxnorm');

function medicationConcept(resource: Resource): CodeableConcept | undefined {
  const concept = resource['medicationCodeableConcept'];
  return typeof concept === 'object' && concept !== null ? (concept as CodeableConcept) : undefined;
}

function conceptStrings(concept: CodeableConcept): string[] {
  return [...(concept.coding ?? []).map((c) => c.display), concept.text].filter(
    (s): s is string => typeof s === 'string' && s.trim() !== '',
  );
}

/** Detect RxCUIs whose label names a different drug than the code denotes. */
export function lintMedicationCodes(resource: Resource): IntegrityWarning[] {
  const concept = medicationConcept(resource);
  if (!concept) return [];
  const warnings: IntegrityWarning[] = [];
  const labels = conceptStrings(concept);
  for (const coding of concept.coding ?? []) {
    const code = coding.code;
    const expected = code ? KNOWN_CODE_DISPLAY_CONFLICTS[code] : undefined;
    if (!code || !expected || !isRxNorm(coding)) continue;
    const display = coding.display ?? concept.text ?? labels[0];
    if (!display || labels.some((l) => textNamesIngredient(l, expected))) continue;
    warnings.push({
      code: 'CODE_DISPLAY_MISMATCH',
      resourceKey: resourceKey(resource),
      message: `display "${display}" conflicts with RxCUI ${code} ("${expected}")`,
      details: { code, display, expected },
    });
  }
  return warnings;
}

/* ------------------------------ medication normalization ------------------------------ */

// Starts only at the beginning of a number (lookbehind) with bounded digit and space runs, so a
// long run of digits or spaces without a unit cannot be re-scanned from every position.
const STRENGTH_RE =
  /(?<![\d.])(\d{1,7}(?:\.\d{1,4})?)[ \t]{0,3}(mg|mcg|ug|g|ml|unit|units|iu|meq|%)(?:[ \t]{0,3}\/[ \t]{0,3}(\d{1,7}(?:\.\d{1,4})?[ \t]{0,3})?(ml|hr|h|actuat))?/i;

function parseStrength(text: string): string | undefined {
  const m = STRENGTH_RE.exec(text);
  return m ? m[0].replace(/\s+/g, ' ').toUpperCase() : undefined;
}

function isConflicting(coding: Coding, labels: readonly string[]): boolean {
  const expected = coding.code ? KNOWN_CODE_DISPLAY_CONFLICTS[coding.code] : undefined;
  if (!expected || !isRxNorm(coding)) return false;
  return labels.length > 0 && !labels.some((l) => textNamesIngredient(l, expected));
}

function replaceBrand(text: string, brand: string, ingredient: string): string {
  return text.replace(new RegExp(`\\b${brand}\\b`, 'i'), ingredient);
}

/** Resolve identity, ingredient and dedupe key for one medication concept. */
export function normalizeMedicationConcept(concept: CodeableConcept): NormalizedMedication | undefined {
  const labels = conceptStrings(concept);
  const primary = concept.text?.trim() || labels[0];
  if (!primary) return undefined;

  const codings = concept.coding ?? [];
  const trusted = codings.filter((c) => !isConflicting(c, labels));
  const rxCoding = trusted.find((c) => isRxNorm(c) && c.code);
  const match = findIngredient(labels.join(' '));
  const strength = parseStrength(labels.join(' '));

  if (!match) {
    const rxnorm = rxCoding?.code;
    return {
      display: primary,
      rxnorm,
      dedupeKey: rxnorm ? `rx:${rxnorm}` : primary.toLowerCase().replace(/\s+/g, ' '),
      concept: { ...concept, coding: trusted.length > 0 ? trusted : undefined },
    };
  }

  const { ingredient, brand } = match;
  const rxnorm =
    productRxcui(ingredient, strength?.toLowerCase()) ?? rxCoding?.code ?? ingredientRxcui(ingredient);
  const base = brand ? replaceBrand(primary, brand, ingredient) : primary;
  const display = brand && rxnorm ? `${base} [RxNorm: ${rxnorm}]` : base;
  const others = trusted.filter((c) => !isRxNorm(c));
  const rxEntry: Coding[] = rxnorm ? [{ system: RXNORM_SYSTEM, code: rxnorm, display: base }] : [];
  return {
    display,
    rxnorm,
    ingredient,
    dedupeKey: `${ingredient.toLowerCase()}|${(strength ?? '').toLowerCase()}`,
    concept: { coding: [...rxEntry, ...others], text: base },
  };
}

export interface MedicationNormalization {
  medications: Map<string, NormalizedMedication>;
  warnings: IntegrityWarning[];
}

/** Normalize + lint every medication usage resource (references must already be resolved). */
export function buildMedications(resources: readonly Resource[]): MedicationNormalization {
  const medications = new Map<string, NormalizedMedication>();
  const warnings: IntegrityWarning[] = [];
  for (const resource of resources) {
    if (!MEDICATION_USAGE_TYPES.has(resource.resourceType)) continue;
    const concept = medicationConcept(resource);
    if (!concept) continue;
    warnings.push(...lintMedicationCodes(resource));
    const normalized = normalizeMedicationConcept(concept);
    if (normalized) medications.set(resourceKey(resource), normalized);
  }
  return { medications, warnings };
}
