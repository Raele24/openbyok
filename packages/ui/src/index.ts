/**
 * openbyok/ui â€” Headless Controller & Themeable <byok-settings> Web Component
 *
 * Provides two UI integration layers:
 * 1. ByokHeadlessController: Framework-agnostic reactive state for custom UIs (React, Vue, Angular, Svelte, Vanilla).
 * 2. <byok-settings> Custom Element: Drop-in Web Component styled via CSS Custom Properties (--byok-*)
 *    or custom CSS class injection (unstyled mode).
 */

import {
  ByokClient,
  ByokLocalizer,
  ConnectionTestResult,
  ProviderId,
  SupportedLanguage,
} from '../../core/src/index';

export interface ByokUiState {
  activeProvider: ProviderId;
  vaultMode: string;
  providers: Array<{ id: string; name: string; requiresKey: boolean }>;
  activeKey: string;
  hasKey: boolean;
  customEndpoint: string;
  customModel: string;
  language: SupportedLanguage;
  isTesting: boolean;
  lastTestResult: ConnectionTestResult | null;
}

export interface ByokClassNames {
  container?: string;
  header?: string;
  fieldGroup?: string;
  label?: string;
  select?: string;
  input?: string;
  buttonRow?: string;
  primaryButton?: string;
  secondaryButton?: string;
  dangerButton?: string;
  statusBanner?: string;
}

/**
 * Layer 1: Headless State Controller
 * Can be consumed by any UI framework or custom DOM templates without imposing any markup or CSS.
 */
export class ByokHeadlessController {
  private listeners = new Set<(state: ByokUiState) => void>();
  private endpoints = new Map<string, string>();
  private models = new Map<string, string>();
  private language: SupportedLanguage = 'en';
  private isTesting = false;
  private lastTestResult: ConnectionTestResult | null = null;

  constructor(public readonly client: ByokClient, initialLang: SupportedLanguage = 'en') {
    this.language = initialLang;
    this.client.vault.subscribe(() => this.emit());
  }

  public getState(): ByokUiState {
    const activeProvider = this.client.getActiveProviderId();
    const providerInstance = this.client.registry.get(activeProvider);
    const activeKey = this.client.vault.getCachedKey(activeProvider);
    const hasKey = !providerInstance.requiresKey || activeKey.trim().length > 0;

    return {
      activeProvider,
      vaultMode: this.client.vault.getActiveMode(),
      providers: this.client.registry.getAll().map((p) => ({
        id: p.id,
        name: p.name,
        requiresKey: p.requiresKey,
      })),
      activeKey,
      hasKey,
      customEndpoint: this.endpoints.get(activeProvider) || providerInstance.defaultBaseUrl,
      customModel: this.models.get(activeProvider) || providerInstance.defaultModel,
      language: this.language,
      isTesting: this.isTesting,
      lastTestResult: this.lastTestResult,
    };
  }

  public setLanguage(lang: SupportedLanguage): void {
    this.language = lang;
    this.emit();
  }

  public selectProvider(providerId: ProviderId): void {
    this.client.setActiveProviderId(providerId);
    this.lastTestResult = null;
    this.emit();
  }

  public async setVaultMode(modeId: string): Promise<void> {
    await this.client.vault.setMode(modeId);
    this.emit();
  }

  public async setKey(secret: string, providerId?: ProviderId): Promise<void> {
    const target = providerId || this.client.getActiveProviderId();
    await this.client.vault.setKey(target, secret);
    this.emit();
  }

  public setCustomEndpoint(url: string, providerId?: ProviderId): void {
    const target = providerId || this.client.getActiveProviderId();
    this.endpoints.set(target, url.trim());
    this.emit();
  }

  public setCustomModel(model: string, providerId?: ProviderId): void {
    const target = providerId || this.client.getActiveProviderId();
    this.models.set(target, model.trim());
    this.emit();
  }

  public async testActiveConnection(): Promise<ConnectionTestResult> {
    const state = this.getState();
    this.isTesting = true;
    this.lastTestResult = null;
    this.emit();

    const result = await this.client.testConnection(state.activeProvider, {
      apiKey: state.activeKey,
      baseUrl: state.customEndpoint,
      model: state.customModel,
    });

    this.isTesting = false;
    this.lastTestResult = result;
    this.emit();
    return result;
  }

  public async purgeAllCredentials(): Promise<void> {
    await this.client.vault.purgeAll();
    this.lastTestResult = null;
    this.emit();
  }

  public subscribe(listener: (state: ByokUiState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

/**
 * Layer 2 & 3: Themeable <byok-settings> Web Component
 *
 * Adapts to any host project design system via:
 * - CSS Custom Properties:
 *   --byok-bg, --byok-surface, --byok-text, --byok-muted, --byok-border,
 *   --byok-accent, --byok-accent-contrast, --byok-danger, --byok-radius, --byok-font
 * - Or unstyled mode with custom CSS class names (Tailwind, Bootstrap, etc.).
 */
const DEFAULT_STYLES = `
:host {
  --byok-bg: #111827;
  --byok-surface: #1f2937;
  --byok-text: #f9fafb;
  --byok-muted: #9ca3af;
  --byok-border: #374151;
  --byok-accent: #10b981;
  --byok-accent-contrast: #064e3b;
  --byok-danger: #ef4444;
  --byok-radius: 10px;
  --byok-font: system-ui, -apple-system, sans-serif;
  display: block;
  font-family: var(--byok-font);
  color: var(--byok-text);
}
.byok-card {
  background: var(--byok-bg);
  border: 1px solid var(--byok-border);
  border-radius: var(--byok-radius);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.byok-header {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
}
.byok-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.byok-label {
  font-size: 0.82rem;
  color: var(--byok-muted);
  font-weight: 500;
}
.byok-input, .byok-select {
  background: var(--byok-surface);
  color: var(--byok-text);
  border: 1px solid var(--byok-border);
  border-radius: calc(var(--byok-radius) - 2px);
  padding: 0.55rem 0.75rem;
  font-size: 0.9rem;
  outline: none;
}
.byok-input:focus, .byok-select:focus {
  border-color: var(--byok-accent);
}
.byok-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.byok-btn {
  padding: 0.5rem 0.9rem;
  border-radius: calc(var(--byok-radius) - 2px);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}
.byok-btn-primary {
  background: var(--byok-accent);
  color: #ffffff;
}
.byok-btn-secondary {
  background: var(--byok-surface);
  color: var(--byok-text);
  border-color: var(--byok-border);
}
.byok-btn-danger {
  background: transparent;
  color: var(--byok-danger);
  border-color: var(--byok-danger);
}
.byok-status {
  font-size: 0.82rem;
  padding: 0.5rem 0.75rem;
  border-radius: calc(var(--byok-radius) - 2px);
  border: 1px solid var(--byok-border);
  background: var(--byok-surface);
}
`;

export function registerByokSettingsElement(tagName = 'byok-settings'): void {
  if (typeof window === 'undefined' || typeof customElements === 'undefined') return;
  if (customElements.get(tagName)) return;

  class ByokSettingsElement extends HTMLElement {
    private controller?: ByokHeadlessController;
    private unsubscribe?: () => void;
    private classNames: ByokClassNames = {};
    private unstyled = false;
    private root: ShadowRoot | HTMLElement;

    constructor() {
      super();
      this.unstyled = this.hasAttribute('unstyled');
      this.root = this.unstyled ? this : this.attachShadow({ mode: 'open' });
    }

    public connectController(
      controller: ByokHeadlessController,
      options?: { unstyled?: boolean; classNames?: ByokClassNames }
    ): void {
      if (this.unsubscribe) this.unsubscribe();
      this.controller = controller;
      if (options?.classNames) this.classNames = options.classNames;
      if (options?.unstyled !== undefined) this.unstyled = options.unstyled;
      this.unsubscribe = this.controller.subscribe((state) => this.render(state));
    }

    disconnectedCallback(): void {
      if (this.unsubscribe) this.unsubscribe();
    }

    private render(state: ByokUiState): void {
      const t = ByokLocalizer.getStrings(state.language);
      const cls = this.classNames;

      const styleBlock = this.unstyled ? '' : `<style>${DEFAULT_STYLES}</style>`;
      const statusHtml = state.lastTestResult
        ? `<div class="${cls.statusBanner || 'byok-status'}">${state.lastTestResult.message}</div>`
        : '';

      this.root.innerHTML = `
        ${styleBlock}
        <div class="${cls.container || 'byok-card'}">
          <h3 class="${cls.header || 'byok-header'}">${t.settingsTitle}</h3>

          <div class="${cls.fieldGroup || 'byok-field'}">
            <label class="${cls.label || 'byok-label'}">${t.providerLabel}</label>
            <select id="byok-provider-select" class="${cls.select || 'byok-select'}">
              ${state.providers
                .map(
                  (p) =>
                    `<option value="${p.id}" ${p.id === state.activeProvider ? 'selected' : ''}>${p.name}</option>`
                )
                .join('')}
            </select>
          </div>

          <div class="${cls.fieldGroup || 'byok-field'}">
            <label class="${cls.label || 'byok-label'}">${t.vaultModeLabel}</label>
            <select id="byok-vault-select" class="${cls.select || 'byok-select'}">
              <option value="session" ${state.vaultMode === 'session' ? 'selected' : ''}>${t.vaultModeSession}</option>
              <option value="encrypted" ${state.vaultMode === 'encrypted' ? 'selected' : ''}>${t.vaultModeEncrypted}</option>
            </select>
          </div>

          <div class="${cls.fieldGroup || 'byok-field'}">
            <label class="${cls.label || 'byok-label'}">${t.apiKeyLabel}</label>
            <input
              id="byok-key-input"
              type="password"
              class="${cls.input || 'byok-input'}"
              placeholder="${t.apiKeyPlaceholder}"
              value="${state.activeKey}"
            />
          </div>

          <div class="${cls.fieldGroup || 'byok-field'}">
            <label class="${cls.label || 'byok-label'}">${t.modelLabel}</label>
            <input
              id="byok-model-input"
              type="text"
              class="${cls.input || 'byok-input'}"
              value="${state.customModel}"
            />
          </div>

          ${statusHtml}

          <div class="${cls.buttonRow || 'byok-actions'}">
            <button id="byok-test-btn" type="button" class="${cls.secondaryButton || 'byok-btn byok-btn-secondary'}">
              ${state.isTesting ? t.testingConnection : t.testConnectionBtn}
            </button>
            <button id="byok-purge-btn" type="button" class="${cls.dangerButton || 'byok-btn byok-btn-danger'}">
              ${t.purgeBtn}
            </button>
          </div>
        </div>
      `;

      const providerSelect = this.root.querySelector('#byok-provider-select') as HTMLSelectElement | null;
      providerSelect?.addEventListener('change', (e) => {
        this.controller?.selectProvider((e.target as HTMLSelectElement).value);
      });

      const vaultSelect = this.root.querySelector('#byok-vault-select') as HTMLSelectElement | null;
      vaultSelect?.addEventListener('change', (e) => {
        this.controller?.setVaultMode((e.target as HTMLSelectElement).value);
      });

      const keyInput = this.root.querySelector('#byok-key-input') as HTMLInputElement | null;
      keyInput?.addEventListener('change', (e) => {
        this.controller?.setKey((e.target as HTMLInputElement).value);
      });

      const modelInput = this.root.querySelector('#byok-model-input') as HTMLInputElement | null;
      modelInput?.addEventListener('change', (e) => {
        this.controller?.setCustomModel((e.target as HTMLInputElement).value);
      });

      const testBtn = this.root.querySelector('#byok-test-btn') as HTMLButtonElement | null;
      testBtn?.addEventListener('click', () => {
        this.controller?.testActiveConnection();
      });

      const purgeBtn = this.root.querySelector('#byok-purge-btn') as HTMLButtonElement | null;
      purgeBtn?.addEventListener('click', () => {
        this.controller?.purgeAllCredentials();
      });
    }
  }

  customElements.define(tagName, ByokSettingsElement);
}

