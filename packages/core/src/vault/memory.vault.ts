/**
 * Memory Vault Adapter (Default Tier 1)
 *
 * Stores credentials strictly in volatile JavaScript runtime memory.
 * Zero disk writes, zero localStorage traces. All secrets are cleared when the tab or process exits.
 */

import { VaultAdapter } from '../types.js';

export class MemoryVaultAdapter implements VaultAdapter {
  public readonly id = 'session';
  public readonly name = 'Session Memory (Volatile RAM)';
  private store = new Map<string, string>();

  public async getSecret(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  public async setSecret(key: string, value: string): Promise<void> {
    const clean = value.trim();
    if (!clean) {
      this.store.delete(key);
    } else {
      this.store.set(key, clean);
    }
  }

  public async deleteSecret(key: string): Promise<void> {
    this.store.delete(key);
  }

  public async clearAll(): Promise<void> {
    this.store.clear();
  }
}

