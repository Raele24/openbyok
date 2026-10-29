/**
 * openbyok/cli â€” Node.js & Terminal Credential Management
 *
 * Provides:
 * 1. PosixFileVaultAdapter: Stores per-provider keys in ~/.<app>/config.json with strict 0600 file and 0700 dir permissions.
 * 2. Environment Variable Precedence Resolver: Evaluates Explicit CLI Flag > Environment Variable > Stored Per-Provider Key.
 * 3. Terminal Security Helpers: promptMaskedInput(), redactApiKey(), warnIfCliKeyExposed().
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { ProviderId, VaultAdapter } from '../../core/src/index.js';

export interface CliConfigData {
  /** Per-provider API key map (e.g. { gemini: 'AIza...', openai: 'sk-...', claude: 'sk-ant-...' }) */
  keys?: Record<string, string>;
  /** Legacy single API key field (auto-migrated to keys[provider]) */
  apiKey?: string;
  /** Default active provider ID */
  provider?: ProviderId;
  /** Default model name */
  model?: string;
  /** Per-provider model overrides */
  models?: Record<string, string>;
  /** Custom endpoint URL */
  endpoint?: string;
  /** Per-provider endpoint overrides */
  endpoints?: Record<string, string>;
  /** Additional application-specific configuration properties */
  [key: string]: unknown;
}

export interface PosixVaultOptions {
  /** Directory name inside user home (default: '.openbyok') */
  configDirName?: string;
  /** Explicit directory path override */
  configDirPath?: string;
  /** Config file name (default: 'config.json') */
  configFileName?: string;
  /** Custom environment variable map per provider ID */
  envVarMap?: Record<string, string>;
}

export const DEFAULT_ENV_VAR_MAP: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  ollama: 'OLLAMA_API_KEY',
};

/**
 * Redacts an API key for safe terminal display (e.g. "AIza...Z4X2").
 */
export function redactApiKey(key?: string | null): string {
  if (!key) return '(not configured)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Displays a security warning when an API key is passed directly via command-line arguments.
 */
export function warnIfCliKeyExposed(
  hasCliKeyFlag: boolean,
  recommendedEnvVar = 'GEMINI_API_KEY',
  cliBinaryName = 'byok'
): void {
  if (!hasCliKeyFlag) return;
  console.warn(
    '\nSecurity advisory: Passing API keys as command line arguments can expose them in shell history and system process listings.'
  );
  console.warn(
    `Recommended: Use environment variables (e.g. export ${recommendedEnvVar}=...) or interactive input ("${cliBinaryName} set-key").\n`
  );
}

/**
 * Reads a secret interactively from stdin without echoing characters to the terminal.
 * Supports piped stdin for CI/CD automation.
 */
export function promptMaskedInput(promptText = 'Enter API key (input hidden): '): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(promptText, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
      return;
    }

    process.stdout.write(promptText);
    let input = '';

    const onData = (char: Buffer) => {
      const str = char.toString('utf-8');
      for (const c of str) {
        if (c === '\n' || c === '\r' || c === '\u0004') {
          process.stdin.removeListener('data', onData);
          if (process.stdin.isRaw) {
            process.stdin.setRawMode(false);
          }
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(input.trim());
          return;
        }
        if (c === '\u0003') {
          process.exit(1);
        }
        if (c === '\u0008' || c === '\x7f') {
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += c;
        }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/**
 * POSIX Owner-Only File Vault Adapter (`0700` dir, `0600` file).
 * Maintains isolated API keys per provider inside `keys: { [providerId]: string }`
 * and resolves credentials using strict precedence:
 * 1. Explicit CLI flag (`explicitKey`)
 * 2. Environment variable (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
 * 3. Stored provider-specific key (`config.keys[providerId]`)
 * 4. Legacy `config.apiKey` (only if `config.provider` matches `providerId`)
 */
export class PosixFileVaultAdapter implements VaultAdapter {
  public readonly id = 'posix-file';
  public readonly name = 'POSIX 0600 Restricted Config File';

  public readonly configDir: string;
  public readonly configFile: string;
  private readonly envVarMap: Record<string, string>;

  constructor(options: PosixVaultOptions = {}) {
    this.configDir =
      options.configDirPath ||
      path.join(os.homedir(), options.configDirName || '.openbyok');
    this.configFile = path.join(
      this.configDir,
      options.configFileName || 'config.json'
    );
    this.envVarMap = { ...DEFAULT_ENV_VAR_MAP, ...options.envVarMap };
  }

  public loadConfig<T extends CliConfigData = CliConfigData>(): T {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        const parsed = JSON.parse(raw) as T;
        // Migrate legacy single apiKey into keys[provider]
        if (parsed.apiKey && !parsed.keys) {
          const targetProvider = (parsed.provider || 'gemini').toLowerCase();
          parsed.keys = { [targetProvider]: parsed.apiKey };
        }
        return parsed;
      }
    } catch { }
    return {} as T;
  }

  public saveConfig<T extends CliConfigData = CliConfigData>(updates: Partial<T>): T {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
      } else {
        try {
          fs.chmodSync(this.configDir, 0o700);
        } catch { }
      }

      const current = this.loadConfig<T>();
      const mergedKeys: Record<string, string> = {
        ...(current.keys || {}),
        ...(updates.keys || {}),
      };

      const targetProvider = ((updates.provider || current.provider || 'gemini') as string).toLowerCase();
      if (updates.apiKey) {
        mergedKeys[targetProvider] = updates.apiKey;
      }

      const merged: T = {
        ...current,
        ...updates,
        keys: mergedKeys,
      };

      // Keep legacy apiKey synchronized with the active provider's key for backward compatibility
      if (mergedKeys[targetProvider]) {
        merged.apiKey = mergedKeys[targetProvider];
      }

      fs.writeFileSync(this.configFile, JSON.stringify(merged, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        fs.chmodSync(this.configFile, 0o600);
      } catch { }
      return merged;
    } catch (err) {
      console.error('Failed to save configuration:', err);
      return this.loadConfig<T>();
    }
  }

  /**
   * Resolves the API key for a provider following strict security precedence:
   * 1. Explicit CLI flag (`explicitKey`)
   * 2. Environment Variable (`process.env[envVar]`)
   * 3. Stored per-provider key (`config.keys[providerId]`)
   * 4. Legacy `config.apiKey` (only when `config.provider === providerId`)
   */
  public resolveKey(providerId: ProviderId, explicitKey?: string): string {
    if (explicitKey && explicitKey.trim()) {
      return explicitKey.trim();
    }

    const id = providerId.toLowerCase();
    const envVarName = this.envVarMap[id] || `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    const envVal = process.env[envVarName];
    if (envVal && envVal.trim()) {
      return envVal.trim();
    }

    const cfg = this.loadConfig();
    if (cfg.keys && cfg.keys[id]) {
      return cfg.keys[id];
    }

    const savedProvider = (cfg.provider || 'gemini').toLowerCase();
    if (cfg.apiKey && savedProvider === id) {
      return cfg.apiKey;
    }

    return '';
  }

  /**
   * Returns a redacted snapshot of the configuration safe for terminal printing.
   */
  public getRedactedConfig(): Record<string, unknown> {
    const cfg = this.loadConfig();
    const redactedKeys: Record<string, string> = {};
    if (cfg.keys) {
      for (const [k, v] of Object.entries(cfg.keys)) {
        redactedKeys[k] = redactApiKey(v);
      }
    }
    return {
      ...cfg,
      apiKey: redactApiKey(cfg.apiKey),
      keys: redactedKeys,
    };
  }

  public async getSecret(providerId: string): Promise<string | null> {
    const resolved = this.resolveKey(providerId);
    return resolved || null;
  }

  public async setSecret(providerId: string, value: string): Promise<void> {
    const id = providerId.toLowerCase();
    const current = this.loadConfig();
    const keys = { ...(current.keys || {}) };
    if (value.trim()) {
      keys[id] = value.trim();
    } else {
      delete keys[id];
    }
    this.saveConfig({ keys });
  }

  public async deleteSecret(providerId: string): Promise<void> {
    await this.setSecret(providerId, '');
  }

  public async clearAll(): Promise<void> {
    try {
      if (fs.existsSync(this.configFile)) {
        fs.unlinkSync(this.configFile);
      }
    } catch { }
  }
}

