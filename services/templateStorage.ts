// IndexedDB service for storing custom report templates permanently in the browser
import { ALL_RADNITO_TEMPLATES } from './builtInTemplates';
import { isDriveConnected, loadJsonFileFromRootFolder, saveJsonFileToRootFolder } from './googleDriveService';

export interface UserTemplate {
  id: string;
  templateId?: string; // e.g. "C1", "C2" or "1", "2"
  templateNumber?: number; // e.g. 1, 2
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
const DRIVE_CUSTOM_TEMPLATES_FILE = 'raddoc_custom_templates.json';

/**
 * Helper to get clean, human-readable Template ID (number or C-number)
 * e.g. "tpl_001" -> "1", "tpl_042" -> "42", "cust_1" / "template_1" -> "C1"
 */
export function getTemplateDisplayId(template: { id?: string; templateId?: string; isBuiltIn?: boolean }): string {
  if (template.templateId) return template.templateId;
  const rawId = template.id || '';
  if (rawId.startsWith('builtin_tpl_') || rawId.startsWith('tpl_')) {
    const num = rawId.replace('builtin_', '').replace('tpl_', '').replace(/^0+/, '');
    return num || '1';
  }
  if (rawId.startsWith('cust_') || rawId.startsWith('template_cust_')) {
    const num = rawId.replace('template_cust_', '').replace('cust_', '').replace(/^0+/, '');
    return `C${num || '1'}`;
  }
  if (rawId.startsWith('template_')) {
    return 'C1';
  }
  return rawId || '1';
}

/**
 * Calculates next available custom template ID and number (e.g. C1, C2, C3)
 */
export function allotNextCustomTemplateId(existingTemplates: UserTemplate[]): { id: string; templateId: string; templateNumber: number } {
  const customOnly = existingTemplates.filter(t => !t.isBuiltIn && !t.id.startsWith('builtin_') && !t.id.startsWith('tpl_'));
  let maxNum = 0;
  for (const ct of customOnly) {
    if (ct.templateNumber && ct.templateNumber > maxNum) maxNum = ct.templateNumber;
    const match = (ct.templateId || '').match(/C?(\d+)/i);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
    const idMatch = (ct.id || '').match(/cust_(\d+)/i);
    if (idMatch) {
      const n = parseInt(idMatch[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  const nextNum = maxNum + 1;
  return {
    id: `cust_${nextNum}`,
    templateId: `C${nextNum}`,
    templateNumber: nextNum,
  };
}

// Ensure any previously hidden built-in IDs are purged so all 300 built-in templates are always visible
export function restoreAllBuiltInTemplates(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(HIDDEN_BUILTINS_KEY);
    }
  } catch {}
}

// Auto-clean any legacy hidden builtin state on startup
restoreAllBuiltInTemplates();

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
 * Helper to sync user custom templates to Google Drive
 */
async function syncCustomTemplatesToDrive(templates: UserTemplate[]): Promise<void> {
  if (!isDriveConnected()) return;
  try {
    const customOnly = templates.filter(t => !t.isBuiltIn && !t.id.startsWith('builtin_') && !t.id.startsWith('tpl_'));
    await saveJsonFileToRootFolder(DRIVE_CUSTOM_TEMPLATES_FILE, customOnly);
  } catch (err) {
    console.warn("Failed to sync custom templates to Google Drive:", err);
  }
}

/**
 * Save a custom template permanently (IndexedDB + Google Drive)
 */
export async function saveUserTemplate(template: Omit<UserTemplate, 'createdAt'>): Promise<UserTemplate> {
  try {
    const db = await getDB();
    if (!db) {
      throw new Error('Database not available');
    }

    // Auto-allot Template ID & Number if not provided
    let templateId = template.templateId;
    let templateNumber = template.templateNumber;
    let templateDbId = template.id;

    if (!templateId || !templateDbId) {
      const allCurrent = await getUserTemplates();
      const nextInfo = allotNextCustomTemplateId(allCurrent);
      templateId = templateId || nextInfo.templateId;
      templateNumber = templateNumber || nextInfo.templateNumber;
      templateDbId = templateDbId || nextInfo.id;
    }

    const fullTemplate: UserTemplate = {
      ...template,
      id: templateDbId,
      templateId,
      templateNumber,
      createdAt: Date.now(),
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_TEMPLATES, 'readwrite');
      const store = tx.objectStore(STORE_TEMPLATES);
      const req = store.put(fullTemplate);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to save template'));
    });

    // In background, sync to Google Drive if connected
    if (isDriveConnected()) {
      getUserTemplates().then(all => syncCustomTemplatesToDrive(all)).catch(() => {});
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('radiology_templates_updated'));
    }

    return fullTemplate;
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

    // If Google Drive is connected, check Google Drive for templates to merge/sync
    if (isDriveConnected()) {
      try {
        const driveData = await loadJsonFileFromRootFolder<UserTemplate[]>(DRIVE_CUSTOM_TEMPLATES_FILE);
        if (Array.isArray(driveData) && driveData.length > 0) {
          const localIds = new Set(userCreated.map(t => t.id));
          let hasNewFromDrive = false;
          for (const dt of driveData) {
            if (!localIds.has(dt.id)) {
              userCreated.push(dt);
              hasNewFromDrive = true;
              if (db) {
                try {
                  const tx = db.transaction(STORE_TEMPLATES, 'readwrite');
                  tx.objectStore(STORE_TEMPLATES).put(dt);
                } catch (_) {}
              }
            }
          }
          if (hasNewFromDrive) {
            userCreated.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          }
        }
      } catch (driveErr) {
        console.warn("Drive custom templates check notice:", driveErr);
      }
    }

    // Ensure all user-created templates have allotted templateId (e.g. C1, C2)
    userCreated.forEach((t, idx) => {
      if (!t.templateId) {
        const num = idx + 1;
        t.templateNumber = num;
        t.templateId = `C${num}`;
      }
    });

    // Convert all 300 authoritative templates into UserTemplate format - permanently built in and non-deletable
    const builtInCustoms: UserTemplate[] = ALL_RADNITO_TEMPLATES.map(t => {
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

      const displayId = t.id.replace('tpl_', '').replace(/^0+/, '') || '1';

      return {
        id: `builtin_${t.id}`,
        templateId: displayId,
        templateNumber: parseInt(displayId, 10) || 1,
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
 * Delete a user-created custom template.
 * Built-in system templates (all 300 templates) are permanent and cannot be deleted.
 */
export async function deleteUserTemplate(id: string): Promise<void> {
  // Built-in templates are permanent system fixtures and cannot be deleted
  if (id.startsWith('builtin_') || id.startsWith('tpl_')) {
    console.warn(`Attempted to delete built-in template ${id}, which is protected and non-deletable.`);
    return;
  }

  try {
    const db = await getDB();
    if (!db) return;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_TEMPLATES, 'readwrite');
      const store = tx.objectStore(STORE_TEMPLATES);
      const req = store.delete(id);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to delete template'));
    });

    if (isDriveConnected()) {
      getUserTemplates().then(all => syncCustomTemplatesToDrive(all)).catch(() => {});
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('radiology_templates_updated'));
    }
  } catch (err) {
    console.error('deleteUserTemplate error:', err);
    throw err;
  }
}

/**
 * Resolve any template by dictated ID or number
 * Matches built-in templates (1-300 or tpl_001) or custom templates (C1, C2, etc.)
 */
export async function findTemplateByIdOrNumber(
  idOrNum: string
): Promise<{
  id: string;
  name: string;
  category?: string;
  modality?: string;
  lines: string[];
  content: string;
  docxBase64?: string;
  fileName?: string;
  skillPrompt?: string;
  templateId?: string;
} | null> {
  if (!idOrNum || !idOrNum.trim()) return null;
  const raw = idOrNum.trim().toLowerCase();
  const clean = raw.replace(/^\{?template\s*id\s*[:\s#]?/i, '').replace(/\}?$/, '').trim();
  const cleanLower = clean.toLowerCase();
  const cleanNumStr = cleanLower.replace(/^(tpl_|cust_|template_|c)/i, '').replace(/^0+/, '');
  const cleanNum = parseInt(cleanNumStr, 10);

  // 1. Check built-in templates (ALL_RADNITO_TEMPLATES)
  const exactBuiltin = ALL_RADNITO_TEMPLATES.find(t => 
    t.id.toLowerCase() === cleanLower ||
    t.id.toLowerCase() === `tpl_${cleanLower.padStart(3, '0')}`
  );
  if (exactBuiltin) {
    return {
      ...exactBuiltin,
      templateId: exactBuiltin.id.replace('tpl_', '').replace(/^0+/, '') || '1'
    };
  }

  // Check numeric match for built-in templates (e.g. "1" -> "tpl_001", "42" -> "tpl_042")
  if (!isNaN(cleanNum) && cleanNum > 0 && cleanNum <= ALL_RADNITO_TEMPLATES.length && !cleanLower.startsWith('c')) {
    const padded = String(cleanNum).padStart(3, '0');
    const matchedBuiltin = ALL_RADNITO_TEMPLATES.find(t => 
      t.id === `tpl_${padded}` || 
      parseInt(t.id.replace('tpl_', ''), 10) === cleanNum
    );
    if (matchedBuiltin) {
      return {
        ...matchedBuiltin,
        templateId: String(cleanNum)
      };
    }
  }

  // 2. Check custom user templates (IndexedDB / Google Drive)
  try {
    const userTemplates = await getUserTemplates();
    const matchedCustom = userTemplates.find(t => {
      if (t.isBuiltIn) return false;
      const tId = (t.templateId || '').toLowerCase();
      const rawId = (t.id || '').toLowerCase();
      if (tId === cleanLower || rawId === cleanLower) return true;
      if (cleanLower.startsWith('c') && tId === cleanLower) return true;
      if (cleanNumStr && (tId === `c${cleanNumStr}` || tId === cleanNumStr || (t.templateNumber && t.templateNumber === cleanNum))) return true;
      return false;
    });

    if (matchedCustom) {
      return {
        id: matchedCustom.id,
        name: matchedCustom.name,
        category: matchedCustom.category || 'CUSTOM',
        modality: matchedCustom.modality,
        lines: matchedCustom.lines || (matchedCustom.text ? matchedCustom.text.split('\n') : []),
        content: matchedCustom.text || (matchedCustom.lines ? matchedCustom.lines.join('\n') : ''),
        docxBase64: matchedCustom.docxFile?.data,
        fileName: matchedCustom.docxFile?.name,
        templateId: matchedCustom.templateId || (matchedCustom.templateNumber ? `C${matchedCustom.templateNumber}` : 'C1')
      };
    }
  } catch (err) {
    console.warn("Error finding custom template by ID:", err);
  }

  return null;
}

export interface DynamicTemplateStats {
  totalCount: number;
  builtInCount: number;
  customCount: number;
  customTemplates: UserTemplate[];
}

/**
 * Calculates real-time dynamic template statistics:
 * 300 authoritative built-in clinical templates + any user-uploaded custom templates stored in IndexedDB.
 */
export async function getDynamicTemplateStats(): Promise<DynamicTemplateStats> {
  try {
    const all = await getUserTemplates();
    const custom = all.filter(t => !t.isBuiltIn && !t.id.startsWith('builtin_') && !t.id.startsWith('tpl_'));
    const builtInCount = ALL_RADNITO_TEMPLATES.length; // 300 built-in templates
    return {
      totalCount: builtInCount + custom.length,
      builtInCount,
      customCount: custom.length,
      customTemplates: custom,
    };
  } catch (e) {
    console.warn('Failed to load dynamic template stats:', e);
    return {
      totalCount: ALL_RADNITO_TEMPLATES.length,
      builtInCount: ALL_RADNITO_TEMPLATES.length,
      customCount: 0,
      customTemplates: [],
    };
  }
}
