/**
 * End-to-end acceptance tests: the six behaviours FHIRBridge promises, exercised through
 * the public SDK (all four layers, no mocks).
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditCitations,
  loadInput,
  normalize,
  pack,
  packFile,
  rehydrate,
  SafeHarborVault,
  scrubText,
  StreamRehydrator,
} from '../src/index.js';
import { shiftFhirDate } from '../src/shared/fhir-date.js';
import type { Encounter, InputEntry, Observation, Resource } from '../src/index.js';

const FIXTURE = resolve(__dirname, 'fixtures/synthea-messy-patient.json');
const NOW = new Date('2026-11-04T00:00:00Z');
const MASTER_KEY = Buffer.alloc(32, 7);

const entries = (...resources: Resource[]): InputEntry[] => resources.map((resource) => ({ resource }));
const patient = (id: string, extra: Partial<Resource> = {}): Resource => ({
  resourceType: 'Patient',
  id,
  name: [{ family: 'Doe', given: ['John'] }],
  birthDate: '1960-01-01',
  ...extra,
});
const subject = (id: string) => ({ reference: `Patient/${id}` });
const medRequest = (id: string, status: string, display: string, code: string): Resource => ({
  resourceType: 'MedicationRequest',
  id,
  status,
  intent: 'order',
  medicationCodeableConcept: {
    coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code, display }],
  },
  subject: subject('p1'),
  authoredOn: '2025-05-01',
});

describe('FHIRBridge end-to-end', () => {
  it('test_token_compression_and_reference_resolution', async () => {
    const { context, graph } = await packFile(FIXTURE, { deid: true, now: NOW });

    // 50 MedicationRequests reference Medication/med-1 three different ways; the name is resolved.
    expect(context.content).not.toMatch(/Unknown medication|name not recorded/i);
    expect(context.content).toMatch(/Metformin 500 MG.*Refills consolidated: 50.*\[MedicationRequest\/medreq-104\]/);
    // Base64 HTML DocumentReference decoded to clean text (tags gone, content kept).
    expect(context.content).toContain('Foley catheter removed');
    expect(context.content).not.toMatch(/<p>|<\/html>|PGh0bWw/);
    // Bloated narratives and 30 duplicate-LOINC results collapse into one table row.
    expect(context.content.match(/\| HbA1c \(4548-4\)/g)).toHaveLength(1);
    expect(graph.stats.inputTokens).toBeGreaterThan(40_000);
    expect(context.tokens.reductionPct).toBeGreaterThan(85);
  });

  it('test_patient_scoped_date_shift_and_reversal', () => {
    const vault = SafeHarborVault.create({ masterKey: MASTER_KEY });
    const input = entries(
      patient('p1'),
      {
        resourceType: 'Encounter',
        id: 'enc-1',
        status: 'finished',
        subject: subject('p1'),
        period: { start: '2026-05-10T10:00:00Z' },
      },
      {
        resourceType: 'Observation',
        id: 'obs-1',
        status: 'final',
        code: { text: 'Troponin' },
        subject: subject('p1'),
        effectiveDateTime: '2026-05-12T10:00:00Z',
        valueQuantity: { value: 0.02, unit: 'ng/mL' },
      },
    );
    const { deidGraph } = pack(input, { deid: true, vault, now: NOW });
    const enc = deidGraph?.index.get('Encounter/enc-1') as Encounter & { period: { start: string } };
    const obs = deidGraph?.index.get('Observation/obs-1') as Observation & { effectiveDateTime: string };

    const shift = vault.dateShiftDaysFor('Patient/p1') ?? 0;
    expect(shift).toBeGreaterThanOrEqual(-365);
    expect(shift).toBeLessThanOrEqual(-2);
    expect(enc.period.start).toBe(shiftFhirDate('2026-05-10T10:00:00Z', shift));
    expect(obs.effectiveDateTime).toBe(shiftFhirDate('2026-05-12T10:00:00Z', shift));
    // Same Δt on both resources: the 48h 00m interval survives exactly.
    expect(Date.parse(obs.effectiveDateTime) - Date.parse(enc.period.start)).toBe(48 * 3_600_000);

    const llm = `Admitted ${enc.period.start.slice(0, 10)}; troponin drawn ${obs.effectiveDateTime.slice(0, 10)}.`;
    expect(rehydrate(llm, vault)).toBe('Admitted 2026-05-10; troponin drawn 2026-05-12.');
  });

  it('test_eponym_and_clinical_fraction_protection', () => {
    const vault = SafeHarborVault.create({ masterKey: MASTER_KEY });
    const note =
      "Patient John Doe (MRN-998877, ZIP 03601, DOB 1930-01-01) has Parkinson's disease and Hodgkin lymphoma. " +
      'Placed Foley catheter and Swan-Ganz line on Perindopril. Prostate biopsy showed 2/12 cores positive and motor strength 4/5.';
    const { text } = scrubText(note, { vault, now: NOW, dateShiftDays: -100 });

    expect(text).toContain('[PATIENT_1]');
    expect(text).toContain('[MRN_1]');
    expect(text).toContain('00000');
    expect(text).toContain('90+');
    for (const kept of ["Parkinson's", 'Hodgkin', 'Foley', 'Swan-Ganz', 'Perindopril', '2/12 cores', '4/5']) {
      expect(text).toContain(kept);
    }
    for (const leaked of ['John', 'Doe', '998877', '03601', '1930']) expect(text).not.toContain(leaked);
    expect(text).not.toMatch(/\[PERSON_\d+\]/);
  });

  it('test_status_gate_and_rxnorm_code_linter', () => {
    const input = entries(
      patient('p1'),
      medRequest('mr-active', 'active', 'Metformin 500 MG Oral Tablet', '861007'),
      medRequest('mr-stopped', 'stopped', 'Lisinopril 10 MG Oral Tablet', '314076'),
      medRequest('mr-error', 'entered-in-error', 'Aspirin 81 MG Oral Tablet', '243670'),
      medRequest('mr-bad', 'active', 'Tiotropium 18 MCG', '1116634'),
    );
    const { context, graph } = pack(input, { now: NOW });
    const md = context.content;
    const active = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'));
    const stopped = md.slice(md.indexOf('## 5.'), md.indexOf('## ', md.indexOf('## 5.') + 4));

    expect(active).toContain('[MedicationRequest/mr-active]');
    expect(active).not.toContain('Lisinopril');
    expect(stopped).toContain('Lisinopril');
    expect(stopped).toContain('[MedicationRequest/mr-stopped]');
    // entered-in-error never appears as a medication, only as an integrity warning.
    expect(active + stopped).not.toContain('Aspirin');
    expect(graph.excluded).toEqual(['MedicationRequest/mr-error']);
    expect(md).toMatch(/EXCLUDED: 1 resource.*\[MedicationRequest\/mr-error\]/);
    expect(md).toMatch(/CODE WARNING: \[MedicationRequest\/mr-bad\].*1116634.*ticagrelor/);
  });

  it('test_citation_verifier_catches_hallucinations_and_status_contradictions', () => {
    const graph = normalize(
      entries(
        patient('p1'),
        medRequest('medreq-active-1', 'active', 'Metformin 500 MG Oral Tablet', '861007'),
        medRequest('medreq-stopped-2', 'stopped', 'Lisinopril 10 MG Oral Tablet', '314076'),
      ),
    );
    const answer = [
      'The patient continues metformin 500 mg twice daily [MedicationRequest/medreq-active-1].',
      'Patient is currently taking Lisinopril 10mg daily [MedicationRequest/medreq-stopped-2].',
      'Her latest potassium was 4.1 [Observation/obs-fake-999].',
    ].join(' ');
    const report = auditCitations(answer, graph);

    expect(report.ok).toBe(false);
    const byCitation = (c: string) => report.issues.filter((i) => i.citation === c).map((i) => i.code);
    expect(byCitation('MedicationRequest/medreq-active-1')).toEqual([]);
    expect(byCitation('MedicationRequest/medreq-stopped-2')).toContain('CRITICAL_STATUS_CONTRADICTION');
    expect(byCitation('Observation/obs-fake-999')).toContain('HALLUCINATED_RESOURCE_ID');
  });

  it('test_sse_streaming_rehydrator_split_tokens', () => {
    const vault = SafeHarborVault.create({ masterKey: MASTER_KEY });
    const shift = vault.assignDateShift('Patient/p1', 'p1');
    // Choose the real admission date so that its shifted form is exactly 2026-01-15.
    const realAdmission = shiftFhirDate('2026-01-15', -shift);
    pack(
      entries(patient('p1'), {
        resourceType: 'Encounter',
        id: 'enc-1',
        status: 'finished',
        subject: subject('p1'),
        period: { start: realAdmission },
      }),
      { deid: true, vault, now: NOW },
    );
    expect(vault.resolveToken('[PATIENT_1]')).toMatch(/John Doe|Doe, John/);

    const stream = new StreamRehydrator(vault);
    const chunks = ['Patient [PAT', 'IENT_1] was ', 'admitted on 2026-', '01-15.'];
    const output = chunks.map((c) => stream.push(c)).join('') + stream.end();

    expect(output).toBe(`Patient ${vault.resolveToken('[PATIENT_1]')} was admitted on ${realAdmission}.`);
    expect(output).not.toContain('[PAT');
  });

  it('loads the fixture as a Bundle with every trap present', async () => {
    const loaded = await loadInput(FIXTURE);
    expect(loaded.source).toBe('bundle');
    const graph = normalize(loaded.entries, { rawText: loaded.rawText, inputBytes: loaded.bytes });
    const kinds = new Set(graph.warnings.map((w) => w.code));
    for (const code of [
      'EXCLUDED_ENTERED_IN_ERROR',
      'CODE_DISPLAY_MISMATCH',
      'ID_SHORTENED',
      'ATTACHMENT_DECODED',
      'BINARY_ATTACHMENT_STRIPPED',
    ]) {
      expect(kinds).toContain(code);
    }
  });
});
