/**
 * Typed errors with stable codes and deterministic CLI exit codes.
 *
 * Privacy rule: an error `message` is shown to users and may end up in CI logs, so it must
 * never contain patient data. Errors from third-party code (JSON.parse quotes the offending
 * input, fs errors quote paths) are wrapped with a generic message; the original is kept only
 * as `cause` and is printed exclusively under `--debug`.
 */

export const ERROR_CODES = [
  'USAGE',
  'CONFIG_INVALID',
  'INPUT_NOT_FOUND',
  'INPUT_INVALID',
  'INPUT_TOO_LARGE',
  'VAULT_KEY_MISSING',
  'VAULT_DECRYPT_FAILED',
  'VAULT_CONFLICT',
  'VAULT_IO',
  'PULL_FAILED',
  'PULL_AUTH',
  'PULL_TIMEOUT',
  'VERIFY_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Exit codes follow sysexits(3) where one fits, so scripts can branch on them.
 * 1 = verification found critical clinical issues (an expected outcome, not a crash).
 */
export const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  VERIFY_FAILED: 1,
  USAGE: 64, // EX_USAGE
  CONFIG_INVALID: 78, // EX_CONFIG
  INPUT_NOT_FOUND: 66, // EX_NOINPUT
  INPUT_INVALID: 65, // EX_DATAERR
  INPUT_TOO_LARGE: 65,
  VAULT_KEY_MISSING: 78,
  VAULT_DECRYPT_FAILED: 77, // EX_NOPERM
  VAULT_CONFLICT: 75, // EX_TEMPFAIL
  VAULT_IO: 74, // EX_IOERR
  PULL_FAILED: 69, // EX_UNAVAILABLE
  PULL_AUTH: 77,
  PULL_TIMEOUT: 75,
  INTERNAL: 70, // EX_SOFTWARE
};

export interface FhirBridgeErrorOptions {
  cause?: unknown;
  /** Actionable next step shown under the message. Must also be PHI-free. */
  hint?: string;
}

export class FhirBridgeError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, opts: FhirBridgeErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'FhirBridgeError';
    this.code = code;
    this.hint = opts.hint;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function isFhirBridgeError(value: unknown): value is FhirBridgeError {
  return value instanceof FhirBridgeError;
}

interface ErrnoLike {
  code?: unknown;
  name?: unknown;
}

const FS_CODES: Readonly<Record<string, { code: ErrorCode; message: string }>> = {
  ENOENT: { code: 'INPUT_NOT_FOUND', message: 'Input path does not exist.' },
  ENOTDIR: { code: 'INPUT_NOT_FOUND', message: 'A path component is not a directory.' },
  EACCES: { code: 'VAULT_IO', message: 'Permission denied while accessing a file.' },
  EPERM: { code: 'VAULT_IO', message: 'Operation not permitted on a file.' },
  EISDIR: { code: 'INPUT_INVALID', message: 'Expected a file but found a directory.' },
  ENOSPC: { code: 'VAULT_IO', message: 'No space left on device.' },
  EMFILE: { code: 'VAULT_IO', message: 'Too many open files.' },
};

/**
 * Normalize anything thrown into a FhirBridgeError with a PHI-free message.
 * Known library errors are classified; everything else becomes INTERNAL.
 */
export function toFhirBridgeError(error: unknown): FhirBridgeError {
  if (isFhirBridgeError(error)) return error;
  const errno = (typeof error === 'object' && error !== null ? error : {}) as ErrnoLike;
  if (typeof errno.code === 'string') {
    const fs = FS_CODES[errno.code];
    if (fs) return new FhirBridgeError(fs.code, fs.message, { cause: error });
    if (errno.code.startsWith('commander.')) {
      return new FhirBridgeError('USAGE', 'Invalid command-line usage.', { cause: error });
    }
  }
  if (errno.name === 'SyntaxError') {
    return new FhirBridgeError('INPUT_INVALID', 'Input is not valid JSON.', { cause: error });
  }
  if (errno.name === 'AbortError' || errno.name === 'TimeoutError') {
    return new FhirBridgeError('PULL_TIMEOUT', 'The operation timed out or was aborted.', { cause: error });
  }
  return new FhirBridgeError('INTERNAL', 'Unexpected internal error. Re-run with --debug for details.', {
    cause: error,
  });
}

export function exitCodeFor(error: unknown): number {
  return toFhirBridgeError(error).exitCode;
}

/** Render the cause chain for `--debug` (may contain raw input; never shown by default). */
export function describeCauses(error: unknown, maxDepth = 5): string[] {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current !== undefined; depth++) {
    if (current instanceof Error) {
      lines.push(`${current.name}: ${current.message}`);
      if (current.stack) lines.push(...current.stack.split('\n').slice(1, 6));
      current = current.cause;
    } else {
      lines.push(String(current));
      current = undefined;
    }
  }
  return lines;
}
