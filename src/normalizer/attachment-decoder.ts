/**
 * EHR dialect fixes applied per resource: narrative removal, id shortening, lastUpdated inference
 * and base64 attachment decoding. Pure: every function returns new objects.
 */
import { createHash } from 'node:crypto';
import type { Resource } from '../types/fhir.js';
import { resourceKey } from '../types/fhir.js';
import type { DecodedDocument, InputEntry, IntegrityWarning } from '../types/pipeline.js';
import { parseFhirDate } from '../shared/fhir-date.js';
import { decodeTextBytes } from './charset.js';
import { collapseWhitespace, stripMarkup, stripRtf } from './markup-strip.js';
import { rewriteReferences } from './graph-resolver.js';

export const ORIGINAL_ID_URL = 'https://fhirbridge.dev/fhir/StructureDefinition/original-id';
export const ATTACHMENT_INFO_URL = 'https://fhirbridge.dev/fhir/StructureDefinition/attachment-info';

export const MAX_ID_LENGTH = 64;
export const MAX_DOC_CHARS = 4000;

const TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/html',
  'text/rtf',
  'application/rtf',
  'application/xml',
  'text/xml',
  'application/xhtml+xml',
]);
const MARKUP_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xml',
  'text/xml',
  'application/xhtml+xml',
]);
const RTF_TYPES: ReadonlySet<string> = new Set(['text/rtf', 'application/rtf']);

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/* ------------------------------ ids ------------------------------ */

export interface ShortenResult {
  entries: InputEntry[];
  idMap: Map<string, string>;
  warnings: IntegrityWarning[];
}

/** Replace ids longer than 64 chars by `<prefix>-<sha256 slice>` and rewrite references to them. */
export function shortenIds(entries: readonly InputEntry[]): ShortenResult {
  const idMap = new Map<string, string>();
  for (const { resource } of entries) {
    if (resource.id && resource.id.length > MAX_ID_LENGTH) {
      idMap.set(resourceKey(resource), shortenId(resource.id));
    }
  }
  if (idMap.size === 0) return { entries: [...entries], idMap, warnings: [] };

  const warnings: IntegrityWarning[] = [];
  const out = entries.map((entry) => {
    const rewritten = rewriteReferences(entry.resource, idMap);
    const originalKey = resourceKey(entry.resource);
    const newId = idMap.get(originalKey);
    if (!newId) return { ...entry, resource: rewritten };
    const originalId = entry.resource.id ?? '';
    const resource: Resource = {
      ...rewritten,
      id: newId,
      meta: {
        ...rewritten.meta,
        extension: [
          ...(rewritten.meta?.extension ?? []),
          { url: ORIGINAL_ID_URL, valueString: originalId },
        ],
      },
    };
    warnings.push({
      code: 'ID_SHORTENED',
      resourceKey: resourceKey(resource),
      message: `id of ${originalId.length} chars shortened to "${newId}"`,
      details: { originalId, shortenedId: newId },
    });
    return { ...entry, resource };
  });
  return { entries: out, idMap, warnings };
}

function shortenId(id: string): string {
  const prefix = id.slice(0, 24).replace(/[^A-Za-z0-9.-]/g, '-');
  return `${prefix}-${sha256Hex(id).slice(0, 16)}`;
}

/* --------------------------- narrative & dates --------------------------- */

/** Drop `text` (Narrative) from the resource and everything in `contained`. */
export function stripNarrative(resource: Resource): Resource {
  const { text: _text, ...rest } = resource;
  void _text;
  if (!rest.contained) return rest;
  return { ...rest, contained: rest.contained.map(stripNarrative) };
}

const DATE_FIELDS: readonly string[] = [
  'effectiveDateTime',
  'effectivePeriod.start',
  'authoredOn',
  'issued',
  'recordedDate',
  'date',
  'period.start',
];

function readPath(resource: Resource, path: string): string | undefined {
  let node: unknown = resource;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node ? node : undefined;
}

/** FHIR date/dateTime → `instant` (always carries a time and timezone). */
export function toInstant(value: string): string | undefined {
  const p = parseFhirDate(value);
  if (!p) return undefined;
  const pad = (n: number | undefined): string => String(n ?? 1).padStart(2, '0');
  const date = `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`;
  if (!p.timePart) return `${date}T00:00:00Z`;
  const hasZone = /(Z|[+-]\d{2}:\d{2})$/.test(p.timePart);
  const time = p.timePart.replace(/^T(\d{2}:\d{2})(?!:)/, 'T$1:00'); // Thh:mm → Thh:mm:ss
  return `${date}${time}${hasZone ? '' : 'Z'}`;
}

export function inferLastUpdated(resource: Resource): { resource: Resource; warning?: IntegrityWarning } {
  if (resource.meta?.lastUpdated) return { resource };
  for (const field of DATE_FIELDS) {
    const instant = toInstant(readPath(resource, field) ?? '');
    if (!instant) continue;
    return {
      resource: { ...resource, meta: { ...resource.meta, lastUpdated: instant } },
      warning: {
        code: 'LAST_UPDATED_INFERRED',
        resourceKey: resourceKey(resource),
        message: `meta.lastUpdated missing; inferred ${instant} from ${field}`,
        details: { field, value: instant },
      },
    };
  }
  return { resource };
}

export { stripMarkup, stripRtf };

/* ------------------------------ text extraction ------------------------------ */

/** Extract plain text; `null` when the bytes are not really text (see `decodeTextBytes`). */
export function extractText(bytes: Buffer, contentType: string, rawContentType = contentType): string | null {
  const decoded = decodeTextBytes(bytes, rawContentType);
  if (decoded === null) return null;
  const raw = decoded.replace(/^﻿/, '');
  if (RTF_TYPES.has(contentType)) return stripRtf(raw);
  if (MARKUP_TYPES.has(contentType)) return stripMarkup(raw, contentType === 'text/html');
  return collapseWhitespace(raw);
}

export function chunkText(text: string, size = MAX_DOC_CHARS): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1; // keep surrogate pairs whole
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/* ------------------------------ attachments ------------------------------ */

const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;

export interface AttachmentDecode {
  resource: Resource;
  documents: DecodedDocument[];
  warnings: IntegrityWarning[];
}

interface Sink {
  key: string;
  documents: DecodedDocument[];
  warnings: IntegrityWarning[];
}

const baseType = (contentType: string | undefined): string =>
  (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

/** Decode/strip base64 payloads in DocumentReference, DiagnosticReport and Binary. */
export function decodeAttachments(resource: Resource): AttachmentDecode {
  const sink: Sink = { key: resourceKey(resource), documents: [], warnings: [] };
  let result = resource;
  if (resource.resourceType === 'DocumentReference' && Array.isArray(resource['content'])) {
    const content = (resource['content'] as Record<string, unknown>[]).map((c) =>
      isRecord(c['attachment']) ? { ...c, attachment: processAttachment(c['attachment'], sink) } : c,
    );
    result = { ...resource, content };
  } else if (resource.resourceType === 'DiagnosticReport' && Array.isArray(resource['presentedForm'])) {
    const forms = (resource['presentedForm'] as unknown[]).map((a) =>
      isRecord(a) ? processAttachment(a, sink) : a,
    );
    result = { ...resource, presentedForm: forms };
  } else if (resource.resourceType === 'Binary' && typeof resource['data'] === 'string') {
    result = processBinary(resource, sink);
  }
  return { resource: result, documents: sink.documents, warnings: sink.warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Payload {
  bytes: Buffer;
  sha256: string;
  validBase64: boolean;
}

function readPayload(data: string): Payload {
  const compact = data.replace(/\s+/g, '');
  const validBase64 = BASE64_RE.test(compact);
  const bytes = validBase64 ? Buffer.from(compact, 'base64') : Buffer.alloc(0);
  return { bytes, sha256: sha256Hex(validBase64 ? bytes : data), validBase64 };
}

function processAttachment(att: Record<string, unknown>, sink: Sink): Record<string, unknown> {
  if (typeof att['data'] !== 'string') return att;
  const { data, ...rest } = att;
  const contentType = baseType(typeof att['contentType'] === 'string' ? att['contentType'] : undefined);
  const payload = readPayload(data as string);
  const size = payload.bytes.length;
  const rawType = typeof att['contentType'] === 'string' ? att['contentType'] : '';

  if (payload.validBase64 && TEXT_CONTENT_TYPES.has(contentType) && recordDocument(sink, contentType, rawType, payload)) {
    return { ...rest, size, hash: payload.sha256 };
  }
  const marker = binaryMarker(contentType, size, payload.sha256);
  recordStripped(sink, contentType, size, payload);
  return {
    ...rest,
    size,
    hash: payload.sha256,
    title: typeof rest['title'] === 'string' && rest['title'] ? rest['title'] : marker,
  };
}

function processBinary(resource: Resource, sink: Sink): Resource {
  const { data, ...rest } = resource;
  const contentType = baseType(typeof resource['contentType'] === 'string' ? resource['contentType'] : undefined);
  const payload = readPayload(data as string);
  const rawType = typeof resource['contentType'] === 'string' ? resource['contentType'] : '';
  let info: string;
  if (payload.validBase64 && TEXT_CONTENT_TYPES.has(contentType) && recordDocument(sink, contentType, rawType, payload)) {
    info = `sha256:${payload.sha256}`;
  } else {
    info = binaryMarker(contentType, payload.bytes.length, payload.sha256);
    recordStripped(sink, contentType, payload.bytes.length, payload);
  }
  return { ...rest, extension: [...(rest.extension ?? []), { url: ATTACHMENT_INFO_URL, valueString: info }] };
}

function binaryMarker(contentType: string, size: number, sha256: string): string {
  return `[BINARY_ATTACHMENT: ${contentType || 'unknown'}, ${size}, sha256:${sha256}]`;
}

/** Returns false (nothing recorded) when the bytes turn out not to be text. */
function recordDocument(sink: Sink, contentType: string, rawType: string, payload: Payload): boolean {
  const full = extractText(payload.bytes, contentType, rawType);
  if (full === null) return false;
  const doc: DecodedDocument = {
    resourceKey: sink.key,
    contentType,
    text: full.slice(0, MAX_DOC_CHARS),
    chunks: chunkText(full),
    truncated: full.length > MAX_DOC_CHARS,
    sourceSizeBytes: payload.bytes.length,
    sha256: payload.sha256,
  };
  sink.documents.push(doc);
  sink.warnings.push({
    code: 'ATTACHMENT_DECODED',
    resourceKey: sink.key,
    message: `decoded ${contentType} attachment (${payload.bytes.length} bytes, ${full.length} chars)`,
    details: { contentType, sizeBytes: payload.bytes.length, chars: full.length },
  });
  return true;
}

function recordStripped(sink: Sink, contentType: string, size: number, payload: Payload): void {
  sink.warnings.push({
    code: 'BINARY_ATTACHMENT_STRIPPED',
    resourceKey: sink.key,
    message: payload.validBase64
      ? `binary attachment ${contentType || 'unknown'} (${size} bytes) removed`
      : 'attachment data is not valid base64 and was removed',
    details: { contentType, sizeBytes: size, sha256: payload.sha256, validBase64: payload.validBase64 },
  });
}

/* ------------------------------ combined ------------------------------ */

export interface PreparedResource {
  resource: Resource;
  documents: DecodedDocument[];
  warnings: IntegrityWarning[];
}

/** Narrative removal + lastUpdated inference + attachment decoding, in that order. */
export function prepareResource(resource: Resource): PreparedResource {
  const stripped = stripNarrative(resource);
  const dated = inferLastUpdated(stripped);
  const decoded = decodeAttachments(dated.resource);
  return {
    resource: decoded.resource,
    documents: decoded.documents,
    warnings: [...(dated.warning ? [dated.warning] : []), ...decoded.warnings],
  };
}
