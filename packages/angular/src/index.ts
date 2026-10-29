/**
 * openbyok/angular â€” Angular Signals Bridge for openbyok/core
 *
 * Allows any Angular application (Angular 16+) to bind its Signal primitives
 * (`signal`, `computed`) to a `ByokClient` or `VaultManager` without coupling
 * `openbyok/angular` to a specific Angular compiler version at build time.
 */

import {
  ByokClient,
  ByokClientOptions,
  ProviderId,
  VaultManager,
} from '../../core/src/index.js';

export interface SignalLike<T> {
  (): T;
  set(value: T): void;
}

export interface AngularSignalPrimitives {
  signal: <T>(initialValue: T) => SignalLike<T>;
  computed: <T>(computation: () => T) => () => T;
}

/**
 * Creates a reactive Angular Signals store backed by `openbyok/core` VaultManager.
 */
export function createByokSignalStore(
  primitives: AngularSignalPrimitives,
  clientOptions?: ByokClientOptions
) {
  const client = new ByokClient(clientOptions);
  const vault: VaultManager = client.vault;

  const storageMode = primitives.signal<string>(vault.getActiveMode());
  const selectedProvider = primitives.signal<ProviderId>(client.getActiveProviderId());

  const geminiKey = primitives.signal<string>('');
  const openaiKey = primitives.signal<string>('');
  const claudeKey = primitives.signal<string>('');
  const ollamaKey = primitives.signal<string>('');
  const customKeys = primitives.signal<Record<string, string>>({});

  const syncFromVault = () => {
    storageMode.set(vault.getActiveMode());
    geminiKey.set(vault.getCachedKey('gemini'));
    openaiKey.set(vault.getCachedKey('openai'));
    claudeKey.set(vault.getCachedKey('claude'));
    ollamaKey.set(vault.getCachedKey('ollama'));

    const allIds = client.registry.getAvailableIds();
    const extras: Record<string, string> = {};
    for (const id of allIds) {
      extras[id] = vault.getCachedKey(id);
    }
    customKeys.set(extras);
  };

  vault.subscribe(syncFromVault);

  const activeApiKey = primitives.computed(() => {
    const provider = selectedProvider();
    if (provider === 'ollama') return ollamaKey();
    if (provider === 'claude') return claudeKey();
    if (provider === 'openai') return openaiKey();
    if (provider === 'gemini') return geminiKey();
    return customKeys()[provider] || '';
  });

  const hasApiKey = primitives.computed(() => {
    const providerId = selectedProvider();
    if (!client.registry.has(providerId)) return false;
    const provider = client.registry.get(providerId);
    if (!provider.requiresKey) return true;
    return activeApiKey().trim().length > 0;
  });

  return {
    client,
    vault,
    storageMode,
    selectedProvider,
    geminiKey,
    openaiKey,
    claudeKey,
    ollamaKey,
    customKeys,
    activeApiKey,
    hasApiKey,
    hydrate: async () => {
      const ids = client.registry.getAvailableIds();
      await vault.hydrate(ids);
      syncFromVault();
    },
    setMode: async (mode: string) => {
      await vault.setMode(mode);
    },
    setKey: async (providerId: ProviderId, key: string) => {
      await vault.setKey(providerId, key);
    },
    purgeAll: async () => {
      await vault.purgeAll();
    },
  };
}

