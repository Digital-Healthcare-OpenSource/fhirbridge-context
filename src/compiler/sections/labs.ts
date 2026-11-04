import type { Resource } from '../../types/fhir.js';
import {
  cell,
  codings,
  conceptText,
  dayOf,
  findCoding,
  inScope,
  keyOf,
  num,
  ofType,
  rec,
  recs,
  resourceDate,
  statusOf,
  str,
  type Rec,
  type SectionCtx,
} from './util.js';

const TREND_POINTS = 6;
const LOINC_RE = /loinc/i;

interface Point {
  value: number;
  unit?: string;
  date: string;
  key: string;
  flag?: string;
  range?: string;
}

interface Series {
  label: string;
  points: Point[];
}

const HIGH_CODES: Record<string, string> = { H: 'HIGH', HH: 'CRITICAL HIGH', '>': 'HIGH', HU: 'HIGH' };
const LOW_CODES: Record<string, string> = { L: 'LOW', LL: 'CRITICAL LOW', '<': 'LOW', LU: 'LOW' };

function rangeBounds(range: Rec | undefined): { low?: number; high?: number } {
  return { low: num(rec(range?.low)?.value), high: num(rec(range?.high)?.value) };
}

function rangeText(range: Rec | undefined, unit: string | undefined): string | undefined {
  if (!range) return undefined;
  const { low, high } = rangeBounds(range);
  const u = unit ? ` ${unit}` : '';
  if (low !== undefined && high !== undefined) return `${low} - ${high}${u}`;
  if (low !== undefined) return `>= ${low}${u}`;
  if (high !== undefined) return `<= ${high}${u}`;
  return str(range.text);
}

function flagFor(value: number, interpretation: unknown, range: Rec | undefined): string | undefined {
  const interp = recs(interpretation).flatMap((i) => codings(i).map((c) => c.code?.toUpperCase()));
  for (const code of interp) {
    if (code && HIGH_CODES[code]) return HIGH_CODES[code];
    if (code && LOW_CODES[code]) return LOW_CODES[code];
  }
  if (interp.some((c) => c === 'N')) return undefined;
  const { low, high } = rangeBounds(range);
  if (high !== undefined && value > high) return 'HIGH';
  if (low !== undefined && value < low) return 'LOW';
  return undefined;
}

/** Observations in scope plus panel children reachable through graph.members. */
function labObservations(ctx: SectionCtx): Resource[] {
  const seen = new Map<string, Resource>();
  for (const obs of ofType(ctx, 'Observation', ['active', 'unknown'])) seen.set(keyOf(obs), obs);
  for (const [parent, children] of ctx.graph.members) {
    if (!inScope(ctx, parent) || ctx.graph.status.get(parent) === 'excluded') continue;
    for (const childKey of children) {
      const child = ctx.graph.index.get(childKey);
      if (!child || child.resourceType !== 'Observation' || seen.has(childKey)) continue;
      const cls = statusOf(ctx, child);
      if (cls === 'active' || cls === 'unknown') seen.set(childKey, child);
    }
  }
  return [...seen.values()];
}

interface Measurement {
  code: unknown;
  quantity: Rec;
  range: Rec | undefined;
  interpretation: unknown;
}

function measurements(obs: Resource): Measurement[] {
  const o = obs as Rec;
  const out: Measurement[] = [];
  const main = rec(o.valueQuantity);
  if (main) {
    out.push({ code: o.code, quantity: main, range: recs(o.referenceRange)[0], interpretation: o.interpretation });
  }
  for (const comp of recs(o.component)) {
    const q = rec(comp.valueQuantity);
    if (q) out.push({ code: comp.code, quantity: q, range: recs(comp.referenceRange)[0], interpretation: comp.interpretation });
  }
  return out;
}

function seriesId(code: unknown): { id: string; label: string } | undefined {
  const name = conceptText(code);
  const loinc = findCoding(code, LOINC_RE)?.code;
  if (loinc) return { id: `loinc:${loinc}`, label: `${name ?? loinc} (${loinc})` };
  return name ? { id: `text:${name.toLowerCase()}`, label: name } : undefined;
}

function buildSeries(ctx: SectionCtx): Series[] {
  const byId = new Map<string, Series>();
  for (const obs of labObservations(ctx)) {
    for (const m of measurements(obs)) {
      const value = num(m.quantity.value);
      const id = seriesId(m.code);
      if (value === undefined || !id) continue;
      const unit = str(m.quantity.unit) ?? str(m.quantity.code);
      const point: Point = {
        value,
        unit,
        date: dayOf(resourceDate(obs)) ?? '',
        key: keyOf(obs),
        flag: flagFor(value, m.interpretation ?? (obs as Rec).interpretation, m.range),
        range: rangeText(m.range, unit),
      };
      const series = byId.get(id.id) ?? { label: id.label, points: [] };
      series.points.push(point);
      byId.set(id.id, series);
    }
  }
  return [...byId.values()]
    .map((s) => ({
      label: s.label,
      points: [...s.points].sort((a, b) =>
        a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      ),
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

function trendValue(p: Point): string {
  const unit = p.unit === undefined ? '' : p.unit === '%' ? '%' : ` ${p.unit}`;
  return `${p.value}${unit} (${p.date || 'undated'})`;
}

function seriesRow(series: Series): string {
  const latest = series.points[series.points.length - 1] as Point;
  const value = `${latest.value}${latest.unit ? ` ${latest.unit}` : ''}${latest.flag ? ` (${latest.flag})` : ''}`;
  const trend = series.points.slice(-TREND_POINTS).map(trendValue).join(' -> ');
  const source = `[${latest.key}]`;
  return `| ${[series.label, value, latest.date, latest.range ?? '', trend, source].map(cell).join(' | ')} |`;
}

export function renderLabs(ctx: SectionCtx): string[] {
  const series = buildSeries(ctx).filter((s) => s.points.length > 0);
  if (series.length === 0) return [];
  return [
    '## 6. Longitudinal Labs & Vitals (Grouped by LOINC)',
    '',
    '| Metric (LOINC) | Latest Value | Date | Reference Range | Historical Trend (Chronological) | Source Anchor |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ...series.map(seriesRow),
  ];
}

