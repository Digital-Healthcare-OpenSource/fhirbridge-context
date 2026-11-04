/**
 * `fhirbridge doctor` — environment self-check. Reports presence and shape of secrets,
 * never their values.
 */
import { createCipheriv, getCiphers, randomBytes, scryptSync } from 'node:crypto';
import { loadRuntimeConfig } from './config.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

type Env = Readonly<Record<string, string | undefined>>;

const MIN_NODE: readonly [number, number] = [22, 12];
const MIN_PASSPHRASE = 12;

export function checkNodeVersion(version: string = process.versions.node): DoctorCheck {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return { name: 'Node.js', ok, detail: `${version} (requires >= ${MIN_NODE.join('.')})` };
}

export function checkConfig(env: Env = process.env): DoctorCheck {
  try {
    const cfg = loadRuntimeConfig(env);
    const mb = Math.round(cfg.limits.maxInputBytes / (1024 * 1024));
    return {
      name: 'Configuration',
      ok: true,
      detail: `max input ${mb} MB, max ${cfg.limits.maxResources} resources, logs ${cfg.logFormat}/${cfg.logLevel}`,
    };
  } catch (error) {
    return { name: 'Configuration', ok: false, detail: error instanceof Error ? error.message : 'invalid' };
  }
}

export function checkVaultKey(env: Env = process.env): DoctorCheck {
  const key = env.FHIRBRIDGE_VAULT_KEY;
  const passphrase = env.FHIRBRIDGE_VAULT_PASSPHRASE;
  if (key !== undefined && key !== '') {
    const ok = /^[0-9a-fA-F]{64}$/.test(key.trim());
    return {
      name: 'Vault key',
      ok,
      detail: ok
        ? 'FHIRBRIDGE_VAULT_KEY is set (256-bit hex)'
        : 'FHIRBRIDGE_VAULT_KEY must be exactly 64 hex characters',
    };
  }
  if (passphrase !== undefined && passphrase !== '') {
    const ok = passphrase.length >= MIN_PASSPHRASE;
    return {
      name: 'Vault key',
      ok,
      detail: ok
        ? 'FHIRBRIDGE_VAULT_PASSPHRASE is set (scrypt-derived key)'
        : `FHIRBRIDGE_VAULT_PASSPHRASE must be at least ${MIN_PASSPHRASE} characters`,
    };
  }
  return {
    name: 'Vault key',
    ok: true,
    detail: 'none set: `pack` uses an in-memory vault (no rehydration); `--vault` needs a key or --allow-key-file',
  };
}

export function checkCrypto(): DoctorCheck {
  try {
    const ok = getCiphers().includes('aes-256-gcm');
    const cipher = createCipheriv('aes-256-gcm', randomBytes(32), randomBytes(12));
    cipher.update('probe');
    cipher.final();
    scryptSync('probe-passphrase', randomBytes(16), 32, { N: 1 << 14 });
    return { name: 'Crypto', ok, detail: 'AES-256-GCM and scrypt available' };
  } catch (error) {
    return { name: 'Crypto', ok: false, detail: error instanceof Error ? error.message : 'unavailable' };
  }
}

export async function checkMcpSdk(): Promise<DoctorCheck> {
  try {
    await import('@modelcontextprotocol/sdk/server/mcp.js');
    return { name: 'MCP SDK', ok: true, detail: 'loadable' };
  } catch {
    return { name: 'MCP SDK', ok: false, detail: 'cannot load @modelcontextprotocol/sdk (reinstall dependencies)' };
  }
}

export async function runDoctor(env: Env = process.env): Promise<DoctorReport> {
  const checks = [checkNodeVersion(), checkConfig(env), checkVaultKey(env), checkCrypto(), await checkMcpSdk()];
  return { ok: checks.every((c) => c.ok), checks };
}
