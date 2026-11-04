/**
 * SafeHarborVault: reversible pseudonym store.
 *
 * Holds Token <-> raw value mappings and per-patient date shifts, encrypted at rest with
 * AES-256-GCM. Two independent subkeys are derived from one 32-byte master key via
 * HKDF-SHA256: `enc` (file encryption) and `hmac` (date-shift derivation). They are never
 * interchanged.
 *
 * PRIVACY: raw values leave this class only through `resolveToken`. Nothing here logs.
 *
 * Key resolution for `open()` (first match wins):
 *   1. opts.masterKey
 *   2. opts.passphrase (scrypt, random salt stored in the vault file)
 *   3. env FHIRBRIDGE_VAULT_KEY (64 hex chars)
 *   4. random key file `<path>.key` (mode 0o600). Keep it SEPARATE from the vault file
 *      (different disk / secret store); anyone holding both can decrypt the vault.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PhiCategory, VaultReader } from '../types/pipeline.js';

export const VAULT_KEY_ENV = 'FHIRBRIDGE_VAULT_KEY';
const FORMAT = 'fhirbridge-vault';
const VERSION = 1;
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`);
const HKDF_SALT = Buffer.from('fhirbridge-vault-hkdf-v1');
const KEY_BYTES = 32;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const SHIFT_SPAN = 364;
const SHIFT_MIN_ABS = 2;

export interface VaultSubkeys {
  enc: Buffer;
  hmac: Buffer;
}

export function deriveVaultSubkeys(masterKey: Buffer): VaultSubkeys {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, Buffer.from(info), KEY_BYTES));
  return { enc: derive('fhirbridge-vault/enc'), hmac: derive('fhirbridge-vault/hmac') };
}

type Kdf = 'scrypt' | 'raw';

interface VaultFile {
  format: typeof FORMAT;
  version: typeof VERSION;
  kdf: Kdf;
  salt?: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface TokenEntry {
  category: PhiCategory;
  raw: string;
  nameWords: number;
}

interface VaultState {
  counters: Record<string, number>;
  tokens: [string, TokenEntry][];
  index: [string, string][];
  dateShifts: [string, number][];
  windows: [string, { min: string; max: string }][];
}

export interface VaultOpenOptions {
  passphrase?: string;
  masterKey?: Buffer;
}

const NAME_CATEGORIES: ReadonlySet<PhiCategory> = new Set(['PATIENT', 'PROVIDER', 'PERSON']);
const TITLE_WORDS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'professor', 'md', 'do', 'rn', 'np',
  'pa', 'pac', 'phd', 'dds', 'dmd', 'pharmd', 'mbbs', 'jr', 'sr', 'ii', 'iii', 'iv',
]);
const DIGITS_ONLY: ReadonlySet<PhiCategory> = new Set(['PHONE', 'FAX', 'SSN']);
const ALNUM_ONLY: ReadonlySet<PhiCategory> = new Set([
  'MRN', 'HEALTH_PLAN', 'ACCOUNT', 'LICENSE', 'VEHICLE', 'DEVICE', 'BIOMETRIC', 'PHOTO', 'ID',
]);

/** Canonical form of a name: titles/punctuation/initials stripped, "Last, First" flipped, sorted. */
export function canonicalName(raw: string): string {
  const folded = raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const comma = folded.indexOf(',');
  const ordered = comma >= 0 ? `${folded.slice(comma + 1)} ${folded.slice(0, comma)}` : folded;
  const words = ordered
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 1 && !TITLE_WORDS.has(w));
  return [...new Set(words)].sort().join(' ');
}

function canonicalize(category: PhiCategory, raw: string): string {
  const trimmed = raw.trim();
  let out: string;
  if (NAME_CATEGORIES.has(category)) out = canonicalName(trimmed);
  else if (DIGITS_ONLY.has(category)) {
    out = trimmed.replace(/\D/g, '');
    if (category !== 'SSN' && out.length === 11 && out.startsWith('1')) out = out.slice(1);
  } else if (ALNUM_ONLY.has(category)) {
    out = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
    // "MRN-4471902" (structured) and "4471902" (free text after the label) are the same record number.
    if (category === 'MRN' && /^mrn\d/.test(out)) out = out.slice(3);
  }
  else if (category === 'EMAIL' || category === 'IP') out = trimmed.toLowerCase();
  else if (category === 'URL') out = trimmed.toLowerCase().replace(/\/+$/, '');
  else out = trimmed.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return out || trimmed.toLowerCase();
}

function parseHexKey(hex: string, origin: string): Buffer {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`${origin} must contain exactly 64 hex characters (32 bytes)`);
  }
  return Buffer.from(clean, 'hex');
}

function assertKeyLength(key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error(`Vault master key must be ${KEY_BYTES} bytes`);
  return key;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function atomicWrite(file: string, data: string, mode: number): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, file);
}

function parseVaultFile(text: string): VaultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Vault file is not valid JSON');
  }
  const f = parsed as Partial<VaultFile> | null;
  const ok =
    f !== null &&
    typeof f === 'object' &&
    f.format === FORMAT &&
    f.version === VERSION &&
    (f.kdf === 'scrypt' || f.kdf === 'raw') &&
    typeof f.iv === 'string' &&
    typeof f.tag === 'string' &&
    typeof f.ciphertext === 'string';
  if (!ok) throw new Error('Unrecognised vault file format or version');
  return f as VaultFile;
}

interface ResolvedKey {
  masterKey: Buffer;
  kdf: Kdf;
  salt?: Buffer;
}

async function resolveKey(
  file: string,
  existing: VaultFile | undefined,
  opts: VaultOpenOptions,
): Promise<ResolvedKey> {
  if (opts.masterKey) return { masterKey: assertKeyLength(opts.masterKey), kdf: 'raw' };
  if (opts.passphrase !== undefined) {
    if (opts.passphrase.length === 0) throw new Error('Vault passphrase must not be empty');
    if (existing && existing.kdf !== 'scrypt') {
      throw new Error('Vault was not created with a passphrase');
    }
    const salt = existing?.salt ? Buffer.from(existing.salt, 'base64') : randomBytes(16);
    if (salt.length === 0) throw new Error('Vault file is missing its KDF salt');
    return { masterKey: scryptSync(opts.passphrase, salt, KEY_BYTES, SCRYPT), kdf: 'scrypt', salt };
  }
  if (existing?.kdf === 'scrypt') throw new Error('Vault is passphrase-protected: passphrase required');
  const env = process.env[VAULT_KEY_ENV];
  if (env) return { masterKey: parseHexKey(env, VAULT_KEY_ENV), kdf: 'raw' };
  const keyFile = `${file}.key`;
  const stored = await readIfExists(keyFile);
  if (stored !== undefined) return { masterKey: parseHexKey(stored, keyFile), kdf: 'raw' };
  if (existing) {
    throw new Error(
      `Vault key not found: pass a passphrase/masterKey, set ${VAULT_KEY_ENV}, or restore ${keyFile}`,
    );
  }
  const masterKey = randomBytes(KEY_BYTES);
  await atomicWrite(keyFile, masterKey.toString('hex'), 0o600);
  return { masterKey, kdf: 'raw' };
}

export class SafeHarborVault implements VaultReader {
  private readonly keys: VaultSubkeys;
  private readonly counters = new Map<string, number>();
  private readonly entries = new Map<string, TokenEntry>();
  private readonly index = new Map<string, string>();
  private readonly nameIndex = new Map<string, { words: Set<string>; token: string }[]>();
  private readonly shifts = new Map<string, number>();
  private readonly windows = new Map<string, { min: string; max: string }>();
  private filePath?: string;
  private kdf: Kdf = 'raw';
  private salt?: Buffer;

  private constructor(masterKey: Buffer) {
    this.keys = deriveVaultSubkeys(masterKey);
  }

  /** Subkeys (exposed so tests can assert they are distinct; treat as secret). */
  get subkeys(): VaultSubkeys {
    return this.keys;
  }

  static create(opts: { masterKey?: Buffer } = {}): SafeHarborVault {
    return new SafeHarborVault(assertKeyLength(opts.masterKey ?? randomBytes(KEY_BYTES)));
  }

  static async open(file: string, opts: VaultOpenOptions = {}): Promise<SafeHarborVault> {
    const text = await readIfExists(file);
    const existing = text === undefined ? undefined : parseVaultFile(text);
    const resolved = await resolveKey(file, existing, opts);
    const vault = new SafeHarborVault(resolved.masterKey);
    vault.filePath = file;
    vault.kdf = resolved.kdf;
    vault.salt = resolved.salt;
    if (existing) vault.load(existing);
    return vault;
  }

  /* ------------------------------ persistence ------------------------------ */

  async save(file?: string): Promise<void> {
    const target = file ?? this.filePath;
    if (!target) throw new Error('Vault has no path: pass one to save()');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.enc, iv, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.toState()), 'utf8'), cipher.final()]);
    const out: VaultFile = {
      format: FORMAT,
      version: VERSION,
      kdf: this.kdf,
      ...(this.salt ? { salt: this.salt.toString('base64') } : {}),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await atomicWrite(target, JSON.stringify(out, null, 2), 0o600);
    this.filePath ??= target;
  }

  private load(file: VaultFile): void {
    let plain: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.keys.enc, Buffer.from(file.iv, 'base64'), {
        authTagLength: 16,
      });
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      plain = Buffer.concat([
        decipher.update(Buffer.from(file.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error(
        'Vault decryption failed: wrong key or passphrase, or the vault file was modified',
      );
    }
    this.fromState(JSON.parse(plain) as VaultState);
  }

  private toState(): VaultState {
    return {
      counters: Object.fromEntries(this.counters),
      tokens: [...this.entries],
      index: [...this.index],
      dateShifts: [...this.shifts],
      windows: [...this.windows],
    };
  }

  private fromState(state: VaultState): void {
    for (const [k, v] of Object.entries(state.counters)) this.counters.set(k, v);
    for (const [token, entry] of state.tokens) this.entries.set(token, entry);
    for (const [key, token] of state.index) {
      this.index.set(key, token);
      const entry = this.entries.get(token);
      if (entry && NAME_CATEGORIES.has(entry.category)) this.addNameIndex(key, token);
    }
    for (const [k, v] of state.dateShifts) this.shifts.set(k, v);
    for (const [k, v] of state.windows) this.windows.set(k, v);
  }

  /* -------------------------------- tokens --------------------------------- */

  tokenFor(category: PhiCategory, raw: string, opts: { patientKey?: string } = {}): string {
    const canon = canonicalize(category, raw);
    const scope = category === 'PATIENT' ? (opts.patientKey ?? '') : '';
    const key = this.indexKey(category, scope, canon);
    const found = this.index.get(key) ?? this.findNameMatch(category, scope, canon);
    if (found) {
      this.bind(category, key, found);
      this.upgradeRaw(found, raw, canon);
      return found;
    }
    const token = this.issue(category, raw, canon);
    this.bind(category, key, token);
    return token;
  }

  /** Bind several variants of one person's name to a single token; returns that token. */
  registerName(
    category: 'PATIENT' | 'PROVIDER' | 'PERSON',
    variants: string[],
    opts: { patientKey?: string } = {},
  ): string {
    const clean = variants.map((v) => v.trim()).filter((v) => canonicalName(v).length > 0);
    const [first, ...rest] = clean;
    if (first === undefined) throw new Error('registerName requires at least one non-empty name');
    const token = this.tokenFor(category, first, opts);
    const scope = category === 'PATIENT' ? (opts.patientKey ?? '') : '';
    for (const variant of rest) {
      const canon = canonicalize(category, variant);
      const key = this.indexKey(category, scope, canon);
      if (!this.index.has(key)) this.bind(category, key, token);
      this.upgradeRaw(token, variant, canon);
    }
    return token;
  }

  resolveToken(token: string): string | undefined {
    return this.entries.get(token)?.raw;
  }

  tokens(): string[] {
    return [...this.entries.keys()];
  }

  private indexKey(category: PhiCategory, scope: string, canon: string): string {
    return `${category}|${scope}|${canon}`;
  }

  private issue(category: PhiCategory, raw: string, canon: string): string {
    const n = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, n);
    const token = `[${category}_${n}]`;
    this.entries.set(token, {
      category,
      raw: raw.trim(),
      nameWords: NAME_CATEGORIES.has(category) ? canon.split(' ').length : 0,
    });
    return token;
  }

  private bind(category: PhiCategory, key: string, token: string): void {
    if (!this.index.has(key)) this.index.set(key, token);
    if (NAME_CATEGORIES.has(category)) this.addNameIndex(key, token);
  }

  private addNameIndex(key: string, token: string): void {
    const [category = '', scope = '', ...canon] = key.split('|');
    const bucket = `${category}|${scope}`;
    const list = this.nameIndex.get(bucket) ?? [];
    list.push({ words: new Set(canon.join('|').split(' ')), token });
    this.nameIndex.set(bucket, list);
  }

  /** Same person spelled with extra/missing middle names: >=2 shared words and one is a subset. */
  private findNameMatch(category: PhiCategory, scope: string, canon: string): string | undefined {
    if (!NAME_CATEGORIES.has(category)) return undefined;
    const words = canon.split(' ');
    if (words.length < 2) return undefined;
    for (const cand of this.nameIndex.get(`${category}|${scope}`) ?? []) {
      if (cand.words.size < 2) continue;
      const shared = words.filter((w) => cand.words.has(w)).length;
      if (shared >= 2 && (shared === words.length || shared === cand.words.size)) return cand.token;
    }
    return undefined;
  }

  private upgradeRaw(token: string, raw: string, canon: string): void {
    const entry = this.entries.get(token);
    if (!entry || !NAME_CATEGORIES.has(entry.category)) return;
    const words = canon.split(' ').length;
    if (words > entry.nameWords) this.entries.set(token, { ...entry, raw: raw.trim(), nameWords: words });
  }

  /* ------------------------------ date shifts ------------------------------ */

  /** Deterministic offset in [-365, -2] for a canonical patient id under this vault's HMAC key. */
  private computeShift(canonicalId: string): number {
    const digest = createHmac('sha256', this.keys.hmac).update(`DATE_SHIFT:${canonicalId}`).digest();
    return -((digest.readUInt32BE(0) % SHIFT_SPAN) + SHIFT_MIN_ABS);
  }

  assignDateShift(patientKey: string, canonicalId: string): number {
    const existing = this.shifts.get(patientKey);
    if (existing !== undefined) return existing;
    const days = this.computeShift(canonicalId);
    this.shifts.set(patientKey, days);
    return days;
  }

  dateShiftDaysFor(patientKey: string): number | undefined {
    return this.shifts.get(patientKey);
  }

  dateShifts(): ReadonlyMap<string, number> {
    return new Map(this.shifts);
  }

  /** Track the window of shifted calendar dates emitted for a patient (first 10 chars, YYYY-MM-DD). */
  recordShiftedDate(patientKey: string, isoDate: string): void {
    const day = isoDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const w = this.windows.get(patientKey);
    if (!w) this.windows.set(patientKey, { min: day, max: day });
    else this.windows.set(patientKey, { min: day < w.min ? day : w.min, max: day > w.max ? day : w.max });
  }

  shiftedDateWindow(patientKey: string): { min: string; max: string } | undefined {
    const w = this.windows.get(patientKey);
    return w ? { ...w } : undefined;
  }
}
