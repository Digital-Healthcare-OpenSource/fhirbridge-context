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
npx fhirbridge pack patient-export.json --deid --vault patient.vault.json > context.md
```

FHIRBridge is a zero-config **CLI, SDK and MCP server** that sits between messy EHR FHIR R4 exports and an LLM:

1. **Normalize**: resolves references (`Type/id`, `urn:uuid:`, `#contained`), decodes Base64 notes, strips XHTML narrative, repairs over-long ids and missing timestamps, and lints RxNorm codes.
2. **De-identify reversibly**: HIPAA Safe Harbor tokenization plus a per-patient date shift that keeps every interval intact, stored in an AES-256-GCM vault.
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
# CLINICAL SUMMARY CONTEXT (FHIRBridge v0.1.0 | SafeHarbor: ENABLED | DateShift: -361d)

## 1. Patient Demographics [Patient/pat-1]
- Name: [PATIENT_1] | Gender: female | Age: 65 (DOB: 1961-03-18) | ZIP: 021XX | MRN: [MRN_1] [Patient/pat-1]

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
$ fhirbridge verify answer.txt --bundle patient-export.json
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
- **De-identification that breaks the timeline.** Shifting each resource's dates independently destroys the intervals clinicians reason about, such as days since admission or time between labs. FHIRBridge derives one offset per patient (HMAC of the patient id) and applies it to every date in that patient's graph, including `contained`, extensions and free text. Time of day is preserved, so a 41 h 45 min gap stays 41 h 45 min.
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
| `fhirbridge pack <input> [--deid] [--vault <file>] [-f clinical-md\|view-json\|csv\|fhir-slim] [--patient Patient/id] [-o out]` | Layers 1→3. Context goes to stdout and statistics to stderr. |
| `fhirbridge verify <answer.txt> --bundle <input> [--vault <file> --rehydrate] [--json]` | Layer 4 citation audit. Exits 1 on critical findings. |
| `fhirbridge rehydrate <answer.txt> --vault <file> [--patient Patient/id]` | Restores tokens and reverses the date shift. |
| `fhirbridge audit <input> [--json]` | Resource counts, token savings, PHI found, `entered-in-error` records and code conflicts. |
| `fhirbridge pull --iss <fhir-base> --patient <id> [--deid] [--vault <file>]` | Pulls `Patient/$everything` (falling back to a compartment search) from any FHIR R4 server, then packs. |
| `fhirbridge mcp --bundle <input> [--vault <file>] [--allow-rehydrate]` | Starts the MCP server on stdio. |

`<input>` can be a Bundle, a JSON array of resources, a single resource, an `.ndjson` file, or a Bulk `$export` directory of `.ndjson` files.

Secrets come from the environment only, never from argv:

| Variable | Purpose |
| :--- | :--- |
| `FHIRBRIDGE_VAULT_PASSPHRASE` | Derives the vault key (scrypt) |
| `FHIRBRIDGE_VAULT_KEY` | 64 hex chars; used instead of a passphrase |
| `FHIRBRIDGE_TOKEN` | Bearer token for `pull` |

Without either variable, a random key is written next to the vault as `<vault>.key` with mode 0600. Keep it somewhere else in production.

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
| `audit_bundle_integrity` | EHR data-quality warnings, Safe Harbor counts and token statistics |

Tool results are model input, so the MCP server **never returns real PHI by default**. Rehydrate on your side with `fhirbridge rehydrate`, or start the server with `--allow-rehydrate` only when the model runs locally.

## SDK

```ts
import { packFile, verifyResponse, SafeHarborVault, StreamRehydrator } from 'fhirbridge';

const vault = await SafeHarborVault.open('patient.vault.json', { passphrase: process.env.VAULT_PASS });
const { context, graph } = await packFile('patient-export.json', { deid: true, vault });
await vault.save();

const answer = await llm(context.content);                  // your model call
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
   │ 2  Safe Harbor engine + vault      │  tokens [PATIENT_1] [MRN_1] … · per-patient Δt ∈ [−365, −2]
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

- **Safe Harbor coverage.** Structured fields are handled for all 18 identifier categories. Biometrics and photos are handled by removing attachment payloads, because they cannot be detected in text. Free-text detection uses dictionaries, known names and cue words (`Pt`, `Dr.`, `signed by`, …). A bare name with no cue that does not also appear in a structured field can be missed. This is a strong default, not a certification. Have your privacy officer validate it, or use Expert Determination, before sending data to a third party.
- **The vault contains PHI** (encrypted). Anyone holding the vault and its key can reverse the tokens. Keep the key off the machine that talks to the LLM.
- **Rehydration is window-limited.** It only reverses dates that fall near the patient's shifted timeline, so dates the model invents, such as guideline years, are left alone.
- **Resource ids are not tokenized.** Ids longer than 64 characters are shortened. If your EHR embeds MRNs in short ids, remap them first.
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
