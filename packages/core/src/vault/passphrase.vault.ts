/**
 * Passphrase-Locked WebCrypto Vault Adapter ('passphrase')
 *
 * Derives an AES-GCM-256 encryption key exclusively from a user-entered PIN or Passphrase
 * combined with a random 128-bit salt using 100,000 PBKDF2-SHA256 iterations.
 *
 * Security Properties:
 * - The passphrase is NEVER written to localStorage, sessionStorage, or disk.
 * - Stores an encrypted verification canary ('byok_vault_canary') to validate the passphrase on unlock().
 * - Calling lock() immediately wipes the in-memory passphrase, rendering stored ciphertexts undecryptable
 *   even if the physical disk or browser profile directory is copied.
 */

import { VaultAdapter } from '../types';
import { WebCryptoVaultAdapter, WebCryptoVaultOptions } from './webcrypto.vault';

const CANARY_STORAGE_KEY = 'byok_vault_canary';
const CANARY_PLAINTEXT = 'BYOK_CANARY_VERIFIED_V1';

export class PassphraseVaultAdapter implements VaultAdapter {
  public readonly id = 'passphrase';
  public readonly name = 'User Passphrase / PIN Encrypted Vault (AES-GCM-256)';

  private innerVault: WebCryptoVaultAdapter;
  private unlocked = false;
  private canaryKey: string;

  constructor(options: WebCryptoVaultOptions & { canaryStorageKey?: string } = {}) {
    this.innerVault = new WebCryptoVaultAdapter({
      ...options,
      storagePrefix: options.storagePrefix || 'byok_pin_vault_',
    });
    this.canaryKey = options.canaryStorageKey || CANARY_STORAGE_KEY;
  }

  /**
   * Returns true if the vault is currently locked (no passphrase in memory).
   */
  public isLocked(): boolean {
    return !this.unlocked;
  }

  /**
   * Locks the vault and wipes the passphrase from runtime memory.
   */
  public lock(): void {
    this.unlocked = false;
    this.innerVault.setPassphrase('__locked_vault__');
  }

  /**
   * Unlocks the vault with the user's PIN/passphrase.
   * If a canary already exists on disk, verifies that the passphrase decrypts it.
   * If no canary exists yet, initializes a new canary encrypted with this passphrase.
   */
  public async unlock(passphrase: string): Promise<boolean> {
    const clean = passphrase.trim();
    if (!clean) return false;

    this.innerVault.setPassphrase(clean);

    if (typeof localStorage !== 'undefined') {
      const existingCanary = localStorage.getItem(this.canaryKey);
      if (existingCanary) {
        const decrypted = await this.innerVault.decryptSecret(existingCanary);
        if (decrypted !== CANARY_PLAINTEXT) {
          this.lock();
          return false;
        }
      } else {
        const encryptedCanary = await this.innerVault.encryptSecret(CANARY_PLAINTEXT);
        try {
          localStorage.setItem(this.canaryKey, encryptedCanary);
        } catch { }
      }
    }

    this.unlocked = true;
    return true;
  }

  public async getSecret(key: string): Promise<string | null> {
    if (!this.unlocked) {
      throw new Error('PassphraseVaultAdapter is locked. Call unlock(passphrase) first.');
    }
    return this.innerVault.getSecret(key);
  }

  public async setSecret(key: string, value: string): Promise<void> {
    if (!this.unlocked) {
      throw new Error('PassphraseVaultAdapter is locked. Call unlock(passphrase) first.');
    }
    return this.innerVault.setSecret(key, value);
  }

  public async deleteSecret(key: string): Promise<void> {
    return this.innerVault.deleteSecret(key);
  }

  public async clearAll(): Promise<void> {
    await this.innerVault.clearAll();
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(this.canaryKey);
      } catch { }
    }
    this.lock();
  }
}

