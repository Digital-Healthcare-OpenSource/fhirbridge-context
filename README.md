<h1 align="center">FHIRBridge</h1>

<p align="center">
  <b>Turn a 50k-token FHIR export into an 800-token, de-identified, citation-anchored clinical context, then verify what the LLM said about it.</b>
</p>

<p align="center">
  <a href="https://github.com/Digital-Healthcare-OpenSource/fhirbridge-context/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Digital-Healthcare-OpenSource/fhirbridge-context/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Node >= 22.12" src="https://img.shields.io/badge/node-%3E%3D22.12-339933.svg">
  <img alt="Runtime deps: 3" src="https://img.shields.io/badge/runtime%20deps-3-brightgreen.svg">
  <img alt="Offline" src="https://img.shields.io/badge/network-none%20required-success.svg">
</p>

```bash
export FHIRBRIDGE_VAULT_PASSPHRASE='use-a-long-passphrase'
npx fhirbridge pack patient-export.json --vault patient.vault.json > context.md   # de-identified by default
```

FHIRBridge is a zero-config **CLI, SDK and MCP server** that sits between messy EHR FHIR R4 exports and an LLM:

1. **Normalize**: resolves references (`Type/id`, `urn:uuid:`, `#contained`), decodes Base64 notes, strips XHTML narrative, repairs over-long ids and missing timestamps, and lints RxNorm codes.
2. **De-identify reversibly**: removes or tokenizes the 18 HIPAA identifier categories, reduces the date of birth to a year, and shifts every other date by a secret per-patient offset that keeps intervals intact. Token mappings live in an AES-256-GCM vault. This is **not** strict Safe Harbor; see [Privacy model and limits](#privacy-model-and-limits).
3. **Compile**: dense clinical Markdown (or SQL-on-FHIR-style tables) where every fact ends with a `[ResourceType/id]` anchor.
4. **Verify**: checks the model's answer against the record, catching invented ids, stopped drugs described as current, and wrong lab values. It then restores the real names and dates locally.

It runs fully offline, with no Docker, no JVM and no cloud API. The runtime dependencies are `commander`, `zod` and `@modelcontextprotocol/sdk`.

---

## Benchmark

Measured by [`scripts/benchmark.mjs`](scripts/benchmark.mjs) on the synthetic fixture in [`tests/fixtures`](tests/fixtures). Run `npm run build && npm run bench` to reproduce.

| Metric | Value |
| :--- | :--- |
| Input | 195.9 KB, 95 resources (1 patient, 50 refills, 30 HbA1c results, Base64 notes, PDF) |
| Tokens before → after | **50,145 → 800 (−98.4%)** |
| Pack time (normalize + de-identify + compile) | 6–11 ms |
| CLI cold start (`fhirbridge --version`) | ~90 ms |
| npm tarball | 159 KB |
| Identifiers tokenized / dates shifted | 171 / 192 |
| Planted PHI strings leaked into the context | **0 / 13** |
| Clinical terms preserved (`2/12 cores`, `Foley`, `Parkinson's`, `5/5`, drug names) | **6 / 6** |
| `entered-in-error` excluded / RxNorm code conflicts flagged | 1 / 1 |

Token counts are estimates at 4 bytes per token, applied the same way to input and output. Timings are from Node 24 on Windows x64. Real exports vary; run the script on your own data.

## What you get

```markdown
# CLINICAL SUMMARY CONTEXT (FHIRBridge v0.1.0 | De-identified: YES)

## 1. Patient Demographics [Patient/pat-1]
- Name: [PATIENT_1] | Gender: female | Age: 64 | Birth year: 1962 | ZIP: 021XX | MRN: [MRN_1] [Patient/pat-1]

## 4. Active Medications (Deduplicated by RxNorm)
- Metformin 500 MG Oral Tablet [RxNorm: 861007] — 1 tablet twice daily with meals (Authored: 2024-08-16, Status: active, Refills consolidated: 50) [MedicationRequest/medreq-104]

## 5. Discontinued / Stopped Medications (DO NOT TREAT AS ACTIVE)
- Lisinopril 10 MG Oral Tablet [RxNorm: 314076] — Status: stopped (2023-10-06, Reason: Dry cough) [MedicationRequest/medreq-088]

## 6. Longitudinal Labs & Vitals (Grouped by LOINC)
| Metric (LOINC) | Latest Value | Date | Reference Range | Historical Trend (Chronological) | Source Anchor |
| HbA1c (4548-4) | 7.8 % (HIGH) | 2024-08-14 | 4 - 5.6 % | 7.9% (2023-02-08) -> … -> 7.8% (2024-08-14) | [Observation/obs-301] |

## 7. Clinical Notes & Decoded DocumentReferences
- [2024-08-14] Progress Note by [PROVIDER_1]: Pt [PATIENT_1] ([MRN_1]) … Breast core biopsy: 2/12 cores positive. Foley catheter removed. Family history of Parkinson's disease. … [DocumentReference/doc-12]

## 8. Clinical Data Integrity Warnings (Auto-Detected by FHIRBridge)
- EXCLUDED: 1 resource(s) with status='entered-in-error' ([MedicationRequest/medreq-err-99]: Aspirin 81 MG Oral Tablet)
- CODE WARNING: [MedicationRequest/medreq-bad-1] display "Tiotropium 18 MCG Inhalation Capsule" conflicts with RxCUI 1116634 ("ticagrelor").
```

Ask the model to cite the anchors. Then check its answer:

```bash
$ fhirbridge verify answer.txt --bundle patient-export.json --vault patient.vault.json
Citations checked: 3; issues: 2
  [CRITICAL] CRITICAL_STATUS_CONTRADICTION MedicationRequest/medreq-088: … historical in the source record but the sentence presents it as current.
  [CRITICAL] HALLUCINATED_RESOURCE_ID Observation/obs-k-1: … does not exist in the source record.
✖ Critical issues found.          # exit code 1, so it can gate a pipeline

$ fhirbridge rehydrate answer.txt --vault patient.vault.json
Maria Elena Gonzalez's HbA1c improved to 7.8% on 2025-08-10 [Observation/obs-301]. …
```

## Why

Feeding raw FHIR to an LLM goes wrong in predictable ways:

- **Bloat.** Most of an export is structural JSON, repeated XHTML narrative and Base64 attachments. Long records overflow context windows or get silently truncated by local runtimes.
- **Broken graphs.** Medication names hide behind `medicationReference`, labs hang off panels, and bulk exports carry ids over FHIR's 64-character limit or no `meta.lastUpdated`. Some datasets carry RxNorm codes that do not match their display text.
- **De-identification that breaks the timeline.** Shifting each resource's dates independently destroys the intervals clinicians reason about, such as days since admission or time between labs. FHIRBridge derives one secret offset per patient (HMAC of the patient id) and applies it to every date in that patient's graph, including `contained`, extensions and free text. Time of day is preserved, so a 41 h 45 min gap stays 41 h 45 min. The offset itself is never written to any output.
- **Naive scrubbers damage the medicine.** Eponyms (`Foley`, `Swan-Ganz`, `Parkinson's`, `Hodgkin`) get redacted as names, and clinical fractions (`2/12 cores`, `4/5` strength, `PEEP 10/5`) get rewritten as dates. FHIRBridge masks those patterns before it detects identifiers.
- **Status hallucination.** Summaries merge `stopped` and `entered-in-error` orders into the active medication list. FHIRBridge gates status at compile time and audits it again in the answer.

## Install

```bash
npx fhirbridge --help              # once published to npm
# from source:
git clone https://github.com/Digital-Healthcare-OpenSource/fhirbridge-context && cd fhirbridge-context
npm ci && npm run build && node dist/cli.js --help
```

Requires Node.js ≥ 22.12.

## CLI

| Command | What it does |
| :--- | :--- |
| `fhirbridge pack <input> [--no-deid] [--vault <file>] [-f clinical-md\|view-json\|csv\|fhir-slim] [--patient Patient/id] [-o out]` | Layers 1→3. **De-identifies by default.** Context goes to stdout and statistics to stderr. Without `--vault` an in-memory vault is used and rehydration is impossible. |
| `fhirbridge verify <answer.txt> --bundle <input> [--vault <file>] [--rehydrate] [--patient Patient/id] [--json]` | Layer 4 citation audit. With `--vault`, pseudonymized ids the model cites are mapped back to the bundle's ids. Exits 1 on critical findings. |
| `fhirbridge rehydrate <answer.txt> --vault <file> [--patient Patient/id]` | Restores tokens and reverses the dates the tool shifted. A vault with several patients requires `--patient`. |
| `fhirbridge audit <input> [--json]` | Resource counts, token savings, PHI found, `entered-in-error` records and code conflicts. Operator-only: its warnings can contain raw values. |
| `fhirbridge pull --iss <fhir-base> --patient <id> [--no-deid] [--vault <file>]` | Pulls `Patient/$everything` (falling back to a compartment search) from any FHIR R4 server, then packs. De-identifies by default. |
| `fhirbridge mcp --bundle <input> [--vault <file>] [--allow-rehydrate]` | Starts the MCP server on stdio. |

`--no-deid` (on `pack` and `pull`) switches de-identification off, prints a warning on stderr before anything is written, and produces output with real names, identifiers and dates. Never send that output to an external LLM.

`<input>` can be a Bundle, a JSON array of resources, a single resource, an `.ndjson` file, or a Bulk `$export` directory of `.ndjson` files.

`pull` falls back to a compartment search when `$everything` is unsupported. In that search only HTTP 400/404/405 for a resource type are skipped, and each skipped type is reported as a warning; 401/403/408/429/5xx abort the pull instead of returning a partial record. Requests time out after 60 s, a single page is capped at 50 MB, and `--max-pages` applies per resource type.

Secrets come from the environment only, never from argv:

| Variable | Purpose |
| :--- | :--- |
| `FHIRBRIDGE_VAULT_PASSPHRASE` | Derives the vault key (scrypt) |
| `FHIRBRIDGE_VAULT_KEY` | 64 hex chars; used instead of a passphrase |
| `FHIRBRIDGE_TOKEN` | Bearer token for `pull` |

A vault key is required: set one of the first two variables. FHIRBridge does not silently create a key file. If you accept the weaker setup where the key sits beside the data, pass `--allow-key-file` explicitly.

## MCP: Claude Desktop, Cursor, OpenCode

```json
{
  "mcpServers": {
    "fhirbridge": {
      "command": "npx",
      "args": ["-y", "fhirbridge", "mcp", "--bundle", "/path/to/patient-export.json", "--vault", "/path/to/patient.vault.json"],
      "env": { "FHIRBRIDGE_VAULT_PASSPHRASE": "use-a-long-passphrase" }
    }
  }
}
```

| Tool | Returns |
| :--- | :--- |
| `get_patient_clinical_summary` | The de-identified `clinical-md` context (or `view-json` / `csv`) |
| `query_patient_resources` | De-identified resources filtered by type, code, shifted date range and status. `entered-in-error` records are never returned. |
| `verify_and_rehydrate_clinical_draft` | A citation audit of the agent's draft |
| `audit_bundle_integrity` | EHR data-quality warnings (code, resource key, sanitized message), de-identification counts and token statistics |

Tool results are model input, so the MCP server **never returns real PHI unless started with `--allow-rehydrate`**. Every tool reads the de-identified graph only. Rehydrate on your side with `fhirbridge rehydrate`; use `--allow-rehydrate` only when the model runs locally. Even then, only tokens the server itself has shown to the model are restored.

## SDK

```ts
import { packFile, verifyResponse, SafeHarborVault, StreamRehydrator } from 'fhirbridge';

const vault = await SafeHarborVault.open('patient.vault.json', { passphrase: process.env.VAULT_PASS });
const { context, graph } = await packFile('patient-export.json', { deid: true, vault });
await vault.save('patient.vault.json');

const answer = await llm(context.content);                  // your model call
// The vault maps pseudonymized ids back to `graph`; pass { patientKey } if it holds several patients.
const { report, rehydrated } = verifyResponse(answer, graph, vault);
if (!report.ok) throw new Error(report.issues.map((i) => i.code).join(', '));

// Streaming: tokens and dates split across SSE chunks are held back until complete.
const stream = new StreamRehydrator(vault);
for await (const chunk of llmStream) process.stdout.write(stream.push(chunk));
process.stdout.write(stream.end());
```

Each layer is also published on its own: `fhirbridge/normalizer`, `fhirbridge/deid`, `fhirbridge/compiler`, `fhirbridge/verifier`.

## Architecture

```text
  FHIR Bundle / NDJSON / Bulk $export / SMART $everything
                     │
   ┌─────────────────▼──────────────────┐
   │ 1  Normalizer                      │  reference graph · Base64/HTML/RTF decode · id/meta repair
   │                                    │  status gate · RxNorm brand→ingredient · code/display lint
   └─────────────────┬──────────────────┘
   ┌─────────────────▼──────────────────┐
   │ 2  De-identification + vault       │  tokens [PATIENT_1] [MRN_1] … · per-patient Δt ∈ [−365, −2]
   │    (AES-256-GCM, HKDF subkeys)     │  eponym/fraction guards · ZIP3 · age > 89 → 90+
   └─────────────────┬──────────────────┘
   ┌─────────────────▼──────────────────┐
   │ 3  Context compiler                │  clinical-md with [Type/id] anchors · SQL-on-FHIR views
   └─────────────────┬──────────────────┘
                     ▼   LLM / MCP agent
   ┌────────────────────────────────────┐
   │ 4  Verifier                        │  hallucinated ids · status contradictions · numeric fidelity
   │                                    │  rehydrate (batch + streaming hold-back buffer)
   └────────────────────────────────────┘
```

## Privacy model and limits

Read this before using it with real patient data.

- **This is not strict HIPAA Safe Harbor.** Safe Harbor requires removing all elements of dates except the year. FHIRBridge removes or tokenizes the 18 identifier categories and reduces the date of birth to the year (ages over 89 become `90+`), but by default it **shifts** all other dates by a secret per-patient offset instead of removing them. Date shifting is a technique used under Expert Determination, not under Safe Harbor, and it keeps day-level information that Safe Harbor would remove. Treat the output as de-identified for LLM use under your own risk assessment, not as a Safe Harbor determination, and have your privacy officer or an expert validate it before data leaves your control.
- **De-identification is the default and can be turned off.** `pack` and `pull` de-identify unless you pass `--no-deid`, which prints a warning and outputs real identifiers and dates.
- **Free-text detection is heuristic.** Structured fields are handled for all 18 identifier categories, and biometrics and photos are handled by removing attachment payloads. In free text, names are found through dictionaries, names registered from structured fields, and cue words (`Pt`, `Dr.`, `signed by`, relationship words such as `mother` or `husband`, and CJK, Vietnamese and Korean honorific cues). A name with no cue that is not registered from a structured field can be missed. Validate the output on a sample of your own notes before relying on it.
- **The vault contains PHI** (encrypted). Anyone holding the vault and its key can reverse the tokens. The key must come from the environment (`FHIRBRIDGE_VAULT_PASSPHRASE` or `FHIRBRIDGE_VAULT_KEY`); a key file next to the vault is used only with `--allow-key-file`. Keep the key off the machine that talks to the LLM.
- **Rehydration reverses only dates the tool emitted.** The vault records the exact shifted dates it produced for each patient. Any other date, such as a guideline year or a date the model computed, is left exactly as written. A vault that holds several patients requires you to name one (`--patient Patient/id`).
- **The MCP server never returns real PHI unless started with `--allow-rehydrate`**, and then only for tokens it has already shown to the model. Use that flag only with models that run locally.
- **Resource ids that embed identifiers are pseudonymized.** Ids longer than 64 characters are shortened. Pass the vault to `verify` / `verifyResponse` so the ids a model cites map back to your bundle.
- **The RxNorm dictionary is small.** It covers common outpatient drugs and known bad codes. It is not a terminology server.
- **This is not a medical device.** The verifier reduces some failure modes; it does not make model output clinically safe.

## Development

```bash
npm ci
npm test          # 109 tests: one suite per layer, end-to-end, MCP (in-memory client), SMART client
npm run lint      # tsc --noEmit (strict)
npm run build
npm run fixtures  # regenerate the synthetic fixture
npm run bench
```

The six acceptance tests in [`tests/fhirbridge.test.ts`](tests/fhirbridge.test.ts) cover token compression and reference resolution, patient-scoped date shift and reversal, eponym and fraction protection, the status gate and code linter, citation hallucination and contradiction detection, and streaming rehydration across split chunks.

## License

[MIT](LICENSE). All patient data in this repository is synthetic.
