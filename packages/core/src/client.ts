/**
 * ByokClient
 *
 * High-level unified client combining ProviderRegistry, VaultManager, ResiliencePolicies,
 * Cross-Provider Failover cascades, Universal Streaming, and Session Budget Guards.
 */

import {
  AIProvider,
  BudgetPolicy,
  ConnectionTestResult,
  GenerationRequest,
  ProviderConfig,
  ProviderId,
  ResiliencePolicy,
  UsageMetrics,
  VaultAdapter,
} from './types';
import { UsageTracker } from './budget';
import { ProviderRegistry } from './providers/registry';
import {
  createOpenAICompatibleProvider,
  OpenAICompatibleOptions,
} from './providers/openai.provider';
import { VaultManager } from './vault/vault-manager';
import { WebCryptoVaultOptions } from './vault/webcrypto.vault';
import { PassphraseVaultAdapter } from './vault/passphrase.vault';

export interface ByokClientOptions {
  /** Default active provider ID (default: 'gemini') */
  defaultProvider?: ProviderId;
  /** Ordered list of fallback provider IDs if the active provider fails or exceeds quota */
  fallbackProviders?: ProviderId[];
  /** Default vault storage mode ('session' | 'encrypted' | 'passphrase' | custom adapter ID) */
  defaultVaultMode?: string;
  /** Custom options for the built-in WebCrypto AES-GCM-256 vault */
  webCryptoOptions?: WebCryptoVaultOptions;
  /** Custom VaultAdapter implementations */
  customVaultAdapters?: VaultAdapter[];
  /** Custom AIProvider instances */
  customProviders?: AIProvider[];
  /** Declarative OpenAI-compatible provider configurations (e.g. Groq, OpenRouter, DeepSeek) */
  openAICompatibleProviders?: OpenAICompatibleOptions[];
  /** Global resilience policy applied across all providers unless overridden */
  globalResilience?: ResiliencePolicy;
  /** Per-provider resilience and failover policy overrides */
  providerResilience?: Record<string, ResiliencePolicy>;
  /** Session budget limits (max requests, max tokens, max USD cost) */
  budgetPolicy?: BudgetPolicy;
}

export class ByokClient {
  public readonly registry: ProviderRegistry;
  public readonly vault: VaultManager;
  public readonly budget: UsageTracker;
  public readonly passphraseVault: PassphraseVaultAdapter;

  private activeProviderId: ProviderId;
  private fallbackProviders: ProviderId[];
  private globalResilience: ResiliencePolicy;
  private providerResilience: Record<string, ResiliencePolicy>;

  constructor(options: ByokClientOptions = {}) {
    this.registry = ProviderRegistry.getInstance();
    this.passphraseVault = new PassphraseVaultAdapter(options.webCryptoOptions);

    this.vault = new VaultManager({
      defaultMode: options.defaultVaultMode || 'session',
      webCryptoOptions: options.webCryptoOptions,
      customAdapters: [this.passphraseVault, ...(options.customVaultAdapters || [])],
    });

    this.budget = new UsageTracker(options.budgetPolicy);
    this.activeProviderId = options.defaultProvider || 'gemini';
    this.fallbackProviders = options.fallbackProviders || [];
    this.globalResilience = options.globalResilience || {};
    this.providerResilience = options.providerResilience || {};

    if (options.customProviders) {
      for (const provider of options.customProviders) {
        this.registry.register(provider);
      }
    }

    if (options.openAICompatibleProviders) {
      for (const compat of options.openAICompatibleProviders) {
        this.registry.register(createOpenAICompatibleProvider(compat));
      }
    }
  }

  public getActiveProviderId(): ProviderId {
    return this.activeProviderId;
  }

  public setActiveProviderId(id: ProviderId): void {
    if (!this.registry.has(id)) {
      throw new Error(`Provider "${id}" is not registered.`);
    }
    this.activeProviderId = id.toLowerCase();
  }

  public setFallbackProviders(providerIds: ProviderId[]): void {
    this.fallbackProviders = providerIds.map((id) => id.toLowerCase());
  }

  public getFallbackProviders(): ProviderId[] {
    return [...this.fallbackProviders];
  }

  public registerProvider(provider: AIProvider): void {
    this.registry.register(provider);
  }

  public registerOpenAICompatible(options: OpenAICompatibleOptions): void {
    this.registry.register(createOpenAICompatibleProvider(options));
  }

  public registerVaultAdapter(adapter: VaultAdapter): void {
    this.vault.registerAdapter(adapter);
  }

  public setProviderResilience(providerId: ProviderId, policy: ResiliencePolicy): void {
    this.providerResilience[providerId.toLowerCase()] = policy;
  }

  public getUsageMetrics(): UsageMetrics {
    return this.budget.getMetrics();
  }

  public resetUsageMetrics(): void {
    this.budget.resetMetrics();
  }

  private async resolveConfig(
    providerId: ProviderId,
    override?: Partial<ProviderConfig>
  ): Promise<ProviderConfig> {
    const id = providerId.toLowerCase();
    const apiKey =
      override?.apiKey !== undefined ? override.apiKey : await this.vault.getKey(id);

    const mergedResilience: ResiliencePolicy = {
      ...this.globalResilience,
      ...this.providerResilience[id],
      ...override?.resilience,
    };

    return {
      apiKey,
      model: override?.model,
      baseUrl: override?.baseUrl,
      timeoutMs: override?.timeoutMs,
      headers: override?.headers,
      resilience: mergedResilience,
    };
  }

  /**
   * Resolves the ordered list of providers to attempt (primary + configured fallbackProviders).
   */
  private async resolveProviderChain(
    primaryId: ProviderId,
    explicitFallbackIds?: ProviderId[],
    explicitApiKey?: string
  ): Promise<Array<{ provider: AIProvider; apiKey: string }>> {
    const chainIds = [
      primaryId,
      ...(explicitFallbackIds || this.fallbackProviders),
    ].filter((id, idx, arr) => Boolean(id) && arr.indexOf(id) === idx);

    const resolvedChain: Array<{ provider: AIProvider; apiKey: string }> = [];

    for (let i = 0; i < chainIds.length; i++) {
      const id = chainIds[i];
      if (!this.registry.has(id)) continue;
      const provider = this.registry.get(id);
      const apiKey =
        i === 0 && explicitApiKey !== undefined
          ? explicitApiKey
          : await this.vault.getKey(id);

      // Include primary provider (even if key missing so it throws a clear error if alone)
      // or any fallback provider that either requires no key (Ollama) or has a key stored
      if (i === 0 || !provider.requiresKey || apiKey.trim().length > 0) {
        resolvedChain.push({ provider, apiKey });
      }
    }

    return resolvedChain;
  }

  public async generateText(
    request: GenerationRequest,
    options?: Partial<ProviderConfig> & {
      providerId?: ProviderId;
      fallbackProviders?: ProviderId[];
    }
  ): Promise<string> {
    this.budget.assertWithinBudget(request);
    const primaryId = options?.providerId || this.activeProviderId;
    const chain = await this.resolveProviderChain(
      primaryId,
      options?.fallbackProviders,
      options?.apiKey
    );

    let lastError: Error | null = null;
    for (let i = 0; i < chain.length; i++) {
      const { provider, apiKey } = chain[i];
      const config = await this.resolveConfig(provider.id, {
        ...options,
        apiKey,
        // Only apply explicit model/baseUrl override to the primary provider
        model: i === 0 ? options?.model : undefined,
        baseUrl: i === 0 ? options?.baseUrl : undefined,
      });

      try {
        const output = await provider.generateText(request, config);
        this.budget.recordUsage(provider.id, request, output);
        return output;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < chain.length - 1) {
          console.warn(
            `[ByokClient] Provider "${provider.id}" failed (${lastError.message}). Failing over to provider "${chain[i + 1].provider.id}".`
          );
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('All configured AI providers failed.');
  }

  public async generateObject<T = Record<string, unknown>>(
    request: GenerationRequest,
    options?: Partial<ProviderConfig> & {
      providerId?: ProviderId;
      fallbackProviders?: ProviderId[];
    }
  ): Promise<T> {
    this.budget.assertWithinBudget(request);
    const primaryId = options?.providerId || this.activeProviderId;
    const chain = await this.resolveProviderChain(
      primaryId,
      options?.fallbackProviders,
      options?.apiKey
    );

    let lastError: Error | null = null;
    for (let i = 0; i < chain.length; i++) {
      const { provider, apiKey } = chain[i];
      const config = await this.resolveConfig(provider.id, {
        ...options,
        apiKey,
        model: i === 0 ? options?.model : undefined,
        baseUrl: i === 0 ? options?.baseUrl : undefined,
      });

      try {
        const result = await provider.generateObject<T>(request, config);
        this.budget.recordUsage(provider.id, request, JSON.stringify(result));
        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < chain.length - 1) {
          console.warn(
            `[ByokClient] Provider "${provider.id}" failed (${lastError.message}). Failing over to provider "${chain[i + 1].provider.id}".`
          );
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('All configured AI providers failed.');
  }

  /**
   * Streams text chunks from the active provider (with automatic cross-provider failover if stream startup fails).
   */
  public async *generateStream(
    request: GenerationRequest,
    options?: Partial<ProviderConfig> & {
      providerId?: ProviderId;
      fallbackProviders?: ProviderId[];
    }
  ): AsyncGenerator<string, void, unknown> {
    this.budget.assertWithinBudget(request);
    const primaryId = options?.providerId || this.activeProviderId;
    const chain = await this.resolveProviderChain(
      primaryId,
      options?.fallbackProviders,
      options?.apiKey
    );

    let lastError: Error | null = null;
    for (let i = 0; i < chain.length; i++) {
      const { provider, apiKey } = chain[i];
      const config = await this.resolveConfig(provider.id, {
        ...options,
        apiKey,
        model: i === 0 ? options?.model : undefined,
        baseUrl: i === 0 ? options?.baseUrl : undefined,
      });

      try {
        let collected = '';
        if (provider.generateStream) {
          for await (const chunk of provider.generateStream(request, config)) {
            collected += chunk;
            yield chunk;
          }
        } else {
          const fullText = await provider.generateText(request, config);
          collected = fullText;
          yield fullText;
        }
        this.budget.recordUsage(provider.id, request, collected);
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < chain.length - 1) {
          continue;
        }
        throw lastError;
      }
    }

    if (lastError) throw lastError;
  }

  public async testConnection(
    providerId?: ProviderId,
    override?: Partial<ProviderConfig>
  ): Promise<ConnectionTestResult> {
    const id = providerId || this.activeProviderId;
    const provider = this.registry.get(id);
    const config = await this.resolveConfig(id, override);
    return provider.testConnection(config);
  }
}

/**
 * Convenience factory to initialize a ByokClient instance.
 */
export function createByok(options?: ByokClientOptions): ByokClient {
  return new ByokClient(options);
}

