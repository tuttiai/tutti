# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Tutti, **please do not open a
public issue.** Instead, report it privately:

- **Email:** security@tutti-ai.com
- **Subject:** `[SECURITY] <brief description>`

Include:
1. Description of the vulnerability
2. Steps to reproduce
3. Affected versions
4. Potential impact

We will acknowledge your report within **48 hours** and aim to release a
fix within **7 days** for critical issues.

## Supported Versions

Only the latest npm release is actively supported with security patches.

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |
| < latest | No       |

## Security Practices

### API Keys and Secrets

- **Never commit API keys.** The `.gitignore` template excludes `.env` files.
- The `SecretsManager` redacts known key patterns (Anthropic, OpenAI,
  GitHub, Google, Bearer tokens) from event payloads and error messages.
- Providers resolve keys via `SecretsManager.optional()` — keys are never
  logged, serialized, or stored to disk.
- Use `tutti-ai check` to verify API keys are set before running.

### Voice Permissions

Voices declare `required_permissions` and agents must explicitly grant
them. The `PermissionGuard` enforces this at runtime:

- `filesystem` — read/write local files
- `network` — make HTTP requests
- `shell` — execute shell commands
- `browser` — control a browser instance

### Tool Input Sanitization

- All tool inputs are **validated with Zod schemas** before execution.
- The `PathSanitizer` blocks access to system paths (`/etc/passwd`,
  `~/.ssh`, `/proc`, `/sys`, `/dev`) and enforces max file size on reads.
- The `UrlSanitizer` blocks `file:`, `javascript:`, `data:` schemes and
  private network ranges in browser navigation.
- Tool calls are rate-limited (`max_tool_calls`, default 20) and
  time-limited (`tool_timeout_ms`, default 30s).

### Prompt Injection Defense

Tool results are scanned by `PromptGuard` for common injection patterns.
Flagged content is wrapped with boundary markers and data-only warnings.
The `security:injection_detected` event is emitted for monitoring.

### Token Budget

Use the `budget` config on agents to set hard limits on token usage and
cost. The agent loop is halted when the budget is exceeded.

### Score File Validation

Score files are Zod-validated on load by `ScoreLoader`. Common mistakes
are caught early: missing provider, empty agent names, negative limits,
dangling delegate references.

### Dependencies

- All external dependencies are pinned to exact versions.
- `npm audit --audit-level=high` runs in CI on every push and PR.
- Internal workspace packages use `"*"` to resolve locally.

## Disclosure Policy

We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure).
Security researchers who report vulnerabilities will be credited in the
release notes (unless they prefer to remain anonymous).
