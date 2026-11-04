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
/** HTTP statuses meaning "this server does not do $everything" → try the compartment search. */
const EVERYTHING_UNSUPPORTED = new Set([400, 403, 404, 405, 422, 501]);

export interface PullOptions {
  /** FHIR base URL (the SMART `iss`). */
  iss: string;
  patientId: string;
  /** Bearer access token, if the server requires auth. */
  token?: string;
  maxPages?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface PullResult extends LoadedInput {
  method: '$everything' | 'compartment-search';
  pages: number;
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

async function fetchJson(url: URL, opts: PullOptions): Promise<Page> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/fhir+json, application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await doFetch(url, { headers, signal: opts.signal, redirect: 'error' });
  const text = await res.text();
  if (!res.ok) throw new FhirPullError(`GET ${url.pathname} failed with HTTP ${res.status}`, res.status);
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

/** Follow `next` links from `first`, collecting entries into `acc`. */
async function collectPages(first: URL, base: URL, opts: PullOptions, acc: Accumulator): Promise<void> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  let url: URL | undefined = first;
  while (url) {
    if (acc.pages >= maxPages) throw new FhirPullError(`Stopped after ${maxPages} pages (raise --max-pages).`);
    const page = await fetchJson(url, opts);
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

function toResult(acc: Accumulator, method: PullResult['method']): PullResult {
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
  };
}

function isSkippableSearchError(err: unknown): boolean {
  return (
    err instanceof FhirPullError &&
    err.status !== undefined &&
    err.status < 500 &&
    err.status !== 401 &&
    err.status !== 403
  );
}

async function compartmentSearch(base: URL, opts: PullOptions): Promise<PullResult> {
  const acc: Accumulator = { entries: [], texts: [], pages: 0 };
  await collectPages(joinUrl(base, `Patient/${encodeURIComponent(opts.patientId)}`), base, opts, acc);
  for (const type of COMPARTMENT_TYPES) {
    const url = joinUrl(base, type);
    url.searchParams.set('patient', opts.patientId);
    url.searchParams.set('_count', '200');
    try {
      await collectPages(url, base, opts, acc);
    } catch (err) {
      // Servers commonly reject searches for types they do not host; skip only those.
      if (!isSkippableSearchError(err)) throw err;
    }
  }
  return toResult(acc, 'compartment-search');
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
