# openbyok

[![npm version](https://img.shields.io/npm/v/openbyok.svg)](https://www.npmjs.com/package/openbyok)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/openbyok)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

Zero-dependency TypeScript toolkit for Bring Your Own Key (BYOK) and local offline AI applications across Web Browsers, Desktop, Mobile, and Node.js CLI environments.

---

## Why openbyok?

Client-side and CLI AI applications need a secure, unified way to manage user-supplied API keys, handle model rate limits, and switch between cloud providers and local models without routing secrets through intermediary servers.

`openbyok` provides:
- **4 Vault Storage Tiers**: Volatile RAM (`session`), WebCrypto AES-GCM-256 (`encrypted`), PIN-Locked AES-GCM-256 with brute-force protection (`passphrase`), and POSIX `0600` owner-only CLI files (`posix-file`).
- **Multi-Provider & OpenAI-Compatible Factory**: Built-in support for Google Gemini, OpenAI, Anthropic Claude, and local Ollama, plus 1-step registration for Groq, OpenRouter, DeepSeek, Mistral, Together AI, LM Studio, and vLLM.
- **2-Level Automatic Failover**: Per-model retry/failover (`ResilienceExecutor`) AND cross-provider cascade (`fallbackProviders`) with session working-model memory.
- **Universal Streaming (`generateStream`)**: Single `AsyncGenerator<string>` interface across Gemini SSE, OpenAI SSE, Claude SSE, and Ollama NDJSON.
- **Session Cost & Request Budget Guard (`UsageTracker`)**: Real-time token/USD estimation and concurrency-safe `BudgetPolicy` limits (`BudgetExceededError`).
- **Drop-In UI & Framework Wrappers**: Themeable `<byok-settings>` Web Component, Headless Controller, Angular Signals (`openbyok/angular`), React Hooks (`openbyok/react`), and Vue 3 Composables (`openbyok/vue`).

---

## Installation

```bash
npm install openbyok
```

---

## Subpath Exports

| Import Path | Target Environment | Included Modules |
| :--- | :--- | :--- |
| `openbyok` | Browser / Node.js | `ByokClient`, `createByok`, `GeminiProvider`, `OpenAIProvider`, `ClaudeProvider`, `OllamaProvider`, `createOpenAICompatibleProvider`, `MemoryVaultAdapter`, `WebCryptoVaultAdapter`, `PassphraseVaultAdapter`, `ResilienceExecutor`, `UsageTracker`, `ByokLocalizer` |
| `openbyok/cli` | Node.js CLI | `PosixFileVaultAdapter` (`0600` file / `0700` dir permissions), `promptMaskedInput`, `redactApiKey`, `warnIfCliKeyExposed` |
| `openbyok/ui` | Web Components / DOM | `ByokHeadlessController`, `registerByokSettingsElement` (`<byok-settings>`), `escapeHtml` |
| `openbyok/angular` | Angular 16+ | `createByokSignalStore` (Angular Signals bridge) |
| `openbyok/react` | React 17 / 18 / 19 | `createByokReactHook` (`useByok` hook factory) |
| `openbyok/vue` | Vue 3 / Nuxt | `createByokVueComposable` (`useByok` composable factory) |

---

## Quick Start

### 1. Client Initialization, Cross-Provider Failover & Streaming

```typescript
import { createByok } from 'openbyok';

const client = createByok({
  defaultProvider: 'gemini',
  fallbackProviders: ['openai', 'ollama'], // Auto-cascades on 429/503 outage
  defaultVaultMode: 'session',
  budgetPolicy: {
    maxRequestsPerSession: 50,
    maxCostUsdPerSession: 0.50,
  },
});

await client.vault.setKey('gemini', 'AIzaSy...');

// Stream text chunks in real time
for await (const chunk of client.generateStream({
  systemPrompt: 'Be concise and factual.',
  userPrompt: 'Explain authenticated AES-GCM-256 encryption.',
})) {
  process.stdout.write(chunk);
}

console.log('Session metrics:', client.getUsageMetrics());
```

### 2. PIN / Passphrase Locked Vault (`PassphraseVaultAdapter`)

Encrypts API keys in browser storage using a key derived from the user's PIN via 100,000 PBKDF2-SHA256 iterations. Includes canary verification and brute-force lockout cooldown:

```typescript
await client.vault.setMode('passphrase');

const unlocked = await client.passphraseVault.unlock('4829');
if (unlocked) {
  await client.vault.setKey('openai', 'sk-proj-...');
}

// Wipe passphrase and derived CryptoKey from RAM when idle
client.passphraseVault.lock();
```

### 3. Registering Groq, OpenRouter, or DeepSeek

```typescript
import { createByok, createOpenAICompatibleProvider } from 'openbyok';

const groq = createOpenAICompatibleProvider({
  id: 'groq',
  name: 'Groq Cloud',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.2-90b-vision-preview',
});

const client = createByok({
  customProviders: [groq],
  defaultProvider: 'groq',
});
```

### 4. Node.js CLI Credential Vault (`openbyok/cli`)

Enforces `0700` directory and `0600` file permissions on `~/.<app>/config.json`, isolates keys per provider, and resolves credentials in strict `CLI Flag > Environment Variable > Stored Config` order:

```typescript
import { PosixFileVaultAdapter, promptMaskedInput, redactApiKey } from 'openbyok/cli';

const cliVault = new PosixFileVaultAdapter({ configDirName: '.my-cli' });

const secret = await promptMaskedInput('Enter OpenAI API Key: ');
await cliVault.setSecret('openai', secret);

const resolved = cliVault.resolveKey('openai', process.env.CLI_FLAG_KEY);
console.log('Active key:', redactApiKey(resolved));
```

---

## Security & Quality Assurance

Run the built-in 18-test security, cryptographic penetration, chaos resilience, concurrency, and fuzzing suite:

```bash
npm test
```

- **AES-GCM-256 Authentication**: Rejects bit-flipped IVs, tampered ciphertexts, and truncated envelopes.
- **Strict No-Plaintext Policy**: Refuses to fall back to plaintext storage if `crypto.subtle` is unavailable.
- **Error Secret Scrubbing**: Automatically redacts raw API keys (`***REDACTED***`) from upstream HTTP errors and stack traces.
- **DOM XSS Sanitization**: Escapes all dynamic state before rendering in `<byok-settings>`.

---

## Documentation

- [System Architecture](./docs/architecture.md)
- [Security & Custom Vault Adapters](./docs/security-vaults.md)
- [Adding Custom AI Providers](./docs/custom-providers.md)
- [Resilience, Retry & Failover Policies](./docs/resilience-and-failover.md)
- [UI Integration & Theming Guide](./docs/ui-theming.md)
- [Multi-Framework Guide (Angular, React, Vue)](./docs/multi-framework-and-python.md)
- [Security Policy](./SECURITY.md)
- [Changelog](./CHANGELOG.md)

---

## License

MIT — Copyright (c) 2026 [Raele24](https://github.com/Raele24)
