/**
 * Ollama Local AI Provider
 *
 * Implements the AIProvider interface for locally hosted Ollama instances
 * with single-turn and multi-turn multimodal vision support, resilient streaming,
 * AbortSignal cancellation, dynamic model discovery via listModels(), and optional Bearer authentication.
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

export class OllamaProvider implements AIProvider {
  public static readonly DEFAULT_ENDPOINT = 'http://localhost:11434';
  public static readonly DEFAULT_MODEL = 'llama3.2-vision';

  public readonly id = 'ollama';
  public readonly name = 'Ollama (Local)';
  public readonly requiresKey = false;
  public readonly defaultBaseUrl = OllamaProvider.DEFAULT_ENDPOINT;
  public readonly defaultModel = OllamaProvider.DEFAULT_MODEL;

  private cachedModels: string[] = [];
  private resilience = new ResilienceExecutor({
    timeoutMs: 90000,
    maxRetries: 0,
    rememberWorkingModel: false,
  });

  private buildMessages(request: GenerationRequest): Array<Record<string, unknown>> {
    const { systemInstruction, turns } = normalizeRequestMessages(request);
    const messages: Array<Record<string, unknown>> = [];

    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }

    for (const turn of turns) {
      const base64Images = (turn.images || []).map((img) =>
        img.data.replace(/^data:[a-zA-Z0-9/+-]+;base64,/, '')
      );
      messages.push({
        role: turn.role,
        content: turn.content,
        ...(base64Images.length > 0 ? { images: base64Images } : {}),
      });
    }

    return messages;
  }

  private getCandidateModels(config: ProviderConfig): string[] {
    return [
      config.model?.trim() || OllamaProvider.DEFAULT_MODEL,
      ...(config.resilience?.failoverModels || []),
      ...this.cachedModels.slice(0, 4),
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
    const endpoint = (config.baseUrl || OllamaProvider.DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
    const candidateModels = this.getCandidateModels(config);
    const messages = this.buildMessages(request);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
    if (config.apiKey && config.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    }

    const res = await this.resilience.executeWithFailover({
      providerId: this.id,
      apiKey: config.apiKey || 'local',
      candidates: candidateModels,
      externalSignal: request.signal,
      onEvent: config.onEvent,
      policy: {
        ...config.resilience,
        timeoutMs: config.timeoutMs ?? config.resilience?.timeoutMs ?? 90000,
      },
      operation: async (model, signal) => {
        let response: Response;
        try {
          response = await fetch(`${endpoint}/api/chat`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              messages,
              stream: true,
              options: { temperature: request.temperature ?? 0.2 },
            }),
            signal,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to connect to Ollama at ${endpoint}. Please verify that Ollama is running ('ollama serve'). Error: ${msg}`
          );
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new HttpStatusError(
            `Ollama stream failed (${response.status}): ${errText}`,
            response.status,
            model
          );
        }
        return response;
      },
    });

    for await (const line of readStreamLines(res.body, request.signal)) {
      try {
        const parsed = JSON.parse(line);
        const text = parsed.message?.content || parsed.response;
        if (text) {
          yield String(text);
        }
      } catch { }
    }
  }

  private async executeGeneration(
    request: GenerationRequest,
    config: ProviderConfig,
    asJson: boolean
  ): Promise<string> {
    const endpoint = (config.baseUrl || OllamaProvider.DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
    const candidateModels = this.getCandidateModels(config);
    const messages = this.buildMessages(request);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
    if (config.apiKey && config.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    }

    return this.resilience.executeWithFailover({
      providerId: this.id,
      apiKey: config.apiKey || 'local',
      candidates: candidateModels,
      externalSignal: request.signal,
      onEvent: config.onEvent,
      policy: {
        ...config.resilience,
        timeoutMs: config.timeoutMs ?? config.resilience?.timeoutMs ?? 90000,
      },
      operation: async (model, signal) => {
        const requestBody: Record<string, unknown> = {
          model,
          messages,
          stream: false,
          options: { temperature: request.temperature ?? 0.2 },
        };
        if (asJson) {
          requestBody['format'] = 'json';
        }

        let response: Response;
        try {
          response = await fetch(`${endpoint}/api/chat`, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to connect to Ollama at ${endpoint}. Please verify that Ollama is running ('ollama serve') and accessible. Error: ${msg}`
          );
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          if (response.status === 404) {
            throw new HttpStatusError(
              `Ollama model "${model}" not found. Please install it by running "ollama run ${model}" in your terminal.`,
              404,
              model
            );
          }
          throw new HttpStatusError(
            `Ollama API error (${response.status}): ${errorText || response.statusText}`,
            response.status,
            model
          );
        }

        const resData = (await response.json()) as {
          message?: { content?: string };
          response?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const rawJsonText = resData.message?.content || resData.response || '';
        if (!rawJsonText.trim()) {
          throw new Error('Ollama returned an empty response. Please check model logs.');
        }

        if (resData.prompt_eval_count || resData.eval_count) {
          config.onEvent?.({
            type: 'usage-recorded',
            providerId: this.id,
            model,
            inputTokens: resData.prompt_eval_count,
            outputTokens: resData.eval_count,
          });
        }

        return rawJsonText;
      },
    });
  }

  public async listModels(config: ProviderConfig): Promise<string[]> {
    const endpoint = (config.baseUrl || OllamaProvider.DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
    const headers: Record<string, string> = { ...config.headers };
    if (config.apiKey && config.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const response = await fetch(`${endpoint}/api/tags`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = (await response.json()) as { models?: Array<{ name: string }> };
        let names = (data.models || []).map((m) => m.name).filter(Boolean);
        if (config.modelFilter) {
          names = names.filter(config.modelFilter);
        }
        if (names.length > 0) {
          this.cachedModels = names;
          return names;
        }
      }
    } catch { }

    return [];
  }

  public async testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
    const endpoint = (config.baseUrl || OllamaProvider.DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
    const targetModel = config.model || OllamaProvider.DEFAULT_MODEL;

    const headers: Record<string, string> = { ...config.headers };
    if (config.apiKey && config.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const response = await fetch(`${endpoint}/api/tags`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          message: `Ollama server replied with HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const modelNames = (data.models || []).map((m) => m.name);
      const targetBase = targetModel.split(':')[0].toLowerCase();
      const hasModel = modelNames.some((n) => n.toLowerCase().includes(targetBase));

      if (hasModel) {
        return {
          success: true,
          message: `Connected to Ollama! Model "${targetModel}" is ready.`,
          activeModel: targetModel,
          availableModels: modelNames,
        };
      } else if (modelNames.length > 0) {
        const topModels = modelNames.slice(0, 3).join(', ');
        return {
          success: true,
          message: `Connected to Ollama! (Model "${targetModel}" not detected yet. Available: ${topModels}. Run "ollama run ${targetModel}" to download it).`,
          availableModels: modelNames,
        };
      } else {
        return {
          success: true,
          message: `Connected to Ollama! No models installed yet. Run "ollama run ${targetModel}" to install vision capability.`,
          availableModels: [],
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('timeout')) {
        return {
          success: false,
          message: `Connection to Ollama timed out at ${endpoint}. Ensure Ollama is running ('ollama serve').`,
        };
      }
      return {
        success: false,
        message: `Cannot reach Ollama at ${endpoint}. Ensure Ollama is running ('ollama serve'). If in browser, ensure OLLAMA_ORIGINS="*" is set.`,
      };
    }
  }
}
