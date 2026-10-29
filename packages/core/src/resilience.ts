/**
 * Resilience Executor
 *
 * Provides configurable per-model timeouts, exponential backoff retries,
 * automatic model candidate failover, session working-model caching,
 * and automatic API key scrubbing from error messages.
 */

import { ResiliencePolicy } from './types.js';

export const DEFAULT_RESILIENCE_POLICY: Required<Omit<ResiliencePolicy, 'perModelTimeoutMs'>> = {
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

  public getMergedPolicy(override?: ResiliencePolicy): Required<Omit<ResiliencePolicy, 'perModelTimeoutMs'>> & {
    perModelTimeoutMs?: Record<string, number>;
  } {
    return {
      ...DEFAULT_RESILIENCE_POLICY,
      ...this.globalPolicy,
      ...override,
      failoverModels: override?.failoverModels ?? this.globalPolicy.failoverModels ?? [],
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
   * per-model AbortController timeouts, retry backoff, automatic failover,
   * and automatic secret scrubbing on thrown errors.
   */
  public async executeWithFailover<T>(options: {
    providerId: string;
    apiKey: string;
    candidates: string[];
    policy?: ResiliencePolicy;
    operation: (model: string, signal: AbortSignal, timeoutMs: number) => Promise<T>;
  }): Promise<T> {
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), modelTimeout);

        try {
          const result = await options.operation(model, controller.signal, modelTimeout);
          clearTimeout(timer);

          this.failedModelsInSession.delete(`${options.providerId}:${model}`);
          if (policy.rememberWorkingModel) {
            this.setWorkingModel(cacheKey, model);
          }
          return result;
        } catch (err: unknown) {
          clearTimeout(timer);
          const isAbort = err instanceof Error && err.name === 'AbortError';

          if (isAbort) {
            lastError = new Error(
              `AI vision model (${model}) timed out after ${modelTimeout / 1000}s due to high server load.`
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
            const delay = policy.retryBackoffMs * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          // Break out of retry loop to fail over to next candidate model
          if (hasMoreCandidates && isFailoverEligible) {
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
