import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deidentify, SafeHarborVault, scrubText } from '../src/deid/index.js';
import type { Resource } from '../src/types/fhir.js';
import { resourceKey } from '../src/types/fhir.js';
import type { DecodedDocument, IntegrityWarning, NormalizedGraph } from '../src/types/pipeline.js';

const NOW = new Date('2026-01-01T00:00:00Z');

function makeGraph(
  resources: Resource[],
  documents: DecodedDocument[] = [],
  warnings: IntegrityWarning[] = [],
): NormalizedGraph {
  const byKey = new Map(resources.map((r) => [resourceKey(r), r]));
  const patientOf = new Map<string, string>();
  for (const r of resources) {
    const key = resourceKey(r);
    if (r.resourceType === 'Patient') patientOf.set(key, key);
    else {
      const ref = (r.subject ?? r.patient ?? r.beneficiary) as { reference?: string } | undefined;
      if (ref?.reference) patientOf.set(key, ref.reference);
    }
  }
  for (const d of documents) {
    const sole = resources.find((r) => r.resourceType === 'Patient');
    if (sole && !patientOf.has(d.resourceKey)) patientOf.set(d.resourceKey, resourceKey(sole));
  }
  return {
    resources,
    index: {
      resolve: (ref) => byKey.get(ref),
      get: (k) => byKey.get(k),
      has: (k) => byKey.has(k),
      all: () => resources,
      byType: <T extends Resource = Resource>(t: string) => resources.filter((r) => r.resourceType === t) as T[],
    },
    status: new Map(resources.map((r) => [resourceKey(r), 'active' as const])),
    patientOf,
    members: new Map(),
    medications: new Map(),
    documents,
    warnings,
    excluded: [],
    idMap: new Map(),
    stats: { inputResources: resources.length, inputBytes: 0, inputTokens: 0 },
  };
}

const doc = (key: string, text: string): DecodedDocument => ({
  resourceKey: key,
  contentType: 'text/plain',
  text: text.slice(0, 4000),
  chunks: [text],
  truncated: false,
  sourceSizeBytes: text.length,
  sha256: 'x',
});

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const subj = { reference: 'Patient/pt1' };
const patient = (extra: Record<string, unknown> = {}): Resource => ({
  resourceType: 'Patient',
  id: 'pt1',
  name: [{ family: 'Wilson', given: ['Robert'] }],
  birthDate: '1962-03-14',
  ...extra,
});
const run = (resources: Resource[], docs: DecodedDocument[] = [], warnings: IntegrityWarning[] = []) => {
  const vault = SafeHarborVault.create();
  return { vault, ...deidentify(makeGraph(resources, docs, warnings), { vault, now: NOW }) };
};
const find = (r: ReturnType<typeof run>, key: string): Record<string, unknown> =>
  r.graph.index.get(key) as unknown as Record<string, unknown>;

describe('C2 warnings carry no raw values', () => {
  it('rebuilds warnings from fixed templates', () => {
    const r = run(
      [patient({ id: 'MRN4471902' })],
      [],
      [
        {
          code: 'CODE_DISPLAY_MISMATCH',
          resourceKey: 'Patient/MRN4471902',
          message: 'display "Robert Wilson 2021-03-15" conflicts',
          details: { code: '29046', display: 'Robert Wilson 555-123-4567', expected: 'Lisinopril' },
        },
        {
          code: 'UNRESOLVED_REFERENCE',
          resourceKey: 'Patient/MRN4471902',
          message: 'reference "Patient/MRN4471902" 2021-03-15',
          details: { reference: 'Patient/MRN4471902' },
        },
      ],
    );
    const text = JSON.stringify(r.graph.warnings);
    for (const raw of ['Robert', 'Wilson', '4471902', '2021-03-15', '555-123']) expect(text).not.toContain(raw);
    expect(r.graph.warnings[0]?.code).toBe('CODE_DISPLAY_MISMATCH');
    expect(r.graph.warnings[0]?.details).toMatchObject({ rxcui: '29046', expected: 'Lisinopril' });
    expect(r.graph.warnings[1]?.details).toBeUndefined();
  });
});

describe('C3/H2 dates fail closed and default-deny', () => {
  it('keeps only the year of malformed dates and removes unrecoverable ones', () => {
    const r = run([
      patient({ birthDate: '03/15/1930' }),
      { resourceType: 'Observation', id: 'o1', subject: subj, effectiveDateTime: '03/15/2021', issued: '20210317', date: 'sometime' },
      { resourceType: 'Observation', id: 'o2', subject: subj, effectiveDateTime: '2021-03-16 10:30:00' },
    ]);
    expect(find(r, 'Patient/pt1').birthDate).toBeUndefined();
    expect(find(r, 'Observation/o1')).toMatchObject({ effectiveDateTime: '2021', issued: '2021' });
    expect(find(r, 'Observation/o1').date).toBeUndefined();
    expect(find(r, 'Observation/o2').effectiveDateTime).toBe('2021');
  });

  it('shifts dates by type wherever they sit', () => {
    const r = run([
      patient(),
      {
        resourceType: 'MedicationStatement', id: 'ms', subject: subj, dateAsserted: '2021-04-01',
        dosage: [{ timing: { event: ['2021-05-05T08:00:00Z'] } }],
        extension: [{ url: 'urn:x', valueString: '2021-06-06' }],
      },
      { resourceType: 'Communication', id: 'c', subject: subj, sent: '2021-06-06T10:00:00Z', received: '2021-06-07' },
    ]);
    const days = r.vault.dateShiftDaysFor('Patient/pt1') as number;
    const shift = (d: string): string => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);
    const text = JSON.stringify(r.graph.resources);
    for (const d of ['2021-04-01', '2021-05-05', '2021-06-06', '2021-06-07']) {
      expect(text).not.toContain(d);
      expect(text).toContain(shift(d));
    }
    expect(r.vault.emittedShiftedDates('Patient/pt1').has(shift('2021-04-01'))).toBe(true);
  });
});

describe('M5 unowned resources in multi-patient graphs', () => {
  it('generalizes their dates to the year', () => {
    const r = run([
      patient(),
      patient({ id: 'pt2', name: [{ family: 'Other', given: ['Zed'] }] }),
      { resourceType: 'Observation', id: 'orph', effectiveDateTime: '2021-03-15' },
    ]);
    expect(find(r, 'Observation/orph').effectiveDateTime).toBe('2021');
  });
});

describe('M6 date of birth keeps only the year', () => {
  it('sets year + age extension, removes birthDate above 89', () => {
    const r = run([patient({ id: 'old', birthDate: '1930-05-05' }), patient({ id: 'young' })]);
    const young = find(r, 'Patient/young');
    expect(young.birthDate).toBe('1962');
    expect(young.extension).toContainEqual({
      url: 'https://fhirbridge.dev/fhir/StructureDefinition/age-at-deidentification',
      valueString: '63',
    });
    const old = find(r, 'Patient/old');
    expect(old.birthDate).toBeUndefined();
    expect(JSON.stringify(old.extension)).toContain('90+');
    expect(r.summary.agesCapped).toBe(1);
  });

  it('reduces free-text DOB to year / 90+', () => {
    const vault = SafeHarborVault.create();
    expect(scrubText('DOB 03/14/1962', { vault, now: NOW }).text).toBe('DOB 1962');
    expect(scrubText('DOB 03/14/1930', { vault, now: NOW }).text).toBe('DOB 90+');
  });
});

describe('H1 default-deny structured scrub', () => {
  it('catches PHI in unusual members', () => {
    const r = run([
      patient({
        contact: [{ name: { family: 'Zorbleton', given: ['Quincy'] }, telecom: [{ system: 'phone', value: '555-987-6543' }] }],
        extension: [
          { url: 'urn:birthPlace', valueAddress: { city: 'Smallville', line: ['9 Elm Street'] } },
          { url: 'urn:mothersMaidenName', valueString: 'Kowalczyk' },
          { url: 'urn:hn', valueHumanName: { family: 'Extfam', given: ['Extgiven'] } },
          { url: 'urn:cp', valueContactPoint: { system: 'phone', value: '555-222-3333' } },
          { url: 'urn:id', valueIdentifier: { value: 'EXTID-5551' } },
        ],
      }),
      { resourceType: 'Organization', id: 'org', name: 'Springfield General', alias: ['Springy'], contact: [{ name: { family: 'Orgcontactfam' } }] },
      { resourceType: 'Communication', id: 'c', subject: subj, payload: [{ contentString: 'Call 555-444-5555 about Robert' }] },
      { resourceType: 'ClinicalImpression', id: 'ci', subject: subj, summary: 'Mr. Zorbleton phoned 555-444-5555' },
      { resourceType: 'Coverage', id: 'cov', beneficiary: subj, subscriberId: 'SUBSCR-998877' },
      { resourceType: 'Device', id: 'dev', patient: subj, serialNumber: 'SN-554433', deviceName: [{ name: 'Gizmo Alpha', type: 'user-friendly-name' }] },
      {
        resourceType: 'Observation', id: 'obs', subject: subj,
        code: { coding: [{ system: 'http://loinc.org', code: '1-1', display: 'Call Robert Wilson 555-444-5555' }] },
        performer: [{ display: 'Plain Person' }],
      },
    ]);
    const text = fold(JSON.stringify(r.graph.resources));
    for (const raw of [
      'zorbleton', 'quincy', '555-987', '555-222', 'smallville', 'elm street', 'kowalczyk', 'extfam',
      'extgiven', 'extid', 'springfield', 'springy', 'orgcontactfam', '555-444', 'subscr-998877', 'sn-554433',
      'gizmo', 'plain person', 'robert', 'wilson',
    ]) {
      expect(text, raw).not.toContain(raw);
    }
  });

  it('keeps clinical content (drug names in Coding.display)', () => {
    const r = run([
      patient(),
      { resourceType: 'MedicationStatement', id: 'm', subject: subj, medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '29046', display: 'Lisinopril 10 MG Oral Tablet' }] } },
    ]);
    expect(JSON.stringify(r.graph.resources)).toContain('Lisinopril 10 MG Oral Tablet');
  });
});

describe('H3/H4 registered names', () => {
  const note = (family: string, given: string[], text: string): string => {
    const r = run([
      { resourceType: 'Patient', id: 'p', name: [{ family, given }] },
      { resourceType: 'Condition', id: 'c', subject: { reference: 'Patient/p' }, note: [{ text }] },
    ]);
    return ((find(r, 'Condition/c').note as { text: string }[])[0] as { text: string }).text;
  };

  it('never exempts a registered name as an eponym', () => {
    const out = note('Wilson', ['Robert'], "Wilson's daughter called. Wilson disease ruled out.");
    expect(out).not.toContain('Wilson');
  });

  it('matches across diacritics, case and apostrophes', () => {
    const a = note('García', ['José'], 'Garcia Jose; Jose Garcia; GARCIA; garcia; García; José');
    expect(fold(a)).not.toMatch(/garcia|jose/);
    const b = note('O’Brien', ['Sean'], "O'Brien arrived. Sean O’Brien. OʼBrien.");
    expect(fold(b)).not.toMatch(/brien|sean/);
  });

  it('does not throw on single-letter names', () => {
    expect(() => note('X', ['J'], 'J X was here')).not.toThrow();
  });
});

describe('H5 relationship and non-Latin cues', () => {
  it('tokenizes relatives and CJK/Vietnamese names', () => {
    const text =
      'Wife Karen called. Spouse Ingrid Larsen visited. Son Tobias came. Her sister Maria Lopez and husband Dmitri. ' +
      '患者の田中太郎 was here. 山田花子様 arrived. 환자 김철수 and 박영희 씨. bệnh nhân Nguyễn Văn An.';
    const r = scrubText(text, { vault: SafeHarborVault.create(), now: NOW });
    for (const raw of ['Karen', 'Ingrid', 'Larsen', 'Tobias', 'Maria', 'Lopez', 'Dmitri', '田中太郎', '山田花子', '김철수', '박영희', 'Nguyễn']) {
      expect(r.text, raw).not.toContain(raw);
    }
  });

  it('applies a name found by a cue to every note of the patient', () => {
    const r = run([
      patient(),
      { resourceType: 'Condition', id: 'a', subject: subj, note: [{ text: 'Lives with Ingrid Larsen.' }] },
      { resourceType: 'Condition', id: 'b', subject: subj, note: [{ text: 'Spouse Ingrid Larsen visited.' }] },
    ]);
    expect(JSON.stringify(r.graph.resources)).not.toMatch(/Ingrid|Larsen/);
  });
});

describe('H6 international postal codes', () => {
  it('tokenizes labelled postcodes', () => {
    const t = 'Postcode SW1A 1AA; postal code K1A 0B1; PLZ 10115; 〒100-0001; 우편번호 06236';
    const out = scrubText(t, { vault: SafeHarborVault.create(), now: NOW }).text;
    for (const raw of ['SW1A', 'K1A', '10115', '100-0001', '06236']) expect(out).not.toContain(raw);
  });
});

describe('M1 names stay distinct', () => {
  it('keeps suffixes, supersets and ambiguous surnames apart', () => {
    const v = SafeHarborVault.create();
    const sr = v.tokenFor('PERSON', 'John Smith Sr');
    const jr = v.tokenFor('PERSON', 'John Smith Jr');
    expect(sr).not.toBe(jr);
    const a = v.tokenFor('PERSON', 'Maria Garcia');
    const b = v.tokenFor('PERSON', 'Maria Garcia Lopez');
    expect(a).not.toBe(b);
    expect(v.resolveToken(a)).toBe('Maria Garcia');
  });

  it('gives a bare surname shared by two providers its own token', () => {
    const r = run([
      patient(),
      { resourceType: 'Practitioner', id: 'a', name: [{ family: 'Smith', given: ['Alice'] }] },
      { resourceType: 'Practitioner', id: 'b', name: [{ family: 'Smith', given: ['Bob'] }] },
      { resourceType: 'Condition', id: 'c', subject: subj, note: [{ text: 'Discussed with Smith. Alice Smith agrees.' }] },
    ]);
    const out = ((find(r, 'Condition/c').note as { text: string }[])[0] as { text: string }).text;
    const bare = /Discussed with (\[PROVIDER_\d+\])\./.exec(out)?.[1];
    expect(bare).toBeDefined();
    expect(r.vault.resolveToken(bare as string)).toBe('Smith');
    expect(out).toMatch(/\[PROVIDER_\d+\] agrees/);
  });
});

describe('M2/M3/M9 vault file safety', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fhirbridge-vault-reg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const PASS = 'a long enough passphrase';

  it('refuses to overwrite a concurrent writer', async () => {
    const file = path.join(dir, 'v.json');
    const seed = await SafeHarborVault.open(file, { passphrase: PASS });
    await seed.save();
    const a = await SafeHarborVault.open(file, { passphrase: PASS });
    const b = await SafeHarborVault.open(file, { passphrase: PASS });
    a.tokenFor('PROVIDER', 'Alice Alpha');
    b.tokenFor('PROVIDER', 'Bob Beta');
    await a.save();
    await expect(b.save()).rejects.toMatchObject({ code: 'VAULT_CONFLICT' });
    const c = await SafeHarborVault.open(file, { passphrase: PASS });
    expect(c.resolveToken('[PROVIDER_1]')).toBe('Alice Alpha');
    expect(await readdir(dir)).toEqual(['v.json']);
  });

  it('does not create a key file unless allowed, and enforces passphrase length', async () => {
    delete process.env.FHIRBRIDGE_VAULT_KEY;
    delete process.env.FHIRBRIDGE_VAULT_PASSPHRASE;
    await expect(SafeHarborVault.open(path.join(dir, 'k.json'))).rejects.toMatchObject({ code: 'VAULT_KEY_MISSING' });
    await expect(SafeHarborVault.open(path.join(dir, 'k.json'), { passphrase: 'short' })).rejects.toThrow(/at least 12/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('detects a tampered header', async () => {
    const file = path.join(dir, 't.json');
    const v = await SafeHarborVault.open(file, { passphrase: PASS });
    v.tokenFor('MRN', 'MRN-1');
    await v.save();
    const { readFile, writeFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(parsed.version).toBe(3); // passphrase vaults use envelope encryption
    await writeFile(file, JSON.stringify({ ...parsed, salt: Buffer.from('0123456789abcdef').toString('base64') }));
    await expect(SafeHarborVault.open(file, { passphrase: PASS })).rejects.toMatchObject({ code: 'VAULT_DECRYPT_FAILED' });
  });
});

describe('M4 identifying ids are pseudonymized', () => {
  it('rewrites ids and references and records the mapping', () => {
    const r = run([
      { resourceType: 'Patient', id: 'MRN4471902', name: [{ family: 'Wilson', given: ['Robert'] }], identifier: [{ system: 'urn:mrn', value: '4471902' }] },
      { resourceType: 'Observation', id: 'obs-301', subject: { reference: 'Patient/MRN4471902' }, effectiveDateTime: '2021-03-15' },
      { resourceType: 'Condition', id: 'robert-wilson-cond', subject: { reference: 'Patient/MRN4471902' } },
    ]);
    const keys = r.graph.resources.map(resourceKey);
    expect(keys).toContain('Observation/obs-301');
    const patientKey = keys.find((k) => k.startsWith('Patient/')) as string;
    expect(patientKey).toMatch(/^Patient\/patient-[0-9a-f]{10}$/);
    expect(r.vault.originalResourceKey(patientKey)).toBe('Patient/MRN4471902');
    expect(JSON.stringify(r.graph.resources)).not.toMatch(/MRN4471902|robert-wilson/i);
    expect((find(r, 'Observation/obs-301').subject as { reference: string }).reference).toBe(patientKey);
    expect(r.graph.patientOf.get('Observation/obs-301')).toBe(patientKey);
    expect(r.vault.dateShiftDaysFor(patientKey)).toBeDefined();
  });

  it('leaves plain ids unchanged', () => {
    const r = run([patient({ id: 'pat-1' }), { resourceType: 'MedicationRequest', id: 'medreq-104', subject: { reference: 'Patient/pat-1' } }]);
    expect(r.graph.resources.map(resourceKey)).toEqual(['Patient/pat-1', 'MedicationRequest/medreq-104']);
  });
});

describe('M7 pathological input', () => {
  it.each(['Ab', 'a.', '1-', 'A ', '1 ', 'Dr. ', 'A, '])('scrubs %j repeated quickly', (unit) => {
    const vault = SafeHarborVault.create();
    const t0 = performance.now();
    scrubText(unit.repeat(40000), { vault, now: NOW });
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it('truncates oversize documents', () => {
    const big = 'x '.repeat(150_000);
    const r = run([patient()], [doc('DocumentReference/d', big)]);
    const d = r.graph.documents[0] as DecodedDocument;
    expect(d.chunks.join('').endsWith('[TRUNCATED]')).toBe(true);
    expect(d.chunks.join('').length).toBeLessThanOrEqual(200_011);
    expect(d.truncated).toBe(true);
  });
});

describe('L2 age observation', () => {
  it('caps Age observations above 89', () => {
    const r = run([
      patient(),
      { resourceType: 'Observation', id: 'age', subject: subj, code: { coding: [{ system: 'http://loinc.org', code: '30525-0', display: 'Age' }] }, valueQuantity: { value: 94, unit: 'a' } },
    ]);
    expect(find(r, 'Observation/age').valueQuantity).toMatchObject({ value: 90, comparator: '>=' });
  });
});

describe('property: no raw PHI anywhere in the output', () => {
  it('leaks none of the planted values', () => {
    const raws = [
      'Robert Wilson', 'Karen Whitfield', 'Quincy Zorbleton', 'Ingrid Larsen', 'Dmitri Volkov', 'Tobias',
      '555-123-4567', 'rw.private@example.org', '4471902', '123-45-6789', '12 Baker Street', 'Springfield',
      'SW1A 1AA', 'Kowalczyk', 'SUBSCR-998877', 'SN-554433', '田中太郎', 'Jane Roe-Nurse',
    ];
    const noteText =
      'Patient Robert Wilson (MRN 4471902, SSN 123-45-6789) called 555-123-4567 or rw.private@example.org. ' +
      'Lives at 12 Baker Street, Springfield, postcode SW1A 1AA. Wife Karen Whitfield; friend Quincy Zorbleton. ' +
      'Spouse Ingrid Larsen; husband Dmitri Volkov; Son Tobias. Mother maiden name Kowalczyk. ' +
      'Coverage member ID SUBSCR-998877, device serial SN-554433. 患者の田中太郎. Seen by Dr. Jane Roe-Nurse on 2021-03-15, DOB 03/14/1962.';
    const r = run(
      [
        patient({
          id: 'MRN4471902',
          identifier: [{ system: 'urn:mrn', value: '4471902' }, { system: 'http://hl7.org/fhir/sid/us-ssn', value: '123-45-6789' }],
          telecom: [{ system: 'phone', value: '555-123-4567' }, { system: 'email', value: 'rw.private@example.org' }],
          address: [{ line: ['12 Baker Street'], city: 'Springfield', postalCode: 'SW1A 1AA' }],
          contact: [{ name: { family: 'Whitfield', given: ['Karen'] } }],
          extension: [{ url: 'urn:mothersMaidenName', valueString: 'Kowalczyk' }],
        }),
        { resourceType: 'Practitioner', id: 'prac', name: [{ family: 'Roe-Nurse', given: ['Jane'] }] },
        { resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/MRN4471902' }, code: { text: 'x' }, note: [{ text: noteText }] },
        { resourceType: 'Communication', id: 'c2', subject: { reference: 'Patient/MRN4471902' }, payload: [{ contentString: noteText }] },
        { resourceType: 'Coverage', id: 'cov', beneficiary: { reference: 'Patient/MRN4471902' }, subscriberId: 'SUBSCR-998877' },
        { resourceType: 'Device', id: 'dev', patient: { reference: 'Patient/MRN4471902' }, serialNumber: 'SN-554433' },
      ],
      [doc('DocumentReference/d1', noteText)],
      [{ code: 'UNRESOLVED_REFERENCE', resourceKey: 'Patient/MRN4471902', message: noteText, details: { reference: noteText } }],
    );
    const haystack = fold(
      JSON.stringify(r.graph.resources) + JSON.stringify(r.graph.documents) + JSON.stringify(r.graph.warnings) + JSON.stringify(r.summary),
    );
    for (const raw of raws) expect(haystack, raw).not.toContain(fold(raw));
    for (const part of ['wilson', 'whitfield', 'zorbleton', 'larsen', 'volkov', 'tobias', 'roe-nurse']) {
      expect(haystack, part).not.toContain(part);
    }
    expect(haystack).not.toContain('2021-03-15');
    expect(haystack).not.toMatch(/dateshift/);
  });
});
