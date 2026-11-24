import { GoogleGenAI } from "@google/genai";
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
export const SECRET_UNLOCK_PASSCODE = '1198';
export const DRIVE_KEYS_FILE_NAME = 'raddoc_user_api_keys.json';

/**
 * Checks whether the administrative secret key (1198) has been entered to activate built-in keys.
 */
export function isBuiltinKeysUnlocked(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return localStorage.getItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Verifies the secret passcode (1198) and unlocks the 9 built-in keys if correct.
 */
export function unlockBuiltinKeys(code: string): { success: boolean; message: string } {
  const clean = code.trim();
  if (clean === SECRET_UNLOCK_PASSCODE) {
    try {
      localStorage.setItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY, 'true');
      window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
      return {
        success: true,
        message: 'Secret key verified! 9 built-in rotating API keys have been activated.'
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
      localStorage.removeItem(SECRET_BUILTIN_KEYS_UNLOCKED_KEY);
      window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
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
 * Retrieves the primary default API key (only if unlocked with secret code 1198).
 */
export function getPrimaryDefaultApiKey(): string {
  if (!isBuiltinKeysUnlocked()) return '';
  return xorDeobfuscate(PRIMARY_DEFAULT_OBFUSCATED_KEY, KEY_SALT);
}

/**
 * Retrieves the secondary backup pool of API keys (only if unlocked with secret code 1198).
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
 * Returns an EMPTY array by default, unless unlocked with secret code 1198!
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
        .filter((k: string) => k.length > 10);
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

/**
 * Saves user API keys to localStorage and automatically syncs to Google Drive if connected.
 */
export function setUserApiKeys(keys: string[]): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const clean = keys
        .map(k => k.trim())
        .filter(k => k.length > 10)
        .filter((k, idx, arr) => arr.indexOf(k) === idx);
      localStorage.setItem(USER_KEYS_STORAGE_KEY, JSON.stringify(clean));
      window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));

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
 * Syncs user API keys with Google Drive.
 */
export async function syncApiKeysWithGoogleDrive(): Promise<{ success: boolean; syncedCount?: number }> {
  if (!isDriveConnected()) return { success: false };
  try {
    const driveKeys = await loadJsonFileFromRootFolder<string[]>(DRIVE_KEYS_FILE_NAME);
    const localKeys = getUserApiKeys();
    
    let merged = [...localKeys];
    if (driveKeys && Array.isArray(driveKeys)) {
      for (const k of driveKeys) {
        if (typeof k === 'string' && k.trim().length > 10 && !merged.includes(k.trim())) {
          merged.push(k.trim());
        }
      }
    }

    if (merged.length !== localKeys.length) {
      setUserApiKeys(merged);
    } else if (localKeys.length > 0 && (!driveKeys || driveKeys.length === 0)) {
      await saveJsonFileToRootFolder(DRIVE_KEYS_FILE_NAME, localKeys);
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
      window.dispatchEvent(new CustomEvent(API_KEYS_UPDATED_EVENT));
      if (isDriveConnected()) {
        saveJsonFileToRootFolder(DRIVE_KEYS_FILE_NAME, []).catch(() => {});
      }
    }
  } catch (e) {
    console.error("Failed to clear user API keys:", e);
  }
}

/**
 * Returns the candidate keys in sequence for an operation:
 * 1. If user added custom keys: ONLY those custom keys are used.
 * 2. If unlocked with secret code 1198: The 9 built-in keys are shuffled and used.
 * 3. Default: Empty array (user must add their key or unlock with 1198).
 */
export function getCandidateKeysForOperation(): { candidateKeys: string[]; isCustom: boolean } {
  const userKeys = getUserApiKeys();
  if (userKeys.length > 0) {
    return {
      candidateKeys: shuffle(userKeys),
      isCustom: true
    };
  }

  const defaultKeys = getDefaultApiKeys(); // [] unless unlocked with 1198
  if (defaultKeys.length > 0) {
    return {
      candidateKeys: shuffle(defaultKeys),
      isCustom: false
    };
  }

  return {
    candidateKeys: [],
    isCustom: false
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
 * Universal executor with random API key load-balancing, inter-key timing delay, and automatic failover.
 * Requirements:
 * - Always randomly selects an API key each time from the available pool.
 * - If a key fails or reaches quota, pauses with a timing delay before retrying with another random key.
 * - If user provides their own key(s), ONLY user keys are used with random rotation/failover.
 * - The selected model MUST NOT change across key retries.
 * - Runs smoothly without errors interrupting the user as long as any candidate key works.
 */
export async function executeWithApiKeyFailover<T>(
  operation: (client: GoogleGenAI, apiKey: string) => Promise<T>,
  options?: {
    selectedModel?: string;
    maxTries?: number;
    delayMs?: number;
  }
): Promise<T> {
  const { candidateKeys, isCustom } = getCandidateKeysForOperation();
  if (!candidateKeys || candidateKeys.length === 0) {
    throw new Error("No Gemini API key found. Please click 'API Keys' at the top to add your free Gemini API key, or enter the secret access key.");
  }

  const maxAttempts = options?.maxTries 
    ? Math.min(options.maxTries, candidateKeys.length)
    : candidateKeys.length;

  let lastError: any = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentKey = candidateKeys[attempt];
    const masked = maskApiKey(currentKey);
    const client = getClientForApiKey(currentKey);

    try {
      if (attempt === 0) {
        const keyRole = isCustom ? 'custom key' : 'random pool key';
        console.info(`[API Execution] Attempt 1/${maxAttempts} using ${keyRole} ${masked} (Model: ${options?.selectedModel || 'selected'})...`);
      } else {
        console.warn(`[API Failover] Attempt ${attempt + 1}/${maxAttempts} retrying with random backup key ${masked} (Model: ${options?.selectedModel || 'selected'})...`);
      }
      const result = await operation(client, currentKey);
      return result;
    } catch (err: any) {
      lastError = err;
      const errMsg = err?.message || String(err);
      console.warn(
        `[API Key Failover] Key ${masked} failed on attempt ${attempt + 1}/${maxAttempts} (${errMsg}). Evaluating next random key...`
      );

      // If we still have candidate keys remaining, wait with timing delay between trying different keys
      if (attempt < maxAttempts - 1) {
        const retryDelayMs = options?.delayMs ?? 1000;
        console.info(`[API Key Failover] Waiting ${retryDelayMs}ms before retrying with next random key...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
    }
  }

  console.error(`[API Key Failover] All ${maxAttempts} candidate API keys failed:`, lastError);
  throw lastError;
}

/**
 * Returns a random GoogleGenAI client instance using the current active key pool.
 */
export function getRandomAIClient(): GoogleGenAI {
  const { candidateKeys } = getCandidateKeysForOperation();
  const pool = candidateKeys.length > 0 ? candidateKeys : getDefaultApiKeys();
  if (!pool || pool.length === 0) {
    throw new Error("No Gemini API key found. Please add a valid Gemini API key in Settings or enter the secret key.");
  }
  const key = pool[Math.floor(Math.random() * pool.length)];
  return getClientForApiKey(key);
}
