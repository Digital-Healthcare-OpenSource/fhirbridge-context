import type { CompileOptions } from '../types/pipeline.js';
import type { NormalizedGraph } from '../types/pipeline.js';
import {
  renderAllergies,
  renderConditions,
  renderDemographics,
  renderEncounters,
  renderProcedures,
} from './sections/clinical-lists.js';
import { renderLabs } from './sections/labs.js';
import { renderActiveMedications, renderDiscontinuedMedications } from './sections/medications.js';
import { renderNotes, renderWarnings } from './sections/notes-warnings.js';
import { keyOf, type SectionCtx } from './sections/util.js';

export const DEFAULT_COMPILER_VERSION = '0.1.0';

/** `Patient/id` the output is about: the requested one, else the first patient in the graph. */
export function selectedPatientKey(graph: NormalizedGraph, requested?: string): string | undefined {
  if (requested) return requested;
  return graph.resources
    .filter((r) => r.resourceType === 'Patient')
    .map(keyOf)
    .sort()[0];
}

function headerLine(graph: NormalizedGraph, opts: CompileOptions, version: string): string {
  const parts = [`FHIRBridge v${version}`, `SafeHarbor: ${opts.safeHarbor ? 'ENABLED' : 'DISABLED'}`];
  if (opts.safeHarbor) {
    const key = selectedPatientKey(graph, opts.patientKey);
    const shift = key ? opts.safeHarbor.dateShiftDays[key] : undefined;
    if (shift !== undefined) parts.push(`DateShift: ${shift}d`);
  }
  return `# CLINICAL SUMMARY CONTEXT (${parts.join(' | ')})`;
}

/**
 * Compile a normalized (optionally de-identified) graph into the `clinical-md` context.
 * Excluded resources never appear as clinical facts; they surface only in the integrity
 * warnings. Every fact line ends with its `[ResourceType/id]` anchor.
 */
export function compileClinicalMarkdown(
  graph: NormalizedGraph,
  opts: CompileOptions & { version?: string },
): string {
  const ctx: SectionCtx = { graph, patientKey: opts.patientKey, now: opts.now ?? new Date() };
  const sections = [
    renderDemographics(ctx),
    renderAllergies(ctx),
    renderConditions(ctx),
    renderActiveMedications(ctx),
    renderDiscontinuedMedications(ctx),
    renderLabs(ctx),
    renderEncounters(ctx),
    renderProcedures(ctx),
    renderNotes(ctx),
    renderWarnings(ctx),
  ].filter((lines) => lines.length > 0);
  const header = headerLine(graph, opts, opts.version ?? DEFAULT_COMPILER_VERSION);
  return `${[header, ...sections.map((lines) => lines.join('\n'))].join('\n\n')}\n`;
}
