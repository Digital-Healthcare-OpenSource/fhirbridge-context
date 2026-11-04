/**
 * Runtime configuration from environment variables, validated once with zod.
 * Invalid values fail fast with a CONFIG_INVALID error naming the variable (never its value,
 * which could be a secret).
 */
import { z } from 'zod';
import { FhirBridgeError } from './errors.js';

const MB = 1024 * 1024;

const positiveInt = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'must be a positive integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

const EnvSchema = z.object({
  FHIRBRIDGE_MAX_INPUT_MB: positiveInt(65_536).default(1024),
  FHIRBRIDGE_MAX_RESOURCES: positiveInt(50_000_000).default(2_000_000),
  FHIRBRIDGE_LOG_FORMAT: z.enum(['text', 'json']).default('text'),
  FHIRBRIDGE_LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
});

export interface RuntimeLimits {
  /** Maximum total bytes read from disk for one input (file or directory). */
  maxInputBytes: number;
  /** Maximum number of FHIR resources accepted from one input. */
  maxResources: number;
}

export type LogFormat = 'text' | 'json';
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface RuntimeConfig {
  limits: RuntimeLimits;
  logFormat: LogFormat;
  logLevel: LogLevel;
}

/** Only FHIRBRIDGE_* keys are read, so unrelated environment variables are never touched. */
export function loadRuntimeConfig(env: Readonly<Record<string, string | undefined>> = process.env): RuntimeConfig {
  const picked = Object.fromEntries(
    Object.keys(EnvSchema.shape)
      .map((key) => [key, env[key]] as const)
      .filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = EnvSchema.safeParse(picked);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const variable = issue?.path.join('.') || 'environment';
    throw new FhirBridgeError('CONFIG_INVALID', `Invalid ${variable}: ${issue?.message ?? 'invalid value'}.`);
  }
  const cfg = parsed.data;
  return {
    limits: {
      maxInputBytes: cfg.FHIRBRIDGE_MAX_INPUT_MB * MB,
      maxResources: cfg.FHIRBRIDGE_MAX_RESOURCES,
    },
    logFormat: cfg.FHIRBRIDGE_LOG_FORMAT,
    logLevel: cfg.FHIRBRIDGE_LOG_LEVEL,
  };
}

export const DEFAULT_LIMITS: Readonly<RuntimeLimits> = Object.freeze(loadRuntimeConfig({}).limits);
