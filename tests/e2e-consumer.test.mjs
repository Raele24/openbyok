import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createByok, ByokLocalizer } from '../dist/core/src/index.js';
import { ByokHeadlessController, escapeHtml } from '../dist/ui/src/index.js';
import { createByokSignalStore } from '../dist/angular/src/index.js';
import { createByokReactHook } from '../dist/react/src/index.js';
import { createByokVueComposable } from '../dist/vue/src/index.js';

describe('E2E Framework Wrappers & DOM XSS Prevention Suite', () => {
  it('1. Neutralizes DOM XSS payloads in UI rendering via escapeHtml()', () => {
    const xssPayload = '"><img src=x onerror=alert(1)><script>stealKeys()</script>\'&';
    const sanitized = escapeHtml(xssPayload);

    assert.ok(!sanitized.includes('<script>'));
    assert.ok(!sanitized.includes('<img'));
    assert.ok(!sanitized.includes('"'));
    assert.ok(!sanitized.includes("'"));
    assert.equal(
      sanitized,
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;stealKeys()&lt;/script&gt;&#39;&amp;'
    );
  });

  it('2. Angular Signals Store (openbyok/angular) reactive lifecycle', async () => {
    // Minimal Angular signal/computed simulation
    const signal = (initial) => {
      let val = initial;
      const fn = () => val;
      fn.set = (next) => {
        val = next;
      };
      return fn;
    };
    const computed = (calc) => () => calc();

    const store = createByokSignalStore(
      { signal, computed },
      { defaultProvider: 'gemini', defaultVaultMode: 'session' }
    );

    assert.equal(store.selectedProvider(), 'gemini');
    assert.equal(store.hasApiKey(), false);

    await store.setKey('gemini', 'AIzaAngularSignalKey123');
    assert.equal(store.geminiKey(), 'AIzaAngularSignalKey123');
    assert.equal(store.activeApiKey(), 'AIzaAngularSignalKey123');
    assert.equal(store.hasApiKey(), true);

    store.selectedProvider.set('ollama');
    assert.equal(store.hasApiKey(), true, 'Ollama requires no API key');

    await store.purgeAll();
    assert.equal(store.geminiKey(), '');
  });

  it('3. React Hook Factory (openbyok/react) state synchronization', async () => {
    let currentState;
    let effectCleanup;

    const mockReact = {
      useState(init) {
        currentState = typeof init === 'function' ? init() : init;
        const setState = (next) => {
          currentState = next;
        };
        return [currentState, setState];
      },
      useEffect(fn) {
        effectCleanup = fn();
      },
    };

    const useByok = createByokReactHook(mockReact, { defaultProvider: 'openai' });
    const hookApi = useByok();

    assert.equal(currentState.activeProvider, 'openai');
    assert.equal(currentState.hasKey, false);

    await hookApi.setKey('sk-react-key-999');
    assert.equal(currentState.activeKey, 'sk-react-key-999');
    assert.equal(currentState.hasKey, true);

    hookApi.selectProvider('claude');
    assert.equal(currentState.activeProvider, 'claude');
    assert.equal(currentState.hasKey, false);

    if (effectCleanup) effectCleanup();
  });

  it('4. Vue 3 Composable Factory (openbyok/vue) reactivity & cleanup', async () => {
    let unmountHook;
    const mockVue = {
      ref(initial) {
        return { value: initial };
      },
      onUnmounted(fn) {
        unmountHook = fn;
      },
    };

    const useByok = createByokVueComposable(mockVue, { defaultProvider: 'claude' });
    const composable = useByok();

    assert.equal(composable.state.value.activeProvider, 'claude');
    await composable.setKey('sk-ant-vue-key-777');
    assert.equal(composable.state.value.activeKey, 'sk-ant-vue-key-777');
    assert.equal(composable.state.value.hasKey, true);

    if (unmountHook) unmountHook();
  });

  it('5. Multilingual i18n dictionary coverage (en, it, fr, es, de + custom)', () => {
    for (const lang of ['en', 'it', 'fr', 'es', 'de']) {
      const strings = ByokLocalizer.getStrings(lang);
      assert.ok(strings.settingsTitle.length > 0);
      assert.ok(strings.purgeBtn.length > 0);
    }

    ByokLocalizer.registerLocale('pt', { settingsTitle: 'Configuracoes de IA' });
    assert.equal(ByokLocalizer.getStrings('pt-BR').settingsTitle, 'Configuracoes de IA');
  });
});

