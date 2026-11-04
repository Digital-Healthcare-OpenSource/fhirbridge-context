import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findIngredient, KNOWN_CODE_DISPLAY_CONFLICTS } from '../src/dictionaries/rxnorm-core.js';
import { decodeAttachments, stripMarkup, stripRtf } from '../src/normalizer/attachment-decoder.js';
import { classifyStatus } from '../src/normalizer/code-linter.js';
import { loadInput, normalize, normalizeFile, parseInput } from '../src/normalizer/index.js';
import type { Resource } from '../src/types/fhir.js';
import type { InputEntry } from '../src/types/pipeline.js';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const entries = (...resources: Resource[]): InputEntry[] => resources.map((resource) => ({ resource }));
const patient: Resource = { resourceType: 'Patient', id: 'p1' };

const medReq = (id: string, extra: Record<string, unknown>): Resource => ({
  resourceType: 'MedicationRequest',
  id,
  status: 'active',
  subject: { reference: 'Patient/p1' },
  ...extra,
});

describe('input parsing', () => {
  const med: Resource = { resourceType: 'Medication', id: 'm1' };
  it('parses bundle, array, single resource and NDJSON; flattens nested bundles', () => {
    const bundle = { resourceType: 'Bundle', entry: [{ fullUrl: 'urn:uuid:a', resource: patient }] };
    expect(parseInput(JSON.stringify(bundle))).toMatchObject({ source: 'bundle' });
    expect(parseInput(JSON.stringify(bundle)).entries[0]?.fullUrl).toBe('urn:uuid:a');
    expect(parseInput(JSON.stringify([patient, med])).source).toBe('resource-array');
    expect(parseInput(JSON.stringify(patient)).source).toBe('single-resource');
    const nd = parseInput(`${JSON.stringify(patient)}\n\n${JSON.stringify(med)}\nnot json\n`);
    expect(nd.entries).toHaveLength(2);
    expect(nd.warnings[0]?.code).toBe('INVALID_RESOURCE');
    const nested = { resourceType: 'Bundle', entry: [{ resource: bundle }] };
    expect(parseInput(JSON.stringify(nested)).entries).toHaveLength(1);
  });

  it('rejects unusable input', () => {
    expect(() => parseInput('  ')).toThrow();
    expect(() => parseInput('{{{')).toThrow();
  });
});

describe('reference forms and graph', () => {
  it('resolves Type/id, absolute URL, urn:uuid and #contained', () => {
    const g = normalize([
      { resource: patient, fullUrl: 'urn:uuid:AAAA-1' },
      { resource: { resourceType: 'Observation', id: 'o1', subject: { reference: 'urn:uuid:aaaa-1' } } },
    ]);
    const obs = g.index.get('Observation/o1')!;
    expect(g.index.resolve('Patient/p1')?.id).toBe('p1');
    expect(g.index.resolve('http://ehr.example/fhir/Patient/p1/_history/2')?.id).toBe('p1');
    expect(g.index.resolve('urn:uuid:aaaa-1')?.id).toBe('p1');
    expect(g.index.resolve('#c1', { resourceType: 'X', contained: [{ resourceType: 'Medication', id: 'c1' }] })?.id).toBe('c1');
    expect(g.index.resolve('Patient/nope')).toBeUndefined();
    expect(g.patientOf.get('Observation/o1')).toBe('Patient/p1');
    expect(g.patientOf.get('Patient/p1')).toBe('Patient/p1');
    expect(g.index.byType('Observation')).toEqual([obs]);
  });

  it('builds members from DiagnosticReport.result and Observation.hasMember', () => {
    const g = normalize(
      entries(
        patient,
        { resourceType: 'Observation', id: 'a' },
        { resourceType: 'Observation', id: 'panel', hasMember: [{ reference: 'Observation/a' }] },
        { resourceType: 'DiagnosticReport', id: 'dr', result: [{ reference: 'Observation/panel' }, { reference: 'Observation/ghost' }] },
      ),
    );
    expect(g.members.get('Observation/panel')).toEqual(['Observation/a']);
    expect(g.members.get('DiagnosticReport/dr')).toEqual(['Observation/panel']);
    expect(g.warnings.some((w) => w.code === 'UNRESOLVED_REFERENCE' && w.resourceKey === 'DiagnosticReport/dr')).toBe(true);
  });
});

describe('medication reference resolution', () => {
  const metformin = { coding: [{ system: RX, code: '861007', display: 'Metformin 500 MG' }], text: 'Metformin 500 MG' };

  it('resolves Medication/id on a copy, keeping the original reference in an extension', () => {
    const original = medReq('r1', { medicationReference: { reference: 'Medication/m1' } });
    const input = entries(patient, { resourceType: 'Medication', id: 'm1', code: metformin }, original);
    const before = JSON.stringify(input);
    const g = normalize(input);
    const out = g.index.get('MedicationRequest/r1')!;
    expect(out['medicationCodeableConcept']).toEqual(metformin);
    expect(out['medicationReference']).toBeUndefined();
    expect(out.extension).toEqual([
      { url: 'https://fhirbridge.dev/fhir/StructureDefinition/original-medication-reference', valueReference: { reference: 'Medication/m1' } },
    ]);
    expect(JSON.stringify(input)).toBe(before); // immutability
    expect(g.medications.get('MedicationRequest/r1')?.rxnorm).toBe('861007');
  });

  it('resolves urn:uuid and #contained references', () => {
    const g = normalize([
      { resource: patient },
      { resource: { resourceType: 'Medication', id: 'mu', code: metformin }, fullUrl: 'urn:uuid:med-1' },
      { resource: medReq('r2', { medicationReference: { reference: 'urn:uuid:med-1' } }) },
      {
        resource: medReq('r3', {
          contained: [{ resourceType: 'Medication', id: 'inline', code: { text: 'Lisinopril 10 MG' } }],
          medicationReference: { reference: '#inline' },
        }),
      },
    ]);
    expect((g.index.get('MedicationRequest/r2')!['medicationCodeableConcept'] as { text: string }).text).toBe('Metformin 500 MG');
    expect((g.index.get('MedicationRequest/r3')!['medicationCodeableConcept'] as { text: string }).text).toBe('Lisinopril 10 MG');
  });

  it('warns UNRESOLVED_REFERENCE when the Medication is missing', () => {
    const g = normalize(entries(patient, medReq('r4', { medicationReference: { reference: 'Medication/gone' } })));
    expect(g.warnings.find((w) => w.code === 'UNRESOLVED_REFERENCE')?.resourceKey).toBe('MedicationRequest/r4');
    expect(g.medications.has('MedicationRequest/r4')).toBe(false);
  });
});

describe('attachment decoding', () => {
  const docRef = (contentType: string, data: string): Resource => ({
    resourceType: 'DocumentReference',
    id: 'd1',
    status: 'current',
    content: [{ attachment: { contentType, data } }],
  });

  it('decodes base64 HTML into text, removes data, sets size/hash', () => {
    const html = '<html><style>p{}</style><body><p>Patient is <b>stable</b> &amp; well&nbsp;today</p><script>x()</script></body></html>';
    const g = normalize(entries(patient, docRef('text/html; charset=utf-8', b64(html))));
    expect(g.documents).toHaveLength(1);
    expect(g.documents[0]).toMatchObject({ resourceKey: 'DocumentReference/d1', contentType: 'text/html', text: 'Patient is stable & well today', truncated: false });
    const att = (g.index.get('DocumentReference/d1')!['content'] as { attachment: Record<string, unknown> }[])[0]!.attachment;
    expect(att['data']).toBeUndefined();
    expect(att['size']).toBe(Buffer.byteLength(html));
    expect(att['hash']).toBe(g.documents[0]?.sha256);
  });

  it('truncates long documents into 4000-char chunks', () => {
    const text = 'word '.repeat(2000);
    const [doc] = decodeAttachments(docRef('text/plain', b64(text))).documents;
    expect(doc?.text).toHaveLength(4000);
    expect(doc?.truncated).toBe(true);
    expect(doc?.chunks.length).toBe(Math.ceil(text.trim().length / 4000));
    expect(doc?.chunks.every((c) => c.length <= 4000)).toBe(true);
  });

  it('strips RTF control words and XML tags', () => {
    expect(stripRtf('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\pard Chest \\b pain\\b0\\par caf\\\'e9 {\\*\\generator x;}done}')).toBe('Chest pain café done');
    expect(stripMarkup('<?xml version="1.0"?><doc><a>Hi</a><b>&#65;&lt;</b></doc>', false)).toBe('Hi A<');
  });

  it('replaces binary data with a marker and warns', () => {
    const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const g = normalize(entries(patient, docRef('application/pdf', payload.toString('base64'))));
    const att = (g.index.get('DocumentReference/d1')!['content'] as { attachment: Record<string, unknown> }[])[0]!.attachment;
    expect(att['data']).toBeUndefined();
    expect(att['title']).toMatch(/^\[BINARY_ATTACHMENT: application\/pdf, 6, sha256:[0-9a-f]{64}\]$/);
    expect(g.warnings.some((w) => w.code === 'BINARY_ATTACHMENT_STRIPPED')).toBe(true);
    expect(g.documents).toHaveLength(0);
  });

  it('never throws on bad base64 and handles Binary + DiagnosticReport.presentedForm', () => {
    expect(() => decodeAttachments(docRef('text/plain', '%%%not base64!!'))).not.toThrow();
    const bad = decodeAttachments(docRef('text/plain', '%%%not base64!!'));
    expect(bad.warnings[0]?.code).toBe('BINARY_ATTACHMENT_STRIPPED');
    const g = normalize(
      entries(
        patient,
        { resourceType: 'Binary', id: 'b1', contentType: 'text/plain', data: b64('hello  world') },
        { resourceType: 'DiagnosticReport', id: 'dr1', status: 'final', presentedForm: [{ contentType: 'text/xml', data: b64('<r>ok</r>') }] },
      ),
    );
    expect(g.documents.map((d) => [d.resourceKey, d.text])).toEqual([['Binary/b1', 'hello world'], ['DiagnosticReport/dr1', 'ok']]);
    expect(g.index.get('Binary/b1')!['data']).toBeUndefined();
  });
});

describe('EHR dialect fixes', () => {
  it('removes text.div (including contained) without touching CodeableConcept.text', () => {
    const g = normalize(
      entries({
        resourceType: 'Condition',
        id: 'c1',
        text: { status: 'generated', div: '<div>long table</div>' },
        code: { text: 'Asthma' },
        contained: [{ resourceType: 'Medication', id: 'x', text: { div: '<div/>' } }],
      }),
    );
    const c = g.index.get('Condition/c1')!;
    expect(c.text).toBeUndefined();
    expect((c.contained?.[0] as Resource).text).toBeUndefined();
    expect((c['code'] as { text: string }).text).toBe('Asthma');
  });

  it('shortens ids > 64 chars, rewrites references and records idMap', () => {
    const longId = 'e'.repeat(70);
    const g = normalize(
      entries(patient, { resourceType: 'Observation', id: longId, subject: { reference: 'Patient/p1' } }, {
        resourceType: 'DiagnosticReport',
        id: 'dr',
        result: [{ reference: `Observation/${longId}` }],
      }),
    );
    const short = g.idMap.get(`Observation/${longId}`)!;
    expect(short.length).toBeLessThan(64);
    expect(g.index.has(`Observation/${short}`)).toBe(true);
    expect(g.index.has(`Observation/${longId}`)).toBe(false);
    expect(g.members.get('DiagnosticReport/dr')).toEqual([`Observation/${short}`]);
    expect(g.warnings.some((w) => w.code === 'ID_SHORTENED')).toBe(true);
    // stable across runs
    const again = normalize(entries({ resourceType: 'Observation', id: longId }));
    expect(again.idMap.get(`Observation/${longId}`)).toBe(short);
  });

  it('infers meta.lastUpdated from clinical dates', () => {
    const g = normalize(
      entries(
        { resourceType: 'Observation', id: 'o1', effectiveDateTime: '2024-03-05' },
        { resourceType: 'MedicationRequest', id: 'm1', authoredOn: '2024-01-02T03:04:05+07:00' },
        { resourceType: 'Condition', id: 'c1', recordedDate: '2023-12' },
        { resourceType: 'Observation', id: 'o2', meta: { lastUpdated: '2020-01-01T00:00:00Z' }, issued: '2024-01-01T00:00:00Z' },
      ),
    );
    expect(g.index.get('Observation/o1')?.meta?.lastUpdated).toBe('2024-03-05T00:00:00Z');
    expect(g.index.get('MedicationRequest/m1')?.meta?.lastUpdated).toBe('2024-01-02T03:04:05+07:00');
    expect(g.index.get('Condition/c1')?.meta?.lastUpdated).toBe('2023-12-01T00:00:00Z');
    expect(g.index.get('Observation/o2')?.meta?.lastUpdated).toBe('2020-01-01T00:00:00Z');
    expect(g.warnings.filter((w) => w.code === 'LAST_UPDATED_INFERRED')).toHaveLength(3);
  });

  it('dedupes identical Type/id', () => {
    const g = normalize(entries(patient, patient));
    expect(g.resources).toHaveLength(1);
    expect(g.warnings.some((w) => w.code === 'DUPLICATE_RESOURCE')).toBe(true);
    expect(g.stats.inputResources).toBe(2);
  });
});

describe('status gate', () => {
  const c = (r: Record<string, unknown>): Resource => ({ resourceType: 'MedicationRequest', ...r });
  it('classifies medications: completed is historical, never active', () => {
    expect(classifyStatus(c({ status: 'active' }))).toBe('active');
    expect(classifyStatus(c({ status: 'completed' }))).toBe('historical');
    expect(classifyStatus(c({ status: 'stopped' }))).toBe('historical');
    expect(classifyStatus(c({ status: 'on-hold' }))).toBe('historical');
    expect(classifyStatus(c({ status: 'draft' }))).toBe('unknown');
    expect(classifyStatus(c({}))).toBe('unknown');
    expect(classifyStatus(c({ status: 'entered-in-error' }))).toBe('excluded');
  });

  it('classifies conditions, results and verificationStatus', () => {
    const cc = (code: string) => ({ coding: [{ code }] });
    expect(classifyStatus({ resourceType: 'Condition', clinicalStatus: cc('relapse') })).toBe('active');
    expect(classifyStatus({ resourceType: 'Condition', clinicalStatus: cc('resolved') })).toBe('historical');
    expect(classifyStatus({ resourceType: 'Condition', clinicalStatus: cc('active'), verificationStatus: cc('refuted') })).toBe('excluded');
    expect(classifyStatus({ resourceType: 'AllergyIntolerance', verificationStatus: cc('entered-in-error') })).toBe('excluded');
    expect(classifyStatus({ resourceType: 'Observation', status: 'final' })).toBe('active');
    expect(classifyStatus({ resourceType: 'Observation', status: 'cancelled' })).toBe('historical');
    expect(classifyStatus({ resourceType: 'Procedure', status: 'completed' })).toBe('active');
  });

  it('lists excluded resources in graph.excluded but keeps them in resources', () => {
    const g = normalize(entries(patient, medReq('bad', { status: 'entered-in-error', medicationCodeableConcept: { text: 'Lasix 40 MG' } })));
    expect(g.excluded).toEqual(['MedicationRequest/bad']);
    expect(g.status.get('MedicationRequest/bad')).toBe('excluded');
    expect(g.index.has('MedicationRequest/bad')).toBe(true);
    expect(g.warnings.some((w) => w.code === 'EXCLUDED_ENTERED_IN_ERROR')).toBe(true);
  });
});

describe('RxNorm linter and brand normalization', () => {
  it('flags Tiotropium coded as RxCUI 1116634 (ticagrelor)', () => {
    const g = normalize(
      entries(patient, medReq('t1', { medicationCodeableConcept: { coding: [{ system: RX, code: '1116634', display: 'Tiotropium 18 MCG' }] } })),
    );
    const w = g.warnings.find((x) => x.code === 'CODE_DISPLAY_MISMATCH');
    expect(w?.message).toBe('display "Tiotropium 18 MCG" conflicts with RxCUI 1116634 ("ticagrelor")');
    expect(w?.details).toEqual({ code: '1116634', display: 'Tiotropium 18 MCG', expected: 'ticagrelor' });
    expect(g.medications.get('MedicationRequest/t1')?.ingredient).toBe('Tiotropium');
    expect(g.medications.get('MedicationRequest/t1')?.concept.coding?.some((c) => c.code === '1116634')).toBe(false);
  });

  it('flags Oxybutynin coded 198369, but accepts correct display or brand', () => {
    expect(KNOWN_CODE_DISPLAY_CONFLICTS['198369']).toBe('torsemide');
    const mk = (id: string, display: string, code: string) =>
      medReq(id, { medicationCodeableConcept: { coding: [{ system: RX, code, display }] } });
    const g = normalize(entries(patient, mk('o', 'Oxybutynin 5 MG', '198369'), mk('ok1', 'Torsemide 20 MG', '198369'), mk('ok2', 'Brilinta 90 MG', '1116634')));
    const flagged = g.warnings.filter((x) => x.code === 'CODE_DISPLAY_MISMATCH').map((x) => x.resourceKey);
    expect(flagged).toEqual(['MedicationRequest/o']);
  });

  it('maps brand to ingredient and shares a dedupeKey with the generic', () => {
    const g = normalize(
      entries(
        patient,
        medReq('b', { medicationCodeableConcept: { text: 'Glucophage 500 MG' } }),
        medReq('g', { medicationCodeableConcept: { coding: [{ system: RX, code: '861007', display: 'Metformin 500 MG Oral Tablet' }] } }),
        medReq('z', { medicationCodeableConcept: { text: 'Zestril 10 MG' } }),
      ),
    );
    const brand = g.medications.get('MedicationRequest/b')!;
    expect(brand.display).toBe('Metformin 500 MG [RxNorm: 861007]');
    expect(brand.ingredient).toBe('Metformin');
    expect(brand.rxnorm).toBe('861007');
    expect(g.medications.get('MedicationRequest/g')?.dedupeKey).toBe(brand.dedupeKey);
    expect(g.medications.get('MedicationRequest/z')?.dedupeKey).toBe('lisinopril|10 mg');
    expect(findIngredient('Spiriva HandiHaler')?.ingredient).toBe('Tiotropium');
  });
});

describe('file loading', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('loads a Bulk $export directory of .ndjson files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fhirbridge-'));
    dirs.push(dir);
    const nd = (...r: Resource[]): string => r.map((x) => JSON.stringify(x)).join('\n') + '\n';
    await writeFile(join(dir, 'Patient.ndjson'), nd(patient));
    await writeFile(join(dir, 'Medication.ndjson'), nd({ resourceType: 'Medication', id: 'm1', code: { text: 'Eliquis 5 MG' } }));
    await writeFile(join(dir, 'MedicationRequest.ndjson'), nd(medReq('r1', { medicationReference: { reference: 'Medication/m1' } })));
    await writeFile(join(dir, 'readme.txt'), 'ignored');

    const loaded = await loadInput(dir);
    expect(loaded.source).toBe('ndjson-dir');
    expect(loaded.entries).toHaveLength(3);
    expect(loaded.bytes).toBeGreaterThan(0);

    const g = await normalizeFile(dir);
    expect(g.stats.inputResources).toBe(3);
    expect(g.stats.inputTokens).toBeGreaterThan(0);
    expect(g.medications.get('MedicationRequest/r1')?.ingredient).toBe('Apixaban');
    expect(g.patientOf.get('MedicationRequest/r1')).toBe('Patient/p1');
  });

  it('loads a single .json bundle and rejects an empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fhirbridge-'));
    dirs.push(dir);
    const file = join(dir, 'bundle.json');
    await writeFile(file, JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: patient }] }));
    expect((await loadInput(file)).source).toBe('bundle');
    const empty = await mkdtemp(join(tmpdir(), 'fhirbridge-'));
    dirs.push(empty);
    await expect(loadInput(empty)).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });
});

describe('attachment charsets and binary detection', () => {
  const docRef = (contentType: string, bytes: Buffer): Resource => ({
    resourceType: 'DocumentReference',
    id: 'd1',
    status: 'current',
    content: [{ attachment: { contentType, data: bytes.toString('base64') } }],
  });
  const NOTE = 'Quentin Zarbowski has hypertension.';

  it('decodes utf-16le, utf-16be, latin1 and BOM-marked payloads', () => {
    const be = Buffer.from(Buffer.from(NOTE, 'utf16le').swap16());
    const cases: [string, Buffer][] = [
      ['text/plain; charset=utf-16le', Buffer.from(NOTE, 'utf16le')],
      ['text/plain; charset="UTF-16BE"', be],
      ['text/plain', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(NOTE, 'utf16le')])],
      ['text/plain', Buffer.concat([Buffer.from([0xfe, 0xff]), be])],
      ['text/plain', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(NOTE, 'utf8')])],
      ['text/plain; charset=iso-8859-1', Buffer.from(NOTE, 'latin1')],
    ];
    for (const [type, bytes] of cases) {
      const { documents } = decodeAttachments(docRef(type, bytes));
      expect(documents[0]?.text, type).toBe(NOTE);
    }
    const accents = decodeAttachments(docRef('text/plain; charset=windows-1252', Buffer.from('Müller café', 'latin1')));
    expect(accents.documents[0]?.text).toBe('Müller café');
  });

  it('treats undecodable text payloads as binary: marker and warning, no document', () => {
    const undeclaredUtf16 = Buffer.from(NOTE, 'utf16le'); // NULs once read as UTF-8
    const garbage = Buffer.from(Array.from({ length: 200 }, (_, i) => 0x80 + (i % 40)));
    for (const bytes of [undeclaredUtf16, garbage]) {
      const out = decodeAttachments(docRef('text/plain', bytes));
      expect(out.documents).toHaveLength(0);
      expect(out.warnings.map((w) => w.code)).toEqual(['BINARY_ATTACHMENT_STRIPPED']);
    }
  });
});
