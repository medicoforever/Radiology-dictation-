import { ReportTemplate } from '../constants';
import { DocxTemplateData } from '../components/ui/CustomPromptInput';
import { getTemplateDocxBase64 } from './builtInTemplates';
import { safeLocalStorage } from './storageService';

export interface UpcomingTemplateConfig {
  id: string;
  name: string;
  promptText: string;
  docxData?: DocxTemplateData;
  category?: string;
  modality?: string;
  lines?: string[];
  content?: string;
}

const UPCOMING_TEMPLATE_KEY = 'radiologyUpcomingTemplate';

type UpcomingTemplateListener = (config: UpcomingTemplateConfig | null) => void;
const listeners = new Set<UpcomingTemplateListener>();

export const subscribeToUpcomingTemplate = (listener: UpcomingTemplateListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getUpcomingTemplate = (): UpcomingTemplateConfig | null => {
  return safeLocalStorage.getItem<UpcomingTemplateConfig | null>(UPCOMING_TEMPLATE_KEY, null);
};

export const setUpcomingTemplate = async (template: ReportTemplate | ReportTemplate[] | any): Promise<UpcomingTemplateConfig> => {
  if (Array.isArray(template)) {
    if (template.length === 1) {
      return setUpcomingTemplate(template[0]);
    }
    const cleanIds = template.map(t => {
      let id = t.id || t.name;
      if (typeof id === 'string' && id.startsWith('builtin_')) {
        id = id.replace('builtin_', '');
      }
      return id;
    });

    const combinedName = template.map(t => t.name).join(' + ');
    const combinedPrompt = `[TEMPLATE_ID: ${cleanIds.join(', ')}] Use combined report templates: ${template.map(t => `"${t.name}"`).join(' and ')}. Integrate my dictation into a unified multi-region report with findings properly placed and generate a synthesized impression.`;

    const combinedExtractedText = template.map(t => {
      const content = t.lines ? t.lines.join('\n') : (t.content || '');
      return `=== TEMPLATE: ${t.name} ===\n${content}`;
    }).join('\n\n');

    let firstDocx = '';
    for (const t of template) {
      if (t.docxBase64) {
        firstDocx = t.docxBase64;
        break;
      } else if (t.id) {
        try {
          const d = await getTemplateDocxBase64(t.id);
          if (d) {
            firstDocx = d;
            break;
          }
        } catch (e) {}
      }
    }

    const docxData: DocxTemplateData = {
      name: `${combinedName}.docx`,
      data: firstDocx,
      size: firstDocx ? Math.round(firstDocx.length * 0.75) : 0,
      extractedText: combinedExtractedText,
    };

    const config: UpcomingTemplateConfig = {
      id: cleanIds.join(','),
      name: combinedName,
      promptText: combinedPrompt,
      docxData,
      category: 'Combined',
      modality: 'COMBINED',
      lines: template.flatMap(t => t.lines || []),
      content: combinedExtractedText,
    };

    safeLocalStorage.setItem(UPCOMING_TEMPLATE_KEY, config);

    listeners.forEach((listener) => {
      try {
        listener(config);
      } catch (e) {
        console.error('Error notifying upcoming template listener:', e);
      }
    });

    return config;
  }

  let cleanId = template.id || template.name;
  if (typeof cleanId === 'string' && cleanId.startsWith('builtin_')) {
    cleanId = cleanId.replace('builtin_', '');
  }

  let docx = template.docxBase64 || template.docxFile?.data;
  if (!docx && cleanId) {
    try {
      docx = await getTemplateDocxBase64(cleanId);
    } catch (e) {
      console.warn('Could not load docx for upcoming template', e);
    }
  }

  const promptText = template.text
    ? (template.text.includes('[TEMPLATE') ? template.text : `[TEMPLATE_ID: ${cleanId}] ${template.text}`)
    : `[TEMPLATE_ID: ${cleanId}] Use the normal "${template.name}" report template. Integrate my dictation and generate a new impression.`;

  const extractedText = template.lines ? template.lines.join('\n') : (template.docxFile?.extractedText || template.text || template.content || '');
  const docxData: DocxTemplateData = {
    name: template.fileName || template.docxFile?.name || `${template.name}.docx`,
    data: docx || '',
    size: docx ? Math.round(docx.length * 0.75) : 0,
    extractedText,
  };

  const config: UpcomingTemplateConfig = {
    id: cleanId,
    name: template.name,
    promptText,
    docxData,
    category: template.category,
    modality: template.modality,
    lines: template.lines,
    content: template.content,
  };

  safeLocalStorage.setItem(UPCOMING_TEMPLATE_KEY, config);

  listeners.forEach((listener) => {
    try {
      listener(config);
    } catch (e) {
      console.error('Error notifying upcoming template listener:', e);
    }
  });

  return config;
};

export type { DocxTemplateData };

export interface CombinedTemplateBundle {
  id: string;
  name: string;
  promptText: string;
  lines: string[];
  docxData: DocxTemplateData | null;
  images: Array<{ data: string; mimeType: string }>;
}

/**
 * Deduplicates and merges reference template image arrays by base64 payload.
 */
export function mergeTemplateImages(
  existing?: Array<{ data: string; mimeType: string }> | null,
  incoming?: Array<{ data: string; mimeType: string }> | null
): Array<{ data: string; mimeType: string }> {
  const result: Array<{ data: string; mimeType: string }> = [];
  const seen = new Set<string>();
  for (const img of [...(existing || []), ...(incoming || [])]) {
    if (img?.data && !seen.has(img.data)) {
      seen.add(img.data);
      result.push({ data: img.data, mimeType: img.mimeType || 'image/png' });
    }
  }
  return result;
}

/**
 * Canonicalizes a raw template ID token:
 * - '1' / 'tpl_1' / 'builtin_tpl_001' -> 'tpl_001'
 * - 'add_128' / 'add 128' / 'tpl_add_128' / 'add underscore 128' -> 'tpl_add_128'
 * - 'c1' -> 'C1'
 */
export function canonicalizeTemplateIdToken(rawToken?: string): string {
  if (!rawToken) return '';
  const cleaned = String(rawToken)
    .trim()
    .replace(/^builtin_/i, '')
    .replace(/\b(?:underscore|under\s+score|dash|hyphen)\b/gi, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  const addMatch = cleaned.match(/^(?:tpl[\s_-]*)?add(?:[\s_-]|_)*(\d+)$/i);
  if (addMatch) {
    const n = parseInt(addMatch[1], 10);
    if (!isNaN(n) && n > 0) {
      return `tpl_add_${String(n).padStart(3, '0')}`;
    }
    return `tpl_add_${addMatch[1].padStart(3, '0')}`;
  }

  const builtinMatch = cleaned.match(/^(?:tpl[\s_-]*)?(\d+)$/i);
  if (builtinMatch) {
    return `tpl_${builtinMatch[1].padStart(3, '0')}`;
  }

  const customMatch = cleaned.match(/^c(\d+)$/i);
  if (customMatch) {
    return `C${customMatch[1]}`;
  }

  return cleaned;
}

/**
 * Normalizes any built-in or custom template item to a canonical [TEMPLATE_ID] token
 * (e.g. 'tpl_001', 'tpl_add_128' for built-ins, 'C1' for custom templates).
 */
export function normalizeTemplateTagId(t: any): string {
  if (!t) return '';
  const rawId = String(t.id || '').trim();
  const stripped = rawId.replace(/^builtin_/i, '');
  if (/^tpl_(?:add_)?\d+$/i.test(stripped)) {
    return canonicalizeTemplateIdToken(stripped);
  }
  const rawDisplayId = String(t.templateId || '').trim();
  if (/^c\d+$/i.test(rawDisplayId)) {
    return rawDisplayId.toUpperCase();
  }
  if (/^(?:tpl_)?add[_\s-]*\d+$/i.test(rawDisplayId)) {
    return canonicalizeTemplateIdToken(rawDisplayId);
  }
  if (/^\d+$/.test(stripped)) {
    return canonicalizeTemplateIdToken(stripped);
  }
  if (/^\d+$/.test(rawDisplayId) && t.isBuiltIn !== false && !t.isCustom && !rawId.startsWith('custom_')) {
    return canonicalizeTemplateIdToken(rawDisplayId);
  }
  return rawDisplayId || stripped || String(t.name || '');
}

/**
 * Extracts all template ID tokens from a prompt's [TEMPLATE_ID: ...] / [TEMPLATE_IDS: ...] tags,
 * including built-in IDs (tpl_001, tpl_add_128, add_128, numeric) and custom IDs (C1, custom_...).
 */
export function extractTemplateTagIds(promptOrId?: string): string[] {
  if (!promptOrId) return [];
  const raw = String(promptOrId).trim();
  if (!raw) return [];
  const results: string[] = [];
  const matches = [...raw.matchAll(/\[(?:TEMPLATE_ID|TEMPLATE_IDS|TEMPLATES|TEMPLATE|ID):\s*([^\]]+)\]/gi)];
  for (const m of matches) {
    const normalizedStr = m[1]
      .replace(/\b((?:builtin_)?(?:tpl[\s_-]*)?add)[\s_-]+(\d+)\b/gi, '$1_$2');
    const parts = normalizedStr
      .split(/[,;\s]+/)
      .map(p => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      const clean = canonicalizeTemplateIdToken(part);
      if (clean && !results.some(r => r.toLowerCase() === clean.toLowerCase())) {
        results.push(clean);
      }
    }
  }
  return results;
}

function extractLinesFromTemplateItem(t: any): string[] {
  if (Array.isArray(t?.lines) && t.lines.length > 0) {
    return t.lines.filter((l: any) => typeof l === 'string' && l.trim().length > 0);
  }
  const rawText = t?.docxFile?.extractedText || t?.extractedText || t?.text || '';
  if (typeof rawText === 'string' && rawText.trim().length > 0) {
    return rawText.split('\n').map(l => l.trim()).filter(Boolean);
  }
  if (typeof t?.content === 'string' && t.content.trim().length > 0) {
    try {
      const parsed = JSON.parse(t.content);
      return [
        parsed.title,
        parsed.technique,
        ...(Array.isArray(parsed.normal_findings) ? parsed.normal_findings : []),
        parsed.default_impression,
      ]
        .filter((x: any) => typeof x === 'string' && x.trim().length > 0);
    } catch {
      return t.content.split('\n').map((l: string) => l.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * Builds a unified prompt, DOCX structure/text payload, and reference images array
 * for 1 or N templates (built-in, custom uploaded, or mixed).
 */
export async function buildCombinedTemplateBundle(
  templateInput: any | any[]
): Promise<CombinedTemplateBundle> {
  const rawList = (Array.isArray(templateInput) ? templateInput : [templateInput]).filter(Boolean);
  const items: any[] = [];
  const seenIds = new Set<string>();
  for (const item of rawList) {
    const tagId = normalizeTemplateTagId(item);
    const dedupKey = (tagId || item.id || item.name || '').toLowerCase();
    if (!seenIds.has(dedupKey)) {
      seenIds.add(dedupKey);
      items.push(item);
    }
  }

  if (items.length === 0) {
    return {
      id: '',
      name: '',
      promptText: '',
      lines: [],
      docxData: null,
      images: [],
    };
  }

  const tagIds: string[] = [];
  const names: string[] = [];
  const allLines: string[] = [];
  const sectionBlocks: string[] = [];
  const skillNotes: string[] = [];
  const combinedImages: Array<{ data: string; mimeType: string }> = [];
  const seenImageData = new Set<string>();

  let firstDocxBase64: string | undefined = undefined;
  let firstDocxName: string | undefined = undefined;
  let totalDocxSize = 0;

  for (const t of items) {
    const tagId = normalizeTemplateTagId(t);
    tagIds.push(tagId);
    names.push(String(t.name || tagId));

    const itemLines = extractLinesFromTemplateItem(t);
    allLines.push(...itemLines);
    const blockText = itemLines.join('\n').trim();
    sectionBlocks.push(
      items.length > 1
        ? `=== TEMPLATE: ${t.name || tagId} ===\n${blockText || t.name || tagId}`
        : blockText
    );

    if (typeof t.skillPrompt === 'string' && t.skillPrompt.trim()) {
      skillNotes.push(
        items.length > 1
          ? `[TEMPLATE INSTRUCTIONS FOR "${t.name}"]: ${t.skillPrompt.trim()}`
          : t.skillPrompt.trim()
      );
    }

    const imgs: Array<{ data: string; mimeType: string }> = [
      ...(Array.isArray(t.images) ? t.images : []),
      ...(Array.isArray(t.customImages) ? t.customImages : []),
    ];
    for (const img of imgs) {
      if (img?.data && !seenImageData.has(img.data)) {
        seenImageData.add(img.data);
        combinedImages.push({ data: img.data, mimeType: img.mimeType || 'image/png' });
      }
    }

    let docxB64: string | undefined = t.docxFile?.data || t.docxBase64 || t.docxData?.data;
    if (!docxB64 && /^tpl_(?:add_)?\d+$/i.test(tagId)) {
      try {
        docxB64 = await getTemplateDocxBase64(tagId);
      } catch (e) {
        console.warn(`Could not fetch docxBase64 for ${tagId}:`, e);
      }
    }
    if (docxB64) {
      if (!firstDocxBase64) {
        firstDocxBase64 = docxB64;
        firstDocxName = t.docxFile?.name || t.fileName || t.docxData?.name;
      }
      totalDocxSize += t.docxFile?.size || Math.round((docxB64.length * 3) / 4);
    }
  }

  const combinedId = tagIds.join(',');
  const combinedName = names.join(' + ');
  const combinedExtractedText = sectionBlocks.filter(Boolean).join('\n\n').trim();
  const skillSuffix = skillNotes.length > 0 ? `\n\n${skillNotes.join('\n')}` : '';

  const promptText =
    items.length === 1
      ? `[TEMPLATE_ID: ${tagIds[0]}] Merged with template: ${names[0]}.${skillSuffix}`
      : `[TEMPLATE_ID: ${tagIds.join(', ')}] Use combined report templates: ${names.map(n => `"${n}"`).join(' and ')}. Merge dictated clinical findings logically into the combined sections of ALL ${items.length} templates in exact sequence without omitting any template or heading, and generate a synthesized impression.${skillSuffix}`;

  const docxData: DocxTemplateData | null =
    firstDocxBase64 || combinedExtractedText
      ? {
          name: items.length === 1 ? (firstDocxName || `${names[0]}.docx`) : `${combinedName}.docx`,
          data: firstDocxBase64 || '',
          size: totalDocxSize || combinedExtractedText.length,
          extractedText: combinedExtractedText,
        }
      : null;

  return {
    id: combinedId,
    name: combinedName,
    promptText,
    lines: allLines,
    docxData,
    images: combinedImages,
  };
}

export const clearUpcomingTemplate = (): void => {
  safeLocalStorage.removeItem(UPCOMING_TEMPLATE_KEY);

  listeners.forEach((listener) => {
    try {
      listener(null);
    } catch (e) {
      console.error('Error notifying upcoming template listener:', e);
    }
  });
};
