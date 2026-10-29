/**
 * Provider Registry
 *
 * Central registry allowing dynamic registration and selection of built-in
 * and user-defined AI providers.
 */

import { AIProvider, ProviderId } from '../types';
import { GeminiProvider } from './gemini.provider';
import { OpenAIProvider } from './openai.provider';
import { ClaudeProvider } from './claude.provider';
import { OllamaProvider } from './ollama.provider';

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers = new Map<string, AIProvider>();

  public constructor(includeDefaults = true) {
    if (includeDefaults) {
      this.register(new GeminiProvider());
      this.register(new OpenAIProvider());
      this.register(new ClaudeProvider());
      this.register(new OllamaProvider());
    }
  }

  public static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry(true);
    }
    return ProviderRegistry.instance;
  }

  public register(provider: AIProvider): void {
    this.providers.set(provider.id.toLowerCase(), provider);
  }

  public get(id: ProviderId): AIProvider {
    const provider = this.providers.get(id.toLowerCase());
    if (!provider) {
      throw new Error(
        `Provider "${id}" is not registered. Available providers: ${this.getAvailableIds().join(', ')}`
      );
    }
    return provider;
  }

  public has(id: ProviderId): boolean {
    return this.providers.has(id.toLowerCase());
  }

  public getAvailableIds(): string[] {
    return Array.from(this.providers.keys());
  }

  public getAll(): AIProvider[] {
    return Array.from(this.providers.values());
  }
}

