import { describe, expect, it } from 'vitest';
import type { Resource } from '../src/types/fhir.js';
import type { SafeHarborSummary } from '../src/types/pipeline.js';
import {
  buildTokenReport,
  compile,
  compileClinicalMarkdown,
  compileViews,
  getReferenceKey,
  getResourceKey,
  toCsv,
} from '../src/compiler/index.js';
import { buildGraph, labObservation, medRequest, patient } from './helpers/manual-graph.js';

const NOW = new Date('2026-11-04T00:00:00Z');
const SAFE_HARBOR: SafeHarborSummary = {
  enabled: true,
  replacements: {},
  datesShifted: 0,
  patientsShifted: 1,
  agesCapped: 0,
  zip3Restricted: 0,
  zip3Generalized: 0,
  rulesApplied: [],
};

const AGE_EXT = 'https://fhirbridge.dev/fhir/StructureDefinition/age-at-deidentification';
const RXNORM ='http://www.nlm.nih.gov/research/umls/rxnorm';
const ref = { reference: 'Patient/pat-1' };

function clinicalResources(): Resource[] {
  const refills = [101, 102, 103, 104, 105, 106].map((n, i) =>
    medRequest(`medreq-${n}`, { authoredOn: `2025-0${i + 2}-12` }),
  );
  return [
    patient(),
    {
      resourceType: 'AllergyIntolerance',
      id: 'alg-1',
      patient: ref,
      criticality: 'high',
      clinicalStatus: { coding: [{ code: 'active' }] },
      code: { text: 'Penicillin' },
      reaction: [{ manifestation: [{ text: 'Anaphylaxis' }] }],
    },
    {
      resourceType: 'Condition',
      id: 'cond-1',
      subject: ref,
      clinicalStatus: { coding: [{ code: 'active' }] },
      code: { text: 'Type 2 diabetes mellitus without complication', coding: [{ system: 'http://snomed.info/sct', code: '44054006' }] },
      onsetDateTime: '2019-06-11',
    },
    {
      resourceType: 'Condition',
      id: 'cond-old',
      subject: ref,
      clinicalStatus: { coding: [{ code: 'resolved' }] },
      code: { text: 'Acute bronchitis', coding: [{ system: 'http://snomed.info/sct', code: '10509002' }] },
      onsetDateTime: '2018-01-02',
    },
    ...refills,
    medRequest('medreq-088', {
      status: 'stopped',
      authoredOn: '2025-04-02',
      statusReason: { text: 'Dry cough' },
      medicationCodeableConcept: {
        text: 'Lisinopril 10 MG Oral Tablet',
        coding: [{ system: RXNORM, code: '314076', display: 'Lisinopril 10 MG Oral Tablet' }],
      },
      dosageInstruction: [{ text: '1 tablet daily' }],
    }),
    medRequest('medreq-err-99', {
      status: 'entered-in-error',
      medicationCodeableConcept: { text: 'Aspirin 81 MG', coding: [{ system: RXNORM, code: '243670', display: 'Aspirin 81 MG' }] },
    }),
    labObservation('obs-299', 8.4, '2025-02-11'),
    labObservation('obs-300', 8.1, '2025-05-09'),
    labObservation('obs-301', 7.8, '2025-08-10', { interpretation: [{ coding: [{ code: 'H' }] }] }),
    {
      resourceType: 'DocumentReference',
      id: 'doc-12',
      status: 'current',
      subject: ref,
      date: '2025-08-10',
      type: { text: 'Progress Note' },
      author: [{ display: '[PROVIDER_1]' }],
    },
    { resourceType: 'Encounter', id: 'enc-1', status: 'finished', subject: ref, class: { code: 'AMB' }, period: { start: '2025-08-10' } },
    { resourceType: 'Procedure', id: 'proc-1', status: 'completed', subject: ref, code: { text: 'Foley catheter removal' }, performedDateTime: '2025-08-09' },
  ];
}

function clinicalGraph() {
  return buildGraph(clinicalResources(), {
    documents: [
      {
        resourceKey: 'DocumentReference/doc-12',
        contentType: 'text/plain',
        text: 'Pt [PATIENT_1] presents for f/u.\n\nProstate biopsy showed 2/12 cores positive.',
        chunks: [],
        truncated: false,
        sourceSizeBytes: 80,
        sha256: 'x',
      },
    ],
    warnings: [
      { code: 'EXCLUDED_ENTERED_IN_ERROR', resourceKey: 'MedicationRequest/medreq-err-99', message: 'excluded' },
      {
        code: 'CODE_DISPLAY_MISMATCH',
        resourceKey: 'MedicationRequest/medreq-bad-1',
        message: 'mismatch',
        details: { display: 'Tiotropium 18 MCG', rxcui: '1116634', rxnormName: 'ticagrelor' },
      },
    ],
  });
}

const compileMd = (graph = clinicalGraph(), extra: Partial<Parameters<typeof compileClinicalMarkdown>[1]> = {}) =>
  compileClinicalMarkdown(graph, { format: 'clinical-md', now: NOW, ...extra });

describe('clinical-md compiler', () => {
  it('prints De-identified: YES in the header and never a date offset', () => {
    const md = compileMd(clinicalGraph(), { safeHarbor: SAFE_HARBOR, version: '0.1.0' });
    expect(md.split('\n')[0]).toBe('# CLINICAL SUMMARY CONTEXT (FHIRBridge v0.1.0 | De-identified: YES)');
  });

  it('prints De-identified: NO otherwise', () => {
    expect(compileMd().split('\n')[0]).toBe('# CLINICAL SUMMARY CONTEXT (FHIRBridge v0.1.0 | De-identified: NO)');
  });

  it('never renders a date offset or the word DateShift in any output format', () => {
    const graph = clinicalGraph();
    for (const format of ['clinical-md', 'view-json', 'csv', 'fhir-slim'] as const) {
      const { content } = compile(graph, { format, now: NOW, safeHarbor: SAFE_HARBOR });
      expect(content, format).not.toMatch(/DateShift/i);
      expect(content, format).not.toMatch(/-?142\s*d\b/);
    }
  });

  it('emits sections in spec order', () => {
    const md = compileMd();
    const headings = md.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(0, 5));
    expect(headings).toEqual(['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 6b', '## 6c', '## 7.', '## 8.']);
    expect(md).toContain('## 1. Patient Demographics [Patient/pat-1]');
  });

  it('renders demographics with age, DOB, ZIP and MRN', () => {
    expect(compileMd()).toContain(
      '- Name: [PATIENT_1] | Gender: female | Age: 64 (DOB: 1962-03-14) | ZIP: 021XX | MRN: [MRN_1] [Patient/pat-1]',
    );
  });

  it('shows recorded age and birth year, never a full DOB, when de-identified', () => {
    const deid = patient({ birthDate: '1962', extension: [{ url: AGE_EXT, valueString: '64' }] });
    const md = compileMd(buildGraph([deid]), { safeHarbor: SAFE_HARBOR });
    expect(md).toContain('Age: 64 | Birth year: 1962');
    expect(md).not.toContain('DOB');
  });

  it('cuts a leaked full birth date down to the year in de-identified output', () => {
    const md = compileMd(buildGraph([patient()]), { safeHarbor: SAFE_HARBOR });
    expect(md).toContain('Birth year: 1962');
    expect(md).not.toContain('1962-03-14');
    const views = compile(buildGraph([patient()]), { format: 'view-json', now: NOW, safeHarbor: SAFE_HARBOR });
    expect(views.content).not.toContain('1962-03-14');
  });

  it('prints Age: 90+ and no birth year for age-capped patients', () => {
    const capped = patient({ birthDate: undefined, extension: [{ url: AGE_EXT, valueString: '90+' }] });
    const md = compileMd(buildGraph([capped]), { safeHarbor: SAFE_HARBOR });
    expect(md).toContain('Age: 90+');
    expect(md).not.toContain('Birth year');
    expect(md).not.toContain('DOB');
    const row = compileViews(buildGraph([capped]), { now: NOW, safeHarbor: SAFE_HARBOR }).patient_demographics[0];
    expect(row).toMatchObject({ age: '90+', birth_date: null });
  });

  it('keeps the full DOB when the output is not de-identified', () => {
    const md = compileMd(buildGraph([patient()]));
    expect(md).toContain('Age: 64 (DOB: 1962-03-14)');
  });

  it('keeps the age extension in fhir-slim output', () => {
    const capped = patient({ birthDate: undefined, extension: [{ url: AGE_EXT, valueString: '90+' }, { url: 'x', valueString: 'drop' }] });
    const { content } = compile(buildGraph([capped]), { format: 'fhir-slim', now: NOW, safeHarbor: SAFE_HARBOR });
    expect(content).toContain('90+');
    expect(content).not.toContain('drop');
  });

  it('renders section 8 from allow-listed warning fields only', () => {
    const graph = buildGraph([patient(), medRequest('medreq-bad-1')], {
      warnings: [
        {
          code: 'CODE_DISPLAY_MISMATCH',
          resourceKey: 'MedicationRequest/medreq-bad-1',
          message: 'mismatch',
          details: { display: 'Tiotropium 18 MCG', code: '1116634', expected: 'ticagrelor', leak: 'Gonzalez 1962-03-14' },
        },
        { code: 'LAST_UPDATED_INFERRED', resourceKey: 'Observation/o1', message: 'inferred', details: { at: '2021-03-15' } },
      ],
    });
    const md = compileMd(graph, { safeHarbor: SAFE_HARBOR });
    expect(md).toContain('CODE WARNING: [MedicationRequest/medreq-bad-1] display "Tiotropium 18 MCG" conflicts with RxCUI 1116634 ("ticagrelor")');
    expect(md).not.toContain('Gonzalez');
    expect(md).not.toContain('2021-03-15');
  });

  it('lists allergies and conditions, keeping resolved conditions apart', () => {
    const md = compileMd();
    expect(md).toContain('- Penicillin (High criticality, Anaphylaxis) — Active [AllergyIntolerance/alg-1]');
    expect(md).toContain(
      '- Type 2 diabetes mellitus without complication [SNOMED: 44054006] (Onset: 2019-06-11, Active) [Condition/cond-1]',
    );
    const [active, past] = md.split('### Resolved / Past Conditions');
    expect(active).not.toContain('cond-old');
    expect(past).toContain('Acute bronchitis');
  });

  it('consolidates refills into one active line anchored on the latest resource', () => {
    const md = compileMd();
    const lines = md.split('\n').filter((l) => l.startsWith('- Metformin'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '- Metformin 500 MG Oral Tablet [RxNorm: 861007] — 1 tablet twice daily (Authored: 2025-07-12, Status: active, Refills consolidated: 6) [MedicationRequest/medreq-106]',
    );
  });

  it('separates discontinued meds and keeps entered-in-error out of every medication list', () => {
    const md = compileMd();
    const active = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'));
    const stopped = md.slice(md.indexOf('## 5.'), md.indexOf('## 6.'));
    expect(active).not.toContain('Lisinopril');
    expect(active).not.toContain('Aspirin');
    expect(stopped).toContain('(DO NOT TREAT AS ACTIVE)');
    expect(stopped).toContain(
      '- Lisinopril 10 MG Oral Tablet [RxNorm: 314076] — Status: stopped (2025-04-02, Reason: Dry cough) [MedicationRequest/medreq-088]',
    );
    expect(stopped).not.toContain('Aspirin');
    const warnings = md.slice(md.indexOf('## 8.'));
    expect(warnings).toContain(
      "- EXCLUDED: 1 resource(s) with status='entered-in-error' ([MedicationRequest/medreq-err-99]: Aspirin 81 MG)",
    );
    expect(warnings).toContain(
      '- CODE WARNING: [MedicationRequest/medreq-bad-1] display "Tiotropium 18 MCG" conflicts with RxCUI 1116634 ("ticagrelor").',
    );
    expect(md.replace(warnings, '')).not.toContain('Aspirin');
  });

  it('groups labs by LOINC with a chronological trend and HIGH flag', () => {
    const md = compileMd();
    expect(md).toContain(
      '| Metric (LOINC) | Latest Value | Date | Reference Range | Historical Trend (Chronological) | Source Anchor |',
    );
    expect(md).toContain(
      '| HbA1c (4548-4) | 7.8 % (HIGH) | 2025-08-10 | 4 - 5.6 % | 8.4% (2025-02-11) -> 8.1% (2025-05-09) -> 7.8% (2025-08-10) | [Observation/obs-301] |',
    );
  });

  it('caps the trend at the last 6 points', () => {
    const obs = Array.from({ length: 9 }, (_, i) => labObservation(`o${i}`, 5 + i, `2025-0${i + 1}-01`));
    const md = compileMd(buildGraph([patient(), ...obs]));
    const row = md.split('\n').find((l) => l.startsWith('| HbA1c')) ?? '';
    expect(row.match(/->/g)).toHaveLength(5);
    expect(row).not.toContain('5% (2025-01-01)');
  });

  it('expands panel children reachable only through members', () => {
    const child = labObservation('obs-child', 6.5, '2025-03-01');
    const panel: Resource = { resourceType: 'DiagnosticReport', id: 'dr-1', status: 'final', subject: ref, result: [{ reference: 'Observation/obs-child' }] };
    const graph = buildGraph([patient(), panel, child]);
    graph.patientOf.delete('Observation/obs-child');
    const md = compileMd(graph, { patientKey: 'Patient/pat-1' });
    expect(md).toContain('[Observation/obs-child]');
  });

  it('renders decoded documents on one line with author and anchor', () => {
    expect(compileMd()).toContain(
      '- [2025-08-10] Progress Note by [PROVIDER_1]: Pt [PATIENT_1] presents for f/u. Prostate biopsy showed 2/12 cores positive. [DocumentReference/doc-12]',
    );
  });

  it('ends every clinical fact line with a ResourceType/id anchor', () => {
    const md = compileMd();
    const facts = md.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- EXCLUDED') && !l.startsWith('- CODE WARNING'));
    expect(facts.length).toBeGreaterThan(8);
    for (const line of facts) expect(line).toMatch(/\[[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]+\]$/);
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Metric') && !l.startsWith('| :---'));
    for (const row of rows) expect(row).toMatch(/\[[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]+\] \|$/);
  });

  it('is deterministic and independent of resource order', () => {
    const a = compileMd(buildGraph(clinicalResources()));
    const b = compileMd(buildGraph([...clinicalResources()].reverse()));
    expect(b).toBe(a);
  });

  it('skips empty sections and falls back to resolved medication names', () => {
    const md = compileMd(buildGraph([patient(), medRequest('m1', { medicationCodeableConcept: undefined, medicationReference: { reference: 'Medication/med-1' } }), { resourceType: 'Medication', id: 'med-1', code: { text: 'Amlodipine 5 MG' } }]));
    expect(md).not.toContain('## 2.');
    expect(md).not.toContain('Unknown medication');
    expect(md).toContain('Amlodipine 5 MG');
  });

  it('restricts output to the requested patient', () => {
    const other = patient({ id: 'pat-2' });
    const otherMed = medRequest('m-other', { subject: { reference: 'Patient/pat-2' } });
    const md = compileMd(buildGraph([patient(), other, otherMed, medRequest('m-mine')]), { patientKey: 'Patient/pat-1' });
    expect(md).toContain('m-mine');
    expect(md).not.toContain('m-other');
    expect(md).not.toContain('pat-2');
  });
});

describe('token reduction', () => {
  it('buildTokenReport computes reduction and cost', () => {
    const report = buildTokenReport(1000, 'x'.repeat(400));
    expect(report).toMatchObject({ inputTokens: 1000, outputTokens: 100, reductionPct: 90, estimatedCostSavedUsd: 0.0027 });
  });

  it('reaches at least 85% reduction on a bloated bundle', () => {
    const bloat = '<div xmlns="http://www.w3.org/1999/xhtml">' + '<p>Generated narrative table row</p>'.repeat(60) + '</div>';
    const meds = Array.from({ length: 50 }, (_, i) =>
      medRequest(`mr-${i}`, {
        authoredOn: `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
        text: { status: 'generated', div: bloat },
        meta: { lastUpdated: '2025-01-01T00:00:00Z', source: 'ehr-export', versionId: String(i) },
        extension: [{ url: 'http://example.org/x', valueString: 'noise'.repeat(20) }],
      }),
    );
    const labs = Array.from({ length: 30 }, (_, i) =>
      labObservation(`ob-${i}`, 6 + (i % 5) / 10, `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`, {
        text: { status: 'generated', div: bloat },
      }),
    );
    const graph = buildGraph([patient({ text: { status: 'generated', div: bloat } }), ...meds, ...labs]);
    const out = compile(graph, { format: 'clinical-md', now: NOW });
    expect(out.tokens.inputTokens).toBe(graph.stats.inputTokens);
    expect(out.tokens.reductionPct).toBeGreaterThanOrEqual(85);
    expect(out.content.match(/Refills consolidated: 50/g)).toHaveLength(1);
  });
});

describe('view tables', () => {
  const graph = clinicalGraph();
  const tables = compileViews(graph, { now: NOW });

  it('gives every row resource_key and subject_key', () => {
    for (const rows of Object.values(tables)) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.resource_key).toMatch(/^[A-Z][A-Za-z]+\/.+/);
        expect(row.subject_key).toBe('Patient/pat-1');
      }
    }
  });

  it('projects only current rows and resolves medication names', () => {
    expect(tables.active_conditions.map((r) => r.resource_key)).toEqual(['Condition/cond-1']);
    expect(tables.active_conditions[0]).toMatchObject({ code: '44054006', onset: '2019-06-11' });
    const keys = tables.active_medications.map((r) => r.resource_key);
    expect(keys).not.toContain('MedicationRequest/medreq-088');
    expect(keys).not.toContain('MedicationRequest/medreq-err-99');
    expect(tables.active_medications[0]).toMatchObject({ medication: 'Metformin 500 MG Oral Tablet', rxnorm: '861007' });
    expect(tables.lab_observations.map((r) => r.value)).toEqual([8.4, 8.1, 7.8]);
    expect(tables.patient_demographics[0]).toMatchObject({ age: 64, postal_code: '021XX' });
  });

  it('resolves keys and references', () => {
    expect(getResourceKey({ resourceType: 'Patient', id: 'p' })).toBe('Patient/p');
    expect(getReferenceKey({ reference: 'http://x.org/fhir/Patient/pat-1' }, graph)).toBe('Patient/pat-1');
    expect(getReferenceKey('urn:uuid:abc')).toBeNull();
    expect(getReferenceKey(undefined)).toBeNull();
  });

  it('quotes CSV per RFC 4180', () => {
    const csv = toCsv([{ a: 'x,y', b: 'say "hi"', c: 'line1\nline2', d: null, e: 3 }]);
    expect(csv).toBe('a,b,c,d,e\n"x,y","say ""hi""","line1\nline2",,3');
    expect(toCsv([])).toBe('');
  });
});

describe('compile() formats', () => {
  const graph = clinicalGraph();

  it('view-json is 2-space JSON of the four tables', () => {
    const out = compile(graph, { format: 'view-json', now: NOW });
    expect(Object.keys(JSON.parse(out.content))).toEqual(['patient_demographics', 'active_conditions', 'active_medications', 'lab_observations']);
    expect(out.content).toContain('\n  "patient_demographics"');
  });

  it('csv emits one titled block per table', () => {
    const out = compile(graph, { format: 'csv', now: NOW });
    expect(out.content).toContain('## lab_observations\nresource_key,subject_key,loinc');
    expect(out.format).toBe('csv');
  });

  it('fhir-slim drops excluded resources and meta/text/extension noise', () => {
    const noisy = buildGraph([
      patient({ meta: { versionId: '1' }, text: { status: 'generated', div: '<div>x</div>' }, extension: [{ url: 'u' }] }),
      medRequest('ok'),
      medRequest('bad', { status: 'entered-in-error' }),
    ]);
    const out = compile(noisy, { format: 'fhir-slim' });
    expect(out.content).not.toContain('"meta"');
    expect(out.content).not.toContain('"div"');
    expect(out.content).not.toContain('"extension"');
    expect(out.content).not.toContain('"bad"');
    expect(out.content).toContain('"text":"Metformin 500 MG Oral Tablet"');
    expect(out.content).not.toContain('\n');
  });

  describe('binary attachment markers', () => {
    const HASH = 'a'.repeat(64);
    const MARKER = `[BINARY_ATTACHMENT: application/pdf, 6, sha256:${HASH}]`;
    const withMarkers = () =>
      buildGraph([
        patient(),
        {
          resourceType: 'DocumentReference',
          id: 'd1',
          status: 'current',
          subject: ref,
          content: [{ attachment: { contentType: 'application/pdf', size: 6, hash: HASH, title: MARKER } }],
        },
        {
          resourceType: 'Condition',
          id: 'c1',
          clinicalStatus: { coding: [{ code: 'active' }] },
          subject: ref,
          code: { text: `Scan ${MARKER}` },
          note: [{ text: `see ${MARKER}` }],
        },
      ]);

    it('never prints payload hashes or markers in any format', () => {
      for (const format of ['clinical-md', 'view-json', 'csv', 'fhir-slim'] as const) {
        const { content } = compile(withMarkers(), { format, now: NOW });
        expect(content, format).not.toContain(HASH);
        expect(content, format).not.toContain('BINARY_ATTACHMENT');
        expect(content, format).not.toMatch(/sha256/i);
      }
    });

    it('shows a neutral placeholder instead', () => {
      expect(compile(withMarkers(), { format: 'fhir-slim', now: NOW }).content).toContain('[binary attachment omitted]');
      expect(compile(withMarkers(), { format: 'csv', now: NOW }).content).toContain('Scan [binary attachment omitted]');
    });

    it('fhir-slim also drops primitive extensions such as _birthDate', () => {
      const g = buildGraph([patient({ _birthDate: { extension: [{ url: 'u', valueDateTime: '1930-03-05T08:15:00Z' }] } })]);
      const { content } = compile(g, { format: 'fhir-slim' });
      expect(content).not.toContain('_birthDate');
      expect(content).not.toContain('08:15');
    });
  });
});
