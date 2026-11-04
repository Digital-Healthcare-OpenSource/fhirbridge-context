/**
 * FHIRBridge public SDK.
 *
 *   const { context, graph, vault } = await packFile('patient.json', { deid: true });
 *   const { report, rehydrated } = verifyResponse(llmAnswer, graph, vault);
 *
 * Each layer is also importable on its own: `fhirbridge/normalizer`, `fhirbridge/deid`,
 * `fhirbridge/compiler`, `fhirbridge/verifier`.
 */
import { compile } from './compiler/index.js';
import { deidentify, SafeHarborVault } from './deid/index.js';
import { loadInput, normalize } from './normalizer/index.js';
import { estimateTokens } from './shared/token-estimate.js';
import type {
  CitationAuditReport,
  CompiledContext,
  ContextFormat,
  InputEntry,
  IntegrityWarning,
  LoadedInput,
  NormalizedGraph,
  PhiCategory,
  SafeHarborSummary,
  VaultReader,
} from './types/pipeline.js';
import { rehydrate, verify } from './verifier/index.js';

export const VERSION = '0.1.0';

export interface PackOptions {
  /** Apply HIPAA Safe Harbor de-identification (uses `vault`, or a new in-memory vault). */
  deid?: boolean;
  /** Vault for reversible tokens and date shifts. */
  vault?: SafeHarborVault;
  format?: ContextFormat;
  /** Restrict the compiled context to one patient (`Patient/id`). */
  patientKey?: string;
  now?: Date;
}

export interface PackResult {
  context: CompiledContext;
  /** Normalized graph BEFORE de-identification (resource ids are identical; audit against it). */
  graph: NormalizedGraph;
  /** De-identified graph, when `deid` was requested. */
  deidGraph?: NormalizedGraph;
  safeHarbor?: SafeHarborSummary;
  /** The vault used, when `deid` was requested (persist it to rehydrate later). */
  vault?: SafeHarborVault;
}

function toGraph(input: LoadedInput | InputEntry[]): NormalizedGraph {
  if (Array.isArray(input)) {
    const rawText = JSON.stringify(input.map((e) => e.resource));
    return normalize(input, { rawText, inputBytes: Buffer.byteLength(rawText, 'utf8') });
  }
  const warnings = (input as LoadedInput & { warnings?: IntegrityWarning[] }).warnings;
  return normalize(input.entries, { rawText: input.rawText, inputBytes: input.bytes, warnings });
}

/** Layers 1 → 2 → 3 on already-loaded input. */
export function pack(input: LoadedInput | InputEntry[], opts: PackOptions = {}): PackResult {
  const graph = toGraph(input);
  const format = opts.format ?? 'clinical-md';
  if (!opts.deid) {
    const context = compile(graph, { format, now: opts.now, patientKey: opts.patientKey });
    return { context, graph };
  }
  const vault = opts.vault ?? SafeHarborVault.create();
  const { graph: deidGraph, summary } = deidentify(graph, { vault, now: opts.now });
  const context = compile(deidGraph, {
    format,
    now: opts.now,
    patientKey: opts.patientKey,
    safeHarbor: summary,
  });
  return { context, graph, deidGraph, safeHarbor: summary, vault };
}

/** Load a Bundle file, resource array, NDJSON file or Bulk `$export` directory, then pack it. */
export async function packFile(path: string, opts: PackOptions = {}): Promise<PackResult> {
  return pack(await loadInput(path), opts);
}

export interface AuditSummary {
  resourceCounts: Record<string, number>;
  patients: number;
  tokens: { input: number; compiled: number; reductionPct: number };
  phiDetected: number;
  phiByCategory: Partial<Record<PhiCategory, number>>;
  datesShifted: number;
  enteredInError: number;
  codeWarnings: number;
  warnings: IntegrityWarning[];
}

/**
 * Integrity + privacy scan. De-identifies with a throwaway in-memory vault only to count
 * identifiers; nothing is persisted.
 */
export function auditInput(input: LoadedInput | InputEntry[], now?: Date): AuditSummary {
  const result = pack(input, { deid: true, now });
  const resourceCounts: Record<string, number> = {};
  for (const r of result.graph.resources) {
    resourceCounts[r.resourceType] = (resourceCounts[r.resourceType] ?? 0) + 1;
  }
  const phiByCategory = result.safeHarbor?.replacements ?? {};
  const phiDetected = Object.values(phiByCategory).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  return {
    resourceCounts,
    patients: resourceCounts.Patient ?? 0,
    tokens: {
      input: result.graph.stats.inputTokens,
      compiled: result.context.tokens.outputTokens,
      reductionPct: result.context.tokens.reductionPct,
    },
    phiDetected,
    phiByCategory,
    datesShifted: result.safeHarbor?.datesShifted ?? 0,
    enteredInError: result.graph.excluded.length,
    codeWarnings: result.graph.warnings.filter((w) => w.code === 'CODE_DISPLAY_MISMATCH').length,
    warnings: result.graph.warnings,
  };
}

export interface VerifyResponseResult {
  report: CitationAuditReport;
  rehydrated?: string;
}

/** Layer 4: audit an LLM answer against the original graph; rehydrate when a vault is given. */
export function verifyResponse(
  text: string,
  graph: NormalizedGraph,
  vault?: VaultReader,
  opts: { patientKey?: string } = {},
): VerifyResponseResult {
  return verify(text, graph, vault, opts);
}

export { estimateTokens, rehydrate, SafeHarborVault };
export { compile } from './compiler/index.js';
export { compileClinicalMarkdown } from './compiler/narrative-compiler.js';
export { compileViews, toCsv } from './compiler/view-definition.js';
export { deidentify, scrubText } from './deid/index.js';
export { classifyStatus, loadInput, normalize, normalizeFile, parseInput } from './normalizer/index.js';
export { FhirPullError, pullPatient } from './portability/smart-client.js';
export type { PullOptions, PullResult } from './portability/smart-client.js';
export { auditCitations, StreamRehydrator } from './verifier/index.js';
export type * from './types/fhir.js';
export type * from './types/pipeline.js';
