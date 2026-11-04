/**
 * Vault file format, key resolution and file locking.
 *
 * File versions:
 *   v1  scrypt N=2^15 derives the master key directly; constant GCM AAD (read only)
 *   v2  raw-key vaults (FHIRBRIDGE_VAULT_KEY / key file); legacy v2 passphrase files derived the
 *       master key with scrypt N=2^17 (read only). AAD binds [format, version, kdf, salt].
 *   v3  passphrase vaults: scrypt N=2^17 derives a KEK that wraps a random master key (envelope).
 *       AAD binds [format, version, kdf, salt, wrappedKey]. v1/v2 passphrase vaults are upgraded to
 *       v3 on their next save WITHOUT changing the master key, so date shifts and pseudonyms that
 *       are keyed by HMAC of the master key stay stable.
 * Every write is restricted to the current user (chmod 600 / owner-only ACL on Windows).
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FhirBridgeError } from '../errors.js';
import { restrictToOwner } from './file-permissions.js';
import { isWrappedKey, unwrapKey, wrapKey, type WrappedKey } from './key-wrap.js';

export const VAULT_KEY_ENV = 'FHIRBRIDGE_VAULT_KEY';
export const VAULT_PASSPHRASE_ENV = 'FHIRBRIDGE_VAULT_PASSPHRASE';
export const MIN_PASSPHRASE_LENGTH = 12;
export const FORMAT = 'fhirbridge-vault';
const KEY_BYTES = 32;
const HKDF_SALT = Buffer.from('fhirbridge-vault-hkdf-v1');
const SCRYPT_V1 = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const SCRYPT_V2 = { N: 2 ** 17, r: 8, p: 1, maxmem: 384 * 1024 * 1024 } as const;
const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

export type Kdf = 'scrypt' | 'raw';
export type VaultVersion = 1 | 2 | 3;

export interface VaultFile {
  format: typeof FORMAT;
  version: VaultVersion;
  kdf: Kdf;
  salt?: string;
  /** v3 only: master key wrapped by the passphrase-derived KEK. */
  wrappedKey?: WrappedKey;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface VaultSubkeys {
  enc: Buffer;
  hmac: Buffer;
}

export interface VaultOpenOptions {
  passphrase?: string;
  masterKey?: Buffer;
  /** Permit creating/reading a `<path>.key` file next to the vault (weaker: key beside data). */
  allowKeyFile?: boolean;
}

export interface ResolvedKey {
  masterKey: Buffer;
  kdf: Kdf;
  salt?: Buffer;
  /** Version written on save. */
  version: VaultVersion;
  /** v3: wrapped master key written into the header on save. */
  wrappedKey?: WrappedKey;
}

export function deriveVaultSubkeys(masterKey: Buffer): VaultSubkeys {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, Buffer.from(info), KEY_BYTES));
  return { enc: derive('fhirbridge-vault/enc'), hmac: derive('fhirbridge-vault/hmac') };
}

export function assertKeyLength(key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new FhirBridgeError('VAULT_KEY_MISSING', `Vault master key must be ${KEY_BYTES} bytes.`);
  return key;
}

export const newMasterKey = (): Buffer => randomBytes(KEY_BYTES);

function parseHexKey(hex: string, origin: string): Buffer {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new FhirBridgeError('VAULT_KEY_MISSING', `${origin} must contain exactly 64 hex characters (32 bytes).`, {
      hint: 'Provide a 64-character hex key, or use a passphrase.',
    });
  }
  return Buffer.from(clean, 'hex');
}

/* --------------------------------- file io --------------------------------- */

export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new FhirBridgeError('VAULT_IO', 'Could not read a vault file.', { cause: err });
  }
}

export async function atomicWrite(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(tmp, data, { mode });
    // Restrict before the rename so the final path never exists with inherited permissions.
    await restrictToOwner(tmp);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if (err instanceof FhirBridgeError) throw err;
    throw new FhirBridgeError('VAULT_IO', 'Could not write the vault file.', { cause: err });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exclusive `<file>.lock` (created with `wx`); waits ~2s, treats locks older than 30s as stale. */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new FhirBridgeError('VAULT_IO', 'Could not lock the vault file.', { cause: err });
      }
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => undefined,
      );
      if (age === undefined) continue; // released between open and stat
      if (age > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new FhirBridgeError('VAULT_CONFLICT', 'Vault is locked by another process.', {
          hint: 'Retry shortly; remove a stale .lock file next to the vault if no other run is active.',
        });
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/* ------------------------------- file format -------------------------------- */

export function parseVaultFile(text: string): VaultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FhirBridgeError('VAULT_DECRYPT_FAILED', 'Vault file is not valid JSON.');
  }
  const f = parsed as Partial<VaultFile> | null;
  const ok =
    f !== null &&
    typeof f === 'object' &&
    f.format === FORMAT &&
    (f.version === 1 || f.version === 2 || f.version === 3) &&
    (f.kdf === 'scrypt' || f.kdf === 'raw') &&
    typeof f.iv === 'string' &&
    typeof f.tag === 'string' &&
    typeof f.ciphertext === 'string' &&
    (f.version !== 3 || (f.kdf === 'scrypt' && typeof f.salt === 'string' && isWrappedKey(f.wrappedKey)));
  if (!ok) throw new FhirBridgeError('VAULT_DECRYPT_FAILED', 'Unrecognised vault file format or version.');
  return f as VaultFile;
}

function aadFor(header: Pick<VaultFile, 'version' | 'kdf' | 'salt' | 'wrappedKey'>): Buffer {
  if (header.version === 1) return Buffer.from(`${FORMAT}:v1`);
  const fields: unknown[] = [FORMAT, header.version, header.kdf, header.salt ?? null];
  if (header.version === 3) {
    const w = header.wrappedKey;
    fields.push(w ? [w.iv, w.tag, w.ciphertext] : null);
  }
  return Buffer.from(JSON.stringify(fields));
}

/** AAD for wrapping the master key: binds the KEK's salt so a wrapped key cannot be transplanted. */
function wrapAad(salt: Buffer): Buffer {
  return Buffer.from(`${FORMAT}:v3:kek:${salt.toString('base64')}`);
}

export function encryptVault(
  encKey: Buffer,
  plaintext: string,
  header: { version: VaultVersion; kdf: Kdf; salt?: Buffer; wrappedKey?: WrappedKey },
): VaultFile {
  const salt = header.salt?.toString('base64');
  const meta = {
    version: header.version,
    kdf: header.kdf,
    ...(salt ? { salt } : {}),
    ...(header.version === 3 && header.wrappedKey ? { wrappedKey: header.wrappedKey } : {}),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv, { authTagLength: 16 });
  cipher.setAAD(aadFor(meta));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    format: FORMAT,
    ...meta,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptVault(encKey: Buffer, file: VaultFile): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(file.iv, 'base64'), {
      authTagLength: 16,
    });
    decipher.setAAD(aadFor(file));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new FhirBridgeError(
      'VAULT_DECRYPT_FAILED',
      'Vault decryption failed: wrong key or passphrase, or the vault file was modified.',
    );
  }
}

/* ------------------------------ key resolution ------------------------------ */

function passphraseKey(passphrase: string, existing: VaultFile | undefined): ResolvedKey {
  if (passphrase.length === 0) throw new FhirBridgeError('VAULT_KEY_MISSING', 'Vault passphrase must not be empty.');
  if (existing && existing.kdf !== 'scrypt') throw new FhirBridgeError('VAULT_KEY_MISSING', 'Vault was not created with a passphrase.', {
      hint: 'Use the vault key (FHIRBRIDGE_VAULT_KEY) instead of a passphrase.',
    });
  if (!existing && passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new FhirBridgeError(
      'VAULT_KEY_MISSING',
      `Vault passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  }
  if (existing?.version === 3 && existing.wrappedKey && existing.salt) {
    const salt = Buffer.from(existing.salt, 'base64');
    const kek = scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_V2);
    const masterKey = unwrapKey(kek, existing.wrappedKey, wrapAad(salt));
    return { masterKey, kdf: 'scrypt', salt, version: 3, wrappedKey: existing.wrappedKey };
  }
  // New vault: random master key. Legacy v1/v2 passphrase vault: the scrypt output IS the master
  // key; keep it and re-wrap it under a fresh N=2^17 KEK so the next save upgrades the file to v3.
  const masterKey = existing ? legacyPassphraseKey(passphrase, existing) : newMasterKey();
  const salt = randomBytes(16);
  const kek = scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_V2);
  return { masterKey, kdf: 'scrypt', salt, version: 3, wrappedKey: wrapKey(kek, masterKey, wrapAad(salt)) };
}

function legacyPassphraseKey(passphrase: string, existing: VaultFile): Buffer {
  const salt = existing.salt ? Buffer.from(existing.salt, 'base64') : Buffer.alloc(0);
  if (salt.length === 0) throw new FhirBridgeError('VAULT_DECRYPT_FAILED', 'Vault file is missing its KDF salt.');
  return scryptSync(passphrase, salt, KEY_BYTES, existing.version === 1 ? SCRYPT_V1 : SCRYPT_V2);
}

export async function resolveKey(
  file: string,
  existing: VaultFile | undefined,
  opts: VaultOpenOptions,
): Promise<ResolvedKey> {
  if (opts.masterKey) return { masterKey: assertKeyLength(opts.masterKey), kdf: 'raw', version: 2 };
  if (opts.passphrase !== undefined) return passphraseKey(opts.passphrase, existing);
  const envKey = process.env[VAULT_KEY_ENV];
  const envPass = process.env[VAULT_PASSPHRASE_ENV];
  if (existing?.kdf === 'scrypt') {
    if (envPass) return passphraseKey(envPass, existing);
    throw new FhirBridgeError('VAULT_KEY_MISSING', 'Vault is passphrase-protected: passphrase required.', {
      hint: `Set ${VAULT_PASSPHRASE_ENV}.`,
    });
  }
  if (envKey) return { masterKey: parseHexKey(envKey, VAULT_KEY_ENV), kdf: 'raw', version: 2 };
  if (!existing && envPass) return passphraseKey(envPass, existing);
  const keyFile = `${file}.key`;
  const stored = await readIfExists(keyFile);
  if (stored !== undefined) return { masterKey: parseHexKey(stored, keyFile), kdf: 'raw', version: 2 };
  if (existing) {
    throw new FhirBridgeError('VAULT_KEY_MISSING', 'Vault key not found.', {
      hint: `Set ${VAULT_PASSPHRASE_ENV} or ${VAULT_KEY_ENV}, or restore the .key file next to the vault.`,
    });
  }
  if (!opts.allowKeyFile) {
    throw new FhirBridgeError(
      'VAULT_KEY_MISSING',
      `No vault key: set ${VAULT_PASSPHRASE_ENV} or ${VAULT_KEY_ENV} (or pass allowKeyFile)`,
      { hint: `Set ${VAULT_PASSPHRASE_ENV} or ${VAULT_KEY_ENV}, or --allow-key-file.` },
    );
  }
  const masterKey = newMasterKey();
  try {
    await mkdir(path.dirname(path.resolve(keyFile)), { recursive: true });
    await writeFile(keyFile, masterKey.toString('hex'), { mode: 0o600, flag: 'wx' });
    await restrictToOwner(keyFile);
  } catch (err) {
    if (err instanceof FhirBridgeError) {
      await rm(keyFile, { force: true }).catch(() => undefined);
      throw err;
    }
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new FhirBridgeError('VAULT_IO', 'Could not create the vault key file.', { cause: err });
    }
    // Lost a creation race: use the key the winner wrote.
    const winner = await readFile(keyFile, 'utf8');
    return { masterKey: parseHexKey(winner, keyFile), kdf: 'raw', version: 2 };
  }
  return { masterKey, kdf: 'raw', version: 2 };
}
