import type { Resource } from '../../src/types/fhir.js';
import type {
  DecodedDocument,
  IntegrityWarning,
  NormalizedGraph,
  NormalizedMedication,
  ResourceIndex,
  StatusClass,
  VaultReader,
} from '../../src/types/pipeline.js';
import { estimateTokens } from '../../src/shared/token-estimate.js';

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;

export const keyOf = (r: Resource): string => `${r.resourceType}/${r.id ?? ''}`;

function makeIndex(resources: Resource[]): ResourceIndex {
  const byKey = new Map(resources.map((r) => [keyOf(r), r]));
  const get = (key: string): Resource | undefined => byKey.get(key);
  return {
    get,
    has: (key) => byKey.has(key),
    all: () => [...byKey.values()],
    byType: <T extends Resource = Resource>(type: string): T[] =>
      [...byKey.values()].filter((r) => r.resourceType === type) as T[],
    resolve(reference) {
      const direct = get(reference);
      if (direct) return direct;
      const tail = /([A-Z][A-Za-z]+\/[A-Za-z0-9\-.]+)$/.exec(reference);
      return tail ? get(tail[1] as string) : undefined;
    },
  };
}

const HISTORICAL = new Set(['stopped', 'cancelled', 'completed', 'inactive', 'resolved', 'on-hold', 'ended']);

function classify(r: Resource): StatusClass {
  const clinical = (r.clinicalStatus as { coding?: { code?: string }[] } | undefined)?.coding?.[0]?.code;
  const status = typeof r.status === 'string' ? r.status : clinical;
  if (status === 'entered-in-error') return 'excluded';
  if (!status) return 'unknown';
  return HISTORICAL.has(status) ? 'historical' : 'active';
}

function subjectKey(r: Resource): string | undefined {
  if (r.resourceType === 'Patient') return keyOf(r);
  const ref = asRec(r.subject) ?? asRec(r.patient);
  return typeof ref?.reference === 'string' ? ref.reference : undefined;
}

function medicationFor(r: Resource, byKey: Map<string, Resource>): NormalizedMedication | undefined {
  if (!['MedicationRequest', 'MedicationStatement', 'MedicationDispense'].includes(r.resourceType)) return undefined;
  const refKey = asRec(r.medicationReference)?.reference;
  const med = typeof refKey === 'string' ? byKey.get(refKey) : undefined;
  const concept = (asRec(r.medicationCodeableConcept) ?? asRec(med?.code) ?? {}) as NormalizedMedication['concept'];
  const coding = concept.coding?.find((c) => /rxnorm/i.test(c.system ?? ''));
  const display = concept.text ?? coding?.display ?? concept.coding?.[0]?.display ?? '';
  if (!display) return undefined;
  const rxnorm = coding?.code;
  return { display, rxnorm, dedupeKey: rxnorm ? `rxnorm:${rxnorm}` : `name:${display.toLowerCase()}`, concept };
}

export interface GraphOptions {
  documents?: DecodedDocument[];
  warnings?: IntegrityWarning[];
  /** Force a status class for specific `Type/id` keys. */
  status?: Record<string, StatusClass>;
  inputTokens?: number;
}

/** Build a NormalizedGraph by hand (no dependency on the real normalizer). */
export function buildGraph(resources: Resource[], opts: GraphOptions = {}): NormalizedGraph {
  const byKey = new Map(resources.map((r) => [keyOf(r), r]));
  const status = new Map<string, StatusClass>();
  const patientOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  const medications = new Map<string, NormalizedMedication>();
  for (const r of resources) {
    const key = keyOf(r);
    status.set(key, opts.status?.[key] ?? classify(r));
    const owner = subjectKey(r);
    if (owner) patientOf.set(key, owner);
    const children = [...((r.hasMember as { reference?: string }[] | undefined) ?? []), ...((r.result as { reference?: string }[] | undefined) ?? [])]
      .map((m) => m.reference)
      .filter((m): m is string => typeof m === 'string');
    if (children.length > 0) members.set(key, children);
    const med = medicationFor(r, byKey);
    if (med) medications.set(key, med);
  }
  const bytes = JSON.stringify(resources);
  return {
    resources,
    index: makeIndex(resources),
    status,
    patientOf,
    members,
    medications,
    documents: opts.documents ?? [],
    warnings: opts.warnings ?? [],
    excluded: [...status.entries()].filter(([, s]) => s === 'excluded').map(([k]) => k),
    idMap: new Map(),
    stats: {
      inputResources: resources.length,
      inputBytes: Buffer.byteLength(bytes, 'utf8'),
      inputTokens: opts.inputTokens ?? estimateTokens(bytes),
    },
  };
}

export interface FakeVaultOptions {
  tokens?: Record<string, string>;
  /** `Patient/id` → day offset. */
  shifts?: Record<string, number>;
  /** `Patient/id` → exact shifted dates (YYYY-MM-DD) the de-identifier emitted. */
  emitted?: Record<string, string[]>;
  /** De-identified `Type/id` → original `Type/id` for pseudonymized resource ids. */
  originalKeys?: Record<string, string>;
}

export function fakeVault(opts: FakeVaultOptions = {}): VaultReader {
  const tokens = opts.tokens ?? {};
  const shifts = new Map(Object.entries(opts.shifts ?? {}));
  const emitted = opts.emitted ?? {};
  const originalKeys = opts.originalKeys ?? {};
  return {
    resolveToken: (t) => tokens[t],
    tokens: () => Object.keys(tokens),
    dateShiftDaysFor: (p) => shifts.get(p),
    dateShifts: () => shifts,
    shiftedDateWindow: () => undefined,
    patientKeys: () => [...shifts.keys()],
    emittedShiftedDates: (p) => new Set(emitted[p] ?? []),
    originalResourceKey: (k) => originalKeys[k],
  };
}

/* ------------------------- resource factories ------------------------- */

export const patient = (over: Rec = {}): Resource => ({
  resourceType: 'Patient',
  id: 'pat-1',
  name: [{ text: '[PATIENT_1]' }],
  gender: 'female',
  birthDate: '1962-03-14',
  address: [{ postalCode: '021XX' }],
  identifier: [{ value: '[MRN_1]' }],
  ...over,
});

export const medRequest = (id: string, over: Rec = {}): Resource => ({
  resourceType: 'MedicationRequest',
  id,
  status: 'active',
  subject: { reference: 'Patient/pat-1' },
  authoredOn: '2025-08-12',
  medicationCodeableConcept: {
    text: 'Metformin 500 MG Oral Tablet',
    coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '861007', display: 'Metformin 500 MG Oral Tablet' }],
  },
  dosageInstruction: [{ text: '1 tablet twice daily' }],
  ...over,
});

export const labObservation = (id: string, value: number, date: string, over: Rec = {}): Resource => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  subject: { reference: 'Patient/pat-1' },
  code: { text: 'HbA1c', coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' }] },
  effectiveDateTime: date,
  valueQuantity: { value, unit: '%' },
  referenceRange: [{ low: { value: 4 }, high: { value: 5.6 } }],
  ...over,
});
