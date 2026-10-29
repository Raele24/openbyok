/**
 * Vault Manager
 *
 * Orchestrates multiple VaultAdapters (e.g. 'session' MemoryVaultAdapter,
 * 'encrypted' WebCryptoVaultAdapter, or user-supplied custom VaultAdapters).
 * Handles runtime switching between storage modes while keeping in-memory keys synchronized.
 */

import { VaultAdapter } from '../types.js';
import { MemoryVaultAdapter } from './memory.vault.js';
import { WebCryptoVaultAdapter, WebCryptoVaultOptions } from './webcrypto.vault.js';

export type VaultChangeListener = () => void;

export class VaultManager {
  private adapters = new Map<string, VaultAdapter>();
  private activeAdapterId = 'session';
  private memoryCache = new Map<string, string>();
  private listeners = new Set<VaultChangeListener>();

  constructor(options?: {
    defaultMode?: string;
    webCryptoOptions?: WebCryptoVaultOptions;
    customAdapters?: VaultAdapter[];
  }) {
    const memoryAdapter = new MemoryVaultAdapter();
    const webCryptoAdapter = new WebCryptoVaultAdapter(options?.webCryptoOptions);

    this.registerAdapter(memoryAdapter);
    this.registerAdapter(webCryptoAdapter);

    if (options?.customAdapters) {
      for (const adapter of options.customAdapters) {
        this.registerAdapter(adapter);
      }
    }

    if (options?.defaultMode && this.adapters.has(options.defaultMode)) {
      this.activeAdapterId = options.defaultMode;
    }
  }

  /**
   * Registers a custom VaultAdapter (e.g. Tauri Keychain, Capacitor Keystore, IndexedDB).
   */
  public registerAdapter(adapter: VaultAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /**
   * Returns all registered vault adapters.
   */
  public getAdapters(): VaultAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Returns the currently active adapter ID ('session', 'encrypted', or custom).
   */
  public getActiveMode(): string {
    return this.activeAdapterId;
  }

  /**
   * Switches the active vault mode.
   * When switching to 'session', purges persistent adapters to guarantee zero disk residue.
   * When switching to a persistent adapter, persists current in-memory keys to the target adapter.
   */
  public async setMode(modeId: string): Promise<void> {
    const target = this.adapters.get(modeId);
    if (!target) {
      throw new Error(`VaultAdapter "${modeId}" is not registered.`);
    }

    const previousId = this.activeAdapterId;
    this.activeAdapterId = modeId;

    if (modeId === 'session') {
      // Purge all non-session adapters so no secrets remain on disk
      for (const [id, adapter] of this.adapters.entries()) {
        if (id !== 'session') {
          await adapter.clearAll();
        }
      }
    } else if (previousId !== modeId) {
      // Persist current memory cache into the newly selected persistent adapter
      for (const [key, secret] of this.memoryCache.entries()) {
        if (secret) {
          await target.setSecret(key, secret);
        }
      }
    }

    this.notify();
  }

  /**
   * Hydrates keys for the given provider IDs from the active adapter into the fast memory cache.
   */
  public async hydrate(providerIds: string[]): Promise<Record<string, string>> {
    const active = this.adapters.get(this.activeAdapterId);
    if (!active) return {};

    if (this.activeAdapterId === 'session') {
      for (const [id, adapter] of this.adapters.entries()) {
        if (id !== 'session') {
          await adapter.clearAll();
        }
      }
    }

    const hydrated: Record<string, string> = {};
    for (const id of providerIds) {
      const secret = await active.getSecret(id);
      if (secret) {
        this.memoryCache.set(id, secret);
        hydrated[id] = secret;
      }
    }
    this.notify();
    return hydrated;
  }

  /**
   * Synchronous read from the hydrated runtime cache.
   */
  public getCachedKey(providerId: string): string {
    return this.memoryCache.get(providerId) || '';
  }

  /**
   * Asynchronous read directly from the active vault adapter (and updates cache).
   */
  public async getKey(providerId: string): Promise<string> {
    const cached = this.memoryCache.get(providerId);
    if (cached !== undefined) return cached;

    const active = this.adapters.get(this.activeAdapterId);
    if (!active) return '';
    const secret = (await active.getSecret(providerId)) || '';
    this.memoryCache.set(providerId, secret);
    return secret;
  }

  /**
   * Sets a key in memory and writes through to the active vault adapter.
   */
  public async setKey(providerId: string, secret: string): Promise<void> {
    const clean = secret.trim();
    if (clean) {
      this.memoryCache.set(providerId, clean);
    } else {
      this.memoryCache.delete(providerId);
    }

    const active = this.adapters.get(this.activeAdapterId);
    if (active) {
      await active.setSecret(providerId, clean);
    }
    this.notify();
  }

  /**
   * Purges all keys from memory and from every registered adapter.
   */
  public async purgeAll(): Promise<void> {
    this.memoryCache.clear();
    for (const adapter of this.adapters.values()) {
      await adapter.clearAll();
    }
    this.notify();
  }

  /**
   * Subscribes to vault changes. Returns an unsubscribe function.
   */
  public subscribe(listener: VaultChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

