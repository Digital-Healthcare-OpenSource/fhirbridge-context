/** MCP server driven by a real MCP client over the SDK's in-memory transport. */
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';

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
    expect(text).toContain('SafeHarbor: ENABLED');
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
  });
});
