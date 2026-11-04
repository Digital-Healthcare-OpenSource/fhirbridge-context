#!/usr/bin/env node
/**
 * Reproducible benchmark on the synthetic fixture (run `npm run build` first).
 * Prints a Markdown table; every number in the README comes from this script.
 *
 *   node scripts/benchmark.mjs [path-to-fhir-input]
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { auditInput, loadInput, pack, SafeHarborVault } from '../dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(process.argv[2] ?? resolve(root, 'tests/fixtures/synthea-messy-patient.json'));

/** Raw identifiers planted in the synthetic fixture; none may survive de-identification. */
const PLANTED_PHI = [
  'Gonzalez',
  'Maria',
  'Elena',
  '4471902',
  '123-45-6789',
  '555-0142',
  'maria.gonzalez@example.com',
  'Brattle',
  'Cambridge',
  '02138',
  '1962-03-14',
  'Sarah Kim',
  '1932456789',
];
const PROTECTED_TERMS = ['2/12 cores', 'Foley', "Parkinson's", '5/5', 'Metformin', 'Lisinopril'];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const loaded = await loadInput(input);
const runs = [];
let result;
for (let i = 0; i < 15; i++) {
  const t0 = performance.now();
  result = pack(loaded, { deid: true, vault: SafeHarborVault.create() });
  runs.push(performance.now() - t0);
}

const out = result.context.content;
const leaked = PLANTED_PHI.filter((v) => out.includes(v));
// The per-patient date offset must never reach the context: with it, shifted dates are reversible.
const offsets = [...result.vault.dateShifts().values()].map((days) => Math.abs(days));
const offsetLeaks = [
  ...(/DateShift/i.test(out) ? ['DateShift'] : []),
  ...offsets.filter((n) => new RegExp(`(?<![\\d.-])-?${n}\\s*d\\b`).test(out)).map((n) => `${n}d`),
];
const kept = PROTECTED_TERMS.filter((v) => out.includes(v));
const audit = auditInput(loaded);

const cliStart = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  execFileSync(process.execPath, [resolve(root, 'dist/cli.js'), '--version']);
  cliStart.push(performance.now() - t0);
}

const pkg = JSON.parse(execSync('npm pack --dry-run --json', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString())[0];
const raw = await readFile(input, 'utf8');
const t = result.context.tokens;
const phiBreakdown = Object.entries(audit.phiByCategory)
  .map(([k, v]) => `${k} ${v}`)
  .join(', ');

const rows = [
  ['Input', `${(Buffer.byteLength(raw) / 1024).toFixed(1)} KB, ${result.graph.resources.length} resources`],
  [
    'Tokens before → after (est., 4 bytes/token)',
    `${t.inputTokens.toLocaleString('en-US')} → ${t.outputTokens.toLocaleString('en-US')}`,
  ],
  ['Token reduction', `${t.reductionPct}%`],
  ['Pack time: normalize + de-identify + compile (median of 15)', `${median(runs).toFixed(1)} ms`],
  ['CLI cold start, `fhirbridge --version` (median of 5)', `${median(cliStart).toFixed(0)} ms`],
  [
    'npm package (unpacked / tarball)',
    `${(pkg.unpackedSize / 1024).toFixed(0)} KB / ${(pkg.size / 1024).toFixed(0)} KB`,
  ],
  ['Identifiers tokenized', `${audit.phiDetected} (${phiBreakdown})`],
  ['Dates shifted', `${audit.datesShifted}`],
  [
    'Planted PHI strings leaked into context',
    `${leaked.length} / ${PLANTED_PHI.length}${leaked.length ? ` (${leaked.join(', ')})` : ''}`,
  ],
  ['Date-shift offset leaked into context (DateShift label or offset value)', `${offsetLeaks.length}${offsetLeaks.length ? ` (${offsetLeaks.join(', ')})` : ''}`],
  ['Clinical terms preserved', `${kept.length} / ${PROTECTED_TERMS.length}`],
  ['entered-in-error excluded / code conflicts flagged', `${audit.enteredInError} / ${audit.codeWarnings}`],
];

process.stdout.write(`| Metric | Value |\n| :--- | :--- |\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n`);
process.stdout.write(`\nNode ${process.version}, ${process.platform}/${process.arch}\n`);
if (leaked.length > 0 || offsetLeaks.length > 0) process.exitCode = 1;
