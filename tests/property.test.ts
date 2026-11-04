/**
 * Property and fuzz tests with a seeded PRNG (deterministic, no extra dependency):
 * date-shift invertibility and interval preservation, and loader robustness on garbage input.
 */
import { describe, expect, it } from 'vitest';
import { FhirBridgeError } from '../src/errors.js';
import { parseInput } from '../src/normalizer/index.js';
import { daysBetween, parseFhirDate, shiftFhirDate } from '../src/shared/fhir-date.js';

/** mulberry32: small, fast, seedable. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function randomFhirDate(rand: () => number): string {
  const year = 1900 + Math.floor(rand() * 200);
  const precision = rand();
  if (precision < 0.05) return String(year);
  const month = 1 + Math.floor(rand() * 12);
  if (precision < 0.1) return `${year}-${pad(month)}`;
  const day = 1 + Math.floor(rand() * 28);
  const date = `${year}-${pad(month)}-${pad(day)}`;
  if (precision < 0.4) return date;
  const time = `${pad(Math.floor(rand() * 24))}:${pad(Math.floor(rand() * 60))}:${pad(Math.floor(rand() * 60))}`;
  const frac = rand() < 0.3 ? `.${String(Math.floor(rand() * 1000)).padStart(3, '0')}` : '';
  const zoneRoll = rand();
  const zone =
    zoneRoll < 0.4 ? 'Z' : `${zoneRoll < 0.7 ? '+' : '-'}${pad(Math.floor(rand() * 14))}:${rand() < 0.5 ? '00' : '30'}`;
  return `${date}T${time}${frac}${zone}`;
}

describe('date shift properties', () => {
  const rand = prng(20261105);
  const samples = Array.from({ length: 5000 }, () => ({
    date: randomFhirDate(rand),
    days: -2 - Math.floor(rand() * 364),
  }));

  const isMonthPrecision = (d: string) => /^\d{4}-\d{2}$/.test(d);

  it('shift then unshift is the identity for day precision (any time and zone) and for years', () => {
    for (const { date, days } of samples.filter((s) => !isMonthPrecision(s.date))) {
      expect(shiftFhirDate(shiftFhirDate(date, days), -days)).toBe(date);
    }
  });

  it('leaves year-only values unchanged (Safe Harbor keeps years; no systematic -1 year bias)', () => {
    for (const { date, days } of samples.filter((s) => /^\d{4}$/.test(s.date))) {
      expect(shiftFhirDate(date, days)).toBe(date);
    }
  });

  it('shifts month-precision values from mid-month, and the round trip is within one month', () => {
    const months = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    for (const { date, days } of samples.filter((s) => isMonthPrecision(s.date))) {
      const shifted = shiftFhirDate(date, days);
      expect(shifted).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
      expect(Math.abs(months(shifted) - months(date) - days / 30.44)).toBeLessThanOrEqual(1);
      expect(Math.abs(months(shiftFhirDate(shifted, -days)) - months(date))).toBeLessThanOrEqual(1);
    }
  });

  it('rejects impossible calendar values instead of overflowing them', () => {
    for (const bad of ['2021-13', '2021-00', '2021-02-30', '2023-02-29', '2021-04-31', '2021-01-01T24:00:00Z', '2021-01-01T10:60:00Z', '2021-01-01T10:00:00+15:00']) {
      expect(parseFhirDate(bad)).toBeUndefined();
      expect(shiftFhirDate(bad, -42)).toBe(bad);
    }
    expect(parseFhirDate('2024-02-29')).toBeDefined();
    expect(parseFhirDate('2016-12-31T23:59:60Z')).toBeDefined();
  });

  it('keeps precision, time of day and zone', () => {
    for (const { date, days } of samples) {
      const shifted = shiftFhirDate(date, days);
      expect(shifted.length).toBe(date.length);
      const a = parseFhirDate(date);
      const b = parseFhirDate(shifted);
      expect(b?.timePart).toBe(a?.timePart);
      expect(b?.month === undefined).toBe(a?.month === undefined);
      expect(b?.day === undefined).toBe(a?.day === undefined);
    }
  });

  it('moves day-precision dates by exactly the offset and preserves intervals', () => {
    const dayDates = samples.filter((s) => /^\d{4}-\d{2}-\d{2}/.test(s.date));
    for (let i = 0; i + 1 < dayDates.length; i += 2) {
      const a = dayDates[i];
      const b = dayDates[i + 1];
      if (!a || !b) continue;
      const shift = a.days;
      expect(daysBetween(a.date, shiftFhirDate(a.date, shift))).toBe(shift);
      expect(daysBetween(shiftFhirDate(a.date, shift), shiftFhirDate(b.date, shift))).toBe(
        daysBetween(a.date, b.date),
      );
    }
  });

  it('leaves non-dates untouched', () => {
    for (const s of ['', 'not a date', '2021-13', '21-01-01', '2021-1-1', 'T10:00', '20210317']) {
      expect(shiftFhirDate(s, -42)).toBe(s);
    }
  });
});

describe('loader fuzzing', () => {
  const rand = prng(7);
  const ALPHABET = '{}[]":,\\ \n\r\tabcxyz0123456789-_.eE+tnulrfs\u0000﻿ é漢';

  function garbage(): string {
    const len = Math.floor(rand() * 200);
    let out = '';
    for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    return out;
  }

  function mutate(text: string): string {
    const chars = [...text];
    const edits = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < edits; i++) {
      const at = Math.floor(rand() * chars.length);
      if (rand() < 0.5) chars.splice(at, 1);
      else chars.splice(at, 0, ALPHABET[Math.floor(rand() * ALPHABET.length)] ?? '');
    }
    return chars.join('');
  }

  const valid = JSON.stringify({
    resourceType: 'Bundle',
    entry: [
      { resource: { resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe' }] } },
      { resource: { resourceType: 'Observation', id: 'o1', status: 'final', subject: { reference: 'Patient/p1' } } },
    ],
  });

  it('either parses or throws FhirBridgeError — never another error type — on 3000 random inputs', () => {
    const inputs = [
      ...Array.from({ length: 1500 }, garbage),
      ...Array.from({ length: 1500 }, () => mutate(valid)),
    ];
    for (const input of inputs) {
      try {
        const parsed = parseInput(input);
        for (const e of parsed.entries) expect(typeof e.resource.resourceType).toBe('string');
      } catch (error) {
        expect(error).toBeInstanceOf(FhirBridgeError);
        expect((error as FhirBridgeError).code).toBe('INPUT_INVALID');
      }
    }
  });
});
