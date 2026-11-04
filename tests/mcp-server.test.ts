/** MCP server driven by a real MCP client over the SDK's in-memory transport. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createMcpServer, restrictTokens } from '../src/mcp/server.js';
import { rehydrate } from '../src/verifier/index.js';
import { fakeVault } from './helpers/manual-graph.js';

const FIXTURE = resolve(__dirname, 'fixtures/synthea-messy-patient.json');
const RAW_PHI = ['Gonzalez', 'Maria', '4471902', '123-45-6789', '555-0142', 'maria.gonzalez@example.com', 'Brattle', '02138'];

let client: Client;

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join('\n');
}

beforeAll(async () => {
  const server = await createMcpServer({ bundlePath: FIXTURE });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe('MCP server', () => {
  it('lists the four tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'audit_bundle_integrity',
      'get_patient_clinical_summary',
      'query_patient_resources',
      'verify_and_rehydrate_clinical_draft',
    ]);
  });

  it('returns a de-identified summary with anchors and no raw PHI', async () => {
    const text = textOf(await client.callTool({ name: 'get_patient_clinical_summary', arguments: {} }));
    expect(text).toContain('De-identified: YES');
    expect(text).not.toMatch(/DateShift/i);
    expect(text).toContain('[MedicationRequest/medreq-104]');
    for (const phi of RAW_PHI) expect(text).not.toContain(phi);
  });

  it('queries resources without leaking PHI or excluded records', async () => {
    const text = textOf(
      await client.callTool({
        name: 'query_patient_resources',
        arguments: { resourceType: 'MedicationRequest', status: 'any', limit: 200 },
      }),
    );
    const rows = JSON.parse(text) as { id: string }[];
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.map((r) => r.id)).not.toContain('medreq-err-99');
    for (const phi of RAW_PHI) expect(text).not.toContain(phi);
  });

  it('audits a draft and does not rehydrate by default', async () => {
    const draft =
      'Patient [PATIENT_1] is currently taking Lisinopril daily [MedicationRequest/medreq-088]. See [Observation/obs-nope].';
    const out = JSON.parse(
      textOf(await client.callTool({ name: 'verify_and_rehydrate_clinical_draft', arguments: { draft } })),
    ) as { report: { ok: boolean; issues: { code: string }[] }; rehydrated?: string };
    expect(out.report.ok).toBe(false);
    expect(out.report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['CRITICAL_STATUS_CONTRADICTION', 'HALLUCINATED_RESOURCE_ID']),
    );
    expect(out.rehydrated).toBeUndefined();
  });

  it('reports integrity problems', async () => {
    const text = textOf(await client.callTool({ name: 'audit_bundle_integrity', arguments: {} }));
    expect(text).toContain('CODE_DISPLAY_MISMATCH');
    expect(text).toContain('MedicationRequest/medreq-err-99');
    for (const phi of RAW_PHI) expect(text).not.toContain(phi);
  });
});

describe('MCP server privacy of warnings and rehydration', () => {
  const REAL_DATE = '2021-03-15';
  let dir: string;
  let bundlePath: string;

  async function connect(allowRehydrate: boolean): Promise<Client> {
    const server = await createMcpServer({ bundlePath, allowRehydrate });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const c = new Client({ name: 'test-client', version: '1.0.0' });
    await c.connect(clientTransport);
    return c;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fhirbridge-mcp-'));
    bundlePath = join(dir, 'bundle.json');
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1', name: [{ family: 'Quartz', given: ['Ignatius'] }], birthDate: '1962-03-14' } },
        {
          // No meta.lastUpdated: the normalizer infers it from effectiveDateTime and warns with the value.
          resource: {
            resourceType: 'Observation',
            id: 'obs-1',
            status: 'final',
            subject: { reference: 'Patient/p1' },
            code: { text: 'Troponin' },
            effectiveDateTime: `${REAL_DATE}T10:30:00Z`,
            valueQuantity: { value: 0.02, unit: 'ng/mL' },
          },
        },
      ],
    };
    await writeFile(bundlePath, JSON.stringify(bundle), 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('never shows the real date of an inferred lastUpdated warning, in any tool output', async () => {
    const c = await connect(false);
    try {
      const resolved = await Promise.all(
        (['clinical-md', 'view-json', 'csv'] as const).map(async (format) =>
          textOf(await c.callTool({ name: 'get_patient_clinical_summary', arguments: { format } })),
        ),
      );
      resolved.push(
        textOf(await c.callTool({ name: 'audit_bundle_integrity', arguments: {} })),
        textOf(
          await c.callTool({
            name: 'query_patient_resources',
            arguments: { resourceType: 'Observation', status: 'any' },
          }),
        ),
        textOf(await c.callTool({ name: 'verify_and_rehydrate_clinical_draft', arguments: { draft: 'ok [Observation/obs-1]' } })),
      );
      for (const out of resolved) expect(out).not.toContain(REAL_DATE);
    } finally {
      await c.close();
    }
  });

  it('rehydrates only when allowed, and only tokens the server has shown', async () => {
    const off = await connect(false);
    try {
      const out = JSON.parse(
        textOf(await off.callTool({ name: 'verify_and_rehydrate_clinical_draft', arguments: { draft: 'Hi [PATIENT_1]' } })),
      ) as { rehydrated?: string };
      expect(out.rehydrated).toBeUndefined();
    } finally {
      await off.close();
    }
    const on = await connect(true);
    try {
      const summary = textOf(await on.callTool({ name: 'get_patient_clinical_summary', arguments: {} }));
      const shown = summary.match(/\[PATIENT_\d+\]/)?.[0];
      expect(shown).toBeDefined();
      const draft = `Hi ${shown ?? ''}.`;
      const out = JSON.parse(
        textOf(await on.callTool({ name: 'verify_and_rehydrate_clinical_draft', arguments: { draft } })),
      ) as { rehydrated: string };
      expect(out.rehydrated).toContain('Quartz');
    } finally {
      await on.close();
    }
  });

  it('restrictTokens resolves only the allowed tokens', () => {
    const vault = fakeVault({ tokens: { '[PATIENT_1]': 'Real Name', '[MRN_7]': 'MRN-1' } });
    const scoped = restrictTokens(vault, new Set(['[PATIENT_1]']));
    expect(scoped.resolveToken('[PATIENT_1]')).toBe('Real Name');
    expect(scoped.resolveToken('[MRN_7]')).toBeUndefined();
    expect(scoped.tokens()).toEqual(['[PATIENT_1]']);
    expect(rehydrate('[PATIENT_1] [MRN_7]', scoped)).toBe('Real Name [MRN_7]');
  });
});

describe('MCP tool-call logging', () => {
  it('logs tool name, outcome and duration but never arguments or results', async () => {
    const lines: string[] = [];
    const logger = createLogger({ format: 'json', level: 'debug', write: (l) => lines.push(l) });
    const server = await createMcpServer({ bundlePath: FIXTURE, logger });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const c = new Client({ name: 'log-test', version: '1.0.0' });
    await c.connect(clientTransport);
    try {
      const draft = 'Zebulon Quartzfield is currently taking Lisinopril [MedicationRequest/medreq-088].';
      await c.callTool({ name: 'verify_and_rehydrate_clinical_draft', arguments: { draft } });
      await c.callTool({ name: 'get_patient_clinical_summary', arguments: {} });
    } finally {
      await c.close();
    }
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === 'mcp.tool');
    expect(events.map((e) => e.tool)).toEqual(['verify_and_rehydrate_clinical_draft', 'get_patient_clinical_summary']);
    for (const e of events) {
      expect(e.ok).toBe(true);
      expect(typeof e.ms).toBe('number');
    }
    const all = lines.join('\n');
    for (const leak of ['Zebulon', 'Lisinopril', 'medreq-088', ...RAW_PHI]) expect(all).not.toContain(leak);
  });
});
