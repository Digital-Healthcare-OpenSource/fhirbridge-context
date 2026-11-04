/**
 * Input loading with bounded resources.
 *
 * - `.ndjson` files are read line by line (Bulk `$export` files can be multi-GB);
 *   `.json` files are size-checked before being read whole (a Bundle is one JSON document).
 * - Total bytes and resource count are capped (FHIRBRIDGE_MAX_INPUT_MB / _MAX_RESOURCES).
 * - Directories: only regular `.json` / `.ndjson` files directly inside are read; symlinks and
 *   sub-directories are ignored.
 * - Error messages never quote input content (JSON.parse messages do, so they are wrapped).
 */
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { loadRuntimeConfig, type RuntimeLimits } from '../config.js';
import { FhirBridgeError } from '../errors.js';
import type { Resource } from '../types/fhir.js';
import { isResource } from '../types/fhir.js';
import type { InputEntry, IntegrityWarning, LoadedInput } from '../types/pipeline.js';

const MAX_BUNDLE_DEPTH = 8;
/** A single NDJSON line larger than this is rejected without buffering the rest of it. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** Maximum JSON container nesting accepted (deeper input would overflow recursive consumers). */
const MAX_JSON_DEPTH = 256;
const LOADABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.ndjson']);
/** Keys that could reach an object prototype if a consumer ever merged parsed JSON naively. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export interface ParsedInput {
  entries: InputEntry[];
  source: LoadedInput['source'];
  /** Lines/elements that were not FHIR resources. */
  warnings: IntegrityWarning[];
}

export type LoadedInputWithWarnings = LoadedInput & { warnings?: IntegrityWarning[] };

function invalid(message: string): IntegrityWarning {
  return { code: 'INVALID_RESOURCE', resourceKey: '(input)', message };
}

/** True when `[`/`{` nesting exceeds the limit (string contents are skipped). */
function exceedsDepth(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i += 1;
      else if (ch === 0x22) inString = false;
    } else if (ch === 0x22) {
      inString = true;
    } else if (ch === 0x5b || ch === 0x7b) {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) return true;
    } else if (ch === 0x5d || ch === 0x7d) {
      depth -= 1;
    }
  }
  return false;
}

function tooDeep(): FhirBridgeError {
  return new FhirBridgeError('INPUT_INVALID', 'Input nesting is too deep.');
}

/**
 * JSON.parse that drops prototype-polluting keys and never surfaces input text in errors.
 * Throws INPUT_INVALID for pathological nesting instead of a RangeError.
 */
function safeJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (exceedsDepth(text)) throw tooDeep();
  try {
    const value: unknown = JSON.parse(text, (key, v: unknown) => (FORBIDDEN_KEYS.has(key) ? undefined : v));
    return { ok: true, value };
  } catch (error) {
    if (error instanceof RangeError) throw tooDeep();
    return { ok: false };
  }
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

/** Expand (possibly nested) Bundles into their entries. Nesting beyond 8 levels is dropped. */
export function expandBundles(entries: readonly InputEntry[], depth = 0): InputEntry[] {
  const out: InputEntry[] = [];
  for (const entry of entries) {
    if (entry.resource.resourceType !== 'Bundle') out.push(entry);
    else if (depth < MAX_BUNDLE_DEPTH) out.push(...expandBundles(bundleEntries(entry.resource), depth + 1));
  }
  return out;
}

function toEntries(values: readonly unknown[], warnings: IntegrityWarning[], label: string): InputEntry[] {
  const entries: InputEntry[] = [];
  values.forEach((value, i) => {
    if (isResource(value)) entries.push({ resource: value });
    else warnings.push(invalid(`${label} ${i + 1} is not a FHIR resource`));
  });
  return expandBundles(entries);
}

/** Accept a Bundle, a JSON array of resources, a single resource or NDJSON text. */
export function parseInput(text: string): ParsedInput {
  const body = text.replace(/^﻿/, '').trim();
  if (!body) throw new FhirBridgeError('INPUT_INVALID', 'Input is empty.');
  const warnings: IntegrityWarning[] = [];

  const whole = safeJson(body);
  if (whole.ok) {
    const value = whole.value;
    if (Array.isArray(value)) {
      return { entries: toEntries(value, warnings, 'array element'), source: 'resource-array', warnings };
    }
    if (isResource(value)) {
      const source = value.resourceType === 'Bundle' ? 'bundle' : 'single-resource';
      return { entries: expandBundles([{ resource: value }]), source, warnings };
    }
    throw new FhirBridgeError('INPUT_INVALID', 'JSON input is not a FHIR resource, Bundle or array of resources.');
  }

  const values: unknown[] = [];
  body.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const parsed = safeJson(line);
    if (parsed.ok) values.push(parsed.value);
    else warnings.push(invalid(`NDJSON line ${i + 1} is not valid JSON`));
  });
  if (values.length === 0) throw new FhirBridgeError('INPUT_INVALID', 'Input is neither valid JSON nor NDJSON.');
  return { entries: toEntries(values, warnings, 'NDJSON line'), source: 'ndjson-file', warnings };
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Running totals shared across the files of one input, enforcing the limits. */
class Budget {
  bytes = 0;
  resources = 0;

  constructor(private readonly limits: RuntimeLimits) {}

  addBytes(n: number): void {
    this.bytes += n;
    if (this.bytes > this.limits.maxInputBytes) {
      throw new FhirBridgeError('INPUT_TOO_LARGE', `Input exceeds ${formatMb(this.limits.maxInputBytes)}.`, {
        hint: 'Raise FHIRBRIDGE_MAX_INPUT_MB, or split the export (for example one patient per run).',
      });
    }
  }

  addResources(n: number): void {
    this.resources += n;
    if (this.resources > this.limits.maxResources) {
      throw new FhirBridgeError('INPUT_TOO_LARGE', `Input exceeds ${this.limits.maxResources} resources.`, {
        hint: 'Raise FHIRBRIDGE_MAX_RESOURCES, or split the export.',
      });
    }
  }
}

/** Split a byte stream into lines, aborting as soon as one line exceeds `maxLineBytes`. */
async function* readLines(
  stream: AsyncIterable<Buffer>,
  budget: Budget,
  maxLineBytes: number = MAX_LINE_BYTES,
): AsyncGenerator<string> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const push = (piece: Buffer): void => {
    pendingBytes += piece.length;
    if (pendingBytes > maxLineBytes) {
      throw new FhirBridgeError('INPUT_TOO_LARGE', `An NDJSON line exceeds ${formatMb(maxLineBytes)}.`, {
        hint: 'Single resources this large are not supported; split the export or strip the attachment.',
      });
    }
    pending.push(piece);
  };
  const flush = (): string => {
    const line = Buffer.concat(pending).toString('utf8').replace(/\r$/, '');
    pending = [];
    pendingBytes = 0;
    return line;
  };
  for await (const chunk of stream) {
    budget.addBytes(chunk.length);
    let from = 0;
    for (let nl = chunk.indexOf(0x0a, from); nl !== -1; nl = chunk.indexOf(0x0a, from)) {
      push(chunk.subarray(from, nl));
      yield flush();
      from = nl + 1;
    }
    if (from < chunk.length) push(chunk.subarray(from));
  }
  if (pendingBytes > 0) yield flush();
}

async function loadNdjsonStream(path: string, budget: Budget): Promise<LoadedInputWithWarnings> {
  const warnings: IntegrityWarning[] = [];
  const entries: InputEntry[] = [];
  const stream = createReadStream(path);
  const start = budget.bytes;
  let lineNo = 0;
  try {
    for await (const rawLine of readLines(stream, budget)) {
      lineNo += 1;
      const line = lineNo === 1 ? rawLine.replace(/^﻿/, '') : rawLine;
      if (!line.trim()) continue;
      const parsed = safeJson(line);
      if (!parsed.ok || !isResource(parsed.value)) {
        warnings.push(invalid(`NDJSON line ${lineNo} is not a FHIR resource`));
        continue;
      }
      const expanded = expandBundles([{ resource: parsed.value }]);
      budget.addResources(expanded.length);
      entries.push(...expanded);
    }
  } finally {
    stream.destroy();
  }
  if (entries.length === 0 && warnings.length === 0) {
    throw new FhirBridgeError('INPUT_INVALID', 'NDJSON input is empty.');
  }
  return { entries, bytes: budget.bytes - start, source: 'ndjson-file', warnings };
}

async function loadJsonFile(path: string, size: number, budget: Budget): Promise<LoadedInputWithWarnings> {
  budget.addBytes(size);
  const parsed = parseInput(await readFile(path, 'utf8'));
  budget.addResources(parsed.entries.length);
  return { entries: parsed.entries, bytes: size, source: parsed.source, warnings: parsed.warnings };
}

function loadFile(path: string, size: number, budget: Budget): Promise<LoadedInputWithWarnings> {
  return extname(path).toLowerCase() === '.ndjson'
    ? loadNdjsonStream(path, budget)
    : loadJsonFile(path, size, budget);
}

async function loadDirectory(path: string, budget: Budget): Promise<LoadedInputWithWarnings> {
  const dirents = await readdir(path, { withFileTypes: true });
  const files = dirents
    .filter((d) => d.isFile() && LOADABLE_EXTENSIONS.has(extname(d.name).toLowerCase()))
    .map((d) => d.name)
    .sort();
  if (files.length === 0) {
    throw new FhirBridgeError('INPUT_INVALID', 'Directory contains no .ndjson or .json files.');
  }
  const entries: InputEntry[] = [];
  const warnings: IntegrityWarning[] = [];
  for (const name of files) {
    const full = join(path, name);
    const info = await lstat(full);
    const file = await loadFile(full, info.size, budget);
    entries.push(...file.entries);
    warnings.push(...(file.warnings ?? []));
  }
  return { entries, bytes: budget.bytes, source: 'ndjson-dir', warnings };
}

/**
 * Load a .json/.ndjson file, or a directory of such files (Bulk `$export` output).
 * Limits default to the current FHIRBRIDGE_MAX_INPUT_MB / FHIRBRIDGE_MAX_RESOURCES environment.
 */
export async function loadInput(
  path: string,
  limits: RuntimeLimits = loadRuntimeConfig().limits,
): Promise<LoadedInputWithWarnings> {
  const info = await lstat(path);
  const budget = new Budget(limits);
  if (info.isDirectory()) return loadDirectory(path, budget);
  if (info.isSymbolicLink()) {
    throw new FhirBridgeError('INPUT_INVALID', 'Input path is a symbolic link; pass the target path instead.');
  }
  if (!info.isFile()) throw new FhirBridgeError('INPUT_INVALID', 'Input path is not a regular file.');
  return loadFile(path, info.size, budget);
}
