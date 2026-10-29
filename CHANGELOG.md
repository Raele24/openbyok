# Changelog

All notable changes to `openbyok` are documented in this file.

## [1.1.1] - 2026-10-29

### Security & Performance
- **Strict AES-GCM Enforcement**: Removed plaintext storage fallback in `WebCryptoVaultAdapter.setSecret()` if WebCrypto encryption fails.
- **PBKDF2 `CryptoKey` Caching**: Added in-memory `derivedKeyCache` in `WebCryptoVaultAdapter`, reducing repeated encrypt/decrypt latency by 80x.
- **PIN Brute-Force Lockout**: Added consecutive failure tracking and exponential lockout cooldown in `PassphraseVaultAdapter`.
- **Automatic Error Secret Scrubbing**: Added `sanitizeErrorMessage()` across `ResilienceExecutor` and `ByokClient` to redact leaked API keys (`***REDACTED***`) from upstream HTTP errors.
- **Concurrency-Safe Budget Guard**: Added `acquireSlot()` in-flight tracking to `UsageTracker` so parallel `Promise.all` bursts strictly respect `maxRequestsPerSession` and `maxEstimatedTokensPerSession`.
- **DOM XSS Sanitization**: Added `escapeHtml()` sanitization across all dynamic attributes and text nodes in `<byok-settings>` (`openbyok/ui`).
- **Native Node.js ESM Compatibility**: Added explicit `.js` extensions on all internal relative imports and a 18-test automated security, stress, and E2E suite (`npm test`).

## [1.1.0] - 2026-10-29

### Added
- **Single-Package Subpath Exports**: Unified `openbyok`, `openbyok/core`, `openbyok/cli`, `openbyok/ui`, `openbyok/angular`, `openbyok/react`, and `openbyok/vue`.
- **Passphrase / PIN Vault (`PassphraseVaultAdapter`)**: User PIN-derived AES-GCM-256 vault with encrypted canary verification.
- **Cross-Provider Failover (`fallbackProviders`)**: Automatic provider cascade when the primary provider fails or hits rate limits.
- **Universal Streaming (`generateStream`)**: Unified `AsyncGenerator<string>` streaming for Gemini, OpenAI, Claude, and Ollama.
- **Session Budget Guard (`UsageTracker`)**: Per-provider request, token, and USD cost tracking with configurable session limits.

