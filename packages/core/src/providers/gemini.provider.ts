/**
 * Google Gemini Provider
 *
 * Interacts directly with the Google Gemini REST API (v1beta).
 * Passes API keys strictly via the 'x-goog-api-key' header (never in URL query strings).
 * Includes dynamic vision model discovery, priority scoring, and ResilienceExecutor failover.
 */

import {
  AIProvider,
  ConnectionTestResult,
  GenerationRequest,
  ProviderConfig,
} from '../types';
import { HttpStatusError, ResilienceExecutor } from '../resilience';
import { readStreamLines } from '../stream.util';

export class GeminiProvider implements AIProvider {
  public readonly id = 'gemini';
  public readonly name = 'Google Gemini (BYOK)';
  public readonly requiresKey = true;
  public readonly defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  public readonly defaultModel = 'gemini-3.5-flash';

  private cachedCandidatesByKey = new Map<string, string[]>();
  private resilience = new ResilienceExecutor({
    timeoutMs: 25000,
    maxRetries: 0,
    rememberWorkingModel: true,
  });

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
    const rawJson = await this.executeGeneration(request, config, true);
    const cleaned = rawJson
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    return JSON.parse(cleaned) as T;
  }

  public async *generateStream(
    request: GenerationRequest,
    config: ProviderConfig
  ): AsyncGenerator<string, void, unknown> {
    const apiKey = (config.apiKey || '').trim();
    if (!apiKey) {
      throw new Error('Gemini API key is required. Please provide your API key.');
    }

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const model = config.model?.trim() || (await this.getCandidateOrder(baseUrl, apiKey))[0] || this.defaultModel;

    const parts: Array<Record<string, unknown>> = [{ text: request.userPrompt }];
    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        const cleanBase64 = img.data.replace(/^data:[a-zA-Z0-9/+-]+;base64,/, '');
        parts.push({
          inline_data: {
            mime_type: img.mimeType || 'image/jpeg',
            data: cleanBase64,
          },
        });
      }
    }

    const requestBody: Record<string, unknown> = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
      },
    };

    if (request.systemPrompt) {
      requestBody['system_instruction'] = { parts: [{ text: request.systemPrompt }] };
    }

    const res = await fetch(`${baseUrl}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        ...config.headers,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new HttpStatusError(`Gemini stream failed (${res.status}): ${errText}`, res.status, model);
    }

    for await (const line of readStreamLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const chunkText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (chunkText) {
          yield String(chunkText);
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
    if (!apiKey) {
      throw new Error('Gemini API key is required. Please provide your API key.');
    }

    const parts: Array<Record<string, unknown>> = [{ text: request.userPrompt }];

    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        const cleanBase64 = img.data.replace(/^data:[a-zA-Z0-9/+-]+;base64,/, '');
        parts.push({
          inline_data: {
            mime_type: img.mimeType || 'image/jpeg',
            data: cleanBase64,
          },
        });
      }
    }

    const generationConfig: Record<string, unknown> = {
      temperature: request.temperature ?? 0.2,
    };

    if (request.maxTokens) {
      generationConfig['maxOutputTokens'] = request.maxTokens;
    }

    if (asJson) {
      generationConfig['response_mime_type'] = 'application/json';
      if (request.jsonSchema) {
        generationConfig['response_schema'] = request.jsonSchema;
      }
    }

    const requestBody: Record<string, unknown> = {
      contents: [{ role: 'user', parts }],
      generationConfig,
    };

    if (request.systemPrompt) {
      requestBody['system_instruction'] = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const primaryCandidates = config.model?.trim()
      ? [config.model.trim()]
      : await this.getCandidateOrder(baseUrl, apiKey);

    return this.resilience.executeWithFailover({
      providerId: this.id,
      apiKey,
      candidates: primaryCandidates,
      policy: {
        ...config.resilience,
        timeoutMs: config.timeoutMs ?? config.resilience?.timeoutMs ?? 25000,
      },
      operation: async (model, signal) => {
        const endpoint = `${baseUrl}/models/${model}:generateContent`;
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
            ...config.headers,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          let errorMessage = `AI vision model (${model}) responded with status ${response.status}`;
          try {
            const parsed = JSON.parse(errorText);
            if (parsed.error?.message) {
              errorMessage = `${errorMessage}: ${parsed.error.message}`;
            }
          } catch {
            if (errorText) {
              errorMessage = `${errorMessage}: ${errorText.slice(0, 200)}`;
            }
          }
          throw new HttpStatusError(errorMessage, response.status, model);
        }

        const jsonResponse = await response.json();
        const rawText = jsonResponse.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
          throw new Error(`No content returned from AI vision model (${model}).`);
        }
        return String(rawText);
      },
    });
  }

  public async testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
    const apiKey = (config.apiKey || '').trim();
    if (!apiKey) {
      return { success: false, message: 'API key is missing' };
    }

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const testUrl = `${baseUrl}/models`;

    try {
      const res = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
          ...config.headers,
        },
      });

      if (res.ok) {
        const data = (await res.json()) as {
          models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
        };
        const validModels = (data.models || []).filter((m) => this.isValidVisionModel(m));
        const sorted = this.getSortedVisionModels(validModels);
        if (sorted.length > 0) {
          this.cachedCandidatesByKey.set(apiKey, sorted);
        }
        const selected = config.model?.trim() || sorted[0] || 'gemini-flash-latest';
        if (selected && !config.model?.trim()) {
          this.resilience.setWorkingModel(`${this.id}:${apiKey.slice(-6)}`, selected);
        }
        return {
          success: true,
          message: `Connected. Active vision engine: ${selected}`,
          activeModel: selected,
          availableModels: sorted,
        };
      }

      const errorJson = await res.json().catch(() => null);
      const msg = errorJson?.error?.message || `HTTP ${res.status} (${res.statusText})`;
      return { success: false, message: `Authentication failed: ${msg}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Network error connecting to Gemini: ${msg}` };
    }
  }

  public async listModels(config: ProviderConfig): Promise<string[]> {
    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    return this.discoverModelCandidates(baseUrl, (config.apiKey || '').trim());
  }

  private isValidVisionModel(m: {
    name?: string;
    supportedGenerationMethods?: string[];
  }): boolean {
    const rawName = (m.name || '').toLowerCase();
    const name = rawName.replace(/^models\//, '');
    if (!name.startsWith('gemini-')) return false;

    if (
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.length > 0 &&
      !m.supportedGenerationMethods.includes('generateContent')
    ) {
      return false;
    }

    if (
      name.includes('embed') ||
      name.includes('aqa') ||
      name.includes('audio') ||
      name.includes('tts') ||
      name.includes('imagen')
    ) {
      return false;
    }
    return true;
  }

  private extractModelVersion(name: string): number {
    const match = name.match(/gemini-(\d+(?:\.\d+)?)/i);
    return match ? parseFloat(match[1]) : 0;
  }

  private getModelPriority(name: string): number {
    const lower = name.toLowerCase();
    if (lower.includes('2.5-flash') || lower.includes('2.5')) return -1000;
    if (lower === 'gemini-3.5-flash' || lower.endsWith('/gemini-3.5-flash')) return 1000;
    if (lower === 'gemini-flash-latest' || lower.endsWith('/gemini-flash-latest')) return 950;
    if (lower.includes('3.5-flash-lite')) return 920;
    if (lower.includes('3.5-flash')) return 900;
    if (lower === 'gemini-1.5-flash' || lower.includes('1.5-flash-latest')) return 800;
    if (lower.includes('1.5-flash-8b')) return 780;
    if (lower.includes('1.5-flash')) return 750;
    if (lower.includes('2.0-flash') && !lower.includes('exp') && !lower.includes('preview')) return 600;
    if (lower.includes('flash')) return 300 + this.extractModelVersion(name);
    return 100;
  }

  private getSortedVisionModels(models: Array<{ name: string }>): string[] {
    const modelNames = models.map((m) => m.name.replace(/^models\//, ''));
    if (modelNames.length === 0) return [];

    const activeModels = modelNames.filter((name) => {
      const lower = name.toLowerCase();
      if (lower.includes('2.5-flash') || lower.includes('2.5')) return false;
      if (lower.includes('exp') || lower.includes('preview')) return false;
      return true;
    });

    const candidatePool = activeModels.length > 0 ? activeModels : modelNames;
    const sorted = [...candidatePool].sort((a, b) => {
      const scoreA = this.getModelPriority(a);
      const scoreB = this.getModelPriority(b);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.localeCompare(b);
    });

    const standardFallbacks = [
      'gemini-3.5-flash',
      'gemini-flash-latest',
      'gemini-3.5-flash-lite',
      'gemini-1.5-flash',
    ];
    for (const fb of standardFallbacks) {
      if (!sorted.includes(fb) && modelNames.includes(fb)) {
        sorted.push(fb);
      }
    }
    return sorted;
  }

  private async discoverModelCandidates(baseUrl: string, apiKey: string): Promise<string[]> {
    const cached = this.cachedCandidatesByKey.get(apiKey);
    if (cached && cached.length > 0) return cached;

    try {
      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
        };
        const validModels = (data.models || []).filter((m) => this.isValidVisionModel(m));
        const sorted = this.getSortedVisionModels(validModels);
        if (sorted.length > 0) {
          this.cachedCandidatesByKey.set(apiKey, sorted);
          return sorted;
        }
      }
    } catch { }

    const fallback = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-1.5-flash'];
    this.cachedCandidatesByKey.set(apiKey, fallback);
    return fallback;
  }

  private async getCandidateOrder(baseUrl: string, apiKey: string): Promise<string[]> {
    const discovered = await this.discoverModelCandidates(baseUrl, apiKey);
    const ordered = [...discovered];
    if (!ordered.includes('gemini-3.5-flash')) ordered.unshift('gemini-3.5-flash');
    if (!ordered.includes('gemini-flash-latest')) ordered.splice(1, 0, 'gemini-flash-latest');
    return ordered.slice(0, 6);
  }
}

