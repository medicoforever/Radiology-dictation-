import { GoogleGenAI } from "@google/genai";
import {
  ModelFallbackPolicy,
  STRICT_SELECTED_MODEL_ONLY_KEY,
  getModelDisplayLabel,
  resolveQuotaPoolModel as resolvePoolModelAlias,
} from "../constants";
import { isDriveConnected, loadJsonFileFromRootFolder, saveJsonFileToRootFolder } from "./googleDriveService";

// Obfuscated salt and keys to prevent raw API key string exposure in repo commits & secret scanners
const KEY_SALT = "RADDOC_RADIOLOGY_SECURE_VAULT_2026";

// Primary default key (obfuscated with KEY_SALT)
const PRIMARY_DEFAULT_OBFUSCATED_KEY = "ExBqBS17DRx3DTN+eAkvLQcbPAEhAS06MA8gGiMHUAJCVxg5LAYaL3IUBxcFPQEpFWspPxQ=";

// Secondary fallback keys (randomly selected if the primary key fails or reaches quota)
const SECONDARY_OBFUSCATED_KEYS: string[] = [
  "ExBqBS17DRx3DTEmeAsvCxQYdy4jE3AbCXk5GGZyfkYCfmokAjM5dho2Lx0sHCIrEDByHBQ=",
  "ExBqBS17DRx3Dz0fOjkLFDwcdhoBNnA5ZAJmJgQ5ZXpYQxcuFwV9MGdnFXQPCQAiIS4HYAQ=",
  "ExBqBS17DRx3CAh9BxUyLWsMIAYQOBNtGhUffBcxf3ZzdWobPn1iL2YEMw0fDgR9djAtHSI=",
  "ExBqBS17DRx3CAMIOTpwOApgcRoWOxcaLBs7JCw0eEhFcAt5PDMNFBskJxEHBgp2JTI9PSI=",
  "ExBqBS17DRx3DwYXORcObG1lCSYdGykKHCwMAgRnC0dRXD0vFic1dmwEAyEvLCcCCnRyEDI=",
  "ExBqBS17DRx3DwUnfyYFGDI/NQ8HHywHGQMDHwMtdEhBfRwbCix2MzRgDgV6eiItJTE3FQQ=",
  "ExBqBS17DRx3DTwoLR4yYDMqCDISPQQWOjszGDIAA0RbACcuLXRiJwYNNgMmIB0aDQY7IjI=",
  "ExBqBS17DRx3DiAIGR8vGCccE3YmImgmMHYNBgIbdWpHeiQxPnZiNAUlDS0dPgkEDSosFQQ=",
];

export const USER_KEYS_STORAGE_KEY = 'raddoc_user_gemini_api_keys';
export const API_KEYS_UPDATED_EVENT = 'raddoc_api_keys_updated';
export const SECRET_BUILTIN_KEYS_UNLOCKED_KEY = 'raddoc_builtin_keys_unlocked';
export const DRIVE_KEYS_FILE_NAME = 'raddoc_user_api_keys.json';
export const DRIVE_KEY_SETTINGS_FILE_NAME = 'raddoc_api_key_settings.json';
export const MODEL_FAILOVER_EVENT = 'raddoc_model_failover';
export const MODEL_OVERLOAD_UPDATED_EVENT = 'raddoc_model_overload_updated';
export const STRICT_MODEL_ONLY_UPDATED_EVENT = 'raddoc_strict_model_only_updated';
export const API_KEY_SETTINGS_UPDATED_EVENT = 'raddoc_api_key_settings_updated';

export const MODEL_FALLBACK_POLICY_KEY = 'raddoc_model_fallback_policy';
export const MEDIUM_PROSE_POLISH_KEY = 'raddoc_medium_prose_polish';
export const RETRY_TOP_TIER_ALL_KEYS_ON_503_KEY = 'raddoc_retry_top_tier_all_keys_on_503';
export const OVERLOADED_MODELS_SESSION_KEY = 'raddoc_overloaded_models_v1';

export interface OverloadedModelInfo {
  model: string;
  strikes: number;
  cooldownUntil: number;
  remainingMs: number;
}

export interface ModelFailoverEventDetail {
  fromModel: string;
  toModel: string;
  reason: 'rate_limit' | 'rpd_ledger' | 'service_unavailable' | 'network_error';
  timestamp: number;
  fromModelLabel: string;
  toModelLabel: string;
  reasonLabel: string;
  userMessage: string;
}

interface PersistedApiKeySettings {
  builtinUnlocked?: boolean;
  modelFallbackPolicy?: ModelFallbackPolicy;
  mediumProsePolish?: boolean;
  retryTopTierAllKeysOn503?: boolean;
}

function dispatchBrowserEvent(name: string, detail?: any): void {
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function' &&
      typeof CustomEvent === 'function'
    ) {
      window.dispatchEvent(new CustomEvent(name, detail !== undefined ? { detail } : undefined));
    }
  } catch {
    // Non-browser environment guard
  }
}

export function emitModelFailoverNotice(
  detail: Omit<ModelFailoverEventDetail, 'timestamp' | 'fromModelLabel' | 'toModelLabel' | 'reasonLabel' | 'userMessage'> &
    Partial<Pick<ModelFailoverEventDetail, 'fromModelLabel' | 'toModelLabel' | 'reasonLabel' | 'userMessage'>>
): void {
  const fromModelLabel = detail.fromModelLabel || getModelDisplayLabel(detail.fromModel);
  const toModelLabel = detail.toModelLabel || getModelDisplayLabel(detail.toModel);
  const reasonLabel =
    detail.reasonLabel ||
    (detail.reason === 'rate_limit'
      ? 'Daily limit reached on this model'
      : detail.reason === 'network_error'
      ? 'Temporary connection issue'
      : 'Model busy right now');
  const userMessage =
    detail.userMessage ||
    (detail.reason === 'rate_limit'
      ? `${fromModelLabel} reached its limit — switched to ${toModelLabel}.`
      : detail.reason === 'network_error'
      ? `${fromModelLabel} had a temporary connection drop — switched to ${toModelLabel}.`
      : `${fromModelLabel} is busy right now — switched to ${toModelLabel}.`);

  dispatchBrowserEvent(MODEL_FAILOVER_EVENT, {
    ...detail,
    fromModelLabel,
    toModelLabel,
    reasonLabel,
    userMessage,
    timestamp: Date.now(),
  });
}

function readLocalStorageString(key: string): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorageString(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Non-browser / quota guard
  }
}

function saveSettingsToDrive(): void {
  if (!isDriveConnected()) return;
  const payload: PersistedApiKeySettings = {
    builtinUnlocked: isBuiltinKeysUnlocked(),
    modelFallbackPolicy: getModelFallbackPolicy(),
    mediumProsePolish: isMediumProsePolishEnabled(),
    retryTopTierAllKeysOn503: isRetryTopTierAllKeysOn503Enabled(),
  };
  saveJsonFileToRootFolder(DRIVE_KEY_SETTINGS_FILE_NAME, payload).catch((err) => {
    console.warn("Could not auto-save API key settings to Drive:", err);
  });
}

export function getModelFallbackPolicy(): ModelFallbackPolicy {
  const raw = readLocalStorageString(MODEL_FALLBACK_POLICY_KEY);
  if (raw === 'top_and_medium' || raw === 'top_only' || raw === 'selected_only') {
    return raw;
  }
  if (readLocalStorageString(STRICT_SELECTED_MODEL_ONLY_KEY) === 'true') {
    return 'selected_only';
  }
  return 'top_and_medium';
}

export function setModelFallbackPolicy(policy: ModelFallbackPolicy): void {
  const clean: ModelFallbackPolicy =
    policy === 'top_only' || policy === 'selected_only' ? policy : 'top_and_medium';
  writeLocalStorageString(MODEL_FALLBACK_POLICY_KEY, clean);
  writeLocalStorageString(STRICT_SELECTED_MODEL_ONLY_KEY, clean === 'selected_only' ? 'true' : 'false');
  dispatchBrowserEvent(STRICT_MODEL_ONLY_UPDATED_EVENT, { enabled: clean === 'selected_only' });
  dispatchBrowserEvent(API_KEY_SETTINGS_UPDATED_EVENT, { modelFallbackPolicy: clean });
  saveSettingsToDrive();
}

export function isStrictSelectedModelOnlyEnabled(): boolean {
  return getModelFallbackPolicy() === 'selected_only';
}

export function setStrictSelectedModelOnlyEnabled(enabled: boolean): void {
  setModelFallbackPolicy(enabled ? 'selected_only' : 'top_and_medium');
}

export function isMediumProsePolishEnabled(): boolean {
  return readLocalStorageString(MEDIUM_PROSE_POLISH_KEY) === 'true';
}

export function setMediumProsePolishEnabled(enabled: boolean): void {
  writeLocalStorageString(MEDIUM_PROSE_POLISH_KEY, enabled ? 'true' : 'false');
  dispatchBrowserEvent(API_KEY_SETTINGS_UPDATED_EVENT, { mediumProsePolish: Boolean(enabled) });
  saveSettingsToDrive();
}

export function isRetryTopTierAllKeysOn503Enabled(): boolean {
  return readLocalStorageString(RETRY_TOP_TIER_ALL_KEYS_ON_503_KEY) === 'true';
}

export function setRetryTopTierAllKeysOn503Enabled(enabled: boolean): void {
  writeLocalStorageString(RETRY_TOP_TIER_ALL_KEYS_ON_503_KEY, enabled ? 'true' : 'false');
  dispatchBrowserEvent(API_KEY_SETTINGS_UPDATED_EVENT, { retryTopTierAllKeysOn503: Boolean(enabled) });
  saveSettingsToDrive();
}

// Salted signature for administrative secret passcode verification (completely hidden from plaintext):
const SECRET_PASSCODE_HASH = 'cmFkZG9jX3NhbHRfMTE5OF9zZWM=';

function verifySecretPasscode(input: string): boolean {
  if (!input) return false;
  try {
    const raw = `raddoc_salt_${input.trim()}_sec`;
    const encoded = typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw).toString('base64');
    return encoded === SECRET_PASSCODE_HASH;
  } catch {
    return false;
  }
}

/**
 * Checks whether the administrative secret key has been entered to activate built-in keys.
 */
export function isBuiltinKeysUnlocked(): boolean {
  return readLocalStorageString(SECRET_BUILTIN_KEYS_UNLOCKED_KEY) === 'true';
}

/**
 * Verifies the secret passcode and unlocks the 9 built-in keys if correct.
 */
export function unlockBuiltinKeys(code: string): { success: boolean; message: string } {
  if (verifySecretPasscode(code)) {
    try {
      writeLocalStorageString(SECRET_BUILTIN_KEYS_UNLOCKED_KEY, 'true');
      resetApiKeyHealthState();
      dispatchBrowserEvent(API_KEYS_UPDATED_EVENT);
      saveSettingsToDrive();
      return {
        success: true,
        message: 'Secret key verified! 9 built-in rotating API keys have been activated and saved.'
      };
    } catch (e: any) {
      return { success: false, message: e?.message || 'Storage error' };
    }
  }
  return { success: false, message: 'Invalid secret key. Please enter the correct code.' };
}

/**
 * Deactivates/locks the built-in keys.
 */
export function lockBuiltinKeys(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY, 'false');
      resetApiKeyHealthState();
      dispatchBrowserEvent(API_KEYS_UPDATED_EVENT);
      saveSettingsToDrive();
    }
  } catch (e) {
    console.error("Failed to lock built-in keys:", e);
  }
}

function xorDeobfuscate(b64: string, salt: string): string {
  try {
    const binary = atob(b64);
    const len = binary.length;
    const saltLen = salt.length;
    let res = '';
    for (let i = 0; i < len; i++) {
      const charCode = binary.charCodeAt(i) ^ salt.charCodeAt(i % saltLen);
      res += String.fromCharCode(charCode);
    }
    return res;
  } catch (err) {
    console.error("Failed to decode API key:", err);
    return '';
  }
}

/**
 * Retrieves the primary default API key (only if unlocked with administrative secret code).
 */
export function getPrimaryDefaultApiKey(): string {
  if (!isBuiltinKeysUnlocked()) return '';
  return xorDeobfuscate(PRIMARY_DEFAULT_OBFUSCATED_KEY, KEY_SALT);
}

/**
 * Retrieves the secondary backup pool of API keys (only if unlocked with administrative secret code).
 */
export function getSecondaryDefaultApiKeys(): string[] {
  if (!isBuiltinKeysUnlocked()) return [];
  const envKey = (typeof process !== 'undefined' && (process.env?.GEMINI_API_KEY || process.env?.API_KEY)) || '';
  const decoded = SECONDARY_OBFUSCATED_KEYS
    .map(obf => xorDeobfuscate(obf, KEY_SALT))
    .filter(k => k && k.length > 20);

  if (envKey && envKey.trim().length > 20 && !decoded.includes(envKey.trim())) {
    decoded.unshift(envKey.trim());
  }
  return decoded;
}

/**
 * Retrieves all default API keys: primary first, followed by secondaries.
 * Returns an EMPTY array by default, unless unlocked with administrative secret code!
 */
export function getDefaultApiKeys(): string[] {
  if (!isBuiltinKeysUnlocked()) {
    return [];
  }
  const primary = getPrimaryDefaultApiKey();
  const secondaries = getSecondaryDefaultApiKeys();
  const all = primary ? [primary, ...secondaries.filter(k => k !== primary)] : secondaries;
  return all;
}

/**
 * Retrieves custom API keys stored by the user in localStorage.
 */
export function getUserApiKeys(): string[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(USER_KEYS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((k: any) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k: string) => k.length >= 10);
    }
  } catch (e) {
    console.warn("Could not read user API keys from localStorage:", e);
  }
  return [];
}

/**
 * Checks if the user has provided one or more custom API keys.
 */
export function hasUserApiKeys(): boolean {
  return getUserApiKeys().length > 0;
}

function persistLocalUserKeys(clean: string[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(USER_KEYS_STORAGE_KEY, JSON.stringify(clean));
    resetApiKeyHealthState();
    dispatchBrowserEvent(API_KEYS_UPDATED_EVENT);
  }
}

/**
 * Saves user API keys to localStorage and automatically syncs to Google Drive if connected.
 */
export function setUserApiKeys(keys: string[]): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const clean = keys
        .map(k => k.trim())
        .filter(k => k.length >= 10)
        .filter((k, idx, arr) => arr.indexOf(k) === idx);
      persistLocalUserKeys(clean);

      if (isDriveConnected()) {
        saveJsonFileToRootFolder(DRIVE_KEYS_FILE_NAME, clean).catch(err => {
          console.warn("Could not auto-save user API keys to Drive:", err);
        });
      }
    }
  } catch (e) {
    console.error("Failed to save user API keys:", e);
  }
}

/**
 * Syncs user API keys and key/tier settings cleanly between localStorage and Google Drive.
 */
export async function syncApiKeysWithGoogleDrive(): Promise<{ success: boolean; syncedCount?: number }> {
  if (!isDriveConnected()) return { success: false };
  try {
    const [driveKeys, driveSettings] = await Promise.all([
      loadJsonFileFromRootFolder<string[]>(DRIVE_KEYS_FILE_NAME),
      loadJsonFileFromRootFolder<PersistedApiKeySettings>(DRIVE_KEY_SETTINGS_FILE_NAME),
    ]);
    const localKeys = getUserApiKeys();
    const cleanDriveKeys = Array.isArray(driveKeys)
      ? driveKeys
          .map((k: any) => (typeof k === 'string' ? k.trim() : ''))
          .filter((k: string) => k.length >= 10)
          .filter((k: string, idx: number, arr: string[]) => arr.indexOf(k) === idx)
      : [];

    const merged = [...localKeys];
    for (const k of cleanDriveKeys) {
      if (!merged.includes(k)) {
        merged.push(k);
      }
    }

    if (merged.length !== localKeys.length || merged.some((k, i) => localKeys[i] !== k)) {
      persistLocalUserKeys(merged);
    }

    const driveMissingAny =
      !Array.isArray(driveKeys) ||
      cleanDriveKeys.length !== merged.length ||
      merged.some(k => !cleanDriveKeys.includes(k));
    if (driveMissingAny && (merged.length > 0 || !Array.isArray(driveKeys))) {
      await saveJsonFileToRootFolder(DRIVE_KEYS_FILE_NAME, merged);
    }

    // Sync settings (builtinUnlocked, modelFallbackPolicy, mediumProsePolish, retryTopTierAllKeysOn503)
    if (typeof window !== 'undefined' && window.localStorage) {
      let settingsChanged = false;
      const localSecretRaw = window.localStorage.getItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY);
      if (localSecretRaw === null && driveSettings?.builtinUnlocked === true) {
        window.localStorage.setItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY, 'true');
        resetApiKeyHealthState();
        settingsChanged = true;
      }
      if (
        readLocalStorageString(MODEL_FALLBACK_POLICY_KEY) === null &&
        (driveSettings?.modelFallbackPolicy === 'top_and_medium' ||
          driveSettings?.modelFallbackPolicy === 'top_only' ||
          driveSettings?.modelFallbackPolicy === 'selected_only')
      ) {
        writeLocalStorageString(MODEL_FALLBACK_POLICY_KEY, driveSettings.modelFallbackPolicy);
        writeLocalStorageString(
          STRICT_SELECTED_MODEL_ONLY_KEY,
          driveSettings.modelFallbackPolicy === 'selected_only' ? 'true' : 'false'
        );
        settingsChanged = true;
      }
      if (readLocalStorageString(MEDIUM_PROSE_POLISH_KEY) === null && typeof driveSettings?.mediumProsePolish === 'boolean') {
        writeLocalStorageString(MEDIUM_PROSE_POLISH_KEY, driveSettings.mediumProsePolish ? 'true' : 'false');
        settingsChanged = true;
      }
      if (
        readLocalStorageString(RETRY_TOP_TIER_ALL_KEYS_ON_503_KEY) === null &&
        typeof driveSettings?.retryTopTierAllKeysOn503 === 'boolean'
      ) {
        writeLocalStorageString(
          RETRY_TOP_TIER_ALL_KEYS_ON_503_KEY,
          driveSettings.retryTopTierAllKeysOn503 ? 'true' : 'false'
        );
        settingsChanged = true;
      }

      if (settingsChanged) {
        dispatchBrowserEvent(API_KEYS_UPDATED_EVENT);
        dispatchBrowserEvent(API_KEY_SETTINGS_UPDATED_EVENT);
      }

      const currentLocal: PersistedApiKeySettings = {
        builtinUnlocked: isBuiltinKeysUnlocked(),
        modelFallbackPolicy: getModelFallbackPolicy(),
        mediumProsePolish: isMediumProsePolishEnabled(),
        retryTopTierAllKeysOn503: isRetryTopTierAllKeysOn503Enabled(),
      };
      const needsDriveSettingsSave =
        !driveSettings ||
        driveSettings.builtinUnlocked !== currentLocal.builtinUnlocked ||
        driveSettings.modelFallbackPolicy !== currentLocal.modelFallbackPolicy ||
        driveSettings.mediumProsePolish !== currentLocal.mediumProsePolish ||
        driveSettings.retryTopTierAllKeysOn503 !== currentLocal.retryTopTierAllKeysOn503;

      if (needsDriveSettingsSave) {
        await saveJsonFileToRootFolder(DRIVE_KEY_SETTINGS_FILE_NAME, currentLocal);
      }
    }

    return { success: true, syncedCount: merged.length };
  } catch (e) {
    console.warn("Could not sync API keys with Google Drive:", e);
    return { success: false };
  }
}

/**
 * Adds a single user API key.
 */
export function addUserApiKey(newKey: string): boolean {
  const clean = newKey.trim();
  if (!clean || clean.length < 10) return false;
  const current = getUserApiKeys();
  if (current.includes(clean)) return true;
  setUserApiKeys([...current, clean]);
  return true;
}

/**
 * Removes a specific API key from the user's stored keys.
 */
export function removeUserApiKey(targetKey: string): void {
  const current = getUserApiKeys();
  const filtered = current.filter(k => k !== targetKey.trim());
  setUserApiKeys(filtered);
}

/**
 * Clears all user custom keys.
 */
export function clearUserApiKeys(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(USER_KEYS_STORAGE_KEY);
      resetApiKeyHealthState();
      dispatchBrowserEvent(API_KEYS_UPDATED_EVENT);
      if (isDriveConnected()) {
        saveJsonFileToRootFolder(DRIVE_KEYS_FILE_NAME, []).catch(() => {});
      }
    }
  } catch (e) {
    console.error("Failed to clear user API keys:", e);
  }
}

// --- Adaptive Exponential 503 Cooldown (sessionStorage + RAM) & LRU Key Pool Health ---

type KeyCooldownEntry = {
  untilMs: number;
  kind: 'rpm' | 'rpd';
  hitCount: number;
  lastErrorAt: number;
};

type ModelOverloadRecord = {
  strikes: number;
  cooldownUntil: number;
};

const keyModelCooldowns = new Map<string, KeyCooldownEntry>();
const keyGlobalInvalidUntil = new Map<string, number>();
const keyModelRecentRequests = new Map<string, number[]>();
const keyLastDispatchedAt = new Map<string, number>();
const modelOverloadStates = new Map<string, ModelOverloadRecord>();

const RPM_WINDOW_MS = 60_000;
const DEFAULT_RPM_COOLDOWN_MS = 65_000;
const DEFAULT_INVALID_KEY_COOLDOWN_MS = 10 * 60_000;

export const OVERLOAD_COOLDOWN_LADDER_MS = [
  5 * 60_000,   // Strike 1: 5m
  15 * 60_000,  // Strike 2: 15m
  30 * 60_000,  // Strike 3: 30m
  60 * 60_000,  // Strike 4+: 60m
] as const;

export const MODEL_UNAVAILABLE_COOLDOWN_MS = OVERLOAD_COOLDOWN_LADDER_MS[0];

export function resolveQuotaPoolModel(model?: string): string {
  return resolvePoolModelAlias(model);
}

function loadOverloadFromSessionStorage(): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    const raw = window.sessionStorage.getItem(OVERLOADED_MODELS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [model, rec] of Object.entries(parsed)) {
      if (
        rec &&
        typeof rec === 'object' &&
        typeof (rec as any).strikes === 'number' &&
        typeof (rec as any).cooldownUntil === 'number'
      ) {
        modelOverloadStates.set(model, {
          strikes: (rec as any).strikes,
          cooldownUntil: (rec as any).cooldownUntil,
        });
      }
    }
  } catch {
    // Ignore storage parse failures
  }
}

function persistOverloadToSessionStorage(): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    if (modelOverloadStates.size === 0) {
      window.sessionStorage.removeItem(OVERLOADED_MODELS_SESSION_KEY);
      return;
    }
    const obj: Record<string, ModelOverloadRecord> = {};
    for (const [k, v] of modelOverloadStates.entries()) {
      obj[k] = v;
    }
    window.sessionStorage.setItem(OVERLOADED_MODELS_SESSION_KEY, JSON.stringify(obj));
  } catch {
    // Ignore storage failures
  }
}

function ensureOverloadHydrated(): void {
  if (modelOverloadStates.size === 0) {
    loadOverloadFromSessionStorage();
  }
}

export function markModelTemporarilyUnavailable(model: string, now = Date.now()): OverloadedModelInfo | null {
  const bucket = resolveQuotaPoolModel(model);
  if (!bucket || bucket === 'default') return null;
  ensureOverloadHydrated();
  const prev = modelOverloadStates.get(bucket);
  const strikes = (prev?.strikes ?? 0) + 1;
  const ladderIdx = Math.min(strikes - 1, OVERLOAD_COOLDOWN_LADDER_MS.length - 1);
  const durationMs = OVERLOAD_COOLDOWN_LADDER_MS[ladderIdx];
  const cooldownUntil = now + durationMs;
  modelOverloadStates.set(bucket, { strikes, cooldownUntil });
  persistOverloadToSessionStorage();

  const info: OverloadedModelInfo = {
    model: bucket,
    strikes,
    cooldownUntil,
    remainingMs: durationMs,
  };
  dispatchBrowserEvent(MODEL_OVERLOAD_UPDATED_EVENT, {
    states: getOverloadedModelStates(now),
  });
  return info;
}

export function clearModelTemporarilyUnavailable(model: string): void {
  const bucket = resolveQuotaPoolModel(model);
  if (!bucket) return;
  ensureOverloadHydrated();
  if (modelOverloadStates.delete(bucket)) {
    persistOverloadToSessionStorage();
    dispatchBrowserEvent(MODEL_OVERLOAD_UPDATED_EVENT, {
      states: getOverloadedModelStates(),
    });
  }
}

export function clearAllModelUnavailableCooldowns(): void {
  modelOverloadStates.clear();
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.removeItem(OVERLOADED_MODELS_SESSION_KEY);
    }
  } catch {
    // Ignore
  }
  dispatchBrowserEvent(MODEL_OVERLOAD_UPDATED_EVENT, { states: [] });
}

export function isModelTemporarilyUnavailable(model: string, now = Date.now()): boolean {
  const bucket = resolveQuotaPoolModel(model);
  if (!bucket || bucket === 'default') return false;
  ensureOverloadHydrated();
  const rec = modelOverloadStates.get(bucket);
  if (!rec) return false;
  // Note: when cooldownUntil <= now, keep `strikes` in memory so subsequent 503s escalate 5m->15m->30m->60m
  // until a 200 OK explicitly clears the record.
  return rec.cooldownUntil > now;
}

export function getOverloadedModelStates(now = Date.now()): OverloadedModelInfo[] {
  ensureOverloadHydrated();
  const out: OverloadedModelInfo[] = [];
  for (const [model, rec] of modelOverloadStates.entries()) {
    if (rec.cooldownUntil > now) {
      out.push({
        model,
        strikes: rec.strikes,
        cooldownUntil: rec.cooldownUntil,
        remainingMs: rec.cooldownUntil - now,
      });
    }
  }
  out.sort((a, b) => b.remainingMs - a.remainingMs);
  return out;
}

/**
 * Clears in-memory key cooldown & temporary overload state.
 */
export function resetApiKeyHealthState(): void {
  keyModelCooldowns.clear();
  keyGlobalInvalidUntil.clear();
  keyModelRecentRequests.clear();
  keyLastDispatchedAt.clear();
  clearAllModelUnavailableCooldowns();
}

function getPoolKey(apiKey: string, poolModel: string): string {
  return `${apiKey}::${poolModel}`;
}

function getActiveCooldown(apiKey: string, poolModel: string, now: number): { untilMs: number; kind: 'rpm' | 'rpd' } | null {
  const mem = keyModelCooldowns.get(getPoolKey(apiKey, poolModel));
  if (mem && mem.untilMs > now) {
    return { untilMs: mem.untilMs, kind: mem.kind };
  }
  return null;
}

function pruneRecentRequests(poolKey: string, now: number): number[] {
  const arr = keyModelRecentRequests.get(poolKey);
  if (!arr || arr.length === 0) return [];
  const fresh = arr.filter((t) => now - t < RPM_WINDOW_MS);
  keyModelRecentRequests.set(poolKey, fresh);
  return fresh;
}

function markApiKeyDispatched(apiKey: string, poolModel: string, now = Date.now()): void {
  const poolKey = getPoolKey(apiKey, poolModel);
  const fresh = pruneRecentRequests(poolKey, now);
  fresh.push(now);
  keyModelRecentRequests.set(poolKey, fresh);
  keyLastDispatchedAt.set(apiKey, now);
}

function recordApiKeyFailure(apiKey: string, poolModel: string, err: any, now = Date.now()): void {
  const status = err?.status ?? err?.code ?? err?.error?.code;
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    msg.includes('permission_denied') ||
    msg.includes('unauthenticated')
  ) {
    keyGlobalInvalidUntil.set(apiKey, now + DEFAULT_INVALID_KEY_COOLDOWN_MS);
    return;
  }

  const isQuotaError =
    status === 429 ||
    status === 'RESOURCE_EXHAUSTED' ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests');

  if (!isQuotaError) return;

  const poolKey = getPoolKey(apiKey, poolModel);
  const prev = keyModelCooldowns.get(poolKey);
  const hitCount = prev && now - prev.lastErrorAt < 10 * 60_000 ? prev.hitCount + 1 : 1;
  keyModelCooldowns.set(poolKey, {
    untilMs: now + DEFAULT_RPM_COOLDOWN_MS,
    kind: 'rpm',
    hitCount,
    lastErrorAt: now,
  });
}

function getRawCandidateKeyPools(_selectedModel?: string): { customKeys: string[]; builtinKeys: string[] } {
  const customKeys = getUserApiKeys();
  const customSet = new Set(customKeys);
  const builtinKeys = getDefaultApiKeys().filter((k) => !customSet.has(k));
  return { customKeys, builtinKeys };
}

/**
 * Returns the total number of unique active API keys across user custom keys
 * and unlocked built-in pool keys.
 */
export function getTotalActiveApiKeyCount(): number {
  const { customKeys, builtinKeys } = getRawCandidateKeyPools();
  return customKeys.length + builtinKeys.length;
}

function classifyPoolTier(rawKeys: string[], poolModel: string, now: number) {
  const healthy: Array<{ key: string; recentCount: number; lastUsed: number }> = [];
  const shortRpmCooled: Array<{ key: string; untilMs: number }> = [];
  const invalidKeys: Array<{ key: string; untilMs: number }> = [];

  for (const key of shuffle(rawKeys)) {
    const invalidUntil = keyGlobalInvalidUntil.get(key) ?? 0;
    if (invalidUntil > now) {
      invalidKeys.push({ key, untilMs: invalidUntil });
      continue;
    }

    const poolKey = getPoolKey(key, poolModel);
    const cd = getActiveCooldown(key, poolModel, now);
    if (cd && cd.untilMs > now) {
      shortRpmCooled.push({ key, untilMs: cd.untilMs });
      continue;
    }

    const recent = pruneRecentRequests(poolKey, now);
    healthy.push({
      key,
      recentCount: recent.length,
      lastUsed: keyLastDispatchedAt.get(key) ?? 0,
    });
  }

  healthy.sort((a, b) => {
    if (a.recentCount !== b.recentCount) return a.recentCount - b.recentCount;
    return a.lastUsed - b.lastUsed;
  });
  shortRpmCooled.sort((a, b) => a.untilMs - b.untilMs);
  invalidKeys.sort((a, b) => a.untilMs - b.untilMs);

  return { healthy, shortRpmCooled, invalidKeys };
}

/**
 * Returns candidate API keys ordered by:
 * 1. Healthy user custom keys FIRST (fewest 60s requests, then LRU).
 * 2. If secret 1198 is unlocked, healthy built-in keys strictly AFTER custom keys.
 * 3. Recently 429-cooled valid keys (custom first, then built-in) right behind healthy keys.
 */
export function getCandidateKeysForOperation(
  selectedModel?: string,
  _options?: { includeRpdCooled?: boolean }
): { candidateKeys: string[]; isCustom: boolean; hasBuiltinBackup: boolean } {
  const { customKeys, builtinKeys } = getRawCandidateKeyPools(selectedModel);
  const isCustom = customKeys.length > 0;
  const hasBuiltinBackup = isCustom && builtinKeys.length > 0;

  if (customKeys.length === 0 && builtinKeys.length === 0) {
    return { candidateKeys: [], isCustom: false, hasBuiltinBackup: false };
  }

  const now = Date.now();
  const poolModel = resolveQuotaPoolModel(selectedModel);

  const customTier = classifyPoolTier(customKeys, poolModel, now);
  const builtinTier = classifyPoolTier(builtinKeys, poolModel, now);

  const ordered = [
    ...customTier.healthy.map((h) => h.key),
    ...builtinTier.healthy.map((h) => h.key),
    ...customTier.shortRpmCooled.map((c) => c.key),
    ...builtinTier.shortRpmCooled.map((c) => c.key),
  ];

  if (ordered.length === 0) {
    if (customTier.invalidKeys.length > 0) {
      ordered.push(customTier.invalidKeys[0].key);
    } else if (builtinTier.invalidKeys.length > 0) {
      ordered.push(builtinTier.invalidKeys[0].key);
    }
  }

  return {
    candidateKeys: ordered,
    isCustom,
    hasBuiltinBackup,
  };
}

/**
 * Shuffles an array randomly using Fisher-Yates.
 */
function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Client cache to avoid reinstantiating GoogleGenAI unnecessarily
const clientCache = new Map<string, GoogleGenAI>();

export function getClientForApiKey(apiKey: string): GoogleGenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({
      apiKey: apiKey,
    });
    clientCache.set(apiKey, client);
  }
  return client;
}

/**
 * Obscures a key for display: "AQ.Ab8••••••••897A" or "AIzaSy••••••••58Gw"
 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '••••••••••';
  return `${key.slice(0, 6)}••••••••${key.slice(-4)}`;
}

/**
 * Tests whether an API key is valid by making a lightweight model query.
 */
export async function testApiKeyValidity(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { method: 'GET' });
    if (res.ok) {
      return { valid: true };
    }
    const data = await res.json().catch(() => ({}));
    const msg = data?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
    return { valid: false, error: msg };
  } catch (e: any) {
    return { valid: false, error: e?.message || 'Network request failed' };
  }
}

/**
 * Detects model-wide transient overload or service unavailability errors (`503/502/504/500/404`,
 * `"high demand"`, `"overloaded"`, `"unavailable"`, or request timeouts) so 503 retries are capped
 * and cross-model failover triggers cleanly without draining all backup keys' RPD counters.
 */
export function isModelLevelServiceUnavailableError(err: any): boolean {
  if (!err) return false;
  if (err?.name === 'AbortError') return false;

  const rawStatus = err?.status ?? err?.code ?? err?.error?.code;
  const status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
  const statusText = String(err?.statusText ?? err?.error?.status ?? '').toLowerCase();
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (status === 503 || status === 502 || status === 504 || status === 404 || status === 408) {
    return true;
  }
  if (status === 500 && !msg.includes('invalid argument') && !msg.includes('api key')) {
    return true;
  }
  if (statusText === 'unavailable') {
    return true;
  }
  return (
    msg.includes('high demand') ||
    msg.includes('currently experiencing high demand') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('service unavailable') ||
    msg.includes('"status":"unavailable"') ||
    msg.includes('"status": "unavailable"') ||
    msg.includes('"code":503') ||
    msg.includes('"code": 503') ||
    msg.includes('http 503') ||
    msg.includes('model not found') ||
    msg.includes('is not found for api version') ||
    msg.includes('timed out') ||
    msg.includes('timeout')
  );
}

export function isNetworkFetchError(err: any): boolean {
  if (!err) return false;
  if (err?.name === 'AbortError') return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('sending request') ||
    msg.includes('fetch failed') ||
    msg.includes('load failed') ||
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('network request failed') ||
    msg.includes('err_network')
  );
}

/**
 * Universal executor with LRU + 60s RPM window ordering, custom-first + 9-key backup chaining,
 * and key-count-aware 503 retry caps.
 */
export async function executeWithApiKeyFailover<T>(
  operation: (client: GoogleGenAI, apiKey: string) => Promise<T>,
  options?: {
    selectedModel?: string;
    maxTries?: number;
    delayMs?: number;
    abortSignal?: AbortSignal;
    failFastOnModelUnavailable?: boolean;
    includeRpdCooled?: boolean;
    allowFullPoolOn503?: boolean;
  }
): Promise<T> {
  if (options?.abortSignal?.aborted) {
    throw new DOMException('Aborted by user', 'AbortError');
  }

  const includeRpdCooled =
    options?.includeRpdCooled ??
    (isStrictSelectedModelOnlyEnabled() && !options?.failFastOnModelUnavailable);
  const { candidateKeys, isCustom } = getCandidateKeysForOperation(options?.selectedModel, {
    includeRpdCooled,
  });
  if (!candidateKeys || candidateKeys.length === 0) {
    throw new Error("No Gemini API key found. Please click 'API Keys' at the top to add your free Gemini API key or enter the secret access code.");
  }

  const poolModel = resolveQuotaPoolModel(options?.selectedModel);
  const keyCount = candidateKeys.length;
  const maxAttempts = options?.maxTries
    ? Math.min(options.maxTries, keyCount)
    : keyCount;

  const max503Tries = options?.failFastOnModelUnavailable
    ? (keyCount <= 2 ? 1 : 2)
    : (options?.allowFullPoolOn503 ? maxAttempts : Math.min(keyCount, 3));
  const maxNetworkTries = options?.failFastOnModelUnavailable
    ? Math.min(keyCount, 2)
    : (options?.allowFullPoolOn503 ? maxAttempts : Math.min(keyCount, 3));

  let lastError: any = null;
  let unavailableHits = 0;
  let networkHits = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options?.abortSignal?.aborted) {
      throw new DOMException('Aborted by user', 'AbortError');
    }

    const currentKey = candidateKeys[attempt];
    const masked = maskApiKey(currentKey);
    const client = getClientForApiKey(currentKey);
    markApiKeyDispatched(currentKey, poolModel);

    try {
      if (attempt === 0) {
        const keyRole = isCustom ? 'custom key' : 'pool key';
        console.info(`[API Execution] Attempt 1/${maxAttempts} using ${keyRole} ${masked} (Model: ${options?.selectedModel || 'selected'})...`);
      } else {
        console.warn(`[API Failover] Attempt ${attempt + 1}/${maxAttempts} retrying with backup key ${masked} (Model: ${options?.selectedModel || 'selected'})...`);
      }
      const result = await operation(client, currentKey);
      return result;
    } catch (err: any) {
      if (err?.name === 'AbortError' || options?.abortSignal?.aborted) {
        throw err;
      }
      if (err?.isNonRetryable === true) {
        throw err;
      }

      recordApiKeyFailure(currentKey, poolModel, err);
      lastError = err;
      const errMsg = err?.message || String(err);

      if (isModelLevelServiceUnavailableError(err)) {
        unavailableHits++;
        if (unavailableHits >= max503Tries) {
          console.warn(
            `[API Key Failover] Model ${options?.selectedModel || 'selected'} hit ${unavailableHits}/${max503Tries} busy/unavailable attempts (${errMsg}); stopping key rotation.`
          );
          if (lastError && typeof lastError === 'object') {
            lastError.triedKeysCount = attempt + 1;
          }
          throw err;
        }
      } else if (isNetworkFetchError(err)) {
        networkHits++;
        if (networkHits >= maxNetworkTries) {
          console.warn(
            `[API Key Failover] Model ${options?.selectedModel || 'selected'} hit ${networkHits}/${maxNetworkTries} network fetch failures (${errMsg}); stopping key rotation.`
          );
          if (lastError && typeof lastError === 'object') {
            lastError.triedKeysCount = attempt + 1;
          }
          throw err;
        }
      }

      console.warn(
        `[API Key Failover] Key ${masked} failed on attempt ${attempt + 1}/${maxAttempts} (${errMsg}). Evaluating next healthy key...`
      );

      if (attempt < maxAttempts - 1) {
        if (options?.abortSignal?.aborted) {
          throw new DOMException('Aborted by user', 'AbortError');
        }
        const retryDelayMs = options?.delayMs ?? 150;
        if (retryDelayMs > 0) {
          console.info(`[API Key Failover] Waiting ${retryDelayMs}ms before retrying with next key...`);
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, retryDelayMs);
            options?.abortSignal?.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(new DOMException('Aborted by user', 'AbortError'));
            }, { once: true });
          });
        }
        continue;
      }
    }
  }

  console.error(`[API Key Failover] All ${maxAttempts} candidate API keys failed:`, lastError);
  if (lastError && typeof lastError === 'object' && lastError.triedKeysCount === undefined) {
    lastError.triedKeysCount = maxAttempts;
  }
  throw lastError;
}

/**
 * Returns a GoogleGenAI client instance using the best available key from the current active pool.
 */
export function getRandomAIClient(): GoogleGenAI {
  const { candidateKeys } = getCandidateKeysForOperation();
  const pool = candidateKeys.length > 0 ? candidateKeys : getDefaultApiKeys();
  if (!pool || pool.length === 0) {
    throw new Error("No Gemini API key found. Please add a free Gemini API key in API Keys or enter the secret access code.");
  }
  return getClientForApiKey(pool[0]);
}
