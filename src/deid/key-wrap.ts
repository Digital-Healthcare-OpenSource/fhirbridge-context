/**
 * Envelope encryption for passphrase vaults: a scrypt-derived key-encryption key (KEK) wraps the
 * random master key with AES-256-GCM. The master key never changes when the KDF is upgraded or
 * the passphrase is rotated, so HMAC-derived values (date-shift store keys, id pseudonyms) stay
 * stable across those operations.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { FhirBridgeError } from '../errors.js';

export interface WrappedKey {
  iv: string;
  tag: string;
  ciphertext: string;
}

const KEY_BYTES = 32;

export function wrapKey(kek: Buffer, masterKey: Buffer, aad: Buffer): WrappedKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function unwrapKey(kek: Buffer, wrapped: WrappedKey, aad: Buffer): Buffer {
  let key: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(wrapped.iv, 'base64'), {
      authTagLength: 16,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
    key = Buffer.concat([decipher.update(Buffer.from(wrapped.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw new FhirBridgeError(
      'VAULT_DECRYPT_FAILED',
      'Vault decryption failed: wrong key or passphrase, or the vault file was modified.',
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new FhirBridgeError('VAULT_DECRYPT_FAILED', 'Vault file holds a malformed wrapped key.');
  }
  return key;
}

export function isWrappedKey(value: unknown): value is WrappedKey {
  const w = value as Partial<WrappedKey> | null;
  return (
    typeof w === 'object' &&
    w !== null &&
    typeof w.iv === 'string' &&
    typeof w.tag === 'string' &&
    typeof w.ciphertext === 'string'
  );
}
