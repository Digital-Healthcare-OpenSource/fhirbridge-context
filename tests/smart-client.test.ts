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
    expect(result.skipped).toEqual([{ type: 'Immunization', status: 400 }]);
  });

  /** $everything unsupported; the compartment search then fails for `failing` with `status`. */
  function compartmentFailing(failing: string, status: number) {
    return fakeFetch((url) => {
      if (url.pathname.endsWith('$everything')) return { status: 404, body: {} };
      if (url.pathname.endsWith('/Patient/p1')) return { status: 200, body: { resourceType: 'Patient', id: 'p1' } };
      if (url.pathname.endsWith(`/${failing}`)) return { status, body: {} };
      return { status: 200, body: bundle([]) };
    });
  }

  it.each([404, 405])('skips and records a compartment type answered with HTTP %i', async (status) => {
    const { fetch } = compartmentFailing('Procedure', status);
    const result = await pullPatient({ iss: BASE, patientId: 'p1', fetchImpl: fetch });
    expect(result.skipped).toEqual([{ type: 'Procedure', status }]);
  });

  it.each([401, 403, 408, 429, 500, 503])(
    'aborts the compartment search on HTTP %i instead of returning a partial record',
    async (status) => {
      const { fetch } = compartmentFailing('Observation', status);
      const failure = await pullPatient({ iss: BASE, patientId: 'p1', fetchImpl: fetch }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(FhirPullError);
      expect((failure as FhirPullError).status).toBe(status);
      expect((failure as FhirPullError).message).toContain(`HTTP ${status}`);
    },
  );

  it('applies maxPages per resource type, not across the whole pull', async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.pathname.endsWith('$everything')) return { status: 404, body: {} };
      if (url.pathname.endsWith('/Patient/p1')) return { status: 200, body: { resourceType: 'Patient', id: 'p1' } };
      const type = url.pathname.split('/').pop() ?? '';
      if (type === 'Condition' || type === 'Observation') {
        const page = Number(url.searchParams.get('page') ?? '1');
        const id = `${type.toLowerCase()}-${page}`;
        const next = page < 2 ? `${BASE}/${type}?patient=p1&page=${page + 1}` : undefined;
        return { status: 200, body: bundle([{ resourceType: type, id }], next) };
      }
      return { status: 200, body: bundle([]) };
    });
    const result = await pullPatient({ iss: BASE, patientId: 'p1', maxPages: 2, fetchImpl: fetch });
    expect(result.entries.map((e) => e.resource.id).sort()).toEqual([
      'condition-1',
      'condition-2',
      'observation-1',
      'observation-2',
      'p1',
    ]);
    const tooMany = fakeFetch(() => ({
      status: 200,
      body: bundle([{ resourceType: 'Patient', id: 'p1' }], `${BASE}/Patient/p1/$everything?page=2`),
    }));
    await expect(pullPatient({ iss: BASE, patientId: 'p1', maxPages: 3, fetchImpl: tooMany.fetch })).rejects.toThrow(
      /Stopped after 3 pages/,
    );
  });

  it('times out a request that never answers', async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    await expect(pullPatient({ iss: BASE, patientId: 'p1', timeoutMs: 25, fetchImpl: hanging })).rejects.toThrow(
      /timed out after 25 ms/,
    );
  });

  it('lets the caller abort without relabelling it as a timeout', async () => {
    const controller = new AbortController();
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const pending = pullPatient({ iss: BASE, patientId: 'p1', signal: controller.signal, fetchImpl: hanging });
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
  });

  it('aborts a page larger than the size cap, by header or while streaming', async () => {
    const big = JSON.stringify(bundle([{ resourceType: 'Patient', id: 'p1', note: 'x'.repeat(5000) }]));
    const streaming = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    await expect(
      pullPatient({ iss: BASE, patientId: 'p1', maxResponseBytes: 1000, fetchImpl: streaming }),
    ).rejects.toThrow(/page limit/);
    const declared = (async () =>
      new Response('{}', { status: 200, headers: { 'content-length': '999999' } })) as unknown as typeof fetch;
    await expect(
      pullPatient({ iss: BASE, patientId: 'p1', maxResponseBytes: 1000, fetchImpl: declared }),
    ).rejects.toThrow(/page limit/);
    const small = fakeFetch(() => ({ status: 200, body: bundle([{ resourceType: 'Patient', id: 'p1' }]) }));
    await expect(
      pullPatient({ iss: BASE, patientId: 'p1', maxResponseBytes: 10_000, fetchImpl: small.fetch }),
    ).resolves.toMatchObject({ pages: 1 });
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
