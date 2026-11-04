/**
 * Gathers every structured identifier value of a resource (MRN/SSN/plan ids, telephone numbers,
 * emails, device ids, postal codes...) so free-text sweeps and resource-id checks can recognise
 * them. Input is untrusted JSON: values of any scalar type are collected, arrays included.
 */
import type { Resource } from '../types/fhir.js';
import type { PhiCategory } from '../types/pipeline.js';
import { stringLeaves } from './name-collect.js';
import { KEY_CATEGORY, contactCategory, identifierCategory, isObj, type Obj } from './structured-handlers.js';

export interface IdentifierTerm {
  category: PhiCategory;
  value: string;
}

const MAX_DEPTH = 64;
/** Scalar members that hold a single identifier whatever the datatype around them. */
const ID_VALUE_KEYS = ['subscriberId', 'serialNumber', 'deviceIdentifier', 'carrierHRF', 'carrierAIDC', 'lotNumber'];

const isIdentifierMember = (key: string | undefined): boolean =>
  key === 'identifier' || (key !== undefined && key.endsWith('Identifier'));

function termsOfObject(o: Obj, key: string | undefined, rt: string | undefined): IdentifierTerm[] {
  const out: IdentifierTerm[] = [];
  const add = (category: PhiCategory, v: unknown): void => {
    for (const value of stringLeaves(v)) out.push({ category, value: value.trim() });
  };
  if (isIdentifierMember(key)) add(identifierCategory(o, rt), o.value);
  if (key === 'telecom' || key === 'valueContactPoint') {
    const system = typeof o.system === 'string' ? o.system : '';
    for (const value of stringLeaves(o.value)) out.push({ category: contactCategory(system, value), value: value.trim() });
  }
  if (key === 'address' || key === 'valueAddress') add('ADDRESS', o.postalCode);
  if (key === 'class' && rt === 'Coverage') add('HEALTH_PLAN', o.value);
  for (const k of ID_VALUE_KEYS) {
    const category = KEY_CATEGORY[k];
    if (category) add(category, o[k]);
  }
  return out;
}

export function collectIdentifierTerms(resource: Resource): IdentifierTerm[] {
  const out: IdentifierTerm[] = [];
  const visit = (value: unknown, key: string | undefined, rt: string | undefined, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) return value.forEach((v) => visit(v, key, rt, depth + 1));
    if (!isObj(value)) return;
    const here = typeof value.resourceType === 'string' ? value.resourceType : rt;
    out.push(...termsOfObject(value, key, here));
    for (const [k, v] of Object.entries(value)) visit(v, k, here, depth + 1);
  };
  visit(resource, undefined, undefined, 0);
  return out;
}
