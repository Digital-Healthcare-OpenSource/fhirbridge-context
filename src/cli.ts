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
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import {
  deidOption,
  formatOption,
  freeTextOption,
  MAX_PAGES_LIMIT,
  noDeidOption,
  parseMaxPages,
} from './cli-options.js';
import { loadRuntimeConfig, type LogFormat } from './config.js';
import { describeCauses, FhirBridgeError, toFhirBridgeError } from './errors.js';
import { auditInput, pack, VERSION, type PackResult } from './index.js';
import { createLogger, type Logger } from './logger.js';
import { SafeHarborVault, type FreeTextMode } from './deid/index.js';
import { runDoctor } from './doctor.js';
import { loadInput, normalize } from './normalizer/index.js';
import { pullPatient } from './portability/smart-client.js';
import type { ContextFormat, IntegrityWarning, LoadedInput } from './types/pipeline.js';
import { auditCitations, rehydrate } from './verifier/index.js';

const NO_DEID_WARNING = [
  '!! WARNING: de-identification is OFF (--no-deid).',
  '!! The output contains real patient identifiers and dates. Do NOT send it to an external LLM or share it.',
];
const VERIFY_VAULT_HINT =
  'If this context was de-identified, pass --vault so pseudonymized ids can be mapped back.';
const ALLOW_KEY_FILE_HELP =
  'allow a key file next to the vault when no FHIRBRIDGE_VAULT_PASSPHRASE / FHIRBRIDGE_VAULT_KEY is set (weaker: the key sits beside the data)';

function err(line = ''): void {
  process.stderr.write(`${line}\n`);
}

/** Process-wide logger, configured from env and the global --log-format / --verbose / --quiet flags. */
let log: Logger = createLogger({ level: 'silent' });
let logFormat: LogFormat = 'text';

interface GlobalOptions {
  debug?: boolean;
  logFormat?: LogFormat;
  verbose?: boolean;
  quiet?: boolean;
}

function configureLogging(opts: GlobalOptions): void {
  const cfg = loadRuntimeConfig();
  logFormat = opts.logFormat ?? cfg.logFormat;
  const level = opts.quiet ? 'error' : opts.verbose || opts.debug ? 'debug' : cfg.logLevel;
  log = createLogger({ format: logFormat, level });
}

function passphrase(): string | undefined {
  return process.env.FHIRBRIDGE_VAULT_PASSPHRASE || undefined;
}

async function openVault(
  path: string | undefined,
  allowKeyFile: boolean | undefined,
): Promise<SafeHarborVault | undefined> {
  return path
    ? SafeHarborVault.open(path, { passphrase: passphrase(), allowKeyFile: allowKeyFile === true })
    : undefined;
}

async function emit(content: string, out?: string): Promise<void> {
  if (out) await writeFile(out, content, 'utf8');
  else process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
}

function printPackStats(result: PackResult, vaultPath: string | undefined, ms: number): void {
  const t = result.context.tokens;
  const codeWarnings = result.graph.warnings.filter((w) => w.code === 'CODE_DISPLAY_MISMATCH').length;
  // JSON logs carry the stats; in text mode the box below is the human view (event only with -v).
  (logFormat === 'json' ? log.info : log.debug)('pack.done', {
    resources: result.graph.resources.length,
    tokensIn: t.inputTokens,
    tokensOut: t.outputTokens,
    reductionPct: t.reductionPct,
    excluded: result.graph.excluded.length,
    codeWarnings,
    deidentified: result.safeHarbor !== undefined,
    identifiers: result.safeHarbor
      ? Object.values(result.safeHarbor.replacements).reduce<number>((a, n) => a + (n ?? 0), 0)
      : 0,
    datesShifted: result.safeHarbor?.datesShifted ?? 0,
    vaultPersisted: vaultPath !== undefined,
    ms,
  });
  if (logFormat === 'json') return;
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
    err(`│ De-identified:    YES — ${replaced} identifiers tokenized, ${s.datesShifted} dates shifted`);
    err(
      `│                   ZIP3 restricted ${s.zip3Restricted}, generalized ${s.zip3Generalized}; ages capped ${s.agesCapped}`,
    );
    err(`│ Vault:            ${vaultPath ?? 'in-memory (not saved: rehydration will not be possible)'}`);
  } else {
    err('│ De-identified:    NO (--no-deid): output holds real identifiers; do not send it to an external LLM');
  }
  err('└');
}

interface PackCliOptions {
  /** `--no-deid` sets this to false; anything else means de-identify (the default). */
  deid?: boolean;
  freeText?: FreeTextMode;
  vault?: string;
  allowKeyFile?: boolean;
  format: ContextFormat;
  output?: string;
  patient?: string;
}

async function packAndEmit(loaded: LoadedInput, opts: PackCliOptions): Promise<void> {
  const deid = opts.deid !== false;
  if (!deid) {
    // Before anything is written, so it cannot scroll past unnoticed.
    for (const line of NO_DEID_WARNING) err(line);
    if (opts.vault) err('!! --vault is ignored with --no-deid.');
  }
  const start = performance.now();
  const vault = deid ? await openVault(opts.vault, opts.allowKeyFile) : undefined;
  const result = pack(loaded, {
    deid,
    vault,
    format: opts.format,
    patientKey: opts.patient,
    freeText: opts.freeText,
  });
  if (deid && opts.vault && result.vault) await result.vault.save(opts.vault);
  await emit(result.context.content, opts.output);
  printPackStats(result, deid ? opts.vault : undefined, Math.round(performance.now() - start));
}

function warningLine(w: IntegrityWarning): string {
  return `  ${w.code.padEnd(28)} ${w.resourceKey}  ${w.message}`;
}

interface VerifyCliOptions {
  bundle: string;
  vault?: string;
  allowKeyFile?: boolean;
  patient?: string;
  rehydrate?: boolean;
  json?: boolean;
}

async function runVerify(file: string, opts: VerifyCliOptions): Promise<void> {
  const text = await readFile(file, 'utf8');
  const loaded = await loadInput(opts.bundle);
  const graph = normalize(loaded.entries, { rawText: loaded.rawText, inputBytes: loaded.bytes });
  const vault = await openVault(opts.vault, opts.allowKeyFile);
  if (opts.rehydrate && !vault) throw new FhirBridgeError('USAGE', '--rehydrate requires --vault.');
  // With a vault, pseudonymized ids the model cites are mapped back to the bundle's own ids.
  const report = auditCitations(text, graph, vault);
  const rehydrated = opts.rehydrate && vault ? rehydrate(text, vault, { patientKey: opts.patient }) : undefined;
  const missingAnchor = report.issues.some((i) => i.code === 'HALLUCINATED_RESOURCE_ID');
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ report, rehydrated }, null, 2)}\n`);
  } else {
    if (rehydrated !== undefined) process.stdout.write(`${rehydrated}\n`);
    err(`Citations checked: ${report.citations.length}; issues: ${report.issues.length}`);
    for (const i of report.issues) err(`  [${i.severity.toUpperCase()}] ${i.code} ${i.citation}: ${i.message}`);
    err(report.ok ? '✔ No critical clinical contradictions.' : '✖ Critical issues found.');
  }
  if (missingAnchor && !vault) err(VERIFY_VAULT_HINT);
  (logFormat === 'json' ? log.info : log.debug)('verify.done', {
    citations: report.citations.length,
    issues: report.issues.length,
    critical: report.issues.filter((i) => i.severity === 'critical').length,
    ok: report.ok,
  });
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
    .addOption(deidOption())
    .addOption(noDeidOption())
    .option('--vault <path>', 'encrypted vault for reversible tokens/date shifts (created if missing)')
    .option('--allow-key-file', ALLOW_KEY_FILE_HELP)
    .option('--patient <key>', 'only compile this patient (Patient/id; the original id works even if it was pseudonymized)')
    .addOption(freeTextOption())
    .addOption(formatOption())
    .option('-o, --output <path>', 'write context to a file instead of stdout')
    .description('compile a FHIR export into compact clinical context')
    .action(async (input: string, opts: PackCliOptions) => packAndEmit(await loadInput(input), opts));

  program
    .command('pull')
    .requiredOption('--iss <url>', 'FHIR R4 base URL (SMART iss)')
    .requiredOption('--patient <id>', 'patient id')
    .option('--token <token>', 'bearer token (prefer the FHIRBRIDGE_TOKEN env var)')
    .addOption(deidOption())
    .addOption(noDeidOption())
    .option('--vault <path>', 'encrypted vault file')
    .option('--allow-key-file', ALLOW_KEY_FILE_HELP)
    .option('--max-pages <n>', `pagination limit per resource type (1-${MAX_PAGES_LIMIT})`, parseMaxPages, 200)
    .option(
      '--allow-private-network',
      'permit an --iss that is a private, link-local or metadata IP literal (refused by default; localhost is always allowed)',
    )
    .addOption(freeTextOption())
    .addOption(formatOption())
    .option('-o, --output <path>', 'write context to a file instead of stdout')
    .description('pull Patient/$everything (or the patient compartment) and pack it')
    .action(
      async (
        opts: PackCliOptions & {
          iss: string;
          patient: string;
          token?: string;
          maxPages: number;
          allowPrivateNetwork?: boolean;
        },
      ) => {
      const pulled = await pullPatient({
        iss: opts.iss,
        patientId: opts.patient,
        token: opts.token ?? process.env.FHIRBRIDGE_TOKEN,
        maxPages: opts.maxPages,
        allowPrivateNetwork: opts.allowPrivateNetwork === true,
      });
      err(`Pulled ${pulled.entries.length} resources via ${pulled.method} (${pulled.pages} page(s)).`);
      for (const s of pulled.skipped) {
        err(`WARNING: skipped ${s.type} (HTTP ${s.status}): the server did not serve it, so this record may be incomplete.`);
      }
      await packAndEmit(pulled, { ...opts, patient: undefined });
      },
    );
}

function addAuditCommands(program: Command): void {
  program
    .command('verify')
    .argument('<llm-response-file>', 'text produced by the LLM')
    .requiredOption('--bundle <path>', 'the original FHIR input the context was compiled from')
    .option('--vault <path>', 'vault used during pack (maps pseudonymized ids back; needed for --rehydrate)')
    .option('--allow-key-file', ALLOW_KEY_FILE_HELP)
    .option('--patient <key>', 'Patient/id whose date shift to reverse (required if the vault holds several patients)')
    .option('--rehydrate', 'restore real names, identifiers and the dates the tool shifted in the output')
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
    .option('--allow-key-file', ALLOW_KEY_FILE_HELP)
    .option('--patient <key>', 'Patient/id whose date shift to reverse (required if the vault holds several patients)')
    .description('restore real identifiers and the dates the tool shifted in LLM output')
    .action(async (file: string, opts: { vault: string; patient?: string; allowKeyFile?: boolean }) => {
      const vault = await openVault(opts.vault, opts.allowKeyFile);
      if (!vault) throw new FhirBridgeError('USAGE', '--vault is required.');
      const text = await readFile(file, 'utf8');
      process.stdout.write(`${rehydrate(text, vault, { patientKey: opts.patient })}\n`);
    });

  program
    .command('mcp')
    .requiredOption('--bundle <path>', 'FHIR input to serve (de-identified)')
    .option('--vault <path>', 'encrypted vault file (keeps tokens stable across restarts)')
    .option('--allow-key-file', ALLOW_KEY_FILE_HELP)
    .option(
      '--allow-rehydrate',
      'returns REAL PHI to the model — only for models running locally (only tokens the server has shown)',
    )
    .addOption(freeTextOption())
    .description('start a privacy-by-design MCP server on stdio')
    .action(
      async (opts: {
        bundle: string;
        vault?: string;
        allowKeyFile?: boolean;
        allowRehydrate?: boolean;
        freeText?: FreeTextMode;
      }) => {
      // Loaded lazily: the MCP SDK is the heaviest dependency and only this command needs it.
      const { runMcpServer } = await import('./mcp/server.js');
      await runMcpServer({
        bundlePath: opts.bundle,
        freeText: opts.freeText,
        vaultPath: opts.vault,
        passphrase: passphrase(),
        allowKeyFile: opts.allowKeyFile === true,
        allowRehydrate: opts.allowRehydrate === true,
        logger: log,
      });
      },
    );
}

function parseLogFormat(value: string): LogFormat {
  if (value !== 'text' && value !== 'json') throw new InvalidArgumentError('Expected text or json');
  return value;
}

export function buildProgram(): Command {
  const program = new Command('fhirbridge')
    .version(VERSION)
    .description('Normalize messy FHIR R4 exports, de-identify them reversibly, and compile verified LLM context.')
    .option('--debug', 'print error causes and stack traces (may include input data; do not share)')
    .addOption(new Option('--log-format <format>', 'diagnostics format on stderr (text | json)').argParser(parseLogFormat))
    .option('-v, --verbose', 'more diagnostics (per-stage timings)')
    .option('-q, --quiet', 'only errors on stderr')
    .exitOverride()
    .hook('preAction', (cmd) => configureLogging(cmd.optsWithGlobals<GlobalOptions>()));
  addPackCommands(program);
  addAuditCommands(program);
  program
    .command('doctor')
    .description('check Node version, configuration and vault key setup (prints no secret values)')
    .action(async () => {
      const report = await runDoctor();
      for (const check of report.checks) err(`${check.ok ? '✔' : '✖'} ${check.name}: ${check.detail}`);
      process.exitCode = report.ok ? 0 : 78;
    });
  return program;
}

/** Single error boundary: classify, print a PHI-free message (+ hint), set a sysexits code. */
function handleFailure(error: unknown, debug: boolean): void {
  if (error instanceof CommanderError) {
    // Commander already printed usage/help/version; 0 for --help and --version.
    process.exitCode = error.exitCode === 0 ? 0 : 64;
    return;
  }
  const mapped = toFhirBridgeError(error);
  err(`fhirbridge: ${mapped.message}`);
  if (mapped.hint) err(`  hint: ${mapped.hint}`);
  if (debug) for (const line of describeCauses(mapped)) err(`  ${line}`);
  log.error('command.failed', { code: mapped.code, exitCode: mapped.exitCode });
  process.exitCode = mapped.exitCode;
}

try {
  await buildProgram().parseAsync(process.argv);
} catch (e) {
  handleFailure(e, process.argv.includes('--debug'));
}
