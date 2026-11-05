/**
 * Text processing that receives untrusted input must stay linear: pathological strings that made
 * the previous regular expressions backtrack quadratically finish quickly, and behaviour is
 * unchanged on ordinary input.
 */
import { describe, expect, it } from 'vitest';
import { cell } from '../src/compiler/sections/util.js';
import { canonicalize } from '../src/deid/vault-names.js';
import { buildResourceIndex, normalizeMedicationConcept, stripMarkup } from '../src/normalizer/index.js';
import { parseReferenceTail } from '../src/shared/reference-tail.js';
import { splitSentences } from '../src/verifier/sentence-splitter.js';

const BUDGET_MS = 200;

function fast(fn: () => unknown): void {
  const start = performance.now();
  fn();
  expect(performance.now() - start).toBeLessThan(BUDGET_MS);
}

describe('pathological inputs finish in linear time', () => {
  it('stripMarkup', () => {
    for (const input of [
      '<'.repeat(100_000),
      '<a'.repeat(50_000),
      '<!--'.repeat(30_000),
      '<![CDATA['.repeat(20_000),
      '<script>'.repeat(20_000),
      '<?'.repeat(50_000),
    ]) {
      fast(() => stripMarkup(input));
    }
  });

  it('splitSentences', () => {
    for (const input of ['.'.repeat(100_000), `a.${' '.repeat(100_000)}`, '. '.repeat(50_000), '!?'.repeat(50_000)]) {
      fast(() => splitSentences(input));
    }
  });

  it('medication strength parsing', () => {
    for (const text of ['1'.repeat(100_000), `${'1'.repeat(1000)}${' '.repeat(50_000)}`, '1.1.1.'.repeat(20_000)]) {
      fast(() => normalizeMedicationConcept({ text }));
    }
  });

  it('reference resolution', () => {
    const index = buildResourceIndex([{ resource: { resourceType: 'Patient', id: 'p1' } }]);
    for (const ref of ['a'.repeat(100_000), `${'a'.repeat(50_000)}/`, `${'a/'.repeat(30_000)}x`]) {
      fast(() => index.resolve(ref));
      fast(() => parseReferenceTail(ref));
    }
  });

  it('URL canonicalization', () => {
    fast(() => canonicalize('URL', `${'/'.repeat(100_000)}x`));
    fast(() => canonicalize('URL', `https://example.org${'/'.repeat(100_000)}`));
  });
});

describe('behaviour is preserved', () => {
  it('stripMarkup keeps the documented semantics', () => {
    expect(stripMarkup('<p>Pt <b>stable</b>.</p><p>Plan</p>')).toBe('Pt stable. Plan');
    expect(stripMarkup('<p>Pt <b>stable</b></p>', false)).toBe('Pt stable');
    expect(stripMarkup('a<![CDATA[ x < y ]]>b')).toBe('a x < y b');
    expect(stripMarkup('a<!-- secret -->b')).toBe('a b');
    expect(stripMarkup('a<script>alert(1)</script >b<style>p{}</style>c')).toBe('a b c');
    expect(stripMarkup('BP < 120 and nothing closes')).toBe('BP < 120 and nothing closes');
    expect(stripMarkup('a < b > c')).toBe('a c');
    expect(stripMarkup('x<script>never closed')).toBe('x');
    expect(stripMarkup('<?xml version="1.0"?><!DOCTYPE x><r>A &amp; B</r>')).toBe('A & B');
    expect(stripMarkup('e<span>m</span>bed')).toBe('embed');
  });

  it('splitSentences keeps abbreviations, decimals and ellipses together', () => {
    expect(splitSentences('HbA1c 7.8 today. Seen by Dr. Kim! Next? Yes')).toEqual([
      'HbA1c 7.8 today.',
      'Seen by Dr. Kim!',
      'Next?',
      'Yes',
    ]);
    // A lowercase continuation never starts a new sentence (unchanged rule).
    expect(splitSentences('Wait... then go. e.g. this')).toEqual(['Wait... then go. e.g. this']);
    expect(splitSentences('Wait... Then go.')).toEqual(['Wait...', 'Then go.']);
    expect(splitSentences('end with dot.   ')).toEqual(['end with dot.']);
  });

  it('parseReferenceTail splits Type/id with prefixes and history', () => {
    expect(parseReferenceTail('Patient/1')).toEqual({ prefix: '', type: 'Patient', id: '1', history: '' });
    expect(parseReferenceTail('https://x.org/fhir/Observation/o-1/_history/3')).toEqual({
      prefix: 'https://x.org/fhir/',
      type: 'Observation',
      id: 'o-1',
      history: '/_history/3',
    });
    for (const bad of ['', 'Patient', 'Patient/', '1/2', 'Patient/a?b', 'Patient/a#b', 'x'.repeat(5000)]) {
      expect(parseReferenceTail(bad)).toBeUndefined();
    }
  });

  it('medication strength is still extracted', () => {
    expect(normalizeMedicationConcept({ text: 'Lisinopril 10 MG Oral Tablet' })?.dedupeKey).toMatch(/10 mg/i);
    expect(normalizeMedicationConcept({ text: 'Insulin 100 unit/ml' })?.dedupeKey).toMatch(/100 unit\/ml/i);
  });

  it('URL canonicalization still drops trailing slashes only', () => {
    expect(canonicalize('URL', 'HTTPS://Example.org/a///')).toBe('https://example.org/a');
    expect(canonicalize('URL', 'https://example.org/a/b')).toBe('https://example.org/a/b');
  });

  it('table cells escape backslashes before pipes', () => {
    expect(cell('a|b')).toBe('a\\|b');
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
    expect(cell('trailing\\')).toBe('trailing\\\\');
    expect(cell('  many   spaces ')).toBe('many spaces');
  });
});
