/**
 * Resource-id pseudonymization (Safe Harbor "any other unique identifying number").
 *
 * A `Resource.id` that embeds an identifier (a run of 5+ digits, an SSN/MRN shape, a
 * registered name part or identifier value) is replaced by `<type>-<hmac10>`, keyed by the
 * vault, and every reference to it is rewritten. The mapping lives only in the vault.
 * Plain ids like `pat-1`, `obs-301` stay untouched.
 */
import type { Resource } from '../types/fhir.js';
import { parseReferenceTail, type ReferenceTail } from '../shared/reference-tail.js';
import { collectIdentifierTerms } from './identifier-collect.js';
import { collectNameVariants, collectNestedNames } from './name-collect.js';
import { STOP_WORDS } from './scrub-name-patterns.js';
import type { SafeHarborVault } from './vault.js';

/** 4+ consecutive digits can be a date (YYYYMMDD), a phone, an MRN: such ids are pseudonymized. */
const DIGIT_RUN = /\d{4,}/;
const SSN_SHAPE = /\d{3}-\d{2}-\d{4}/;
const SHORT_DATE_SHAPE = /\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/;
const PHONE_SHAPE = /\d{3}[-.\s]\d{3}[-.\s]\d{4}/;
const LABEL_SHAPE = /(?:^|[^a-z])(?:mrn|ssn)(?:[^a-z]|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_TYPE = /^[A-Z][A-Za-z]+$/;

/** `…/Type/id[/_history/n]` where Type looks like a FHIR resource type (linear-time split). */
function referenceTail(reference: string): ReferenceTail | undefined {
  const tail = parseReferenceTail(reference);
  return tail && RESOURCE_TYPE.test(tail.type) ? tail : undefined;
}
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

function addNameParts(names: Set<string>, variants: readonly string[]): void {
  for (const v of variants) {
    for (const part of v.split(/[\s,]+/)) {
      const p = part.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
      if (p.length >= MIN_NAME_PART && !STOP_WORDS.has(p)) names.add(p);
      for (const piece of p.split('-')) {
        if (piece.length >= MIN_NAME_PART && !STOP_WORDS.has(piece)) names.add(piece);
      }
    }
  }
}

/** Display text of references that point at a person ("Practitioner/jsmith-md" + "J Smith"). */
function personDisplays(resource: Resource): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) return;
    if (Array.isArray(value)) return value.forEach((v) => visit(v, depth + 1));
    if (!isObj(value)) return;
    const type = typeof value.reference === 'string' ? referenceTail(value.reference)?.type : value.type;
    if (typeof value.display === 'string' && typeof type === 'string' && PERSON_TYPES.has(type)) out.push(value.display);
    for (const v of Object.values(value)) visit(v, depth + 1);
  };
  visit(resource, 0);
  return out;
}

function collectSensitive(resources: readonly Resource[]): { names: string[]; identifiers: string[] } {
  const names = new Set<string>();
  const identifiers = new Set<string>();
  for (const r of resources) {
    if (PERSON_TYPES.has(r.resourceType)) addNameParts(names, collectNameVariants(r.name));
    for (const group of collectNestedNames(r)) addNameParts(names, group);
    addNameParts(names, personDisplays(r));
    for (const term of collectIdentifierTerms(r)) {
      const value = alnum(term.value);
      if (value.length >= MIN_IDENTIFIER_ALNUM && (value.match(/\d/g)?.length ?? 0) >= 3) identifiers.add(value);
    }
  }
  return { names: [...names], identifiers: [...identifiers] };
}

export function createKeyMapper(resources: readonly Resource[], vault: SafeHarborVault): KeyMapper {
  const sensitive = collectSensitive(resources);
  const idCache = new Map<string, string>();

  const isIdentifying = (id: string): boolean => {
    if (!UUID.test(id) && (DIGIT_RUN.test(id) || SSN_SHAPE.test(id) || SHORT_DATE_SHAPE.test(id) || PHONE_SHAPE.test(id))) {
      return true;
    }
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
    const m = referenceTail(reference);
    if (!m) return reference;
    return `${m.prefix}${m.type}/${mapId(m.type, m.id)}${m.history}`;
  };

  /** Contained resources are local to one resource: an identifying local id is renamed with its `#refs`. */
  const containedRenames = (resource: Resource): Map<string, string> => {
    const renames = new Map<string, string>();
    for (const c of Array.isArray(resource.contained) ? resource.contained : []) {
      if (!isObj(c) || typeof c.id !== 'string' || typeof c.resourceType !== 'string') continue;
      const renamed = mapId(c.resourceType, c.id);
      if (renamed !== c.id) renames.set(c.id, renamed);
    }
    return renames;
  };
  const rewrite = (value: unknown, key: string | undefined, renames: ReadonlyMap<string, string>): unknown => {
    if (typeof value === 'string') {
      if (key !== 'reference') return value;
      return value.startsWith('#') ? `#${renames.get(value.slice(1)) ?? value.slice(1)}` : mapReference(value);
    }
    if (Array.isArray(value)) return value.map((v) => rewrite(v, key, renames));
    if (!isObj(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k, renames)]));
  };
  const mapResource = <T extends Resource>(resource: T): T => {
    const renames = containedRenames(resource);
    const rewritten = rewrite(resource, undefined, renames) as Obj;
    if (typeof resource.id === 'string') rewritten.id = mapId(resource.resourceType, resource.id);
    if (renames.size > 0 && Array.isArray(rewritten.contained)) {
      rewritten.contained = rewritten.contained.map((c: unknown) =>
        isObj(c) && typeof c.id === 'string' && renames.has(c.id) ? { ...c, id: renames.get(c.id) } : c,
      );
    }
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
