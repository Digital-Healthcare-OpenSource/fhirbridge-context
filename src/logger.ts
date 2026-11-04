/**
 * PHI-safe structured logger (stderr only — stdout is reserved for data and the MCP channel).
 *
 * The logger cannot know whether a string is patient data, so it is deny-by-default:
 * field values must be numbers, booleans, or short identifier-like strings
 * (`[A-Za-z0-9_.:/@+-]`, ≤ 128 chars: error codes, resource keys, tool names, formats).
 * Anything else — free text, names, dates with spaces, nested objects — is replaced by
 * "[redacted]". Event names follow the same rule.
 */
import type { LogFormat, LogLevel } from './config.js';

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  error(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  /** Logger that adds `fields` to every record. */
  child(fields: LogFields): Logger;
  /** Measure a step; logs `<event>` with `ms` and `ok` at debug (warn on failure), rethrows. */
  time<T>(event: string, fn: () => Promise<T> | T, fields?: LogFields): Promise<T>;
}

export interface LoggerOptions {
  format?: LogFormat;
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

type ActiveLevel = Exclude<LogLevel, 'silent'>;

const LEVELS: Readonly<Record<ActiveLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };
const THRESHOLD: Readonly<Record<LogLevel, number>> = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };
const SAFE_STRING = /^[A-Za-z0-9_.:/@+-]{0,128}$/;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const REDACTED = '[redacted]';

/** Exported for tests: the exact sanitization applied to every value. */
export function sanitizeValue(value: LogValue): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return typeof value === 'string' && SAFE_STRING.test(value) ? value : REDACTED;
}

function sanitizeFields(fields: LogFields): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_KEY.test(key) || value === undefined) continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}

function renderText(ts: string, level: string, event: string, fields: Record<string, unknown>): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`);
  return [ts, level.toUpperCase().padEnd(5), event, ...pairs].join(' ');
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'ERROR';
}

export function createLogger(opts: LoggerOptions = {}, bound: LogFields = {}): Logger {
  const format = opts.format ?? 'text';
  const threshold = THRESHOLD[opts.level ?? 'info'];
  const write = opts.write ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());

  const emit = (level: ActiveLevel, event: string, fields: LogFields = {}): void => {
    if (LEVELS[level] > threshold) return;
    const safeEvent = event.length > 0 && SAFE_STRING.test(event) ? event : REDACTED;
    const merged = sanitizeFields({ ...bound, ...fields });
    const ts = now().toISOString();
    write(
      format === 'json'
        ? JSON.stringify({ ts, level, event: safeEvent, ...merged })
        : renderText(ts, level, safeEvent, merged),
    );
  };

  return {
    error: (event, fields) => emit('error', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    child: (fields) => createLogger(opts, { ...bound, ...fields }),
    async time<T>(event: string, fn: () => Promise<T> | T, fields: LogFields = {}): Promise<T> {
      const start = performance.now();
      try {
        const result = await fn();
        emit('debug', event, { ...fields, ok: true, ms: Math.round(performance.now() - start) });
        return result;
      } catch (error) {
        emit('warn', event, { ...fields, ok: false, code: errorCode(error), ms: Math.round(performance.now() - start) });
        throw error;
      }
    },
  };
}

/** A logger that discards everything (SDK default: libraries stay silent unless asked). */
export const silentLogger: Logger = createLogger({ level: 'silent', write: () => undefined });
