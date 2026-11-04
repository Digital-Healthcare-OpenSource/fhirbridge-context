/** Error classification, exit codes and environment configuration. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, loadRuntimeConfig } from '../src/config.js';
import {
  ERROR_CODES,
  EXIT_CODES,
  FhirBridgeError,
  describeCauses,
  exitCodeFor,
  toFhirBridgeError,
} from '../src/errors.js';

describe('toFhirBridgeError', () => {
  it('keeps FhirBridgeError instances as they are', () => {
    const e = new FhirBridgeError('VAULT_CONFLICT', 'changed', { hint: 'rerun' });
    expect(toFhirBridgeError(e)).toBe(e);
    expect(e.exitCode).toBe(75);
  });

  it('classifies fs errors without echoing the path', () => {
    const fsError = Object.assign(new Error("ENOENT: no such file, open 'C:/patients/Jane-Doe-MRN-12345.json'"), {
      code: 'ENOENT',
    });
    const mapped = toFhirBridgeError(fsError);
    expect(mapped.code).toBe('INPUT_NOT_FOUND');
    expect(mapped.message).not.toContain('Jane');
    expect(mapped.cause).toBe(fsError);
  });

  it('wraps JSON SyntaxError so the offending input is not printed', () => {
    let syntax: unknown;
    try {
      JSON.parse('{"name": "Jane Doe" oops}');
    } catch (e) {
      syntax = e;
    }
    const mapped = toFhirBridgeError(syntax);
    expect(mapped.code).toBe('INPUT_INVALID');
    expect(mapped.message).not.toContain('Jane');
  });

  it('maps aborts and timeouts to PULL_TIMEOUT', () => {
    expect(toFhirBridgeError(new DOMException('x', 'TimeoutError')).code).toBe('PULL_TIMEOUT');
    expect(toFhirBridgeError(new DOMException('x', 'AbortError')).code).toBe('PULL_TIMEOUT');
  });

  it('turns unknown throws (even non-Errors) into INTERNAL with a generic message', () => {
    for (const thrown of [new TypeError('Patient Jane Doe'), 'Jane Doe', 42, null, undefined]) {
      const mapped = toFhirBridgeError(thrown);
      expect(mapped.code).toBe('INTERNAL');
      expect(mapped.message).not.toContain('Jane');
      expect(exitCodeFor(thrown)).toBe(70);
    }
  });

  it('has an exit code for every error code, and 1 only for verification failures', () => {
    for (const code of ERROR_CODES) expect(EXIT_CODES[code]).toBeGreaterThan(0);
    expect(ERROR_CODES.filter((c) => EXIT_CODES[c] === 1)).toEqual(['VERIFY_FAILED']);
  });

  it('describes cause chains for --debug', () => {
    const root = new Error('root cause');
    const lines = describeCauses(new FhirBridgeError('INTERNAL', 'outer', { cause: root }));
    expect(lines[0]).toContain('outer');
    expect(lines.some((l) => l.includes('root cause'))).toBe(true);
  });
});

describe('loadRuntimeConfig', () => {
  it('uses safe defaults', () => {
    const cfg = loadRuntimeConfig({});
    expect(cfg.limits).toEqual(DEFAULT_LIMITS);
    expect(cfg.limits.maxInputBytes).toBe(1024 * 1024 * 1024);
    expect(cfg.logFormat).toBe('text');
    expect(cfg.logLevel).toBe('info');
  });

  it('parses overrides and ignores unrelated variables', () => {
    const cfg = loadRuntimeConfig({
      FHIRBRIDGE_MAX_INPUT_MB: '64',
      FHIRBRIDGE_MAX_RESOURCES: '1000',
      FHIRBRIDGE_LOG_FORMAT: 'json',
      FHIRBRIDGE_LOG_LEVEL: 'debug',
      UNRELATED_SECRET: 'ignored',
    });
    expect(cfg.limits).toEqual({ maxInputBytes: 64 * 1024 * 1024, maxResources: 1000 });
    expect(cfg.logFormat).toBe('json');
    expect(cfg.logLevel).toBe('debug');
  });

  it('fails fast naming the variable but not echoing its value', () => {
    for (const bad of ['-5', '0', '1e9', 'lots', '99999999999']) {
      try {
        loadRuntimeConfig({ FHIRBRIDGE_MAX_INPUT_MB: bad });
        expect.unreachable(`accepted ${bad}`);
      } catch (e) {
        expect(e).toMatchObject({ code: 'CONFIG_INVALID' });
        expect((e as Error).message).toContain('FHIRBRIDGE_MAX_INPUT_MB');
        if (bad.length > 2) expect((e as Error).message).not.toContain(bad);
      }
    }
    expect(() => loadRuntimeConfig({ FHIRBRIDGE_LOG_FORMAT: 'xml' })).toThrow(/FHIRBRIDGE_LOG_FORMAT/);
  });
});
