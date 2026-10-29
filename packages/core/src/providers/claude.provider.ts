/**
 * Anthropic Claude Provider
 *
 * Implements the AIProvider interface for Anthropic's Messages API
 * with multimodal vision support and browser CORS compatibility.
 */

import {
  AIProvider,
  ConnectionTestResult,
  GenerationRequest,
  ProviderConfig,
} from '../types.js';
import { HttpStatusError, ResilienceExecutor } from '../resilience.js';
import { readStreamLines } from '../stream.util.js';

export class ClaudeProvider implements AIProvider {
  public static readonly DEFAULT_MODEL = 'claude-3-5-haiku-20241022';

  public readonly id = 'claude';
  public readonly name = 'Anthropic Claude';
  public readonly requiresKey = true;
  public readonly defaultBaseUrl = 'https://api.anthropic.com/v1';
  public readonly defaultModel = ClaudeProvider.DEFAULT_MODEL;

  private resilience = new ResilienceExecutor({
    timeoutMs: 60000,
    maxRetries: 1,
    rememberWorkingModel: true,
  });

  public async generateText(
    request: GenerationRequest,
    config: ProviderConfig
  ): Promise<string> {
    return this.executeGeneration(request, config);
  }

  public async generateObject<T = Record<string, unknown>>(
    request: GenerationRequest,
    config: ProviderConfig
  ): Promise<T> {
    const rawText = await this.executeGeneration(request, config);
    const cleaned = rawText
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
      throw new Error('Anthropic Claude API key is required. Please provide your API key.');
    }

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const model = config.model?.trim() || this.defaultModel;

    const requestBody: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 2048,
      messages: [{ role: 'user', content: request.userPrompt }],
      temperature: request.temperature ?? 0.2,
      stream: true,
    };
    if (request.systemPrompt) {
      requestBody['system'] = request.systemPrompt;
    }

    const res = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...config.headers,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new HttpStatusError(`Claude stream failed (${res.status}): ${errText}`, res.status, model);
    }

    for await (const line of readStreamLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          yield String(parsed.delta.text);
        }
      } catch { }
    }
  }

  private async executeGeneration(
    request: GenerationRequest,
    config: ProviderConfig
  ): Promise<string> {
    const apiKey = (config.apiKey || '').trim();
    if (!apiKey) {
      throw new Error('Anthropic Claude API key is required. Please provide your API key.');
    }

    const contentItems: Array<Record<string, unknown>> = [];

    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        const cleanBase64 = img.data.replace(/^data:[a-zA-Z0-9/+-]+;base64,/, '');
        let mediaType = img.mimeType || 'image/jpeg';
        if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
          mediaType = 'image/jpeg';
        }
        contentItems.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: cleanBase64,
          },
        });
      }
    }

    contentItems.push({
      type: 'text',
      text: request.userPrompt,
    });

    const systemContent = [request.systemPrompt, request.schemaInstruction]
      .filter(Boolean)
      .join('\n\n');

    const candidateModels = [
      config.model?.trim(),
      ClaudeProvider.DEFAULT_MODEL,
      'claude-3-5-sonnet-20241022',
    ].filter((m, idx, arr): m is string => Boolean(m) && arr.indexOf(m) === idx);

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');

    return this.resilience.executeWithFailover({
      providerId: this.id,
      apiKey,
      candidates: candidateModels,
      policy: {
        ...config.resilience,
        timeoutMs: config.timeoutMs ?? config.resilience?.timeoutMs ?? 60000,
      },
      operation: async (model, signal) => {
        const requestBody: Record<string, unknown> = {
          model,
          max_tokens: request.maxTokens ?? 2048,
          messages: [{ role: 'user', content: contentItems }],
          temperature: request.temperature ?? 0.2,
        };
        if (systemContent) {
          requestBody['system'] = systemContent;
        }

        const response = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            ...config.headers,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          let errorMessage = `Claude API responded with status ${response.status}`;
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
        const textBlocks =
          jsonResponse.content?.filter((c: { type: string; text?: string }) => c.type === 'text') ||
          [];
        const rawText = textBlocks.map((c: { text: string }) => c.text).join('\n').trim();
        if (!rawText) {
          throw new Error('No text content returned from Claude model.');
        }
        return rawText;
      },
    });
  }

  public async testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
    const apiKey = (config.apiKey || '').trim();
    if (!apiKey) {
      return { success: false, message: 'API key is missing' };
    }

    const baseUrl = (config.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    try {
      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...config.headers,
        },
      });

      if (res.ok) {
        return {
          success: true,
          message: 'Connected successfully. Claude 3.5 Vision models ready.',
        };
      }

      const errorJson = await res.json().catch(() => null);
      const msg = errorJson?.error?.message || `HTTP ${res.status} (${res.statusText})`;
      return { success: false, message: `Authentication failed: ${msg}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Network error connecting to Claude: ${msg}` };
    }
  }
}

