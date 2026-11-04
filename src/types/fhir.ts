/**
 * Minimal FHIR R4 type surface used by FHIRBridge.
 *
 * Deliberately permissive: real EHR exports (Epic, Cerner, eClinicalWorks,
 * Synthea) violate the spec in many small ways, so every field is optional
 * and unknown fields are preserved via the index signature.
 */

export interface Coding {
  system?: string;
  version?: string;
  code?: string;
  display?: string;
}

export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

export interface Identifier {
  use?: string;
  type?: CodeableConcept;
  system?: string;
  value?: string;
}

export interface Reference {
  reference?: string;
  type?: string;
  display?: string;
  identifier?: Identifier;
}

export interface Period {
  start?: string;
  end?: string;
}

export interface Quantity {
  value?: number;
  comparator?: string;
  unit?: string;
  system?: string;
  code?: string;
}

export interface Annotation {
  authorReference?: Reference;
  authorString?: string;
  time?: string;
  text?: string;
}

export interface HumanName {
  use?: string;
  text?: string;
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
}

export interface ContactPoint {
  system?: string;
  value?: string;
  use?: string;
}

export interface Address {
  use?: string;
  text?: string;
  line?: string[];
  city?: string;
  district?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface Extension {
  url: string;
  valueString?: string;
  valueCode?: string;
  valueDateTime?: string;
  valueReference?: Reference;
  valueInteger?: number;
  extension?: Extension[];
  [key: string]: unknown;
}

export interface Meta {
  versionId?: string;
  lastUpdated?: string;
  source?: string;
  tag?: Coding[];
  extension?: Extension[];
}

export interface Narrative {
  status?: string;
  div?: string;
}

export interface Attachment {
  contentType?: string;
  language?: string;
  data?: string;
  url?: string;
  size?: number;
  hash?: string;
  title?: string;
  creation?: string;
}

export interface Dosage {
  text?: string;
  timing?: unknown;
  route?: CodeableConcept;
  doseAndRate?: unknown[];
}

/** Base resource. Unknown fields are kept so normalization never drops data silently. */
export interface Resource {
  resourceType: string;
  id?: string;
  meta?: Meta;
  text?: Narrative;
  contained?: Resource[];
  extension?: Extension[];
  [key: string]: unknown;
}

export interface Patient extends Resource {
  resourceType: 'Patient';
  identifier?: Identifier[];
  name?: HumanName[];
  telecom?: ContactPoint[];
  gender?: string;
  birthDate?: string;
  deceasedBoolean?: boolean;
  deceasedDateTime?: string;
  address?: Address[];
}

export interface Practitioner extends Resource {
  resourceType: 'Practitioner';
  identifier?: Identifier[];
  name?: HumanName[];
  telecom?: ContactPoint[];
}

export interface Organization extends Resource {
  resourceType: 'Organization';
  identifier?: Identifier[];
  name?: string;
  telecom?: ContactPoint[];
  address?: Address[];
}

export interface Encounter extends Resource {
  resourceType: 'Encounter';
  status?: string;
  class?: Coding;
  type?: CodeableConcept[];
  subject?: Reference;
  period?: Period;
  reasonCode?: CodeableConcept[];
  participant?: { individual?: Reference }[];
}

export interface Condition extends Resource {
  resourceType: 'Condition';
  clinicalStatus?: CodeableConcept;
  verificationStatus?: CodeableConcept;
  category?: CodeableConcept[];
  code?: CodeableConcept;
  subject?: Reference;
  encounter?: Reference;
  onsetDateTime?: string;
  onsetPeriod?: Period;
  abatementDateTime?: string;
  recordedDate?: string;
  note?: Annotation[];
}

export interface Observation extends Resource {
  resourceType: 'Observation';
  status?: string;
  category?: CodeableConcept[];
  code?: CodeableConcept;
  subject?: Reference;
  encounter?: Reference;
  effectiveDateTime?: string;
  effectivePeriod?: Period;
  issued?: string;
  valueQuantity?: Quantity;
  valueCodeableConcept?: CodeableConcept;
  valueString?: string;
  interpretation?: CodeableConcept[];
  referenceRange?: { low?: Quantity; high?: Quantity; text?: string }[];
  hasMember?: Reference[];
  component?: { code?: CodeableConcept; valueQuantity?: Quantity }[];
  note?: Annotation[];
}

export interface Medication extends Resource {
  resourceType: 'Medication';
  code?: CodeableConcept;
  form?: CodeableConcept;
}

export interface MedicationRequest extends Resource {
  resourceType: 'MedicationRequest';
  status?: string;
  intent?: string;
  medicationCodeableConcept?: CodeableConcept;
  medicationReference?: Reference;
  subject?: Reference;
  encounter?: Reference;
  authoredOn?: string;
  requester?: Reference;
  dosageInstruction?: Dosage[];
  statusReason?: CodeableConcept;
  note?: Annotation[];
  dispenseRequest?: { numberOfRepeatsAllowed?: number; validityPeriod?: Period };
}

export interface MedicationStatement extends Resource {
  resourceType: 'MedicationStatement';
  status?: string;
  medicationCodeableConcept?: CodeableConcept;
  medicationReference?: Reference;
  subject?: Reference;
  effectiveDateTime?: string;
  effectivePeriod?: Period;
  dateAsserted?: string;
  dosage?: Dosage[];
  statusReason?: CodeableConcept[];
  note?: Annotation[];
}

export interface MedicationDispense extends Resource {
  resourceType: 'MedicationDispense';
  status?: string;
  medicationCodeableConcept?: CodeableConcept;
  medicationReference?: Reference;
  subject?: Reference;
  whenHandedOver?: string;
  whenPrepared?: string;
  dosageInstruction?: Dosage[];
  note?: Annotation[];
}

export interface AllergyIntolerance extends Resource {
  resourceType: 'AllergyIntolerance';
  clinicalStatus?: CodeableConcept;
  verificationStatus?: CodeableConcept;
  criticality?: string;
  code?: CodeableConcept;
  patient?: Reference;
  onsetDateTime?: string;
  recordedDate?: string;
  reaction?: { manifestation?: CodeableConcept[]; severity?: string }[];
  note?: Annotation[];
}

export interface Procedure extends Resource {
  resourceType: 'Procedure';
  status?: string;
  code?: CodeableConcept;
  subject?: Reference;
  performedDateTime?: string;
  performedPeriod?: Period;
  note?: Annotation[];
}

export interface DiagnosticReport extends Resource {
  resourceType: 'DiagnosticReport';
  status?: string;
  category?: CodeableConcept[];
  code?: CodeableConcept;
  subject?: Reference;
  effectiveDateTime?: string;
  effectivePeriod?: Period;
  issued?: string;
  result?: Reference[];
  conclusion?: string;
  presentedForm?: Attachment[];
}

export interface DocumentReference extends Resource {
  resourceType: 'DocumentReference';
  status?: string;
  docStatus?: string;
  type?: CodeableConcept;
  subject?: Reference;
  date?: string;
  author?: Reference[];
  description?: string;
  content?: { attachment: Attachment; format?: Coding }[];
  context?: { period?: Period; encounter?: Reference[] };
}

export interface Binary extends Resource {
  resourceType: 'Binary';
  contentType?: string;
  data?: string;
}

export interface BundleEntry {
  fullUrl?: string;
  resource?: Resource;
  search?: { mode?: string };
  request?: { method?: string; url?: string };
}

export interface Bundle extends Resource {
  resourceType: 'Bundle';
  type?: string;
  total?: number;
  entry?: BundleEntry[];
  link?: { relation?: string; url?: string }[];
}

/** Resource types that carry a medication[x] choice. */
export type MedicationUsage = MedicationRequest | MedicationStatement | MedicationDispense;

export function isResource(value: unknown): value is Resource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { resourceType?: unknown }).resourceType === 'string'
  );
}

/** `ResourceType/id` — the canonical anchor used in compiled context and citations. */
export function resourceKey(resource: Pick<Resource, 'resourceType' | 'id'>): string {
  return `${resource.resourceType}/${resource.id ?? ''}`;
}
