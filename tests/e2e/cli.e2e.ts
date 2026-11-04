/**
 * The built CLI as a user runs it: exit codes, stdout/stderr separation, PHI-free errors.
 * Requires `npm run build`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'dist/cli.js');
const FIXTURE = join(ROOT, 'tests/fixtures/synthea-messy-patient.json');
const PASSPHRASE = 'e2e-only passphrase, not a secret';
const PLANTED_PHI = ['Gonzalez', '4471902', '123-45-6789', '555-0142', 'maria.gonzalez@example.com', '1962-03-14'];

let dir: string;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}, input?: string): Run {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FHIRBRIDGE_')));
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...clean, ...env },
    input,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('dist/cli.js missing: run `npm run build` before the e2e tests');
  dir = await mkdtemp(join(tmpdir(), 'fhirbridge-e2e-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fhirbridge CLI (built)', () => {
  it('prints version and help with exit 0', () => {
    expect(run(['--version'])).toMatchObject({ code: 0 });
    expect(run(['--version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const help = run(['--help']);
    expect(help.code).toBe(0);
    for (const cmd of ['pack', 'verify', 'audit', 'pull', 'mcp', 'rehydrate', 'doctor']) expect(help.stdout).toContain(cmd);
  });

  it('exits 64 on unknown commands and invalid options', () => {
    expect(run(['frobnicate']).code).toBe(64);
    expect(run(['pack', FIXTURE, '--format', 'xml']).code).toBe(64);
    expect(run(['--log-format', 'yaml', 'doctor']).code).toBe(64);
  });

  it('pack de-identifies by default, keeps stdout clean, and puts stats on stderr', () => {
    const res = run(['pack', FIXTURE]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^# CLINICAL SUMMARY CONTEXT \(FHIRBridge v[\d.]+ \| De-identified: YES\)/);
    expect(res.stdout).not.toContain('┌');
    expect(res.stderr).toContain('FHIRBridge pack');
    for (const phi of PLANTED_PHI) expect(res.stdout).not.toContain(phi);
    expect(res.stdout).not.toMatch(/DateShift/i);
  });

  it('--no-deid warns on stderr before any output', () => {
    const res = run(['pack', FIXTURE, '--no-deid']);
    expect(res.code).toBe(0);
    expect(res.stderr.split('\n')[0]).toMatch(/WARNING: de-identification is OFF/);
    expect(res.stdout).toContain('De-identified: NO');
  });

  it('emits one PHI-free JSON event per line with --log-format json', () => {
    const res = run(['--log-format', 'json', 'pack', FIXTURE]);
    expect(res.code).toBe(0);
    const events = res.stderr
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = events.find((e) => e.event === 'pack.done');
    expect(done).toMatchObject({ level: 'info', deidentified: true });
    expect(done?.tokensIn).toBeGreaterThan(done?.tokensOut as number);
    for (const phi of PLANTED_PHI) expect(res.stderr).not.toContain(phi);
  });

  it('maps input errors to sysexits codes without echoing input content', async () => {
    expect(run(['pack', join(dir, 'missing.json')]).code).toBe(66);

    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{"resourceType":"Patient","name":"Zebulon Quartzfield SSN 078-05-1120" ,,, }\n{also broken');
    const res = run(['pack', broken]);
    expect(res.code).toBe(65);
    expect(res.stderr).not.toContain('Zebulon');
    expect(res.stderr).not.toContain('078-05-1120');
    const debug = run(['--debug', 'pack', broken]);
    expect(debug.code).toBe(65);
  });

  it('honours FHIRBRIDGE_MAX_INPUT_MB and rejects invalid configuration', async () => {
    const big = join(dir, 'big.ndjson');
    const line = JSON.stringify({ resourceType: 'Observation', id: 'x', status: 'final', pad: 'p'.repeat(1000) });
    await writeFile(big, Array.from({ length: 2200 }, (_, i) => line.replace('"x"', `"o${i}"`)).join('\n'));
    const tooBig = run(['pack', big], { FHIRBRIDGE_MAX_INPUT_MB: '1' });
    expect(tooBig.code).toBe(65);
    expect(tooBig.stderr).toMatch(/exceeds 1 MB/);
    expect(tooBig.stderr).toMatch(/hint: Raise FHIRBRIDGE_MAX_INPUT_MB/);

    const badCfg = run(['pack', FIXTURE], { FHIRBRIDGE_MAX_INPUT_MB: 'lots' });
    expect(badCfg.code).toBe(78);
    expect(badCfg.stderr).toContain('FHIRBRIDGE_MAX_INPUT_MB');
  });

  it('verify exits 1 on a status contradiction and 0 on a faithful answer', async () => {
    const bad = join(dir, 'bad-answer.txt');
    await writeFile(bad, 'Patient is currently taking Lisinopril 10 mg daily [MedicationRequest/medreq-088].');
    expect(run(['verify', bad, '--bundle', FIXTURE]).code).toBe(1);

    const good = join(dir, 'good-answer.txt');
    await writeFile(good, 'Lisinopril was stopped because of a dry cough [MedicationRequest/medreq-088].');
    expect(run(['verify', good, '--bundle', FIXTURE]).code).toBe(0);
  });

  it('round-trips through a passphrase vault and refuses a wrong passphrase', async () => {
    const vault = join(dir, 'p.vault.json');
    const packed = run(['pack', FIXTURE, '--vault', vault, '-o', join(dir, 'ctx.md')], {
      FHIRBRIDGE_VAULT_PASSPHRASE: PASSPHRASE,
    });
    expect(packed.code).toBe(0);
    const answer = join(dir, 'answer.txt');
    await writeFile(answer, 'Summary for [PATIENT_1].');
    const restored = run(['rehydrate', answer, '--vault', vault], { FHIRBRIDGE_VAULT_PASSPHRASE: PASSPHRASE });
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain('Gonzalez');

    const wrong = run(['rehydrate', answer, '--vault', vault], {
      FHIRBRIDGE_VAULT_PASSPHRASE: 'a different long passphrase',
    });
    expect(wrong.code).toBe(77);
    expect(wrong.stdout).toBe('');
  });

  it('refuses to create a vault without a key unless --allow-key-file', () => {
    const res = run(['pack', FIXTURE, '--vault', join(dir, 'nokey.vault.json')]);
    expect(res.code).toBe(78);
    expect(res.stderr).toMatch(/FHIRBRIDGE_VAULT_PASSPHRASE/);
  });

  it('doctor passes with a valid setup and fails (78) on a malformed key', () => {
    const ok = run(['doctor'], { FHIRBRIDGE_VAULT_PASSPHRASE: PASSPHRASE });
    expect(ok.code).toBe(0);
    expect(ok.stderr).not.toContain(PASSPHRASE);
    const bad = run(['doctor'], { FHIRBRIDGE_VAULT_KEY: 'zz' });
    expect(bad.code).toBe(78);
  });

  it('validates --free-text and accepts omit (structured-only)', () => {
    const bogus = run(['pack', FIXTURE, '--free-text', 'keep']);
    expect(bogus.code).toBe(64);
    expect(bogus.stderr).toMatch(/scrub, omit/);
    const omit = run(['pack', FIXTURE, '--free-text', 'omit']);
    expect(omit.code).toBe(0);
    for (const phi of PLANTED_PHI) expect(omit.stdout).not.toContain(phi);
    expect(run(['mcp', '--help']).stdout).toContain('--free-text');
    expect(run(['pull', '--help']).stdout).toContain('--free-text');
  });

  it('validates pull --max-pages as an integer from 1 to 10000', () => {
    for (const bad of ['0', '-3', 'abc', '2.5', '10001']) {
      const res = run(['pull', '--iss', 'https://fhir.example.org/r4', '--patient', 'p1', '--max-pages', bad]);
      expect(res.code, bad).toBe(64);
    }
  });

  it('refuses a private-network --iss without echoing the URL (exit 69)', () => {
    const res = run(['pull', '--iss', 'https://10.9.8.7/secret-path', '--patient', 'p1']);
    expect(res.code).toBe(69);
    expect(res.stderr).toMatch(/--allow-private-network/);
    expect(res.stderr).not.toMatch(/10\.9\.8\.7|secret-path/);
    expect(run(['pull', '--help']).stdout).toContain('--allow-private-network');
  });

  it('pack --patient rejects unknown patients (65) and rehydrate needs --patient for multi-patient vaults (64)', async () => {
    const unknown = run(['pack', FIXTURE, '--patient', 'Patient/does-not-exist']);
    expect(unknown.code).toBe(65);
    expect(unknown.stderr).toContain('No such patient in the input');

    const two = join(dir, 'two-patients.ndjson');
    const patient = (id: string) => JSON.stringify({ resourceType: 'Patient', id, name: [{ family: 'Doe', given: ['Jane'] }], birthDate: '1980-02-03' });
    await writeFile(two, `${patient('a1')}\n${patient('b2')}\n`);
    const vault = join(dir, 'two.vault.json');
    const env = { FHIRBRIDGE_VAULT_PASSPHRASE: PASSPHRASE };
    expect(run(['pack', two, '--vault', vault, '-o', join(dir, 'two.md')], env).code).toBe(0);
    const answer = join(dir, 'two-answer.txt');
    await writeFile(answer, 'Summary for [PATIENT_1] on 2026-01-15.');
    const res = run(['rehydrate', answer, '--vault', vault], env);
    expect(res.code).toBe(64);
    expect(res.stderr).toContain('Vault holds 2 patients; pass --patient Patient/id.');
    expect(run(['rehydrate', answer, '--vault', vault, '--patient', 'Patient/a1'], env).code).toBe(0);
  });
});
