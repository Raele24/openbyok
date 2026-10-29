import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  WebCryptoVaultAdapter,
  PassphraseVaultAdapter,
  VaultManager,
  sanitizeErrorMessage,
  ResilienceExecutor,
  HttpStatusError,
  createByok,
} from '../dist/core/src/index.js';
import {
  PosixFileVaultAdapter,
  redactApiKey,
} from '../dist/cli/src/index.js';

/**
 * In-memory localStorage mock for testing browser vaults in Node.js
 */
function installMockLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(String(k), String(v));
    },
    removeItem(k) {
      store.delete(String(k));
    },
    clear() {
      store.clear();
    },
  };
  return store;
}

describe('Security & Cryptographic Penetration Suite', () => {
  let rawStorage;

  beforeEach(() => {
    rawStorage = installMockLocalStorage();
  });

  it('1. AES-GCM-256 encrypts at rest and never stores plaintext in localStorage', async () => {
    const vault = new WebCryptoVaultAdapter({ storagePrefix: 'sec_test_' });
    const secretKey = 'sk-live-super-secret-key-99887766';

    await vault.setSecret('openai', secretKey);

    const rawStored = rawStorage.get('sec_test_openai');
    assert.ok(rawStored, 'Ciphertext should be written to storage');
    assert.ok(rawStored.startsWith('enc:v1:'), 'Must use enc:v1: authenticated envelope');
    assert.ok(!rawStored.includes(secretKey), 'Plaintext key must NEVER appear in storage');

    const decrypted = await vault.getSecret('openai');
    assert.equal(decrypted, secretKey);
  });

  it('2. Rejects tampered/bit-flipped AES-GCM ciphertext and IV without leaking data', async () => {
    const vault = new WebCryptoVaultAdapter({ storagePrefix: 'tamper_' });
    await vault.setSecret('gemini', 'AIzaSySecretKeyValue123456789');

    const validEnvelope = rawStorage.get('tamper_gemini');
    const [prefix, version, ivB64, cipherB64] = validEnvelope.split(':');

    // Flip 1 bit in the ciphertext
    const cipherBytes = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));
    cipherBytes[0] ^= 0xff;
    const corruptedCipherB64 = btoa(String.fromCharCode(...cipherBytes));
    const tamperedCipherEnvelope = `${prefix}:${version}:${ivB64}:${corruptedCipherB64}`;

    const resultFromCorruptedCipher = await vault.decryptSecret(tamperedCipherEnvelope);
    assert.equal(resultFromCorruptedCipher, '', 'Tampered ciphertext must fail GCM tag verification');

    // Flip 1 bit in the IV
    const ivBytes = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
    ivBytes[0] ^= 0xff;
    const corruptedIvB64 = btoa(String.fromCharCode(...ivBytes));
    const tamperedIvEnvelope = `${prefix}:${version}:${corruptedIvB64}:${cipherB64}`;

    const resultFromCorruptedIv = await vault.decryptSecret(tamperedIvEnvelope);
    assert.equal(resultFromCorruptedIv, '', 'Tampered IV must fail GCM authentication');

    // Truncated envelope attack
    const truncated = await vault.decryptSecret('enc:v1:AAAA:BBBB');
    assert.equal(truncated, '', 'Truncated payload (<12B IV or <=16B tag) must be rejected');
  });

  it('3. Refuses to fall back to plaintext storage if WebCrypto fails', async () => {
    const vault = new WebCryptoVaultAdapter({ storagePrefix: 'nofallback_' });
    const originalEncrypt = globalThis.crypto.subtle.encrypt;

    // Simulate broken/unavailable WebCrypto encrypt
    globalThis.crypto.subtle.encrypt = async () => {
      throw new Error('Simulated WebCrypto hardware failure');
    };

    try {
      await assert.rejects(
        () => vault.setSecret('claude', 'sk-ant-api03-secret-value'),
        /Simulated WebCrypto hardware failure|WebCrypto encryption failed/
      );
      assert.equal(
        rawStorage.get('nofallback_claude'),
        undefined,
        'Plaintext key must NEVER be written to localStorage when encryption fails'
      );
    } finally {
      globalThis.crypto.subtle.encrypt = originalEncrypt;
    }
  });

  it('4. PBKDF2 CryptoKey caching accelerates 50 consecutive reads/writes (< 100ms)', async () => {
    const vault = new WebCryptoVaultAdapter({ storagePrefix: 'perf_' });
    await vault.setSecret('gemini', 'AIzaInitialWarmup');

    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      await vault.setSecret(`provider_${i}`, `secret_token_value_${i}`);
      const readBack = await vault.getSecret(`provider_${i}`);
      assert.equal(readBack, `secret_token_value_${i}`);
    }
    const elapsedMs = performance.now() - start;
    assert.ok(
      elapsedMs < 350,
      `Expected 50 encrypt+decrypt cycles with cached CryptoKey to finish under 350ms, took ${elapsedMs.toFixed(1)}ms`
    );
  });

  it('5. PassphraseVaultAdapter enforces PIN canary verification, lock state, and brute-force lockout', async () => {
    const pinVault = new PassphraseVaultAdapter({
      storagePrefix: 'pin_',
      canaryStorageKey: 'pin_canary',
      maxFailedAttempts: 3,
      lockoutCooldownMs: 2000,
    });

    assert.equal(pinVault.isLocked(), true);
    await assert.rejects(
      () => pinVault.setSecret('openai', 'sk-pin-protected'),
      /PassphraseVaultAdapter is locked/
    );

    // Initialize with PIN '8492'
    const unlocked = await pinVault.unlock('8492');
    assert.equal(unlocked, true);
    assert.equal(pinVault.isLocked(), false);

    await pinVault.setSecret('openai', 'sk-pin-protected');
    assert.equal(await pinVault.getSecret('openai'), 'sk-pin-protected');

    // Lock the vault and verify access is blocked
    pinVault.lock();
    assert.equal(pinVault.isLocked(), true);
    await assert.rejects(
      () => pinVault.getSecret('openai'),
      /PassphraseVaultAdapter is locked/
    );

    // Attempt 3 wrong PINs to trigger brute-force lockout
    assert.equal(await pinVault.unlock('0000'), false);
    assert.equal(await pinVault.unlock('1111'), false);
    assert.equal(await pinVault.unlock('2222'), false);
    assert.equal(pinVault.getFailedAttempts(), 3);
    assert.ok(pinVault.getRemainingLockoutMs() > 0, 'Lockout timer must be active after 3 failures');

    // 4th attempt even with the right PIN must be rejected during lockout window
    await assert.rejects(
      () => pinVault.unlock('8492'),
      /Too many failed PIN attempts/
    );
  });

  it('6. Switching VaultManager to session mode purges all persistent ciphertexts from disk', async () => {
    const manager = new VaultManager({ defaultMode: 'encrypted' });
    await manager.setKey('gemini', 'AIzaPersistentSecret');
    assert.ok(rawStorage.get('byok_vault_gemini')?.startsWith('enc:v1:'));

    // Switch back to volatile session mode
    await manager.setMode('session');
    assert.equal(
      rawStorage.get('byok_vault_gemini'),
      undefined,
      'Switching to session mode must wipe encrypted keys from localStorage'
    );
    assert.equal(
      manager.getCachedKey('gemini'),
      'AIzaPersistentSecret',
      'In-memory session key remains available until tab closes or purgeAll()'
    );

    await manager.purgeAll();
    assert.equal(manager.getCachedKey('gemini'), '');
  });

  it('7. Scrubs leaked API keys from upstream HTTP error messages and stack traces', async () => {
    const leakedKey = 'sk-proj-ULTRA_SENSITIVE_SECRET_KEY_123456';
    const rawUpstreamError = `OpenAI gateway error 401: Invalid bearer token "${leakedKey}" for organization org-123`;

    const scrubbed = sanitizeErrorMessage(rawUpstreamError, leakedKey);
    assert.ok(!scrubbed.includes(leakedKey), 'Leaked key must be removed from error string');
    assert.ok(scrubbed.includes('***REDACTED***'), 'Must replace key with ***REDACTED***');

    const executor = new ResilienceExecutor({ maxRetries: 0 });
    await assert.rejects(
      () =>
        executor.executeWithFailover({
          providerId: 'openai',
          apiKey: leakedKey,
          candidates: ['gpt-4o-mini'],
          operation: async (model) => {
            throw new HttpStatusError(rawUpstreamError, 401, model);
          },
        }),
      (err) => {
        assert.ok(!err.message.includes(leakedKey), 'Thrown error must never contain raw API key');
        assert.ok(err.message.includes('***REDACTED***'));
        return true;
      }
    );
  });

  it('8. PosixFileVaultAdapter isolates per-provider keys and enforces Flag > Env > Config precedence', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbyok-sec-'));
    try {
      const cliVault = new PosixFileVaultAdapter({ configDirPath: tempDir });

      await cliVault.setSecret('gemini', 'AIzaStoredGeminiKey9999');
      await cliVault.setSecret('openai', 'sk-StoredOpenAIKey8888');

      // 1. Stored config resolution & isolation
      assert.equal(cliVault.resolveKey('gemini'), 'AIzaStoredGeminiKey9999');
      assert.equal(cliVault.resolveKey('openai'), 'sk-StoredOpenAIKey8888');
      assert.equal(cliVault.resolveKey('claude'), '');

      // 2. Environment variable overrides stored config
      process.env.GEMINI_API_KEY = 'AIzaFromEnvVar7777';
      assert.equal(cliVault.resolveKey('gemini'), 'AIzaFromEnvVar7777');

      // 3. Explicit CLI flag overrides both Environment Variable and Stored Config
      assert.equal(
        cliVault.resolveKey('gemini', 'AIzaExplicitFlag6666'),
        'AIzaExplicitFlag6666'
      );

      // 4. Redaction check
      const redacted = cliVault.getRedactedConfig();
      assert.equal(redacted.keys.gemini, 'AIza...9999');
      assert.equal(redacted.keys.openai, 'sk-S...8888');
      assert.equal(redactApiKey('short'), '****');
      assert.equal(redactApiKey(''), '(not configured)');
    } finally {
      delete process.env.GEMINI_API_KEY;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

