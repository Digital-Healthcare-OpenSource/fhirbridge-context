# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release.

### Added

- **Normalizer**: Bundle, resource-array, NDJSON and Bulk `$export` input; reference resolution
  (`Type/id`, `urn:uuid:`, `#contained`); Base64 HTML/RTF/XML document decoding; narrative
  stripping; over-long id repair; `meta.lastUpdated` inference; clinical status gate; RxNorm
  brand→ingredient mapping and code/display conflict detection.
- **De-identification**: tokens for the 18 HIPAA identifier categories with canonical entity
  consolidation; default-deny structured scrubbing; clinical-fraction and eponym protection;
  relationship and CJK/Vietnamese/Korean name cues; per-patient date shift preserving intervals;
  date of birth reduced to the year, ages over 89 to `90+`; ZIP3 generalization; pseudonyms for
  ids that embed identifiers; sanitized warnings.
- **Vault**: AES-256-GCM, HKDF subkeys, scrypt passphrases (N=2^17), header bound as AAD, lock
  file with conflict detection, key required from the environment.
- **Compiler**: `clinical-md` with `[ResourceType/id]` anchors, refill consolidation, LOINC trend
  tables; SQL-on-FHIR-style views; CSV; `fhir-slim`.
- **Verifier**: hallucinated-id, status-contradiction and numeric-fidelity checks; exact batch and
  streaming rehydration of issued tokens and emitted dates.
- **CLI**: `pack`, `verify`, `rehydrate`, `audit`, `pull`, `mcp`, `doctor`; de-identification on
  by default; sysexits exit codes; `--log-format json`, `--debug`, `-v`, `-q`.
- **MCP server** (stdio): four tools reading the de-identified graph only; tool-call logging
  without arguments; graceful shutdown; opt-in, token-scoped `--allow-rehydrate`.
- **SMART-on-FHIR pull**: `$everything` with compartment-search fallback, same-origin pagination,
  60 s timeouts, 50 MB page cap, no silent skips of rate-limited or failed types.
- **Operations**: zod-validated configuration, input byte/resource limits, streaming NDJSON,
  PHI-safe structured logging, distroless non-root container image, CI (Ubuntu/Windows × Node
  22/24, e2e, coverage, Docker, npm-pack check), CodeQL, Dependabot, provenance-signed releases.

### Security

- Fixed before release, found by independent review: the date-shift offset in the compiled
  header, raw normalizer warnings in model-facing output, unparseable dates passed through
  unshifted, uncovered structured fields and extensions, patient surnames treated as eponyms,
  diacritic and apostrophe variants of names, unregistered relatives' names, ReDoS in the
  scrubber, lost vault writes under concurrency, a key file created beside the vault by default.
