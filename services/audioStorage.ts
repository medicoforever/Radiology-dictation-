// IndexedDB Storage Service for Audio Persistence and Recovery

const DB_NAME = 'RadiologyDictationAudioDB';
const STORE_CHUNKS = 'active_chunks';
const STORE_COMPLETED = 'completed_recordings';
const STORE_BLOBS = 'audio_blobs';

export interface UnsavedSession {
  timestamp: number;
  mimeType: string;
  chunks: Blob[];
  totalBytes: number;
}

export interface SavedRecording {
  id: string;
  timestamp: number;
  mimeType: string;
  blob: Blob;
  size: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDB(): Promise<IDBDatabase | null> {
  if (dbPromise) {
    return dbPromise;
  }

  const currentPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      resolve(null);
      return;
    }

    try {
      const request = indexedDB.open(DB_NAME);

      request.onblocked = () => {
        console.debug('IndexedDB database open blocked');
        dbPromise = null;
        resolve(null);
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          db.createObjectStore(STORE_CHUNKS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_COMPLETED)) {
          db.createObjectStore(STORE_COMPLETED, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        const storesNeeded = [STORE_CHUNKS, STORE_COMPLETED, STORE_BLOBS];
        const missingStores = storesNeeded.filter(s => !db.objectStoreNames.contains(s));

        if (missingStores.length === 0) {
          db.onversionchange = () => {
            try { db.close(); } catch {}
            dbPromise = null;
          };
          db.onerror = () => {
            dbPromise = null;
          };
          resolve(db);
        } else {
          const currentVersion = db.version;
          db.close();
          const upgradeReq = indexedDB.open(DB_NAME, currentVersion + 1);
          upgradeReq.onupgradeneeded = () => {
            const uDb = upgradeReq.result;
            for (const s of storesNeeded) {
              if (!uDb.objectStoreNames.contains(s)) {
                if (s === STORE_BLOBS) {
                  uDb.createObjectStore(s, { keyPath: 'key' });
                } else {
                  uDb.createObjectStore(s, { keyPath: 'id' });
                }
              }
            }
          };
          upgradeReq.onsuccess = () => {
            const uDb = upgradeReq.result;
            uDb.onversionchange = () => {
              try { uDb.close(); } catch {}
              dbPromise = null;
            };
            uDb.onerror = () => {
              dbPromise = null;
            };
            resolve(uDb);
          };
          upgradeReq.onerror = () => {
            dbPromise = null;
            resolve(null);
          };
        }
      };

      request.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch (e) {
      dbPromise = null;
      resolve(null);
    }
  });

  dbPromise = currentPromise.then((db) => {
    if (!db) {
      dbPromise = null; // Reset so subsequent calls can retry
    }
    return db;
  });

  return dbPromise;
}

/**
 * Saves an audio blob by key into IndexedDB
 */
export async function saveAudioBlob(key: string, blob: Blob): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    const store = tx.objectStore(STORE_BLOBS);
    store.put({ key, blob, mimeType: blob.type || 'audio/webm', timestamp: Date.now() });
  } catch (err) {
    console.debug(`Failed to save audio blob [${key}]:`, err);
  }
}

/**
 * Retrieves an audio blob by key from IndexedDB
 */
export async function getAudioBlob(key: string): Promise<Blob | null> {
  try {
    const db = await getDB();
    if (!db) return null;
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const store = tx.objectStore(STORE_BLOBS);
    return new Promise((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result && req.result.blob) {
          resolve(req.result.blob as Blob);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.debug(`Failed to get audio blob [${key}]:`, err);
    return null;
  }
}

/**
 * Deletes an audio blob by key from IndexedDB
 */
export async function deleteAudioBlob(key: string): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    const store = tx.objectStore(STORE_BLOBS);
    store.delete(key);
  } catch (err) {
    console.debug(`Failed to delete audio blob [${key}]:`, err);
  }
}

/**
 * Cleans up any keys in STORE_BLOBS that are no longer valid
 */
export async function clearUnusedAudioBlobs(validKeys: string[]): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    const store = tx.objectStore(STORE_BLOBS);
    const validSet = new Set(validKeys);
    
    const req = store.getAllKeys();
    req.onsuccess = () => {
      const keys = req.result as string[];
      for (const k of keys) {
        if (k.startsWith('batch_audio_') && !validSet.has(k)) {
          store.delete(k);
        }
      }
    };
  } catch (err) {
    console.debug('Failed to clear unused audio blobs:', err);
  }
}

/**
 * Saves active recording session chunks into IndexedDB
 */
export async function saveActiveSession(chunks: Blob[], mimeType: string, timestamp?: number): Promise<void> {
  if (!chunks || chunks.length === 0) return;
  try {
    const db = await getDB();
    if (!db) return;

    const combinedBlob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    const record = {
      id: 'current_session',
      timestamp: timestamp || Date.now(),
      mimeType: mimeType || combinedBlob.type || 'audio/webm',
      chunks: [combinedBlob],
      totalBytes: combinedBlob.size,
    };

    const tx = db.transaction(STORE_CHUNKS, 'readwrite');
    const store = tx.objectStore(STORE_CHUNKS);
    store.put(record);

    try {
      localStorage.setItem('has_unsaved_session', JSON.stringify({
        timestamp: record.timestamp,
        totalBytes: record.totalBytes,
        mimeType: record.mimeType,
      }));
    } catch {}
  } catch (err) {
    console.debug('Failed to save active session:', err);
  }
}

/**
 * Checks for any unsaved active session chunks from an interrupted or crashed recording.
 */
export async function getUnsavedActiveSession(): Promise<UnsavedSession | null> {
  try {
    const db = await getDB();
    if (!db) return null;

    const tx = db.transaction(STORE_CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_CHUNKS);

    return new Promise((resolve) => {
      const req = store.get('current_session');
      req.onsuccess = () => {
        const data = req.result;
        if (data) {
          let chunks: Blob[] = [];
          if (Array.isArray(data.chunks) && data.chunks.length > 0) {
            chunks = data.chunks;
          } else if (data.blob instanceof Blob) {
            chunks = [data.blob];
          }
          if (chunks.length > 0) {
            resolve({
              timestamp: data.timestamp || Date.now(),
              mimeType: data.mimeType || 'audio/webm',
              chunks: chunks,
              totalBytes: data.totalBytes || chunks.reduce((acc, c) => acc + c.size, 0),
            });
            return;
          }
        }
        resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.debug('Failed to read unsaved active session from IndexedDB:', err);
    return null;
  }
}

/**
 * Clears the active session from IndexedDB and localStorage.
 */
export async function clearActiveSession(): Promise<void> {
  try {
    try {
      localStorage.removeItem('has_unsaved_session');
    } catch {}

    const db = await getDB();
    if (!db) return;

    const tx = db.transaction(STORE_CHUNKS, 'readwrite');
    const store = tx.objectStore(STORE_CHUNKS);
    store.delete('current_session');
  } catch (err) {
    console.debug('Failed to clear active session from IndexedDB:', err);
  }
}

/**
 * Saves a completed audio recording Blob into IndexedDB.
 */
export async function saveCompletedRecording(blob: Blob, mimeType: string): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;

    const tx = db.transaction(STORE_COMPLETED, 'readwrite');
    const store = tx.objectStore(STORE_COMPLETED);

    const record: SavedRecording = {
      id: 'last_completed',
      timestamp: Date.now(),
      mimeType: mimeType || blob.type || 'audio/webm',
      blob: blob,
      size: blob.size,
    };

    store.put(record);
  } catch (err) {
    console.debug('Failed to save completed recording to IndexedDB:', err);
  }
}

/**
 * Retrieves the last completed audio recording.
 */
export async function getLastCompletedRecording(): Promise<SavedRecording | null> {
  try {
    const db = await getDB();
    if (!db) return null;

    const tx = db.transaction(STORE_COMPLETED, 'readonly');
    const store = tx.objectStore(STORE_COMPLETED);

    return new Promise((resolve) => {
      const req = store.get('last_completed');
      req.onsuccess = () => {
        if (req.result && req.result.blob) {
          resolve(req.result as SavedRecording);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.debug('Failed to get last completed recording:', err);
    return null;
  }
}

/**
 * Clears the last completed recording from IndexedDB.
 */
export async function clearLastCompletedRecording(): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;

    const tx = db.transaction(STORE_COMPLETED, 'readwrite');
    const store = tx.objectStore(STORE_COMPLETED);
    store.delete('last_completed');
  } catch (err) {
    console.debug('Failed to clear last completed recording from IndexedDB:', err);
  }
}

export const DICTATE_CHANGES_AUDIO_KEY = 'dictate_changes_stored_audio';
export const DICTATE_CHANGES_META_KEY = 'dictate_changes_audio_meta';

export interface DictateChangesAudioRecord {
  blob: Blob;
  meta: {
    timestamp: number;
    size: number;
    mimeType: string;
    name?: string;
  } | null;
}

/**
 * Saves the dictate changes audio recording into IndexedDB and stores metadata.
 */
export async function saveDictateChangesAudio(blob: Blob, name?: string): Promise<void> {
  try {
    await saveAudioBlob(DICTATE_CHANGES_AUDIO_KEY, blob);
    const meta = {
      timestamp: Date.now(),
      size: blob.size,
      mimeType: blob.type || 'audio/webm',
      name: name || 'Recorded Voice Changes'
    };
    try {
      localStorage.setItem(DICTATE_CHANGES_META_KEY, JSON.stringify(meta));
    } catch {}
  } catch (err) {
    console.debug('Failed to save dictate changes audio to IndexedDB:', err);
  }
}

/**
 * Retrieves the stored dictate changes audio and its metadata from IndexedDB.
 */
export async function getDictateChangesAudio(): Promise<DictateChangesAudioRecord | null> {
  try {
    const blob = await getAudioBlob(DICTATE_CHANGES_AUDIO_KEY);
    if (!blob || blob.size === 0) return null;

    let meta: { timestamp: number; size: number; mimeType: string; name?: string } | null = null;
    try {
      const raw = localStorage.getItem(DICTATE_CHANGES_META_KEY);
      if (raw) meta = JSON.parse(raw);
    } catch {}

    return {
      blob,
      meta: meta || {
        timestamp: Date.now(),
        size: blob.size,
        mimeType: blob.type || 'audio/webm',
        name: 'Stored Changes Audio'
      }
    };
  } catch (err) {
    console.debug('Failed to retrieve dictate changes audio:', err);
    return null;
  }
}

/**
 * Checks whether a dictate changes audio recording is currently stored in browser.
 */
export function hasStoredDictateChangesAudio(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Boolean(localStorage.getItem(DICTATE_CHANGES_META_KEY));
  } catch {
    return false;
  }
}

/**
 * Deletes the stored dictate changes audio from IndexedDB and clears metadata.
 */
export async function deleteDictateChangesAudio(): Promise<void> {
  try {
    await deleteAudioBlob(DICTATE_CHANGES_AUDIO_KEY);
    try {
      localStorage.removeItem(DICTATE_CHANGES_META_KEY);
    } catch {}
  } catch (err) {
    console.debug('Failed to delete dictate changes audio:', err);
  }
}


