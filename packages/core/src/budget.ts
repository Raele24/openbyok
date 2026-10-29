/**
 * Usage Tracker & Session Budget Guard
 *
 * Tracks request counts, in-flight concurrent requests, estimated input/output tokens,
 * and estimated USD cost per provider.
 * Enforces configurable BudgetPolicy limits (including under concurrent Promise.all load)
 * to prevent accidental runaway API spend.
 */

import { BudgetPolicy, GenerationRequest, ProviderId, UsageMetrics } from './types.js';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Approximate cost per 1M tokens (USD) for standard multimodal flash/mini models.
 * Custom rates can be registered via UsageTracker.setProviderCostRate().
 */
const DEFAULT_COST_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  gemini: { input: 0.1, output: 0.4 },
  openai: { input: 0.15, output: 0.6 },
  claude: { input: 0.8, output: 4.0 },
  ollama: { input: 0.0, output: 0.0 },
};

export class UsageTracker {
  private policy: BudgetPolicy;
  private inFlightRequests = 0;
  private inFlightTokens = 0;
  private costRates = new Map<string, { input: number; output: number }>(
    Object.entries(DEFAULT_COST_PER_1M_TOKENS)
  );

  private metrics: UsageMetrics = {
    requestCount: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTotalTokens: 0,
    estimatedCostUsd: 0,
    byProvider: {},
  };

  constructor(policy: BudgetPolicy = {}) {
    this.policy = policy;
  }

  public setPolicy(policy: BudgetPolicy): void {
    this.policy = { ...this.policy, ...policy };
  }

  public getPolicy(): BudgetPolicy {
    return { ...this.policy };
  }

  public setProviderCostRate(
    providerId: ProviderId,
    ratePer1MTokensUsd: { input: number; output: number }
  ): void {
    this.costRates.set(providerId.toLowerCase(), ratePer1MTokensUsd);
  }

  /**
   * Estimates input tokens from prompt text and attached images (~258 tokens per image).
   */
  public estimateRequestInputTokens(request: GenerationRequest): number {
    const sysChars = request.systemPrompt?.length || 0;
    const schemaChars = request.schemaInstruction?.length || 0;
    const userChars = request.userPrompt?.length || 0;
    const textTokens = Math.ceil((sysChars + schemaChars + userChars) / 4);
    const imageTokens = (request.images?.length || 0) * 258;
    return textTokens + imageTokens;
  }

  /**
   * Estimates output tokens from response string length (~4 chars per token).
   */
  public estimateOutputTokens(outputText: string): number {
    return Math.ceil((outputText?.length || 0) / 4);
  }

  /**
   * Verifies that executing the next request will not violate any configured BudgetPolicy limit.
   * Accounts for both completed and currently in-flight concurrent requests.
   * Throws BudgetExceededError if any limit is reached.
   */
  public assertWithinBudget(request: GenerationRequest): void {
    const totalActiveRequests = this.metrics.requestCount + this.inFlightRequests;
    if (
      this.policy.maxRequestsPerSession !== undefined &&
      totalActiveRequests >= this.policy.maxRequestsPerSession
    ) {
      throw new BudgetExceededError(
        `Session request limit reached (${totalActiveRequests}/${this.policy.maxRequestsPerSession} requests).`
      );
    }

    const projectedInput = this.estimateRequestInputTokens(request);
    const totalProjectedTokens =
      this.metrics.estimatedTotalTokens + this.inFlightTokens + projectedInput;
    if (
      this.policy.maxEstimatedTokensPerSession !== undefined &&
      totalProjectedTokens > this.policy.maxEstimatedTokensPerSession
    ) {
      throw new BudgetExceededError(
        `Session token budget exceeded (${totalProjectedTokens}/${this.policy.maxEstimatedTokensPerSession} tokens).`
      );
    }

    if (
      this.policy.maxCostUsdPerSession !== undefined &&
      this.metrics.estimatedCostUsd >= this.policy.maxCostUsdPerSession
    ) {
      throw new BudgetExceededError(
        `Session cost budget exceeded ($${this.metrics.estimatedCostUsd.toFixed(4)}/$${this.policy.maxCostUsdPerSession.toFixed(4)} USD).`
      );
    }
  }

  /**
   * Atomically validates budget and reserves an in-flight slot for concurrent execution.
   * Returns a release function that must be called in a finally block.
   */
  public acquireSlot(request: GenerationRequest): () => void {
    this.assertWithinBudget(request);
    const projectedInput = this.estimateRequestInputTokens(request);
    this.inFlightRequests += 1;
    this.inFlightTokens += projectedInput;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
      this.inFlightTokens = Math.max(0, this.inFlightTokens - projectedInput);
    };
  }

  /**
   * Records a completed request and updates token and cost counters.
   */
  public recordUsage(
    providerId: ProviderId,
    request: GenerationRequest,
    outputText: string
  ): void {
    const id = providerId.toLowerCase();
    const inTokens = this.estimateRequestInputTokens(request);
    const outTokens = this.estimateOutputTokens(outputText);
    const rate = this.costRates.get(id) || { input: 0.2, output: 0.8 };
    const callCost = (inTokens / 1_000_000) * rate.input + (outTokens / 1_000_000) * rate.output;

    this.metrics.requestCount += 1;
    this.metrics.estimatedInputTokens += inTokens;
    this.metrics.estimatedOutputTokens += outTokens;
    this.metrics.estimatedTotalTokens += inTokens + outTokens;
    this.metrics.estimatedCostUsd += callCost;

    const existing = this.metrics.byProvider[id] || {
      requestCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
    };

    existing.requestCount += 1;
    existing.estimatedInputTokens += inTokens;
    existing.estimatedOutputTokens += outTokens;
    existing.estimatedCostUsd += callCost;
    this.metrics.byProvider[id] = existing;
  }

  public getMetrics(): UsageMetrics {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  public resetMetrics(): void {
    this.inFlightRequests = 0;
    this.inFlightTokens = 0;
    this.metrics = {
      requestCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedTotalTokens: 0,
      estimatedCostUsd: 0,
      byProvider: {},
    };
  }
}
