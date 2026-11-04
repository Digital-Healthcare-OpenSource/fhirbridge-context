import type { Resource } from '../types/fhir.js';
import { resourceKey } from '../types/fhir.js';
import type { NormalizedGraph, SafeHarborSummary, ViewRow, ViewTables } from '../types/pipeline.js';
import { ageInYears } from '../shared/fhir-date.js';
import { medInfo } from './sections/medications.js';
import {
  ageAtDeidentification,
  findCoding,
  hideBinaryMarkers,
  inScope,
  rec,
  str,
  visibleBirthDate,
  type Rec,
  type SectionCtx,
} from './sections/util.js';

/* ------------------------------------------------------------------ */
/* Key helpers                                                         */
/* ------------------------------------------------------------------ */

const TYPE_ID_TAIL_RE = /(?:^|\/)([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/;

/** Canonical `ResourceType/id` of a resource. */
export function getResourceKey(resource: Pick<Resource, 'resourceType' | 'id'>): string {
  return resourceKey(resource);
}

/** Resolve a Reference (or reference string) to `ResourceType/id`; null when it cannot be resolved. */
export function getReferenceKey(ref: unknown, graph?: NormalizedGraph, from?: Resource): string | null {
  const reference = typeof ref === 'string' ? ref : str(rec(ref)?.reference);
  if (!reference) return null;
  const resolved = graph?.index.resolve(reference, from);
  if (resolved?.id) return getResourceKey(resolved);
  const tail = TYPE_ID_TAIL_RE.exec(reference);
  return tail ? `${tail[1]}/${tail[2]}` : null;
}

/* ------------------------------------------------------------------ */
/* Tiny declarative ViewDefinition interpreter                         */
/* ------------------------------------------------------------------ */

export interface ViewColumn {
  name: string;
  /** Dotted path (`code.coding.0.code`), a function call, or `a | b` (first non-null wins). */
  path: string;
}

/** Without `in` the clause requires a non-null value. */
export interface ViewWhere {
  path: string;
  in?: readonly string[];
}

export interface ViewDefinition {
  name: string;
  resource: string | readonly string[];
  select: { column: ViewColumn[] }[];
  where?: ViewWhere[];
}

type Scalar = string | number | boolean | null;

interface EvalCtx {
  graph: NormalizedGraph;
  resource: Resource;
  now: Date;
  deidentified: boolean;
}

function step(values: unknown[], segment: string): unknown[] {
  return values.flatMap((v) => {
    if (Array.isArray(v)) return /^\d+$/.test(segment) ? [v[Number(segment)]] : step(v, segment);
    const r = rec(v);
    return r && r[segment] !== undefined ? [r[segment]] : [];
  });
}

function firstValue(resource: unknown, path: string): unknown {
  const values = path.split('.').reduce<unknown[]>((acc, seg) => step(acc, seg), [resource]);
  const first = values.flatMap((v) => (Array.isArray(v) ? v : [v]))[0];
  return first ?? null;
}

function scalar(value: unknown): Scalar {
  if (typeof value === 'string') return hideBinaryMarkers(value);
  return typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

function callFunction(name: string, arg: string, ec: EvalCtx): Scalar {
  const r = ec.resource as Rec;
  const sectionCtx: SectionCtx = { graph: ec.graph, now: ec.now };
  const key = getResourceKey(ec.resource);
  switch (name) {
    case 'getResourceKey':
      return key;
    case 'getReferenceKey':
      return getReferenceKey(firstValue(r, arg), ec.graph, ec.resource);
    case 'getStatusClass':
      return ec.graph.status.get(key) ?? 'unknown';
    case 'getMedication': {
      const info = medInfo(sectionCtx, ec.resource);
      return arg === 'rxnorm' ? (info.rxnorm ?? null) : arg === 'dedupeKey' ? info.dedupeKey : info.display;
    }
    case 'getCode': {
      const [path = '', system = ''] = arg.split(',').map((s) => s.trim());
      const concept = firstValue(r, path);
      return (system ? findCoding(concept, new RegExp(system, 'i')) : undefined)?.code ?? scalar(firstValue(concept, 'coding.0.code'));
    }
    case 'getAge': {
      const recorded = ageAtDeidentification(r);
      if (recorded !== undefined) return /^\d+$/.test(recorded) ? Number(recorded) : recorded;
      const birth = str(r.birthDate);
      // A de-identified record without the age extension has at most a year: no computed age.
      if (!birth || ec.deidentified) return null;
      return ageInYears(birth, ec.now) ?? null;
    }
    case 'getBirthDate':
      return visibleBirthDate(r, ec.deidentified) ?? null;
    default:
      return null;
  }
}

function evalExpr(expr: string, ec: EvalCtx): Scalar {
  for (const alternative of expr.split(/\s+\|\s+/)) {
    const fn = /^(\w+)\((.*)\)$/.exec(alternative.trim());
    const value = fn
      ? callFunction(fn[1] as string, (fn[2] ?? '').trim(), ec)
      : scalar(firstValue(ec.resource, alternative.trim()));
    if (value !== null && value !== '') return value;
  }
  return null;
}

function matchesWhere(where: ViewWhere[] | undefined, ec: EvalCtx): boolean {
  return (where ?? []).every((clause) => {
    const value = evalExpr(clause.path, ec);
    return clause.in ? value !== null && clause.in.includes(String(value)) : value !== null;
  });
}

export interface ViewOptions {
  patientKey?: string;
  now?: Date;
  /** Present when the graph was de-identified: full birth dates are then never emitted. */
  safeHarbor?: SafeHarborSummary;
}

/** Project every matching resource of the graph through a ViewDefinition. */
export function runViewDefinition(
  def: ViewDefinition,
  graph: NormalizedGraph,
  opts: ViewOptions = {},
): ViewRow[] {
  const types = typeof def.resource === 'string' ? [def.resource] : def.resource;
  const now = opts.now ?? new Date();
  const deidentified = opts.safeHarbor !== undefined;
  const scope: SectionCtx = { graph, patientKey: opts.patientKey, now, deidentified };
  const rows: ViewRow[] = [];
  for (const resource of graph.resources) {
    const key = getResourceKey(resource);
    if (!types.includes(resource.resourceType) || !inScope(scope, key)) continue;
    const ec: EvalCtx = { graph, resource, now, deidentified };
    if (!matchesWhere(def.where, ec)) continue;
    const row: ViewRow = {};
    for (const select of def.select) for (const col of select.column) row[col.name] = evalExpr(col.path, ec);
    row.subject_key ??= graph.patientOf.get(key) ?? null;
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* The four standard tables                                            */
/* ------------------------------------------------------------------ */

const keys = (subject: string): ViewColumn[] => [
  { name: 'resource_key', path: 'getResourceKey()' },
  { name: 'subject_key', path: subject },
];
const CURRENT = { path: 'getStatusClass()', in: ['active', 'unknown'] } as const;

export const VIEW_DEFINITIONS: Record<keyof ViewTables, ViewDefinition> = {
  patient_demographics: {
    name: 'patient_demographics',
    resource: 'Patient',
    select: [
      {
        column: [
          ...keys('getResourceKey()'),
          { name: 'name', path: 'name.0.text | name.0.family' },
          { name: 'gender', path: 'gender' },
          { name: 'birth_date', path: 'getBirthDate()' },
          { name: 'age', path: 'getAge()' },
          { name: 'postal_code', path: 'address.0.postalCode' },
          { name: 'mrn', path: 'identifier.0.value' },
        ],
      },
    ],
  },
  active_conditions: {
    name: 'active_conditions',
    resource: 'Condition',
    where: [CURRENT],
    select: [
      {
        column: [
          ...keys('getReferenceKey(subject)'),
          { name: 'code', path: 'getCode(code, snomed|icd)' },
          { name: 'display', path: 'code.text | code.coding.0.display' },
          { name: 'onset', path: 'onsetDateTime | onsetPeriod.start | recordedDate' },
          { name: 'status', path: 'getStatusClass()' },
        ],
      },
    ],
  },
  active_medications: {
    name: 'active_medications',
    resource: ['MedicationRequest', 'MedicationStatement'],
    where: [CURRENT],
    select: [
      {
        column: [
          ...keys('getReferenceKey(subject)'),
          { name: 'medication', path: 'getMedication(display)' },
          { name: 'rxnorm', path: 'getMedication(rxnorm)' },
          { name: 'dedupe_key', path: 'getMedication(dedupeKey)' },
          { name: 'dose', path: 'dosageInstruction.0.text | dosage.0.text' },
          { name: 'authored_on', path: 'authoredOn | effectiveDateTime | effectivePeriod.start | dateAsserted' },
          { name: 'status', path: 'status' },
        ],
      },
    ],
  },
  lab_observations: {
    name: 'lab_observations',
    resource: 'Observation',
    where: [CURRENT, { path: 'valueQuantity.value' }],
    select: [
      {
        column: [
          ...keys('getReferenceKey(subject)'),
          { name: 'loinc', path: 'getCode(code, loinc)' },
          { name: 'display', path: 'code.text | code.coding.0.display' },
          { name: 'value', path: 'valueQuantity.value' },
          { name: 'unit', path: 'valueQuantity.unit' },
          { name: 'effective', path: 'effectiveDateTime | effectivePeriod.start | issued' },
          { name: 'interpretation', path: 'interpretation.0.coding.0.code' },
        ],
      },
    ],
  },
};

const SORT_COLUMNS: Record<keyof ViewTables, string[]> = {
  patient_demographics: ['resource_key'],
  active_conditions: ['resource_key'],
  active_medications: ['dedupe_key', 'authored_on', 'resource_key'],
  lab_observations: ['loinc', 'effective', 'resource_key'],
};

function sortRows(rows: ViewRow[], columns: string[]): ViewRow[] {
  const text = (v: Scalar | undefined): string => (v === null || v === undefined ? '' : String(v));
  return [...rows].sort((a, b) => {
    for (const col of columns) {
      const x = text(a[col]);
      const y = text(b[col]);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
}

/** Compile the four SQL-on-FHIR style tables; every row carries `resource_key` and `subject_key`. */
export function compileViews(
  graph: NormalizedGraph,
  opts: ViewOptions = {},
): ViewTables {
  const table = (name: keyof ViewTables): ViewRow[] =>
    sortRows(runViewDefinition(VIEW_DEFINITIONS[name], graph, opts), SORT_COLUMNS[name]);
  return {
    patient_demographics: table('patient_demographics'),
    active_conditions: table('active_conditions'),
    active_medications: table('active_medications'),
    lab_observations: table('lab_observations'),
  };
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

function csvField(value: Scalar | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 quoting (fields with comma, quote or newline are quoted; quotes doubled). */
export function toCsv(rows: ViewRow[]): string {
  if (rows.length === 0) return '';
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [columns.map(csvField).join(','), ...rows.map((r) => columns.map((c) => csvField(r[c])).join(','))];
  return lines.join('\n');
}
