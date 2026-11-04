/**
 * SafeHarborVault: reversible pseudonym store.
 *
 * Holds Token <-> raw value mappings, per-patient date shifts, the exact shifted dates that
 * were emitted, and pseudonymized resource ids, encrypted at rest with AES-256-GCM. Two
 * independent subkeys are derived from one 32-byte master key via HKDF-SHA256: `enc` (file
 * encryption) and `hmac` (date-shift and id derivation). They are never interchanged.
 *
 * PRIVACY: raw values leave this class only through `resolveToken` / `originalResourceKey`.
 * Nothing here logs.
 *
 * Key resolution for `open()` (first match wins):
 *   1. opts.masterKey
 *   2. opts.passphrase (scrypt, random salt stored in the vault file; min 12 chars)
 *   3. env FHIRBRIDGE_VAULT_KEY (64 hex chars) / FHIRBRIDGE_VAULT_PASSPHRASE
 *   4. an EXISTING `<path>.key` file, or a new one when `opts.allowKeyFile` is true. A key file
 *      beside the vault defeats encryption at rest if both are stolen: opt in knowingly.
 *
 * Concurrency: `save()` takes `<path>.lock` and refuses to overwrite a file that another writer
 * changed since this vault was opened (no silent lost updates).
 */
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { FhirBridgeError } from '../errors.js';
import type { PhiCategory, VaultReader } from '../types/pipeline.js';
import type { WrappedKey } from './key-wrap.js';
import {
  assertKeyLength,
  atomicWrite,
  decryptVault,
  deriveVaultSubkeys,
  encryptVault,
  newMasterKey,
  parseVaultFile,
  readIfExists,
  resolveKey,
  withFileLock,
  type Kdf,
  type VaultFile,
  type VaultOpenOptions,
  type VaultSubkeys,
  type VaultVersion,
} from './vault-crypto.js';
import { NAME_CATEGORIES, canonicalize, canonicalName } from './vault-names.js';

export { VAULT_KEY_ENV, VAULT_PASSPHRASE_ENV, deriveVaultSubkeys } from './vault-crypto.js';
export type { VaultOpenOptions, VaultSubkeys } from './vault-crypto.js';
export { canonicalName } from './vault-names.js';

const SHIFT_SPAN = 364;
const SHIFT_MIN_ABS = 2;
const ID_HASH_CHARS = 10;

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
  emitted?: [string, string[]][];
  ids?: [string, string][];
  bindings?: [string, string][];
}

export class SafeHarborVault implements VaultReader {
  private readonly keys: VaultSubkeys;
  private readonly counters = new Map<string, number>();
  private readonly entries = new Map<string, TokenEntry>();
  private readonly index = new Map<string, string>();
  private readonly shifts = new Map<string, number>();
  private readonly windows = new Map<string, { min: string; max: string }>();
  private readonly emitted = new Map<string, Set<string>>();
  private readonly ids = new Map<string, string>();
  /** patientKey -> shift key of its most recent canonical binding. */
  private readonly bindings = new Map<string, string>();
  private filePath?: string;
  private kdf: Kdf = 'raw';
  private salt?: Buffer;
  private version: VaultVersion = 2;
  /** v3 passphrase vaults: the wrapped master key written into the header. */
  private wrappedKey?: WrappedKey;
  /** Path + GCM tag of the file state this vault was loaded from / last saved as. */
  private baseline?: { file: string; tag: string | undefined };

  private constructor(masterKey: Buffer) {
    this.keys = deriveVaultSubkeys(masterKey);
  }

  /** Subkeys (exposed so tests can assert they are distinct; treat as secret). */
  get subkeys(): VaultSubkeys {
    return this.keys;
  }

  static create(opts: { masterKey?: Buffer } = {}): SafeHarborVault {
    return new SafeHarborVault(assertKeyLength(opts.masterKey ?? newMasterKey()));
  }

  static async open(file: string, opts: VaultOpenOptions = {}): Promise<SafeHarborVault> {
    const text = await readIfExists(file);
    const existing = text === undefined ? undefined : parseVaultFile(text);
    const resolved = await resolveKey(file, existing, opts);
    const vault = new SafeHarborVault(resolved.masterKey);
    vault.filePath = file;
    vault.kdf = resolved.kdf;
    vault.salt = resolved.salt;
    vault.version = resolved.version;
    vault.wrappedKey = resolved.wrappedKey;
    vault.baseline = { file: path.resolve(file), tag: existing?.tag };
    if (existing) vault.load(existing);
    return vault;
  }

  /* ------------------------------ persistence ------------------------------ */

  async save(file?: string): Promise<void> {
    const target = file ?? this.filePath;
    if (!target) throw new FhirBridgeError('USAGE', 'Vault has no path: pass one to save().');
    const resolved = path.resolve(target);
    await withFileLock(target, async () => {
      const current = await readIfExists(target);
      if (current !== undefined) {
        const onDisk = parseVaultFile(current);
        const known = this.baseline?.file === resolved ? this.baseline.tag : undefined;
        if (known === undefined || onDisk.tag !== known) {
          throw new FhirBridgeError(
            'VAULT_CONFLICT',
            'Vault changed concurrently: another process saved it since it was opened.',
            { hint: 'Rerun the command.' },
          );
        }
      }
      const out = encryptVault(this.keys.enc, JSON.stringify(this.toState()), {
        version: this.version,
        kdf: this.kdf,
        salt: this.salt,
        wrappedKey: this.wrappedKey,
      });
      await atomicWrite(target, JSON.stringify(out, null, 2), 0o600);
      this.baseline = { file: resolved, tag: out.tag };
    });
    this.filePath ??= target;
  }

  private load(file: VaultFile): void {
    this.fromState(JSON.parse(decryptVault(this.keys.enc, file)) as VaultState);
  }

  private toState(): VaultState {
    return {
      counters: Object.fromEntries(this.counters),
      tokens: [...this.entries],
      index: [...this.index],
      dateShifts: [...this.shifts],
      windows: [...this.windows],
      emitted: [...this.emitted].map(([k, v]) => [k, [...v].sort()]),
      ids: [...this.ids],
      bindings: [...this.bindings],
    };
  }

  private fromState(state: VaultState): void {
    for (const [k, v] of Object.entries(state.counters)) this.counters.set(k, v);
    for (const [token, entry] of state.tokens) this.entries.set(token, entry);
    for (const [key, token] of state.index) this.index.set(key, token);
    for (const [k, v] of state.dateShifts) this.shifts.set(k, v);
    for (const [k, v] of state.windows) this.windows.set(k, v);
    for (const [k, v] of state.emitted ?? []) this.emitted.set(k, new Set(v));
    for (const [k, v] of state.ids ?? []) this.ids.set(k, v);
    for (const [k, v] of state.bindings ?? []) this.bindings.set(k, v);
  }

  /* -------------------------------- tokens --------------------------------- */

  tokenFor(category: PhiCategory, raw: string, opts: { patientKey?: string; ambiguous?: boolean } = {}): string {
    const canon = canonicalize(category, raw);
    // Ambiguous bare names get their own token space so they never resolve to one person.
    const scope = opts.ambiguous ? 'ambiguous' : category === 'PATIENT' ? (opts.patientKey ?? '') : '';
    const key = this.indexKey(category, scope, canon);
    const found = this.index.get(key);
    if (found) {
      this.upgradeRaw(found, raw, canon);
      return found;
    }
    const token = this.issue(category, raw, canon);
    this.index.set(key, token);
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
      // A bare first/last name is shared by many people: never bind it to this token.
      if (!canon.includes(' ')) continue;
      const key = this.indexKey(category, scope, canon);
      if (!this.index.has(key)) this.index.set(key, token);
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

  /**
   * Shifts, emitted dates and windows are stored per (patientKey, canonical id): the same
   * `Patient/p1` arriving with a different canonical id is a different person and gets its own
   * offset and its own emitted-date record. The reader methods below take the plain `patientKey`
   * and resolve it to the MOST RECENT canonical binding made for that key in this vault.
   */
  private shiftKey(patientKey: string, canonicalId: string): string {
    const tag = createHmac('sha256', this.keys.hmac).update(`DATE_SHIFT_KEY:${canonicalId}`).digest('hex');
    return `${patientKey}#${tag.slice(0, ID_HASH_CHARS)}`;
  }

  /** Store key for a patient: the latest binding, else a pre-binding legacy entry keyed by itself. */
  private resolveShiftKey(patientKey: string): string | undefined {
    const bound = this.bindings.get(patientKey);
    if (bound !== undefined) return bound;
    return this.shifts.has(patientKey) ? patientKey : undefined;
  }

  assignDateShift(patientKey: string, canonicalId: string): number {
    const key = this.shiftKey(patientKey, canonicalId);
    let days = this.shifts.get(key);
    if (days === undefined) {
      days = this.computeShift(canonicalId);
      this.shifts.set(key, days);
      this.adoptLegacyEmitted(patientKey, key, days);
    }
    this.bindings.set(patientKey, key);
    return days;
  }

  /** A vault written before canonical binding keyed its record by the plain patient key. */
  private adoptLegacyEmitted(patientKey: string, key: string, days: number): void {
    if (this.shifts.get(patientKey) !== days) return;
    const dates = this.emitted.get(patientKey);
    if (dates) this.emitted.set(key, new Set(dates));
    const window = this.windows.get(patientKey);
    if (window) this.windows.set(key, { ...window });
  }

  dateShiftDaysFor(patientKey: string): number | undefined {
    const key = this.resolveShiftKey(patientKey);
    return key === undefined ? undefined : this.shifts.get(key);
  }

  dateShifts(): ReadonlyMap<string, number> {
    return new Map(this.patientKeys().map((k) => [k, this.dateShiftDaysFor(k) ?? 0]));
  }

  patientKeys(): string[] {
    const keys = new Set(this.bindings.keys());
    for (const k of this.shifts.keys()) if (!k.includes('#')) keys.add(k);
    return [...keys];
  }

  /** Record a SHIFTED date emitted for a patient (first 10 chars, YYYY-MM-DD). */
  recordShiftedDate(patientKey: string, isoDate: string): void {
    const day = isoDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const key = this.resolveShiftKey(patientKey) ?? patientKey;
    const set = this.emitted.get(key) ?? new Set<string>();
    set.add(day);
    this.emitted.set(key, set);
    const w = this.windows.get(key);
    if (!w) this.windows.set(key, { min: day, max: day });
    else this.windows.set(key, { min: day < w.min ? day : w.min, max: day > w.max ? day : w.max });
  }

  shiftedDateWindow(patientKey: string): { min: string; max: string } | undefined {
    const w = this.windows.get(this.resolveShiftKey(patientKey) ?? patientKey);
    return w ? { ...w } : undefined;
  }

  emittedShiftedDates(patientKey: string): ReadonlySet<string> {
    return new Set(this.emitted.get(this.resolveShiftKey(patientKey) ?? patientKey) ?? []);
  }

  /* ------------------------------ resource ids ------------------------------ */

  /** Stable pseudonymous id for an identifying `Type/id`; the mapping is kept for rehydration. */
  pseudonymizeResourceId(resourceType: string, id: string): string {
    const digest = createHmac('sha256', this.keys.hmac)
      .update(`RESOURCE_ID:${resourceType}/${id}`)
      .digest('hex')
      .slice(0, ID_HASH_CHARS);
    const pseudonym = `${resourceType.toLowerCase()}-${digest}`;
    this.ids.set(`${resourceType}/${pseudonym}`, `${resourceType}/${id}`);
    return pseudonym;
  }

  originalResourceKey(deidKey: string): string | undefined {
    return this.ids.get(deidKey);
  }
}
