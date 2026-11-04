import type { Resource } from '../types/fhir.js';
import type {
  CitationAuditReport,
  CitationCheck,
  CitationIssue,
  NormalizedGraph,
  StatusClass,
} from '../types/pipeline.js';
import { splitSentences } from './sentence-splitter.js';

const ANCHOR_RE = /\[([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})\]/g;
const REL_TOLERANCE = 0.005;
const EPSILON = 1e-9;

const cue = (alternatives: string[]): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');

/** Wording that asserts the cited thing is happening now. */
const CURRENT_USE_RE = cue([
  'currently',
  'is\\s+taking',
  'are\\s+taking',
  'continues?\\s+on',
  'continues?\\s+to\\s+take',
  'remains?\\s+on',
  'active',
  'on\\s+[^.\\[\\]]{1,60}?\\s+(?:daily|twice\\s+daily|once\\s+daily|nightly|weekly|bid|tid|qid|qd)',
  'đang\\s+dùng',
  'đang\\s+điều\\s+trị',
  'đang\\s+uống',
]);

/** Wording that marks the citation as past / negated, which makes a historical status correct. */
const PAST_OR_NEGATED_RE = cue([
  'stopped',
  'discontinued',
  'past',
  'former',
  'formerly',
  'previously',
  'cancell?ed',
  'held',
  'no\\s+longer',
  'history\\s+of',
  'inactive',
  'resolved',
  'not',
  'never',
  'ngưng',
  'ngừng',
  'đã\\s+dừng',
  'trước\\s+đây',
  'không\\s+còn',
]);

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((r): r is Rec => !!r) : []);

/* ---------------------------- numbers ---------------------------- */

/** Numbers a sentence states, excluding dates, times, anchors, tokens and list ordinals. */
export function extractNumbers(sentence: string): string[] {
  const cleaned = sentence
    .normalize('NFC')
    .replace(ANCHOR_RE, ' ')
    .replace(/\[[A-Z_]+_\d+\]/g, ' ')
    .replace(/\d{4}-\d{2}(?:-\d{2})?(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/^\s*\d{1,3}[.)]\s+/, '')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  return cleaned.match(/(?<![\p{L}\d_.])\d+(?:\.\d+)?/gu) ?? [];
}

function numberMatches(token: string, target: number): boolean {
  const n = Number(token);
  if (Math.abs(n - target) <= Math.abs(target) * REL_TOLERANCE + EPSILON) return true;
  const decimals = token.includes('.') ? token.length - token.indexOf('.') - 1 : 0;
  return Math.abs(Number(target.toFixed(decimals)) - n) < EPSILON;
}

/** Quantity values carried by an Observation (its own value plus component values). */
function observationValues(obs: Resource): number[] {
  const values = [rec(obs.valueQuantity)?.value];
  for (const comp of recs(obs.component)) values.push(rec(comp.valueQuantity)?.value);
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

function seriesKeys(graph: NormalizedGraph, obs: Resource): string[] {
  const patient = graph.patientOf.get(`${obs.resourceType}/${obs.id ?? ''}`) ?? '';
  const code = rec(obs.code);
  const codes = recs(code?.coding).map((c) => c.code).filter((c): c is string => typeof c === 'string');
  const text = typeof code?.text === 'string' ? [`text:${code.text.toLowerCase()}`] : [];
  return [...codes, ...text].map((c) => `${patient}|${c}`);
}

/** Lazily built `patient|code` → values map over non-excluded Observations. */
function buildSeriesIndex(graph: NormalizedGraph): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const obs of graph.index.byType('Observation')) {
    if (graph.status.get(`Observation/${obs.id ?? ''}`) === 'excluded') continue;
    const values = observationValues(obs);
    if (values.length === 0) continue;
    for (const key of seriesKeys(graph, obs)) index.set(key, [...(index.get(key) ?? []), ...values]);
  }
  return index;
}

/* ----------------------------- audit ----------------------------- */

interface AuditState {
  graph: NormalizedGraph;
  issues: CitationIssue[];
  citations: CitationCheck[];
  series?: Map<string, number[]>;
}

function seriesFor(state: AuditState): Map<string, number[]> {
  state.series ??= buildSeriesIndex(state.graph);
  return state.series;
}

function pushIssue(
  state: AuditState,
  code: CitationIssue['code'],
  severity: CitationIssue['severity'],
  citation: string,
  sentence: string,
  message: string,
): void {
  state.issues.push({ code, severity, citation, sentence, message });
}

function checkStatus(state: AuditState, key: string, status: StatusClass, sentence: string): void {
  // Cues are read from the prose only: ids such as `medreq-stopped-2` must not count as wording.
  const prose = sentence.replace(ANCHOR_RE, ' ').normalize('NFC');
  const assertsCurrent = CURRENT_USE_RE.test(prose) && !PAST_OR_NEGATED_RE.test(prose);
  if (status === 'excluded') {
    pushIssue(state, 'EXCLUDED_RESOURCE_CITED', 'critical', key, sentence,
      `${key} was excluded (entered-in-error/refuted) and must not be cited as a clinical fact.`);
  }
  if ((status === 'excluded' || status === 'historical') && assertsCurrent) {
    pushIssue(state, 'CRITICAL_STATUS_CONTRADICTION', 'critical', key, sentence,
      `${key} is ${status} in the source record but the sentence presents it as current.`);
  }
}

function checkNumbers(state: AuditState, key: string, resource: Resource, sentence: string): void {
  const own = observationValues(resource);
  if (resource.resourceType !== 'Observation' || own.length === 0) return;
  const numbers = extractNumbers(sentence);
  if (numbers.length === 0) return;
  const series = seriesKeys(state.graph, resource).flatMap((k) => seriesFor(state).get(k) ?? []);
  const known = [...own, ...series];
  if (numbers.some((n) => known.some((v) => numberMatches(n, v)))) return;
  pushIssue(state, 'NUMERIC_VALUE_MISMATCH', 'warning', key, sentence,
    `Numbers [${numbers.join(', ')}] in the sentence match neither ${key} (${own.join(', ')}) nor its history.`);
}

function auditAnchor(state: AuditState, key: string, sentence: string): void {
  const before = state.issues.length;
  const resource = state.graph.index.get(key);
  const status = resource ? (state.graph.status.get(key) ?? 'unknown') : undefined;
  if (!resource || status === undefined) {
    pushIssue(state, 'HALLUCINATED_RESOURCE_ID', 'critical', key, sentence,
      `${key} does not exist in the source record.`);
  } else {
    checkStatus(state, key, status, sentence);
    checkNumbers(state, key, resource, sentence);
  }
  state.citations.push({
    citation: key,
    sentence,
    exists: resource !== undefined,
    status,
    ok: state.issues.length === before,
  });
}

function citedKeys(sentence: string): string[] {
  return [...new Set([...sentence.matchAll(ANCHOR_RE)].map((m) => `${m[1]}/${m[2]}`))];
}

/** Verify every `[ResourceType/id]` citation in LLM output against the source graph. */
export function auditCitations(text: string, graph: NormalizedGraph): CitationAuditReport {
  const state: AuditState = { graph, issues: [], citations: [] };
  for (const sentence of splitSentences(text)) {
    for (const key of citedKeys(sentence)) auditAnchor(state, key, sentence);
  }
  return {
    ok: !state.issues.some((i) => i.severity === 'critical'),
    citations: state.citations,
    issues: state.issues,
  };
}
