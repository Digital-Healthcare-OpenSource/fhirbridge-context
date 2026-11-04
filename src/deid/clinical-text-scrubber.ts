/**
 * Clinical free-text scrubber (HIPAA Safe Harbor).
 *
 * Pipeline: protect clinical fractions -> structured identifiers -> addresses/postal codes ->
 * DOB / age>89 -> dates -> names -> restore. Medical eponyms, devices, specialties and drug
 * names are never treated as person names unless the name is registered from structured data.
 * PRIVACY CRITICAL: when unsure about a PHI-shaped value, remove it.
 *
 * Without a date shift (no `dateShiftDays` and no shift registered for `patientKey`) dates
 * are generalized to their year (allowed by Safe Harbor) instead of being left intact. A
 * birth date is ALWAYS reduced to its year (or "90+" when older than 89).
 */
import { generalizeZip } from '../dictionaries/hipaa-zip3.js';
import { ageInYears, shiftFhirDate } from '../shared/fhir-date.js';
import { AGE_CAP_LABEL } from './date-shifter.js';
import {
  ADDRESS_RE,
  AGE_RE,
  DATE_RE,
  DOB_RE,
  FRACTION_RES,
  ID_RULES,
  POSTAL_RE,
  ZIP_RES,
  parseAnyDate,
} from './scrub-patterns.js';
import { scrubNames } from './scrub-names.js';
import { Shield, bump, type Acc, type Run, type ScrubContext, type ScrubResult } from './scrub-types.js';

export type { KnownName, ScrubContext, ScrubResult } from './scrub-types.js';

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

/* ----------------------------------- dates ------------------------------------- */

function shiftedDateText(iso: string, run: Run): string {
  if (run.days === undefined) return iso.slice(0, 4);
  const shifted = shiftFhirDate(iso, run.days);
  run.acc.datesShifted += 1;
  if (run.ctx.patientKey) run.ctx.vault.recordShiftedDate(run.ctx.patientKey, shifted);
  return shifted;
}

function applyDobAndDates(text: string, run: Run): string {
  let out = text.replace(DOB_RE, (...args: unknown[]) => {
    const groups = args[args.length - 1] as { lab: string; v: string };
    const iso = parseAnyDate(groups.v);
    if (!iso) return args[0] as string;
    const age = ageInYears(iso, run.now);
    // Safe Harbor: a birth date keeps only its year, and nothing at all above age 89.
    const replacement = age !== undefined && age > 89 ? AGE_CAP_LABEL : iso.slice(0, 4);
    return `${groups.lab}${run.shield.hold(replacement)}`;
  });
  out = out.replace(AGE_RE, (...args: unknown[]) => {
    const groups = args[args.length - 1] as { suf: string };
    return run.shield.hold(`${AGE_CAP_LABEL}${groups.suf}`);
  });
  return out.replace(DATE_RE, (m) => {
    const iso = parseAnyDate(m);
    return iso ? run.shield.hold(shiftedDateText(iso, run)) : m;
  });
}

/* ------------------------------------ entry ------------------------------------ */

export function scrubText(text: string, ctx: ScrubContext): ScrubResult {
  const acc: Acc = { counts: {}, datesShifted: 0, zip3Restricted: 0, zip3Generalized: 0 };
  const shield = new Shield();
  const days =
    ctx.dateShiftDays ?? (ctx.patientKey ? ctx.vault.dateShiftDaysFor(ctx.patientKey) : undefined);
  const run: Run = { ctx, acc, shield, now: ctx.now ?? new Date(), days };
  let t = text.replace(/[]/g, '');
  for (const re of FRACTION_RES) t = t.replace(re, (m) => shield.hold(m));
  t = applyIdRules(t, run);
  t = applyAddressAndZip(t, run);
  t = applyDobAndDates(t, run);
  t = scrubNames(t, run);
  return { text: shield.restore(t), ...acc };
}
