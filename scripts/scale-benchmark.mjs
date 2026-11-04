#!/usr/bin/env node
/**
 * Scale benchmark: N synthetic patients written as a Bulk-export style NDJSON directory,
 * then loaded, normalized, de-identified and compiled. Reports time, throughput and peak
 * heap so super-linear behaviour shows up as the per-resource cost growing with N.
 *
 *   npm run build && node --expose-gc scripts/scale-benchmark.mjs 10 100 1000
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { loadInput, pack, SafeHarborVault } from '../dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);
const SIZES = sizes.length > 0 ? sizes : [10, 100, 1000];

const fixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/synthea-messy-patient.json'), 'utf8'));
const template = fixture.entry.map((e) => e.resource);

/** Re-key every id and reference so each copy is a distinct patient graph. */
function patientCopy(n) {
  const suffix = `-${n}`;
  return template.map((r) =>
    JSON.parse(
      JSON.stringify(r)
        .replace(/"id":"([^"]+)"/g, (_, id) => `"id":"${id.slice(0, 50)}${suffix}"`)
        .replace(/"reference":"([A-Za-z]+)\/([^"]+)"/g, (_, t, id) => `"reference":"${t}/${id}${suffix}"`)
        .replace(/urn:uuid:([0-9a-f-]+)/g, (_, u) => `urn:uuid:${u.slice(0, 24)}${String(n).padStart(12, '0')}`)
        .replace(/MRN-4471902/g, `MRN-${4471902 + n}`),
    ),
  );
}

async function writeBulk(dir, patients) {
  const byType = new Map();
  for (let n = 0; n < patients; n++) {
    for (const r of patientCopy(n)) {
      const lines = byType.get(r.resourceType) ?? [];
      lines.push(JSON.stringify(r));
      byType.set(r.resourceType, lines);
    }
  }
  for (const [type, lines] of byType) await writeFile(join(dir, `${type}.ndjson`), `${lines.join('\n')}\n`);
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function measure(patients) {
  const dir = await mkdtemp(join(tmpdir(), 'fhirbridge-scale-'));
  try {
    await writeBulk(dir, patients);
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    let peak = heapBefore;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 5);
    const t0 = performance.now();
    const loaded = await loadInput(dir);
    const t1 = performance.now();
    const result = pack(loaded, { deid: true, vault: SafeHarborVault.create() });
    const t2 = performance.now();
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    const resources = result.graph.resources.length;
    return {
      patients,
      resources,
      inputMb: mb(loaded.bytes),
      loadMs: Math.round(t1 - t0),
      packMs: Math.round(t2 - t1),
      usPerResource: (((t2 - t0) * 1000) / resources).toFixed(1),
      peakHeapMb: mb(peak - heapBefore),
      reductionPct: result.context.tokens.reductionPct,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rows = [];
for (const patients of SIZES) rows.push(await measure(patients));

const header = ['patients', 'resources', 'inputMb', 'loadMs', 'packMs', 'usPerResource', 'peakHeapMb', 'reductionPct'];
process.stdout.write(`| ${header.join(' | ')} |\n| ${header.map(() => '---:').join(' | ')} |\n`);
for (const r of rows) process.stdout.write(`| ${header.map((h) => r[h]).join(' | ')} |\n`);
process.stdout.write(`\nNode ${process.version}, ${process.platform}/${process.arch}\n`);

// Super-linear guard: per-resource cost at the largest size must stay within 3x of the smallest.
const first = Number(rows[0]?.usPerResource ?? 0);
const last = Number(rows.at(-1)?.usPerResource ?? 0);
if (rows.length > 1 && first > 0 && last / first > 3) {
  process.stderr.write(`per-resource cost grew ${(last / first).toFixed(1)}x from ${SIZES[0]} to ${SIZES.at(-1)} patients\n`);
  process.exitCode = 1;
}
