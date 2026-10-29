# Changelog

All notable changes to `openbyok` are documented in this file.

## [1.2.0] - 2026-10-29

### Added
- **Unified Live Model Auto-Discovery (`listModels`)**: Implemented `listModels(config)` across all built-in and OpenAI-compatible providers (`gemini`, `openai`, `claude`, `ollama`), exposed `client.listModels()`, and added automatic background model discovery (`availableModels`, `refreshModels()`) in `ByokHeadlessController`, `<byok-settings>`, `openbyok/angular`, `openbyok/react`, and `openbyok/vue`.
- **Configurable Model Filtering (`modelFilter`)**: Added optional `modelFilter?: (modelId: string) => boolean` in `ProviderConfig`, `OpenAICompatibleOptions`, and `ByokClientOptions.providerModelFilters`.
- **Native Multi-Turn Chat (`messages[]`)**: Added `ChatMessage` and `messages?: ChatMessage[]` support in `GenerationRequest` with per-turn multimodal images while maintaining full backward compatibility with `userPrompt`.
- **Native `AbortSignal` Cancellation (`request.signal`)**: Added `signal?: AbortSignal` to `GenerationRequest`, propagating cancellation through `ResilienceExecutor` and `readStreamLines()` with immediate `reader.cancel()` and no unintended fallback cascade on user abort.
- **State & Credential Hydration (`client.hydrate()`)**: Added `client.hydrate()` and `controller.hydrate()` to restore persisted `vaultMode`, `activeProvider`, custom models/endpoints, and encrypted keys across browser reloads.
- **Lifecycle Telemetry (`client.onEvent`) & Exact Upstream Token Tracking**: Added `ByokLifecycleEvent` hooks (`retry`, `model-failover`, `provider-failover`, `usage-recorded`) and exact API token counting from `usage` / `usageMetadata` responses.
- **Runtime Budget Policy Updates (`setBudgetPolicy`)**: Added `client.setBudgetPolicy(policy)` and `client.getBudgetPolicy()`.

### Fixed
- **Multimodal Streaming (`generateStream`)**: Shared message builders across `executeGeneration` and `generateStream` so `request.images` are included during streaming on OpenAI, Claude, and Ollama.
- **Resilient Streaming Handshake**: Wrapped `generateStream()` initial HTTP handshake in `ResilienceExecutor.executeWithFailover()` across all providers for per-model timeouts, `503`/`429` retry backoff, and candidate model rotation.
- **Aggregated Failover Error Chain**: Fixed `lastError` overwriting primary provider errors during fallback cascades (`All providers failed: [primary: ...] -> [fallback: ...]`).
- **UI Controller to Client Model/Endpoint Sync**: Synchronized `setCustomModel()` and `setCustomEndpoint()` directly with `ByokClient` (`setProviderModel`, `setProviderEndpoint`).
- **Tolerant Structured JSON Parsing (`parseStructuredJson`)**: Unified JSON extraction across all providers to tolerate markdown fences and surrounding conversational text in `generateObject<T>()`.

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

