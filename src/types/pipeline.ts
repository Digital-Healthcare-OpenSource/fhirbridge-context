/**
 * Cross-layer contracts. Every layer codes against these types only, so the
 * normalizer, de-identifier, compiler and verifier can evolve independently.
 *
 *   load → normalize (Layer 1) → deidentify (Layer 2) → compile (Layer 3)
 *                                                      ↘ verify/rehydrate (Layer 4)
 */
import type { CodeableConcept, Resource } from './fhir.js';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/** One resource as read from disk, with the Bundle `fullUrl` it came with (if any). */
export interface InputEntry {
  resource: Resource;
  fullUrl?: string;
}

export interface LoadedInput {
  entries: InputEntry[];
  /** Total raw bytes read from disk (UTF-8). */
  bytes: number;
  /**
   * @deprecated Not retained by the file loader (it doubled peak memory on large Bulk exports).
   * Token estimates are derived from `bytes`. Still accepted when callers already hold the text.
   */
  rawText?: string;
  source: 'bundle' | 'resource-array' | 'single-resource' | 'ndjson-file' | 'ndjson-dir';
}

/* ------------------------------------------------------------------ */
/* Layer 1 — normalizer                                                */
/* ------------------------------------------------------------------ */

/**
 * Clinical status gate.
 *  - active:     usable as current clinical truth
 *  - historical: stopped / cancelled / completed / resolved / inactive — shown only as past
 *  - excluded:   entered-in-error / refuted — never shown as clinical fact
 *  - unknown:    no status information
 */
export type StatusClass = 'active' | 'historical' | 'excluded' | 'unknown';

export type IntegrityWarningCode =
  | 'EXCLUDED_ENTERED_IN_ERROR'
  | 'CODE_DISPLAY_MISMATCH'
  | 'UNRESOLVED_REFERENCE'
  | 'ID_SHORTENED'
  | 'LAST_UPDATED_INFERRED'
  | 'ATTACHMENT_DECODED'
  | 'BINARY_ATTACHMENT_STRIPPED'
  | 'DUPLICATE_RESOURCE'
  | 'INVALID_RESOURCE';

export interface IntegrityWarning {
  code: IntegrityWarningCode;
  /** `ResourceType/id` of the resource the warning is about. */
  resourceKey: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ResourceIndex {
  /**
   * Resolve any reference form: `Type/id`, absolute URL ending in `Type/id`,
   * `urn:uuid:…` (Bundle fullUrl), or `#id` (contained — relative to `from`).
   */
  resolve(reference: string, from?: Resource): Resource | undefined;
  /** Lookup by canonical `Type/id`. */
  get(key: string): Resource | undefined;
  has(key: string): boolean;
  all(): Resource[];
  byType<T extends Resource = Resource>(resourceType: string): T[];
}

export interface DecodedDocument {
  /** `DocumentReference/id`, `DiagnosticReport/id` or `Binary/id`. */
  resourceKey: string;
  contentType: string;
  /** Plain clinical text, HTML/XML/RTF stripped, capped at 4000 chars. */
  text: string;
  /** Full text split into ≤4000-char chunks. */
  chunks: string[];
  truncated: boolean;
  sourceSizeBytes: number;
  sha256: string;
}

/** Medication identity after reference resolution + RxNorm brand→ingredient normalization. */
export interface NormalizedMedication {
  /** Human display, e.g. "Metformin 500 MG Oral Tablet". */
  display: string;
  /** RxNorm code used for grouping (ingredient-level when known). */
  rxnorm?: string;
  /** Generic ingredient name if the input was a brand, e.g. "Metformin". */
  ingredient?: string;
  /** Stable key used to deduplicate refills of the same drug. */
  dedupeKey: string;
  concept: CodeableConcept;
}

export interface NormalizedGraph {
  /** Normalized top-level resources (excluded ones stay so audits can still cite them). */
  resources: Resource[];
  index: ResourceIndex;
  /** `Type/id` → status class. Every resource has an entry. */
  status: Map<string, StatusClass>;
  /** `Type/id` → `Patient/id` that owns it (subject / patient / the Patient itself). */
  patientOf: Map<string, string>;
  /** Parent `Type/id` → child Observation keys (DiagnosticReport.result, Observation.hasMember). */
  members: Map<string, string[]>;
  /** MedicationRequest/Statement/Dispense `Type/id` → resolved, normalized medication. */
  medications: Map<string, NormalizedMedication>;
  documents: DecodedDocument[];
  warnings: IntegrityWarning[];
  /** Keys excluded by the status gate (entered-in-error / refuted). */
  excluded: string[];
  /** `Type/originalId` → shortened id for ids longer than 64 chars. */
  idMap: Map<string, string>;
  stats: {
    inputResources: number;
    inputBytes: number;
    /** Heuristic token estimate of the raw input text. */
    inputTokens: number;
  };
}

/* ------------------------------------------------------------------ */
/* Layer 2 — de-identification                                         */
/* ------------------------------------------------------------------ */

/** Token categories covering the 18 HIPAA Safe Harbor identifier groups. */
export type PhiCategory =
  | 'PATIENT'
  | 'PROVIDER'
  | 'PERSON'
  | 'ORG'
  | 'MRN'
  | 'SSN'
  | 'PHONE'
  | 'FAX'
  | 'EMAIL'
  | 'URL'
  | 'IP'
  | 'ADDRESS'
  | 'HEALTH_PLAN'
  | 'ACCOUNT'
  | 'LICENSE'
  | 'VEHICLE'
  | 'DEVICE'
  | 'BIOMETRIC'
  | 'PHOTO'
  | 'ID';

/** Read-only view of the vault — all that Layers 3 and 4 need. */
export interface VaultReader {
  /** `[PATIENT_1]` → original value, or undefined for an unknown token. */
  resolveToken(token: string): string | undefined;
  /** All issued tokens, e.g. `[PATIENT_1]`, `[MRN_1]`. */
  tokens(): string[];
  /** Day offset applied to this patient (negative, in [-365, -2]). */
  dateShiftDaysFor(patientKey: string): number | undefined;
  /** `Patient/id` → day offset. */
  dateShifts(): ReadonlyMap<string, number>;
  /**
   * Inclusive window of SHIFTED calendar dates (YYYY-MM-DD) emitted for this patient.
   * Rehydration only reverses dates within [min − 400d, max + 400d], so unrelated dates an
   * LLM writes (guideline years, today's date) are left untouched.
   */
  shiftedDateWindow(patientKey: string): { min: string; max: string } | undefined;
  /** Keys of every patient that has a date shift in this vault. */
  patientKeys(): string[];
  /**
   * Exact set of SHIFTED calendar dates (YYYY-MM-DD) that de-identification emitted for this
   * patient. Rehydration reverses only these, so dates the LLM computed or invented are never
   * silently moved.
   */
  emittedShiftedDates(patientKey: string): ReadonlySet<string>;
  /**
   * Original `Type/id` for a de-identified resource key whose id was pseudonymized
   * (ids that embed identifiers). Undefined when the key was not pseudonymized.
   */
  originalResourceKey(deidKey: string): string | undefined;
}

/**
 * Counts only. Must never carry date offsets, raw values or anything derived from them:
 * this object is rendered into LLM-facing output.
 */
export interface SafeHarborSummary {
  enabled: true;
  /** Replacement counts per token category. */
  replacements: Partial<Record<PhiCategory, number>>;
  datesShifted: number;
  /** Number of patients that received a (secret) date shift. */
  patientsShifted: number;
  /** Patients whose age (> 89) was capped to "90+". */
  agesCapped: number;
  /** ZIP codes in a restricted ZIP3 (< 20,000 population) → "00000". */
  zip3Restricted: number;
  /** ZIP codes generalized to "<ZIP3>XX". */
  zip3Generalized: number;
  /** Human-readable list of Safe Harbor rules enforced. */
  rulesApplied: string[];
}

export interface DeidResult {
  graph: NormalizedGraph;
  summary: SafeHarborSummary;
}

/* ------------------------------------------------------------------ */
/* Layer 3 — compiler                                                  */
/* ------------------------------------------------------------------ */

export type ContextFormat = 'clinical-md' | 'view-json' | 'csv' | 'fhir-slim';

export interface TokenReport {
  inputTokens: number;
  outputTokens: number;
  /** 0–100, one decimal. */
  reductionPct: number;
  /** Rough input-token cost saved at $3 per 1M tokens. */
  estimatedCostSavedUsd: number;
  method: 'heuristic-chars-per-token';
}

export interface CompileOptions {
  format: ContextFormat;
  /** Present when the graph was de-identified; drives the header line. */
  safeHarbor?: SafeHarborSummary;
  /** Reference "now" for age computation. Defaults to the current time. */
  now?: Date;
  /** Restrict output to one patient when the graph holds several. */
  patientKey?: string;
}

export interface CompiledContext {
  format: ContextFormat;
  content: string;
  tokens: TokenReport;
}

export type ViewRow = Record<string, string | number | boolean | null>;
export type ViewTables = Record<
  'patient_demographics' | 'active_conditions' | 'active_medications' | 'lab_observations',
  ViewRow[]
>;

/* ------------------------------------------------------------------ */
/* Layer 4 — verifier                                                  */
/* ------------------------------------------------------------------ */

export type CitationIssueCode =
  | 'HALLUCINATED_RESOURCE_ID'
  | 'CRITICAL_STATUS_CONTRADICTION'
  | 'EXCLUDED_RESOURCE_CITED'
  | 'NUMERIC_VALUE_MISMATCH';

export interface CitationIssue {
  code: CitationIssueCode;
  severity: 'critical' | 'warning';
  /** The cited anchor, e.g. `MedicationRequest/medreq-stopped-2`. */
  citation: string;
  sentence: string;
  message: string;
}

export interface CitationCheck {
  citation: string;
  sentence: string;
  exists: boolean;
  status?: StatusClass;
  ok: boolean;
}

export interface CitationAuditReport {
  /** False when any critical issue was found. */
  ok: boolean;
  citations: CitationCheck[];
  issues: CitationIssue[];
}

export interface RehydrateOptions {
  /** Patient whose date shift to reverse. Defaults to the vault's only patient. */
  patientKey?: string;
}
