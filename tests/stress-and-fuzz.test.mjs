import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createByok,
  ResilienceExecutor,
  HttpStatusError,
  BudgetExceededError,
  readStreamLines,
} from '../dist/core/src/index.js';

describe('Chaos, Stress & Fuzzing Suite', () => {
  it('1. ResilienceExecutor survives timeouts + 503 outages and caches the working model', async () => {
    const executor = new ResilienceExecutor({
      timeoutMs: 80,
      maxRetries: 0,
      rememberWorkingModel: true,
    });

    const attemptedModels = [];

    const result1 = await executor.executeWithFailover({
      providerId: 'gemini',
      apiKey: 'AIzaTestKey123456',
      candidates: ['model-timeout', 'model-503', 'model-healthy'],
      operation: async (model, signal) => {
        attemptedModels.push(model);
        if (model === 'model-timeout') {
          // Hang until AbortController fires
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          });
        }
        if (model === 'model-503') {
          throw new HttpStatusError('Service Unavailable', 503, model);
        }
        return `Success from ${model}`;
      },
    });

    assert.equal(result1, 'Success from model-healthy');
    assert.deepEqual(attemptedModels, ['model-timeout', 'model-503', 'model-healthy']);

    // Second call must jump straight to 'model-healthy' in 0ms without touching the dead models
    attemptedModels.length = 0;
    const result2 = await executor.executeWithFailover({
      providerId: 'gemini',
      apiKey: 'AIzaTestKey123456',
      candidates: ['model-timeout', 'model-503', 'model-healthy'],
      operation: async (model) => {
        attemptedModels.push(model);
        return `Fast success from ${model}`;
      },
    });

    assert.equal(result2, 'Fast success from model-healthy');
    assert.deepEqual(
      attemptedModels,
      ['model-healthy'],
      'Working model cache must bypass failed models on subsequent calls'
    );
  });

  it('2. Aborts immediately on 401 Unauthorized without wasting failover calls', async () => {
    const executor = new ResilienceExecutor({ maxRetries: 2 });
    const attempts = [];

    await assert.rejects(
      () =>
        executor.executeWithFailover({
          providerId: 'openai',
          apiKey: 'sk-invalid-key',
          candidates: ['gpt-4o-mini', 'gpt-4o'],
          operation: async (model) => {
            attempts.push(model);
            throw new HttpStatusError('Invalid API key', 401, model);
          },
        }),
      /Invalid API key/
    );

    assert.equal(
      attempts.length,
      1,
      'Must abort immediately on 401 without retrying or failing over to other models'
    );
  });

  it('3. Cross-Provider Cascade: automatically fails over from primary provider to fallback provider', async () => {
    const client = createByok({
      defaultProvider: 'primary-dead',
      fallbackProviders: ['secondary-rate-limited', 'tertiary-healthy'],
    });

    const callOrder = [];

    client.registerProvider({
      id: 'primary-dead',
      name: 'Primary Dead Cloud',
      requiresKey: false,
      defaultBaseUrl: 'http://localhost',
      defaultModel: 'm1',
      async generateText() {
        callOrder.push('primary-dead');
        throw new Error('503 Service Outage');
      },
      async generateObject() {
        throw new Error('503 Service Outage');
      },
      async testConnection() {
        return { success: false, message: 'Down' };
      },
    });

    client.registerProvider({
      id: 'secondary-rate-limited',
      name: 'Secondary Rate-Limited',
      requiresKey: false,
      defaultBaseUrl: 'http://localhost',
      defaultModel: 'm2',
      async generateText() {
        callOrder.push('secondary-rate-limited');
        throw new Error('429 Too Many Requests');
      },
      async generateObject() {
        throw new Error('429 Too Many Requests');
      },
      async testConnection() {
        return { success: false, message: 'Rate limited' };
      },
    });

    client.registerProvider({
      id: 'tertiary-healthy',
      name: 'Tertiary Healthy Local',
      requiresKey: false,
      defaultBaseUrl: 'http://localhost',
      defaultModel: 'm3',
      async generateText(req) {
        callOrder.push('tertiary-healthy');
        return `Recovered: ${req.userPrompt}`;
      },
      async generateObject() {
        return { ok: true };
      },
      async testConnection() {
        return { success: true, message: 'OK' };
      },
    });

    const output = await client.generateText({ userPrompt: 'Hello failover' });
    assert.equal(output, 'Recovered: Hello failover');
    assert.deepEqual(callOrder, [
      'primary-dead',
      'secondary-rate-limited',
      'tertiary-healthy',
    ]);
  });

  it('4. Concurrency & Budget Stress Test: 100 parallel Promise.all requests enforce exact maxRequestsPerSession=25', async () => {
    const client = createByok({
      defaultProvider: 'fast-mock',
      budgetPolicy: {
        maxRequestsPerSession: 25,
      },
    });

    client.registerProvider({
      id: 'fast-mock',
      name: 'Fast Mock Provider',
      requiresKey: false,
      defaultBaseUrl: 'http://localhost',
      defaultModel: 'mock-1',
      async generateText() {
        // Simulate asynchronous network latency so all 100 requests overlap in flight
        await new Promise((r) => setTimeout(r, 15));
        return 'ok';
      },
      async generateObject() {
        return { ok: true };
      },
      async testConnection() {
        return { success: true, message: 'OK' };
      },
    });

    const promises = Array.from({ length: 100 }, (_, i) =>
      client.generateText({ userPrompt: `Concurrent prompt #${i}` })
    );

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(
      fulfilled.length,
      25,
      `Expected exactly 25 requests to succeed under concurrent load, got ${fulfilled.length}`
    );
    assert.equal(
      rejected.length,
      75,
      `Expected exactly 75 requests to be blocked by BudgetExceededError, got ${rejected.length}`
    );
    for (const rej of rejected) {
      assert.ok(rej.reason instanceof BudgetExceededError);
    }
    assert.equal(client.getUsageMetrics().requestCount, 25);
  });

  it('5. Stream Fuzzing: handles fragmented multi-chunk UTF-8 SSE and NDJSON streams', async () => {
    const encoder = new TextEncoder();
    const fragments = [
      'data: {"choices":[{"delta":{"con',
      'tent":"Hel',
      'lo "}}]}\n\n',
      '   \r\n',
      'data: {"choices":[{"delta":{"content":"World!"}}]}\r\n',
      'data: [DONE]\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const frag of fragments) {
          controller.enqueue(encoder.encode(frag));
        }
        controller.close();
      },
    });

    const lines = [];
    for await (const line of readStreamLines(stream)) {
      lines.push(line);
    }

    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'data: {"choices":[{"delta":{"content":"Hello "}}]}');
    assert.equal(lines[1], 'data: {"choices":[{"delta":{"content":"World!"}}]}');
    assert.equal(lines[2], 'data: [DONE]');
  });
});

