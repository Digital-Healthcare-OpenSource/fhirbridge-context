/**
 * SMART-on-FHIR R4 pull: `Patient/{id}/$everything`, falling back to a Patient
 * compartment search when the server does not support the operation.
 *
 * Security: pagination (`Bundle.link[next]`) is only followed to the same origin as
 * `iss`, so a malicious server cannot make us send the bearer token elsewhere.
 */
import type { Bundle, Resource } from '../types/fhir.js';
import { isResource } from '../types/fhir.js';
import type { InputEntry, LoadedInput } from '../types/pipeline.js';

export const COMPARTMENT_TYPES = [
  'AllergyIntolerance',
  'Condition',
  'Encounter',
  'MedicationRequest',
  'MedicationStatement',
  'MedicationDispense',
  'Observation',
  'Procedure',
  'DiagnosticReport',
  'DocumentReference',
  'Immunization',
] as const;

const PATIENT_ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
/** Compartment-search statuses meaning "this server does not host / support that type". */
const SKIPPABLE_SEARCH_STATUSES = new Set([400, 404, 405]);
/** HTTP statuses meaning "this server does not do $everything" → try the compartment search. */
const EVERYTHING_UNSUPPORTED = new Set([400, 403, 404, 405, 422, 501]);

export interface PullOptions {
  /** FHIR base URL (the SMART `iss`). */
  iss: string;
  patientId: string;
  /** Bearer access token, if the server requires auth. */
  token?: string;
  /** Page limit PER resource type (and for `$everything`). Default 200. */
  maxPages?: number;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /** Largest accepted response body per page. Default 50 MB. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** A resource type the compartment search could not read and left out of the result. */
export interface SkippedType {
  type: string;
  status: number;
}

export interface PullResult extends LoadedInput {
  method: '$everything' | 'compartment-search';
  pages: number;
  /** Types skipped by the compartment search (empty for `$everything`). */
  skipped: SkippedType[];
}

export class FhirPullError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FhirPullError';
  }
}

export function normalizeBaseUrl(iss: string): URL {
  let url: URL;
  try {
    url = new URL(iss);
  } catch {
    throw new FhirPullError(`Invalid FHIR base URL: ${iss}`);
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new FhirPullError('FHIR base URL must use https (http is allowed only for localhost).');
  }
  if (url.username || url.password) {
    throw new FhirPullError('Credentials in the URL are not allowed; use --token.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function joinUrl(base: URL, path: string): URL {
  return new URL(`${base.pathname}/${path}`, base.origin);
}

interface Page {
  bundle: Bundle;
  text: string;
}

/** Combine the caller's signal with a per-request timeout. */
function requestSignal(opts: PullOptions): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

/** Read a response body, aborting as soon as it exceeds `maxBytes`. */
async function readCapped(res: Response, url: URL, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new FhirPullError(`GET ${url.pathname} response exceeds the ${maxBytes}-byte page limit.`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new FhirPullError(`GET ${url.pathname} response exceeds the ${maxBytes}-byte page limit.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function describeFailure(url: URL, status: number): string {
  if (status === 401 || status === 403) {
    return `GET ${url.pathname} was refused (HTTP ${status}): check the access token and its scopes.`;
  }
  if (status === 408 || status === 429 || status >= 500) {
    return `GET ${url.pathname} failed with HTTP ${status} (server busy or unavailable); retry later.`;
  }
  return `GET ${url.pathname} failed with HTTP ${status}`;
}

async function fetchJson(url: URL, opts: PullOptions): Promise<Page> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/fhir+json, application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let text: string;
  let res: Response;
  try {
    res = await doFetch(url, { headers, signal: requestSignal(opts), redirect: 'error' });
    if (!res.ok) {
      await res.body?.cancel();
      throw new FhirPullError(describeFailure(url, res.status), res.status);
    }
    text = await readCapped(res, url, opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof FhirPullError) throw err;
    if (opts.signal?.aborted) throw err;
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new FhirPullError(`GET ${url.pathname} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms.`);
    }
    throw new FhirPullError(`GET ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FhirPullError(`GET ${url.pathname} did not return JSON`);
  }
  if (!isResource(body)) throw new FhirPullError(`GET ${url.pathname} did not return a FHIR resource`);
  const bundle: Bundle =
    body.resourceType === 'Bundle' ? (body as Bundle) : { resourceType: 'Bundle', entry: [{ resource: body }] };
  return { bundle, text };
}

function nextLink(bundle: Bundle, base: URL): URL | undefined {
  const href = bundle.link?.find((l) => l.relation === 'next')?.url;
  if (!href) return undefined;
  const next = new URL(href, base.origin);
  if (next.origin !== base.origin) {
    throw new FhirPullError(`Refusing to follow pagination to a different origin (${next.origin}).`);
  }
  return next;
}

interface Accumulator {
  entries: InputEntry[];
  texts: string[];
  pages: number;
}

/** Follow `next` links from `first`, collecting entries into `acc`; `maxPages` applies to this call. */
async function collectPages(first: URL, base: URL, opts: PullOptions, acc: Accumulator): Promise<void> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  let url: URL | undefined = first;
  let fetched = 0;
  while (url) {
    if (fetched >= maxPages) {
      throw new FhirPullError(`Stopped after ${maxPages} pages of ${first.pathname} (raise --max-pages).`);
    }
    const page = await fetchJson(url, opts);
    fetched += 1;
    acc.pages += 1;
    acc.texts.push(page.text);
    for (const entry of page.bundle.entry ?? []) {
      if (entry.resource && isResource(entry.resource) && entry.resource.resourceType !== 'OperationOutcome') {
        acc.entries.push({ resource: entry.resource, fullUrl: entry.fullUrl });
      }
    }
    url = nextLink(page.bundle, base);
  }
}

function toResult(acc: Accumulator, method: PullResult['method'], skipped: SkippedType[] = []): PullResult {
  const seen = new Set<string>();
  const entries = acc.entries.filter(({ resource }: { resource: Resource }) => {
    if (!resource.id) return true;
    const key = `${resource.resourceType}/${resource.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rawText = acc.texts.join('\n');
  return {
    entries,
    rawText,
    bytes: Buffer.byteLength(rawText, 'utf8'),
    source: 'bundle',
    method,
    pages: acc.pages,
    skipped,
  };
}

function skippableStatus(err: unknown): number | undefined {
  return err instanceof FhirPullError && err.status !== undefined && SKIPPABLE_SEARCH_STATUSES.has(err.status)
    ? err.status
    : undefined;
}

async function compartmentSearch(base: URL, opts: PullOptions): Promise<PullResult> {
  const acc: Accumulator = { entries: [], texts: [], pages: 0 };
  const skipped: SkippedType[] = [];
  await collectPages(joinUrl(base, `Patient/${encodeURIComponent(opts.patientId)}`), base, opts, acc);
  for (const type of COMPARTMENT_TYPES) {
    const url = joinUrl(base, type);
    url.searchParams.set('patient', opts.patientId);
    url.searchParams.set('_count', '200');
    try {
      await collectPages(url, base, opts, acc);
    } catch (err) {
      // Servers commonly reject searches for types they do not host. Skip only those, and say so:
      // auth, rate-limit, timeout and server errors must not silently yield a partial record.
      const status = skippableStatus(err);
      if (status === undefined) throw err;
      skipped.push({ type, status });
    }
  }
  return toResult(acc, 'compartment-search', skipped);
}

/** Pull one patient's record from a FHIR R4 server. */
export async function pullPatient(opts: PullOptions): Promise<PullResult> {
  if (!PATIENT_ID_RE.test(opts.patientId)) throw new FhirPullError('Invalid patient id.');
  const base = normalizeBaseUrl(opts.iss);
  const acc: Accumulator = { entries: [], texts: [], pages: 0 };
  try {
    const everything = joinUrl(base, `Patient/${encodeURIComponent(opts.patientId)}/$everything`);
    await collectPages(everything, base, opts, acc);
    return toResult(acc, '$everything');
  } catch (err) {
    const unsupported =
      err instanceof FhirPullError && err.status !== undefined && EVERYTHING_UNSUPPORTED.has(err.status);
    if (!unsupported) throw err;
  }
  return compartmentSearch(base, opts);
}
