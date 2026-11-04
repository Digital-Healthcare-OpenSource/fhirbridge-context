/**
 * Validation of "structural" string members that the walker used to pass through untouched
 * (codes, systems, units, statuses, extension urls...). A value that does not have the shape of
 * its field, or that carries a registered name / identifier, is scrubbed or replaced: a PHI value
 * hidden in a code or a system URI never survives.
 */
import { mentionsRegistered, termsFor } from './registered-terms.js';
import { scrub, type RulesContext } from './structured-handlers.js';

export const REDACTED_SYSTEM = 'urn:fhirbridge:redacted-system';

const CODE_SHAPE = /^[A-Za-z0-9._:\-/ ]{1,64}$/;
const VERSION_SHAPE = /^[A-Za-z0-9._:\-/ +]{1,64}$/;
const UNIT_SHAPE = /^[A-Za-z0-9%/.[\]{}()^*\-' ]{1,32}$/;
const MIME_SHAPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,96}(?:\s{0,2};\s{0,2}[A-Za-z0-9-]{1,32}=[A-Za-z0-9"._-]{1,32}){0,3}$/;
const ABSOLUTE_URI = /^(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s]{1,400}|urn:(?:oid|uuid):[A-Za-z0-9.-]{1,80}|urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:[^\s]{1,200})$/;
/** Numeric terminology codes: SNOMED / RxNorm / CPT digits, NDC segments, LOINC with check digit. */
const NUMERIC_TERMINOLOGY = /^(?:\d{1,18}|\d{4,5}-\d{3,4}-\d{1,2}|\d{1,7}-\d)$/;
const LONG_DIGIT_RUN = /\d{5,}/;
const SSN_SHAPE = /\d{3}-\d{2}-\d{4}/;
const DATE_SHAPE = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/;
const PHONE_SHAPE = /\d{3}[-.\s]\d{3}[-.\s]\d{4}/;

/** Keys whose string value is a short structural code (FHIR `code`, `status`, `use`...). */
export const CODE_LIKE_KEYS: ReadonlySet<string> = new Set([
  'code', 'valueCode', 'status', 'priority', 'language', 'intent', 'use', 'gender',
  'criticality', 'severity', 'comparator', 'type', 'versionId',
]);
const URI_KEYS: ReadonlySet<string> = new Set(['system', 'profile', 'fullUrl']);

const scopeTerms = (ctx: RulesContext) => termsFor(ctx.knownNames);

/** `code` and its siblings: strict code shape, no registered PHI, no unexplained long digit run. */
export function validateCode(ctx: RulesContext, key: string, v: string): string {
  const allowsNumeric = key === 'code' || key === 'valueCode';
  const digitsOk = !LONG_DIGIT_RUN.test(v) || (allowsNumeric && NUMERIC_TERMINOLOGY.test(v));
  const shaped = CODE_SHAPE.test(v) && !SSN_SHAPE.test(v) && !DATE_SHAPE.test(v) && !PHONE_SHAPE.test(v);
  return shaped && digitsOk && !mentionsRegistered(v, scopeTerms(ctx)) ? v : scrub(ctx, v);
}

/** `version`: relaxed shape (versions embed dates and URLs) but never a registered value. */
export function validateVersion(ctx: RulesContext, v: string): string {
  return VERSION_SHAPE.test(v) && !mentionsRegistered(v, scopeTerms(ctx)) ? v : scrub(ctx, v);
}

/** Absolute URI (or urn:oid / urn:uuid) whose path carries no registered PHI or long digit run. */
export function validateUri(ctx: RulesContext, v: string): string {
  const trimmed = v.trim();
  if (!ABSOLUTE_URI.test(trimmed)) return REDACTED_SYSTEM;
  const isUrn = /^urn:/i.test(trimmed);
  const path = isUrn ? '' : trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '');
  if (!isUrn && LONG_DIGIT_RUN.test(path)) return REDACTED_SYSTEM;
  return mentionsRegistered(trimmed, scopeTerms(ctx)) ? REDACTED_SYSTEM : v;
}

const REFERENCE_SHAPE =
  /^(?:#[A-Za-z0-9\-.]{1,64}|urn:[A-Za-z0-9:.-]{1,200}|(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?#]{1,300}\/)?[A-Z][A-Za-z]{1,40}\/[^\s/?#]{1,128}(?:\/_history\/[^\s/]{1,64})?)$/;

/** `Reference.reference`: relative / absolute / contained / urn form; free text is scrubbed. */
export function validateReference(ctx: RulesContext, v: string): string {
  return REFERENCE_SHAPE.test(v) ? v : scrub(ctx, v);
}

/** UCUM-ish unit; anything else (or a unit naming a registered value) is scrubbed. */
export function validateUnit(ctx: RulesContext, v: string): string {
  return UNIT_SHAPE.test(v) && !mentionsRegistered(v, scopeTerms(ctx)) ? v : scrub(ctx, v);
}

export function validateContentType(ctx: RulesContext, v: string): string {
  return MIME_SHAPE.test(v) && !mentionsRegistered(v, scopeTerms(ctx)) ? v : scrub(ctx, v);
}

/** Dispatch for the keys that used to be passed through; undefined = not a validated key. */
export function validateStructural(
  ctx: RulesContext,
  key: string,
  v: string,
  container?: string,
): string | undefined {
  // ContactPoint.system is a code ("phone"), not a URI.
  const contactPoint = container === 'telecom' || container === 'valueContactPoint';
  if (CODE_LIKE_KEYS.has(key) || (key === 'system' && contactPoint)) return validateCode(ctx, key, v);
  if (URI_KEYS.has(key)) return validateUri(ctx, v);
  if (key === 'unit') return validateUnit(ctx, v);
  if (key === 'contentType') return validateContentType(ctx, v);
  if (key === 'version') return validateVersion(ctx, v);
  return undefined;
}
