# System Architecture

`openbyok` separates credential management, model transport resilience, and UI presentation into independent layers with zero external runtime dependencies.

---

## 1. Layered Design

1. **`VaultManager` & `VaultAdapter` (`openbyok`, `openbyok/cli`)**:
   - Manages per-provider secret storage (`gemini`, `openai`, `claude`, `ollama`, or custom provider IDs).
   - Provides a synchronous in-memory read cache hydrated from asynchronous storage adapters (`MemoryVaultAdapter`, `WebCryptoVaultAdapter`, `PassphraseVaultAdapter`, `PosixFileVaultAdapter`, or custom adapters).
2. **`ResilienceExecutor` & `UsageTracker` (`openbyok`)**:
   - Wraps provider HTTP calls with per-model `AbortController` timeouts, exponential backoff retries, HTTP status classification (`429`, `503`, `404`), and session working-model caching.
   - Immediately aborts failover on authentication errors (`401` / `403`) so invalid keys are reported without wasting requests.
   - Tracks request count, estimated tokens, and estimated USD cost per session (`UsageTracker`).
3. **`ProviderRegistry` & `AIProvider` (`openbyok`)**:
   - Normalizes text, streaming (`generateStream`), multimodal base64 images, and structured JSON schema enforcement across Google Gemini, OpenAI, Anthropic Claude, Local Ollama, and custom endpoints.
4. **UI & Framework Bridges (`openbyok/ui`, `openbyok/angular`, `openbyok/react`, `openbyok/vue`)**:
   - Exposes `ByokHeadlessController` for custom UI templates, `<byok-settings>` for drop-in CSS-variable themed settings panels, and framework adapters for Angular Signals, React Hooks, and Vue 3 Composables.
