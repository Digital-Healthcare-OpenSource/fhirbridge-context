import type { Resource } from '../types/fhir.js';
import type { CompileOptions, CompiledContext, NormalizedGraph } from '../types/pipeline.js';
import { compileClinicalMarkdown } from './narrative-compiler.js';
import { AGE_EXTENSION_URL, BINARY_MARKER_RE, BINARY_OMITTED, hideBinaryMarkers } from './sections/util.js';
import { buildTokenReport } from './token-estimator.js';
import { compileViews, toCsv } from './view-definition.js';

export * from './narrative-compiler.js';
export * from './token-estimator.js';
export * from './view-definition.js';

const NOISE_KEYS = new Set(['meta', 'extension', 'modifierExtension']);

/**
 * Drop FHIR bookkeeping noise: meta, extensions (except the recorded age), primitive extensions
 * (`_birthDate`), generated narrative (`text.div`) and attachment hashes / binary markers (a
 * payload hash would let a model confirm guesses about a stripped attachment).
 */
export function slimResource<T>(value: T): T {
  return slim(value) as T;
}

function slim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slim);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  const isAttachment = 'contentType' in value;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('_') || (isAttachment && key === 'hash')) continue;
    if (typeof child === 'string' && BINARY_MARKER_RE.test(child)) {
      out[key] = BINARY_OMITTED;
      continue;
    }
    if (key === 'extension' && Array.isArray(child)) {
      // The recorded age is the only clinical signal left for age-capped patients.
      const ages = child.filter((e: unknown) => (e as { url?: unknown } | null)?.url === AGE_EXTENSION_URL);
      if (ages.length > 0) out[key] = ages;
      continue;
    }
    if (NOISE_KEYS.has(key)) continue;
    if (key === 'text' && typeof child === 'object' && child !== null && 'div' in child) continue;
    out[key] = slim(child);
  }
  return out;
}

function slimResources(graph: NormalizedGraph, patientKey?: string): Resource[] {
  return graph.resources
    .filter((r) => {
      const key = `${r.resourceType}/${r.id ?? ''}`;
      if (graph.status.get(key) === 'excluded') return false;
      return patientKey === undefined || graph.patientOf.get(key) === patientKey;
    })
    .map((r) => slim(r) as Resource);
}

function render(graph: NormalizedGraph, opts: CompileOptions): string {
  switch (opts.format) {
    case 'clinical-md':
      return compileClinicalMarkdown(graph, opts);
    case 'view-json':
      return JSON.stringify(compileViews(graph, opts), null, 2);
    case 'csv': {
      const tables = compileViews(graph, opts);
      return Object.entries(tables)
        .map(([name, rows]) => `## ${name}\n${toCsv(rows)}\n`)
        .join('\n');
    }
    case 'fhir-slim':
      return JSON.stringify(slimResources(graph, opts.patientKey));
  }
}

/** Compile a normalized graph into one of the four context formats, with a token report. */
export function compile(graph: NormalizedGraph, opts: CompileOptions): CompiledContext {
  // Final backstop: whichever section rendered a value, a marker (it embeds a payload hash) never leaves.
  const content = hideBinaryMarkers(render(graph, opts));
  return {
    format: opts.format,
    content,
    tokens: buildTokenReport(graph.stats.inputTokens, content),
  };
}
