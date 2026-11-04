/** Helpers that gather person-name spellings from FHIR resources. */
import type { HumanName, Resource } from '../types/fhir.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** All spellings of the person names in a HumanName[] (for consolidation + text sweeps). */
export function collectNameVariants(names: HumanName[] | undefined): string[] {
  const out: string[] = [];
  for (const n of names ?? []) {
    const given = (n.given ?? []).filter((g): g is string => typeof g === 'string').join(' ').trim();
    const family = typeof n.family === 'string' ? n.family.trim() : '';
    const full = `${given} ${family}`.trim();
    for (const v of [n.text, full, family && given ? `${family}, ${given}` : '', family, ...(n.given ?? [])]) {
      if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
    }
  }
  return out;
}

/** City / district / street values of every Address nested in a resource (for free-text sweeps). */
export function collectAddressTerms(resource: Resource): string[] {
  const out = new Set<string>();
  const visit = (value: unknown, key: string | undefined): void => {
    if (Array.isArray(value)) return value.forEach((v) => visit(v, key));
    if (!isObj(value)) return;
    if (key === 'address' || key === 'valueAddress') {
      for (const k of ['city', 'district', 'line'] as const) {
        const v = value[k];
        for (const s of Array.isArray(v) ? v : [v]) if (typeof s === 'string' && s.trim()) out.add(s.trim());
      }
    }
    for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(resource, undefined);
  return [...out];
}

/** True when an object has the shape of a HumanName (not e.g. Device.deviceName). */
export function isHumanName(o: unknown): o is HumanName {
  if (!isObj(o)) return false;
  if ('family' in o || 'given' in o || 'prefix' in o || 'suffix' in o) return true;
  return typeof o.text === 'string' && !('system' in o) && !('value' in o) && !('name' in o);
}

/**
 * Names nested below the top level of a resource (Patient.contact.name, Organization.contact.name,
 * extension valueHumanName...). Each entry holds the variants of one person.
 */
export function collectNestedNames(resource: Resource): string[][] {
  const groups: string[][] = [];
  const visit = (value: unknown, key: string | undefined, depth: number): void => {
    if (Array.isArray(value)) {
      const humans = value.filter(isHumanName);
      if (depth > 1 && (key === 'name' || key === 'valueHumanName') && humans.length > 0) {
        const variants = collectNameVariants(humans);
        if (variants.length > 0) groups.push(variants);
        return;
      }
      for (const v of value) visit(v, key, depth);
      return;
    }
    if (!isObj(value)) return;
    if (/mother.?s?.?maiden/i.test(String(value.url ?? '')) && typeof value.valueString === 'string') {
      if (value.valueString.trim()) groups.push([value.valueString.trim()]);
    }
    if ((key === 'name' || key === 'valueHumanName') && depth > 1 && isHumanName(value)) {
      const variants = collectNameVariants([value]);
      if (variants.length > 0) groups.push(variants);
      return;
    }
    for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1);
  };
  visit(resource, undefined, 0);
  return groups;
}
