# Adding Custom AI Providers

`openbyok` provides two ways to add custom AI providers: declarative configuration for OpenAI-compatible APIs, or full custom `AIProvider` classes.

---

## 1. OpenAI-Compatible Providers

Any provider that implements the OpenAI `/v1/chat/completions` specification (Groq, OpenRouter, DeepSeek, Mistral, Together AI, LM Studio, vLLM) can be registered with `createOpenAICompatibleProvider`:

```typescript
import { createByok, createOpenAICompatibleProvider } from 'openbyok';

const groqProvider = createOpenAICompatibleProvider({
  id: 'groq',
  name: 'Groq Cloud',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.2-90b-vision-preview',
  fallbackModels: ['llama-3.2-11b-vision-preview'],
});

const client = createByok({
  customProviders: [groqProvider],
});
```

---

## 2. Implementing a Full Custom `AIProvider`

For proprietary endpoints or custom protocols, implement `AIProvider`:

```typescript
import {
  AIProvider,
  ConnectionTestResult,
  GenerationRequest,
  ProviderConfig,
} from 'openbyok';

export class CustomEnterpriseProvider implements AIProvider {
  public readonly id = 'enterprise-ai';
  public readonly name = 'Enterprise Vision Gateway';
  public readonly requiresKey = true;
  public readonly defaultBaseUrl = 'https://ai.internal.example.com/v1';
  public readonly defaultModel = 'enterprise-vision-v2';

  public async generateText(req: GenerationRequest, cfg: ProviderConfig): Promise<string> {
    const res = await fetch(`${cfg.baseUrl || this.defaultBaseUrl}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enterprise-Token': cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.model || this.defaultModel,
        prompt: req.userPrompt,
        images: req.images,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.output;
  }

  public async generateObject<T>(req: GenerationRequest, cfg: ProviderConfig): Promise<T> {
    const raw = await this.generateText(req, cfg);
    return JSON.parse(raw) as T;
  }

  public async testConnection(cfg: ProviderConfig): Promise<ConnectionTestResult> {
    if (!cfg.apiKey) return { success: false, message: 'Token required' };
    return { success: true, message: 'Enterprise gateway ready' };
  }
}
```
