/**
 * openbyok/react — React Hooks Adapter for openbyok/core & openbyok/ui
 *
 * Accepts standard React hook primitives (`useState`, `useEffect`) so it works
 * across React 17, 18, 19, Next.js, and Remix without peer-dependency version conflicts.
 */

import {
  BudgetPolicy,
  ByokClient,
  ByokClientOptions,
  ByokEventListener,
  ProviderId,
} from '../../core/src/index.js';
import { ByokHeadlessController, ByokUiState } from '../../ui/src/index.js';

export interface ReactPrimitives {
  useState: <T>(initial: T | (() => T)) => [T, (next: T) => void];
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
}

/**
 * Creates a `useByok()` React hook bound to a `ByokClient` instance.
 */
export function createByokReactHook(
  react: ReactPrimitives,
  clientOrOptions?: ByokClient | ByokClientOptions
) {
  const sharedClient =
    clientOrOptions instanceof ByokClient
      ? clientOrOptions
      : new ByokClient(clientOrOptions);
  const sharedController = new ByokHeadlessController(sharedClient);

  return function useByok() {
    const [state, setState] = react.useState<ByokUiState>(() =>
      sharedController.getState()
    );

    react.useEffect(() => {
      return sharedController.subscribe((nextState) => {
        setState({ ...nextState });
      });
    }, []);

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
      refreshModels: (providerId?: ProviderId) =>
        sharedController.refreshModels(providerId),
      listModels: (providerId?: ProviderId) =>
        sharedClient.listModels(providerId),
      hydrate: () => sharedController.hydrate(),
      onEvent: (listener: ByokEventListener) => sharedClient.onEvent(listener),
      setBudgetPolicy: (policy: BudgetPolicy) =>
        sharedController.setBudgetPolicy(policy),
      testConnection: () => sharedController.testActiveConnection(),
      purgeAll: () => sharedController.purgeAllCredentials(),
      unlockPassphraseVault: (pin: string) =>
        sharedClient.passphraseVault.unlock(pin),
      lockPassphraseVault: () => sharedClient.passphraseVault.lock(),
      getUsageMetrics: () => sharedClient.getUsageMetrics(),
    };
  };
}
