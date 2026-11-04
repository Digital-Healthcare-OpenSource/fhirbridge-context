/** `fhirbridge doctor` must diagnose without ever printing secret values. */
import { describe, expect, it } from 'vitest';
import { checkConfig, checkCrypto, checkNodeVersion, checkVaultKey, runDoctor } from '../src/doctor.js';

const HEX_KEY = 'ab'.repeat(32);

describe('doctor', () => {
  it('checks the Node version boundary', () => {
    expect(checkNodeVersion('22.12.0').ok).toBe(true);
    expect(checkNodeVersion('24.0.1').ok).toBe(true);
    expect(checkNodeVersion('22.11.9').ok).toBe(false);
    expect(checkNodeVersion('20.19.0').ok).toBe(false);
  });

  it('validates the vault key shape without echoing it', () => {
    const good = checkVaultKey({ FHIRBRIDGE_VAULT_KEY: HEX_KEY });
    expect(good.ok).toBe(true);
    expect(good.detail).not.toContain(HEX_KEY);

    const bad = checkVaultKey({ FHIRBRIDGE_VAULT_KEY: 'not-a-key-secret-value' });
    expect(bad.ok).toBe(false);
    expect(bad.detail).not.toContain('secret-value');

    const shortPass = checkVaultKey({ FHIRBRIDGE_VAULT_PASSPHRASE: 'hunter2' });
    expect(shortPass.ok).toBe(false);
    expect(shortPass.detail).not.toContain('hunter2');

    const longPass = checkVaultKey({ FHIRBRIDGE_VAULT_PASSPHRASE: 'correct horse battery staple' });
    expect(longPass.ok).toBe(true);
    expect(longPass.detail).not.toContain('horse');

    expect(checkVaultKey({}).ok).toBe(true);
  });

  it('reports invalid configuration by variable name', () => {
    const cfg = checkConfig({ FHIRBRIDGE_MAX_RESOURCES: 'many' });
    expect(cfg.ok).toBe(false);
    expect(cfg.detail).toContain('FHIRBRIDGE_MAX_RESOURCES');
    expect(checkConfig({}).ok).toBe(true);
  });

  it('confirms the crypto primitives the vault relies on', () => {
    expect(checkCrypto().ok).toBe(true);
  });

  it('aggregates every check', async () => {
    const report = await runDoctor({ FHIRBRIDGE_VAULT_PASSPHRASE: 'correct horse battery staple' });
    expect(report.checks.map((c) => c.name)).toEqual(['Node.js', 'Configuration', 'Vault key', 'Crypto', 'MCP SDK']);
    expect(report.ok).toBe(true);
    const failing = await runDoctor({ FHIRBRIDGE_VAULT_KEY: 'zz' });
    expect(failing.ok).toBe(false);
  });
});
