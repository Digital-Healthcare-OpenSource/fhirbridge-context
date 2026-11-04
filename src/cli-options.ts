/** Commander option factories and argument parsers shared by the CLI commands. */
import { InvalidArgumentError, Option } from 'commander';
import type { FreeTextMode } from './deid/index.js';
import type { ContextFormat } from './types/pipeline.js';

export const FORMATS: ContextFormat[] = ['clinical-md', 'view-json', 'csv', 'fhir-slim'];
export const FREE_TEXT_MODES: readonly FreeTextMode[] = ['scrub', 'omit'];
export const MAX_PAGES_LIMIT = 10_000;

export function parseFormat(value: string): ContextFormat {
  if (!FORMATS.includes(value as ContextFormat)) {
    throw new InvalidArgumentError(`Expected one of: ${FORMATS.join(', ')}`);
  }
  return value as ContextFormat;
}

export function formatOption(): Option {
  return new Option('-f, --format <format>', `output format (${FORMATS.join(' | ')})`)
    .argParser(parseFormat)
    .default('clinical-md');
}

export function parseFreeText(value: string): FreeTextMode {
  if (!FREE_TEXT_MODES.includes(value as FreeTextMode)) {
    throw new InvalidArgumentError(`Expected one of: ${FREE_TEXT_MODES.join(', ')}`);
  }
  return value as FreeTextMode;
}

export function freeTextOption(): Option {
  return new Option(
    '--free-text <mode>',
    'free text in de-identified output: scrub (best-effort redaction) | omit (structured data only; recommended for real data)',
  )
    .argParser(parseFreeText)
    .default('scrub');
}

/** A positive integer up to MAX_PAGES_LIMIT; anything else (0, negatives, decimals, text) is rejected. */
export function parseMaxPages(value: string): number {
  const n = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGES_LIMIT) {
    throw new InvalidArgumentError(`Expected a positive integer up to ${MAX_PAGES_LIMIT}`);
  }
  return n;
}

/** De-identification is the default; this stays accepted (hidden) so existing scripts keep working. */
export function deidOption(): Option {
  return new Option('--deid', 'de-identify the output (default)').hideHelp();
}

export function noDeidOption(): Option {
  return new Option(
    '--no-deid',
    'DISABLE de-identification: output keeps real names, identifiers and dates (never send it to an external LLM)',
  );
}
