/**
 * Clinical free-text scrubber (HIPAA Safe Harbor).
 *
 * Pipeline: protect clinical fractions -> neutralize literal tokens -> structured identifiers ->
 * addresses/postal codes -> birth cues / ages > 89 / dates -> own identifiers + digit runs ->
 * names -> restore. Medical eponyms, devices, specialties and drug names are never treated as
 * person names unless the name is registered from structured data.
 * PRIVACY CRITICAL: when unsure about a PHI-shaped value, remove it.
 *
 * Without a date shift (no `dateShiftDays` and no shift registered for `patientKey`) dates
 * are generalized to their year (allowed by Safe Harbor) instead of being left intact. A
 * birth date is ALWAYS reduced to its year (or "90+" when older than 89).
 */
import { generalizeZip } from '../dictionaries/hipaa-zip3.js';
import { ADDRESS_RE, FRACTION_RES, ID_RULES, POSTAL_RE, ZIP_RES } from './scrub-patterns.js';
import { scrubIdentifiers } from './scrub-identifiers.js';
import { scrubNames } from './scrub-names.js';
import { PH_CLOSE, PH_OPEN, Shield, bump, type Acc, type Run, type ScrubContext, type ScrubResult } from './scrub-types.js';
import { applyAges, applyBirthCues, applyTextDates } from './text-dates.js';

export type { KnownName, ScrubContext, ScrubResult } from './scrub-types.js';

/** Input must never carry the private-use delimiters the Shield uses for held output. */
const PLACEHOLDER_CHARS_RE = new RegExp(`[${PH_OPEN}${PH_CLOSE}]`, 'g');
/** A `[CATEGORY_n]` already present in SOURCE text must never be mistaken for a vault token. */
const LITERAL_TOKEN_RE = /\[([A-Z][A-Z_]*_\d+)\]/g;

/* ---------------------------- structured identifiers --------------------------- */

function applyIdRules(text: string, run: Run): string {
  let out = text;
  for (const rule of ID_RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const groups = args[args.length - 1] as { lab?: string; v: string };
      const offset = args[args.length - 3] as number;
      const whole = args[args.length - 2] as string;
      const category =
        typeof rule.category === 'function'
          ? rule.category(whole.slice(Math.max(0, offset - 12), offset))
          : rule.category;
      const tail = rule.trimTail ? (/[.,;:!?]+$/.exec(groups.v)?.[0] ?? '') : '';
      const value = tail ? groups.v.slice(0, -tail.length) : groups.v;
      const token = run.ctx.vault.tokenFor(category, value, { patientKey: run.ctx.patientKey });
      bump(run.acc, category);
      return `${rule.dropLabel ? '' : (groups.lab ?? '')}${token}${tail}`;
    });
  }
  return out;
}

function applyAddressAndZip(text: string, run: Run): string {
  let out = text.replace(ADDRESS_RE, (m) => {
    bump(run.acc, 'ADDRESS');
    return run.ctx.vault.tokenFor('ADDRESS', m);
  });
  out = out.replace(POSTAL_RE, (...args: unknown[]) => {
    const groups = args[args.length - 1] as { lab: string; v: string };
    bump(run.acc, 'ADDRESS');
    return `${groups.lab}${run.ctx.vault.tokenFor('ADDRESS', groups.v)}`;
  });
  for (const re of ZIP_RES) {
    out = out.replace(re, (...args: unknown[]) => {
      const groups = args[args.length - 1] as { lab: string; v: string };
      const zip = generalizeZip(groups.v);
      if (zip.restricted) run.acc.zip3Restricted += 1;
      else run.acc.zip3Generalized += 1;
      return `${groups.lab}${run.shield.hold(zip.value)}`;
    });
  }
  return out;
}

/* ------------------------------------ entry ------------------------------------ */

export function scrubText(text: string, ctx: ScrubContext): ScrubResult {
  const acc: Acc = { counts: {}, datesShifted: 0, zip3Restricted: 0, zip3Generalized: 0 };
  const shield = new Shield();
  const days =
    ctx.dateShiftDays ?? (ctx.patientKey ? ctx.vault.dateShiftDaysFor(ctx.patientKey) : undefined);
  const run: Run = { ctx, acc, shield, now: ctx.now ?? new Date(), days };
  let t = text.replace(PLACEHOLDER_CHARS_RE, '').replace(LITERAL_TOKEN_RE, '($1)');
  for (const re of FRACTION_RES) t = t.replace(re, (m) => shield.hold(m));
  t = applyIdRules(t, run);
  t = applyAddressAndZip(t, run);
  t = applyBirthCues(t, run);
  t = applyAges(t, run);
  t = applyTextDates(t, run);
  t = scrubIdentifiers(t, run);
  t = scrubNames(t, run);
  return { text: shield.restore(t), ...acc };
}
