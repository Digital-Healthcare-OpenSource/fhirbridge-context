/** Bounded, streaming, PHI-safe input loading. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadInput, normalize, parseInput } from '../src/normalizer/index.js';

let dir: string;
const line = (id: string) => JSON.stringify({ resourceType: 'Observation', id, status: 'final' });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fhirbridge-loader-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

describe('loadInput', () => {
  it('streams NDJSON with BOM, CRLF, blank and broken lines', async () => {
    const path = await file('mixed.ndjson', `﻿${line('a')}\r\n\r\n{not json\r\n${line('b')}\r\n42\r\n`);
    const loaded = await loadInput(path);
    expect(loaded.entries.map((e) => e.resource.id)).toEqual(['a', 'b']);
    expect(loaded.source).toBe('ndjson-file');
    expect(loaded.warnings?.map((w) => w.message)).toEqual([
      'NDJSON line 3 is not a FHIR resource',
      'NDJSON line 5 is not a FHIR resource',
    ]);
    expect(loaded.rawText).toBeUndefined();
    expect(loaded.bytes).toBeGreaterThan(0);
  });

  it('enforces the byte limit across a Bulk export directory', async () => {
    const bulk = join(dir, 'bulk');
    await mkdir(bulk);
    await writeFile(
      join(bulk, 'Observation.ndjson'),
      Array.from({ length: 50 }, (_, i) => line(`o${i}`)).join('\n'),
    );
    await writeFile(join(bulk, 'Patient.ndjson'), JSON.stringify({ resourceType: 'Patient', id: 'p1' }));
    await mkdir(join(bulk, 'nested.ndjson')); // a directory with a loadable name is ignored
    const ok = await loadInput(bulk);
    expect(ok.entries).toHaveLength(51);
    expect(ok.source).toBe('ndjson-dir');
    await expect(loadInput(bulk, { maxInputBytes: 1000, maxResources: 1e6 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    });
  });

  it('enforces the resource limit, including resources inside Bundles', async () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: Array.from({ length: 20 }, (_, i) => ({ resource: { resourceType: 'Condition', id: `c${i}` } })),
    };
    const path = await file('bundle.json', JSON.stringify(bundle));
    await expect(loadInput(path, { maxInputBytes: 1e9, maxResources: 10 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    });
  });

  it('rejects a .json file larger than the limit before reading it', async () => {
    const path = await file('big.json', JSON.stringify({ resourceType: 'Patient', id: 'x', pad: 'z'.repeat(5000) }));
    await expect(loadInput(path, { maxInputBytes: 100, maxResources: 10 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    });
  });

  it('surfaces a missing path as an fs error the CLI maps to INPUT_NOT_FOUND', async () => {
    await expect(loadInput(join(dir, 'nope.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('parseInput', () => {
  it('never quotes input content in errors (JSON.parse would)', () => {
    const secret = 'Patient John Q Public SSN 123-45-6789';
    let message = '';
    try {
      parseInput(`{"resourceType": "Patient", "name": "${secret}" ,,, }\nalso broken ${secret}`);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/neither valid JSON nor NDJSON/);
    expect(message).not.toContain('John');
    expect(message).not.toContain('123-45-6789');
  });

  it('drops prototype-polluting keys', () => {
    const parsed = parseInput(
      '{"resourceType":"Patient","id":"p","__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
    );
    const patient = parsed.entries[0]?.resource as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(patient, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(patient, 'constructor')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects empty and non-FHIR JSON with INPUT_INVALID', () => {
    expect(() => parseInput('   ')).toThrow(expect.objectContaining({ code: 'INPUT_INVALID' }));
    expect(() => parseInput('{"hello":"world"}')).toThrow(expect.objectContaining({ code: 'INPUT_INVALID' }));
  });

  it('caps Bundle nesting depth instead of recursing forever', () => {
    let resource: Record<string, unknown> = { resourceType: 'Observation', id: 'deep' };
    for (let i = 0; i < 50; i++) resource = { resourceType: 'Bundle', entry: [{ resource }] };
    expect(parseInput(JSON.stringify(resource)).entries).toEqual([]);
  });
});

describe('normalize token accounting', () => {
  it('estimates input tokens from bytes when no raw text is retained', () => {
    const entries = [{ resource: { resourceType: 'Patient', id: 'p1' } }];
    expect(normalize(entries, { inputBytes: 4000 }).stats.inputTokens).toBe(1000);
    expect(normalize(entries).stats.inputTokens).toBeGreaterThan(0);
  });
});
