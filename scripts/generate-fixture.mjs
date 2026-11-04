#!/usr/bin/env node
/**
 * Deterministically generates tests/fixtures/synthea-messy-patient.json: one synthetic
 * patient whose export contains every real-world trap FHIRBridge handles. All identities
 * are fictional.
 *
 * Traps: 50 refills via medicationReference (3 reference forms), 30 HbA1c results with
 * the same LOINC, bloated text.div narratives, Base64 HTML + PDF attachments, an id longer
 * than 64 chars, missing meta.lastUpdated, stopped / entered-in-error prescriptions, and a
 * Tiotropium prescription carrying ticagrelor's RxCUI (1116634).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/synthea-messy-patient.json');

const PATIENT = 'pat-1';
const subject = { reference: `Patient/${PATIENT}`, display: 'Maria Elena Gonzalez' };
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';

/** Epic-style narrative bloat: a repeated XHTML table. */
function narrative(title, rows = 12) {
  const tr = Array.from(
    { length: rows },
    (_, i) =>
      `<tr><td>${title} detail ${i + 1}</td><td>Recorded by Sarah Kim, MD</td><td>Gonzalez, Maria E</td></tr>`,
  ).join('');
  return {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml"><table class="epic-grid"><thead><tr><th>Item</th><th>Author</th><th>Patient</th></tr></thead><tbody>${tr}</tbody></table></div>`,
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const isoDay = (start, plusDays) =>
  new Date(Date.UTC(start[0], start[1] - 1, start[2]) + plusDays * 86_400_000).toISOString().slice(0, 10);
const uuid = (n) => `6f1c2a7e-0000-4000-8000-${String(n).padStart(12, '0')}`;

const entries = [];
let seq = 0;
function add(resource, fullUrl) {
  seq += 1;
  entries.push({ fullUrl: fullUrl ?? `urn:uuid:${uuid(seq)}`, resource });
}

add(
  {
    resourceType: 'Patient',
    id: PATIENT,
    meta: { lastUpdated: '2025-08-12T10:00:00Z' },
    text: narrative('Demographics', 6),
    identifier: [
      {
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
        system: 'urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.14',
        value: 'MRN-4471902',
      },
      { system: 'http://hl7.org/fhir/sid/us-ssn', value: '123-45-6789' },
    ],
    name: [{ use: 'official', family: 'Gonzalez', given: ['Maria', 'Elena'] }],
    telecom: [
      { system: 'phone', value: '(617) 555-0142', use: 'home' },
      { system: 'email', value: 'maria.gonzalez@example.com' },
    ],
    gender: 'female',
    birthDate: '1962-03-14',
    address: [
      { line: ['45 Brattle Street', 'Apt 3'], city: 'Cambridge', state: 'MA', postalCode: '02138', country: 'US' },
    ],
  },
  `urn:uuid:${uuid(9000)}`,
);

add({
  resourceType: 'Practitioner',
  id: 'prac-1',
  name: [{ family: 'Kim', given: ['Sarah'], prefix: ['Dr.'] }],
  identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1932456789' }],
});

const medUrn = `urn:uuid:${uuid(9100)}`;
add(
  {
    resourceType: 'Medication',
    id: 'med-1',
    code: {
      coding: [{ system: RXNORM, code: '861007', display: 'Glucophage 500 MG Oral Tablet' }],
      text: 'Glucophage 500 MG Oral Tablet',
    },
  },
  medUrn,
);

add({
  resourceType: 'Encounter',
  id: 'enc-1',
  status: 'finished',
  class: { code: 'AMB' },
  type: [{ text: 'Diabetes follow-up' }],
  subject,
  period: { start: '2026-05-10T14:30:00Z', end: '2026-05-10T15:10:00Z' },
  participant: [{ individual: { reference: 'Practitioner/prac-1', display: 'Dr. Sarah Kim' } }],
  text: narrative('Encounter'),
});

add({
  resourceType: 'AllergyIntolerance',
  id: 'alg-1',
  clinicalStatus: { coding: [{ code: 'active' }] },
  verificationStatus: { coding: [{ code: 'confirmed' }] },
  criticality: 'high',
  code: { coding: [{ system: RXNORM, code: '7980', display: 'Penicillin G' }], text: 'Penicillin' },
  patient: subject,
  reaction: [{ manifestation: [{ text: 'Anaphylaxis' }], severity: 'severe' }],
  recordedDate: '2010-04-02',
});

const conditions = [
  ['cond-1', '44054006', 'Type 2 diabetes mellitus without complication', 'active', '2019-06-11'],
  ['cond-2', '59621000', 'Essential hypertension', 'active', '2021-01-20'],
  ['cond-3', '195662009', 'Acute viral pharyngitis', 'resolved', '2023-11-02'],
];
for (const [id, code, display, status, onset] of conditions) {
  add({
    resourceType: 'Condition',
    id,
    clinicalStatus: { coding: [{ code: status }] },
    verificationStatus: { coding: [{ code: 'confirmed' }] },
    code: { coding: [{ system: SNOMED, code, display }], text: display },
    subject,
    onsetDateTime: onset,
    recordedDate: onset,
    note: [{ text: 'Discussed with Maria Gonzalez (MRN-4471902); call back at 617-555-0142.' }],
    text: narrative(display),
  });
}

// 50 Metformin refills through medicationReference, rotating the three reference forms.
// The last one is the current active order.
for (let i = 0; i < 50; i++) {
  const form = i % 3;
  const reference = form === 0 ? 'Medication/med-1' : form === 1 ? medUrn : '#med-inline';
  const last = i === 49;
  add({
    resourceType: 'MedicationRequest',
    id: last ? 'medreq-104' : `medreq-refill-${i + 1}`,
    status: last ? 'active' : 'completed',
    intent: 'order',
    ...(form === 2
      ? {
          contained: [
            {
              resourceType: 'Medication',
              id: 'med-inline',
              code: { coding: [{ system: RXNORM, code: '861007', display: 'Glucophage 500 MG Oral Tablet' }] },
            },
          ],
        }
      : {}),
    medicationReference: { reference },
    subject,
    authoredOn: last ? '2025-08-12' : isoDay([2021, 8, 12], i * 30),
    requester: { reference: 'Practitioner/prac-1', display: 'Sarah Kim, MD' },
    dosageInstruction: [{ text: '1 tablet twice daily with meals' }],
    text: narrative('Medication order', 4),
  });
}

add({
  resourceType: 'MedicationRequest',
  id: 'medreq-088',
  status: 'stopped',
  intent: 'order',
  medicationCodeableConcept: {
    coding: [{ system: RXNORM, code: '314076', display: 'Lisinopril 10 MG Oral Tablet' }],
  },
  subject,
  authoredOn: '2024-10-01',
  statusReason: { text: 'Dry cough' },
  dosageInstruction: [{ text: '1 tablet daily' }],
});

add({
  resourceType: 'MedicationRequest',
  id: 'medreq-err-99',
  status: 'entered-in-error',
  intent: 'order',
  medicationCodeableConcept: { coding: [{ system: RXNORM, code: '243670', display: 'Aspirin 81 MG Oral Tablet' }] },
  subject,
  authoredOn: '2025-06-01',
});

add({
  resourceType: 'MedicationRequest',
  id: 'medreq-bad-1',
  status: 'active',
  intent: 'order',
  medicationCodeableConcept: {
    coding: [{ system: RXNORM, code: '1116634', display: 'Tiotropium 18 MCG Inhalation Capsule' }],
    text: 'Tiotropium 18 MCG',
  },
  subject,
  authoredOn: '2025-03-03',
  dosageInstruction: [{ text: 'Inhale 1 capsule daily' }],
});

// 30 HbA1c results with the same LOINC; the latest is obs-301 (7.8 %).
const a1c = [
  9.1, 9.0, 8.9, 8.8, 8.8, 8.7, 8.6, 8.6, 8.5, 8.5, 8.4, 8.4, 8.3, 8.3, 8.2, 8.2, 8.2, 8.1, 8.1, 8.1, 8.0, 8.0, 8.0,
  7.9, 7.9, 7.9, 7.9, 7.8, 7.8, 7.8,
];
a1c.forEach((value, i) => {
  const last = i === a1c.length - 1;
  add({
    resourceType: 'Observation',
    id: last ? 'obs-301' : `obs-a1c-${i + 1}`,
    status: 'final',
    category: [{ coding: [{ code: 'laboratory' }] }],
    code: {
      coding: [{ system: LOINC, code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }],
      text: 'HbA1c',
    },
    subject,
    effectiveDateTime: last ? '2025-08-10T08:15:00Z' : `${isoDay([2018, 2, 11], i * 91)}T08:15:00Z`,
    valueQuantity: { value, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
    interpretation: [{ coding: [{ code: 'H' }] }],
    referenceRange: [{ low: { value: 4.0, unit: '%' }, high: { value: 5.6, unit: '%' } }],
    text: narrative('HbA1c result', 8),
  });
});

add({
  resourceType: 'Observation',
  id: 'obs-ldl-1',
  status: 'final',
  code: {
    coding: [{ system: LOINC, code: '13457-7', display: 'Cholesterol in LDL [Mass/volume] in Serum or Plasma' }],
    text: 'LDL',
  },
  subject,
  effectiveDateTime: '2025-08-10T08:15:00Z',
  valueQuantity: { value: 112, unit: 'mg/dL' },
});
add({
  resourceType: 'DiagnosticReport',
  id: 'dr-lipid-1',
  status: 'final',
  code: { coding: [{ system: LOINC, code: '57698-3', display: 'Lipid panel' }] },
  subject,
  effectiveDateTime: '2025-08-10T08:15:00Z',
  result: [{ reference: 'Observation/obs-ldl-1' }],
});

const noteHtml =
  '<html><body><h1>Progress Note</h1>' +
  '<p>Pt Maria Gonzalez (MRN-4471902, DOB 03/14/1962) presents for f/u on 2025-08-10.</p>' +
  '<p>Breast core biopsy at outside facility: 2/12 cores positive. Foley catheter removed. ' +
  "Family history of Parkinson's disease. Motor strength 5/5.</p>" +
  '<p>HbA1c 7.8% today, improved from 8.4%. Continue metformin. Lisinopril was stopped for dry cough.</p>' +
  '<p>Signed: Sarah Kim, MD. Contact maria.gonzalez@example.com.</p></body></html>';
add({
  resourceType: 'DocumentReference',
  id: 'doc-12',
  status: 'current',
  type: { text: 'Progress Note' },
  subject,
  date: '2025-08-10T16:00:00Z',
  author: [{ reference: 'Practitioner/prac-1', display: 'Sarah Kim, MD' }],
  content: [{ attachment: { contentType: 'text/html', data: b64(noteHtml) } }],
});

const fakePdf = `%PDF-1.4\n${'0'.repeat(24_000)}\n%%EOF`;
add({
  resourceType: 'DocumentReference',
  // Epic Bulk exports sometimes emit ids longer than the FHIR 64-char limit.
  id: 'eRk2Lm9xPq7Tz4WbYc1Nd8Fg3Hj6Ks0Vu5Ai2Bo7Cp9Dq4Er1Fs6Gt3Hu8Iv0Jw5Kx2Ly7Mz-scan',
  status: 'current',
  type: { text: 'Scanned outside records' },
  subject,
  date: '2024-02-01',
  content: [{ attachment: { contentType: 'application/pdf', data: b64(fakePdf), title: 'Outside records' } }],
});

const bundle = { resourceType: 'Bundle', type: 'collection', entry: entries };
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
process.stderr.write(`wrote ${entries.length} entries to ${out}\n`);
