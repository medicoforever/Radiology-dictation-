/**
 * RADDOC Macros Service
 * Provides simple custom text macros: macro name and corresponding sentence/paragraph.
 * No default macros provided by default - user creates their own macros.
 * Supports localStorage persistence and optional Google Drive synchronization.
 */

import { loadJsonFileFromRootFolder, saveJsonFileToRootFolder, isDriveConnected } from './googleDriveService';

export interface RadiologyMacro {
  id: string;
  name: string;
  text: string; // Corresponding sentence or paragraph
  findings?: string[];
  triggerPhrases?: string[];
  category?: string;
  enabled?: boolean;
  updatedAt?: number;
}

// Kept for backward compatibility with existing interfaces
export interface VocabularyRule {
  id: string;
  pattern: string;
  replacement: string;
  category?: string;
  isRegex?: boolean;
  enabled?: boolean;
  description?: string;
  updatedAt?: number;
}

export interface MacroDictionaryStore {
  version: number;
  macros: RadiologyMacro[];
  vocabularyRules: VocabularyRule[];
  lastSyncedAt?: number;
}

const STORAGE_KEY = 'radiology_macros_and_dictionary_store';
const DRIVE_FILE_NAME = 'raddoc_macros_dictionary.json';

// Zero default macros - user starts with a clean slate
export const DEFAULT_BUILTIN_MACROS: RadiologyMacro[] = [];
export const DEFAULT_BUILTIN_VOCABULARY_RULES: VocabularyRule[] = [];

// Legacy default IDs to purge if found in existing localStorage
const LEGACY_DEFAULT_IDS = new Set([
  'macro_cxr_normal',
  'macro_ct_brain_normal',
  'macro_usg_abdomen_normal',
  'macro_mri_spine_normal',
  'macro_appendix_normal',
  'vocab_calculus',
  'vocab_gallbladder',
  'vocab_choledocholithiasis',
  'vocab_hypodensity',
  'vocab_sp_abbreviation',
]);

const listeners = new Set<(store: MacroDictionaryStore) => void>();

function notifyListeners(store: MacroDictionaryStore): void {
  listeners.forEach(fn => {
    try {
      fn(store);
    } catch (e) {
      console.warn('Listener error in macroDictionaryService:', e);
    }
  });
}

function normalizeMacro(m: Partial<RadiologyMacro> & { name: string; text?: string; findings?: string[] }): RadiologyMacro {
  const text = (m.text || (Array.isArray(m.findings) ? m.findings.join('\n') : '') || '').trim();
  const name = (m.name || '').trim();
  const findings = text
    ? text.split('\n').map(l => l.trim()).filter(Boolean)
    : [name];

  return {
    id: m.id || `macro_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    text,
    findings,
    triggerPhrases: [name.toLowerCase(), `macro ${name.toLowerCase()}`],
    enabled: m.enabled !== false,
    updatedAt: m.updatedAt || Date.now(),
  };
}

/**
 * Loads the current store from localStorage.
 * Does not inject any default macros. Filters out legacy built-in defaults.
 */
export function getMacroDictionaryStore(): MacroDictionaryStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MacroDictionaryStore;
      if (Array.isArray(parsed.macros)) {
        // Filter out legacy default macros so the user has no pre-provided macros
        const cleanedMacros = parsed.macros
          .filter(m => m && !LEGACY_DEFAULT_IDS.has(m.id))
          .map(m => normalizeMacro(m));

        const store: MacroDictionaryStore = {
          version: parsed.version || 2,
          macros: cleanedMacros,
          vocabularyRules: Array.isArray(parsed.vocabularyRules)
            ? parsed.vocabularyRules.filter(r => r && !LEGACY_DEFAULT_IDS.has(r.id))
            : [],
          lastSyncedAt: parsed.lastSyncedAt,
        };

        // If legacy items were purged, save the clean store back
        if (cleanedMacros.length !== parsed.macros.length) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
          } catch {}
        }

        return store;
      }
    }
  } catch (err) {
    console.warn('Failed to parse local macro store:', err);
  }

  // Initial clean empty store
  const emptyStore: MacroDictionaryStore = {
    version: 2,
    macros: [],
    vocabularyRules: [],
    lastSyncedAt: undefined,
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(emptyStore));
  } catch {}

  return emptyStore;
}

/**
 * Persists the store to localStorage and broadcasts to subscribers.
 */
export function saveMacroDictionaryStore(store: MacroDictionaryStore): void {
  const normalized: MacroDictionaryStore = {
    ...store,
    macros: (store.macros || []).map(m => normalizeMacro(m)),
    vocabularyRules: store.vocabularyRules || [],
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (err) {
    console.warn('Failed to save macro store to localStorage:', err);
  }
  notifyListeners(normalized);
}

/**
 * Subscribe to reactive store changes.
 */
export function subscribeToMacroDictionary(callback: (store: MacroDictionaryStore) => void): () => void {
  listeners.add(callback);
  callback(getMacroDictionaryStore());
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Normalizes text for matching macro triggers.
 * Removes outer brackets like { }, [ ], ( ), punctuation, hyphens, and whitespace.
 */
export function normalizeForMacroMatch(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/^bold::/i, '')
    .replace(/[{}\[\]()]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/[.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches a spoken utterance against configured macros by name.
 * E.g. user says "macro age related" or "insert normal chest".
 */
export function matchSpokenVoiceMacro(utterance: string): { matchedMacro: RadiologyMacro; expandedFindings: string[] } | null {
  if (!utterance || !utterance.trim()) return null;
  const cleaned = normalizeForMacroMatch(utterance);
  const store = getMacroDictionaryStore();

  for (const macro of store.macros) {
    if (macro.enabled === false) continue;
    const nameClean = normalizeForMacroMatch(macro.name);
    if (!nameClean) continue;

    const triggers = [
      `macro ${nameClean}`,
      `insert macro ${nameClean}`,
      nameClean,
      `insert ${nameClean}`,
      ...(macro.triggerPhrases || []).map(p => normalizeForMacroMatch(p))
    ];

    for (const phrase of triggers) {
      if (!phrase) continue;
      if (
        cleaned === phrase ||
        cleaned.startsWith(phrase + ' ') ||
        cleaned.endsWith(' ' + phrase) ||
        cleaned.includes(' ' + phrase + ' ')
      ) {
        const textLines = macro.text ? macro.text.split('\n').filter(Boolean) : (macro.findings || []);
        return {
          matchedMacro: macro,
          expandedFindings: textLines.length > 0 ? textLines : [macro.text || macro.name],
        };
      }
    }
  }

  return null;
}

/**
 * Returns a prompt fragment listing user-defined macros to instruct Gemini to expand them.
 */
export function getMacroPromptContext(): string {
  try {
    const store = getMacroDictionaryStore();
    if (!store.macros || store.macros.length === 0) return '';
    const active = store.macros.filter(m => m.enabled !== false && m.name && m.name.trim() && (m.text || (m.findings && m.findings.length > 0)));
    if (active.length === 0) return '';

    const lines = active.map(m => {
      const content = (m.text || (m.findings ? m.findings.join(' ') : '')).trim();
      return `- Spoken phrase: "macro ${m.name}" (or "${m.name}") -> MUST expand into exact text: "${content}"`;
    });

    return `
================================================================================
CRITICAL CLINICAL VOICE MACROS:
The radiologist has configured the following active text macros.
If the doctor speaks "macro [macro name]" (e.g. "macro ${active[0].name}") or dictates a macro trigger,
DO NOT write literal placeholder words like "macro ${active[0].name}" or "{Macro ${active[0].name}.}" in the report findings!
You MUST expand it and output the corresponding full text:
${lines.join('\n')}
================================================================================
`;
  } catch (e) {
    return '';
  }
}

/**
 * Expands any macro references across an array of report finding strings.
 * Detects standalone lines like "{Macro age-related.}", "Macro age-related.", "macro age related",
 * as well as embedded macro triggers inside a finding line.
 */
export function expandMacrosInFindings(findings: string[]): string[] {
  if (!findings || findings.length === 0) return findings;
  const store = getMacroDictionaryStore();
  if (!store.macros || store.macros.length === 0) return findings;

  const activeMacros = store.macros.filter(m => m.enabled !== false && m.name && m.name.trim());
  if (activeMacros.length === 0) return findings;

  const result: string[] = [];

  for (const rawFinding of findings) {
    if (!rawFinding || typeof rawFinding !== 'string') {
      result.push(rawFinding);
      continue;
    }

    const isBoldPrefixed = rawFinding.startsWith('BOLD::');
    const findingContent = rawFinding.replace(/^BOLD::/i, '').trim();
    const normalizedContent = normalizeForMacroMatch(findingContent);

    // 1. Check if the entire finding is an isolated macro trigger:
    // e.g. "{Macro age-related.}", "Macro age-related.", "macro age related", "insert macro age related", "{age-related}"
    let matchedMacro: RadiologyMacro | null = null;

    for (const macro of activeMacros) {
      const macroNorm = normalizeForMacroMatch(macro.name);
      if (!macroNorm) continue;

      const strippedMacroPrefix = normalizedContent.replace(/^(?:insert\s+)?macro\s+/i, '').trim();
      if (
        normalizedContent === macroNorm ||
        normalizedContent === `macro ${macroNorm}` ||
        normalizedContent === `insert macro ${macroNorm}` ||
        strippedMacroPrefix === macroNorm ||
        (macroNorm.length > 3 && strippedMacroPrefix.startsWith(macroNorm)) ||
        (strippedMacroPrefix.length > 3 && macroNorm.startsWith(strippedMacroPrefix))
      ) {
        matchedMacro = macro;
        break;
      }
    }

    if (matchedMacro) {
      // Expand into macro lines
      const macroLines = (matchedMacro.text || (matchedMacro.findings ? matchedMacro.findings.join('\n') : matchedMacro.name))
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

      for (const line of macroLines) {
        if (isBoldPrefixed && !line.startsWith('BOLD::') && !line.startsWith('IMPRESSION:') && !line.toLowerCase().startsWith('clinical profile:')) {
          result.push(`BOLD::${line}`);
        } else {
          result.push(line);
        }
      }
      continue;
    }

    // 2. Check for embedded macro references inside the line:
    // e.g. "Mild ischemic changes. {Macro age-related.} No mass effect."
    let processedFinding = findingContent;
    let didReplaceEmbedded = false;

    for (const macro of activeMacros) {
      const macroNorm = normalizeForMacroMatch(macro.name);
      if (!macroNorm) continue;

      const nameParts = macro.name.split(/[\s\-_]+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
      const namePattern = nameParts.join('[\\s\\-_]+');

      // Embedded with "macro" keyword: {Macro age-related.} or Macro: age-related or macro age-related
      const embeddedRegex = new RegExp(
        `(?:\\{|\\(|\\[)?\\s*(?:insert\\s+)?macro[\\s:\\-]+` + namePattern + `[.,!?;:]?\\s*(?:\\}|\\)|\\])?`,
        'gi'
      );

      if (embeddedRegex.test(processedFinding)) {
        const replacementText = (macro.text || (macro.findings ? macro.findings.join(' ') : macro.name)).trim();
        processedFinding = processedFinding.replace(embeddedRegex, replacementText);
        didReplaceEmbedded = true;
      }

      // Also match {<macro_name>} with curly braces even if word "macro" wasn't transcribed: {age-related} or {age related.}
      const bracketedRegex = new RegExp(
        `\\{\\s*` + namePattern + `[.,!?;:]?\\s*\\}`,
        'gi'
      );
      if (bracketedRegex.test(processedFinding)) {
        const replacementText = (macro.text || (macro.findings ? macro.findings.join(' ') : macro.name)).trim();
        processedFinding = processedFinding.replace(bracketedRegex, replacementText);
        didReplaceEmbedded = true;
      }
    }

    if (didReplaceEmbedded) {
      if (isBoldPrefixed) {
        result.push(`BOLD::${processedFinding}`);
      } else {
        result.push(processedFinding);
      }
    } else {
      result.push(rawFinding);
    }
  }

  return result;
}

/**
 * Applies custom vocabulary rules if any exist in the store.
 */
export function applyCustomVocabularyRules(text: string): string {
  if (!text) return '';
  const store = getMacroDictionaryStore();
  if (!store.vocabularyRules || store.vocabularyRules.length === 0) return text;

  let result = text;
  for (const rule of store.vocabularyRules) {
    if (rule.enabled === false || !rule.pattern) continue;
    try {
      if (rule.isRegex) {
        const regex = new RegExp(rule.pattern, 'gi');
        result = result.replace(regex, rule.replacement);
      } else {
        const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        result = result.replace(regex, rule.replacement);
      }
    } catch (err) {
      console.warn(`Failed to execute vocabulary rule "${rule.pattern}":`, err);
    }
  }

  return result;
}

/**
 * Synchronizes the macros store with Google Drive root folder.
 */
export async function syncMacrosWithGoogleDrive(): Promise<{ success: boolean; message?: string; syncedCount?: number }> {
  if (!isDriveConnected()) {
    return { success: false, message: 'Google Drive is not connected. Sign in with Google Drive first.' };
  }

  try {
    const driveData = await loadJsonFileFromRootFolder<MacroDictionaryStore>(DRIVE_FILE_NAME);
    const localStore = getMacroDictionaryStore();

    if (driveData && Array.isArray(driveData.macros)) {
      const mergedMacrosMap = new Map<string, RadiologyMacro>();
      localStore.macros.forEach(m => mergedMacrosMap.set(m.id, m));
      driveData.macros.forEach(m => {
        if (!LEGACY_DEFAULT_IDS.has(m.id)) {
          const local = mergedMacrosMap.get(m.id);
          if (!local || (m.updatedAt || 0) > (local.updatedAt || 0)) {
            mergedMacrosMap.set(m.id, normalizeMacro(m));
          }
        }
      });

      const mergedStore: MacroDictionaryStore = {
        version: Math.max(localStore.version || 2, driveData.version || 2) + 1,
        macros: Array.from(mergedMacrosMap.values()),
        vocabularyRules: [],
        lastSyncedAt: Date.now(),
      };

      saveMacroDictionaryStore(mergedStore);
      await saveJsonFileToRootFolder(DRIVE_FILE_NAME, mergedStore);

      return {
        success: true,
        message: 'Macros synced with Google Drive',
        syncedCount: mergedStore.macros.length,
      };
    } else {
      const storeToUpload: MacroDictionaryStore = {
        ...localStore,
        lastSyncedAt: Date.now(),
      };
      await saveJsonFileToRootFolder(DRIVE_FILE_NAME, storeToUpload);
      saveMacroDictionaryStore(storeToUpload);

      return {
        success: true,
        message: 'Uploaded macros to Google Drive',
        syncedCount: storeToUpload.macros.length,
      };
    }
  } catch (err: any) {
    console.warn('Sync macros with Google Drive failed:', err);
    return {
      success: false,
      message: err?.message || 'Failed to sync with Google Drive',
    };
  }
}

/**
 * Adds or updates a macro from spoken voice dictation or automated agent.
 */
export function addMacroFromAutonomous(name: string, text: string): RadiologyMacro {
  const store = getMacroDictionaryStore();
  const trimmedName = name.trim();
  const trimmedText = text.trim();
  
  const existingIdx = store.macros.findIndex(
    m => m.name.toLowerCase() === trimmedName.toLowerCase()
  );
  
  const macro: RadiologyMacro = {
    id: existingIdx >= 0 ? store.macros[existingIdx].id : `macro_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: trimmedName,
    text: trimmedText,
    findings: trimmedText.split('\n').map(l => l.trim()).filter(Boolean),
    triggerPhrases: [trimmedName.toLowerCase(), `macro ${trimmedName.toLowerCase()}`],
    enabled: true,
    updatedAt: Date.now(),
  };

  if (existingIdx >= 0) {
    store.macros[existingIdx] = macro;
  } else {
    store.macros.unshift(macro);
  }

  saveMacroDictionaryStore(store);
  return macro;
}

/**
 * Adds or updates a vocabulary replacement rule from spoken voice dictation or automated agent.
 */
export function addVocabularyRuleFromAutonomous(pattern: string, replacement: string): VocabularyRule {
  const store = getMacroDictionaryStore();
  const trimmedPattern = pattern.trim();
  const trimmedReplacement = replacement.trim();

  const existingIdx = store.vocabularyRules.findIndex(
    r => r.pattern.toLowerCase() === trimmedPattern.toLowerCase()
  );

  const rule: VocabularyRule = {
    id: existingIdx >= 0 ? store.vocabularyRules[existingIdx].id : `vocab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    pattern: trimmedPattern,
    replacement: trimmedReplacement,
    enabled: true,
    updatedAt: Date.now(),
  };

  if (existingIdx >= 0) {
    store.vocabularyRules[existingIdx] = rule;
  } else {
    store.vocabularyRules.unshift(rule);
  }

  saveMacroDictionaryStore(store);
  return rule;
}

