import type { Resource } from '../../types/fhir.js';
import { medInfo } from './medications.js';
import { safeWarnings, type SafeWarning } from './safe-warnings.js';
import {
  anchor,
  codings,
  conceptText,
  dayOf,
  firstConceptText,
  inScope,
  keyOf,
  noteText,
  ofType,
  oneLine,
  referenceDisplay,
  resourceDate,
  str,
  type Rec,
  type SectionCtx,
} from './util.js';

const NOTE_MAX_CHARS = 600;
const DEFAULT_EXCLUDED_STATUS = 'entered-in-error';

interface NoteEntry {
  date: string;
  key: string;
  line: string;
}

function datePrefix(resource: Resource): { raw: string; label: string } {
  const day = dayOf(resourceDate(resource)) ?? '';
  return { raw: day, label: day ? `[${day}] ` : '' };
}

function documentEntries(ctx: SectionCtx): NoteEntry[] {
  const entries: NoteEntry[] = [];
  for (const doc of ctx.graph.documents) {
    const resource = ctx.graph.index.get(doc.resourceKey);
    if (!resource || ctx.graph.status.get(doc.resourceKey) === 'excluded' || !inScope(ctx, doc.resourceKey)) continue;
    const r = resource as Rec;
    const kind =
      conceptText(r.type) ?? firstConceptText(r.category) ?? conceptText(r.code) ?? str(r.description) ?? 'Document';
    const author = referenceDisplay(ctx, r.author ?? r.performer);
    const { raw, label } = datePrefix(resource);
    const body = oneLine(doc.text, NOTE_MAX_CHARS);
    if (body === '') continue;
    entries.push({
      date: raw,
      key: doc.resourceKey,
      line: `- ${label}${kind}${author ? ` by ${author}` : ''}: ${body} ${anchor(resource)}`,
    });
  }
  return entries;
}

function resourceNoteEntries(ctx: SectionCtx): NoteEntry[] {
  const entries: NoteEntry[] = [];
  const documented = new Set(ctx.graph.documents.map((d) => d.resourceKey));
  for (const type of ['Condition', 'Procedure', 'DiagnosticReport']) {
    for (const resource of ofType(ctx, type)) {
      const r = resource as Rec;
      const body = type === 'DiagnosticReport' ? (documented.has(keyOf(resource)) ? undefined : str(r.conclusion)) : noteText(resource);
      if (!body) continue;
      const name = conceptText(r.code);
      const { raw, label } = datePrefix(resource);
      const heading = type === 'DiagnosticReport' ? 'Diagnostic report conclusion' : `${type} note`;
      entries.push({
        date: raw,
        key: keyOf(resource),
        line: `- ${label}${heading}${name ? ` (${name})` : ''}: ${oneLine(body, NOTE_MAX_CHARS)} ${anchor(resource)}`,
      });
    }
  }
  return entries;
}

export function renderNotes(ctx: SectionCtx): string[] {
  const entries = [...documentEntries(ctx), ...resourceNoteEntries(ctx)].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  if (entries.length === 0) return [];
  return ['## 7. Clinical Notes & Decoded DocumentReferences', '', ...entries.map((e) => e.line)];
}

function excludedStatus(resource: Resource | undefined): string {
  if (!resource) return DEFAULT_EXCLUDED_STATUS;
  const r = resource as Rec;
  return str(r.status) ?? codings(r.verificationStatus)[0]?.code ?? DEFAULT_EXCLUDED_STATUS;
}

function excludedName(ctx: SectionCtx, resource: Resource | undefined, key: string): string {
  if (!resource) return key.split('/')[0] ?? key;
  if (ctx.graph.medications.has(key)) return medInfo(ctx, resource).display;
  const r = resource as Rec;
  return conceptText(r.code) ?? conceptText(r.medicationCodeableConcept) ?? resource.resourceType;
}

function excludedLines(ctx: SectionCtx): string[] {
  const keys = new Set<string>(ctx.graph.excluded);
  for (const w of ctx.graph.warnings) if (w.code === 'EXCLUDED_ENTERED_IN_ERROR') keys.add(w.resourceKey);
  const groups = new Map<string, string[]>();
  for (const key of [...keys].sort()) {
    if (!inScope(ctx, key)) continue;
    const resource = ctx.graph.index.get(key);
    const status = excludedStatus(resource);
    const items = groups.get(status) ?? [];
    items.push(`[${key}]: ${excludedName(ctx, resource, key)}`);
    groups.set(status, items);
  }
  return [...groups.entries()].map(
    ([status, items]) => `- EXCLUDED: ${items.length} resource(s) with status='${status}' (${items.join('; ')})`,
  );
}

function codeWarningLine(w: SafeWarning): string {
  const { display, rxcui, expected } = w.details ?? {};
  if (display && rxcui) {
    return `- CODE WARNING: [${w.resourceKey}] display "${display}" conflicts with RxCUI ${rxcui}${expected ? ` ("${expected}")` : ''}.`;
  }
  return `- CODE WARNING: [${w.resourceKey}] ${oneLine(w.message, 240)}`;
}

/** Section 8 is built from the graph's (sanitized) warnings only; compile the de-identified graph. */
export function renderWarnings(ctx: SectionCtx): string[] {
  const mismatches = safeWarnings(ctx.graph)
    .filter((w) => w.code === 'CODE_DISPLAY_MISMATCH' && inScope(ctx, w.resourceKey))
    .map(codeWarningLine);
  const lines = [...excludedLines(ctx), ...new Set(mismatches)];
  if (lines.length === 0) return [];
  return ['## 8. Clinical Data Integrity Warnings (Auto-Detected by FHIRBridge)', '', ...lines];
}
