/**
 * Envelope-encrypted (v3) passphrase vaults, the v1→v3 upgrade that must keep the master key,
 * and owner-only file permissions.
 */
import { execFileSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeHarborVault } from '../src/deid/vault.js';
import { decryptVault, deriveVaultSubkeys, encryptVault, parseVaultFile } from '../src/deid/vault-crypto.js';
import { windowsPrincipal } from '../src/deid/file-permissions.js';

const PASS = 'correct horse battery staple';
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fhirbridge-vault3-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Snapshot {
  token: string;
  shift: number;
  pseudonym: string;
}

function populate(v: SafeHarborVault): Snapshot {
  const token = v.tokenFor('MRN', 'MRN-555');
  const shift = v.assignDateShift('Patient/p1', 'MRN-555');
  const pseudonym = v.pseudonymizeResourceId('Encounter', 'enc-2024-03-05');
  return { token, shift, pseudonym };
}

/** Write a genuine v1 file: scrypt N=2^15 output is the master key, constant AAD. */
async function writeLegacyV1(file: string): Promise<Snapshot> {
  const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const masterKey = scryptSync(PASS, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const seed = SafeHarborVault.create({ masterKey });
  const snap = populate(seed);
  const rawPath = path.join(dir, `seed-${path.basename(file)}`);
  await seed.save(rawPath);
  const state = decryptVault(deriveVaultSubkeys(masterKey).enc, parseVaultFile(await readFile(rawPath, 'utf8')));
  const v1 = encryptVault(deriveVaultSubkeys(masterKey).enc, state, { version: 1, kdf: 'scrypt', salt });
  await writeFile(file, JSON.stringify(v1));
  return snap;
}

describe('v3 envelope encryption', () => {
  it('upgrades a v1 passphrase vault to v3 on save without changing the master key', async () => {
    const file = path.join(dir, 'legacy.json');
    const before = await writeLegacyV1(file);

    const opened = await SafeHarborVault.open(file, { passphrase: PASS });
    expect(opened.resolveToken(before.token)).toBe('MRN-555');
    await opened.save();

    const header = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(header.version).toBe(3);
    expect(header.wrappedKey).toMatchObject({ iv: expect.any(String), tag: expect.any(String) });

    const again = await SafeHarborVault.open(file, { passphrase: PASS });
    expect(again.resolveToken(before.token)).toBe('MRN-555');
    expect(again.dateShiftDaysFor('Patient/p1')).toBe(before.shift);
    // Same HMAC key → the same pseudonym for the same id: date-shift store keys stay valid.
    expect(again.pseudonymizeResourceId('Encounter', 'enc-2024-03-05')).toBe(before.pseudonym);
    expect(again.assignDateShift('Patient/p1', 'MRN-555')).toBe(before.shift);
  });

  it('rejects a wrong passphrase and a tampered wrapped key', async () => {
    const file = path.join(dir, 'tamper.json');
    const v = await SafeHarborVault.open(file, { passphrase: PASS });
    v.tokenFor('SSN', '078-05-1120');
    await v.save();

    await expect(SafeHarborVault.open(file, { passphrase: 'another long passphrase' })).rejects.toMatchObject({
      code: 'VAULT_DECRYPT_FAILED',
    });

    const header = JSON.parse(await readFile(file, 'utf8')) as { wrappedKey: { ciphertext: string } };
    const flipped = Buffer.from(header.wrappedKey.ciphertext, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    header.wrappedKey.ciphertext = flipped.toString('base64');
    await writeFile(file, JSON.stringify(header));
    await expect(SafeHarborVault.open(file, { passphrase: PASS })).rejects.toMatchObject({
      code: 'VAULT_DECRYPT_FAILED',
    });
  });

  it('gives each new passphrase vault its own random master key', async () => {
    const a = await SafeHarborVault.open(path.join(dir, 'a.json'), { passphrase: PASS });
    const b = await SafeHarborVault.open(path.join(dir, 'b.json'), { passphrase: PASS });
    expect(a.subkeys.hmac.equals(b.subkeys.hmac)).toBe(false);
  });

  it('rejects a v3 header without a wrapped key', async () => {
    const file = path.join(dir, 'broken.json');
    const v = await SafeHarborVault.open(file, { passphrase: PASS });
    await v.save();
    const header = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    delete header.wrappedKey;
    await writeFile(file, JSON.stringify(header));
    await expect(SafeHarborVault.open(file, { passphrase: PASS })).rejects.toMatchObject({
      code: 'VAULT_DECRYPT_FAILED',
    });
  });
});

describe('owner-only permissions', () => {
  async function assertOwnerOnly(file: string): Promise<void> {
    if (process.platform === 'win32') {
      const acl = execFileSync('icacls', [file], { encoding: 'utf8' });
      expect(acl).not.toMatch(/\(I\)/); // no inherited entries
      expect(acl).not.toMatch(/BUILTIN\\Users|Everyone|Authenticated Users/i);
      expect(acl.toLowerCase()).toContain(windowsPrincipal().toLowerCase());
    } else {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  }

  it('restricts a saved vault file to the current user', async () => {
    const file = path.join(dir, 'acl.json');
    const v = await SafeHarborVault.open(file, { passphrase: PASS });
    v.tokenFor('MRN', 'MRN-1');
    await v.save();
    await assertOwnerOnly(file);
  });

  it('restricts a generated key file to the current user', async () => {
    const file = path.join(dir, 'keyed.json');
    const v = await SafeHarborVault.open(file, { allowKeyFile: true });
    await v.save();
    await assertOwnerOnly(`${file}.key`);
    await assertOwnerOnly(file);
  });

  it('builds the Windows principal from USERDOMAIN when present', () => {
    expect(windowsPrincipal({ USERDOMAIN: 'CORP' }, 'alice')).toBe('CORP\\alice');
    expect(windowsPrincipal({}, 'alice')).toBe('alice');
  });
});
