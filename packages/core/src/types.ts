/**
 * openbyok Core Type Definitions
 *
 * Defines interfaces for AI providers, single-turn and multi-turn multimodal requests,
 * structured outputs, streaming, AbortSignal cancellation, per-model and cross-provider
 * resilience policies, budget guards, pluggable credential vaults, and localization.
 */

export type BuiltInProviderId = 'gemini' | 'openai' | 'claude' | 'ollama';
export type ProviderId = BuiltInProviderId | (string & {});

export type SupportedLanguage = 'en' | 'it' | 'fr' | 'es' | 'de' | (string & {});

/**
 * Base64 image input compatible with Browser and Node.js runtimes.
 */
export interface MediaAttachment {
  /** Base64-encoded image data (with or without data URI prefix) */
  data: string;
  /** MIME type, e.g. 'image/jpeg', 'image/png', 'image/webp' */
  mimeType: string;
  /** Optional file name or identifier */
  fileName?: string;
}

/**
 * Role in a multi-turn conversation.
 */
export type ChatRole = 'system' | 'user' | 'assistant';

/**
 * Single message turn in a multi-turn conversation.
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional multimodal images attached to this specific message turn */
  images?: MediaAttachment[];
}

/**
 * Resilience, retry, timeout, and failover configuration per provider or model.
 */
export interface ResiliencePolicy {
  /** Request timeout per model attempt in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Maximum retries on transient errors before failing over to next model (default: 1) */
  maxRetries?: number;
  /** Alias for maxRetries */
  maxRetriesPerModel?: number;
  /** Base delay in milliseconds for exponential backoff between retries (default: 800) */
  retryBackoffMs?: number;
  /** Ordered list of fallback model identifiers to try if primary model fails */
  failoverModels?: string[];
  /** Alias for failoverModels */
  candidateModels?: string[];
  /** HTTP status codes that trigger retry or model failover (default: [400, 404, 408, 429, 500, 502, 503, 504]) */
  failoverStatusCodes?: number[];
  /** Cache and prioritize the last working model for a given key during the session (default: true) */
  rememberWorkingModel?: boolean;
  /** Specific timeout overrides per model name (e.g. { 'gpt-4o': 45000 }) */
  perModelTimeoutMs?: Record<string, number>;
}

/**
 * Session budget and rate-limiting policy to protect user API keys from runaway costs.
 */
export interface BudgetPolicy {
  /** Maximum number of generation requests allowed in the current session */
  maxRequestsPerSession?: number;
  /** Maximum estimated total tokens (input + output) allowed in the current session */
  maxEstimatedTokensPerSession?: number;
  /** Maximum estimated cost in USD allowed in the current session */
  maxCostUsdPerSession?: number;
}

/**
 * Snapshot of token, request, and cost usage tracked by UsageTracker.
 */
export interface UsageMetrics {
  requestCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  estimatedCostUsd: number;
  byProvider: Record<
    string,
    {
      requestCount: number;
      estimatedInputTokens: number;
      estimatedOutputTokens: number;
      estimatedCostUsd: number;
    }
  >;
}

/**
 * Telemetry and lifecycle event emitted by ByokClient and ResilienceExecutor.
 */
export interface ByokLifecycleEvent {
  type: 'retry' | 'model-failover' | 'provider-failover' | 'usage-recorded';
  providerId: ProviderId;
  model?: string;
  nextModel?: string;
  nextProviderId?: ProviderId;
  attempt?: number;
  statusCode?: number;
  message?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type ByokEventListener = (event: ByokLifecycleEvent) => void;

/**
 * Configuration passed to a provider during execution or connection testing.
 */
export interface ProviderConfig {
  /** API key or bearer token (empty string allowed for local providers like Ollama) */
  apiKey: string;
  /** Target model identifier (uses provider default or auto-discovery if omitted) */
  model?: string;
  /** Custom endpoint URL (for Ollama, proxies, or OpenAI-compatible services) */
  baseUrl?: string;
  /** Optional timeout override in milliseconds */
  timeoutMs?: number;
  /** Optional custom HTTP headers */
  headers?: Record<string, string>;
  /** Optional resilience and failover policy override */
  resilience?: ResiliencePolicy;
  /** Optional user-defined predicate to filter model IDs returned by listModels() */
  modelFilter?: (modelId: string) => boolean;
  /** Optional internal callback for emitting resilience telemetry events */
  onEvent?: ByokEventListener;
}

/**
 * Generic multimodal and multi-turn AI generation request.
 * Supports either single-turn `userPrompt` or multi-turn `messages[]` (or both).
 */
export interface GenerationRequest<TSchema = Record<string, unknown>> {
  /** System instructions defining role, rules, and output constraints */
  systemPrompt?: string;
  /** Single-turn user prompt text (optional if `messages` array is provided) */
  userPrompt?: string;
  /** Multi-turn conversation history (`user` / `assistant` / `system` turns with optional per-turn images) */
  messages?: ChatMessage[];
  /** Optional multimodal image attachments for the current user turn */
  images?: MediaAttachment[];
  /** Optional JSON schema object for structured JSON output enforcement */
  jsonSchema?: TSchema;
  /** Optional human-readable schema description appended for providers without native schema objects */
  schemaInstruction?: string;
  /** Sampling temperature (default: 0.2) */
  temperature?: number;
  /** Maximum output tokens (default: 2048) */
  maxTokens?: number;
  /** Target output language code */
  language?: SupportedLanguage;
  /** Optional AbortSignal to cancel in-flight generation or streaming from UI (e.g. Stop button) */
  signal?: AbortSignal;
}

/**
 * Result of a provider connection test.
 */
export interface ConnectionTestResult {
  success: boolean;
  message: string;
  activeModel?: string;
  availableModels?: string[];
}

/**
 * Universal interface that all built-in and custom AI providers implement.
 */
export interface AIProvider {
  /** Unique provider identifier (e.g. 'gemini', 'openai', 'claude', 'ollama', 'groq') */
  readonly id: ProviderId;
  /** Human-readable provider display name */
  readonly name: string;
  /** Whether this provider requires a non-empty API key by default */
  readonly requiresKey: boolean;
  /** Default endpoint URL */
  readonly defaultBaseUrl: string;
  /** Default model identifier */
  readonly defaultModel: string;

  /**
   * Generates raw text or markdown from text/messages and optional images.
   */
  generateText(request: GenerationRequest, config: ProviderConfig): Promise<string>;

  /**
   * Generates and parses a typed JSON object from text/messages and optional images.
   */
  generateObject<T = Record<string, unknown>>(
    request: GenerationRequest,
    config: ProviderConfig
  ): Promise<T>;

  /**
   * Streams text chunks in real time using Server-Sent Events (SSE) or NDJSON.
   */
  generateStream?(
    request: GenerationRequest,
    config: ProviderConfig
  ): AsyncGenerator<string, void, unknown>;

  /**
   * Validates whether the API key and endpoint are reachable and authenticated.
   */
  testConnection(config: ProviderConfig): Promise<ConnectionTestResult>;

  /**
   * Discovers available models for the configured credentials and endpoint.
   */
  listModels(config: ProviderConfig): Promise<string[]>;
}

/**
 * Pluggable credential storage adapter interface.
 */
export interface VaultAdapter {
  /** Unique identifier for this vault mode (e.g. 'session', 'encrypted', 'passphrase', 'posix-file') */
  readonly id: string;
  /** Human-readable label */
  readonly name: string;

  /** Retrieves a stored credential for a specific key/provider */
  getSecret(key: string): Promise<string | null>;
  /** Saves a credential for a specific key/provider */
  setSecret(key: string, value: string): Promise<void>;
  /** Removes a single credential */
  deleteSecret(key: string): Promise<void>;
  /** Purges all stored credentials managed by this adapter */
  clearAll(): Promise<void>;
}

/**
 * Stored metadata for a provider inside the VaultManager.
 */
export interface ProviderSettings {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}
