/**
 * openbyok/vue â€” Vue 3 Composition API Adapter for openbyok/core & openbyok/ui
 *
 * Accepts Vue reactivity primitives (`ref`, `onUnmounted`) so it works in Vue 3 and Nuxt 3
 * without bundling a duplicate Vue runtime.
 */

import { ByokClient, ByokClientOptions, ProviderId } from '../../core/src/index.js';
import { ByokHeadlessController, ByokUiState } from '../../ui/src/index.js';

export interface VueRef<T> {
  value: T;
}

export interface VuePrimitives {
  ref: <T>(value: T) => VueRef<T>;
  onUnmounted?: (hook: () => void) => void;
}

/**
 * Creates a reactive Vue 3 composable backed by `ByokClient` and `ByokHeadlessController`.
 */
export function createByokVueComposable(
  vue: VuePrimitives,
  clientOrOptions?: ByokClient | ByokClientOptions
) {
  const sharedClient =
    clientOrOptions instanceof ByokClient
      ? clientOrOptions
      : new ByokClient(clientOrOptions);
  const sharedController = new ByokHeadlessController(sharedClient);

  return function useByok() {
    const state = vue.ref<ByokUiState>(sharedController.getState());
    const unsubscribe = sharedController.subscribe((next) => {
      state.value = { ...next };
    });

    if (vue.onUnmounted) {
      vue.onUnmounted(() => unsubscribe());
    }

    return {
      state,
      client: sharedClient,
      controller: sharedController,
      selectProvider: (id: ProviderId) => sharedController.selectProvider(id),
      setVaultMode: (mode: string) => sharedController.setVaultMode(mode),
      setKey: (secret: string, providerId?: ProviderId) =>
        sharedController.setKey(secret, providerId),
      setCustomEndpoint: (url: string, providerId?: ProviderId) =>
        sharedController.setCustomEndpoint(url, providerId),
      setCustomModel: (model: string, providerId?: ProviderId) =>
        sharedController.setCustomModel(model, providerId),
      testConnection: () => sharedController.testActiveConnection(),
      purgeAll: () => sharedController.purgeAllCredentials(),
      unlockPassphraseVault: (pin: string) =>
        sharedClient.passphraseVault.unlock(pin),
      lockPassphraseVault: () => sharedClient.passphraseVault.lock(),
      getUsageMetrics: () => sharedClient.getUsageMetrics(),
    };
  };
}

