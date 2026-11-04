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
import { SafeHarborVault } from '../deid/index.js';
import { pack, VERSION, type PackResult } from '../index.js';
import { loadInput } from '../normalizer/index.js';
import type { Resource } from '../types/fhir.js';
import { resourceKey } from '../types/fhir.js';
import type { NormalizedGraph, StatusClass } from '../types/pipeline.js';
import { verify } from '../verifier/index.js';

export interface McpServerOptions {
  bundlePath: string;
  vaultPath?: string;
  passphrase?: string;
  /** Return real (rehydrated) values from verify_and_rehydrate_clinical_draft. Off by default. */
  allowRehydrate?: boolean;
}

interface ServerState {
  result: PackResult & { deidGraph: NormalizedGraph; vault: SafeHarborVault };
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
        'Compact, HIPAA Safe Harbor de-identified clinical context. Every fact ends with a [ResourceType/id] anchor; cite those anchors in answers. Dates are consistently shifted per patient.',
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

function registerAuditTools(server: McpServer, state: ServerState): void {
  const { result } = state;
  server.registerTool(
    'verify_and_rehydrate_clinical_draft',
    {
      title: 'Verify a clinical draft',
      description:
        'Audit every [ResourceType/id] citation in a draft: hallucinated ids, stopped/entered-in-error records described as current, and numbers that do not match the cited observation. Returns the audit report. Real identities are restored only if the server was started with --allow-rehydrate.',
      inputSchema: { draft: z.string().min(1).max(200_000) },
      annotations: { readOnlyHint: true },
    },
    async ({ draft }) => {
      const out = verify(draft, result.graph, state.allowRehydrate ? result.vault : undefined);
      return text(JSON.stringify(out, null, 1));
    },
  );

  server.registerTool(
    'audit_bundle_integrity',
    {
      title: 'Audit EHR data integrity',
      description:
        'Report EHR data problems found during normalization: entered-in-error exclusions, RxNorm code/display conflicts, unresolved references, decoded attachments, plus Safe Harbor and token statistics.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        JSON.stringify(
          {
            excluded: result.graph.excluded,
            warnings: result.graph.warnings.map((w) => ({
              code: w.code,
              resourceKey: w.resourceKey,
              message: w.message,
            })),
            safeHarbor: result.safeHarbor,
            tokens: result.context.tokens,
          },
          null,
          1,
        ),
      ),
  );
}

export async function createMcpServer(opts: McpServerOptions): Promise<McpServer> {
  const vault = opts.vaultPath
    ? await SafeHarborVault.open(opts.vaultPath, { passphrase: opts.passphrase })
    : SafeHarborVault.create();
  const packed = pack(await loadInput(opts.bundlePath), { deid: true, vault });
  if (!packed.deidGraph || !packed.vault) throw new Error('De-identification did not run.');
  if (opts.vaultPath) await vault.save(opts.vaultPath);
  const state: ServerState = {
    result: { ...packed, deidGraph: packed.deidGraph, vault: packed.vault },
    allowRehydrate: opts.allowRehydrate === true,
  };
  const server = new McpServer({ name: 'fhirbridge', version: VERSION });
  registerReadTools(server, state);
  registerAuditTools(server, state);
  return server;
}

/** Start the server on stdio. stdout is the MCP channel; never write logs there. */
export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  const server = await createMcpServer(opts);
  await server.connect(new StdioServerTransport());
}
