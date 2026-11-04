# Security policy

FHIRBridge handles protected health information. Please report vulnerabilities
privately through [GitHub Security Advisories](https://github.com/Digital-Healthcare-OpenSource/fhirbridge-context/security/advisories/new),
not public issues.

Especially in scope:

- PHI that survives `--deid` (please include a synthetic reproduction, never real patient data)
- Vault confidentiality or integrity (key handling, AES-GCM usage, file permissions)
- Rehydration restoring the wrong identity or date
- The MCP server returning real PHI without `--allow-rehydrate`
- Token or credential leakage in `pull` (redirects, cross-origin pagination)

We aim to acknowledge reports within 3 business days.
