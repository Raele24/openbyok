/**
 * Resilience Executor
 *
 * Provides configurable per-model timeouts, external AbortSignal propagation,
 * exponential backoff retries, automatic model candidate failover, session working-model caching,
 * and automatic API key scrubbing from error messages.
 */

import {
  ByokEventListener,
  ChatMessage,
  GenerationRequest,
  MediaAttachment,
  ResiliencePolicy,
} from './types.js';

export const DEFAULT_RESILIENCE_POLICY: Required<
  Omit<ResiliencePolicy, 'perModelTimeoutMs' | 'candidateModels' | 'maxRetriesPerModel'>
> = {
  timeoutMs: 30000,
  maxRetries: 1,
  retryBackoffMs: 800,
  failoverModels: [],
  failoverStatusCodes: [400, 404, 408, 429, 500, 502, 503, 504],
  rememberWorkingModel: true,
};

/**
 * Scrubs any raw API key occurrence from error messages or upstream HTTP responses
 * so secrets are never leaked into console logs, stack traces, or UI alerts.
 */
export function sanitizeErrorMessage(message: string, apiKey?: string): string {
  if (!message) return '';
  let sanitized = message;
  const cleanKey = (apiKey || '').trim();
  if (cleanKey.length >= 6 && cleanKey !== 'local') {
    sanitized = sanitized.split(cleanKey).join('***REDACTED***');
  }
  return sanitized;
}

/**
 * Normalizes a GenerationRequest into an ordered list of ChatMessages and a combined system prompt.
 * Supports both single-turn (`userPrompt` + `images`) and multi-turn (`messages[]`).
 */
export function normalizeRequestMessages(request: GenerationRequest): {
  systemInstruction: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string; images: MediaAttachment[] }>;
} {
  const systemParts: string[] = [];
  if (request.systemPrompt?.trim()) {
    systemParts.push(request.systemPrompt.trim());
  }
  if (request.schemaInstruction?.trim()) {
    systemParts.push(request.schemaInstruction.trim());
  }

  const turns: Array<{ role: 'user' | 'assistant'; content: string; images: MediaAttachment[] }> = [];

  if (Array.isArray(request.messages) && request.messages.length > 0) {
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        if (msg.content?.trim()) {
          systemParts.push(msg.content.trim());
        }
      } else {
        turns.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content || '',
          images: msg.images ? [...msg.images] : [],
        });
      }
    }
  }

  // If userPrompt is also provided (or no messages[] were provided), append it as the final user turn
  if (request.userPrompt !== undefined && request.userPrompt !== '') {
    turns.push({
      role: 'user',
      content: request.userPrompt,
      images: request.images ? [...request.images] : [],
    });
  } else if (request.images && request.images.length > 0) {
    // Attach top-level request.images to the last user turn if present, or create a user turn
    let attached = false;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user') {
        turns[i].images.push(...request.images);
        attached = true;
        break;
      }
    }
    if (!attached) {
      turns.push({
        role: 'user',
        content: '',
        images: [...request.images],
      });
    }
  }

  return {
    systemInstruction: systemParts.join('\n\n'),
    turns,
  };
}

/**
 * Parses a structured JSON object or array from an AI model text response,
 * tolerating markdown code fences and surrounding conversational text.
 */
export function parseStructuredJson<T = Record<string, unknown>>(rawText: string): T {
  let clean = (rawText || '').trim();
  if (!clean) {
    throw new Error('Cannot parse JSON from empty AI response.');
  }

  clean = clean
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(clean) as T;
  } catch {
    // Attempt to isolate the outermost JSON object {...} or array [...]
    const firstObj = clean.indexOf('{');
    const lastObj = clean.lastIndexOf('}');
    const firstArr = clean.indexOf('[');
    const lastArr = clean.lastIndexOf(']');

    let candidate = '';
    if (
      firstObj !== -1 &&
      lastObj > firstObj &&
      (firstArr === -1 || firstObj < firstArr)
    ) {
      candidate = clean.slice(firstObj, lastObj + 1);
    } else if (firstArr !== -1 && lastArr > firstArr) {
      candidate = clean.slice(firstArr, lastArr + 1);
    }

    if (candidate) {
      try {
        return JSON.parse(candidate) as T;
      } catch { }
    }

    throw new Error(
      `Failed to parse structured JSON output from AI response: ${rawText.slice(0, 160)}`
    );
  }
}

export class HttpStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly model: string
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export class ResilienceExecutor {
  private workingModelCache = new Map<string, string>();
  private failedModelsInSession = new Set<string>();

  constructor(private globalPolicy: ResiliencePolicy = {}) {}

  public setGlobalPolicy(policy: ResiliencePolicy): void {
    this.globalPolicy = { ...this.globalPolicy, ...policy };
  }

  public getMergedPolicy(
    override?: ResiliencePolicy
  ): Required<
    Omit<ResiliencePolicy, 'perModelTimeoutMs' | 'candidateModels' | 'maxRetriesPerModel'>
  > & {
    perModelTimeoutMs?: Record<string, number>;
  } {
    const mergedFailover =
      override?.failoverModels ??
      override?.candidateModels ??
      this.globalPolicy.failoverModels ??
      this.globalPolicy.candidateModels ??
      [];
    const mergedRetries =
      override?.maxRetries ??
      override?.maxRetriesPerModel ??
      this.globalPolicy.maxRetries ??
      this.globalPolicy.maxRetriesPerModel ??
      DEFAULT_RESILIENCE_POLICY.maxRetries;

    return {
      ...DEFAULT_RESILIENCE_POLICY,
      ...this.globalPolicy,
      ...override,
      maxRetries: mergedRetries,
      failoverModels: mergedFailover,
      failoverStatusCodes:
        override?.failoverStatusCodes ??
        this.globalPolicy.failoverStatusCodes ??
        DEFAULT_RESILIENCE_POLICY.failoverStatusCodes,
    };
  }

  /**
   * Orders candidate models by prioritizing the last known working model
   * and demoting models that failed earlier in the current session.
   */
  public resolveCandidateModels(
    providerId: string,
    apiKey: string,
    primaryCandidates: string[],
    overridePolicy?: ResiliencePolicy
  ): string[] {
    const policy = this.getMergedPolicy(overridePolicy);
    const combined = [...primaryCandidates, ...policy.failoverModels].filter(
      (m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx
    );

    if (combined.length === 0) return [];

    const cacheKey = `${providerId}:${apiKey.slice(-6)}`;
    const lastWorking = policy.rememberWorkingModel ? this.getWorkingModel(cacheKey) : null;

    let ordered = [...combined];
    if (
      lastWorking &&
      ordered.includes(lastWorking) &&
      !this.failedModelsInSession.has(`${providerId}:${lastWorking}`)
    ) {
      ordered = [lastWorking, ...ordered.filter((c) => c !== lastWorking)];
    }

    const healthy = ordered.filter((m) => !this.failedModelsInSession.has(`${providerId}:${m}`));
    const degraded = ordered.filter((m) => this.failedModelsInSession.has(`${providerId}:${m}`));

    return [...healthy, ...degraded];
  }

  /**
   * Executes an operation across an ordered list of candidate models with
   * per-model AbortController timeouts, caller AbortSignal propagation, retry backoff,
   * automatic failover, and automatic secret scrubbing on thrown errors.
   */
  public async executeWithFailover<T>(options: {
    providerId: string;
    apiKey: string;
    candidates: string[];
    policy?: ResiliencePolicy;
    externalSignal?: AbortSignal;
    onEvent?: ByokEventListener;
    operation: (model: string, signal: AbortSignal, timeoutMs: number) => Promise<T>;
  }): Promise<T> {
    if (options.externalSignal?.aborted) {
      const abortErr = new Error('Generation aborted by caller');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const policy = this.getMergedPolicy(options.policy);
    const orderedModels = this.resolveCandidateModels(
      options.providerId,
      options.apiKey,
      options.candidates,
      options.policy
    );

    if (orderedModels.length === 0) {
      throw new Error(`No candidate models configured for provider "${options.providerId}".`);
    }

    let lastError: Error | null = null;
    const cacheKey = `${options.providerId}:${options.apiKey.slice(-6)}`;

    for (let mIdx = 0; mIdx < orderedModels.length; mIdx++) {
      const model = orderedModels[mIdx];
      const hasMoreCandidates = mIdx < orderedModels.length - 1;
      const modelTimeout =
        policy.perModelTimeoutMs?.[model] ??
        (hasMoreCandidates ? Math.min(policy.timeoutMs, 15000) : policy.timeoutMs);

      const maxAttempts = Math.max(1, (policy.maxRetries ?? 0) + 1);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (options.externalSignal?.aborted) {
          const abortErr = new Error('Generation aborted by caller');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, modelTimeout);

        const onExternalAbort = () => {
          controller.abort();
        };
        if (options.externalSignal) {
          options.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }

        try {
          const result = await options.operation(model, controller.signal, modelTimeout);
          clearTimeout(timer);
          if (options.externalSignal) {
            options.externalSignal.removeEventListener('abort', onExternalAbort);
          }

          this.failedModelsInSession.delete(`${options.providerId}:${model}`);
          if (policy.rememberWorkingModel) {
            this.setWorkingModel(cacheKey, model);
          }
          return result;
        } catch (err: unknown) {
          clearTimeout(timer);
          if (options.externalSignal) {
            options.externalSignal.removeEventListener('abort', onExternalAbort);
          }

          // If the caller explicitly aborted via request.signal, rethrow AbortError immediately without failing over
          if (options.externalSignal?.aborted && !timedOut) {
            const abortErr = new Error('Generation aborted by caller');
            abortErr.name = 'AbortError';
            throw abortErr;
          }

          const isAbort = timedOut || (err instanceof Error && err.name === 'AbortError');

          if (isAbort) {
            lastError = new Error(
              `AI model (${model}) timed out after ${modelTimeout / 1000}s due to high server load.`
            );
          } else if (err instanceof HttpStatusError) {
            lastError = new HttpStatusError(
              sanitizeErrorMessage(err.message, options.apiKey),
              err.status,
              err.model
            );
          } else if (err instanceof Error) {
            lastError = new Error(sanitizeErrorMessage(err.message, options.apiKey));
          } else {
            lastError = new Error(sanitizeErrorMessage(String(err), options.apiKey));
          }

          this.failedModelsInSession.add(`${options.providerId}:${model}`);

          const status = err instanceof HttpStatusError ? err.status : undefined;
          const isFailoverEligible =
            isAbort ||
            status === undefined ||
            policy.failoverStatusCodes.includes(status) ||
            status >= 500;

          // If not eligible for retry/failover (e.g. 401 Unauthorized / invalid key), throw immediately
          if (status === 401 || status === 403) {
            throw lastError;
          }

          // Retry on same model if attempts remain and no fallback candidates or transient error
          if (attempt < maxAttempts - 1 && isFailoverEligible && !hasMoreCandidates) {
            options.onEvent?.({
              type: 'retry',
              providerId: options.providerId,
              model,
              attempt: attempt + 1,
              statusCode: status,
              message: lastError.message,
            });
            const delay = policy.retryBackoffMs * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          // Break out of retry loop to fail over to next candidate model
          if (hasMoreCandidates && isFailoverEligible) {
            options.onEvent?.({
              type: 'model-failover',
              providerId: options.providerId,
              model,
              nextModel: orderedModels[mIdx + 1],
              statusCode: status,
              message: lastError.message,
            });
            break;
          }

          throw lastError;
        }
      }
    }

    throw lastError || new Error('All candidate AI models failed.');
  }

  public getWorkingModel(cacheKey: string): string | null {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        const stored = window.sessionStorage.getItem(`byok_engine_${cacheKey}`);
        if (stored) return stored;
      }
    } catch { }
    return this.workingModelCache.get(cacheKey) || null;
  }

  public setWorkingModel(cacheKey: string, model: string): void {
    this.workingModelCache.set(cacheKey, model);
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(`byok_engine_${cacheKey}`, model);
      }
    } catch { }
  }
}
