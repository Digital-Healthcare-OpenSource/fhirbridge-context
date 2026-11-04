/**
 * Layer 1 entry point: load FHIR input, normalize it into a NormalizedGraph.
 *
 *   loadInput/parseInput → normalize → { resources, index, status, members, medications, … }
 */
import { createHash } from 'node:crypto';
import { estimateTokensFromBytes } from '../shared/token-estimate.js';
import { expandBundles, loadInput } from './input-loader.js';
import type { Resource } from '../types/fhir.js';
import { isResource, resourceKey } from '../types/fhir.js';
import type {
  DecodedDocument,
  InputEntry,
  IntegrityWarning,
  LoadedInput,
  NormalizedGraph,
} from '../types/pipeline.js';
import { prepareResource, shortenIds } from './attachment-decoder.js';
import { buildMedications, buildStatusGate } from './code-linter.js';
import {
  buildMembers,
  buildPatientOf,
  buildResourceIndex,
  resolveMedicationReferences,
} from './graph-resolver.js';

export { classifyStatus, lintMedicationCodes, normalizeMedicationConcept } from './code-linter.js';
export { buildResourceIndex, resolveMedicationReferences } from './graph-resolver.js';
export { decodeAttachments, prepareResource, shortenIds, stripMarkup, stripRtf } from './attachment-decoder.js';

export { expandBundles, loadInput, parseInput } from './input-loader.js';
export type { LoadedInputWithWarnings, ParsedInput } from './input-loader.js';

/* ------------------------------ normalize ------------------------------ */

export interface NormalizeOptions {
  inputBytes?: number;
  rawText?: string;
  /** Warnings produced while loading (e.g. invalid NDJSON lines). */
  warnings?: IntegrityWarning[];
}

/** Resources without an id get a stable one (from a urn:uuid fullUrl, else a content hash). */
function withId(entry: InputEntry): InputEntry {
  if (entry.resource.id) return entry;
  const uuid = /^urn:uuid:(.+)$/i.exec(entry.fullUrl ?? '')?.[1];
  const id = uuid ?? `gen-${createHash('sha256').update(JSON.stringify(entry.resource)).digest('hex').slice(0, 16)}`;
  return { ...entry, resource: { ...entry.resource, id } };
}

function lastUpdatedOf(resource: Resource): string {
  return resource.meta?.lastUpdated ?? '';
}

/** Keep one resource per `Type/id`; the newer `meta.lastUpdated` wins, ties keep the first. */
function dedupe(entries: readonly InputEntry[]): { entries: InputEntry[]; warnings: IntegrityWarning[] } {
  const kept = new Map<string, InputEntry>();
  const warnings: IntegrityWarning[] = [];
  for (const entry of entries) {
    const key = resourceKey(entry.resource);
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, entry);
      continue;
    }
    const replaced = lastUpdatedOf(entry.resource) > lastUpdatedOf(existing.resource);
    if (replaced) kept.set(key, entry);
    warnings.push({
      code: 'DUPLICATE_RESOURCE',
      resourceKey: key,
      message: `duplicate ${key}; kept the ${replaced ? 'newer' : 'first'} copy`,
      details: { replaced },
    });
  }
  return { entries: [...kept.values()], warnings };
}

/**
 * Normalize input entries. Never mutates `entries`: everything is deep-cloned first.
 */
export function normalize(entries: InputEntry[], opts: NormalizeOptions = {}): NormalizedGraph {
  const warnings: IntegrityWarning[] = [...(opts.warnings ?? [])];
  const cloned = expandBundles(
    entries.filter((e) => isResource(e?.resource)).map((e) => structuredClone(e)),
  ).map(withId);
  const deduped = dedupe(cloned);
  const shortened = shortenIds(deduped.entries);
  warnings.push(...deduped.warnings, ...shortened.warnings);

  const documents: DecodedDocument[] = [];
  const prepared: InputEntry[] = shortened.entries.map((entry) => {
    const p = prepareResource(entry.resource);
    documents.push(...p.documents);
    warnings.push(...p.warnings);
    return { ...entry, resource: p.resource };
  });

  const firstIndex = buildResourceIndex(prepared);
  const resolution = resolveMedicationReferences(prepared.map((e) => e.resource), firstIndex);
  warnings.push(...resolution.warnings);
  const finalEntries = prepared.map((e, i) => ({ ...e, resource: resolution.resources[i] ?? e.resource }));
  const index = buildResourceIndex(finalEntries);
  const resources = index.all();

  const gate = buildStatusGate(resources);
  const meds = buildMedications(resources);
  const members = buildMembers(resources, index);
  warnings.push(...gate.warnings, ...meds.warnings, ...members.warnings);

  const inputBytes = resolveInputBytes(opts, entries);
  return {
    resources,
    index,
    status: gate.status,
    patientOf: buildPatientOf(resources, index),
    members: members.members,
    medications: meds.medications,
    documents,
    warnings,
    excluded: gate.excluded,
    idMap: shortened.idMap,
    stats: {
      inputResources: cloned.length,
      inputBytes,
      inputTokens: estimateTokensFromBytes(inputBytes),
    },
  };
}

/**
 * Byte size of the original input for the "before" token estimate: the loader's byte count,
 * else the caller's raw text, else the serialized entries (SDK callers passing objects).
 */
function resolveInputBytes(opts: NormalizeOptions, entries: readonly InputEntry[]): number {
  if (opts.inputBytes !== undefined) return opts.inputBytes;
  if (opts.rawText !== undefined) return Buffer.byteLength(opts.rawText, 'utf8');
  return Buffer.byteLength(JSON.stringify(entries.map((e) => e.resource)), 'utf8');
}

export async function normalizeFile(path: string): Promise<NormalizedGraph> {
  const loaded = await loadInput(path);
  return normalize(loaded.entries, { inputBytes: loaded.bytes, warnings: loaded.warnings });
}
