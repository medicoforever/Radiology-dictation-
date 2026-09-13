/**
 * Local IndexedDB Rolling Audio Cache for Live Dictation (Feature F)
 * Provides crash protection and network resilience by persisting PCM audio chunks locally.
 */

const DB_NAME = 'RadiologyLiveAudioCacheDB';
const DB_VERSION = 1;
const STORE_CHUNKS = 'session_audio_chunks';
const STORE_META = 'session_audio_meta';

interface AudioChunkRecord {
  sessionId: string;
  chunkIndex: number;
  data: ArrayBuffer;
  timestamp: number;
}

interface AudioMetaRecord {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  totalChunks: number;
}

let dbInstance: IDBDatabase | null = null;

async function getDB(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB is not supported in this environment'));
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CHUNKS, { keyPath: ['sessionId', 'chunkIndex'] });
        chunkStore.createIndex('sessionId', 'sessionId', { unique: false });
        chunkStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'sessionId' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.warn('Failed to open IndexedDB for live audio cache:', event);
      reject((event.target as IDBOpenDBRequest).error);
    };
  });
}

/**
 * Initializes a new audio caching session and cleans up old expired sessions.
 */
export async function initLiveAudioSessionCache(sessionId: string): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_META], 'readwrite');
    const store = tx.objectStore(STORE_META);
    const meta: AudioMetaRecord = {
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalChunks: 0,
    };
    store.put(meta);

    // Clean up older sessions in background (> 24 hours)
    purgeExpiredAudioCaches().catch(() => {});
  } catch (err) {
    console.warn('Audio cache init notice (continuing without persistent cache):', err);
  }
}

/**
 * Stores a PCM Int16 audio chunk into IndexedDB
 */
export async function cacheAudioChunk(
  sessionId: string,
  chunkIndex: number,
  pcmData: Int16Array
): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_CHUNKS, STORE_META], 'readwrite');
    const chunkStore = tx.objectStore(STORE_CHUNKS);
    const metaStore = tx.objectStore(STORE_META);

    // Make a copy of the buffer to store safely
    const bufferCopy = pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength);

    const record: AudioChunkRecord = {
      sessionId,
      chunkIndex,
      data: bufferCopy,
      timestamp: Date.now(),
    };
    chunkStore.put(record);

    const metaReq = metaStore.get(sessionId);
    metaReq.onsuccess = () => {
      const meta = metaReq.result as AudioMetaRecord | undefined;
      if (meta) {
        meta.updatedAt = Date.now();
        meta.totalChunks = Math.max(meta.totalChunks, chunkIndex + 1);
        metaStore.put(meta);
      }
    };
  } catch (err) {
    // Non-blocking: fail gracefully without disrupting audio recording
    console.debug('Failed to cache audio chunk:', err);
  }
}

/**
 * Clears the cache for a completed session
 */
export async function clearSessionAudioCache(sessionId: string): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_CHUNKS, STORE_META], 'readwrite');
    const chunkStore = tx.objectStore(STORE_CHUNKS);
    const metaStore = tx.objectStore(STORE_META);

    const index = chunkStore.index('sessionId');
    const range = IDBKeyRange.only(sessionId);
    const request = index.openCursor(range);

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    metaStore.delete(sessionId);
  } catch (err) {
    console.warn('Failed to clear session audio cache:', err);
  }
}

/**
 * Automatically purges audio cache sessions older than 24 hours
 */
export async function purgeExpiredAudioCaches(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_META, STORE_CHUNKS], 'readwrite');
    const metaStore = tx.objectStore(STORE_META);
    const chunkStore = tx.objectStore(STORE_CHUNKS);

    const now = Date.now();
    const cursorReq = metaStore.openCursor();

    cursorReq.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;
      if (cursor) {
        const meta = cursor.value as AudioMetaRecord;
        if (now - meta.createdAt > maxAgeMs) {
          const expiredSessionId = meta.sessionId;
          cursor.delete();

          // Delete all associated chunks
          const chunkIndex = chunkStore.index('sessionId');
          const chunkReq = chunkIndex.openCursor(IDBKeyRange.only(expiredSessionId));
          chunkReq.onsuccess = (chunkEvent) => {
            const chunkCursor = (chunkEvent.target as IDBRequest).result as IDBCursorWithValue | null;
            if (chunkCursor) {
              chunkCursor.delete();
              chunkCursor.continue();
            }
          };
        }
        cursor.continue();
      }
    };
  } catch (err) {
    console.debug('Cache purge notice:', err);
  }
}

/**
 * Retrieves any incomplete/unfinalized live audio sessions from IndexedDB
 */
export async function getIncompleteLiveAudioSessions(): Promise<AudioMetaRecord[]> {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_META], 'readonly');
    const store = tx.objectStore(STORE_META);
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const results = ((req.result as AudioMetaRecord[]) || []).filter(r => r.totalChunks > 0);
        resolve(results);
      };
      req.onerror = () => resolve([]);
    });
  } catch (err) {
    console.debug('Failed to get incomplete live sessions:', err);
    return [];
  }
}

/**
 * Reconstructs the complete WAV audio blob from cached PCM chunks of a live session
 */
export async function recoverLiveSessionAudioAsBlob(sessionId: string): Promise<Blob | null> {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_CHUNKS], 'readonly');
    const chunkStore = tx.objectStore(STORE_CHUNKS);
    const index = chunkStore.index('sessionId');

    return new Promise((resolve) => {
      const req = index.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => {
        const records = ((req.result as AudioChunkRecord[]) || []).sort((a, b) => a.chunkIndex - b.chunkIndex);
        if (records.length === 0) {
          resolve(null);
          return;
        }

        const pcmChunks = records.map(r => new Int16Array(r.data));
        let totalSamples = 0;
        for (const c of pcmChunks) totalSamples += c.length;

        if (totalSamples === 0) {
          resolve(null);
          return;
        }

        const buffer = new ArrayBuffer(44 + totalSamples * 2);
        const view = new DataView(buffer);

        const writeString = (offset: number, str: string) => {
          for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
          }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + totalSamples * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // Mono
        view.setUint32(24, 16000, true); // 16kHz
        view.setUint32(28, 16000 * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, totalSamples * 2, true);

        let offset = 44;
        for (const chunk of pcmChunks) {
          for (let i = 0; i < chunk.length; i++, offset += 2) {
            view.setInt16(offset, chunk[i], true);
          }
        }

        resolve(new Blob([buffer], { type: 'audio/wav' }));
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.error('Failed to recover live session audio:', err);
    return null;
  }
}

