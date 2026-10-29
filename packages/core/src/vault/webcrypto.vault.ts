/**
 * WebCrypto AES-GCM-256 Vault Adapter
 *
 * Provides authenticated AES-GCM-256 at-rest encryption for API keys in browser storage.
 * Derives a non-extractable 256-bit CryptoKey using PBKDF2 with 100,000 SHA-256 iterations,
 * a 128-bit random salt, origin metadata, and an optional user passphrase.
 */

import { VaultAdapter } from '../types.js';

const ENCRYPTION_PREFIX = 'enc:v1:';
const DEFAULT_STORAGE_PREFIX = 'byok_vault_';
const DEFAULT_SALT_KEY = 'byok_sec_salt';

export interface WebCryptoVaultOptions {
  /** Custom key prefix in localStorage (default: 'byok_vault_') */
  storagePrefix?: string;
  /** Custom salt storage key (default: 'byok_sec_salt') */
  saltStorageKey?: string;
  /** Optional storage key mapping (e.g. { gemini: 'my_app_gemini_key' }) for migrating existing storage keys */
  legacyKeyMap?: Record<string, string>;
  /** Optional custom passphrase or application identifier for PBKDF2 key derivation */
  passphrase?: string;
}

export class WebCryptoVaultAdapter implements VaultAdapter {
  public readonly id = 'encrypted';
  public readonly name = 'WebCrypto AES-GCM-256 Persistent Storage';

  private storagePrefix: string;
  private saltStorageKey: string;
  private legacyKeyMap: Record<string, string>;
  private passphrase: string;
  private derivedKeyCache = new Map<string, CryptoKey>();

  constructor(options: WebCryptoVaultOptions = {}) {
    this.storagePrefix = options.storagePrefix || DEFAULT_STORAGE_PREFIX;
    this.saltStorageKey = options.saltStorageKey || DEFAULT_SALT_KEY;
    this.legacyKeyMap = options.legacyKeyMap || {};
    this.passphrase = options.passphrase || 'byok_vault_v1';
  }

  /**
   * Updates the passphrase used for PBKDF2 key derivation and clears cached CryptoKeys.
   */
  public setPassphrase(passphrase: string): void {
    this.passphrase = passphrase || 'byok_vault_v1';
    this.derivedKeyCache.clear();
  }

  /**
   * Wipes cached CryptoKeys from memory.
   */
  public clearKeyCache(): void {
    this.derivedKeyCache.clear();
  }

  private resolveStorageKey(key: string): string {
    return this.legacyKeyMap[key] || `${this.storagePrefix}${key}`;
  }

  public async getSecret(key: string): Promise<string | null> {
    if (typeof localStorage === 'undefined') return null;
    try {
      const storageKey = this.resolveStorageKey(key);
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;

      const decrypted = await this.decryptSecret(raw);
      if (decrypted && !raw.startsWith(ENCRYPTION_PREFIX)) {
        await this.setSecret(key, decrypted);
      }
      return decrypted || null;
    } catch {
      return null;
    }
  }

  public async setSecret(key: string, value: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    const storageKey = this.resolveStorageKey(key);
    const clean = value.trim();
    if (!clean) {
      localStorage.removeItem(storageKey);
      return;
    }

    const encrypted = await this.encryptSecret(clean);
    if (!encrypted || !encrypted.startsWith(ENCRYPTION_PREFIX)) {
      throw new Error('WebCrypto encryption failed: refusing to store plaintext secret.');
    }
    localStorage.setItem(storageKey, encrypted);
  }

  public async deleteSecret(key: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(this.resolveStorageKey(key));
    } catch { }
  }

  public async clearAll(): Promise<void> {
    this.derivedKeyCache.clear();
    if (typeof localStorage === 'undefined') return;
    try {
      for (const legacyKey of Object.values(this.legacyKeyMap)) {
        localStorage.removeItem(legacyKey);
      }
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(this.storagePrefix)) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
    } catch { }
  }

  private getOrCreateSalt(): { bytes: Uint8Array; base64: string } {
    try {
      const existing = localStorage.getItem(this.saltStorageKey);
      if (existing) {
        return {
          bytes: Uint8Array.from(atob(existing), (c) => c.charCodeAt(0)),
          base64: existing,
        };
      }
    } catch { }

    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    const base64Salt = btoa(String.fromCharCode(...newSalt));
    try {
      localStorage.setItem(this.saltStorageKey, base64Salt);
    } catch { }
    return { bytes: newSalt, base64: base64Salt };
  }

  private async deriveStorageKey(includeUserAgentSlice = false): Promise<CryptoKey> {
    const salt = this.getOrCreateSalt();
    const origin =
      typeof window !== 'undefined' && window.location ? window.location.origin : 'local';
    const uaPart =
      includeUserAgentSlice && typeof navigator !== 'undefined'
        ? `:${navigator.userAgent.slice(0, 50)}`
        : '';
    const originEntropy = `${origin}${uaPart}:${this.passphrase}`;
    const cacheId = `${salt.base64}:${originEntropy}`;

    const cached = this.derivedKeyCache.get(cacheId);
    if (cached) {
      return cached;
    }

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(originEntropy) as unknown as BufferSource,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt.bytes as unknown as BufferSource,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.derivedKeyCache.set(cacheId, derivedKey);
    return derivedKey;
  }

  public async encryptSecret(secret: string): Promise<string> {
    if (!secret || secret.trim() === '') return '';
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('WebCrypto API (crypto.subtle) is unavailable in this environment.');
    }

    const key = await this.deriveStorageKey(false);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(secret.trim());

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      encoded as unknown as BufferSource
    );

    const ivBase64 = btoa(String.fromCharCode(...iv));
    const cipherBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));

    return `${ENCRYPTION_PREFIX}${ivBase64}:${cipherBase64}`;
  }

  public async decryptSecret(payload: string): Promise<string> {
    if (!payload || payload.trim() === '') return '';
    if (!payload.startsWith(ENCRYPTION_PREFIX)) {
      return payload.trim();
    }

    const parts = payload.slice(ENCRYPTION_PREFIX.length).split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return '';

    let iv: Uint8Array;
    let ciphertext: Uint8Array;
    try {
      iv = Uint8Array.from(atob(parts[0]), (c) => c.charCodeAt(0));
      ciphertext = Uint8Array.from(atob(parts[1]), (c) => c.charCodeAt(0));
    } catch {
      return '';
    }

    // AES-GCM requires a 12-byte IV and at least a 16-byte authentication tag
    if (iv.byteLength !== 12 || ciphertext.byteLength <= 16) {
      return '';
    }

    try {
      const key = await this.deriveStorageKey(false);
      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        ciphertext as unknown as BufferSource
      );
      return new TextDecoder().decode(decryptedBuffer);
    } catch {
      try {
        const fallbackKey = await this.deriveStorageKey(true);
        const decryptedBuffer = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv as unknown as BufferSource },
          fallbackKey,
          ciphertext as unknown as BufferSource
        );
        return new TextDecoder().decode(decryptedBuffer);
      } catch {
        return '';
      }
    }
  }
}
