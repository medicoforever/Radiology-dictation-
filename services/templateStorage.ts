// IndexedDB service for storing custom report templates permanently in the browser
export interface UserTemplate {
  id: string;
  name: string;
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  createdAt: number;
}

const DB_NAME = 'RadiologyDictationTemplatesDB';
const STORE_TEMPLATES = 'user_templates';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDB(): Promise<IDBDatabase | null> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      resolve(null);
      return;
    }

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_TEMPLATES)) {
          db.createObjectStore(STORE_TEMPLATES, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          try { db.close(); } catch {}
          dbPromise = null;
        };
        db.onerror = () => {
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = (e) => {
        console.error('Failed to open templates database:', e);
        dbPromise = null;
        resolve(null);
      };

      request.onblocked = () => {
        console.warn('Templates database open blocked');
        dbPromise = null;
        resolve(null);
      };
    } catch (err) {
      console.error('Error opening templates database:', err);
      dbPromise = null;
      resolve(null);
    }
  });

  return dbPromise;
}

/**
 * Save a custom template permanently
 */
export async function saveUserTemplate(template: Omit<UserTemplate, 'createdAt'>): Promise<void> {
  try {
    const db = await getDB();
    if (!db) {
      throw new Error('Database not available');
    }

    const fullTemplate: UserTemplate = {
      ...template,
      createdAt: Date.now(),
    };

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_TEMPLATES, 'readwrite');
      const store = tx.objectStore(STORE_TEMPLATES);
      const req = store.put(fullTemplate);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to save template'));
    });
  } catch (err) {
    console.error('saveUserTemplate error:', err);
    throw err;
  }
}

/**
 * Retrieve all custom templates
 */
export async function getUserTemplates(): Promise<UserTemplate[]> {
  try {
    const db = await getDB();
    if (!db) return [];

    return new Promise<UserTemplate[]>((resolve, reject) => {
      const tx = db.transaction(STORE_TEMPLATES, 'readonly');
      const store = tx.objectStore(STORE_TEMPLATES);
      const req = store.getAll();

      req.onsuccess = () => {
        const results = req.result as UserTemplate[];
        // Sort by name or createdAt
        results.sort((a, b) => b.createdAt - a.createdAt);
        resolve(results);
      };
      req.onerror = () => reject(req.error || new Error('Failed to fetch templates'));
    });
  } catch (err) {
    console.error('getUserTemplates error:', err);
    return [];
  }
}

/**
 * Delete a custom template
 */
export async function deleteUserTemplate(id: string): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_TEMPLATES, 'readwrite');
      const store = tx.objectStore(STORE_TEMPLATES);
      const req = store.delete(id);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to delete template'));
    });
  } catch (err) {
    console.error('deleteUserTemplate error:', err);
    throw err;
  }
}
