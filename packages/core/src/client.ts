/**
 * ByokClient
 *
 * High-level unified client combining ProviderRegistry, VaultManager, ResiliencePolicies,
 * Cross-Provider Failover cascades, Universal Streaming, Telemetry Events, and Session Budget Guards.
 */

import {
  AIProvider,
  BudgetPolicy,
  ByokEventListener,
  ByokLifecycleEvent,
  ConnectionTestResult,
  GenerationRequest,
  ProviderConfig,
  ProviderId,
  ResiliencePolicy,
  UsageMetrics,
  VaultAdapter,
} from './types.js';
import { UsageTracker } from './budget.js';
import { sanitizeErrorMessage } from './resilience.js';
import { ProviderRegistry } from './providers/registry.js';
import {
  createOpenAICompatibleProvider,
  OpenAICompatibleOptions,
} from './providers/openai.provider.js';
import { VaultManager } from './vault/vault-manager.js';
import { WebCryptoVaultOptions } from './vault/webcrypto.vault.js';
import { PassphraseVaultAdapter, PassphraseVaultOptions } from './vault/passphrase.vault.js';

const PREFERENCES_STORAGE_KEY = 'openbyok_ui_preferences_v1';

export interface ByokClientOptions {
  /** Default active provider ID (default: 'gemini') */
  defaultProvider?: ProviderId;
  /** Ordered list of fallback provider IDs if the active provider fails or exceeds quota */
  fallbackProviders?: ProviderId[];
  /** Default vault storage mode ('session' | 'encrypted' | 'passphrase' | custom adapter ID) */
  defaultVaultMode?: string;
  /** Custom options for the built-in WebCrypto and Passphrase vaults */
  webCryptoOptions?: WebCryptoVaultOptions & PassphraseVaultOptions;
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
  /** Optional per-provider model filters for listModels() */
  providerModelFilters?: Record<string, (modelId: string) => boolean>;
  /** Session budget limits (max requests, max tokens, max USD cost) */
  budgetPolicy?: BudgetPolicy;
  /** Optional telemetry and failover lifecycle event listener */
  onEvent?: ByokEventListener;
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
  private providerModels = new Map<string, string>();
  private providerEndpoints = new Map<string, string>();
  private providerModelFilters = new Map<string, (modelId: string) => boolean>();
  private eventListeners = new Set<ByokEventListener>();

  constructor(options: ByokClientOptions = {}) {
    this.registry = ProviderRegistry.getInstance();
    this.passphraseVault = new PassphraseVaultAdapter(options.webCryptoOptions);

    this.vault = new VaultManager({
      defaultMode: options.defaultVaultMode || 'session',
      webCryptoOptions: options.webCryptoOptions,
      customAdapters: [this.passphraseVault, ...(options.customVaultAdapters || [])],
    });

    this.budget = new UsageTracker(options.budgetPolicy);
    this.activeProviderId = (options.defaultProvider || 'gemini').toLowerCase();
    this.fallbackProviders = (options.fallbackProviders || []).map((id) => id.toLowerCase());
    this.globalResilience = options.globalResilience || {};
    this.providerResilience = options.providerResilience || {};

    if (options.providerModelFilters) {
      for (const [id, fn] of Object.entries(options.providerModelFilters)) {
        this.providerModelFilters.set(id.toLowerCase(), fn);
      }
    }

    if (options.onEvent) {
      this.eventListeners.add(options.onEvent);
    }

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

    this.vault.subscribe(() => {
      this.savePreferencesIfPersistent();
    });
  }

  /**
   * Subscribes to lifecycle events ('retry', 'model-failover', 'provider-failover', 'usage-recorded').
   * Returns an unsubscribe function.
   */
  public onEvent(listener: ByokEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emitEvent(event: ByokLifecycleEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch { }
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
    this.savePreferencesIfPersistent();
  }

  public setProviderModel(providerId: ProviderId, model: string): void {
    const id = providerId.toLowerCase();
    const trimmed = model.trim();
    if (trimmed) {
      this.providerModels.set(id, trimmed);
    } else {
      this.providerModels.delete(id);
    }
    this.savePreferencesIfPersistent();
  }

  public getProviderModel(providerId?: ProviderId): string {
    const id = (providerId || this.activeProviderId).toLowerCase();
    const custom = this.providerModels.get(id);
    if (custom) return custom;
    if (this.registry.has(id)) {
      return this.registry.get(id).defaultModel;
    }
    return '';
  }

  public setProviderEndpoint(providerId: ProviderId, baseUrl: string): void {
    const id = providerId.toLowerCase();
    const trimmed = baseUrl.trim();
    if (trimmed) {
      this.providerEndpoints.set(id, trimmed);
    } else {
      this.providerEndpoints.delete(id);
    }
    this.savePreferencesIfPersistent();
  }

  public getProviderEndpoint(providerId?: ProviderId): string {
    const id = (providerId || this.activeProviderId).toLowerCase();
    const custom = this.providerEndpoints.get(id);
    if (custom) return custom;
    if (this.registry.has(id)) {
      return this.registry.get(id).defaultBaseUrl;
    }
    return '';
  }

  public setProviderModelFilter(
    providerId: ProviderId,
    filterFn?: (modelId: string) => boolean
  ): void {
    const id = providerId.toLowerCase();
    if (filterFn) {
      this.providerModelFilters.set(id, filterFn);
    } else {
      this.providerModelFilters.delete(id);
    }
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

  public setBudgetPolicy(policy: BudgetPolicy): void {
    this.budget.setPolicy(policy);
  }

  public getBudgetPolicy(): BudgetPolicy {
    return this.budget.getPolicy();
  }

  public getUsageMetrics(): UsageMetrics {
    return this.budget.getMetrics();
  }

  public resetUsageMetrics(): void {
    this.budget.resetMetrics();
  }

  /**
   * Restores persisted non-secret UI preferences (vaultMode, activeProvider, custom models/endpoints)
   * and hydrates encrypted API keys from the active persistent vault into memory on app startup.
   */
  public async hydrate(): Promise<Record<string, string>> {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
        if (raw) {
          const prefs = JSON.parse(raw) as {
            vaultMode?: string;
            activeProvider?: string;
            models?: Record<string, string>;
            endpoints?: Record<string, string>;
          };
          if (prefs.vaultMode && prefs.vaultMode !== 'session') {
            await this.vault.setMode(prefs.vaultMode);
          }
          if (prefs.activeProvider && this.registry.has(prefs.activeProvider)) {
            this.activeProviderId = prefs.activeProvider.toLowerCase();
          }
          if (prefs.models && typeof prefs.models === 'object') {
            for (const [k, v] of Object.entries(prefs.models)) {
              if (v) this.providerModels.set(k.toLowerCase(), v);
            }
          }
          if (prefs.endpoints && typeof prefs.endpoints === 'object') {
            for (const [k, v] of Object.entries(prefs.endpoints)) {
              if (v) this.providerEndpoints.set(k.toLowerCase(), v);
            }
          }
        }
      }
    } catch { }

    const allProviderIds = this.registry.getAvailableIds();
    return this.vault.hydrate(allProviderIds);
  }

  private savePreferencesIfPersistent(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const mode = this.vault.getActiveMode();
      if (mode === 'session') {
        window.localStorage.removeItem(PREFERENCES_STORAGE_KEY);
        return;
      }

      const prefs = {
        vaultMode: mode,
        activeProvider: this.activeProviderId,
        models: Object.fromEntries(this.providerModels.entries()),
        endpoints: Object.fromEntries(this.providerEndpoints.entries()),
      };
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
    } catch { }
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

    const resolvedModel = override?.model || this.providerModels.get(id);
    const resolvedBaseUrl = override?.baseUrl || this.providerEndpoints.get(id);
    const resolvedFilter = override?.modelFilter || this.providerModelFilters.get(id);

    return {
      apiKey,
      model: resolvedModel,
      baseUrl: resolvedBaseUrl,
      timeoutMs: override?.timeoutMs,
      headers: override?.headers,
      resilience: mergedResilience,
      modelFilter: resolvedFilter,
      onEvent: (ev) => {
        override?.onEvent?.(ev);
        this.emitEvent(ev);
      },
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

      if (i === 0 || !provider.requiresKey || apiKey.trim().length > 0) {
        resolvedChain.push({ provider, apiKey });
      }
    }

    return resolvedChain;
  }

  private buildFailoverError(errors: string[], lastError: Error | null): Error {
    if (errors.length > 1) {
      return new Error(`All providers failed: ${errors.join(' -> ')}`);
    }
    return lastError || new Error('All configured AI providers failed.');
  }

  public async generateText(
    request: GenerationRequest,
    options?: Partial<ProviderConfig> & {
      providerId?: ProviderId;
      fallbackProviders?: ProviderId[];
    }
  ): Promise<string> {
    const releaseSlot = this.budget.acquireSlot(request);
    try {
      const primaryId = options?.providerId || this.activeProviderId;
      const chain = await this.resolveProviderChain(
        primaryId,
        options?.fallbackProviders,
        options?.apiKey
      );

      let lastError: Error | null = null;
      const errors: string[] = [];

      for (let i = 0; i < chain.length; i++) {
        if (request.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }

        const { provider, apiKey } = chain[i];
        let capturedUsage: { inputTokens?: number; outputTokens?: number } | undefined;

        const config = await this.resolveConfig(provider.id, {
          ...options,
          apiKey,
          model: i === 0 ? options?.model : undefined,
          baseUrl: i === 0 ? options?.baseUrl : undefined,
          onEvent: (ev) => {
            if (ev.type === 'usage-recorded') {
              capturedUsage = {
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
              };
            }
            options?.onEvent?.(ev);
          },
        });

        try {
          const output = await provider.generateText(request, config);
          this.budget.recordUsage(provider.id, request, output, capturedUsage);
          return output;
        } catch (err: unknown) {
          if (
            request.signal?.aborted ||
            (err instanceof Error && err.name === 'AbortError' && request.signal?.aborted)
          ) {
            throw err;
          }
          const rawMsg = err instanceof Error ? err.message : String(err);
          const sanitized = sanitizeErrorMessage(rawMsg, apiKey);
          lastError = new Error(sanitized);
          errors.push(`[${provider.id}: ${sanitized}]`);
          if (i < chain.length - 1) {
            this.emitEvent({
              type: 'provider-failover',
              providerId: provider.id,
              nextProviderId: chain[i + 1].provider.id,
              message: sanitized,
            });
            continue;
          }
          throw this.buildFailoverError(errors, lastError);
        }
      }

      throw this.buildFailoverError(errors, lastError);
    } finally {
      releaseSlot();
    }
  }

  public async generateObject<T = Record<string, unknown>>(
    request: GenerationRequest,
    options?: Partial<ProviderConfig> & {
      providerId?: ProviderId;
      fallbackProviders?: ProviderId[];
    }
  ): Promise<T> {
    const releaseSlot = this.budget.acquireSlot(request);
    try {
      const primaryId = options?.providerId || this.activeProviderId;
      const chain = await this.resolveProviderChain(
        primaryId,
        options?.fallbackProviders,
        options?.apiKey
      );

      let lastError: Error | null = null;
      const errors: string[] = [];

      for (let i = 0; i < chain.length; i++) {
        if (request.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }

        const { provider, apiKey } = chain[i];
        let capturedUsage: { inputTokens?: number; outputTokens?: number } | undefined;

        const config = await this.resolveConfig(provider.id, {
          ...options,
          apiKey,
          model: i === 0 ? options?.model : undefined,
          baseUrl: i === 0 ? options?.baseUrl : undefined,
          onEvent: (ev) => {
            if (ev.type === 'usage-recorded') {
              capturedUsage = {
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
              };
            }
            options?.onEvent?.(ev);
          },
        });

        try {
          const result = await provider.generateObject<T>(request, config);
          this.budget.recordUsage(
            provider.id,
            request,
            JSON.stringify(result),
            capturedUsage
          );
          return result;
        } catch (err: unknown) {
          if (
            request.signal?.aborted ||
            (err instanceof Error && err.name === 'AbortError' && request.signal?.aborted)
          ) {
            throw err;
          }
          const rawMsg = err instanceof Error ? err.message : String(err);
          const sanitized = sanitizeErrorMessage(rawMsg, apiKey);
          lastError = new Error(sanitized);
          errors.push(`[${provider.id}: ${sanitized}]`);
          if (i < chain.length - 1) {
            this.emitEvent({
              type: 'provider-failover',
              providerId: provider.id,
              nextProviderId: chain[i + 1].provider.id,
              message: sanitized,
            });
            continue;
          }
          throw this.buildFailoverError(errors, lastError);
        }
      }

      throw this.buildFailoverError(errors, lastError);
    } finally {
      releaseSlot();
    }
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
    const releaseSlot = this.budget.acquireSlot(request);
    try {
      const primaryId = options?.providerId || this.activeProviderId;
      const chain = await this.resolveProviderChain(
        primaryId,
        options?.fallbackProviders,
        options?.apiKey
      );

      let lastError: Error | null = null;
      const errors: string[] = [];

      for (let i = 0; i < chain.length; i++) {
        if (request.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }

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
          if (
            request.signal?.aborted ||
            (err instanceof Error && err.name === 'AbortError' && request.signal?.aborted)
          ) {
            throw err;
          }
          const rawMsg = err instanceof Error ? err.message : String(err);
          const sanitized = sanitizeErrorMessage(rawMsg, apiKey);
          lastError = new Error(sanitized);
          errors.push(`[${provider.id}: ${sanitized}]`);
          if (i < chain.length - 1) {
            this.emitEvent({
              type: 'provider-failover',
              providerId: provider.id,
              nextProviderId: chain[i + 1].provider.id,
              message: sanitized,
            });
            continue;
          }
          throw this.buildFailoverError(errors, lastError);
        }
      }

      if (lastError) {
        throw this.buildFailoverError(errors, lastError);
      }
    } finally {
      releaseSlot();
    }
  }

  /**
   * Queries the target provider for all live available model IDs using the stored or overridden credentials.
   */
  public async listModels(
    providerId?: ProviderId,
    override?: Partial<ProviderConfig>
  ): Promise<string[]> {
    const id = providerId || this.activeProviderId;
    const provider = this.registry.get(id);
    const config = await this.resolveConfig(id, override);
    return provider.listModels(config);
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
