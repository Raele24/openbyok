# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `1.1.x` | Yes |
| `< 1.1.0` | No |

## Security Architecture

`openbyok` is engineered for zero-intermediary Bring Your Own Key (BYOK) applications:
- **Zero Telemetry or External Servers**: All requests go directly from the client runtime to the configured AI provider endpoint.
- **Authenticated Encryption at Rest**: Browser persistent vaults use `crypto.subtle` AES-GCM-256 with a 96-bit random IV and PBKDF2-SHA256 (100,000 iterations).
- **Brute-Force Protection**: `PassphraseVaultAdapter` enforces exponential lockout cooldowns after consecutive failed PIN attempts.
- **Automatic Key Scrubbing**: `sanitizeErrorMessage()` strips raw API keys from thrown error messages before they reach logs or UI components.
- **Strict POSIX Permissions**: `PosixFileVaultAdapter` enforces `0700` directory and `0600` file permissions on configuration files.

## Reporting a Vulnerability

If you discover a security vulnerability in `openbyok`, please report it privately via [GitHub Security Advisories](https://github.com/Raele24/openbyok/security/advisories/new) rather than opening a public issue.

