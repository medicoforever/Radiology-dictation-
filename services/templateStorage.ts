// IndexedDB service for storing custom report templates permanently in the browser
import { ALL_RADNITO_TEMPLATES } from './builtInTemplates';

export interface UserTemplate {
  id: string;
  name: string;
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  docxFile?: {
    name: string;
    data?: string; // base64 of docx
    size: number;
    extractedText: string;
    extractedHtml?: string;
  };
  createdAt: number;
  isBuiltIn?: boolean;
  modality?: string;
  category?: string;
  lines?: string[];
}

const DB_NAME = 'RadiologyDictationTemplatesDB';
const STORE_TEMPLATES = 'user_templates';
const DB_VERSION = 1;
const HIDDEN_BUILTINS_KEY = 'rad_hidden_builtin_templates';

function getHiddenBuiltinIds(): Set<string> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return new Set();
    const raw = localStorage.getItem(HIDDEN_BUILTINS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {}
  return new Set();
}

function saveHiddenBuiltinId(id: string) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const current = getHiddenBuiltinIds();
    current.add(id);
    localStorage.setItem(HIDDEN_BUILTINS_KEY, JSON.stringify(Array.from(current)));
  } catch {}
}

export function restoreAllBuiltInTemplates(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(HIDDEN_BUILTINS_KEY);
    }
  } catch {}
}

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
 * Retrieve all custom templates (both user-saved and built-in templates available as custom templates)
 */
export async function getUserTemplates(): Promise<UserTemplate[]> {
  try {
    const db = await getDB();
    let userCreated: UserTemplate[] = [];

    if (db) {
      userCreated = await new Promise<UserTemplate[]>((resolve) => {
        const tx = db.transaction(STORE_TEMPLATES, 'readonly');
        const store = tx.objectStore(STORE_TEMPLATES);
        const req = store.getAll();

        req.onsuccess = () => {
          const results = (req.result as UserTemplate[]) || [];
          results.sort((a, b) => b.createdAt - a.createdAt);
          resolve(results);
        };
        req.onerror = () => {
          console.warn('Failed to fetch user templates from DB:', req.error);
          resolve([]);
        };
      });
    }

    // Convert all 72 templates into UserTemplate format so they are directly available as custom built-ins
    const hiddenSet = getHiddenBuiltinIds();
    const builtInCustoms: UserTemplate[] = ALL_RADNITO_TEMPLATES
      .filter(t => !hiddenSet.has(t.id) && !hiddenSet.has(`builtin_${t.id}`))
      .map(t => {
        let extractedText = '';
        if (t.lines && t.lines.length > 0) {
          extractedText = t.lines.join('\n');
        } else {
          try {
            const parsed = JSON.parse(t.content);
            extractedText = [
              parsed.title,
              parsed.technique,
              ...(parsed.normal_findings || []),
              parsed.default_impression
            ].filter(Boolean).join('\n');
          } catch {
            extractedText = t.content;
          }
        }

        return {
          id: `builtin_${t.id}`,
          name: t.name,
          text: extractedText,
          images: [],
          docxFile: t.docxBase64 ? {
            name: t.fileName || `${t.name}.docx`,
            data: t.docxBase64,
            size: Math.round(t.docxBase64.length * 0.75),
            extractedText: extractedText,
          } : undefined,
          createdAt: 1700000000000,
          isBuiltIn: true,
          modality: t.modality,
          category: t.category,
          lines: t.lines,
        };
      });

    return [...userCreated, ...builtInCustoms];
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
    if (id.startsWith('builtin_') || id.startsWith('tpl_')) {
      saveHiddenBuiltinId(id);
      return;
    }

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
