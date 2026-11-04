/**
 * Layer 1 entry point: load FHIR input, normalize it into a NormalizedGraph.
 *
 *   loadInput/parseInput → normalize → { resources, index, status, members, medications, … }
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { estimateTokens } from '../shared/token-estimate.js';
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

const MAX_BUNDLE_DEPTH = 8;
const LOADABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.ndjson']);

/* ------------------------------ parsing ------------------------------ */

export interface ParsedInput {
  entries: InputEntry[];
  source: LoadedInput['source'];
  /** Lines/elements that were not FHIR resources. */
  warnings: IntegrityWarning[];
}

function invalid(message: string): IntegrityWarning {
  return { code: 'INVALID_RESOURCE', resourceKey: '(input)', message };
}

/** Expand (possibly nested) Bundles into their entries. */
function expandBundles(entries: readonly InputEntry[], depth = 0): InputEntry[] {
  const out: InputEntry[] = [];
  for (const entry of entries) {
    if (entry.resource.resourceType !== 'Bundle') {
      out.push(entry);
    } else if (depth < MAX_BUNDLE_DEPTH) {
      out.push(...expandBundles(bundleEntries(entry.resource), depth + 1));
    }
  }
  return out;
}

function bundleEntries(bundle: Resource): InputEntry[] {
  const raw = bundle['entry'];
  if (!Array.isArray(raw)) return [];
  const entries: InputEntry[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { resource, fullUrl } = item as { resource?: unknown; fullUrl?: unknown };
    if (!isResource(resource)) continue;
    entries.push(typeof fullUrl === 'string' ? { resource, fullUrl } : { resource });
  }
  return entries;
}

function toEntries(values: readonly unknown[], warnings: IntegrityWarning[], label: string): InputEntry[] {
  const entries: InputEntry[] = [];
  values.forEach((value, i) => {
    if (isResource(value)) entries.push({ resource: value });
    else warnings.push(invalid(`${label} ${i + 1} is not a FHIR resource`));
  });
  return expandBundles(entries);
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Accept a Bundle, a JSON array of resources, a single resource or NDJSON. Throws on unusable input. */
export function parseInput(text: string): ParsedInput {
  const body = text.replace(/^﻿/, '').trim();
  if (!body) throw new Error('Input is empty');
  const warnings: IntegrityWarning[] = [];

  const whole = tryJson(body);
  if (whole.ok) {
    const value = whole.value;
    if (Array.isArray(value)) {
      return { entries: toEntries(value, warnings, 'array element'), source: 'resource-array', warnings };
    }
    if (isResource(value)) {
      const source = value.resourceType === 'Bundle' ? 'bundle' : 'single-resource';
      return { entries: expandBundles([{ resource: value }]), source, warnings };
    }
    throw new Error('JSON input is not a FHIR resource, Bundle or array of resources');
  }

  const values: unknown[] = [];
  body.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const parsed = tryJson(line);
    if (parsed.ok) values.push(parsed.value);
    else warnings.push(invalid(`NDJSON line ${i + 1} is not valid JSON`));
  });
  if (values.length === 0) throw new Error('Input is neither valid JSON nor NDJSON');
  return { entries: toEntries(values, warnings, 'NDJSON line'), source: 'ndjson-file', warnings };
}

export type LoadedInputWithWarnings = LoadedInput & { warnings?: IntegrityWarning[] };

/** Load a .json/.ndjson file, or a directory of such files (Bulk `$export` output). */
export async function loadInput(path: string): Promise<LoadedInputWithWarnings> {
  const info = await stat(path);
  if (!info.isDirectory()) return loadFile(path);

  const names = (await readdir(path))
    .filter((n) => LOADABLE_EXTENSIONS.has(extname(n).toLowerCase()))
    .sort();
  if (names.length === 0) throw new Error(`No .ndjson/.json files found in ${path}`);

  const entries: InputEntry[] = [];
  const warnings: IntegrityWarning[] = [];
  const texts: string[] = [];
  let bytes = 0;
  for (const name of names) {
    const file = await loadFile(join(path, name));
    entries.push(...file.entries);
    warnings.push(...(file.warnings ?? []));
    texts.push(file.rawText);
    bytes += file.bytes;
  }
  return { entries, bytes, rawText: texts.join('\n'), source: 'ndjson-dir', warnings };
}

async function loadFile(path: string): Promise<LoadedInputWithWarnings> {
  const buffer = await readFile(path);
  const rawText = buffer.toString('utf8');
  const parsed = parseInput(rawText);
  const isNdjson = extname(path).toLowerCase() === '.ndjson';
  return {
    entries: parsed.entries,
    bytes: buffer.length,
    rawText,
    source: isNdjson ? 'ndjson-file' : parsed.source,
    warnings: parsed.warnings,
  };
}

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

  const rawText = opts.rawText ?? '';
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
      inputBytes: opts.inputBytes ?? Buffer.byteLength(rawText, 'utf8'),
      inputTokens: estimateTokens(rawText),
    },
  };
}

export async function normalizeFile(path: string): Promise<NormalizedGraph> {
  const loaded = await loadInput(path);
  return normalize(loaded.entries, {
    inputBytes: loaded.bytes,
    rawText: loaded.rawText,
    warnings: loaded.warnings,
  });
}
