/**
 * Resource-id pseudonymization (Safe Harbor "any other unique identifying number").
 *
 * A `Resource.id` that embeds an identifier (a run of 5+ digits, an SSN/MRN shape, a
 * registered name part or identifier value) is replaced by `<type>-<hmac10>`, keyed by the
 * vault, and every reference to it is rewritten. The mapping lives only in the vault.
 * Plain ids like `pat-1`, `obs-301` stay untouched.
 */
import type { Resource } from '../types/fhir.js';
import { collectNameVariants } from './name-collect.js';
import { STOP_WORDS } from './scrub-name-patterns.js';
import type { SafeHarborVault } from './vault.js';

const DIGIT_RUN = /\d{5,}/;
const SSN_SHAPE = /\d{3}-\d{2}-\d{4}/;
const LABEL_SHAPE = /(?:^|[^a-z])(?:mrn|ssn)(?:[^a-z]|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_TAIL = /^(.*?)([A-Z][A-Za-z]+)\/([^/?#]+)((?:\/_history\/[^/]+)?)$/;
const PERSON_TYPES: ReadonlySet<string> = new Set(['Patient', 'Practitioner', 'RelatedPerson', 'Person']);
const MIN_NAME_PART = 3;
const MIN_IDENTIFIER_ALNUM = 5;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface KeyMapper {
  /** `Type/id` -> pseudonymized `Type/id` (unchanged when the id is not identifying). */
  mapKey(key: string): string;
  /** Rewrite a reference string (relative, absolute URL, `_history`); `#id`/`urn:` untouched. */
  mapReference(reference: string): string;
  /** Rewrite ids and every `reference` inside one resource. */
  mapResource<T extends Resource>(resource: T): T;
  /** Re-key a `Type/id`-keyed map. */
  remapKeyed<V>(m: ReadonlyMap<string, V>): Map<string, V>;
  /** `Type/originalId` -> shortened id map: the (long, original) keys are always pseudonymized. */
  mapIdMap(idMap: ReadonlyMap<string, string>): Map<string, string>;
}

function collectSensitive(resources: readonly Resource[]): { names: string[]; identifiers: string[] } {
  const names = new Set<string>();
  const identifiers = new Set<string>();
  for (const r of resources) {
    if (PERSON_TYPES.has(r.resourceType)) {
      for (const v of collectNameVariants(r.name as never)) {
        for (const part of v.split(/[\s,]+/)) {
          const p = part.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
          if (p.length >= MIN_NAME_PART && !STOP_WORDS.has(p)) names.add(p);
        }
      }
    }
    const ids = Array.isArray(r.identifier) ? r.identifier : [];
    for (const i of ids) {
      const value = isObj(i) && typeof i.value === 'string' ? alnum(i.value) : '';
      if (value.length >= MIN_IDENTIFIER_ALNUM && (value.match(/\d/g)?.length ?? 0) >= 3) identifiers.add(value);
    }
  }
  return { names: [...names], identifiers: [...identifiers] };
}

export function createKeyMapper(resources: readonly Resource[], vault: SafeHarborVault): KeyMapper {
  const sensitive = collectSensitive(resources);
  const idCache = new Map<string, string>();

  const isIdentifying = (id: string): boolean => {
    if (!UUID.test(id) && (DIGIT_RUN.test(id) || SSN_SHAPE.test(id))) return true;
    if (LABEL_SHAPE.test(id)) return true;
    const lower = id.toLowerCase();
    if (sensitive.names.some((n) => lower.includes(n))) return true;
    const flat = alnum(id);
    return sensitive.identifiers.some((v) => flat.includes(v));
  };
  const mapId = (type: string, id: string): string => {
    const cacheKey = `${type}/${id}`;
    const hit = idCache.get(cacheKey);
    if (hit !== undefined) return hit;
    const out = isIdentifying(id) ? vault.pseudonymizeResourceId(type, id) : id;
    idCache.set(cacheKey, out);
    return out;
  };
  const mapKey = (key: string): string => {
    const slash = key.indexOf('/');
    if (slash <= 0) return key;
    return `${key.slice(0, slash)}/${mapId(key.slice(0, slash), key.slice(slash + 1))}`;
  };
  const mapReference = (reference: string): string => {
    if (reference.startsWith('#') || reference.startsWith('urn:')) return reference;
    const m = REFERENCE_TAIL.exec(reference);
    if (!m) return reference;
    const [, prefix = '', type = '', id = '', history = ''] = m;
    return `${prefix}${type}/${mapId(type, id)}${history}`;
  };

  const rewrite = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === 'string') return key === 'reference' ? mapReference(value) : value;
    if (Array.isArray(value)) return value.map((v) => rewrite(v, key));
    if (!isObj(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]));
  };
  const mapResource = <T extends Resource>(resource: T): T => {
    const rewritten = rewrite(resource, undefined) as Obj;
    if (typeof resource.id === 'string') rewritten.id = mapId(resource.resourceType, resource.id);
    return rewritten as T;
  };

  const remapKeyed = <V>(m: ReadonlyMap<string, V>): Map<string, V> =>
    new Map([...m].map(([k, v]) => [mapKey(k), v]));
  const mapIdMap = (idMap: ReadonlyMap<string, string>): Map<string, string> =>
    new Map(
      [...idMap].map(([original, shortened]) => {
        const slash = original.indexOf('/');
        const type = slash > 0 ? original.slice(0, slash) : 'Resource';
        const id = slash > 0 ? original.slice(slash + 1) : original;
        return [`${type}/${vault.pseudonymizeResourceId(type, id)}`, mapId(type, shortened)];
      }),
    );

  return { mapKey, mapReference, mapResource, remapKeyed, mapIdMap };
}
