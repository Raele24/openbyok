/**
 * Passphrase-Locked WebCrypto Vault Adapter ('passphrase')
 *
 * Derives an AES-GCM-256 encryption key exclusively from a user-entered PIN or Passphrase
 * combined with a random 128-bit salt using 100,000 PBKDF2-SHA256 iterations.
 *
 * Security Properties:
 * - The passphrase is NEVER written to localStorage, sessionStorage, or disk.
 * - Stores an encrypted verification canary ('byok_vault_canary') to validate the passphrase on unlock().
 * - Includes brute-force rate limiting: locks out unlock() attempts with exponential backoff after
 *   consecutive failed PIN attempts.
 * - Calling lock() immediately wipes the in-memory passphrase and derived CryptoKey cache.
 */

import { VaultAdapter } from '../types.js';
import { WebCryptoVaultAdapter, WebCryptoVaultOptions } from './webcrypto.vault.js';

const CANARY_STORAGE_KEY = 'byok_vault_canary';
const CANARY_PLAINTEXT = 'BYOK_CANARY_VERIFIED_V1';

export interface PassphraseVaultOptions extends WebCryptoVaultOptions {
  canaryStorageKey?: string;
  /** Maximum consecutive failed unlock attempts before temporary lockout (default: 5) */
  maxFailedAttempts?: number;
  /** Base lockout cooldown in milliseconds when maxFailedAttempts is reached (default: 5000) */
  lockoutCooldownMs?: number;
}

export class PassphraseVaultAdapter implements VaultAdapter {
  public readonly id = 'passphrase';
  public readonly name = 'User Passphrase / PIN Encrypted Vault (AES-GCM-256)';

  private innerVault: WebCryptoVaultAdapter;
  private unlocked = false;
  private canaryKey: string;
  private failedAttempts = 0;
  private lockedUntil = 0;
  private maxFailedAttempts: number;
  private lockoutCooldownMs: number;

  constructor(options: PassphraseVaultOptions = {}) {
    this.innerVault = new WebCryptoVaultAdapter({
      ...options,
      storagePrefix: options.storagePrefix || 'byok_pin_vault_',
    });
    this.canaryKey = options.canaryStorageKey || CANARY_STORAGE_KEY;
    this.maxFailedAttempts = options.maxFailedAttempts ?? 5;
    this.lockoutCooldownMs = options.lockoutCooldownMs ?? 5000;
  }

  /**
   * Returns true if the vault is currently locked (no passphrase in memory).
   */
  public isLocked(): boolean {
    return !this.unlocked;
  }

  /**
   * Returns the number of consecutive failed unlock attempts.
   */
  public getFailedAttempts(): number {
    return this.failedAttempts;
  }

  /**
   * Returns remaining brute-force lockout time in milliseconds (0 if not locked out).
   */
  public getRemainingLockoutMs(): number {
    return Math.max(0, this.lockedUntil - Date.now());
  }

  /**
   * Locks the vault and wipes the passphrase and derived CryptoKey from runtime memory.
   */
  public lock(): void {
    this.unlocked = false;
    this.innerVault.setPassphrase('__locked_vault__');
    this.innerVault.clearKeyCache();
  }

  /**
   * Unlocks the vault with the user's PIN/passphrase.
   * Enforces brute-force lockout cooldown after maxFailedAttempts consecutive failures.
   */
  public async unlock(passphrase: string): Promise<boolean> {
    const remainingLockout = this.getRemainingLockoutMs();
    if (remainingLockout > 0) {
      throw new Error(
        `Too many failed PIN attempts. Vault is temporarily locked for ${Math.ceil(remainingLockout / 1000)}s.`
      );
    }

    const clean = passphrase.trim();
    if (!clean) return false;

    this.innerVault.setPassphrase(clean);

    if (typeof localStorage !== 'undefined') {
      const existingCanary = localStorage.getItem(this.canaryKey);
      if (existingCanary) {
        const decrypted = await this.innerVault.decryptSecret(existingCanary);
        if (decrypted !== CANARY_PLAINTEXT) {
          this.failedAttempts += 1;
          if (this.failedAttempts >= this.maxFailedAttempts) {
            const multiplier = Math.pow(2, this.failedAttempts - this.maxFailedAttempts);
            this.lockedUntil = Date.now() + this.lockoutCooldownMs * multiplier;
          }
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

    this.failedAttempts = 0;
    this.lockedUntil = 0;
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
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    this.lock();
  }
}
