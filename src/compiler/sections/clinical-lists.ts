import type { Resource } from '../../types/fhir.js';
import { ageInYears } from '../../shared/fhir-date.js';
import {
  ageAtDeidentification,
  anchor,
  capitalize,
  codings,
  conceptText,
  dayOf,
  findCoding,
  firstConceptText,
  ofType,
  rec,
  recs,
  resourceDate,
  statusOf,
  str,
  systemLabel,
  visibleBirthDate,
  type Rec,
  type SectionCtx,
} from './util.js';

const RECENT_LIMIT = 10;

function patientName(patient: Rec): string | undefined {
  const name = recs(patient.name)[0];
  if (!name) return undefined;
  const given = Array.isArray(name.given) ? name.given.filter((g) => typeof g === 'string') : [];
  return str(name.text) ?? str([...given, name.family].filter((p) => typeof p === 'string').join(' '));
}

/**
 * De-identified patients show the recorded age and the birth year only; identified ones keep
 * `age (DOB: full date)`.
 */
function ageAndBirth(patient: Rec, ctx: SectionCtx): [string, string | undefined][] {
  const recordedAge = ageAtDeidentification(patient);
  const birth = visibleBirthDate(patient, ctx.deidentified || recordedAge !== undefined);
  if (ctx.deidentified || recordedAge !== undefined) {
    return [
      ['Age', recordedAge],
      ['Birth year', birth && /^\d{4}$/.test(birth) ? birth : undefined],
    ];
  }
  const full = str(patient.birthDate);
  const age = full ? ageInYears(full, ctx.now) : undefined;
  return [['Age', age === undefined ? undefined : `${age} (DOB: ${full})`]];
}

function patientMrn(patient: Rec): string | undefined {
  const ids = recs(patient.identifier);
  const mr = ids.find((i) => codings(i.type).some((c) => c.code === 'MR'));
  return str((mr ?? ids[0])?.value);
}

function demographicsLine(patient: Resource, ctx: SectionCtx): string {
  const p = patient as Rec;
  const parts = [
    ['Name', patientName(p)],
    ['Gender', str(p.gender)],
    ...ageAndBirth(p, ctx),
    ['ZIP', str(recs(p.address)[0]?.postalCode)],
    ['MRN', patientMrn(p)],
  ]
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([label, value]) => `${label}: ${value}`);
  return `- ${parts.join(' | ')} ${anchor(patient)}`;
}

export function renderDemographics(ctx: SectionCtx): string[] {
  const patients = ofType(ctx, 'Patient');
  if (patients.length === 0) return [];
  const only = patients.length === 1 ? patients[0] : undefined;
  const heading = `## 1. Patient Demographics${only ? ` ${anchor(only)}` : ''}`;
  return [heading, '', ...patients.map((p) => demographicsLine(p, ctx))];
}

function allergyStatus(ctx: SectionCtx, allergy: Resource): string {
  const clinical = codings((allergy as Rec).clinicalStatus)[0]?.code;
  if (clinical) return capitalize(clinical);
  const cls = statusOf(ctx, allergy);
  return cls === 'historical' ? 'Inactive' : cls === 'active' ? 'Active' : 'Status unknown';
}

function allergyLine(ctx: SectionCtx, allergy: Resource): string {
  const a = allergy as Rec;
  const name = conceptText(a.code) ?? 'Allergen not specified';
  const reactions = recs(a.reaction)
    .flatMap((r) => recs(r.manifestation).map((m) => conceptText(m)))
    .filter((t): t is string => t !== undefined);
  const crit = str(a.criticality);
  const details = [
    crit ? `${capitalize(crit)} criticality` : undefined,
    ...[...new Set(reactions)],
  ].filter((d): d is string => d !== undefined);
  const detailText = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `- ${name}${detailText} — ${allergyStatus(ctx, allergy)} ${anchor(allergy)}`;
}

export function renderAllergies(ctx: SectionCtx): string[] {
  const allergies = ofType(ctx, 'AllergyIntolerance');
  if (allergies.length === 0) return [];
  return ['## 2. Allergies & Intolerances', '', ...allergies.map((a) => allergyLine(ctx, a))];
}

function conditionLine(ctx: SectionCtx, condition: Resource): string {
  const c = condition as Rec;
  const name = conceptText(c.code) ?? 'Condition not specified';
  const preferred =
    findCoding(c.code, /snomed/i) ?? findCoding(c.code, /icd/i) ?? codings(c.code).find((x) => x.code);
  const code = preferred?.code ? ` [${systemLabel(preferred.system)}: ${preferred.code}]` : '';
  const onset = dayOf(resourceDate(condition));
  const statusText =
    codings(c.clinicalStatus)[0]?.code ??
    (statusOf(ctx, condition) === 'unknown' ? 'status unknown' : statusOf(ctx, condition));
  const abatement = dayOf(str(c.abatementDateTime));
  const meta = [
    onset ? `Onset: ${onset}` : undefined,
    capitalize(statusText),
    abatement ? `Resolved: ${abatement}` : undefined,
  ].filter((m): m is string => m !== undefined);
  return `- ${name}${code} (${meta.join(', ')}) ${anchor(condition)}`;
}

export function renderConditions(ctx: SectionCtx): string[] {
  const current = ofType(ctx, 'Condition', ['active', 'unknown']);
  const past = ofType(ctx, 'Condition', ['historical']);
  if (current.length === 0 && past.length === 0) return [];
  const lines = ['## 3. Active Problem List (Conditions)', ''];
  lines.push(...(current.length > 0 ? current.map((c) => conditionLine(ctx, c)) : ['- None recorded.']));
  if (past.length > 0) {
    lines.push('', '### Resolved / Past Conditions (not current)', '');
    lines.push(...past.map((c) => conditionLine(ctx, c)));
  }
  return lines;
}

function lastN(resources: Resource[]): Resource[] {
  return resources.slice(-RECENT_LIMIT);
}

export function renderEncounters(ctx: SectionCtx): string[] {
  const encounters = lastN(ofType(ctx, 'Encounter'));
  if (encounters.length === 0) return [];
  const lines = encounters.map((e) => {
    const r = e as Rec;
    const kind = firstConceptText(r.type) ?? str(rec(r.class)?.display) ?? str(rec(r.class)?.code) ?? 'Encounter';
    const reason = firstConceptText(r.reasonCode);
    const status = str(r.status);
    const date = dayOf(resourceDate(e));
    const meta = [reason ? `Reason: ${reason}` : undefined, status ? `Status: ${status}` : undefined]
      .filter((m): m is string => m !== undefined)
      .join(', ');
    return `- ${date ? `[${date}] ` : ''}${kind}${meta ? ` (${meta})` : ''} ${anchor(e)}`;
  });
  return ['## 6b. Recent Encounters (last 10)', '', ...lines];
}

export function renderProcedures(ctx: SectionCtx): string[] {
  const procedures = lastN(ofType(ctx, 'Procedure'));
  if (procedures.length === 0) return [];
  const lines = procedures.map((p) => {
    const r = p as Rec;
    const name = conceptText(r.code) ?? 'Procedure not specified';
    const status = str(r.status);
    const date = dayOf(resourceDate(p));
    return `- ${date ? `[${date}] ` : ''}${name}${status ? ` (Status: ${status})` : ''} ${anchor(p)}`;
  });
  return ['## 6c. Procedures (last 10)', '', ...lines];
}
