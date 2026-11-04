import { describe, expect, it } from 'vitest';
import { deidentify, SafeHarborVault, scrubText, type FreeTextMode } from '../src/deid/index.js';
import type { Resource } from '../src/types/fhir.js';
import { resourceKey } from '../src/types/fhir.js';
import type { DecodedDocument, DeidResult, NormalizedGraph } from '../src/types/pipeline.js';

const NOW = new Date('2025-01-01T00:00:00Z');

function makeGraph(resources: Resource[], documents: DecodedDocument[] = []): NormalizedGraph {
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
    warnings: [],
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

interface Run {
  result: DeidResult;
  vault: SafeHarborVault;
  json: string;
  find: (type: string, id?: string) => Record<string, unknown> | undefined;
}

function run(resources: Resource[], opts: { documents?: DecodedDocument[]; freeText?: FreeTextMode } = {}): Run {
  const vault = SafeHarborVault.create();
  const result = deidentify(makeGraph(structuredClone(resources), opts.documents), {
    vault,
    now: NOW,
    ...(opts.freeText ? { freeText: opts.freeText } : {}),
  });
  const all = result.graph.resources as unknown as Record<string, unknown>[];
  return {
    result,
    vault,
    json: JSON.stringify(all) + JSON.stringify(result.graph.documents),
    find: (type, id) => all.find((r) => r.resourceType === type && (id === undefined || r.id === id)),
  };
}

const patient = (extra: Record<string, unknown> = {}): Resource =>
  ({
    resourceType: 'Patient',
    id: 'p1',
    identifier: [{ system: 'http://h.org/mrn', type: { coding: [{ code: 'MR' }] }, value: 'MRN-88213377' }],
    name: [{ family: 'Zarbowski', given: ['Quentin'] }],
    birthDate: '1960-03-05',
    telecom: [{ system: 'phone', value: '415-555-0142' }, { system: 'email', value: 'qz@example.org' }],
    address: [{ line: ['12 Elm Street'], city: 'Springfield', postalCode: '62704' }],
    ...extra,
  }) as Resource;

const obs = (id: string, extra: Record<string, unknown> = {}): Resource =>
  ({
    resourceType: 'Observation',
    id,
    status: 'final',
    subject: { reference: 'Patient/p1' },
    code: { coding: [{ system: 'http://loinc.org', code: '2345-7', display: 'Glucose' }] },
    effectiveDateTime: '2024-05-06T10:00:00Z',
    valueQuantity: { value: 5, unit: 'mg' },
    ...extra,
  }) as Resource;

const BAD = ['Quentin', 'Zarbowski', '88213377', '4155550142', '415-555', 'Elm', 'Springfield', '62704', 'qz@'];
const leaks = (text: string, needles: readonly string[] = BAD): string[] => needles.filter((n) => text.includes(n));

/* ------------------------------------------------------------------------------------ */

describe('non-conformant JSON types never fall back to the raw value', () => {
  const shapes: [string, Record<string, unknown>, string[]][] = [
    ['identifier.value as a number', { identifier: [{ system: 'http://h/mrn', value: 88213377 }] }, ['88213377']],
    ['telecom.value as a number', { telecom: [{ system: 'phone', value: 4155550142 }] }, ['4155550142']],
    ['telecom.value as an array', { telecom: [{ system: 'phone', value: ['415-555-0142'] }] }, ['415-555-0142']],
    ['postalCode as a number', { address: [{ postalCode: 62704 }] }, ['62704']],
    ['address.line as a string', { address: [{ line: '12 Elm Street' }] }, ['Elm']],
    ['address.line nested', { address: [{ line: [['12 Elm Street']] }] }, ['Elm']],
    ['address.city as an object', { address: [{ city: { v: 'Springfield' } }] }, ['Springfield']],
    ['name as a string', { name: 'Quentin Zarbowski' }, ['Quentin', 'Zarbowski']],
    ['name as nested arrays', { name: [[{ family: 'Zarbowski' }]] }, ['Zarbowski']],
    ['given as a string', { name: [{ family: 'Zarbowski', given: 'Quentin' }] }, ['Quentin', 'Zarbowski']],
  ];
  for (const [label, extra, needles] of shapes) {
    it(`handles ${label}`, () => {
      const base = { resourceType: 'Patient', id: 'p1', birthDate: '1970-01-02', ...extra } as Resource;
      const withName = extra.name ? base : ({ ...base, name: [{ family: 'Zz', given: ['Yy'] }] } as Resource);
      const r = run([withName]);
      expect(leaks(r.json, needles)).toEqual([]);
    });
  }

  it('tokenizes a string Patient.name and later free text with the same token', () => {
    const r = run([
      { resourceType: 'Patient', id: 'p1', name: 'Quentin Zarbowski', birthDate: '1970-01-01' } as Resource,
      obs('o1', { valueString: 'Quentin Zarbowski is stable' }),
    ]);
    expect(leaks(r.json, ['Quentin', 'Zarbowski'])).toEqual([]);
    expect(String(r.find('Observation')?.valueString)).toMatch(/^\[PATIENT_1\] is stable$/);
  });

  it('coerces numeric leaves under non-quantity keys to scrubbed strings', () => {
    const r = run([patient(), obs('o2', { component: [{ code: { text: 'x' }, mystery: 4155550142, valueInteger: 7 }] })]);
    const comp = (r.find('Observation', 'o2')?.component as Record<string, unknown>[])[0];
    expect(typeof comp?.mystery).toBe('string');
    expect(String(comp?.mystery)).not.toContain('4155550142');
    expect(comp?.valueInteger).toBe(7);
    expect((r.find('Observation', 'o2')?.valueQuantity as { value: number }).value).toBe(5);
  });

  it('keeps clinical numbers numeric', () => {
    const r = run([
      patient(),
      obs('o3', {
        valueQuantity: { value: 123456789, unit: 'cells' },
        referenceRange: [{ low: { value: 3, unit: 'mg' }, high: { value: 9 } }],
      }),
    ]);
    const o = r.find('Observation', 'o3');
    expect((o?.valueQuantity as { value: unknown }).value).toBe(123456789);
    expect(JSON.stringify(o?.referenceRange)).toContain('"value":9');
  });
});

describe('payloads are removed wherever they sit', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64');
  it('drops every `data` key, with or without a contentType sibling', () => {
    const r = run([
      patient(),
      { resourceType: 'Provenance', id: 'pv', target: [{ reference: 'Observation/o1' }], recorded: '2024-01-01T00:00:00Z', signature: [{ type: [{ code: 'x' }], when: '2024-01-01T00:00:00Z', data: b64('Quentin Zarbowski signature') }] } as Resource,
      { resourceType: 'Binary', id: 'bin', data: b64('Quentin Zarbowski binary') } as Resource,
      { resourceType: 'Media', id: 'med', status: 'completed', subject: { reference: 'Patient/p1' }, content: { contentType: 'text/plain', data: b64('Quentin Zarbowski media') } } as Resource,
    ]);
    expect(r.json).not.toContain('"data"');
    expect(leaks(r.json, ['Quentin', 'Zarbowski'])).toEqual([]);
  });

  it('replaces a long base64 string in any member', () => {
    const blob = b64('Quentin Zarbowski has a secret '.repeat(4));
    const r = run([patient(), obs('o4', { valueString: blob, note: [{ text: blob }] })]);
    expect(blob.length).toBeGreaterThan(64);
    expect(r.json).toContain('[BINARY_REMOVED]');
    expect(r.json).not.toContain(blob);
  });

  it('keeps SampledData waveforms', () => {
    const r = run([patient(), obs('o5', { valueSampledData: { origin: { value: 0 }, period: 10, dimensions: 1, data: '0 1 2 3 E' } })]);
    expect(JSON.stringify(r.find('Observation', 'o5')?.valueSampledData)).toContain('0 1 2 3 E');
  });
});

describe('the record owner’s own identifiers in free text', () => {
  const structuredToken = (r: Run, key: string): string => {
    const tel = (r.find('Patient')?.telecom as { system: string; value: string }[]).find((t) => t.system === key);
    return String(tel?.value);
  };

  it('uses the structured token for every spelling of the phone number', () => {
    const r = run([
      patient(),
      obs('o6', { valueString: 'Call 4155550142 or 415-555-0142 or (415) 555-0142 or +1 415 555 0142' }),
    ]);
    const phone = structuredToken(r, 'phone');
    expect(String(r.find('Observation', 'o6')?.valueString)).toBe(`Call ${phone} or ${phone} or ${phone} or ${phone}`);
  });

  it('uses the MRN, email and address tokens in prose', () => {
    const r = run([
      patient(),
      obs('o7', { valueString: 'Chart 88213377; mrn-88213377; mail QZ@Example.org; lives at 12 Elm Street, Springfield' }),
    ]);
    expect(leaks(r.json)).toEqual([]);
    const id = (r.find('Patient')?.identifier as { value: string }[])[0]?.value;
    expect(String(r.find('Observation', 'o7')?.valueString)).toContain(String(id));
  });

  it('tokenizes registered identifiers inside decoded documents', () => {
    const r = run([patient(), { resourceType: 'DocumentReference', id: 'd1', status: 'current', subject: { reference: 'Patient/p1' } } as Resource], {
      documents: [doc('DocumentReference/d1', 'Patient 88213377 phone 4155550142 mail qz@example.org')],
    });
    expect(leaks(r.json)).toEqual([]);
  });

  const text = (s: string): string => {
    const vault = SafeHarborVault.create();
    return scrubText(s, { vault, now: NOW, dateShiftDays: -10 }).text;
  };

  it('tokenizes any other standalone run of 7+ digits', () => {
    expect(text('Call 4155550142 now')).toMatch(/Call \[ID_\d+\] now/);
    expect(text('ref 555-0142 ok')).toMatch(/ref \[ID_\d+\] ok/);
    expect(text('ref 1234 5678 9012')).not.toMatch(/1234 5678/);
  });

  it('leaves clinical codes, decimals and measured values alone', () => {
    expect(text('RxNorm 1049630 daily')).toContain('1049630');
    expect(text('SNOMED CT 73211009')).toContain('73211009');
    expect(text('WBC 12345678.5 high')).toContain('12345678.5');
    expect(text('count 12345678 cells')).toContain('12345678 cells');
    expect(text('BP 120/80 HR 72 SpO2 98 temp 36 5')).toContain('120/80');
  });

  it('knows the new labels', () => {
    for (const s of ['patient ID 55512345', 'MR# 55512345', 'MRN# 55512345', 'file no 55512345', 'ID: 55512345', 'chart 55512345', 'acct 55512345', 'member 55512345']) {
      expect(text(s), s).not.toContain('55512345');
    }
  });
});

describe('dates and ages in free text', () => {
  const vault = SafeHarborVault.create();
  const ctx = { vault, now: NOW, dateShiftDays: -100 };
  const out = (s: string): string => scrubText(s, ctx).text;

  const fullDates = [
    'Seen on 3/5/24', 'Seen 3-5-24', 'Seen 05.03.2024', 'Seen 5-3-2024', 'Seen 13/05/2024', 'Seen 2024/03/05',
    'Seen 2024.03.05', 'Seen 2024-3-5', 'Seen 20240305', 'Seen 05Mar1960', 'Seen 05-Mar-2024', 'Seen 2024年3月5日',
    'Seen Tuesday, March 5, 2024', 'Seen 5th of March 2024',
  ];
  for (const s of fullDates) {
    it(`shifts a full date: ${s}`, () => {
      const t = out(s);
      expect(t).toMatch(/^Seen (on )?\d{4}-\d{2}-\d{2}$/);
      expect(t).not.toMatch(/Mar|2024-03-05|05\.03|3\/5|Tuesday|年/);
    });
  }

  it('generalizes partial dates to the year and hides month-day', () => {
    expect(out('Seen March 2020.')).toBe('Seen 2020.');
    expect(out('Seen in Mar 2020')).toBe('Seen in 2020');
    expect(out('Seen 2024-03')).toBe('Seen 2024');
    expect(out('Seen Mar. 5')).toBe('Seen [DATE]');
    expect(out('Seen March 5th')).toBe('Seen [DATE]');
    expect(out('on the 5th of March')).toBe('on the [DATE]');
  });

  it('does not touch ordinary words and ratios', () => {
    expect(out('may 5 times, 2/12 cores, 4/5 strength')).toContain('2/12 cores');
    expect(out('She may rest.')).toBe('She may rest.');
  });

  it('reduces any date after a birth cue to the year', () => {
    expect(out('DOB 03/05/1960')).toBe('DOB 1960');
    expect(out('D.O.B. 05.03.1960')).toBe('D.O.B. 1960');
    expect(out('born in March 1960')).toBe('born in 1960');
    expect(out('Date of birth: 5 March 1960')).toBe('Date of birth: 1960');
    expect(out('DOB: 05Mar1960')).toBe('DOB: 1960');
    expect(out('born 1960')).toBe('born 1960');
    expect(out('DOB 03/05/60')).toBe('DOB 1960');
    expect(out('生年月日 1960年3月5日')).toBe('生年月日 1960');
    expect(out('생년월일 1960.03.05')).toBe('생년월일 1960');
    expect(out('ngày sinh 05/03/1960')).toBe('ngày sinh 1960');
  });

  it('reduces to 90+ above 89 and fails closed when unparsable', () => {
    expect(out('DOB 03/05/1930')).toBe('DOB 90+');
    expect(out('born in 1920')).toBe('born in 90+');
    expect(out('DOB: 31/02/1960')).toBe('DOB: [DATE]');
    expect(out('DOB 5th of Mrch 1960')).toBe('DOB [DATE]');
  });

  const ages: [string, string][] = [
    ['age 92', 'age 90+'], ['aged 94', 'aged 90+'], ['age: 101', 'age: 90+'], ['92M', '90+ M'],
    ['92 F', '90+ F'], ['92yo', '90+yo'], ['95 years of age', '90+ years of age'], ['age of 97', 'age of 90+'],
    ['turned 91', 'turned 90+'], ['in his 90s', 'in their 90+'], ['in her mid-90s', 'in their 90+'],
    ['ninety-two year old', '90+ year old'], ['ninety two years old', '90+ years old'],
    ['one hundred and three years old', '90+ years old'], ['aged ninety', 'aged 90+'], ['a nonagenarian', 'a 90+ year old'],
  ];
  for (const [input, expected] of ages) {
    it(`caps the age in "${input}"`, () => {
      expect(out(input)).toBe(expected);
    });
  }

  it('keeps ordinary numbers and ages below 90', () => {
    expect(out('age 64, 88 yo, temp 98 F')).toBe('age 64, 88 yo, temp 98 F');
    expect(out('Temperature 99 F')).toBe('Temperature 99 F');
    expect(out('ninety percent of cases')).toBe('ninety percent of cases');
  });
});

describe('resource ids are not an offset oracle', () => {
  it('pseudonymizes ids carrying dates, phones or 4+ digits but keeps readable ones', () => {
    const r = run([
      patient(),
      { ...obs('obs-301'), id: 'obs-301' } as Resource,
      { resourceType: 'Encounter', id: 'enc-2024-03-05', subject: { reference: 'Patient/p1' }, status: 'finished', class: { code: 'AMB' }, period: { start: '2024-03-05' } } as Resource,
      obs('obs-415-555-0142'),
      obs('obs-3-5-24'),
      obs('20240305'),
      { resourceType: 'MedicationRequest', id: 'medreq-104', status: 'active', intent: 'order', subject: { reference: 'Patient/p1' }, medicationCodeableConcept: { text: 'Metformin' } } as Resource,
      obs('1f0e8a3c-9d2b-4c1e-8f7a-123456789abc'),
    ]);
    const ids = (r.result.graph.resources as { id?: string }[]).map((x) => x.id);
    expect(ids).toContain('obs-301');
    expect(ids).toContain('medreq-104');
    expect(ids).toContain('1f0e8a3c-9d2b-4c1e-8f7a-123456789abc');
    for (const bad of ['enc-2024-03-05', 'obs-415-555-0142', 'obs-3-5-24', '20240305']) expect(ids).not.toContain(bad);
    expect(r.json).not.toMatch(/2024-03-05|415-555-0142/);
  });

  it('pseudonymizes a dangling reference whose id carries a registered name part', () => {
    const r = run([patient(), obs('o8', { performer: [{ reference: 'Practitioner/jsmith-md', display: 'J Smith' }] })]);
    expect(r.json).not.toMatch(/jsmith/i);
  });
});

describe('birth data', () => {
  it('drops _birthDate and reduces birth-ish extensions to the year', () => {
    const r = run([
      patient({
        _birthDate: { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/patient-birthTime', valueDateTime: '1960-03-05T08:15:00Z' }] },
        extension: [
          { url: 'http://x/dob', valueString: '1960-03-05' },
          { url: 'http://hl7.org/fhir/StructureDefinition/patient-birthTime', valueDateTime: '1960-03-05T08:15:00Z' },
          { url: 'http://hl7.org/fhir/StructureDefinition/patient-birthPlace', valueAddress: { city: 'Springfield', state: 'IL', country: 'US' } },
          { url: 'http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName', valueString: 'Bertha Qwertz' },
        ],
      }),
    ]);
    const p = r.find('Patient');
    expect(p?._birthDate).toBeUndefined();
    expect(r.json).not.toMatch(/03-05|08:15|Springfield|Bertha|Qwertz/);
    expect(JSON.stringify(p?.extension)).toContain('"country":"US"');
    expect(JSON.stringify(p?.extension)).toContain('"valueDateTime":"1960"');
  });

  it('removes birth values above age 89', () => {
    const r = run([patient({ birthDate: '1920-01-01', extension: [{ url: 'http://x/birthTime', valueDateTime: '1920-01-01T00:00:00Z' }, { url: 'http://x/dob', valueDate: '1920-01-01' }] })]);
    expect(r.json).not.toContain('1920');
    expect(r.json).toContain('90+');
  });
});

describe('another patient’s name keeps that patient’s token', () => {
  it('sweeps all patients’ names and tokenizes them per patient', () => {
    const p2 = { resourceType: 'Patient', id: 'p2', name: [{ family: 'Kowalczyk', given: ['Brunhilde'] }], birthDate: '1971-02-03' } as Resource;
    const note = { resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/p1' }, code: { text: 'Roommate' }, note: [{ text: 'Roommate Brunhilde Kowalczyk was loud; Quentin Zarbowski slept.' }] } as Resource;
    const r = run([patient(), p2, note]);
    expect(leaks(r.json, ['Brunhilde', 'Kowalczyk', 'Quentin', 'Zarbowski'])).toEqual([]);
    const names = (id: string): string => ((r.find('Patient', id)?.name as { text: string }[])[0]?.text) ?? '';
    const text = JSON.stringify(r.find('Condition', 'c1')?.note);
    expect(text).toContain(names('p2'));
    expect(text).toContain(names('p1'));
    expect(names('p1')).not.toBe(names('p2'));
  });
});

describe('structural members are validated', () => {
  it('replaces codes, systems, units and extension urls that carry PHI', () => {
    const r = run([
      patient(),
      obs('o9', {
        code: { coding: [{ system: 'http://h/mrn/M111222', code: 'Quentin-Zarbowski', display: 'ok' }, { system: 'http://snomed.info/sct', code: '73211009' }] },
        valueQuantity: { value: 1, unit: 'Zarbowski' },
        status: 'final Zarbowski',
        extension: [{ url: 'http://x/Quentin-Zarbowski', valueCode: 'Zarbowski' }, { url: 'urn:oid:2.16.840.1.113883.6.96', valueCode: 'ok' }],
        interpretation: [{ coding: [{ system: 'not a uri 88213377', code: 'H' }] }],
      }),
    ]);
    expect(leaks(r.json, ['Quentin', 'Zarbowski', 'M111222', '88213377'])).toEqual([]);
    expect(r.json).toContain('urn:fhirbridge:redacted-system');
    expect(r.json).toContain('73211009');
    expect(r.json).toContain('http://snomed.info/sct');
    expect(r.json).toContain('urn:oid:2.16.840.1.113883.6.96');
  });

  it('keeps ContactPoint.system codes', () => {
    const r = run([patient()]);
    expect(JSON.stringify(r.find('Patient')?.telecom)).toContain('"system":"phone"');
  });

  it('drops nested element ids but keeps resource and contained ids', () => {
    const r = run([
      patient({ name: [{ id: 'name-Zarbowski', family: 'Zarbowski', given: ['Quentin'] }], address: [{ id: 'addr-1', city: 'Springfield' }] }),
      obs('o10', { contained: [{ resourceType: 'Organization', id: 'org1', name: 'Clinic' }], performer: [{ reference: '#org1' }] }),
    ]);
    expect(r.json).not.toContain('name-Zarbowski');
    expect(r.json).not.toContain('addr-1');
    expect(r.json).toContain('"id":"org1"');
    expect(r.json).toContain('"reference":"#org1"');
  });

  it('tokenizes Coverage.class values, subscriber ids and device identifiers', () => {
    const r = run([
      patient(),
      { resourceType: 'Coverage', id: 'cov1', status: 'active', beneficiary: { reference: 'Patient/p1' }, subscriberId: 'SUB998877', class: [{ type: { coding: [{ code: 'group' }] }, value: 'GRP-445566' }] } as Resource,
      { resourceType: 'Device', id: 'dev1', patient: { reference: 'Patient/p1' }, udiCarrier: [{ deviceIdentifier: '00844588003288', carrierHRF: '(01)00844588003288(21)SERIAL123', carrierAIDC: 'QUJD' }], lotNumber: 'LOT123', serialNumber: 'SER998' } as Resource,
    ]);
    expect(leaks(r.json, ['SUB998877', 'GRP-445566', '00844588003288', 'SERIAL123', 'LOT123', 'SER998', 'QUJD'])).toEqual([]);
    expect(r.json).toMatch(/\[HEALTH_PLAN_\d+\]/);
    expect(r.json).toMatch(/\[DEVICE_\d+\]/);
  });
});

describe('date shift is keyed by the canonical id', () => {
  it('gives a different offset and a separate emitted record per canonical id', () => {
    const v = SafeHarborVault.create();
    const a = v.assignDateShift('Patient/p1', 'MRN-A-100');
    v.recordShiftedDate('Patient/p1', '2024-01-01');
    const b = v.assignDateShift('Patient/p1', 'MRN-B-200');
    v.recordShiftedDate('Patient/p1', '2024-06-01');
    expect(v.assignDateShift('Patient/p1', 'MRN-A-100')).toBe(a);
    expect(a).not.toBe(b);
    // the most recent binding (A again) is the one the readers resolve to
    expect(v.dateShiftDaysFor('Patient/p1')).toBe(a);
    expect([...v.emittedShiftedDates('Patient/p1')]).toEqual(['2024-01-01']);
    v.assignDateShift('Patient/p1', 'MRN-B-200');
    expect([...v.emittedShiftedDates('Patient/p1')]).toEqual(['2024-06-01']);
    expect(v.dateShifts().get('Patient/p1')).toBe(b);
  });

  it('survives a save / open round trip', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'fb-vault-'));
    try {
      const key = Buffer.alloc(32, 7);
      const file = path.join(dir, 'v.vault');
      const v = await SafeHarborVault.open(file, { masterKey: key });
      const days = v.assignDateShift('Patient/p1', 'MRN-A-100');
      v.recordShiftedDate('Patient/p1', '2024-01-01');
      await v.save();
      const again = await SafeHarborVault.open(file, { masterKey: key });
      expect(again.dateShiftDaysFor('Patient/p1')).toBe(days);
      expect([...again.emittedShiftedDates('Patient/p1')]).toEqual(['2024-01-01']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Age values above 89 are capped everywhere', () => {
  it('caps onsetAge, valueAge and extension valueAge', () => {
    const r = run([
      patient(),
      { resourceType: 'Condition', id: 'c9', subject: { reference: 'Patient/p1' }, code: { text: 'x' }, onsetAge: { value: 95, unit: 'a', system: 'http://unitsofmeasure.org', code: 'a' }, abatementAge: { value: 1200, code: 'mo' }, extension: [{ url: 'http://x/age', valueAge: { value: 95 } }] } as Resource,
      obs('o11', { valueAge: { value: 101, unit: 'years' } }),
    ]);
    expect(r.json).not.toMatch(/"value":(95|1200|101)\b/);
    expect(JSON.stringify(r.find('Condition')?.onsetAge)).toContain('"value":90');
    expect(JSON.stringify(r.find('Condition')?.onsetAge)).toContain('">="');
  });

  it('leaves younger ages alone', () => {
    const r = run([patient(), { resourceType: 'Condition', id: 'c8', subject: { reference: 'Patient/p1' }, code: { text: 'x' }, onsetAge: { value: 45, unit: 'a' } } as Resource]);
    expect(JSON.stringify(r.find('Condition')?.onsetAge)).toContain('"value":45');
  });
});

describe('more name cues and spellings', () => {
  const vault = SafeHarborVault.create();
  const out = (s: string, names: { category: 'PATIENT' | 'PERSON'; variants: string[] }[] = []): string =>
    scrubText(s, { vault, now: NOW, dateShiftDays: -10, knownNames: names }).text;

  it('recognizes the new cues', () => {
    expect(out('Name: Bob Smith')).not.toContain('Bob');
    expect(out('named Alice Cooper')).not.toContain('Alice');
    expect(out('next of kin: Alice Cooper')).not.toContain('Alice');
    expect(out('NOK Alice Cooper')).not.toContain('Alice');
    expect(out('Emergency contact Alice Cooper')).not.toContain('Alice');
    expect(out('guarantor Alice Cooper')).not.toContain('Alice');
    expect(out('Reviewed with John Smith.')).not.toContain('John');
    expect(out('Sra. Gomez')).not.toContain('Gomez');
    expect(out('Frau Müller')).not.toContain('Müller');
    expect(out('Herr Schmidt')).not.toContain('Schmidt');
    expect(out('Mme Dupont')).not.toContain('Dupont');
    expect(out('M. Dupont')).not.toContain('Dupont');
  });

  it('keeps a capitalized stop word that is part of a name after a cue', () => {
    expect(out('Dr. Nguyen Van An saw him')).not.toContain('An');
    expect(out('bệnh nhân An vào viện')).not.toContain('An');
  });

  it('does not treat "Name" without a colon or ordinary prose as a cue', () => {
    expect(out('Name of the drug is aspirin')).toBe('Name of the drug is aspirin');
    expect(out('Contact the clinic tomorrow')).toBe('Contact the clinic tomorrow');
  });

  it('registers hyphenated surnames as whole and parts, and plurals', () => {
    const names = [{ category: 'PATIENT' as const, variants: ['Anna Zarbowski-Smith'] }];
    const t = out('Zarbowski-Smith, Smith and the Zarbowskis, Zarbowski’s chart', names);
    expect(t).not.toMatch(/Zarbowski|Smith/);
  });

  it('registers one-character CJK names', () => {
    const t = out('患者の李さんは来院', [{ category: 'PATIENT', variants: ['李'] }]);
    expect(t).not.toContain('李');
  });
});

describe('literal tokens in source text are neutralized', () => {
  it('can never be rehydrated', () => {
    const vault = SafeHarborVault.create();
    const t = scrubText('Source note says [SSN_1] and [PATIENT_7] verbatim', { vault, now: NOW, dateShiftDays: -10 }).text;
    expect(t).toBe('Source note says (SSN_1) and (PATIENT_7) verbatim');
    expect(vault.tokens()).toEqual([]);
  });
});

describe('freeText omit mode', () => {
  const resources: Resource[] = [
    patient(),
    {
      resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/p1' },
      code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006', display: 'Type 2 diabetes' }], text: 'Type 2 diabetes' },
      category: [{ text: 'Quentin free category' }],
      note: [{ text: 'Quentin Zarbowski called' }], onsetString: 'x',
    } as Resource,
    obs('o12', { valueString: 'Quentin said hi', comment: 'c', conclusion: 'k', description: 'd', summary: 's', contentString: 'cs', patientInstruction: 'pi', reasonText: 'rt', dosageInstruction: [{ text: 'take Zarbowski daily', route: { coding: [{ code: '26643006', display: 'Oral' }] } }] }),
    { resourceType: 'DocumentReference', id: 'd1', status: 'current', subject: { reference: 'Patient/p1' }, description: 'Note about Quentin' } as Resource,
  ];

  it('removes free-text members and every document, keeping structured codes', () => {
    const r = run(resources, { freeText: 'omit', documents: [doc('DocumentReference/d1', 'Quentin Zarbowski note')] });
    expect(r.result.graph.documents).toEqual([]);
    expect(leaks(r.json, ['Quentin', 'Zarbowski'])).toEqual([]);
    const cond = r.find('Condition');
    expect(JSON.stringify(cond?.code)).toContain('44054006');
    expect(JSON.stringify(cond?.code)).toContain('Type 2 diabetes');
    expect(cond?.note).toBeUndefined();
    expect(JSON.stringify(cond?.category)).not.toContain('free category');
    const o = r.find('Observation', 'o12');
    for (const k of ['valueString', 'comment', 'conclusion', 'description', 'summary', 'contentString', 'patientInstruction', 'reasonText']) {
      expect(o?.[k], k).toBeUndefined();
    }
    expect(JSON.stringify(o?.dosageInstruction)).toContain('26643006');
    expect(JSON.stringify(o?.dosageInstruction)).not.toContain('daily');
    expect((o?.valueQuantity as { value: number }).value).toBe(5);
  });

  it('scrub is the default and keeps documents', () => {
    const r = run(resources, { documents: [doc('DocumentReference/d1', 'Quentin Zarbowski note')] });
    expect(r.result.graph.documents).toHaveLength(1);
    expect(r.result.graph.documents[0]?.text).toBe('[PATIENT_1] note');
  });
});

describe('pathological input stays fast', () => {
  const vault = SafeHarborVault.create();
  const ctx = { vault, now: NOW, dateShiftDays: -10, knownNames: [{ category: 'PATIENT' as const, variants: ['Quentin Zarbowski'], patientKey: 'Patient/p1' }] };
  const N = 200_000;
  const cases: Record<string, string> = {
    born: 'born '.repeat(N / 5),
    dob: 'DOB '.repeat(N / 4),
    age: 'age '.repeat(N / 4),
    aged9: 'aged 9'.repeat(N / 6),
    months: 'Mar 5 '.repeat(N / 6),
    shortDates: '1/1/24 '.repeat(N / 7),
    isoShort: '2024-3-5 '.repeat(N / 9),
    groups: '123 456 '.repeat(N / 8),
    digits: '1234567 '.repeat(N / 8),
    ninety: 'ninety-'.repeat(N / 7),
    atDot: 'a at b dot '.repeat(N / 11),
    nameDot: 'Name: '.repeat(N / 6),
    contact: 'contact '.repeat(N / 8),
    weekdays: 'Tue, '.repeat(N / 5),
  };
  for (const [label, input] of Object.entries(cases)) {
    it(`handles ${label}`, () => {
      const t0 = performance.now();
      scrubText(input, ctx);
      expect(performance.now() - t0).toBeLessThan(1500);
    });
  }
});
