/**
 * Reference graph: ResourceIndex, medication[x] resolution, panel membership, patient ownership.
 * All functions are pure; resources are returned as new objects when changed.
 */
import type { Reference, Resource } from '../types/fhir.js';
import { isResource, resourceKey } from '../types/fhir.js';
import type { InputEntry, IntegrityWarning, ResourceIndex } from '../types/pipeline.js';
import { parseReferenceTail } from '../shared/reference-tail.js';

export const ORIGINAL_MEDICATION_REFERENCE_URL =
  'https://fhirbridge.dev/fhir/StructureDefinition/original-medication-reference';

export const MEDICATION_USAGE_TYPES: ReadonlySet<string> = new Set([
  'MedicationRequest',
  'MedicationStatement',
  'MedicationDispense',
]);

function normalizeUrl(url: string): string {
  return url.toLowerCase().startsWith('urn:uuid:') ? url.toLowerCase() : url;
}

export function buildResourceIndex(entries: readonly InputEntry[]): ResourceIndex {
  const byKey = new Map<string, Resource>();
  const byUrl = new Map<string, Resource>();
  for (const { resource, fullUrl } of entries) {
    const key = resourceKey(resource);
    if (!byKey.has(key)) byKey.set(key, resource);
    if (fullUrl) byUrl.set(normalizeUrl(fullUrl), resource);
  }

  const resolve = (reference: string, from?: Resource): Resource | undefined => {
    if (!reference) return undefined;
    if (reference.startsWith('#')) {
      if (reference === '#') return from;
      const id = reference.slice(1);
      return from?.contained?.find((c) => c.id === id);
    }
    const direct = byKey.get(reference) ?? byUrl.get(normalizeUrl(reference));
    if (direct) return direct;
    const tail = parseReferenceTail(reference);
    return tail ? byKey.get(`${tail.type}/${tail.id}`) : undefined;
  };

  return {
    resolve,
    get: (key) => byKey.get(key),
    has: (key) => byKey.has(key),
    all: () => [...byKey.values()],
    byType: <T extends Resource = Resource>(resourceType: string): T[] =>
      [...byKey.values()].filter((r) => r.resourceType === resourceType) as T[],
  };
}

/** Rewrite one reference string whose `Type/id` appears in `idMap`; otherwise return it unchanged. */
export function rewriteReferenceString(reference: string, idMap: ReadonlyMap<string, string>): string {
  const tail = parseReferenceTail(reference);
  if (!tail) return reference;
  const replacement = idMap.get(`${tail.type}/${tail.id}`);
  if (!replacement) return reference;
  return `${tail.prefix}${tail.type}/${replacement}${tail.history}`;
}

/** Deep copy of `value` with every `reference` string rewritten through `idMap`. */
export function rewriteReferences<T>(value: T, idMap: ReadonlyMap<string, string>): T {
  return rewriteNode(value, idMap) as T;
}

function rewriteNode(node: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteNode(item, idMap));
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    out[key] =
      key === 'reference' && typeof child === 'string'
        ? rewriteReferenceString(child, idMap)
        : rewriteNode(child, idMap);
  }
  return out;
}

/* ------------------------------ medications ------------------------------ */

export interface MedicationResolution {
  resources: Resource[];
  warnings: IntegrityWarning[];
}

/**
 * Give every medication usage resource a `medicationCodeableConcept` copied from the referenced
 * Medication. The original reference is preserved in an extension, never silently dropped.
 */
export function resolveMedicationReferences(
  resources: readonly Resource[],
  index: ResourceIndex,
): MedicationResolution {
  const warnings: IntegrityWarning[] = [];
  const out = resources.map((resource) => {
    const resolved = resolveOne(resource, index, warnings);
    return resolved ?? resource;
  });
  return { resources: out, warnings };
}

function resolveOne(
  resource: Resource,
  index: ResourceIndex,
  warnings: IntegrityWarning[],
): Resource | undefined {
  if (!MEDICATION_USAGE_TYPES.has(resource.resourceType)) return undefined;
  if (resource['medicationCodeableConcept']) return undefined;
  const ref = resource['medicationReference'] as Reference | undefined;
  if (!ref?.reference) return undefined;

  const medication = index.resolve(ref.reference, resource);
  const code = medication?.['code'];
  if (!medication || typeof code !== 'object' || code === null) {
    warnings.push({
      code: 'UNRESOLVED_REFERENCE',
      resourceKey: resourceKey(resource),
      message: medication
        ? `medicationReference "${ref.reference}" resolves to a Medication without code`
        : `medicationReference "${ref.reference}" could not be resolved`,
      details: { reference: ref.reference, field: 'medicationReference' },
    });
    return undefined;
  }

  const { medicationReference: _dropped, ...rest } = resource;
  void _dropped;
  return {
    ...rest,
    medicationCodeableConcept: structuredClone(code),
    extension: [
      ...(resource.extension ?? []),
      { url: ORIGINAL_MEDICATION_REFERENCE_URL, valueReference: ref },
    ],
  };
}

/* ------------------------- members & patient ownership ------------------------- */

export interface MembersResult {
  members: Map<string, string[]>;
  warnings: IntegrityWarning[];
}

/** DiagnosticReport.result and Observation.hasMember → child Observation keys. */
export function buildMembers(resources: readonly Resource[], index: ResourceIndex): MembersResult {
  const members = new Map<string, string[]>();
  const warnings: IntegrityWarning[] = [];
  for (const resource of resources) {
    const field =
      resource.resourceType === 'DiagnosticReport'
        ? 'result'
        : resource.resourceType === 'Observation'
          ? 'hasMember'
          : undefined;
    if (!field) continue;
    const parentKey = resourceKey(resource);
    const children: string[] = [];
    for (const ref of asReferences(resource[field])) {
      const child = ref.reference ? index.resolve(ref.reference, resource) : undefined;
      if (child?.resourceType === 'Observation') {
        const childKey = resourceKey(child);
        if (!children.includes(childKey)) children.push(childKey);
      } else if (!child && ref.reference) {
        warnings.push({
          code: 'UNRESOLVED_REFERENCE',
          resourceKey: parentKey,
          message: `${field} reference "${ref.reference}" could not be resolved`,
          details: { reference: ref.reference, field },
        });
      }
    }
    if (children.length > 0) members.set(parentKey, children);
  }
  return { members, warnings };
}

const PATIENT_FIELDS = ['subject', 'patient', 'beneficiary'] as const;

/** `Type/id` → owning `Patient/id`. Resources without a patient link are omitted. */
export function buildPatientOf(
  resources: readonly Resource[],
  index: ResourceIndex,
): Map<string, string> {
  const patientOf = new Map<string, string>();
  for (const resource of resources) {
    const key = resourceKey(resource);
    if (resource.resourceType === 'Patient') {
      patientOf.set(key, key);
      continue;
    }
    const owner = findPatientKey(resource, index);
    if (owner) patientOf.set(key, owner);
  }
  return patientOf;
}

function findPatientKey(resource: Resource, index: ResourceIndex): string | undefined {
  for (const field of PATIENT_FIELDS) {
    const ref = asReferences(resource[field])[0]?.reference;
    if (!ref) continue;
    const target = index.resolve(ref, resource);
    if (target) {
      if (target.resourceType === 'Patient') return resourceKey(target);
      continue;
    }
    const tail = parseReferenceTail(ref);
    if (tail?.type === 'Patient') return `Patient/${tail.id}`;
  }
  return undefined;
}

function asReferences(value: unknown): Reference[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.filter(
    (item): item is Reference => typeof item === 'object' && item !== null && !isResource(item),
  );
}
