import type { Resource } from '../../types/fhir.js';
import {
  anchor,
  conceptText,
  dayOf,
  firstConceptText,
  keyOf,
  ofType,
  recs,
  referenceDisplay,
  resourceDate,
  statusOf,
  str,
  compareChronological,
  type Rec,
  type SectionCtx,
} from './util.js';

const UNNAMED_MEDICATION = 'Medication (name not recorded)';

export interface MedInfo {
  display: string;
  rxnorm?: string;
  dedupeKey: string;
}

/** Resolved medication identity; never falls back to a placeholder when a name exists. */
export function medInfo(ctx: SectionCtx, resource: Resource): MedInfo {
  const normalized = ctx.graph.medications.get(keyOf(resource));
  if (normalized) {
    return { display: normalized.display, rxnorm: normalized.rxnorm, dedupeKey: normalized.dedupeKey };
  }
  const r = resource as Rec;
  const display =
    conceptText(r.medicationCodeableConcept) ?? referenceDisplay(ctx, r.medicationReference) ?? UNNAMED_MEDICATION;
  return { display, dedupeKey: `name:${display.toLowerCase()}` };
}

function doseText(resource: Resource): string | undefined {
  const r = resource as Rec;
  return str(recs(r.dosageInstruction)[0]?.text) ?? str(recs(r.dosage)[0]?.text);
}

function reasonText(resource: Resource): string | undefined {
  return firstConceptText((resource as Rec).statusReason);
}

function medicationResources(ctx: SectionCtx, include: Parameters<typeof ofType>[2]): Resource[] {
  return [...ofType(ctx, 'MedicationRequest', include), ...ofType(ctx, 'MedicationStatement', include)].sort(
    compareChronological,
  );
}

interface MedGroup {
  info: MedInfo;
  members: Resource[];
}

function groupBy(ctx: SectionCtx, resources: Resource[], extraKey: (r: Resource) => string): MedGroup[] {
  const groups = new Map<string, MedGroup>();
  for (const resource of resources) {
    const info = medInfo(ctx, resource);
    const id = `${info.dedupeKey}|${extraKey(resource)}`;
    const group = groups.get(id) ?? { info, members: [] };
    group.members.push(resource);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => g);
}

function rxnormTag(info: MedInfo): string {
  if (!info.rxnorm || info.display.includes('[RxNorm:')) return '';
  return ` [RxNorm: ${info.rxnorm}]`;
}

/**
 * A `completed` order of a drug that is still active is a past fill of the same therapy:
 * it counts as a consolidated refill instead of appearing as a discontinued medication.
 */
function isCompletedRefill(resource: Resource, activeKeys: ReadonlySet<string>, ctx: SectionCtx): boolean {
  return str((resource as Rec).status) === 'completed' && activeKeys.has(medInfo(ctx, resource).dedupeKey);
}

function activeDedupeKeys(ctx: SectionCtx): Set<string> {
  return new Set(medicationResources(ctx, ['active', 'unknown']).map((r) => medInfo(ctx, r).dedupeKey));
}

function activeLine(ctx: SectionCtx, group: MedGroup, completedRefills: number): string {
  const latest = group.members[group.members.length - 1] as Resource;
  const dose = [...group.members].reverse().map(doseText).find((d) => d !== undefined);
  const date = dayOf(resourceDate(latest));
  const label = latest.resourceType === 'MedicationStatement' ? 'Recorded' : 'Authored';
  const status = str((latest as Rec).status) ?? statusOf(ctx, latest);
  const orders = group.members.length + completedRefills;
  const meta = [
    date ? `${label}: ${date}` : undefined,
    `Status: ${status}`,
    orders > 1 ? `Refills consolidated: ${orders}` : undefined,
  ].filter((m): m is string => m !== undefined);
  return `- ${group.info.display}${rxnormTag(group.info)}${dose ? ` — ${dose}` : ''} (${meta.join(', ')}) ${anchor(latest)}`;
}

function stoppedLine(ctx: SectionCtx, group: MedGroup): string {
  const latest = group.members[group.members.length - 1] as Resource;
  const status = str((latest as Rec).status) ?? statusOf(ctx, latest);
  const date = dayOf(resourceDate(latest));
  const reason = reasonText(latest);
  const detail = [date, reason ? `Reason: ${reason}` : undefined].filter((d): d is string => d !== undefined);
  return `- ${group.info.display}${rxnormTag(group.info)} — Status: ${status}${detail.length > 0 ? ` (${detail.join(', ')})` : ''} ${anchor(latest)}`;
}

export function renderActiveMedications(ctx: SectionCtx): string[] {
  const groups = groupBy(ctx, medicationResources(ctx, ['active', 'unknown']), () => '');
  if (groups.length === 0) return [];
  const activeKeys = activeDedupeKeys(ctx);
  const refills = new Map<string, number>();
  for (const r of medicationResources(ctx, ['historical'])) {
    if (!isCompletedRefill(r, activeKeys, ctx)) continue;
    const key = medInfo(ctx, r).dedupeKey;
    refills.set(key, (refills.get(key) ?? 0) + 1);
  }
  return [
    '## 4. Active Medications (Deduplicated by RxNorm)',
    '',
    ...groups.map((g) => activeLine(ctx, g, refills.get(g.info.dedupeKey) ?? 0)),
  ];
}

export function renderDiscontinuedMedications(ctx: SectionCtx): string[] {
  const activeKeys = activeDedupeKeys(ctx);
  const resources = medicationResources(ctx, ['historical']).filter((r) => !isCompletedRefill(r, activeKeys, ctx));
  const groups = groupBy(ctx, resources, (r) => str((r as Rec).status) ?? '');
  if (groups.length === 0) return [];
  return [
    '## 5. Discontinued / Stopped Medications (DO NOT TREAT AS ACTIVE)',
    '',
    ...groups.map((g) => stoppedLine(ctx, g)),
  ];
}
