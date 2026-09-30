import { ReportTemplate } from '../constants';
import { DocxTemplateData } from '../components/ui/CustomPromptInput';
import { getTemplateDocxBase64 } from './builtInTemplates';

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
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(UPCOMING_TEMPLATE_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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

    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem(UPCOMING_TEMPLATE_KEY, JSON.stringify(config));
      }
    } catch (err) {
      console.warn('Failed to save upcoming combined template to localStorage', err);
    }

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

  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(UPCOMING_TEMPLATE_KEY, JSON.stringify(config));
    }
  } catch (err) {
    console.warn('Failed to save upcoming template to localStorage', err);
  }

  listeners.forEach((listener) => {
    try {
      listener(config);
    } catch (e) {
      console.error('Error notifying upcoming template listener:', e);
    }
  });

  return config;
};

export const clearUpcomingTemplate = (): void => {
  try {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(UPCOMING_TEMPLATE_KEY);
    }
  } catch {}

  listeners.forEach((listener) => {
    try {
      listener(null);
    } catch (e) {
      console.error('Error notifying upcoming template listener:', e);
    }
  });
};
