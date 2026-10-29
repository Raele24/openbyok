/**
 * openbyok/core Localization (i18n) Dictionary
 *
 * Provides localized UI strings, CLI prompts, and AI language instructions
 * across English, Italian, French, Spanish, and German, with custom locale registration.
 */

import { SupportedLanguage } from './types';

export interface ByokTranslationStrings {
  languageName: string;
  settingsTitle: string;
  providerLabel: string;
  apiKeyLabel: string;
  apiKeyPlaceholder: string;
  endpointLabel: string;
  modelLabel: string;
  vaultModeLabel: string;
  vaultModeSession: string;
  vaultModeEncrypted: string;
  testConnectionBtn: string;
  testingConnection: string;
  saveBtn: string;
  purgeBtn: string;
  purgeConfirm: string;
  keyMissingError: string;
  connectionSuccess: string;
  connectionFailed: string;
}

const DEFAULT_TRANSLATIONS: Record<string, ByokTranslationStrings> = {
  en: {
    languageName: 'English',
    settingsTitle: 'AI Provider & Key Settings',
    providerLabel: 'AI Provider',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'Enter your API key...',
    endpointLabel: 'Endpoint URL',
    modelLabel: 'Model Name',
    vaultModeLabel: 'Credential Storage Mode',
    vaultModeSession: 'Session Only (In-Memory RAM)',
    vaultModeEncrypted: 'Encrypted Persistent (WebCrypto AES-256)',
    testConnectionBtn: 'Test Connection',
    testingConnection: 'Testing...',
    saveBtn: 'Save Settings',
    purgeBtn: 'Purge All Keys',
    purgeConfirm: 'All credentials removed from memory and storage.',
    keyMissingError: 'API key is required for this provider.',
    connectionSuccess: 'Connected successfully.',
    connectionFailed: 'Connection failed.',
  },
  it: {
    languageName: 'Italian (Italiano)',
    settingsTitle: 'Impostazioni Provider AI e Chiavi',
    providerLabel: 'Provider AI',
    apiKeyLabel: 'Chiave API',
    apiKeyPlaceholder: 'Inserisci la tua chiave API...',
    endpointLabel: 'URL Endpoint',
    modelLabel: 'Nome Modello',
    vaultModeLabel: 'Modalita Salvataggio Credenziali',
    vaultModeSession: 'Solo Sessione (Memoria RAM)',
    vaultModeEncrypted: 'Persistente Cifrato (WebCrypto AES-256)',
    testConnectionBtn: 'Testa Connessione',
    testingConnection: 'Verifica in corso...',
    saveBtn: 'Salva Impostazioni',
    purgeBtn: 'Cancella Tutte le Chiavi',
    purgeConfirm: 'Tutte le credenziali sono state rimosse da memoria e disco.',
    keyMissingError: 'La chiave API e obbligatoria per questo provider.',
    connectionSuccess: 'Connessione riuscita.',
    connectionFailed: 'Connessione fallita.',
  },
  fr: {
    languageName: 'French (Francais)',
    settingsTitle: 'Parametres du Fournisseur IA et Cles',
    providerLabel: 'Fournisseur IA',
    apiKeyLabel: 'Cle API',
    apiKeyPlaceholder: 'Entrez votre cle API...',
    endpointLabel: 'URL du Point de Terminaison',
    modelLabel: 'Nom du Modele',
    vaultModeLabel: 'Mode de Stockage des Identifiants',
    vaultModeSession: 'Session Uniquement (Memoire RAM)',
    vaultModeEncrypted: 'Persistant Chiffre (WebCrypto AES-256)',
    testConnectionBtn: 'Tester la Connexion',
    testingConnection: 'Test en cours...',
    saveBtn: 'Enregistrer',
    purgeBtn: 'Purger Toutes les Cles',
    purgeConfirm: 'Tous les identifiants ont ete supprimes.',
    keyMissingError: 'Une cle API est requise pour ce fournisseur.',
    connectionSuccess: 'Connexion etablie.',
    connectionFailed: 'Echec de la connexion.',
  },
  es: {
    languageName: 'Spanish (Espanol)',
    settingsTitle: 'Configuracion de Proveedor IA y Claves',
    providerLabel: 'Proveedor IA',
    apiKeyLabel: 'Clave API',
    apiKeyPlaceholder: 'Introduce tu clave API...',
    endpointLabel: 'URL del Endpoint',
    modelLabel: 'Nombre del Modelo',
    vaultModeLabel: 'Modo de Almacenamiento de Claves',
    vaultModeSession: 'Solo Sesion (Memoria RAM)',
    vaultModeEncrypted: 'Persistente Cifrado (WebCrypto AES-256)',
    testConnectionBtn: 'Probar Conexion',
    testingConnection: 'Probando...',
    saveBtn: 'Guardar Configuracion',
    purgeBtn: 'Borrar Todas las Claves',
    purgeConfirm: 'Todas las credenciales han sido eliminadas.',
    keyMissingError: 'Se requiere una clave API para este proveedor.',
    connectionSuccess: 'Conectado con exito.',
    connectionFailed: 'Error de conexion.',
  },
  de: {
    languageName: 'German (Deutsch)',
    settingsTitle: 'KI-Anbieter und Schlusseleinstellungen',
    providerLabel: 'KI-Anbieter',
    apiKeyLabel: 'API-Schlussel',
    apiKeyPlaceholder: 'API-Schlussel eingeben...',
    endpointLabel: 'Endpunkt-URL',
    modelLabel: 'Modellname',
    vaultModeLabel: 'Speichermodus fur Zugangsdaten',
    vaultModeSession: 'Nur Sitzung (RAM-Speicher)',
    vaultModeEncrypted: 'Verschlusselt Permanent (WebCrypto AES-256)',
    testConnectionBtn: 'Verbindung Testen',
    testingConnection: 'Wird getestet...',
    saveBtn: 'Einstellungen Speichern',
    purgeBtn: 'Alle Schlussel Loschen',
    purgeConfirm: 'Alle Zugangsdaten wurden geloscht.',
    keyMissingError: 'Fur diesen Anbieter ist ein API-Schlussel erforderlich.',
    connectionSuccess: 'Erfolgreich verbunden.',
    connectionFailed: 'Verbindung fehlgeschlagen.',
  },
};

export class ByokLocalizer {
  private static locales = new Map<string, ByokTranslationStrings>(
    Object.entries(DEFAULT_TRANSLATIONS)
  );

  /**
   * Registers or overrides a localization dictionary.
   */
  public static registerLocale(langCode: string, strings: Partial<ByokTranslationStrings>): void {
    const base = this.locales.get('en')!;
    const existing = this.locales.get(langCode.toLowerCase()) || base;
    this.locales.set(langCode.toLowerCase(), { ...existing, ...strings });
  }

  /**
   * Returns translation strings for the given language code (falls back to 'en').
   */
  public static getStrings(langCode?: SupportedLanguage): ByokTranslationStrings {
    if (!langCode) return this.locales.get('en')!;
    const clean = langCode.toLowerCase().split('-')[0];
    return this.locales.get(clean) || this.locales.get('en')!;
  }

  /**
   * Resolves the full language display name for AI prompt instructions.
   */
  public static getLanguageName(langCode?: SupportedLanguage): string {
    if (!langCode || langCode === 'auto') return 'English';
    const entry = this.locales.get(langCode.toLowerCase());
    return entry ? entry.languageName : langCode.toUpperCase();
  }
}

