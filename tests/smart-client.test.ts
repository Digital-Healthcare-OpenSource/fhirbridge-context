/** SMART-on-FHIR pull against a fake FHIR server (no network). */
import { describe, expect, it } from 'vitest';
import { FhirPullError, normalizeBaseUrl, pullPatient } from '../src/portability/smart-client.js';

const BASE = 'https://fhir.example.org/r4';

type Handler = (url: URL) => { status: number; body: unknown };

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: { url: string; auth?: string }[] } {
  const calls: { url: string; auth?: string }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: url.toString(), auth: headers.Authorization });
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch: impl as typeof fetch, calls };
}

const bundle = (resources: unknown[], next?: string) => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: next ? [{ relation: 'next', url: next }] : [],
});

describe('pullPatient', () => {
  it('follows same-origin $everything pagination and sends the bearer token', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.searchParams.get('page') === '2') {
        return { status: 200, body: bundle([{ resourceType: 'Observation', id: 'o1' }]) };
      }
      return {
        status: 200,
        body: bundle([{ resourceType: 'Patient', id: 'p1' }], `${BASE}/Patient/p1/$everything?page=2`),
      };
    });
    const result = await pullPatient({ iss: BASE, patientId: 'p1', token: 't0k', fetchImpl: fetch });
    expect(result.method).toBe('$everything');
    expect(result.pages).toBe(2);
    expect(result.entries.map((e) => `${e.resource.resourceType}/${e.resource.id}`)).toEqual([
      'Patient/p1',
      'Observation/o1',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer t0k')).toBe(true);
  });

  it('falls back to a compartment search when $everything is unsupported', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith('$everything')) return { status: 404, body: { resourceType: 'OperationOutcome' } };
      if (url.pathname.endsWith('/Patient/p1')) return { status: 200, body: { resourceType: 'Patient', id: 'p1' } };
      if (url.pathname.endsWith('/Condition')) {
        return { status: 200, body: bundle([{ resourceType: 'Condition', id: 'c1' }]) };
      }
      if (url.pathname.endsWith('/Immunization')) return { status: 400, body: {} };
      return { status: 200, body: bundle([]) };
    });
    const result = await pullPatient({ iss: BASE, patientId: 'p1', fetchImpl: fetch });
    expect(result.method).toBe('compartment-search');
    expect(result.entries.map((e) => e.resource.id).sort()).toEqual(['c1', 'p1']);
    expect(calls.some((c) => c.url.includes('Condition?patient=p1'))).toBe(true);
  });

  it('refuses to follow pagination to another origin (token exfiltration)', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: bundle([{ resourceType: 'Patient', id: 'p1' }], 'https://attacker.example/steal?page=2'),
    }));
    await expect(pullPatient({ iss: BASE, patientId: 'p1', token: 'secret', fetchImpl: fetch })).rejects.toThrow(
      /different origin/,
    );
    expect(calls.every((c) => c.url.startsWith(BASE))).toBe(true);
  });

  it('surfaces auth failures instead of silently falling back', async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: {} }));
    await expect(pullPatient({ iss: BASE, patientId: 'p1', fetchImpl: fetch })).rejects.toBeInstanceOf(FhirPullError);
  });

  it('validates the base URL and patient id', async () => {
    expect(() => normalizeBaseUrl('http://fhir.example.org')).toThrow(/https/);
    expect(() => normalizeBaseUrl('https://user:pw@fhir.example.org')).toThrow(/Credentials/);
    expect(normalizeBaseUrl('http://localhost:8080/fhir/').toString()).toBe('http://localhost:8080/fhir');
    await expect(pullPatient({ iss: BASE, patientId: '../../admin' })).rejects.toThrow(/Invalid patient id/);
  });
});
