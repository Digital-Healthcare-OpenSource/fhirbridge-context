/**
 * Registry of everything the free-text sweeps must recognise: person names, place terms and
 * structured identifiers, grouped by the patient they belong to.
 *
 *  - `global`      providers, plus anything that belongs to no patient;
 *  - `byPatient`   the record owner's own names, places and identifiers;
 *  - `others`      PATIENT / PERSON names of every patient, swept after the owner's own list so a
 *                  mention of another patient gets THAT patient's token (empty for one patient).
 */
import type { Resource } from '../types/fhir.js';
import { collectIdentifierTerms } from './identifier-collect.js';
import { collectAddressTerms, collectNameVariants, collectNestedNames } from './name-collect.js';
import type { KnownName } from './scrub-types.js';

export interface KnownNameRegistry {
  global: KnownName[];
  byPatient: Map<string, KnownName[]>;
  /** Everything, for resources that belong to no patient. */
  everyone: KnownName[];
  others: KnownName[];
}

const named = (category: 'PATIENT' | 'PROVIDER' | 'PERSON', variants: string[], patientKey?: string): KnownName[] =>
  variants.length > 0 ? [{ category, variants, ...(patientKey ? { patientKey } : {}) }] : [];

/** `ownerOf` maps a resource to the patient key it belongs to (undefined = nobody). */
export function buildKnownNames(
  source: readonly Resource[],
  ownerOf: (r: Resource) => string | undefined,
  keyOf: (r: Resource) => string,
): KnownNameRegistry {
  const global: KnownName[] = [];
  const byPatient = new Map<string, KnownName[]>();
  const addFor = (owner: string | undefined, names: KnownName[]): void => {
    if (!owner) global.push(...names);
    else byPatient.set(owner, [...(byPatient.get(owner) ?? []), ...names]);
  };
  for (const r of source) {
    const owner = ownerOf(r);
    const own = collectNameVariants(r.name);
    if (r.resourceType === 'Patient') addFor(owner, named('PATIENT', own, keyOf(r)));
    else if (r.resourceType === 'Practitioner' || r.resourceType === 'PractitionerRole') {
      global.push(...named('PROVIDER', own));
    } else if (r.resourceType === 'RelatedPerson' || r.resourceType === 'Person') {
      addFor(owner, named('PERSON', own));
    }
    for (const variants of collectNestedNames(r)) addFor(owner, named('PERSON', variants));
    const places = collectAddressTerms(r);
    if (places.length > 0) addFor(owner, [{ category: 'ADDRESS', variants: places }]);
    for (const term of collectIdentifierTerms(r)) {
      addFor(owner, [{ category: 'IDENTIFIER', variants: [term.value], idCategory: term.category }]);
    }
  }
  const people = (list: readonly KnownName[]): KnownName[] =>
    list.filter((k) => k.category === 'PATIENT' || k.category === 'PERSON');
  const others = byPatient.size > 1 ? [...byPatient.values()].flatMap(people) : [];
  return { global, byPatient, everyone: [...[...byPatient.values()].flat(), ...global], others };
}
