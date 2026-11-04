import { FhirBridgeError } from '../errors.js';
import { shiftDatesInText } from '../shared/fhir-date.js';
import type { RehydrateOptions, VaultReader } from '../types/pipeline.js';

/** Never hold more than this many characters back (ample for the longest token or date). */
const MAX_HOLD_BACK = 32;

const PHI_CATEGORIES =
  'PATIENT|PROVIDER|PERSON|ORG|MRN|SSN|PHONE|FAX|EMAIL|URL|IP|ADDRESS|HEALTH_PLAN|ACCOUNT|LICENSE|VEHICLE|DEVICE|BIOMETRIC|PHOTO|ID';
/** Counter is capped at 6 digits so a token is always ≤ 20 chars and hold-back is bounded. */
const TOKEN_RE = new RegExp(`\\[(?:${PHI_CATEGORIES})_\\d{1,6}\\]`, 'g');
/** A suffix that may still grow into a token: `[` followed by token-alphabet characters. */
const TOKEN_PREFIX_TAIL_RE = /\[[A-Z0-9_]{0,19}$/;
/**
 * A suffix that may still grow into (or be) a date: up to 4 year digits, or a full year followed
 * by `-MM[-DD]` in progress. The char before must not be a word char (same rule as ``).
 */
const DATE_PREFIX_TAIL_RE = /(?<![A-Za-z0-9_])(?:\d{1,4}|\d{4}-\d{0,2}(?:-\d{0,2})?)$/;

/**
 * Patient whose shift is reversed. With several patients in the vault the caller must say which:
 * guessing would silently move dates by the wrong offset.
 */
function patientKeyFor(vault: VaultReader, requested?: string): string | undefined {
  if (requested) return requested;
  const keys = vault.patientKeys();
  if (keys.length > 1) {
    throw new FhirBridgeError('USAGE', `Vault holds ${keys.length} patients; pass --patient Patient/id.`);
  }
  return keys[0];
}

type Transform = (text: string) => string;

/** Build the text → text rehydration function once (shift, emitted dates and patient are fixed). */
function buildTransform(vault: VaultReader, opts: RehydrateOptions): Transform {
  const patientKey = patientKeyFor(vault, opts.patientKey);
  const delta = patientKey ? vault.dateShiftDaysFor(patientKey) : undefined;
  const emitted = patientKey ? vault.emittedShiftedDates(patientKey) : undefined;

  // Only dates the tool itself emitted are reversed; any other date stays exactly as written.
  const wasEmitted = (iso: string): boolean => emitted?.has(iso) === true;

  return (text) => {
    // Dates first: resolved values (e.g. a real DOB) are already unshifted and must not be touched.
    const dated = delta === undefined || delta === 0 ? text : shiftDatesInText(text, -delta, wasEmitted);
    return dated.replace(TOKEN_RE, (token) => vault.resolveToken(token) ?? token);
  };
}

/** Distinct PHI tokens (`[PATIENT_1]`, …) appearing in `text`. */
export function extractTokens(text: string): string[] {
  return [...new Set(text.match(TOKEN_RE) ?? [])];
}

/** Replace PHI tokens with vault values and reverse the patient's date shift. */
export function rehydrate(text: string, vault: VaultReader, opts: RehydrateOptions = {}): string {
  return buildTransform(vault, opts)(text);
}

function holdBackLength(buffer: string): number {
  const token = TOKEN_PREFIX_TAIL_RE.exec(buffer)?.[0].length ?? 0;
  const date = DATE_PREFIX_TAIL_RE.exec(buffer)?.[0].length ?? 0;
  return Math.min(Math.max(token, date), MAX_HOLD_BACK);
}

/**
 * Incremental rehydrator for SSE/streaming proxies. A tail that could still become a token
 * (`[PAT`) or a date (`2025-08-`, or a complete date that a digit may still extend) is held
 * back, so the concatenated output of `push()`/`end()` equals `rehydrate(fullText)` for any
 * chunking.
 */
export class StreamRehydrator {
  private readonly transform: Transform;
  private buffer = '';
  /** Whether the last emitted character was a word character (left context for the date `\b` rule). */
  private afterWordChar = false;

  constructor(vault: VaultReader, opts: RehydrateOptions = {}) {
    this.transform = buildTransform(vault, opts);
  }

  /** Feed a chunk; returns the text that is safe to emit now. */
  push(chunk: string): string {
    this.buffer += chunk;
    const cut = this.buffer.length - holdBackLength(this.buffer);
    const ready = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return this.emit(ready);
  }

  /** Flush whatever is still buffered (end of stream). */
  end(): string {
    const rest = this.buffer;
    this.buffer = '';
    return this.emit(rest);
  }

  /** Transform with the previous character as left context, then drop that context again. */
  private emit(raw: string): string {
    if (raw === '') return '';
    // A stand-in word char (never a digit) reproduces "a word char precedes this text" without
    // letting the real previous digit combine with the new text into a false date.
    const context = this.afterWordChar ? 'a' : '';
    const out = this.transform(context + raw).slice(context.length);
    this.afterWordChar = /[A-Za-z0-9_]$/.test(raw);
    return out;
  }
}
