# openbyok

Zero-dependency TypeScript and Python toolkit for Bring Your Own Key (BYOK) and local offline AI applications across Web Browsers, Desktop, Mobile, Node.js CLI, and Python environments.

---

## Installation

### JavaScript / TypeScript (Browser, Node.js, Angular, React, Vue)
```bash
npm install openbyok
```

### Python (CLI & Backend Scripts)
```bash
pip install openbyok
```

---

## Core Capabilities

1. **Multi-Provider Support & Custom Providers**:
   - Built-in support for Google Gemini (`gemini`), OpenAI (`openai`), Anthropic Claude (`claude`), and local offline Ollama (`ollama`).
   - Built-in `createOpenAICompatibleProvider()` factory to register Groq, OpenRouter, DeepSeek, Mistral, Together AI, LM Studio, or vLLM with a simple configuration object.
   - Open `AIProvider` interface for custom endpoints.
2. **Per-Model & Cross-Provider Failover (`ResilienceExecutor` & `fallbackProviders`)**:
   - Per-model timeouts (`AbortController`), retry counts with exponential backoff, automatic model discovery, and session working-model caching.
   - **Cross-Provider Cascade**: Configure `fallbackProviders: ['openai', 'ollama']` so if the primary provider hits a rate limit (`429`) or outage (`503`), `ByokClient` automatically cascades to the next configured provider.
3. **Universal Real-Time Streaming (`generateStream`)**:
   - Unified `AsyncGenerator<string>` streaming across Gemini SSE, OpenAI SSE, Claude SSE, and Ollama NDJSON.
4. **Session Token & Cost Budget Guard (`UsageTracker` & `BudgetPolicy`)**:
   - Tracks per-provider requests, estimated input/output tokens, and USD cost (`getUsageMetrics()`).
   - Enforces `maxRequestsPerSession`, `maxEstimatedTokensPerSession`, and `maxCostUsdPerSession` via `BudgetExceededError`.
5. **Pluggable Credential Vaults (`VaultAdapter`)**:
   - **Session Memory Vault (`MemoryVaultAdapter` - `session`)**: Stores keys exclusively in volatile JavaScript RAM. Zero disk writes.
   - **Encrypted Persistent Vault (`WebCryptoVaultAdapter` - `encrypted`)**: Encrypts keys at rest in browser storage using authenticated `crypto.subtle` AES-GCM-256 and PBKDF2 (100,000 SHA-256 iterations).
   - **Passphrase / PIN Locked Vault (`PassphraseVaultAdapter` - `passphrase`)**: Derives the AES-GCM-256 key strictly from a user-entered PIN/passphrase (`unlock(pin)` / `lock()`) verified against an encrypted canary. The passphrase is never stored on disk.
   - **Node / CLI & Python Vault (`PosixFileVaultAdapter` - `posix-file`)**: Stores isolated keys per provider (`keys: { gemini, openai, claude, ollama }`) in `~/.<app>/config.json` with strict `0600` file permissions and `0700` directory permissions, enforcing `CLI Flag > Environment Variable > Stored Config` precedence.
6. **Adaptive UI & Multi-Framework Subpath Exports**:
   - **Headless Controller (`openbyok/ui`)**: Framework-agnostic reactive state for custom UIs.
   - **Themeable Web Component (`<byok-settings>`)**: Drop-in HTML element customizable via CSS Custom Properties (`--byok-*`) or unstyled CSS class injection (Tailwind, Bootstrap).
   - **Framework Wrappers**: `openbyok/angular` (Signals), `openbyok/react` (Hooks), `openbyok/vue` (Vue 3 Composables), and `openbyok` (Python SDK).
7. **Multilingual Localization (i18n)**:
   - Built-in translations for English (`en`), Italian (`it`), French (`fr`), Spanish (`es`), and German (`de`), plus `ByokLocalizer.registerLocale()` for custom languages.

---

## Subpath Exports

| Import Path | Environment | Description |
| :--- | :--- | :--- |
| `openbyok` | Browser / Node | Core `ByokClient`, `createByok`, 4 built-in providers + OpenAI-compatible factory, Cross-Provider Failover, Universal Streaming, Budget Guard, `MemoryVaultAdapter`, `WebCryptoVaultAdapter`, `PassphraseVaultAdapter`, and `ByokLocalizer`. |
| `openbyok/cli` | Node.js CLI | Terminal credential manager (`PosixFileVaultAdapter` with `0600` permissions, multi-provider key map, `promptMaskedInput`, `redactApiKey`). |
| `openbyok/ui` | Web Components | Framework-agnostic `ByokHeadlessController` and themeable `<byok-settings>` Custom Element. |
| `openbyok/angular` | Angular 16+ | Reactive Angular Signals integration (`createByokSignalStore`). |
| `openbyok/react` | React 17/18/19 | Reactive React Hook factory (`createByokReactHook`). |
| `openbyok/vue` | Vue 3 / Nuxt | Reactive Vue 3 Composable factory (`createByokVueComposable`). |
| `openbyok` (Python) | Python 3.9+ | Zero-dependency Python SDK sharing `~/.<app>/config.json` (`0600`) with `openbyok/cli`. |

---

## Quick Start

### 1. Cross-Provider Failover, Budget Guard & Streaming (`openbyok`)

```typescript
import { createByok } from 'openbyok';

const client = createByok({
  defaultProvider: 'gemini',
  fallbackProviders: ['openai', 'ollama'],
  defaultVaultMode: 'session',
  budgetPolicy: {
    maxRequestsPerSession: 50,
    maxCostUsdPerSession: 0.50,
  },
});

for await (const chunk of client.generateStream({
  systemPrompt: 'Be concise.',
  userPrompt: 'Explain AES-GCM-256 encryption.',
})) {
  process.stdout.write(chunk);
}

console.log('Session usage:', client.getUsageMetrics());
```

### 2. User Passphrase / PIN Vault (`PassphraseVaultAdapter`)

```typescript
await client.vault.setMode('passphrase');
const unlocked = await client.passphraseVault.unlock('my-secret-pin-4829');
if (unlocked) {
  await client.vault.setKey('openai', 'sk-proj-...');
}
// Lock when idle (wipes passphrase from RAM)
client.passphraseVault.lock();
```

---

## Documentation Index

- [Architecture & Design](./docs/architecture.md)
- [Security & Custom Vault Adapters](./docs/security-vaults.md)
- [Adding Custom AI Providers](./docs/custom-providers.md)
- [Resilience, Retry & Failover Policies](./docs/resilience-and-failover.md)
- [UI Integration & Theming Guide](./docs/ui-theming.md)
- [Multi-Framework (Angular, React, Vue) & Python SDK](./docs/multi-framework-and-python.md)

---

## License

MIT
