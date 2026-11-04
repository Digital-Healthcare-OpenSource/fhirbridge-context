import { describe, expect, it } from 'vitest';
import type { Resource } from '../src/types/fhir.js';
import {
  StreamRehydrator,
  auditCitations,
  extractNumbers,
  rehydrate,
  splitSentences,
  verify,
} from '../src/verifier/index.js';
import { shiftFhirDate } from '../src/shared/fhir-date.js';
import { buildGraph, fakeVault, labObservation, medRequest, patient } from './helpers/manual-graph.js';

const ref = { reference: 'Patient/pat-1' };

function sourceGraph() {
  const resources: Resource[] = [
    patient(),
    medRequest('medreq-active-1'),
    medRequest('medreq-stopped-2', {
      status: 'stopped',
      medicationCodeableConcept: { text: 'Lisinopril 10 MG Oral Tablet' },
    }),
    medRequest('medreq-err-9', { status: 'entered-in-error' }),
    labObservation('obs-299', 8.4, '2025-02-11'),
    labObservation('obs-301', 7.8, '2025-08-10'),
    { resourceType: 'Condition', id: 'cond-old', subject: ref, clinicalStatus: { coding: [{ code: 'resolved' }] }, code: { text: 'Bronchitis' } },
    { resourceType: 'Condition', id: 'cond-1', subject: ref, clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Diabetes' } },
  ];
  return buildGraph(resources);
}

const issuesOf = (text: string) => auditCitations(text, sourceGraph()).issues;
const codesOf = (text: string) => issuesOf(text).map((i) => `${i.code}:${i.citation}`);

describe('citation auditor', () => {
  it('spec: validates a good citation, flags a status contradiction and a hallucinated id', () => {
    const text = [
      'The patient takes metformin twice daily [MedicationRequest/medreq-active-1].',
      'Patient is currently taking Lisinopril 10mg daily [MedicationRequest/medreq-stopped-2].',
      'Latest result was normal [Observation/obs-fake-999].',
    ].join('\n');
    const report = auditCitations(text, sourceGraph());
    expect(report.ok).toBe(false);
    expect(report.citations).toHaveLength(3);
    expect(report.citations[0]).toMatchObject({ citation: 'MedicationRequest/medreq-active-1', exists: true, status: 'active', ok: true });
    expect(report.issues.map((i) => [i.code, i.severity, i.citation])).toEqual([
      ['CRITICAL_STATUS_CONTRADICTION', 'critical', 'MedicationRequest/medreq-stopped-2'],
      ['HALLUCINATED_RESOURCE_ID', 'critical', 'Observation/obs-fake-999'],
    ]);
    expect(report.citations[2]).toMatchObject({ exists: false, ok: false });
  });

  it('accepts a stopped medication described in the past or negated', () => {
    const ok = [
      'Lisinopril was stopped in April due to cough [MedicationRequest/medreq-stopped-2].',
      'Patient is no longer taking lisinopril [MedicationRequest/medreq-stopped-2].',
      'Patient previously took lisinopril 10 mg daily [MedicationRequest/medreq-stopped-2].',
      'Bệnh nhân đã dừng lisinopril [MedicationRequest/medreq-stopped-2].',
    ];
    for (const sentence of ok) expect(codesOf(sentence)).toEqual([]);
  });

  it('flags current-use wording for resolved conditions and Vietnamese phrasing', () => {
    expect(codesOf('Patient has active bronchitis [Condition/cond-old].')).toEqual(['CRITICAL_STATUS_CONTRADICTION:Condition/cond-old']);
    expect(codesOf('Bệnh nhân đang dùng lisinopril [MedicationRequest/medreq-stopped-2].')).toEqual(['CRITICAL_STATUS_CONTRADICTION:MedicationRequest/medreq-stopped-2']);
    expect(codesOf('Bệnh nhân đang điều trị viêm phế quản [Condition/cond-old].')).toEqual(['CRITICAL_STATUS_CONTRADICTION:Condition/cond-old']);
    expect(codesOf('Patient has inactive bronchitis [Condition/cond-old].')).toEqual([]);
  });

  it('does not treat a plain mention of a historical resource as a contradiction', () => {
    expect(codesOf('Lisinopril 10 mg is listed [MedicationRequest/medreq-stopped-2].')).toEqual([]);
  });

  it('flags any citation of an excluded resource, plus a contradiction when presented as current', () => {
    expect(codesOf('A prescription exists [MedicationRequest/medreq-err-9].')).toEqual(['EXCLUDED_RESOURCE_CITED:MedicationRequest/medreq-err-9']);
    expect(codesOf('Patient is currently taking it [MedicationRequest/medreq-err-9].')).toEqual([
      'EXCLUDED_RESOURCE_CITED:MedicationRequest/medreq-err-9',
      'CRITICAL_STATUS_CONTRADICTION:MedicationRequest/medreq-err-9',
    ]);
  });

  it('warns when the stated number matches neither the value nor its history', () => {
    const issues = issuesOf('HbA1c is 9.4% [Observation/obs-301].');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'NUMERIC_VALUE_MISMATCH', severity: 'warning' });
    expect(auditCitations('HbA1c is 9.4% [Observation/obs-301].', sourceGraph()).ok).toBe(true);
  });

  it('accepts the current value, historical series values and display rounding', () => {
    expect(codesOf('HbA1c is 7.8% [Observation/obs-301].')).toEqual([]);
    expect(codesOf('HbA1c fell from 8.4 to 7.8 [Observation/obs-301].')).toEqual([]);
    expect(codesOf('HbA1c was 8.4% earlier [Observation/obs-301].')).toEqual([]);
    expect(codesOf('HbA1c is 7.80 [Observation/obs-301].')).toEqual([]);
  });

  it('ignores dates, ordinals, tokens and the anchor itself when comparing numbers', () => {
    expect(codesOf('1. On 2025-08-10, [PATIENT_1] had HbA1c 7.8 [Observation/obs-301].')).toEqual([]);
    expect(extractNumbers('3) On 2025-08-10 at 14:30 [PATIENT_1] HbA1c 7.8% [Observation/obs-301] ok')).toEqual(['7.8']);
  });

  it('does not run the numeric check when the sentence has no numbers', () => {
    expect(codesOf('The HbA1c is elevated [Observation/obs-301].')).toEqual([]);
  });
});

describe('sentence splitting', () => {
  it('keeps e.g. and decimals intact and splits on real boundaries', () => {
    expect(splitSentences('HbA1c was 7.8 e.g. controlled. Next visit is due. Dr. Lee agrees.')).toEqual([
      'HbA1c was 7.8 e.g. controlled.',
      'Next visit is due.',
      'Dr. Lee agrees.',
    ]);
  });

  it('splits on line breaks and strips bullets, and re-attaches trailing anchors', () => {
    expect(splitSentences('- First fact.\n2. Second fact. [Observation/obs-1]\n* Third')).toEqual([
      'First fact.',
      'Second fact. [Observation/obs-1]',
      'Third',
    ]);
  });

  it('attributes a post-period anchor to its sentence', () => {
    expect(codesOf('Patient is currently taking lisinopril. [MedicationRequest/medreq-stopped-2]')).toEqual([
      'CRITICAL_STATUS_CONTRADICTION:MedicationRequest/medreq-stopped-2',
    ]);
  });
});

/* ---------------------------- rehydration ---------------------------- */

const SHIFT = -142;
const KEY = 'Patient/pat-1';
const vault = (window?: { min: string; max: string }) =>
  fakeVault({
    tokens: { '[PATIENT_1]': 'John Doe', '[MRN_1]': 'MRN-998877', '[PROVIDER_1]': 'Dr. Smith' },
    shifts: { [KEY]: SHIFT },
    windows: window ? { [KEY]: window } : {},
  });
const WINDOW = { min: '2025-01-01', max: '2026-02-01' };
/** Reverse of the vault's shift (delta -142 means +142 days on rehydration). */
const back = (d: string): string => shiftFhirDate(d, -SHIFT);

describe('rehydrate', () => {
  it('restores tokens and reverses the date shift', () => {
    expect(rehydrate('[PATIENT_1] (MRN [MRN_1]) was admitted on 2026-01-15.', vault(WINDOW))).toBe(
      'John Doe (MRN MRN-998877) was admitted on 2026-06-06.',
    );
  });

  it('leaves unknown tokens as-is', () => {
    expect(rehydrate('See [PATIENT_9] and [PERSON_1].', vault())).toBe('See [PATIENT_9] and [PERSON_1].');
  });

  it('reverses the date part of ISO datetimes and keeps the time', () => {
    expect(rehydrate('At 2026-01-15T10:00:00Z the line was placed.', vault(WINDOW))).toBe(
      'At 2026-06-06T10:00:00Z the line was placed.',
    );
  });

  it('leaves dates far outside the shifted window untouched', () => {
    const text = 'ADA 2019-03-04 guideline; today 2030-01-01; visit 2025-08-10.';
    expect(rehydrate(text, vault(WINDOW))).toBe(
      `ADA 2019-03-04 guideline; today 2030-01-01; visit ${back('2025-08-10')}.`,
    );
  });

  it('includes dates up to 400 days beyond the window edges', () => {
    const edge = shiftFhirDate(WINDOW.max, 400);
    const past = shiftFhirDate(WINDOW.max, 401);
    expect(rehydrate(`${edge} and ${past}`, vault(WINDOW))).toBe(`${back(edge)} and ${past}`);
    const low = shiftFhirDate(WINDOW.min, -400);
    expect(rehydrate(low, vault(WINDOW))).toBe(back(low));
    expect(rehydrate(shiftFhirDate(WINDOW.min, -401), vault(WINDOW))).toBe(shiftFhirDate(WINDOW.min, -401));
  });

  it('reverses every date when no window was recorded', () => {
    expect(rehydrate('on 2019-03-04', vault())).toBe(`on ${back('2019-03-04')}`);
  });

  it('does not touch dates when the patient is ambiguous or unshifted', () => {
    const two = fakeVault({ shifts: { 'Patient/a': -10, 'Patient/b': -20 } });
    expect(rehydrate('2026-01-15', two)).toBe('2026-01-15');
    expect(rehydrate('2026-01-15', two, { patientKey: 'Patient/b' })).toBe('2026-02-04');
  });

  it('ignores impossible calendar dates and does not re-shift restored values', () => {
    expect(rehydrate('2026-13-45', vault())).toBe('2026-13-45');
    const v = fakeVault({ tokens: { '[ID_1]': '2026-01-15' }, shifts: { [KEY]: SHIFT } });
    expect(rehydrate('[ID_1]', v)).toBe('2026-01-15');
  });
});

/* ------------------------------ streaming ------------------------------ */

function streamAll(chunks: string[], v = vault(WINDOW)): string {
  const s = new StreamRehydrator(v);
  return chunks.map((c) => s.push(c)).join('') + s.end();
}

/** Small deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSplit(text: string, rand: () => number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const len = 1 + Math.floor(rand() * 9);
    chunks.push(text.slice(i, i + len));
    i += len;
  }
  return chunks;
}

describe('StreamRehydrator', () => {
  it('spec: rejoins split tokens and split dates', () => {
    const chunks = ['Patient [PAT', 'IENT_1] was ', 'admitted on 2026-', '01-15.'];
    const s = new StreamRehydrator(vault(WINDOW));
    const outputs = chunks.map((c) => s.push(c));
    expect(outputs[0]).toBe('Patient ');
    expect(outputs[1]).toBe('John Doe was ');
    expect(outputs[2]).toBe('admitted on ');
    expect(outputs.join('') + s.end()).toBe('Patient John Doe was admitted on 2026-06-06.');
  });

  const SAMPLE = [
    'Patient [PATIENT_1] (MRN [MRN_1]) was admitted on 2026-01-15 and seen by [PROVIDER_1].',
    'Follow-up 2025-08-10T09:30:00Z; unknown [PERSON_7]; guideline 2019-03-04; version 2026-01-155.',
    'Nested [[PATIENT_1]] and a2026-01-15 and 12026-01-15 and [PATIENT_ and [ID_12345678].',
    'Range 2025-02-11-2025-05-09, ids 20260115 and 2026-1-5, end 2026-02-',
  ].join('\n');

  it('equals rehydrate(full) for every 2-way split', () => {
    const expected = rehydrate(SAMPLE, vault(WINDOW));
    for (let i = 0; i <= SAMPLE.length; i++) {
      expect(streamAll([SAMPLE.slice(0, i), SAMPLE.slice(i)])).toBe(expected);
    }
  });

  it('equals rehydrate(full) for every char-by-char and many random chunkings', () => {
    const expected = rehydrate(SAMPLE, vault(WINDOW));
    expect(streamAll([...SAMPLE])).toBe(expected);
    const rand = mulberry32(20261104);
    for (let n = 0; n < 400; n++) expect(streamAll(randomSplit(SAMPLE, rand))).toBe(expected);
  });

  it('holds a complete date until the next character shows it is complete', () => {
    const s = new StreamRehydrator(vault(WINDOW));
    expect(s.push('on 2026-01-15')).toBe('on ');
    expect(s.push('.')).toBe('2026-06-06.');
    expect(s.end()).toBe('');
  });

  it('never holds back more than 32 characters', () => {
    const s = new StreamRehydrator(vault());
    const long = '[' + 'A'.repeat(60);
    expect(s.push(long)).toBe(long);
    expect(s.end()).toBe('');
  });

  it('flushes a dangling partial token at end of stream', () => {
    const s = new StreamRehydrator(vault());
    expect(s.push('trailing [PATI')).toBe('trailing ');
    expect(s.end()).toBe('[PATI');
  });
});

describe('verify()', () => {
  it('audits and rehydrates when a vault is given', () => {
    const text = '[PATIENT_1] is currently taking lisinopril [MedicationRequest/medreq-stopped-2] since 2026-01-15.';
    const result = verify(text, sourceGraph(), vault(WINDOW));
    expect(result.report.ok).toBe(false);
    expect(result.rehydrated).toBe(
      'John Doe is currently taking lisinopril [MedicationRequest/medreq-stopped-2] since 2026-06-06.',
    );
  });

  it('skips rehydration without a vault', () => {
    const result = verify('Takes metformin [MedicationRequest/medreq-active-1].', sourceGraph());
    expect(result.report.ok).toBe(true);
    expect(result.rehydrated).toBeUndefined();
  });
});
