import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ByokClient,
  BudgetExceededError,
} from '../dist/core/src/index.js';
import { ByokHeadlessController } from '../dist/ui/src/index.js';

function createSSEStream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
}

test('Improvement 1: Unified listModels() on all providers + auto-discovery in ByokHeadlessController', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-flash',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('api.openai.com/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }],
          }),
          { status: 200 }
        );
      }
      if (u.includes('api.anthropic.com/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'claude-3-5-sonnet-latest' }],
          }),
          { status: 200 }
        );
      }
      if (u.includes('11434/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [{ name: 'llava:latest' }, { name: 'llama3.2:latest' }],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const client = new ByokClient({ defaultProvider: 'openai' });
    await client.vault.setKey('gemini', 'gk-123');
    await client.vault.setKey('openai', 'sk-123');
    await client.vault.setKey('claude', 'ck-123');

    const geminiModels = await client.listModels('gemini');
    const openaiModels = await client.listModels('openai');
    const claudeModels = await client.listModels('claude');
    const ollamaModels = await client.listModels('ollama');

    assert.deepEqual(geminiModels, ['gemini-2.5-flash']);
    assert.deepEqual(openaiModels, ['gpt-4o-mini', 'gpt-4o']);
    assert.deepEqual(claudeModels, ['claude-3-5-sonnet-latest']);
    assert.deepEqual(ollamaModels, ['llava:latest', 'llama3.2:latest']);

    // Verify ByokHeadlessController automatic background model discovery on setKey()
    const controller = new ByokHeadlessController(client);
    await controller.setKey('sk-live-key', 'openai');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(controller.getState().availableModels, ['gpt-4o-mini', 'gpt-4o']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Improvement 2: Multimodal generateStream() sends images on OpenAI, Claude, and Ollama', async () => {
  const originalFetch = globalThis.fetch;
  const capturedBodies = {};

  try {
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const bodyObj = JSON.parse(init.body);
      if (u.includes('openai.com')) {
        capturedBodies.openai = bodyObj;
        return new Response(
          createSSEStream([
            'data: {"choices":[{"delta":{"content":"OpenAI vision ok"}}]}',
            'data: [DONE]',
          ]),
          { status: 200 }
        );
      }
      if (u.includes('anthropic.com')) {
        capturedBodies.claude = bodyObj;
        return new Response(
          createSSEStream([
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude vision ok"}}',
          ]),
          { status: 200 }
        );
      }
      if (u.includes('11434/api/chat')) {
        capturedBodies.ollama = bodyObj;
        return new Response(
          createSSEStream(['{"message":{"content":"Ollama vision ok"}}']),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const client = new ByokClient();
    await client.vault.setKey('openai', 'sk-test');
    await client.vault.setKey('claude', 'ck-test');

    const imgRequest = {
      userPrompt: 'Describe this image',
      images: [{ mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' }],
    };

    for (const providerId of ['openai', 'claude', 'ollama']) {
      let text = '';
      for await (const chunk of client.generateStream(imgRequest, { providerId })) {
        text += chunk;
      }
      assert.ok(text.includes('vision ok'));
    }

    // Verify OpenAI stream payload included image_url
    const openAiUserContent = capturedBodies.openai.messages[0].content;
    assert.equal(Array.isArray(openAiUserContent), true);
    assert.equal(openAiUserContent[1].type, 'image_url');

    // Verify Claude stream payload included base64 image block
    const claudeUserContent = capturedBodies.claude.messages[0].content;
    assert.equal(Array.isArray(claudeUserContent), true);
    assert.equal(claudeUserContent[0].type, 'image');
    assert.equal(claudeUserContent[0].source.data, 'iVBORw0KGgoAAAANSUhEUg==');

    // Verify Ollama stream payload included images array on the user message
    const ollamaUserMsg = capturedBodies.ollama.messages[0];
    assert.deepEqual(ollamaUserMsg.images, ['iVBORw0KGgoAAAANSUhEUg==']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Improvement 3: generateStream() uses ResilienceExecutor for 503 retry and candidate model failover', async () => {
  const originalFetch = globalThis.fetch;
  const attemptedUrls = [];

  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      attemptedUrls.push(u);
      if (u.includes('gemini-primary-busy')) {
        return new Response('Service Unavailable - High Demand', { status: 503 });
      }
      return new Response(
        createSSEStream([
          'data: {"candidates":[{"content":{"parts":[{"text":"Failover stream success"}]}}]}',
        ]),
        { status: 200 }
      );
    };

    const client = new ByokClient({
      defaultProvider: 'gemini',
      globalResilience: {
        maxRetriesPerModel: 0,
        candidateModels: ['gemini-backup-model'],
      },
    });
    await client.vault.setKey('gemini', 'gk-resilience');

    let output = '';
    for await (const chunk of client.generateStream(
      { userPrompt: 'Hello' },
      { model: 'gemini-primary-busy' }
    )) {
      output += chunk;
    }

    assert.equal(output, 'Failover stream success');
    assert.equal(attemptedUrls.length, 2);
    assert.ok(attemptedUrls[0].includes('gemini-primary-busy'));
    assert.ok(attemptedUrls[1].includes('gemini-backup-model'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Improvement 4: Aggregated failover error chain preserves primary provider error instead of masking it', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        return new Response('503 Model Overloaded', { status: 503 });
      }
      if (u.includes('11434')) {
        throw new Error('ECONNREFUSED 127.0.0.1:11434');
      }
      return new Response('Error', { status: 500 });
    };

    const client = new ByokClient({
      defaultProvider: 'gemini',
      fallbackProviders: ['ollama'],
      globalResilience: { maxRetriesPerModel: 0, candidateModels: [] },
    });
    await client.vault.setKey('gemini', 'gk-secret-123456');

    await assert.rejects(
      async () => {
        await client.generateText({ userPrompt: 'Test chain error' }, { model: 'gemini-only' });
      },
      (err) => {
        assert.ok(err.message.includes('All providers failed:'));
        assert.ok(err.message.includes('[gemini:'));
        assert.ok(err.message.includes('503 Model Overloaded'));
        assert.ok(err.message.includes('-> [ollama:'));
        assert.ok(err.message.includes('11434'));
        assert.ok(!err.message.includes('gk-secret-123456'));
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Improvement 5: Native AbortSignal in GenerationRequest cancels in-flight stream immediately without failover', async () => {
  const originalFetch = globalThis.fetch;
  let fallbackCalled = false;

  try {
    const abortController = new AbortController();

    globalThis.fetch = async (url) => {
      if (String(url).includes('11434')) {
        fallbackCalled = true;
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"chunk "}}]}\n')
          );
          await new Promise((r) => setTimeout(r, 15));
        },
      });
      return new Response(stream, { status: 200 });
    };

    const client = new ByokClient({
      defaultProvider: 'openai',
      fallbackProviders: ['ollama'],
    });
    await client.vault.setKey('openai', 'sk-abort-test');

    const received = [];
    await assert.rejects(
      async () => {
        for await (const chunk of client.generateStream({
          userPrompt: 'Count forever',
          signal: abortController.signal,
        })) {
          received.push(chunk);
          if (received.length === 2) {
            abortController.abort();
          }
        }
      },
      (err) => err.name === 'AbortError'
    );

    assert.equal(received.length, 2);
    assert.equal(fallbackCalled, false, 'User-initiated AbortSignal must not trigger fallback providers');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Improvement 6: Native multi-turn messages[] support across Gemini, OpenAI, Claude, and Ollama', async () => {
  const originalFetch = globalThis.fetch;
  const payloads = {};

  try {
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const body = JSON.parse(init.body);
      if (u.includes('generativelanguage.googleapis.com')) {
        payloads.gemini = body;
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Gemini reply' }] } }],
          }),
          { status: 200 }
        );
      }
      if (u.includes('openai.com')) {
        payloads.openai = body;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'OpenAI reply' } }],
          }),
          { status: 200 }
        );
      }
      if (u.includes('anthropic.com')) {
        payloads.claude = body;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'Claude reply' }],
          }),
          { status: 200 }
        );
      }
      if (u.includes('11434/api/chat')) {
        payloads.ollama = body;
        return new Response(
          JSON.stringify({
            message: { content: 'Ollama reply' },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const client = new ByokClient();
    await client.vault.setKey('gemini', 'gk-1');
    await client.vault.setKey('openai', 'sk-1');
    await client.vault.setKey('claude', 'ck-1');

    const chatRequest = {
      systemPrompt: 'You are a helpful coding assistant.',
      messages: [
        { role: 'user', content: 'Hi, my name is Alice.' },
        { role: 'assistant', content: 'Hello Alice! How can I help?' },
        { role: 'user', content: 'What is my name?' },
      ],
    };

    for (const providerId of ['gemini', 'openai', 'claude', 'ollama']) {
      const res = await client.generateText(chatRequest, { providerId });
      assert.ok(res.includes('reply'));
    }

    // Gemini maps 'assistant' -> 'model' and puts systemPrompt in system_instruction
    assert.equal(payloads.gemini.contents.length, 3);
    assert.equal(payloads.gemini.contents[1].role, 'model');
    assert.equal(
      payloads.gemini.system_instruction.parts[0].text,
      'You are a helpful coding assistant.'
    );

    // OpenAI includes system message + 3 conversation turns = 4 messages
    assert.equal(payloads.openai.messages.length, 4);
    assert.equal(payloads.openai.messages[0].role, 'system');
    assert.equal(payloads.openai.messages[2].role, 'assistant');

    // Claude uses top-level system field + 3 user/assistant messages
    assert.equal(payloads.claude.system, 'You are a helpful coding assistant.');
    assert.equal(payloads.claude.messages.length, 3);
    assert.equal(payloads.claude.messages[1].role, 'assistant');

    // Ollama includes system message + 3 conversation turns = 4 messages
    assert.equal(payloads.ollama.messages.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Improvement 7: Runtime setBudgetPolicy() dynamically updates session limits', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200 }
      );

    const client = new ByokClient({
      defaultProvider: 'openai',
      budgetPolicy: { maxRequestsPerSession: 1 },
    });
    await client.vault.setKey('openai', 'sk-budget');

    await client.generateText({ userPrompt: 'First request' });

    // Second request blocked by initial maxRequestsPerSession: 1
    await assert.rejects(
      async () => client.generateText({ userPrompt: 'Second request' }),
      (err) => err instanceof BudgetExceededError
    );

    // Dynamically raise limit at runtime via client.setBudgetPolicy()
    client.setBudgetPolicy({ maxRequestsPerSession: 3 });
    assert.equal(client.getBudgetPolicy().maxRequestsPerSession, 3);

    const secondOut = await client.generateText({ userPrompt: 'Second request now allowed' });
    assert.equal(secondOut, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Next-1: UI controller setCustomModel & setCustomEndpoint synchronize directly with ByokClient generation', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedModel = '';

  try {
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      if (init?.body) {
        capturedModel = JSON.parse(init.body).model;
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Synced model response' } }],
        }),
        { status: 200 }
      );
    };

    const client = new ByokClient({ defaultProvider: 'openai' });
    const controller = new ByokHeadlessController(client);
    await client.vault.setKey('openai', 'sk-sync-test');

    // Change model and endpoint via UI controller without passing overrides to client.generateText()
    controller.setCustomModel('gpt-4.1-custom', 'openai');
    controller.setCustomEndpoint('https://custom.proxy.local/v1', 'openai');

    const res = await client.generateText({ userPrompt: 'Test sync' });
    assert.equal(res, 'Synced model response');
    assert.equal(capturedModel, 'gpt-4.1-custom');
    assert.equal(capturedUrl, 'https://custom.proxy.local/v1/chat/completions');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Next-2: User-configurable modelFilter in listModels() & dynamic discovered model failover', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-4o-mini' },
            { id: 'text-embedding-3-small' },
            { id: 'whisper-1' },
            { id: 'gpt-4o' },
          ],
        }),
        { status: 200 }
      );

    const client = new ByokClient({
      defaultProvider: 'openai',
      providerModelFilters: {
        openai: (id) => id.startsWith('gpt-'),
      },
    });
    await client.vault.setKey('openai', 'sk-filter');

    const filtered = await client.listModels('openai');
    assert.deepEqual(filtered, ['gpt-4o-mini', 'gpt-4o']);

    // Per-call override filter (e.g. embedding-only context)
    const embeddingsOnly = await client.listModels('openai', {
      modelFilter: (id) => id.includes('embedding'),
    });
    assert.deepEqual(embeddingsOnly, ['text-embedding-3-small']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Next-3: client.hydrate() restores persisted vaultMode, activeProvider, and customModel across reloads', async () => {
  const storage = new Map();
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;

  const mockStorage = {
    get length() {
      return storage.size;
    },
    key: (i) => Array.from(storage.keys())[i] || null,
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  try {
    globalThis.localStorage = mockStorage;
    globalThis.window = { localStorage: mockStorage };

    // Simulate Session 1: user switches to encrypted mode, selects claude, sets custom model and key
    const client1 = new ByokClient();
    await client1.vault.setMode('encrypted');
    client1.setActiveProviderId('claude');
    client1.setProviderModel('claude', 'claude-3-7-sonnet-latest');
    await client1.vault.setKey('claude', 'sk-ant-persisted-secret');

    // Simulate Page Reload (F5): new ByokClient instance starts fresh and calls hydrate()
    const client2 = new ByokClient();
    await client2.hydrate();

    assert.equal(client2.vault.getActiveMode(), 'encrypted');
    assert.equal(client2.getActiveProviderId(), 'claude');
    assert.equal(client2.getProviderModel('claude'), 'claude-3-7-sonnet-latest');
    assert.equal(client2.vault.getCachedKey('claude'), 'sk-ant-persisted-secret');
  } finally {
    globalThis.window = originalWindow;
    globalThis.localStorage = originalLocalStorage;
  }
});

test('Next-4: Shared parseStructuredJson() extracts JSON objects/arrays wrapped in conversational text', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'Sure! Here is the requested JSON payload:\n```json\n{"title":"Vintage Jacket","price":45}\n```\nLet me know if you need changes.',
            },
          ],
        }),
        { status: 200 }
      );

    const client = new ByokClient({ defaultProvider: 'claude' });
    await client.vault.setKey('claude', 'ck-json');

    const obj = await client.generateObject({ userPrompt: 'Extract item' });
    assert.deepEqual(obj, { title: 'Vintage Jacket', price: 45 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Next-5: Telemetry onEvent() emits model-failover, provider-failover, and exact API token usage', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('gemini-busy')) {
        return new Response('503 Busy', { status: 503 });
      }
      if (u.includes('gemini-backup')) {
        return new Response('503 Backup Also Busy', { status: 503 });
      }
      if (u.includes('openai.com')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Fallback OpenAI response' } }],
            usage: { prompt_tokens: 142, completion_tokens: 58 },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const events = [];
    const client = new ByokClient({
      defaultProvider: 'gemini',
      fallbackProviders: ['openai'],
      globalResilience: {
        maxRetries: 0,
        failoverModels: ['gemini-backup'],
      },
      onEvent: (ev) => events.push(ev),
    });
    await client.vault.setKey('gemini', 'gk-telemetry');
    await client.vault.setKey('openai', 'sk-telemetry');

    const result = await client.generateText(
      { userPrompt: 'Hello telemetry' },
      { model: 'gemini-busy' }
    );
    assert.equal(result, 'Fallback OpenAI response');

    // Verify model-failover, provider-failover, and usage-recorded events were emitted
    assert.ok(events.some((e) => e.type === 'model-failover' && e.model === 'gemini-busy' && e.nextModel === 'gemini-backup'));
    assert.ok(events.some((e) => e.type === 'provider-failover' && e.providerId === 'gemini' && e.nextProviderId === 'openai'));
    assert.ok(events.some((e) => e.type === 'usage-recorded' && e.inputTokens === 142 && e.outputTokens === 58));

    // Verify UsageTracker recorded exact API tokens (142 + 58 = 200) instead of char/4 estimate
    const metrics = client.getUsageMetrics();
    assert.equal(metrics.estimatedInputTokens, 142);
    assert.equal(metrics.estimatedOutputTokens, 58);
    assert.equal(metrics.estimatedTotalTokens, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
