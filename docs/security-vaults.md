# Security Architecture & Custom Vault Adapters

`openbyok` is designed for client-side and CLI applications where users supply their own AI provider credentials or connect to local models.

---

## 1. Built-In Browser Vaults (`openbyok`)

### Tier 1: `MemoryVaultAdapter` (`id: 'session'`) â€” Default
- Stores credentials strictly in a private JavaScript `Map` in volatile RAM.
- Switching to `session` mode automatically purges any previously stored ciphertext from `localStorage`.
- Closing the browser tab destroys all keys in memory.

### Tier 2: `WebCryptoVaultAdapter` (`id: 'encrypted'`)
- Encrypts credentials before writing to `localStorage` using `crypto.subtle` AES-GCM-256.
- Derives the 256-bit key via PBKDF2 with 100,000 SHA-256 iterations using origin metadata, a 128-bit random salt, and an application or user passphrase.

### Tier 3: `PassphraseVaultAdapter` (`id: 'passphrase'`)
- Encrypts credentials using an AES-GCM-256 key derived from a user-entered PIN or passphrase via PBKDF2 (100,000 SHA-256 iterations) and a 128-bit random salt.
- Verifies the passphrase on `unlock(pin)` against an encrypted canary block (`byok_vault_canary`).
- The passphrase is never stored on disk; calling `lock()` immediately clears the derived key from memory.

---

## 2. Built-In Node / CLI Vault (`openbyok/cli`)

### `PosixFileVaultAdapter` (`id: 'posix-file'`)
- Stores credentials in `~/.<app>/config.json` with directory mode `0700` and file mode `0600` (owner read/write only).
- Stores keys in a per-provider dictionary (`keys: { gemini: '...', openai: '...', claude: '...' }`) so switching providers via CLI flags never overwrites another provider's key.
- Enforces strict resolution priority:
  1. Explicit CLI flag (`--key`)
  2. Environment variable (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY`)
  3. Per-provider stored key (`config.keys[providerId]`)

---

## 3. Implementing a Custom `VaultAdapter`

You can register custom storage backends (such as IndexedDB, encrypted cloud sync, or native OS keychains) by implementing `VaultAdapter`:

```typescript
import { VaultAdapter, createByok } from 'openbyok';

export class IndexedDbVault implements VaultAdapter {
  public readonly id = 'indexed-db';
  public readonly name = 'IndexedDB Encrypted Store';

  public async getSecret(key: string): Promise<string | null> {
    // Custom read implementation
    return null;
  }

  public async setSecret(key: string, value: string): Promise<void> {
    // Custom write implementation
  }

  public async deleteSecret(key: string): Promise<void> {
    // Custom delete implementation
  }

  public async clearAll(): Promise<void> {
    // Custom clear implementation
  }
}

const client = createByok({
  customVaultAdapters: [new IndexedDbVault()],
  defaultVaultMode: 'indexed-db',
});
```
