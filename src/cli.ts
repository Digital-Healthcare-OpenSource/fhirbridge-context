#!/usr/bin/env node
/**
 * fhirbridge CLI: pack | verify | audit | pull | mcp | rehydrate
 *
 * Compiled context goes to stdout (or -o); statistics and warnings go to stderr, so
 * `fhirbridge pack x.json | llm` stays clean.
 * Secrets are read from the environment, never from argv (argv is visible in `ps`):
 *   FHIRBRIDGE_VAULT_PASSPHRASE, FHIRBRIDGE_VAULT_KEY, FHIRBRIDGE_TOKEN
 */
import { readFile, writeFile } from 'node:fs/promises';
import { Command, InvalidArgumentError, Option } from 'commander';
import { auditInput, pack, VERSION, type PackResult } from './index.js';
import { SafeHarborVault } from './deid/index.js';
import { loadInput, normalize } from './normalizer/index.js';
import { pullPatient } from './portability/smart-client.js';
import type { ContextFormat, IntegrityWarning, LoadedInput } from './types/pipeline.js';
import { rehydrate, verify } from './verifier/index.js';

const FORMATS: ContextFormat[] = ['clinical-md', 'view-json', 'csv', 'fhir-slim'];

function err(line = ''): void {
  process.stderr.write(`${line}\n`);
}

function passphrase(): string | undefined {
  return process.env.FHIRBRIDGE_VAULT_PASSPHRASE || undefined;
}

async function openVault(path: string | undefined): Promise<SafeHarborVault | undefined> {
  return path ? SafeHarborVault.open(path, { passphrase: passphrase() }) : undefined;
}

async function emit(content: string, out?: string): Promise<void> {
  if (out) await writeFile(out, content, 'utf8');
  else process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
}

function printPackStats(result: PackResult, vaultPath?: string): void {
  const t = result.context.tokens;
  const codeWarnings = result.graph.warnings.filter((w) => w.code === 'CODE_DISPLAY_MISMATCH').length;
  err('┌ FHIRBridge pack');
  err(`│ Resources:        ${result.graph.resources.length}`);
  err(
    `│ Tokens (est.):    ${t.inputTokens.toLocaleString()} → ${t.outputTokens.toLocaleString()}  (−${t.reductionPct}%)`,
  );
  err(`│ Input cost saved: ~$${t.estimatedCostSavedUsd.toFixed(4)} per call`);
  err(`│ Excluded:         ${result.graph.excluded.length} entered-in-error / refuted`);
  err(`│ Code warnings:    ${codeWarnings}`);
  if (result.safeHarbor) {
    const s = result.safeHarbor;
    const replaced = Object.values(s.replacements).reduce<number>((a, n) => a + (n ?? 0), 0);
    err(`│ Safe Harbor:      ENABLED — ${replaced} identifiers tokenized, ${s.datesShifted} dates shifted`);
    err(
      `│                   ZIP3 restricted ${s.zip3Restricted}, generalized ${s.zip3Generalized}; ages capped ${s.agesCapped}`,
    );
    err(`│ Vault:            ${vaultPath ?? 'in-memory (not saved: rehydration will not be possible)'}`);
  } else {
    err('│ Safe Harbor:      DISABLED (add --deid before sending to an external LLM)');
  }
  err('└');
}

function parseFormat(value: string): ContextFormat {
  if (!FORMATS.includes(value as ContextFormat)) {
    throw new InvalidArgumentError(`Expected one of: ${FORMATS.join(', ')}`);
  }
  return value as ContextFormat;
}

function formatOption(): Option {
  return new Option('-f, --format <format>', `output format (${FORMATS.join(' | ')})`)
    .argParser(parseFormat)
    .default('clinical-md');
}

interface PackCliOptions {
  deid?: boolean;
  vault?: string;
  format: ContextFormat;
  output?: string;
  patient?: string;
}

async function packAndEmit(loaded: LoadedInput, opts: PackCliOptions): Promise<void> {
  const vault = opts.deid ? await openVault(opts.vault) : undefined;
  const result = pack(loaded, { deid: opts.deid, vault, format: opts.format, patientKey: opts.patient });
  if (opts.deid && opts.vault && result.vault) await result.vault.save(opts.vault);
  await emit(result.context.content, opts.output);
  printPackStats(result, opts.deid ? opts.vault : undefined);
}

function warningLine(w: IntegrityWarning): string {
  return `  ${w.code.padEnd(28)} ${w.resourceKey}  ${w.message}`;
}

async function runVerify(
  file: string,
  opts: { bundle: string; vault?: string; rehydrate?: boolean; json?: boolean },
): Promise<void> {
  const text = await readFile(file, 'utf8');
  const loaded = await loadInput(opts.bundle);
  const graph = normalize(loaded.entries, { rawText: loaded.rawText, inputBytes: loaded.bytes });
  const vault = opts.rehydrate ? await openVault(opts.vault) : undefined;
  if (opts.rehydrate && !vault) throw new Error('--rehydrate requires --vault');
  const { report, rehydrated } = verify(text, graph, vault);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ report, rehydrated }, null, 2)}\n`);
  } else {
    if (rehydrated !== undefined) process.stdout.write(`${rehydrated}\n`);
    err(`Citations checked: ${report.citations.length}; issues: ${report.issues.length}`);
    for (const i of report.issues) err(`  [${i.severity.toUpperCase()}] ${i.code} ${i.citation}: ${i.message}`);
    err(report.ok ? '✔ No critical clinical contradictions.' : '✖ Critical issues found.');
  }
  process.exitCode = report.ok ? 0 : 1;
}

async function runAudit(input: string, opts: { json?: boolean }): Promise<void> {
  const summary = auditInput(await loadInput(input));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const counts = Object.entries(summary.resourceCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `  ${type.padEnd(24)} ${n}`);
  const t = summary.tokens;
  process.stdout.write(
    [
      'Resources:',
      ...counts,
      `Tokens (est.):      ${t.input.toLocaleString()} → ${t.compiled.toLocaleString()} (−${t.reductionPct}%)`,
      `PHI identifiers:    ${summary.phiDetected} ${JSON.stringify(summary.phiByCategory)}`,
      `Dates to shift:     ${summary.datesShifted}`,
      `Entered-in-error:   ${summary.enteredInError}`,
      `Code conflicts:     ${summary.codeWarnings}`,
      'Warnings:',
      ...summary.warnings.map(warningLine),
      '',
    ].join('\n'),
  );
}

function addPackCommands(program: Command): void {
  program
    .command('pack')
    .argument('<input>', 'FHIR Bundle (.json), resource array, .ndjson file, or Bulk $export directory')
    .option('--deid', 'apply HIPAA Safe Harbor de-identification')
    .option('--vault <path>', 'encrypted vault for reversible tokens/date shifts (created if missing)')
    .option('--patient <key>', 'only compile this patient (Patient/id)')
    .addOption(formatOption())
    .option('-o, --output <path>', 'write context to a file instead of stdout')
    .description('compile a FHIR export into compact clinical context')
    .action(async (input: string, opts: PackCliOptions) => packAndEmit(await loadInput(input), opts));

  program
    .command('pull')
    .requiredOption('--iss <url>', 'FHIR R4 base URL (SMART iss)')
    .requiredOption('--patient <id>', 'patient id')
    .option('--token <token>', 'bearer token (prefer the FHIRBRIDGE_TOKEN env var)')
    .option('--deid', 'apply HIPAA Safe Harbor de-identification')
    .option('--vault <path>', 'encrypted vault file')
    .option('--max-pages <n>', 'pagination limit', (v) => Number.parseInt(v, 10), 200)
    .addOption(formatOption())
    .option('-o, --output <path>', 'write context to a file instead of stdout')
    .description('pull Patient/$everything (or the patient compartment) and pack it')
    .action(async (opts: PackCliOptions & { iss: string; patient: string; token?: string; maxPages: number }) => {
      const pulled = await pullPatient({
        iss: opts.iss,
        patientId: opts.patient,
        token: opts.token ?? process.env.FHIRBRIDGE_TOKEN,
        maxPages: opts.maxPages,
      });
      err(`Pulled ${pulled.entries.length} resources via ${pulled.method} (${pulled.pages} page(s)).`);
      await packAndEmit(pulled, { ...opts, patient: undefined });
    });
}

function addAuditCommands(program: Command): void {
  program
    .command('verify')
    .argument('<llm-response-file>', 'text produced by the LLM')
    .requiredOption('--bundle <path>', 'the original FHIR input the context was compiled from')
    .option('--vault <path>', 'vault used during pack (needed for --rehydrate)')
    .option('--rehydrate', 'restore real names, identifiers and dates in the output')
    .option('--json', 'print the audit report as JSON')
    .description('audit [ResourceType/id] citations; exit code 1 on critical findings')
    .action(runVerify);

  program
    .command('audit')
    .argument('<input>', 'FHIR Bundle, resource array, .ndjson file, or Bulk $export directory')
    .option('--json', 'print JSON')
    .description('report resource counts, token savings, PHI found, and EHR data-integrity problems')
    .action(runAudit);

  program
    .command('rehydrate')
    .argument('<file>', 'LLM output containing tokens like [PATIENT_1] and shifted dates')
    .requiredOption('--vault <path>', 'vault used during pack')
    .option('--patient <key>', 'Patient/id whose date shift to reverse (default: the only patient)')
    .description('restore real identifiers and dates in LLM output')
    .action(async (file: string, opts: { vault: string; patient?: string }) => {
      const vault = await openVault(opts.vault);
      if (!vault) throw new Error('--vault is required');
      const text = await readFile(file, 'utf8');
      process.stdout.write(`${rehydrate(text, vault, { patientKey: opts.patient })}\n`);
    });

  program
    .command('mcp')
    .requiredOption('--bundle <path>', 'FHIR input to serve (de-identified)')
    .option('--vault <path>', 'encrypted vault file (keeps tokens stable across restarts)')
    .option('--allow-rehydrate', 'let verify_and_rehydrate_clinical_draft return real PHI (local models only)')
    .description('start a privacy-by-design MCP server on stdio')
    .action(async (opts: { bundle: string; vault?: string; allowRehydrate?: boolean }) => {
      // Loaded lazily: the MCP SDK is the heaviest dependency and only this command needs it.
      const { runMcpServer } = await import('./mcp/server.js');
      await runMcpServer({
        bundlePath: opts.bundle,
        vaultPath: opts.vault,
        passphrase: passphrase(),
        allowRehydrate: opts.allowRehydrate === true,
      });
    });
}

export function buildProgram(): Command {
  const program = new Command('fhirbridge')
    .version(VERSION)
    .description('Normalize messy FHIR R4 exports, de-identify them reversibly, and compile verified LLM context.');
  addPackCommands(program);
  addAuditCommands(program);
  return program;
}

try {
  await buildProgram().parseAsync(process.argv);
} catch (e) {
  err(`fhirbridge: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
