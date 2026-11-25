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

function spokenWordsToNumber(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/[-\s]+/g, ' ');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const ones: Record<string, number> = {
    zero: 0, oh: 0, o: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5,
    six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const tens: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const tokens = s.split(' ').filter(t => t && t !== 'and');
  if (tokens.length === 0) return null;

  // Handle common spoken 3-digit shorthands without "hundred": e.g. "one twenty eight" -> 128, "one oh five" -> 105, "one two eight" -> 128
  if (!tokens.includes('hundred')) {
    const first = ones[tokens[0]];
    if (tokens.length === 3 && first !== undefined && first >= 0 && first <= 9) {
      const secondTen = tens[tokens[1]];
      const secondOne = ones[tokens[1]];
      const third = ones[tokens[2]];
      if (first >= 1 && secondTen !== undefined && third !== undefined && third >= 1 && third <= 9) {
        return first * 100 + secondTen + third;
      }
      if (secondOne !== undefined && secondOne >= 0 && secondOne <= 9 && third !== undefined && third >= 0 && third <= 9) {
        return first * 100 + secondOne * 10 + third;
      }
    }
    if (tokens.length === 2 && first !== undefined && first >= 1 && first <= 9) {
      const secondTen = tens[tokens[1]];
      const secondTeen = ones[tokens[1]];
      if (secondTen !== undefined) {
        return first * 100 + secondTen;
      }
      if (secondTeen !== undefined && secondTeen >= 10 && secondTeen <= 19) {
        return first * 100 + secondTeen;
      }
    }
  }

  let total = 0;
  let current = 0;
  for (const tok of tokens) {
    if (ones[tok] !== undefined) {
      current += ones[tok];
    } else if (tens[tok] !== undefined) {
      current += tens[tok];
    } else if (tok === 'hundred') {
      current = (current === 0 ? 1 : current) * 100;
    } else if (/^\d+$/.test(tok)) {
      current += parseInt(tok, 10);
    } else {
      return null;
    }
  }
  total += current;
  return total > 0 ? total : null;
}

/**
 * Resolve any template by dictated ID or number
 * Matches built-in templates (1-72 or tpl_001), supplemental templates (add_001-add_228 or tpl_add_128),
 * or custom templates (C1, C2, etc.).
 * Strictly rejects vague names without an explicit numeric, add_XXX, or C-ID.
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
  const clean = raw
    .replace(/^\{?\s*(?:add\s+template\s+id|template\s+id|template|id)\s*(?:number|no\.?)?\s*[:\s#-]*/i, '')
    .replace(/\}?$/, '')
    .replace(/[.,!?;:]+$/, '')
    .replace(/\b(?:underscore|under\s+score|dash|hyphen)\b/gi, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;

  const cleanNoSpaces = clean.replace(/[\s\-]+/g, '');
  const cleanLower = cleanNoSpaces.toLowerCase();

  // 0. Check supplemental ADDITIONAL_TEMPLATES ("add_128", "add 128", "tpl_add_128", "builtin_tpl_add_128")
  const addTokenMatch = clean.match(/^(?:builtin_)?(?:tpl[\s_-]*)?add(?:[\s_-]+|(?=\d))(.*)$/i);
  if (addTokenMatch) {
    const addTail = addTokenMatch[1].replace(/^[\s_#-]+/, '').trim();
    const addNum = /^\d+$/.test(addTail.replace(/^0+/, ''))
      ? parseInt(addTail.replace(/^0+/, ''), 10)
      : spokenWordsToNumber(addTail);
    if (addNum && !isNaN(addNum) && addNum > 0) {
      const paddedAddId = `tpl_add_${String(addNum).padStart(3, '0')}`;
      const matchedAdd = ALL_RADNITO_TEMPLATES.find(t =>
        t.id.toLowerCase() === paddedAddId ||
        t.id.toLowerCase() === `tpl_add_${addNum}`
      );
      if (matchedAdd) {
        return {
          ...matchedAdd,
          templateId: matchedAdd.id.replace(/^tpl_/i, ''),
        };
      }
    }
    return null;
  }

  const isCustomToken = /^(?:c|see|sea|custom|cust)(?:[\s\-_]|\d|$)/i.test(clean);
  const strippedPrefix = clean
    .replace(/^(?:builtin_)?(?:tpl_|template_|cust_|custom\s+|see\s+|sea\s+|c(?=\s*\d|\s+[a-z]))/i, '')
    .replace(/^[c](?=\d)/i, '')
    .replace(/^[\s\-_#]+/, '')
    .trim();

  const parsedNum = /^\d+$/.test(strippedPrefix.replace(/^0+/, ''))
    ? parseInt(strippedPrefix.replace(/^0+/, ''), 10)
    : spokenWordsToNumber(strippedPrefix);

  const normalizedCustomId = isCustomToken && parsedNum ? `c${parsedNum}` : '';

  // 1. Check built-in templates (ALL_RADNITO_TEMPLATES) if not explicitly prefixed as custom
  if (!isCustomToken) {
    const exactBuiltin = ALL_RADNITO_TEMPLATES.find(t =>
      t.id.toLowerCase() === cleanLower ||
      (parsedNum && t.id.toLowerCase() === `tpl_${String(parsedNum).padStart(3, '0')}`)
    );
    if (exactBuiltin) {
      return {
        ...exactBuiltin,
        templateId: exactBuiltin.id.replace('tpl_', '').replace(/^0+/, '') || '1'
      };
    }

    if (parsedNum && !isNaN(parsedNum) && parsedNum > 0 && parsedNum <= ALL_RADNITO_TEMPLATES.length) {
      const padded = String(parsedNum).padStart(3, '0');
      const matchedBuiltin = ALL_RADNITO_TEMPLATES.find(t =>
        t.id === `tpl_${padded}` ||
        parseInt(t.id.replace('tpl_', ''), 10) === parsedNum
      );
      if (matchedBuiltin) {
        return {
          ...matchedBuiltin,
          templateId: String(parsedNum)
        };
      }
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
      if (normalizedCustomId && (tId === normalizedCustomId || rawId === `cust_${parsedNum}`)) return true;
      if (isCustomToken && parsedNum && t.templateNumber === parsedNum) return true;
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
