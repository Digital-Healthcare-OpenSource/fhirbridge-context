# Production audit & state (superseded)

> **Complete — superseded by [ARCHITECTURE.md](ARCHITECTURE.md) and [CHANGELOG.md](CHANGELOG.md).**
> Kept only as a record of the hardening pass; safe to delete (`git rm PRODUCTION_AUDIT_AND_STATE.md`).

Working state for the production-hardening pass.

## What this project is

`fhirbridge` (npm) — CLI, SDK and stdio MCP server. Pipeline:
load (Bundle / NDJSON / Bulk dir / SMART pull) → **normalize** (reference graph, decode, lint,
status gate) → **de-identify** (tokens + per-patient date shift, AES-GCM vault) → **compile**
(clinical-md / views with `[Type/id]` anchors) → LLM → **verify** (citation audit) + **rehydrate**.

Runtime: Node ≥ 22.12, ESM, TS strict. Runtime deps: commander, zod, @modelcontextprotocol/sdk.
No network except `pull`; no database; the only persistent state is the encrypted vault file.

## Target production architecture

- Layered core (`normalizer` → `deid` → `compiler` → `verifier`) behind typed contracts
  (`src/types/pipeline.ts`); adapters at the edge: CLI, MCP, SMART client, SDK facade.
- Typed error hierarchy with stable codes → deterministic CLI exit codes; no stack traces or PHI
  in user-facing errors.
- Fail-closed privacy: anything not provably safe is removed or generalized.
- Bounded resources: input size/resource caps, streaming NDJSON, bounded regex work, network
  timeouts and byte caps.
- PHI-free structured diagnostics on stderr (`--log-format json`), per-stage timings.
- Reproducible: lockfile, CI matrix (3 OS × Node 22/24), coverage gate, container image,
  provenance-signed npm release.

## Master checklist

### Phase 1 — Core architecture, config validation, centralized error handling
- [x] `src/errors.ts`: `FhirBridgeError` + 14 codes → sysexits exit codes (1 verify, 64 usage,
      65 data, 66 no input, 70 internal, 74 io, 75 tempfail, 77 noperm, 78 config); third-party
      errors (JSON.parse quotes input) wrapped with generic messages — tests/errors-config.test.ts
- [x] `src/config.ts`: zod-validated FHIRBRIDGE_MAX_INPUT_MB / _MAX_RESOURCES / _LOG_FORMAT /
      _LOG_LEVEL; errors name the variable, never the value
- [x] CLI single error boundary (`exitOverride`, `toFhirBridgeError`, hint line, `--debug` cause
      chain) — tests/e2e/cli.e2e.ts (11 tests on the built binary)

### Phase 2 — Security hardening, secret management, data sanitization
- [x] Fix independent review findings C1–C3, H1–H6, M1–M9, L1–L5 (all fixed; H6 partial: unlabelled
      postcodes in prose not detected; un-cued unregistered bare surnames remain a heuristic limit)
- [x] Re-ran the reviewer's probes: remaining hits are by design (birth year) or documented limits
- [ ] Red-team pass on new code (Stage 4)

### Phase 3 — Resiliency, concurrency safety, performance
- [x] Loader (`src/normalizer/input-loader.ts`): no retained `rawText` (tokens from byte count),
      streaming NDJSON via readline, byte + resource budgets across Bulk dirs, regular files
      only (symlinks rejected), prototype-polluting keys dropped — tests/input-loader.test.ts
- [~] Vault file locking + merge-on-save (deid agent)
- [~] `pull` timeouts, byte caps, no silent skips (app agent)
- [x] Scale benchmark (scripts/scale-benchmark.mjs): 1000 patients / 95k resources went from
      53 s to 16 s after profiling (per-char fold fast path + memoized canonicalName/foldKey).
      Residual ~1.4x per-resource growth 100→1000 from patient×provider matchers (kept: needed
      for ambiguous-surname detection). Peak heap ≈ 7.5× input size.

### Phase 4 — Observability
- [x] `src/logger.ts`: deny-by-default values (identifier-like strings, numbers, booleans only),
      injection-proof; `--log-format json|text`, `-v`, `-q` — tests/logger.test.ts
- [x] `pack.done` / `verify.done` / `command.failed` events with counts + ms
- [x] MCP server: `mcp.tool` events (name, outcome, ms — never arguments), `mcp.ready`,
      graceful shutdown on SIGINT/SIGTERM/stdin EOF — tests/mcp-server.test.ts
- [x] `fhirbridge doctor` (Node, config, vault key shape, crypto, MCP SDK) — tests/doctor.test.ts

### Phase 5 — Comprehensive testing
- [x] Coverage with thresholds: lines 93.1%, statements 89.4%, functions 92.3%, branches 76.9%
- [x] Property/fuzz (tests/property.test.ts, seeded PRNG): 5000 random FHIR dates, 3000 garbage /
      mutated inputs; plus the deid agent's planted-PHI property test. Found + fixed 2 real bugs:
      invalid calendar values (2021-13, 2021-02-30) overflowed into real dates; year-only values
      were always shifted into the previous year
- [x] CLI e2e against the built binary (tests/e2e/cli.e2e.ts, 11 tests)
- [x] Adversarial inputs: BOM, CRLF, broken lines, 50-level Bundle nesting, prototype keys,
      oversized inputs (tests/input-loader.test.ts); ReDoS inputs (deid regressions)

### Phase 6 — Packaging, CI/CD, documentation
- [x] Multi-stage Dockerfile → distroless nodejs22 nonroot, 53 MB, `--disable-proto=delete`,
      verified with `--read-only` rootfs + read-only data mount
- [x] CI: lint, test, build, e2e, smoke, bench (ubuntu+windows × node 22/24), coverage job,
      npm-pack content check, docker job; CodeQL (security-extended); dependabot (npm/actions/docker).
      macOS dropped while private (metered minutes) — re-add at public launch
- [x] Release workflow: tag → verify → npm publish --provenance + multi-arch GHCR image with SBOM
- [ ] README rewrite (Mermaid architecture, security model, benchmarks, configuration reference,
      production runbook), ARCHITECTURE.md, CHANGELOG.md, CONTRIBUTING.md

## Log
- 2026-11-05: audit started. Baseline: 109 tests pass, tsc clean, npm audit 0. Independent
  security review found 3 CRITICAL / 6 HIGH leaks → fixes in progress.
- 2026-11-05 (round 3, residual backlog from the second red-team review — all [x]):
  - [x] Windows ACL: vault, temp and key files restricted to the current user (icacls, no shell);
        fail closed with VAULT_IO — tests/vault-envelope.test.ts checks the real ACL
  - [x] Vault v3 envelope encryption (scrypt N=2^17 KEK wraps the master key); v1/v2 passphrase
        vaults upgraded on save with the master key unchanged (shifts/pseudonyms proven stable)
  - [x] Docker base images pinned by digest (Dependabot docker keeps them current)
  - [x] Logger redacts e-mail, date and 7+ digit identifier-shaped values
  - Accepted limits (documented): rollback to an older vault file is undetectable without
    external state; lowercase un-cued names in free text (use --free-text omit)
