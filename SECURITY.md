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

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Security Practices

### API Keys and Secrets

- **Never commit API keys.** The `.gitignore` template excludes `.env` files.
- The `tutti-ai init` scaffold generates `.env.example` with placeholder
  values — never real keys.
- `AnthropicProvider` reads `ANTHROPIC_API_KEY` from the environment at
  runtime. Keys are never logged, serialized, or stored to disk.

### Tool Execution

- All tool inputs are **validated with Zod schemas** before execution.
  Invalid input is rejected and never reaches the tool handler.
- Tool execution errors are caught and reported — they do not crash the
  runtime or leak stack traces to the LLM.
- Voices (plugins) run in the same process as the runtime. Only install
  voices from sources you trust.

### Dependencies

- We keep dependencies minimal and audit them regularly.
- `npm audit` is run as part of our CI pipeline.
- We pin major versions and review dependency updates before merging.

### Score Files

- Score files (`tutti.score.ts`) are dynamically imported via `ScoreLoader`.
  Only load score files from paths you control — a malicious score file
  has full access to the Node.js runtime.

## Disclosure Policy

We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure).
Security researchers who report vulnerabilities will be credited in the
release notes (unless they prefer to remain anonymous).
