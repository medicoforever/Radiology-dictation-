/**
 * Safe LocalStorage Service
 *
 * Provides fault-tolerant, quota-managed access to window.localStorage.
 * - Prevents QuotaExceededError from crashing React components.
 * - Auto-purges temporary/cached data when quota is reached.
 * - Safely handles corrupted JSON and private browsing restrictions.
 */

const TEMPORARY_CACHE_KEYS = [
  'in_flight_recording_meta',
  'has_unsaved_session',
  'radiologyDictationBatchDriveFolder',
  'radiologyDictationBatchDriveSyncedHash',
  'last_app_error',
  'dictate_changes_audio_meta',
];


let cachedTabId: string | null = null;

export function getTabId(): string {
  if (cachedTabId) return cachedTabId;
  if (typeof window === 'undefined') return 'tab_ssr';
  try {
    let id = window.sessionStorage?.getItem('raddoc_tab_id');
    if (!id) {
      id = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
      window.sessionStorage?.setItem('raddoc_tab_id', id);
    }
    cachedTabId = id;
    return id;
  } catch (_) {
    cachedTabId = 'tab_' + Date.now();
    return cachedTabId;
  }
}

export interface TabHeartbeat {
  tabId: string;
  status: 'recording' | 'processing' | 'idle';
  timestamp: number;
}

export function markTabActive(status: 'recording' | 'processing' | 'idle'): void {
  try {
    const tabId = getTabId();
    safeLocalStorage.setItem(`tab_heartbeat_${tabId}`, {
      tabId,
      status,
      timestamp: Date.now(),
    });
  } catch (_) {}
}

export function isTabHeartbeatAlive(tabId?: string, maxAgeMs = 25000): boolean {
  if (!tabId) return false;
  try {
    const hb = safeLocalStorage.getItem<TabHeartbeat | null>(`tab_heartbeat_${tabId}`, null);
    if (!hb) return false;
    return Date.now() - hb.timestamp < maxAgeMs && hb.status !== 'idle';
  } catch (_) {
    return false;
  }
}

export function isLocalStorageAvailable(): boolean {
  try {
    const testKey = '__test_storage_availability__';
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
    return true;
  } catch (_) {
    return false;
  }
}

export const safeLocalStorage = {
  /**
   * Safely retrieves and JSON-parses an item from localStorage.
   * Returns defaultValue if missing, malformed, or if storage is inaccessible.
   */
  getItem<T>(key: string, defaultValue: T): T {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return defaultValue;
      }
      const raw = window.localStorage.getItem(key);
      if (raw === null || raw === undefined) {
        return defaultValue;
      }
      return JSON.parse(raw) as T;
    } catch (e) {
      console.warn(`safeLocalStorage: Failed to parse item for key "${key}". Using default value.`, e);
      return defaultValue;
    }
  },

  /**
   * Safely retrieves a raw string from localStorage.
   */
  getRaw(key: string, fallback = ''): string {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return fallback;
      }
      const val = window.localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch (_) {
      return fallback;
    }
  },

  /**
   * Safely writes a JSON-serializable value to localStorage.
   * If a QuotaExceededError is encountered, automatically clears temporary caches and retries.
   * Never throws an uncaught exception.
   */
  setItem(key: string, value: any): boolean {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return false;
      }
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      try {
        window.localStorage.setItem(key, serialized);
        return true;
      } catch (writeErr: any) {
        const isQuotaError = 
          writeErr?.name === 'QuotaExceededError' || 
          writeErr?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
          writeErr?.code === 22 || 
          writeErr?.code === 1014;

        if (isQuotaError) {
          console.warn(`safeLocalStorage: Quota exceeded when writing "${key}". Purging temporary caches...`);
          this.clearTemporaryCaches();
          try {
            window.localStorage.setItem(key, serialized);
            return true;
          } catch (retryErr) {
            console.error(`safeLocalStorage: Storage still full after cleanup. Could not persist "${key}".`, retryErr);
            return false;
          }
        }
        console.error(`safeLocalStorage: Unexpected error writing "${key}":`, writeErr);
        return false;
      }
    } catch (outerErr) {
      console.error(`safeLocalStorage: Serialization error for "${key}":`, outerErr);
      return false;
    }
  },

  /**
   * Safely writes a raw string to localStorage.
   */
  setRaw(key: string, value: string): boolean {
    return this.setItem(key, value);
  },

  /**
   * Safely removes an item from localStorage.
   */
  removeItem(key: string): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(key);
      }
    } catch (e) {
      console.warn(`safeLocalStorage: Failed to remove key "${key}":`, e);
    }
  },

  /**
   * Clears temporary caches to free up space without affecting user API keys or settings.
   */
  clearTemporaryCaches(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      for (const k of TEMPORARY_CACHE_KEYS) {
        try {
          window.localStorage.removeItem(k);
        } catch (_) {}
      }
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && (k.startsWith('has_unsaved_session_') || k.startsWith('in_flight_recording_meta_') || k.startsWith('tab_heartbeat_'))) {
          try {
            window.localStorage.removeItem(k);
          } catch (_) {}
        }
      }
    } catch (_) {}
  },

  /**
   * Validates all stored JSON items in localStorage.
   * Purges any truncated or invalid JSON entries that could crash the application.
   */
  validateAndCleanStorage(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const jsonKeys = [
        'radiologyDictationSingleMode',
        'radiologyDictationBatchMode',
        'radiologyErrorCheckEnabled',
        'user_api_keys',
        'radiology_custom_macros_dictionary',
        'upcoming_report_template',
        'radiologyBatchGlobalImages',
      ];

      for (const k of jsonKeys) {
        try {
          const raw = window.localStorage.getItem(k);
          if (raw) {
            JSON.parse(raw); // test validity
          }
        } catch (e) {
          console.warn(`safeLocalStorage: Removing corrupted key "${k}":`, e);
          window.localStorage.removeItem(k);
        }
      }
    } catch (_) {}
  },

  /**
   * Calculates total localStorage usage in bytes and item counts for diagnostics.
   */
  getStorageUsage(): { usedBytes: number; keyCount: number; keys: { key: string; size: number }[] } {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return { usedBytes: 0, keyCount: 0, keys: [] };
      }
      let usedBytes = 0;
      const keys: { key: string; size: number }[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k) {
          const val = window.localStorage.getItem(k) || '';
          const size = (k.length + val.length) * 2; // ~2 bytes per UTF-16 character
          usedBytes += size;
          keys.push({ key: k, size });
        }
      }
      return { usedBytes, keyCount: keys.length, keys };
    } catch (_) {
      return { usedBytes: 0, keyCount: 0, keys: [] };
    }
  }
};
