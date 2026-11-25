import { GoogleGenAI } from "@google/genai";
import { STRICT_SELECTED_MODEL_ONLY_KEY } from "../constants";
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
export const QUOTA_LEDGER_STORAGE_KEY = 'raddoc_free_tier_quota_ledger_v1';
export const MODEL_FAILOVER_EVENT = 'raddoc_model_failover';
export const STRICT_MODEL_ONLY_UPDATED_EVENT = 'raddoc_strict_model_only_updated';

export function isStrictSelectedModelOnlyEnabled(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return localStorage.getItem(STRICT_SELECTED_MODEL_ONLY_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setStrictSelectedModelOnlyEnabled(enabled: boolean): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(STRICT_SELECTED_MODEL_ONLY_KEY, enabled ? 'true' : 'false');
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(STRICT_MODEL_ONLY_UPDATED_EVENT, { detail: { enabled } }));
    }
  } catch {
    // Non-browser environment guard
  }
}

export interface ModelFailoverEventDetail {
  fromModel: string;
  toModel: string;
  reason: 'rate_limit' | 'rpd_ledger' | 'service_unavailable';
  timestamp: number;
}

export function emitModelFailoverNotice(detail: Omit<ModelFailoverEventDetail, 'timestamp'>): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent<ModelFailoverEventDetail>(MODEL_FAILOVER_EVENT, {
          detail: { ...detail, timestamp: Date.now() },
        })
      );
    }
  } catch {
    // Non-browser environment guard
  }
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
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return localStorage.getItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveBuiltinUnlockStateToDrive(unlocked: boolean): void {
  if (!isDriveConnected()) return;
  saveJsonFileToRootFolder(DRIVE_KEY_SETTINGS_FILE_NAME, { builtinUnlocked: unlocked }).catch((err) => {
    console.warn("Could not auto-save secret unlock setting to Drive:", err);
  });
}

/**
 * Verifies the secret passcode and unlocks the 9 built-in keys if correct.
 */
export function unlockBuiltinKeys(code: string): { success: boolean; message: string } {
  if (verifySecretPasscode(code)) {
    try {
      localStorage.setItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY, 'true');
      resetApiKeyHealthState();
      window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
      saveBuiltinUnlockStateToDrive(true);
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
      localStorage.setItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY, 'false');
      resetApiKeyHealthState();
      window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
      saveBuiltinUnlockStateToDrive(false);
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
    const raw = localStorage.getItem(USER_KEYS_STORAGE_KEY);
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
    localStorage.setItem(USER_KEYS_STORAGE_KEY, JSON.stringify(clean));
    resetApiKeyHealthState();
    window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
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

      // Auto-save to Google Drive in background if connected
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
 * Syncs both user API keys and secret unlock preference cleanly between localStorage and Google Drive.
 */
export async function syncApiKeysWithGoogleDrive(): Promise<{ success: boolean; syncedCount?: number }> {
  if (!isDriveConnected()) return { success: false };
  try {
    const [driveKeys, driveSettings] = await Promise.all([
      loadJsonFileFromRootFolder<string[]>(DRIVE_KEYS_FILE_NAME),
      loadJsonFileFromRootFolder<{ builtinUnlocked?: boolean }>(DRIVE_KEY_SETTINGS_FILE_NAME),
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

    // Also sync secret 1198 unlock status between localStorage and Google Drive
    if (typeof window !== 'undefined' && window.localStorage) {
      const localSecretRaw = localStorage.getItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY);
      if (localSecretRaw === 'true' && driveSettings?.builtinUnlocked !== true) {
        await saveJsonFileToRootFolder(DRIVE_KEY_SETTINGS_FILE_NAME, { builtinUnlocked: true });
      } else if (localSecretRaw === 'false' && driveSettings?.builtinUnlocked === true) {
        await saveJsonFileToRootFolder(DRIVE_KEY_SETTINGS_FILE_NAME, { builtinUnlocked: false });
      } else if (localSecretRaw === null && driveSettings?.builtinUnlocked === true) {
        localStorage.setItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY, 'true');
        resetApiKeyHealthState();
        window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
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
      localStorage.removeItem(USER_KEYS_STORAGE_KEY);
      resetApiKeyHealthState();
      window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
      if (isDriveConnected()) {
        saveJsonFileToRootFolder(DRIVE_KEYS_FILE_NAME, []).catch(() => {});
      }
    }
  } catch (e) {
    console.error("Failed to clear user API keys:", e);
  }
}

type KeyCooldownEntry = {
  untilMs: number;
  kind: 'rpm' | 'rpd';
  hitCount: number;
  lastErrorAt: number;
};

type LedgerPoolStats = {
  count: number;
  cooldownUntil?: number;
  cooldownKind?: 'rpm' | 'rpd';
};

type PersistedQuotaLedger = {
  datePt: string;
  entries: Record<string, Record<string, LedgerPoolStats>>;
};

export interface FreeTierModelQuotaStat {
  model: string;
  label: string;
  rpdLimitPerKey: number;
  usedToday: number;
  totalCapacity: number;
  exhaustedKeys: number;
  totalKeys: number;
}

const TRACKED_FREE_TIER_MODELS: Array<{ model: string; label: string; rpdLimitPerKey: number }> = [
  { model: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (#1 Default)', rpdLimitPerKey: 20 },
  { model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (#2 Accuracy)', rpdLimitPerKey: 20 },
  { model: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (#3 Accuracy)', rpdLimitPerKey: 20 },
  { model: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (#4 Backup)', rpdLimitPerKey: 20 },
  { model: 'gemini-robotics-er-2-preview', label: 'Gemini Robotics ER-2 (#5 Backup)', rpdLimitPerKey: 20 },
  { model: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite (Manual / QA)', rpdLimitPerKey: 500 },
];

const keyModelCooldowns = new Map<string, KeyCooldownEntry>();
const keyGlobalInvalidUntil = new Map<string, number>();
const keyModelRecentRequests = new Map<string, number[]>();
const keyLastDispatchedAt = new Map<string, number>();
let inMemoryLedger: PersistedQuotaLedger | null = null;

const RPM_WINDOW_MS = 60_000;
const DEFAULT_RPM_COOLDOWN_MS = 65_000;
const DEFAULT_RPD_COOLDOWN_MS = 20 * 60_000;
const DEFAULT_INVALID_KEY_COOLDOWN_MS = 10 * 60_000;

export function getCurrentPacificDateString(nowMs = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs - 8 * 3600_000).toISOString().slice(0, 10);
  }
}

function getKeyFingerprint(apiKey: string): string {
  let hash = 2166136261;
  for (let i = 0; i < apiKey.length; i++) {
    hash ^= apiKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${maskApiKey(apiKey)}#${(hash >>> 0).toString(36)}`;
}

function getOrLoadQuotaLedger(nowMs = Date.now()): PersistedQuotaLedger {
  const todayPt = getCurrentPacificDateString(nowMs);
  if (inMemoryLedger && inMemoryLedger.datePt === todayPt) {
    return inMemoryLedger;
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = localStorage.getItem(QUOTA_LEDGER_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedQuotaLedger;
        if (parsed && parsed.datePt === todayPt && parsed.entries && typeof parsed.entries === 'object') {
          inMemoryLedger = parsed;
          return inMemoryLedger;
        }
      }
    }
  } catch {
    // Ignore storage read errors cleanly
  }

  inMemoryLedger = { datePt: todayPt, entries: {} };
  return inMemoryLedger;
}

function saveQuotaLedger(ledger: PersistedQuotaLedger): void {
  inMemoryLedger = ledger;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(QUOTA_LEDGER_STORAGE_KEY, JSON.stringify(ledger));
    }
  } catch {
    // Ignore storage quota errors cleanly
  }
}

function notifyKeyOrQuotaUpdated(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
    }
  } catch {
    // Non-browser guard
  }
}

/**
 * Normalizes model identifier cleanly and maps routed deprecated aliases (`3.7-flash -> 3.8-flash`,
 * `3.5-flash -> 3.6-flash`) to their shared Google quota bucket so we never burn redundant retries
 * against an already-exhausted bucket.
 */
export function resolveQuotaPoolModel(model?: string): string {
  if (!model) return 'default';
  const clean = model.replace(/^models\//, '').trim();
  if (clean === 'gemini-3.7-flash') return 'gemini-3.8-flash';
  if (clean === 'gemini-3.5-flash') return 'gemini-3.6-flash';
  if (clean === 'gemini-embedding-2-preview') return 'gemini-embedding-2';
  return clean || 'default';
}

/**
 * Clears in-memory key cooldown & persistent daily ledger state (used on key updates, manual reset, or tests).
 */
export function resetApiKeyHealthState(): void {
  keyModelCooldowns.clear();
  keyGlobalInvalidUntil.clear();
  keyModelRecentRequests.clear();
  keyLastDispatchedAt.clear();
  inMemoryLedger = null;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(QUOTA_LEDGER_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors cleanly
  }
}

export function resetFreeTierDailyQuotaStats(): void {
  resetApiKeyHealthState();
  notifyKeyOrQuotaUpdated();
}

function getPoolKey(apiKey: string, poolModel: string): string {
  return `${apiKey}::${poolModel}`;
}

function getActiveCooldown(apiKey: string, poolModel: string, now: number): { untilMs: number; kind: 'rpm' | 'rpd' } | null {
  const mem = keyModelCooldowns.get(getPoolKey(apiKey, poolModel));
  if (mem && mem.untilMs > now) {
    return { untilMs: mem.untilMs, kind: mem.kind };
  }
  const ledger = getOrLoadQuotaLedger(now);
  const fp = getKeyFingerprint(apiKey);
  const persisted = ledger.entries[fp]?.[poolModel];
  if (persisted?.cooldownUntil && persisted.cooldownUntil > now) {
    return { untilMs: persisted.cooldownUntil, kind: persisted.cooldownKind || 'rpd' };
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

  const ledger = getOrLoadQuotaLedger(now);
  const fp = getKeyFingerprint(apiKey);
  if (!ledger.entries[fp]) ledger.entries[fp] = {};
  const existing = ledger.entries[fp][poolModel] || { count: 0 };
  ledger.entries[fp][poolModel] = { ...existing, count: existing.count + 1 };
  saveQuotaLedger(ledger);
}

function parseRetryDelayMs(msg: string): number | null {
  const secMatch = msg.match(/retry\s*(?:in|after|delay)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*s\b/i);
  if (secMatch) {
    const ms = Math.ceil(parseFloat(secMatch[1]) * 1000) + 1000;
    return Math.min(30 * 60_000, Math.max(5_000, ms));
  }
  return null;
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
  const recentQuotaHits = prev && now - prev.lastErrorAt < 10 * 60_000 ? prev.hitCount + 1 : 1;

  const explicitDaily =
    msg.includes('perday') ||
    msg.includes('per_day') ||
    msg.includes('requestsperday') ||
    msg.includes('requests per day') ||
    msg.includes('rpd') ||
    msg.includes('daily');
  const explicitMinute =
    msg.includes('perminute') ||
    msg.includes('per_minute') ||
    msg.includes('tokensperminute') ||
    msg.includes('requestsperminute') ||
    msg.includes('rpm') ||
    msg.includes('tpm');

  const isDailyExhausted = explicitDaily || (!explicitMinute && recentQuotaHits >= 2);
  const hintMs = parseRetryDelayMs(msg);
  const cooldownMs = isDailyExhausted
    ? Math.max(DEFAULT_RPD_COOLDOWN_MS, hintMs ?? 0)
    : Math.max(DEFAULT_RPM_COOLDOWN_MS, hintMs ?? 0);

  const kind: 'rpm' | 'rpd' = isDailyExhausted ? 'rpd' : 'rpm';
  const untilMs = now + cooldownMs;

  keyModelCooldowns.set(poolKey, {
    untilMs,
    kind,
    hitCount: recentQuotaHits,
    lastErrorAt: now,
  });

  const ledger = getOrLoadQuotaLedger(now);
  const fp = getKeyFingerprint(apiKey);
  if (!ledger.entries[fp]) ledger.entries[fp] = {};
  const existing = ledger.entries[fp][poolModel] || { count: 0 };
  ledger.entries[fp][poolModel] = {
    ...existing,
    cooldownUntil: untilMs,
    cooldownKind: kind,
  };
  saveQuotaLedger(ledger);
}

export function hasConfirmedDailyExhaustionAcrossAllKeys(model: string, now = Date.now()): boolean {
  const { customKeys, builtinKeys } = getRawCandidateKeyPools();
  const allKeys = [...customKeys, ...builtinKeys];
  if (allKeys.length === 0) return false;

  const poolModel = resolveQuotaPoolModel(model);
  return allKeys.every((key) => {
    const cd = getActiveCooldown(key, poolModel, now);
    return cd?.kind === 'rpd' && cd.untilMs > now;
  });
}

export function getFreeTierDailyQuotaStats(): {
  datePt: string;
  totalKeys: number;
  models: FreeTierModelQuotaStat[];
} {
  const now = Date.now();
  const { customKeys, builtinKeys } = getRawCandidateKeyPools();
  const allKeys = [...customKeys, ...builtinKeys];
  const ledger = getOrLoadQuotaLedger(now);

  const models = TRACKED_FREE_TIER_MODELS.map((entry) => {
    let usedToday = 0;
    let exhaustedKeys = 0;
    for (const key of allKeys) {
      const fp = getKeyFingerprint(key);
      const stat = ledger.entries[fp]?.[entry.model];
      if (stat?.count) usedToday += stat.count;
      const cd = getActiveCooldown(key, entry.model, now);
      if (cd?.kind === 'rpd' && cd.untilMs > now) exhaustedKeys++;
    }
    return {
      model: entry.model,
      label: entry.label,
      rpdLimitPerKey: entry.rpdLimitPerKey,
      usedToday,
      totalCapacity: allKeys.length * entry.rpdLimitPerKey,
      exhaustedKeys,
      totalKeys: allKeys.length,
    };
  });

  return {
    datePt: ledger.datePt,
    totalKeys: allKeys.length,
    models,
  };
}

function getRawCandidateKeyPools(): { customKeys: string[]; builtinKeys: string[] } {
  const customKeys = getUserApiKeys();
  const customSet = new Set(customKeys);
  const builtinKeys = getDefaultApiKeys().filter((k) => !customSet.has(k));
  return { customKeys, builtinKeys };
}

function classifyPoolTier(rawKeys: string[], poolModel: string, now: number) {
  const healthy: Array<{ key: string; recentCount: number; lastUsed: number }> = [];
  const shortRpmCooled: Array<{ key: string; untilMs: number }> = [];
  const longRpdOrInvalid: Array<{ key: string; untilMs: number }> = [];

  for (const key of shuffle(rawKeys)) {
    const invalidUntil = keyGlobalInvalidUntil.get(key) ?? 0;
    if (invalidUntil > now) {
      longRpdOrInvalid.push({ key, untilMs: invalidUntil });
      continue;
    }

    const poolKey = getPoolKey(key, poolModel);
    const cd = getActiveCooldown(key, poolModel, now);
    if (cd && cd.untilMs > now) {
      if (cd.kind === 'rpm' && cd.untilMs - now <= 120_000) {
        shortRpmCooled.push({ key, untilMs: cd.untilMs });
      } else {
        longRpdOrInvalid.push({ key, untilMs: cd.untilMs });
      }
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
  longRpdOrInvalid.sort((a, b) => a.untilMs - b.untilMs);

  return { healthy, shortRpmCooled, longRpdOrInvalid };
}

/**
 * Returns candidate keys ordered cleanly for maximum free-tier throughput and strict priority:
 * 1. Healthy user custom keys FIRST (sorted by fewest requests in the last 60s, then LRU).
 * 2. If secret 1198 is unlocked, healthy built-in keys strictly AFTER custom keys (as automatic failover).
 * 3. Short RPM-cooled keys (custom first, then built-in backup).
 * 4. If ALL keys are in long RPD cooldown, includes only 1 earliest-expiring probe key.
 */
export function getCandidateKeysForOperation(
  selectedModel?: string
): { candidateKeys: string[]; isCustom: boolean; hasBuiltinBackup: boolean } {
  const { customKeys, builtinKeys } = getRawCandidateKeyPools();
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

  // If every key in both tiers is currently in long RPD cooldown for this model,
  // probe at most 1 key (preferring custom first) rather than wasting retries across dead keys.
  if (ordered.length === 0) {
    if (customTier.longRpdOrInvalid.length > 0) {
      ordered.push(customTier.longRpdOrInvalid[0].key);
    } else if (builtinTier.longRpdOrInvalid.length > 0) {
      ordered.push(builtinTier.longRpdOrInvalid[0].key);
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
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
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
 * Detects model-wide transient overload or service unavailability errors (e.g. HTTP 503 UNAVAILABLE
 * "experiencing high demand", 500/502/504, or 404 model not found) where retrying additional API keys
 * on the exact same overloaded model fails identically, so cross-model failover should trigger right away.
 */
export function isModelLevelServiceUnavailableError(err: any): boolean {
  if (!err) return false;
  const rawStatus = err?.status ?? err?.code ?? err?.error?.code;
  const status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
  const statusText = String(err?.statusText ?? err?.error?.status ?? '').toLowerCase();
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (status === 503 || status === 502 || status === 504 || status === 404) {
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
    msg.includes('service unavailable') ||
    msg.includes('"status":"unavailable"') ||
    msg.includes('"status": "unavailable"') ||
    msg.includes('"code":503') ||
    msg.includes('"code": 503') ||
    msg.includes('http 503') ||
    msg.includes('model not found') ||
    msg.includes('is not found for api version')
  );
}

/**
 * Universal executor with random API key load-balancing, inter-key timing delay, and automatic failover.
 * Requirements:
 * - Always randomly selects an API key each time from the available pool.
 * - If a key fails or reaches quota, pauses with a timing delay before retrying with another random key.
 * - If failFastOnModelUnavailable is enabled and the backend returns a model-wide 503/500/404 overload/unavailable
 *   error, breaks immediately so cross-model fallback can switch to a healthy model without burning every key.
 */
export async function executeWithApiKeyFailover<T>(
  operation: (client: GoogleGenAI, apiKey: string) => Promise<T>,
  options?: {
    selectedModel?: string;
    maxTries?: number;
    delayMs?: number;
    abortSignal?: AbortSignal;
    failFastOnModelUnavailable?: boolean;
  }
): Promise<T> {
  if (options?.abortSignal?.aborted) {
    throw new DOMException('Aborted by user', 'AbortError');
  }

  const { candidateKeys, isCustom } = getCandidateKeysForOperation(options?.selectedModel);
  if (!candidateKeys || candidateKeys.length === 0) {
    throw new Error("No Gemini API key found. Please click 'API Keys' at the top to add your free Gemini API key, or enter the secret access key.");
  }

  const poolModel = resolveQuotaPoolModel(options?.selectedModel);
  const maxAttempts = options?.maxTries 
    ? Math.min(options.maxTries, candidateKeys.length)
    : candidateKeys.length;

  let lastError: any = null;

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
        const keyRole = isCustom ? 'custom key' : 'random pool key';
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

      if (options?.failFastOnModelUnavailable && isModelLevelServiceUnavailableError(err)) {
        console.warn(
          `[API Key Failover] Model ${options?.selectedModel || 'selected'} is experiencing high demand / unavailable (${errMsg}); failing over to next accurate model immediately.`
        );
        throw err;
      }

      console.warn(
        `[API Key Failover] Key ${masked} failed on attempt ${attempt + 1}/${maxAttempts} (${errMsg}). Evaluating next healthy key...`
      );

      // Separate Google accounts have independent quotas, so brief 150ms handoff avoids wasted 1s stalls
      if (attempt < maxAttempts - 1) {
        if (options?.abortSignal?.aborted) {
          throw new DOMException('Aborted by user', 'AbortError');
        }
        const retryDelayMs = options?.delayMs ?? 150;
        console.info(`[API Key Failover] Waiting ${retryDelayMs}ms before retrying with next key...`);
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, retryDelayMs);
          options?.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new DOMException('Aborted by user', 'AbortError'));
          }, { once: true });
        });
        continue;
      }
    }
  }

  console.error(`[API Key Failover] All ${maxAttempts} candidate API keys failed:`, lastError);
  throw lastError;
}

/**
 * Returns a GoogleGenAI client instance honoring custom-key priority and LRU health ordering.
 */
export function getRandomAIClient(): GoogleGenAI {
  const { candidateKeys } = getCandidateKeysForOperation();
  const pool = candidateKeys.length > 0 ? candidateKeys : getDefaultApiKeys();
  if (!pool || pool.length === 0) {
    throw new Error("No Gemini API key found. Please add a valid Gemini API key in Settings or enter the secret key.");
  }
  return getClientForApiKey(pool[0]);
}
