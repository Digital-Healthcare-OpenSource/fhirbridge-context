import type { Resource } from '../../types/fhir.js';
import { resourceKey } from '../../types/fhir.js';
import type { NormalizedGraph, StatusClass } from '../../types/pipeline.js';

export type Rec = Record<string, unknown>;

/** Everything a section renderer needs. */
export interface SectionCtx {
  graph: NormalizedGraph;
  /** Restrict output to this `Patient/id` (undefined = whole graph). */
  patientKey?: string;
  now: Date;
  /** The graph was de-identified: a full birth date must never be rendered. */
  deidentified?: boolean;
}

/** Extension the de-identifier sets on Patient: `valueString` is an age (`'64'`) or `'90+'`. */
export const AGE_EXTENSION_URL = 'https://fhirbridge.dev/fhir/StructureDefinition/age-at-deidentification';

export function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** Array of records; a single record is wrapped, anything else yields []. */
export function recs(value: unknown): Rec[] {
  if (Array.isArray(value)) return value.map(rec).filter((r): r is Rec => r !== undefined);
  const single = rec(value);
  return single ? [single] : [];
}

export function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface CodingInfo {
  system?: string;
  code?: string;
  display?: string;
}

export function codings(concept: unknown): CodingInfo[] {
  return recs(rec(concept)?.coding).map((c) => ({
    system: str(c.system),
    code: str(c.code),
    display: str(c.display),
  }));
}

/** First coding whose system matches `systemPattern`. */
export function findCoding(concept: unknown, systemPattern: RegExp): CodingInfo | undefined {
  return codings(concept).find((c) => c.system !== undefined && systemPattern.test(c.system));
}

/** Human text of a CodeableConcept: text, else first coding display, else first code. */
export function conceptText(concept: unknown): string | undefined {
  const c = rec(concept);
  if (!c) return undefined;
  const list = codings(c);
  return str(c.text) ?? list.find((x) => x.display)?.display ?? list.find((x) => x.code)?.code;
}

/** First code of a (possibly array-valued) concept field, any system. */
export function firstConceptText(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(conceptText).find((t) => t !== undefined);
  return conceptText(value);
}

/** Age recorded by de-identification (`'64'` or `'90+'`), if present. */
export function ageAtDeidentification(patient: Rec): string | undefined {
  const ext = recs(patient.extension).find((e) => e.url === AGE_EXTENSION_URL);
  return str(ext?.valueString);
}

/**
 * Birth date as it may be shown: the 4-digit year when de-identified (anything longer is cut to
 * the year, defensively), the full value otherwise.
 */
export function visibleBirthDate(patient: Rec, deidentified: boolean | undefined): string | undefined {
  const birth = str(patient.birthDate);
  if (!birth) return undefined;
  if (!deidentified) return birth;
  return /^\d{4}/.test(birth) ? birth.slice(0, 4) : undefined;
}

export function keyOf(resource: Resource): string {
  return resourceKey(resource);
}

export function anchor(resource: Resource): string {
  return `[${resourceKey(resource)}]`;
}

/** `YYYY-MM-DD` prefix of a FHIR date/dateTime. */
export function dayOf(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, 10);
}

/** `[BINARY_ATTACHMENT: type, size, sha256:...]` markers written by the normalizer. */
export const BINARY_MARKER_RE = /\[BINARY_ATTACHMENT[^\]]*\]/;
export const BINARY_OMITTED = '[binary attachment omitted]';

/** Replace binary-attachment markers (which embed a payload hash) before text reaches a model. */
export function hideBinaryMarkers(value: string): string {
  return value.replace(new RegExp(BINARY_MARKER_RE.source, 'g'), BINARY_OMITTED);
}

export function oneLine(value: string, max: number): string {
  const flat = hideBinaryMarkers(value).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/**
 * Escape a value for a markdown table cell. Backslashes are escaped first: otherwise an input
 * ending in `\` before a `|` ("a\|b") would turn the added escape into a literal backslash and
 * let the pipe split the column.
 */
export function cell(value: string): string {
  return hideBinaryMarkers(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** Best clinical date of a resource (raw FHIR date string). */
export function resourceDate(resource: Resource): string | undefined {
  const r = resource as Rec;
  const direct = [
    'effectiveDateTime',
    'onsetDateTime',
    'performedDateTime',
    'authoredOn',
    'date',
  ]
    .map((f) => str(r[f]))
    .find((v) => v !== undefined);
  if (direct) return direct;
  const periods = ['effectivePeriod', 'performedPeriod', 'period', 'onsetPeriod']
    .map((f) => str(rec(r[f])?.start))
    .find((v) => v !== undefined);
  return periods ?? str(r.issued) ?? str(r.recordedDate) ?? str(r.dateAsserted);
}

/** Stable order: date ascending (undated first), then key. */
export function compareChronological(a: Resource, b: Resource): number {
  const da = resourceDate(a) ?? '';
  const db = resourceDate(b) ?? '';
  if (da !== db) return da < db ? -1 : 1;
  const ka = keyOf(a);
  const kb = keyOf(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function statusOf(ctx: SectionCtx, resource: Resource): StatusClass {
  return ctx.graph.status.get(keyOf(resource)) ?? 'unknown';
}

export function inScope(ctx: SectionCtx, key: string): boolean {
  return ctx.patientKey === undefined || ctx.graph.patientOf.get(key) === ctx.patientKey;
}

/** In-scope resources of a type with an allowed status class, chronologically sorted. */
export function ofType(
  ctx: SectionCtx,
  type: string,
  include: readonly StatusClass[] = ['active', 'historical', 'unknown'],
): Resource[] {
  return ctx.graph.resources
    .filter(
      (r) =>
        r.resourceType === type &&
        inScope(ctx, keyOf(r)) &&
        include.includes(statusOf(ctx, r)),
    )
    .sort(compareChronological);
}

/** Display name of a Reference: its display, else the resolved resource's name. */
export function referenceDisplay(ctx: SectionCtx, value: unknown): string | undefined {
  const ref = rec(Array.isArray(value) ? value[0] : value);
  if (!ref) return undefined;
  const direct = str(ref.display);
  if (direct) return direct;
  const reference = str(ref.reference);
  const target = reference ? ctx.graph.index.resolve(reference) : undefined;
  if (!target) return undefined;
  const name = recs(target.name)[0];
  if (name) {
    const parts = [...(Array.isArray(name.given) ? name.given : []), name.family].filter(
      (p): p is string => typeof p === 'string',
    );
    return str(name.text) ?? str(parts.join(' '));
  }
  return str(target.name) ?? conceptText(target.code);
}

/** Short label for a coding system URI. */
export function systemLabel(system: string | undefined): string {
  if (!system) return 'Code';
  const s = system.toLowerCase();
  if (s.includes('snomed')) return 'SNOMED';
  if (s.includes('icd-10') || s.includes('icd10')) return 'ICD-10';
  if (s.includes('icd-9') || s.includes('icd9')) return 'ICD-9';
  if (s.includes('loinc')) return 'LOINC';
  if (s.includes('rxnorm')) return 'RxNorm';
  const tail = system.split(/[/#:]/).filter(Boolean).pop();
  return tail ?? 'Code';
}

export function capitalize(value: string): string {
  return value === '' ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/** Text of a `note` array (Annotation[]) joined on one line. */
export function noteText(resource: Resource): string | undefined {
  const parts = recs((resource as Rec).note)
    .map((n) => str(n.text))
    .filter((t): t is string => t !== undefined);
  return parts.length > 0 ? parts.join(' ') : undefined;
}
