/**
 * OpenAI & OpenAI-Compatible Provider
 *
 * Supports OpenAI Platform as well as any OpenAI-compatible Chat Completions endpoint
 * (Groq, OpenRouter, DeepSeek, Mistral, Together AI, LM Studio, vLLM) via createOpenAICompatibleProvider().
 * Supports single-turn and multi-turn multimodal requests, resilient streaming with model failover,
 * AbortSignal cancellation, and dynamic model discovery via listModels().
 */

import {
  AIProvider,
  ConnectionTestResult,
  GenerationRequest,
  ProviderConfig,
} from '../types.js';
import {
  HttpStatusError,
  normalizeRequestMessages,
  parseStructuredJson,
  ResilienceExecutor,
} from '../resilience.js';
import { readStreamLines } from '../stream.util.js';

export interface OpenAICompatibleOptions {
  id: string;
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  fallbackModels?: string[];
  requiresKey?: boolean;
  defaultHeaders?: Record<string, string>;
  /** Optional default predicate to filter model IDs returned by listModels() */
  modelFilter?: (modelId: string) => boolean;
}

export class OpenAIProvider implements AIProvider {
  public static readonly DEFAULT_MODEL = 'gpt-4o-mini';

  public readonly id: string;
  public readonly name: string;
  public readonly requiresKey: boolean;
  public readonly defaultBaseUrl: string;
  public readonly defaultModel: string;
  private readonly fallbackModels: string[];
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultModelFilter?: (modelId: string) => boolean;
  private cachedModelsByKey = new Map<string, string[]>();
  private resilience = new ResilienceExecutor({
    timeoutMs: 60000,
    maxRetries: 1,
    rememberWorkingModel: true,
  });

  constructor(options?: Partial<OpenAICompatibleOptions>) {
    this.id = options?.id || 'openai';
    this.name = options?.name || 'OpenAI (BYOK)';
    this.requiresKey = options?.requiresKey ?? true;
    this.defaultBaseUrl = options?.defaultBaseUrl || 'https://api.openai.com/v1';
    this.defaultModel = options?.defaultModel || OpenAIProvider.DEFAULT_MODEL;
    this.fallbackModels = options?.fallbackModels || ['gpt-4o'];
    this.defaultHeaders = options?.defaultHeaders || {};
    this.defaultModelFilter = options?.modelFilter;
  }

  /**
   * Builds normalized OpenAI chat completion messages supporting both single-turn
   * and multi-turn requests with multimodal base64 image attachments.
   */
  private buildMessages(request: GenerationRequest): Array<Record<string, unknown>> {
    const { systemInstruction, turns } = normalizeRequestMessages(request);
    const messages: Array<Record<string, unknown>> = [];

    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }

    for (const turn of turns) {
      if (turn.role === 'assistant') {
        messages.push({ role: 'assistant', content: turn.content });
        continue;
      }

      if (turn.images && turn.images.length > 0) {
        const contentArray: Array<Record<string, unknown>> = [];
        if (turn.content) {
          contentArray.push({ type: 'text', text: turn.content });
        }
        for (const img of turn.images) {
          const cleanBase64 = img.data.replace(/^data:[a-zA-Z0-9/+-]+;base64,/, '');
          const mimeType = img.mimeType || 'image/jpeg';
          contentArray.push({
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${cleanBase64}`,
              detail: 'high',
            },
          });
        }
        messages.push({ role: 'user', content: contentArray });
      } else {
        messages.push({ role: 'user', content: turn.content });
      }
    }

    return messages;
  }

  private getCandidateModels(config: ProviderConfig): string[] {
    const discovered = this.cachedModelsByKey.get((config.apiKey || '').trim()) || [];
    return [
      config.model?.trim(),
      this.defaultModel,
      ...this.fallbackModels,
      ...discovered.slice(0, 4),
    ].filter((m, idx, arr): m is string => Boolean(m) && arr.indexOf(m) === idx);
  }

  public async generateText(
    request: GenerationRequest,
    config: ProviderConfig
  ): Promise<string> {
    return this.executeGeneration(request, config, false);
  }

  public async generateObject<T = Record<string, unknown>>(
    request: GenerationRequest,
    config: ProviderConfig
  ): Promise<T> {
    const rawText = await this.executeGeneration(request, config, true);
    return parseStructuredJson<T>(rawText);
  }

  public async *generateStream(
    request: GenerationRequest,
    config: ProviderConfig
  ): AsyncGenerator<string, void, unknown> {
    const apiKey = (config.apiKey || '').trim();
    if (this.requiresKey && !apiKey) {
      throw new Error(`${this.name} API key is required. Please provide your API key.`);
    }

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const messages = this.buildMessages(request);
    const candidateModels = this.getCandidateModels(config);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...config.headers,
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await this.resilience.executeWithFailover({
      providerId: this.id,
      apiKey,
      candidates: candidateModels,
      externalSignal: request.signal,
      onEvent: config.onEvent,
      policy: {
        ...config.resilience,
        timeoutMs: config.timeoutMs ?? config.resilience?.timeoutMs ?? 60000,
      },
      operation: async (model, signal) => {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages,
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 2048,
            stream: true,
          }),
          signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new HttpStatusError(
            `${this.name} stream failed (${response.status}): ${errText}`,
            response.status,
            model
          );
        }
        return response;
      },
    });

    for await (const line of readStreamLines(res.body, request.signal)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') break;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          yield String(delta);
        }
      } catch { }
    }
  }

  private async executeGeneration(
    request: GenerationRequest,
    config: ProviderConfig,
    asJson: boolean
  ): Promise<string> {
    const apiKey = (config.apiKey || '').trim();
    if (this.requiresKey && !apiKey) {
      throw new Error(`${this.name} API key is required. Please provide your API key.`);
    }

    const messages = this.buildMessages(request);
    const candidateModels = this.getCandidateModels(config);
    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');

    return this.resilience.executeWithFailover({
      providerId: this.id,
      apiKey,
      candidates: candidateModels,
      externalSignal: request.signal,
      onEvent: config.onEvent,
      policy: {
        ...config.resilience,
        timeoutMs: config.timeoutMs ?? config.resilience?.timeoutMs ?? 60000,
      },
      operation: async (model, signal) => {
        const requestBody: Record<string, unknown> = {
          model,
          messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 2048,
        };

        if (asJson) {
          requestBody['response_format'] = { type: 'json_object' };
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...this.defaultHeaders,
          ...config.headers,
        };
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          let errorMessage = `${this.name} API responded with status ${response.status}`;
          try {
            const parsed = JSON.parse(errorText);
            if (parsed.error?.message) {
              errorMessage = `${errorMessage}: ${parsed.error.message}`;
            }
          } catch {
            errorMessage = `${errorMessage}: ${errorText.slice(0, 200)}`;
          }
          throw new HttpStatusError(errorMessage, response.status, model);
        }

        const jsonResponse = await response.json();
        const rawText = jsonResponse.choices?.[0]?.message?.content;
        if (!rawText) {
          throw new Error(`No content returned from ${this.name} model (${model}).`);
        }

        if (jsonResponse.usage) {
          config.onEvent?.({
            type: 'usage-recorded',
            providerId: this.id,
            model,
            inputTokens: jsonResponse.usage.prompt_tokens,
            outputTokens: jsonResponse.usage.completion_tokens,
          });
        }

        return String(rawText);
      },
    });
  }

  public async listModels(config: ProviderConfig): Promise<string[]> {
    const apiKey = (config.apiKey || '').trim();
    const filterFn = config.modelFilter || this.defaultModelFilter;
    const defaults = [this.defaultModel, ...this.fallbackModels];
    if (this.requiresKey && !apiKey) {
      return filterFn ? defaults.filter(filterFn) : defaults;
    }

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...config.headers,
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        let models: string[] = (data.data || [])
          .map((m: { id?: string }) => m.id || '')
          .filter(Boolean);
        if (filterFn) {
          models = models.filter(filterFn);
        }
        if (models.length > 0) {
          this.cachedModelsByKey.set(apiKey, models);
          return models;
        }
      }
    } catch { }

    return filterFn ? defaults.filter(filterFn) : defaults;
  }

  public async testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
    const apiKey = (config.apiKey || '').trim();
    if (this.requiresKey && !apiKey) {
      return { success: false, message: 'API key is missing' };
    }

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...config.headers,
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const models: string[] = data.data?.map((m: { id: string }) => m.id) || [];
        const hasVision = models.some(
          (m) => m.includes('gpt') || m.includes('vision') || m.includes('4o')
        );
        return {
          success: true,
          message: hasVision
            ? 'Connected successfully. Vision models available.'
            : 'Connected successfully.',
          availableModels: models.length > 0 ? models : [this.defaultModel, ...this.fallbackModels],
        };
      }

      const errorJson = await res.json().catch(() => null);
      const msg = errorJson?.error?.message || `HTTP ${res.status} (${res.statusText})`;
      return { success: false, message: `Authentication failed: ${msg}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Network error connecting to ${this.name}: ${msg}` };
    }
  }
}

/**
 * Factory helper to create a custom OpenAI-compatible provider with zero boilerplate.
 */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): AIProvider {
  return new OpenAIProvider(options);
}
