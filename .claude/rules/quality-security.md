---
paths:
  - ".github/workflows/**"
  - ".github/actions/**"
  - "src/webview/**"
  - "src/installer.ts"
  - "src/grim.ts"
---

# Security Standards

Deep-dive reference for security reviews.

## Security Checklist

- [ ] No hardcoded secrets or credentials
- [ ] All user input validated + sanitized
- [ ] SQL queries use parameterized statements
- [ ] Auth + authorization properly implemented
- [ ] Sensitive data encrypted at rest + in transit
- [ ] Error messages no expose internal details
- [ ] Dependencies up to date + vuln-free

## OWASP Top 10 2021

| Category | Check For |
|----------|-----------|
| Broken Access Control | Missing authorization checks |
| Cryptographic Failures | Unencrypted sensitive data |
| Injection | SQL, Command, XSS vulnerabilities |
| Insecure Design | Missing threat modeling |
| Security Misconfiguration | Default credentials, debug enabled |
| Vulnerable Components | Outdated/CVE-affected packages |
| Auth Failures | Weak passwords, session issues |
| Integrity Failures | Unsigned updates, untrusted deserialization |
| Logging Failures | Missing audit trails |
| SSRF | Unvalidated URLs in server requests |

## Severity Classification

| Severity | Definition | Action |
|----------|------------|--------|
| Critical | Exploitable vulnerability, data loss risk, high impact | MUST fix before merge |
| High | Exploitable vulnerability, breaking change, moderate impact, major bug | MUST fix before merge |
| Medium | Requires conditions to exploit, performance issue, code smell | SHOULD fix, can negotiate |
| Low | Best practice violation, style, minor improvement | COULD fix, optional |

## CWE References

Reference CWE (Common Weakness Enumeration) IDs for standardized vuln classification. Example: `CWE-89` for SQL Injection, `CWE-798` for hardcoded credentials.

## Dependency Safety

- Warn on deprecated/vulnerable deps
- Audit new deps before adding
- Keep deps updated
- Use automated scanning (Trivy, Snyk, Dependabot)

## Output Guidelines

- Never expose actual secrets in analysis output
- Give specific file locations + line numbers
- Include concrete remediation steps
- Check code AND config files

## grimoire-vscode Attack Surfaces

Recurring attack surfaces in this extension. Use as STRIDE scoping checklist for any audit.

### Webview Content Injection (XSS)
- Strict CSP: nonce scripts only, no remote content
- markdown-it configured `html:false` — never relax
- lit-html auto-escapes bindings; `unsafeHTML` reserved for markdown-it output and highlightJson's self-escaped spans — nothing else, ever
- String-rendered host HTML (first-paint skeleton) escapes every dynamic value through `esc()`; every new render path gets an escaping test
- Registry-sourced metadata (names, descriptions, READMEs) is untrusted input

### Process Spawning
- grim spawned only via `execFile` in `src/grim.ts` — no shell, no string interpolation into argv
- Never pass user/registry-controlled data as flags (argument injection); positional args after `--`

### Binary Auto-Install (`src/installer.ts`)
- Release assets resolved via dist-manifest.json from the official GitHub repo only
- Archive extraction via system `tar -xf` into extension storage — watch path traversal, symlink injection
- Downloaded binary path never derived from untrusted input

### Message Protocol
- Host validates webview messages (shape + expected values) before acting — a compromised webview must not gain arbitrary command execution

## Audit Checklist

- [ ] Escaping on every render path (lit-html bindings, `esc()` in string paths)
- [ ] `unsafeHTML` usage unchanged (markdown-it + highlightJson only)
- [ ] No shell spawns; argv built by pure builders
- [ ] Input validation (repo refs, tags, paths from messages/deep links)
- [ ] Secrets management (no credentials in logs/errors)
- [ ] Dependency vulnerabilities (`npm audit`)
- [ ] Archive extraction safety