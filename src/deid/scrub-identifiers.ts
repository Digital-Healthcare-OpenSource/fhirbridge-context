/**
 * Identifier pass of the free-text scrubber.
 *
 *  1. The structured identifiers of the record owner (MRN, plan ids, phone numbers, emails,
 *     device ids, postal codes...) are swept from free text, digit-normalized so "4155550142",
 *     "415-555-0142" and "(415) 555-0142" are one value, and replaced with the SAME token the
 *     structured field received.
 *  2. Any other standalone run of 7+ digits (separators `-`, `.`, space allowed) becomes [ID_n]
 *     unless it is a clinical code, a decimal or a measured value.
 * Every quantifier is bounded so pathological input stays linear.
 */
import type { PhiCategory } from '../types/pipeline.js';
import { bump, type KnownName, type Run } from './scrub-types.js';

interface OwnId {
  category: PhiCategory;
  raw: string;
}

interface Registry {
  digits: Map<string, OwnId>;
  /** Lower-case literals (emails, alphanumeric ids). */
  literals: Map<string, OwnId>;
  /** Alphanumeric-only form of ids that mix letters and digits. */
  alnum: Map<string, OwnId>;
}

const MIN_DIGITS_REGISTERED = 5;
const MIN_DIGITS_GENERIC = 7;
const MIN_LITERAL = 4;
const PHONE_LIKE = /^[\d\s().+-]+$/;

function register(reg: Registry, category: PhiCategory, raw: string): void {
  const value = raw.trim();
  if (!value) return;
  const own: OwnId = { category, raw: value };
  const digits = value.replace(/\D/g, '');
  if (PHONE_LIKE.test(value)) {
    if (digits.length >= MIN_DIGITS_REGISTERED) {
      reg.digits.set(digits, own);
      if (digits.length === 11 && digits.startsWith('1')) reg.digits.set(digits.slice(1), own);
    }
    return;
  }
  const lower = value.toLowerCase();
  if (lower.length >= MIN_LITERAL) reg.literals.set(lower, own);
  const alnum = lower.replace(/[^a-z0-9]/g, '');
  if (alnum.length >= MIN_DIGITS_REGISTERED && /\d/.test(alnum)) reg.alnum.set(alnum, own);
  // "MRN-88213377" / "GRP-445566": the numeric part alone is how it is usually written in prose.
  if (digits.length >= MIN_DIGITS_REGISTERED && alnum.length - digits.length <= 4) reg.digits.set(digits, own);
}

const registryCache = new WeakMap<readonly KnownName[], Registry | null>();

function registryFor(known: readonly KnownName[] | undefined): Registry | null {
  if (!known) return null;
  const cached = registryCache.get(known);
  if (cached !== undefined) return cached;
  const reg: Registry = { digits: new Map(), literals: new Map(), alnum: new Map() };
  let any = false;
  for (const k of known) {
    if (k.category !== 'IDENTIFIER' || !k.idCategory) continue;
    for (const v of k.variants) register(reg, k.idCategory, v);
    any = true;
  }
  const out = any ? reg : null;
  registryCache.set(known, out);
  return out;
}

/* ------------------------------ digit runs ------------------------------ */

const RUN_RE =
  /(?<![\p{L}\p{N}_])(?<![.,]\d)\+?\(?\d{3,}\)?(?:[-. ]\(?\d{3,}\)?){0,5}(?:[-. ]\d{2,})?(?![\p{L}\p{N}_])(?![.,]\d)/gu;
const CODE_LABEL_BEFORE =
  /(?:rxnorm|rxcui|loinc|snomed(?:\s?ct)?|icd\W?\d{0,2}(?:\W?cm)?|cpt|ndc|cvx|hcpcs|atc|oid|code|umls|cui)\W{0,3}$/i;
const UNIT_AFTER = /^\s{0,2}(?:mg|mcg|µg|ug|g|kg|ml|l|dl|mmol|mol|iu|units?|cells?|copies|mm|cm|bpm|%)(?![\p{L}])/iu;

function lookupDigits(reg: Registry | null, digits: string): OwnId | undefined {
  return reg?.digits.get(digits) ?? (digits.length === 11 && digits.startsWith('1') ? reg?.digits.get(digits.slice(1)) : undefined);
}

function tokenOf(run: Run, own: OwnId): string {
  bump(run.acc, own.category);
  return run.ctx.vault.tokenFor(own.category, own.raw, { patientKey: run.ctx.patientKey });
}

function replaceRuns(text: string, run: Run, reg: Registry | null): string {
  return text.replace(RUN_RE, (m: string, ...rest: unknown[]) => {
    const offset = rest[rest.length - 2] as number;
    const whole = rest[rest.length - 1] as string;
    const digits = m.replace(/\D/g, '');
    const own = digits.length >= MIN_DIGITS_REGISTERED ? lookupDigits(reg, digits) : undefined;
    if (own) return tokenOf(run, own);
    if (digits.length < MIN_DIGITS_GENERIC) return m;
    if (/^\d+\.\d+$/.test(m)) return m;
    if (CODE_LABEL_BEFORE.test(whole.slice(Math.max(0, offset - 24), offset))) return m;
    if (UNIT_AFTER.test(whole.slice(offset + m.length, offset + m.length + 14))) return m;
    bump(run.acc, 'ID');
    return run.ctx.vault.tokenFor('ID', digits);
  });
}

/* ------------------------------ literal tokens ------------------------------ */

const CANDIDATE_RE = /[\p{L}\p{N}][\p{L}\p{N}._%+@'’-]{2,100}/gu;
const TRAILING_PUNCT = /[._%+@'’-]+$/;

function lookupLiteral(reg: Registry, candidate: string): OwnId | undefined {
  const lower = candidate.toLowerCase();
  const hit = reg.literals.get(lower) ?? reg.alnum.get(lower.replace(/[^a-z0-9]/g, ''));
  if (hit) return hit;
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < MIN_DIGITS_REGISTERED || !/\p{L}/u.test(candidate)) return undefined;
  return reg.digits.get(digits);
}

function replaceLiterals(text: string, run: Run, reg: Registry): string {
  return text.replace(CANDIDATE_RE, (m: string) => {
    const tail = TRAILING_PUNCT.exec(m)?.[0] ?? '';
    const core = tail ? m.slice(0, -tail.length) : m;
    const own = core.length >= MIN_LITERAL ? lookupLiteral(reg, core) : undefined;
    return own ? `${tokenOf(run, own)}${tail}` : m;
  });
}

/** Registered identifiers first (same token as the structured field), then generic digit runs. */
export function scrubIdentifiers(text: string, run: Run): string {
  const reg = registryFor(run.ctx.knownNames);
  const withLiterals = reg ? replaceLiterals(text, run, reg) : text;
  return replaceRuns(withLiterals, run, reg);
}
