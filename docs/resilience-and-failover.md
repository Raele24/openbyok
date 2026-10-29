# Resilience, Retry & Failover Policies

`openbyok` includes `ResilienceExecutor` to handle rate limits (`429`), overloaded clusters (`503`), deprecated models (`404`), and slow multimodal requests.

---

## Configuration Options (`ResiliencePolicy`)

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `timeoutMs` | `number` | `30000` | Maximum duration in milliseconds per model attempt before `AbortController` cancels the request. |
| `perModelTimeoutMs` | `Record<string, number>` | `undefined` | Fine-grained timeout overrides per model identifier. |
| `maxRetries` | `number` | `1` | Number of retries on the same model before moving to the next failover model. |
| `retryBackoffMs` | `number` | `800` | Base delay in milliseconds for exponential backoff (`800ms`, `1600ms`, `3200ms`). |
| `failoverModels` | `string[]` | `[]` | Ordered fallback models to try if the primary model fails. |
| `failoverStatusCodes` | `number[]` | `[400, 404, 408, 429, 500, 502, 503, 504]` | HTTP status codes that trigger automatic failover. `401` and `403` never fail over and throw immediately. |
| `rememberWorkingModel` | `boolean` | `true` | Caches the last model that succeeded for the current API key in `sessionStorage` and memory, promoting it to first position on subsequent calls. |

---

## Example: Per-Provider and Cross-Provider Failover

```typescript
import { createByok } from 'openbyok';

const client = createByok({
  defaultProvider: 'gemini',
  fallbackProviders: ['openai', 'ollama'],
  globalResilience: {
    timeoutMs: 30000,
    maxRetries: 1,
    rememberWorkingModel: true,
  },
  providerResilience: {
    gemini: {
      timeoutMs: 20000,
      failoverModels: ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-1.5-flash'],
      perModelTimeoutMs: {
        'gemini-3.5-flash': 12000,
        'gemini-1.5-flash': 25000,
      },
    },
    openai: {
      timeoutMs: 45000,
      failoverModels: ['gpt-4o-mini', 'gpt-4o'],
    },
  },
});
```
