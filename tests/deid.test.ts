import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generalizeZip, RESTRICTED_ZIP3 } from '../src/dictionaries/hipaa-zip3.js';
import { COMMON_DRUG_NAMES, isMedicalTerm } from '../src/dictionaries/medical-eponyms.js';
import { deidentify, SafeHarborVault, scrubText } from '../src/deid/index.js';
import { deriveVaultSubkeys } from '../src/deid/vault.js';
import type { Resource } from '../src/types/fhir.js';
import { resourceKey } from '../src/types/fhir.js';
import type { DecodedDocument, NormalizedGraph } from '../src/types/pipeline.js';

const NOW = new Date('2026-11-04T00:00:00Z');

function makeGraph(resources: Resource[], documents: DecodedDocument[] = []): NormalizedGraph {
  const byKey = new Map(resources.map((r) => [resourceKey(r), r]));
  const patientOf = new Map<string, string>();
  for (const r of resources) {
    const key = resourceKey(r);
    if (r.resourceType === 'Patient') patientOf.set(key, key);
    else {
      const ref = (r.subject ?? r.patient) as { reference?: string } | undefined;
      if (ref?.reference) patientOf.set(key, ref.reference);
    }
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
    status: new Map(),
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

const ref = (r: string) => ({ reference: r });
const T0 = '2026-05-10T10:00:00Z';
const T1 = '2026-05-12T10:00:00Z';

function basicGraph(): NormalizedGraph {
  return makeGraph([
    {
      resourceType: 'Patient',
      id: 'pat-1',
      identifier: [
        { type: { coding: [{ code: 'MR' }] }, value: 'MRN-998877' },
        { system: 'http://hl7.org/fhir/sid/us-ssn', value: '123-45-6789' },
      ],
      name: [{ family: 'Torres', given: ['Michael', 'A.'] }],
      telecom: [
        { system: 'phone', value: '(617) 555-0142' },
        { system: 'email', value: 'mtorres@example.org' },
      ],
      address: [{ line: ['12 Main Street'], city: 'Cambridge', state: 'MA', postalCode: '02138' }],
      birthDate: '1962-03-14',
      extension: [{ url: 'http://example.org/ext/admit', valueDateTime: T0 }],
      photo: [{ contentType: 'image/png', data: 'AAAA' }],
    },
    { resourceType: 'Practitioner', id: 'prac-1', name: [{ family: 'Chen', given: ['Sarah'], prefix: ['Dr.'] }] },
    {
      resourceType: 'Encounter',
      id: 'enc-1',
      status: 'finished',
      subject: ref('Patient/pat-1'),
      period: { start: T0 },
      participant: [{ individual: { reference: 'Practitioner/prac-1', display: 'Dr. Sarah Chen' } }],
    },
    {
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      subject: { reference: 'Patient/pat-1', display: 'Michael Torres' },
      effectiveDateTime: T1,
      contained: [{ resourceType: 'Observation', id: 'c1', effectiveDateTime: T1 }],
      note: [
        {
          text: 'Mr. Torres seen by Dr. Chen. Call 617-555-0142 or mtorres@example.org. SSN 123-45-6789. Torres, Michael was admitted 2026-05-10.',
        },
      ],
    },
  ]);
}

describe('medical dictionaries', () => {
  it('has at least 150 drug names and recognises eponym variants', () => {
    expect(COMMON_DRUG_NAMES.length).toBeGreaterThanOrEqual(150);
    for (const w of ["Parkinson's", 'Swan-Ganz', 'FOLEY', 'Guillain-Barré', 'Perindopril', 'Cardiology']) {
      expect(isMedicalTerm(w)).toBe(true);
    }
    expect(isMedicalTerm('Torres')).toBe(false);
  });

  it('lists the 17 restricted ZIP3 areas and generalizes ZIP codes', () => {
    expect(RESTRICTED_ZIP3.size).toBe(17);
    expect(generalizeZip('02138').value).toBe('021XX');
    expect(generalizeZip('03601-1234')).toEqual({ value: '00000', restricted: true });
  });
});

describe('vault', () => {
  it('derives a date shift in [-365,-2], deterministic per key and id', () => {
    const key = randomBytes(32);
    const a = SafeHarborVault.create({ masterKey: key });
    const b = SafeHarborVault.create({ masterKey: key });
    for (let i = 0; i < 300; i += 1) {
      const d = a.assignDateShift(`Patient/${i}`, `id-${i}`);
      expect(d).toBeGreaterThanOrEqual(-365);
      expect(d).toBeLessThanOrEqual(-2);
      expect(b.assignDateShift(`Patient/${i}`, `id-${i}`)).toBe(d);
    }
    const other = SafeHarborVault.create();
    const differs = Array.from({ length: 20 }, (_, i) => other.assignDateShift(`P${i}`, `id-${i}`) !== a.assignDateShift(`P${i}`, `id-${i}`));
    expect(differs.some(Boolean)).toBe(true);
  });

  it('consolidates name variants into one token', () => {
    const v = SafeHarborVault.create();
    const t = v.tokenFor('PATIENT', 'Michael A. Torres');
    expect(t).toBe('[PATIENT_1]');
    expect(v.tokenFor('PATIENT', 'Torres, Michael')).toBe(t);
    expect(v.tokenFor('PATIENT', 'MR. MICHAEL TORRES')).toBe(t);
    expect(v.tokenFor('PATIENT', 'Jane Roe')).toBe('[PATIENT_2]');
    expect(v.tokenFor('PHONE', '(617) 555-0142')).toBe(v.tokenFor('PHONE', '617.555.0142'));
    expect(v.resolveToken(t)).toBe('Michael A. Torres');
  });

  it('derives distinct HKDF subkeys', () => {
    const { enc, hmac } = deriveVaultSubkeys(randomBytes(32));
    expect(enc.equals(hmac)).toBe(false);
    expect(enc.length).toBe(32);
  });

  describe('persistence', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'fhirbridge-vault-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('round-trips with a passphrase and rejects a wrong one', async () => {
      const file = path.join(dir, 'v.json');
      const v = await SafeHarborVault.open(file, { passphrase: 'correct horse' });
      const token = v.tokenFor('PATIENT', 'Michael Torres');
      const shift = v.assignDateShift('Patient/1', 'MRN-1');
      v.recordShiftedDate('Patient/1', '2026-01-30T10:00:00Z');
      await v.save();
      const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
      expect(onDisk.format).toBe('fhirbridge-vault');
      expect(onDisk.kdf).toBe('scrypt');
      expect(JSON.stringify(onDisk)).not.toContain('Torres');

      const again = await SafeHarborVault.open(file, { passphrase: 'correct horse' });
      expect(again.resolveToken(token)).toBe('Michael Torres');
      expect(again.dateShiftDaysFor('Patient/1')).toBe(shift);
      expect(again.shiftedDateWindow('Patient/1')).toEqual({ min: '2026-01-30', max: '2026-01-30' });
      expect(again.tokenFor('PATIENT', 'Torres, Michael')).toBe(token);

      await expect(SafeHarborVault.open(file, { passphrase: 'wrong' })).rejects.toThrow(/decryption failed/i);
      await expect(SafeHarborVault.open(file)).rejects.toThrow(/passphrase required/i);
    });

    it('uses a key file when no key is supplied and fails with a different master key', async () => {
      const file = path.join(dir, 'v2.json');
      const v = await SafeHarborVault.open(file, { allowKeyFile: true });
      const token = v.tokenFor('MRN', 'MRN-1');
      await v.save();
      const again = await SafeHarborVault.open(file, {});
      await expect(SafeHarborVault.open(path.join(dir, 'nokey.json'))).rejects.toThrow(/No vault key/);
      expect(again.resolveToken(token)).toBe('MRN-1');
      await expect(SafeHarborVault.open(file, { masterKey: randomBytes(32) })).rejects.toThrow(/decryption failed/i);
    });
  });
});

describe('clinical text scrubber', () => {
  it('satisfies the eponym / fraction protection spec example', () => {
    const vault = SafeHarborVault.create();
    const input =
      "Patient John Doe (MRN-998877, ZIP 03601, DOB 1930-01-01) has Parkinson's disease and Hodgkin lymphoma. Placed Foley catheter and Swan-Ganz line on Perindopril. Prostate biopsy showed 2/12 cores positive and motor strength 4/5.";
    const { text } = scrubText(input, { vault, now: NOW });
    for (const keep of ['[PATIENT_1]', '[MRN_1]', '00000', '90+', "Parkinson's", 'Hodgkin', 'Foley', 'Swan-Ganz', 'Perindopril', '2/12 cores', '4/5']) {
      expect(text).toContain(keep);
    }
    for (const gone of ['John', 'Doe', '998877', '03601', '1930']) expect(text).not.toContain(gone);
  });

  it('shifts only full dates, never clinical fractions', () => {
    const vault = SafeHarborVault.create();
    const r = scrubText('Seen 2026-05-10 and 05/12/2026. BP 120/80, pain 7/10, PEEP 5/8, vision 20/40.', {
      vault,
      dateShiftDays: -10,
      now: NOW,
    });
    expect(r.text).toBe('Seen 2026-04-30 and 2026-05-02. BP 120/80, pain 7/10, PEEP 5/8, vision 20/40.');
    expect(r.datesShifted).toBe(2);
  });

  it('removes structured identifiers and keeps Dr. surnames that are also eponyms', () => {
    const vault = SafeHarborVault.create();
    const { text } = scrubText(
      'Dr. Wilson called 617-555-0199 (fax: 617-555-0100), mail a@b.org, see https://x.org/p?id=1, SSN 000-12-3456, Boston, MA 02138. Wilson disease confirmed.',
      { vault, now: NOW },
    );
    expect(text).toContain('[PROVIDER_1]');
    expect(text).toContain('[PHONE_1]');
    expect(text).toContain('[FAX_1]');
    expect(text).toContain('[EMAIL_1]');
    expect(text).toContain('[URL_1]');
    expect(text).toContain('[SSN_1]');
    expect(text).toContain('MA 021XX');
    expect(text).toContain('Wilson disease');
  });

  it('generalizes patients over 89 in free text', () => {
    const vault = SafeHarborVault.create();
    const { text } = scrubText('A 94-year-old woman, born on March 3, 1931.', { vault, now: NOW });
    expect(text).toContain('90+-year-old');
    expect(text).not.toContain('1931');
  });
});

describe('deidentify', () => {
  it('shifts every date by the same offset and preserves the 48h interval', () => {
    const vault = SafeHarborVault.create();
    const { graph, summary } = deidentify(basicGraph(), { vault, now: NOW });
    const days = vault.dateShiftDaysFor('Patient/pat-1') as number;
    expect(summary.patientsShifted).toBe(1);
    expect(days).toBeGreaterThanOrEqual(-365);
    expect(days).toBeLessThanOrEqual(-2);

    const pat = graph.index.get('Patient/pat-1') as Resource;
    const enc = graph.index.get('Encounter/enc-1') as Resource;
    const obs = graph.index.get('Observation/obs-1') as Resource;
    const a = ((pat.extension ?? [])[0] as { valueDateTime: string }).valueDateTime;
    const b = (enc.period as { start: string }).start;
    const c = obs.effectiveDateTime as string;
    const d = ((obs.contained ?? [])[0] as Resource).effectiveDateTime as string;
    const expected = new Date(Date.parse(T0) + days * 86_400_000).toISOString().replace('.000', '');
    expect(a).toBe(expected);
    expect(b).toBe(expected);
    expect(Date.parse(c) - Date.parse(b)).toBe(48 * 3_600_000);
    expect(d).toBe(c);
    expect(summary.datesShifted).toBeGreaterThan(0);
    const window = vault.shiftedDateWindow('Patient/pat-1');
    expect(window).toBeDefined();
  });

  it('leaves no raw PHI in the de-identified graph and does not mutate the input', () => {
    const input = basicGraph();
    const snapshot = JSON.stringify(input.resources);
    const vault = SafeHarborVault.create();
    const { graph, summary } = deidentify(input, { vault, now: NOW });
    expect(JSON.stringify(input.resources)).toBe(snapshot);

    const out = JSON.stringify(graph.resources);
    for (const raw of [
      'Michael', 'Torres', 'Sarah', 'Chen', '998877', '555-0142', '5550142', 'mtorres', '123-45-6789',
      'Main Street', 'Cambridge', '02138', '1962-03-14', '2026-05-10', 'AAAA',
    ]) {
      expect(out).not.toContain(raw);
    }
    const pat = graph.index.get('Patient/pat-1') as Resource;
    expect((pat.address as { postalCode: string }[])[0]?.postalCode).toBe('021XX');
    expect((pat.address as { state: string }[])[0]?.state).toBe('MA');
    expect(pat.photo).toBeUndefined();
    expect(summary.zip3Generalized).toBe(1);
    expect(summary.rulesApplied).toHaveLength(18);
    expect(vault.resolveToken('[PATIENT_1]')).toBe('Michael A. Torres');
    // Same pseudonym in structured name, Reference.display and free text.
    expect(out).toContain('[PATIENT_1]');
    expect(out).not.toContain('[PATIENT_2]');
    expect(out).not.toContain('[PROVIDER_2]');
  });

  it('caps ages over 89 and ZIP-restricts addresses', () => {
    const g = makeGraph([
      {
        resourceType: 'Patient',
        id: 'old',
        birthDate: '1930-01-01',
        address: [{ postalCode: '03601' }],
      },
    ]);
    const { graph, summary } = deidentify(g, { vault: SafeHarborVault.create(), now: NOW });
    const p = graph.index.get('Patient/old') as Resource;
    expect(p.birthDate).toBeUndefined();
    expect(JSON.stringify(p.extension)).toContain('"valueString":"90+"');
    expect((p.address as { postalCode: string }[])[0]?.postalCode).toBe('00000');
    expect(summary.agesCapped).toBe(1);
    expect(summary.zip3Restricted).toBe(1);
  });

  it('removes the original-id extension and scrubs decoded documents', () => {
    const g = makeGraph(
      [
        { resourceType: 'Patient', id: 'p1', name: [{ family: 'Roe', given: ['Jane'] }] },
        {
          resourceType: 'Condition',
          id: 'c1',
          subject: ref('Patient/p1'),
          meta: { extension: [{ url: 'https://fhirbridge.dev/fhir/StructureDefinition/original-id', valueString: 'MRN12345-Jane' }] },
        },
      ],
      [
        {
          resourceKey: 'DocumentReference/d1',
          contentType: 'text/plain',
          text: 'Jane Roe presented.',
          chunks: ['Jane Roe presented.'],
          truncated: false,
          sourceSizeBytes: 19,
          sha256: 'x',
        },
      ],
    );
    g.patientOf.set('DocumentReference/d1', 'Patient/p1');
    const { graph } = deidentify(g, { vault: SafeHarborVault.create(), now: NOW });
    expect(JSON.stringify(graph.resources)).not.toContain('MRN12345');
    expect(graph.documents[0]?.text).toBe('[PATIENT_1] presented.');
    expect(graph.documents[0]?.chunks[0]).toBe('[PATIENT_1] presented.');
  });
});
