/** The logger must be unable to emit PHI, whatever callers pass it. */
import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED, sanitizeValue, silentLogger } from '../src/logger.js';

const FIXED = () => new Date('2026-11-05T00:00:00.000Z');

function capture(level: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'debug', format: 'text' | 'json' = 'json') {
  const lines: string[] = [];
  const logger = createLogger({ level, format, now: FIXED, write: (l) => lines.push(l) });
  return { logger, lines };
}

describe('sanitizeValue', () => {
  it('passes identifiers, numbers and booleans', () => {
    for (const v of ['pack.done', 'MedicationRequest/medreq-104', 'INPUT_TOO_LARGE', 'clinical-md', '1.2.3', 42, 0, true])
      expect(sanitizeValue(v)).toBe(v);
  });

  it('redacts anything that could be free text or PHI', () => {
    for (const v of [
      'Maria Gonzalez',
      '2025-08-10 09:30',
      'line1\nline2',
      'x'.repeat(129),
      'maria.gonzalez@example.com ',
      '(617) 555-0142',
      'José',
      '\u001b[31mred',
    ]) {
      expect(sanitizeValue(v)).toBe(REDACTED);
    }
    for (const v of ['123-45-6789', '4155550142', '415-555-0142', 'MRN-4471902', '2024-03-05', '03/05/2024', 'a@b.co', 'Patient/7781234']) {
      expect(sanitizeValue(v)).toBe(REDACTED);
    }
    expect(sanitizeValue('Observation/obs-301')).toBe('Observation/obs-301');
    expect(sanitizeValue('v0.1.0')).toBe('v0.1.0');
    expect(sanitizeValue(Number.NaN)).toBeNull();
    expect(sanitizeValue(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('createLogger', () => {
  it('writes one JSON object per line with sanitized fields', () => {
    const { logger, lines } = capture();
    logger.info('pack.done', { resources: 95, format: 'clinical-md', patient: 'Maria Gonzalez', ok: true });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ts: '2026-11-05T00:00:00.000Z',
      level: 'info',
      event: 'pack.done',
      resources: 95,
      format: 'clinical-md',
      patient: REDACTED,
      ok: true,
    });
  });

  it('cannot be log-injected through event names, keys or values', () => {
    const { logger, lines } = capture('debug', 'text');
    logger.warn('evil\nFAKE ERROR line', { 'bad key\n': 'x', good: 'a\nb', nested: '{"a":1}' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toBe(`2026-11-05T00:00:00.000Z WARN  ${REDACTED} good=${REDACTED} nested=${REDACTED}`);
  });

  it('respects levels, including silent', () => {
    const { logger, lines } = capture('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(['c', 'd']);
    const silent = capture('silent');
    silent.logger.error('x');
    expect(silent.lines).toEqual([]);
    expect(() => silentLogger.error('x', { a: 1 })).not.toThrow();
  });

  it('child loggers bind fields, and call-site fields win', () => {
    const { logger, lines } = capture();
    logger.child({ command: 'pack', run: 'r1' }).info('step', { run: 'r2' });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ command: 'pack', run: 'r2' });
  });

  it('time() reports duration and outcome, and rethrows failures with only their code', async () => {
    const { logger, lines } = capture();
    await expect(logger.time('stage.ok', () => 7)).resolves.toBe(7);
    const failure = Object.assign(new Error('Patient Maria Gonzalez is invalid'), { code: 'INPUT_INVALID' });
    await expect(
      logger.time('stage.fail', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const [ok, bad] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ok).toMatchObject({ level: 'debug', event: 'stage.ok', ok: true });
    expect(typeof ok?.ms).toBe('number');
    expect(bad).toMatchObject({ level: 'warn', event: 'stage.fail', ok: false, code: 'INPUT_INVALID' });
    expect(lines.join('\n')).not.toContain('Maria');
  });
});
