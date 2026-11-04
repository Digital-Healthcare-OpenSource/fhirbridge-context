/**
 * Privacy-by-Design MCP server (stdio) for Claude Desktop, Cursor, OpenCode, …
 *
 * Everything returned to the model comes from the DE-IDENTIFIED graph. Tool results are
 * model input, so rehydrated (real) PHI is never returned unless the operator explicitly
 * starts the server with `allowRehydrate` (meant for fully local models).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { compile } from '../compiler/index.js';
import { safeWarnings } from '../compiler/sections/safe-warnings.js';
import { SafeHarborVault } from '../deid/index.js';
import { pack, VERSION, type PackResult } from '../index.js';
import { loadInput } from '../normalizer/index.js';
import { silentLogger, type Logger } from '../logger.js';
import type { Resource } from '../types/fhir.js';
import { resourceKey } from '../types/fhir.js';
import type { NormalizedGraph, SafeHarborSummary, StatusClass, VaultReader } from '../types/pipeline.js';
import { auditCitations, extractTokens, rehydrate } from '../verifier/index.js';

export interface McpServerOptions {
  bundlePath: string;
  vaultPath?: string;
  passphrase?: string;
  /** Permit a key file next to the vault when no passphrase/key env var is set (off by default). */
  allowKeyFile?: boolean;
  /**
   * Return REAL PHI from verify_and_rehydrate_clinical_draft (only for tokens this server has
   * shown). Off by default; only for models running locally.
   */
  allowRehydrate?: boolean;
  /** Diagnostics sink (stderr). Tool calls are logged by name, outcome and duration — never arguments. */
  logger?: Logger;
}

/** The pre-de-identification graph is deliberately absent: tools must not be able to reach it. */
interface ServerState {
  result: Pick<PackResult, 'context'> & {
    deidGraph: NormalizedGraph;
    vault: SafeHarborVault;
    safeHarbor: SafeHarborSummary;
  };
  shownTokens: ReadonlySet<string>;
  allowRehydrate: boolean;
}

const DATE_FIELDS = [
  'effectiveDateTime',
  'authoredOn',
  'onsetDateTime',
  'recordedDate',
  'performedDateTime',
  'issued',
  'date',
  'whenHandedOver',
] as const;

function primaryDate(r: Resource): string | undefined {
  for (const f of DATE_FIELDS) {
    const v = r[f];
    if (typeof v === 'string') return v;
  }
  const period = (r.period ?? r.effectivePeriod ?? r.performedPeriod) as { start?: string } | undefined;
  return period?.start;
}

interface ConceptLike {
  coding?: { code?: string; display?: string }[];
  text?: string;
}

function codesOf(r: Resource): string[] {
  const out: string[] = [];
  for (const field of ['code', 'medicationCodeableConcept', 'vaccineCode', 'type']) {
    const cc = r[field] as ConceptLike | undefined;
    if (!cc || typeof cc !== 'object') continue;
    for (const c of cc.coding ?? []) {
      if (c.code) out.push(c.code);
      if (c.display) out.push(c.display);
    }
    if (cc.text) out.push(cc.text);
  }
  return out.map((s) => s.toLowerCase());
}

/** Drop transport noise so the model sees clinical content only. */
function slim(r: Resource): Resource {
  const { meta: _meta, text: _text, ...rest } = r;
  return rest as Resource;
}

export interface ResourceQuery {
  resourceType: string;
  code?: string;
  since?: string;
  until?: string;
  status?: 'active' | 'historical' | 'any';
  limit?: number;
}

const STATUS_FILTER: Record<NonNullable<ResourceQuery['status']>, StatusClass[]> = {
  active: ['active', 'unknown'],
  historical: ['historical'],
  any: ['active', 'historical', 'unknown'],
};

/** Filter the (de-identified) graph. Excluded (entered-in-error / refuted) records never match. */
export function queryResources(graph: NormalizedGraph, q: ResourceQuery): Resource[] {
  const wanted = STATUS_FILTER[q.status ?? 'any'];
  const code = q.code?.toLowerCase();
  return graph.resources
    .filter((r) => r.resourceType === q.resourceType)
    .filter((r) => wanted.includes(graph.status.get(resourceKey(r)) ?? 'unknown'))
    .filter((r) => !code || codesOf(r).some((c) => c === code || c.includes(code)))
    .filter((r) => {
      const d = primaryDate(r)?.slice(0, 10);
      if (!d) return !q.since && !q.until;
      return (!q.since || d >= q.since) && (!q.until || d <= q.until);
    })
    .sort((a, b) => (primaryDate(b) ?? '').localeCompare(primaryDate(a) ?? ''))
    .slice(0, q.limit ?? 50)
    .map(slim);
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function registerReadTools(server: McpServer, state: ServerState): void {
  const { result } = state;
  server.registerTool(
    'get_patient_clinical_summary',
    {
      title: 'De-identified clinical summary',
      description:
        'Compact de-identified clinical context (identifiers tokenized, other dates shifted per patient). Every fact ends with a [ResourceType/id] anchor; cite those anchors in answers.',
      inputSchema: {
        format: z.enum(['clinical-md', 'view-json', 'csv']).optional(),
        patientKey: z
          .string()
          .regex(/^Patient\/[A-Za-z0-9\-.]{1,64}$/)
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ format, patientKey }) =>
      text(
        compile(result.deidGraph, {
          format: format ?? 'clinical-md',
          patientKey,
          safeHarbor: result.safeHarbor,
        }).content,
      ),
  );

  server.registerTool(
    'query_patient_resources',
    {
      title: 'Query de-identified FHIR resources',
      description:
        'Return de-identified FHIR resources of one type, optionally filtered by code (system code or display text), shifted-date range (YYYY-MM-DD) and clinical status. entered-in-error / refuted records are never returned.',
      inputSchema: {
        resourceType: z.string().regex(/^[A-Z][A-Za-z]{1,63}$/),
        code: z.string().max(200).optional(),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        status: z.enum(['active', 'historical', 'any']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (q) => text(JSON.stringify(queryResources(result.deidGraph, q), null, 1)),
  );
}

/** A vault view that resolves only tokens the server itself put in front of the model. */
export function restrictTokens(vault: VaultReader, allowed: ReadonlySet<string>): VaultReader {
  return {
    resolveToken: (t) => (allowed.has(t) ? vault.resolveToken(t) : undefined),
    tokens: () => vault.tokens().filter((t) => allowed.has(t)),
    dateShiftDaysFor: (k) => vault.dateShiftDaysFor(k),
    dateShifts: () => vault.dateShifts(),
    shiftedDateWindow: (k) => vault.shiftedDateWindow(k),
    patientKeys: () => vault.patientKeys(),
    emittedShiftedDates: (k) => vault.emittedShiftedDates(k),
    originalResourceKey: (k) => vault.originalResourceKey(k),
  };
}

function registerAuditTools(server: McpServer, state: ServerState): void {
  const { result } = state;
  server.registerTool(
    'verify_and_rehydrate_clinical_draft',
    {
      title: 'Verify a clinical draft',
      description:
        'Audit every [ResourceType/id] citation in a draft: hallucinated ids, stopped/entered-in-error records described as current, and numbers that do not match the cited observation. Returns the audit report. Real identities are restored only if the server was started with --allow-rehydrate, and then only for tokens this server has shown.',
      inputSchema: {
        draft: z.string().min(1).max(200_000),
        patientKey: z
          .string()
          .regex(/^Patient\/[A-Za-z0-9\-.]{1,64}$/)
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ draft, patientKey }) => {
      // Audit in the de-identified frame the model works in; the pre-de-identification graph is never read here.
      const report = auditCitations(draft, result.deidGraph);
      if (!state.allowRehydrate) return text(JSON.stringify({ report }, null, 1));
      const scoped = restrictTokens(result.vault, state.shownTokens);
      return text(JSON.stringify({ report, rehydrated: rehydrate(draft, scoped, { patientKey }) }, null, 1));
    },
  );

  server.registerTool(
    'audit_bundle_integrity',
    {
      title: 'Audit EHR data integrity',
      description:
        'Report EHR data problems found during normalization: entered-in-error exclusions, RxNorm code/display conflicts, unresolved references, decoded attachments, plus de-identification and token statistics (counts only).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    // Built from the de-identified graph only: pre-de-identification warnings carry raw values.
    async () =>
      text(
        JSON.stringify(
          {
            excluded: result.deidGraph.excluded,
            warnings: safeWarnings(result.deidGraph),
            safeHarbor: result.safeHarbor,
            tokens: result.context.tokens,
          },
          null,
          1,
        ),
      ),
  );
}

/** Every PHI token a tool of this server can show the model (all context formats + raw queries). */
function collectShownTokens(deidGraph: NormalizedGraph, safeHarbor: SafeHarborSummary): ReadonlySet<string> {
  const shown = new Set<string>(extractTokens(JSON.stringify(deidGraph.resources)));
  for (const format of ['clinical-md', 'view-json', 'csv'] as const) {
    for (const token of extractTokens(compile(deidGraph, { format, safeHarbor }).content)) shown.add(token);
  }
  return shown;
}

export async function createMcpServer(opts: McpServerOptions): Promise<McpServer> {
  const vault = opts.vaultPath
    ? await SafeHarborVault.open(opts.vaultPath, {
        passphrase: opts.passphrase,
        allowKeyFile: opts.allowKeyFile === true,
      })
    : SafeHarborVault.create();
  const packed = pack(await loadInput(opts.bundlePath), { deid: true, vault });
  if (!packed.deidGraph || !packed.vault || !packed.safeHarbor) throw new Error('De-identification did not run.');
  if (opts.vaultPath) await vault.save(opts.vaultPath);
  const state: ServerState = {
    result: {
      deidGraph: packed.deidGraph,
      vault: packed.vault,
      safeHarbor: packed.safeHarbor,
      context: packed.context,
    },
    shownTokens: collectShownTokens(packed.deidGraph, packed.safeHarbor),
    allowRehydrate: opts.allowRehydrate === true,
  };
  const server = new McpServer({ name: 'fhirbridge', version: VERSION });
  instrumentTools(server, opts.logger ?? silentLogger);
  registerReadTools(server, state);
  registerAuditTools(server, state);
  return server;
}

interface ToolResultLike {
  isError?: boolean;
}

/**
 * Wrap every tool callback registered from now on with timing/outcome logging. Arguments and
 * results are never logged: drafts and resources are model-facing data.
 */
function instrumentTools(server: McpServer, logger: Logger): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const patched = (name: string, config: unknown, cb: (...cbArgs: unknown[]) => unknown): unknown =>
    register(name, config, async (...cbArgs: unknown[]) => {
      const start = performance.now();
      try {
        const result = (await cb(...cbArgs)) as ToolResultLike;
        logger.info('mcp.tool', { tool: name, ok: result?.isError !== true, ms: Math.round(performance.now() - start) });
        return result;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        logger.warn('mcp.tool', {
          tool: name,
          ok: false,
          code: typeof code === 'string' ? code : 'ERROR',
          ms: Math.round(performance.now() - start),
        });
        throw error;
      }
    });
  (server as unknown as { registerTool: typeof patched }).registerTool = patched;
}

/**
 * Start the server on stdio. stdout is the MCP channel; never write logs there.
 * SIGINT/SIGTERM and stdin EOF close the transport cleanly so the host sees a normal exit.
 */
export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  const server = await createMcpServer(opts);
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = (reason: string): void => {
    if (closing) return;
    closing = true;
    logger.info('mcp.shutdown', { reason });
    void server.close().finally(() => {
      process.exitCode = process.exitCode ?? 0;
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.stdin.once('end', () => shutdown('stdin-closed'));
  await server.connect(transport);
  logger.info('mcp.ready', { tools: 4, rehydrate: opts.allowRehydrate === true });
}
