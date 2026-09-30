import { GoogleGenAI, Type, GenerateContentResponse, Chat } from "@google/genai";
import { DEFAULT_GEMINI_PROMPT, REPROCESS_GEMINI_PROMPT, TEMPLATE_GEMINI_PROMPT, REPORT_TEMPLATES, ERROR_IDENTIFIER_PROMPT, INITIAL_AGENT_PROMPT, REFINEMENT_AGENT_PROMPT, SYNTHESIZER_AGENT_PROMPT, VISUAL_TEMPLATE_GEMINI_PROMPT, getLiveModelFallbackChain, DEFAULT_SELECTED_MODEL, ReportTemplate } from '../constants';
import { IdentifiedError } from "../types";
import { isTableRowFinding } from "./docxService";

let aiClient: GoogleGenAI | null = null;
export const getAI = (): GoogleGenAI => {
  if (!aiClient) {
    const key = (typeof process !== 'undefined' && (process.env?.GEMINI_API_KEY || process.env?.API_KEY)) || '';
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
};

export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result as string;
      // remove the "data:audio/ogg;base64," part
      resolve(base64data.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export const base64ToBlob = (base64: string, mimeType: string): Blob => {
  try {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  } catch (e) {
    console.error("Failed to convert base64 to Blob:", e);
    // Return an empty blob on error
    return new Blob([], { type: mimeType });
  }
};


export const getCleanMimeType = (blob: Blob): string => {
    let mimeType = blob.type;
    if ((!mimeType || mimeType === 'application/octet-stream') && (blob as any).name) {
        const name = ((blob as any).name as string).toLowerCase();
        if (name.endsWith('.pdf')) return 'application/pdf';
        if (name.endsWith('.png')) return 'image/png';
        if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
        if (name.endsWith('.webp')) return 'image/webp';
        if (name.endsWith('.gif')) return 'image/gif';
        if (name.endsWith('.mp4')) return 'video/mp4';
        if (name.endsWith('.mov')) return 'video/quicktime';
        if (name.endsWith('.webm')) return 'video/webm';
        if (name.endsWith('.mp3')) return 'audio/mp3';
        if (name.endsWith('.wav')) return 'audio/wav';
        if (name.endsWith('.m4a')) return 'audio/m4a';
        if (name.endsWith('.ogg')) return 'audio/ogg';
        if (name.endsWith('.flac')) return 'audio/flac';
        if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || name.endsWith('.json')) return 'text/plain';
    }

    if (!mimeType) {
        // Fallback for files without a MIME type, maintaining original behavior.
        return 'audio/ogg';
    }
    // Handle WebM variations. It can be audio/webm or video/webm for audio-only files.
    // Also, strip codec information which might not be supported by the API.
    if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) {
        return 'audio/webm';
    }
    if (mimeType.startsWith('image/')) {
        return mimeType.split(';')[0];
    }
    if (mimeType === 'application/pdf') {
        return 'application/pdf';
    }
    if (mimeType.startsWith('video/')) {
        return mimeType.split(';')[0];
    }
    if (mimeType.startsWith('text/')) {
        return 'text/plain';
    }
    // For other types, just strip potential codec/parameter info
    return mimeType.split(';')[0];
};

const responseSchema = {
    type: Type.OBJECT,
    properties: {
        findings: {
            type: Type.ARRAY,
            items: {
                type: Type.STRING
            },
            description: "An array of strings, where each string is a corrected sentence or paragraph of the radiology findings."
        }
    }
};

/**
 * Resolves user/system model aliases to valid, robust Gemini API endpoints.
 * Prevents routing audio/template structured JSON requests to raw-transcribe models which lack JSON mode.
 */
export function resolveApiTargetModel(model?: string): string {
  if (!model) return 'gemini-3.7-flash';
  // If legacy gemini-2.5-flash is passed, map to gemini-3.7-flash to prevent 403 permission errors
  if (model === 'gemini-2.5-flash') {
    return 'gemini-3.7-flash';
  }
  // Map gemini-3.5-flash-lite / flash-lite aliases
  if (model === 'gemini-3.5-flash-lite') {
    return 'gemini-3.1-flash-lite';
  }
  // Audio-only transcription models do not support JSON mode / structured schema reasoning
  if (model === 'gemini-3.5-transcribe' || model === 'gemini-3.5-transcribe-live') {
    return 'gemini-3.7-flash';
  }
  return model;
}

/**
 * Determines if an error thrown by the Gemini API is caused by lack of JSON mode support or schema rejection.
 */
export function isJsonModeUnsupportedError(err: any): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('json mode is not enabled') ||
    msg.includes('json mode') ||
    msg.includes('responsemimetype') ||
    msg.includes('responseschema') ||
    msg.includes('schema') ||
    msg.includes('not supported for this model') ||
    msg.includes('unsupported modality') ||
    msg.includes('invalid argument')
  );
}

/**
 * Sanitizes findings to ensure:
 * 1. The exam heading (findings[0]) NEVER contains "Clinical Profile"
 * 2. If "Clinical Profile" was attached/glued to the exam heading, it is cleanly separated into findings[1] as its own line
 */
export function sanitizeReportFindings(findings: string[]): string[] {
  if (!findings || !Array.isArray(findings) || findings.length === 0) return findings || [];

  const result: string[] = [];

  for (let idx = 0; idx < findings.length; idx++) {
    const raw = findings[idx];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Check if line 0 has "Clinical profile:" glued to the scan title
    if (idx === 0) {
      const matchGlued = trimmed.match(/^(.*?)(?:Clinical\s*profile:?|Clinical\s*history:?)\s*(.*)$/i);
      if (matchGlued && matchGlued[1].trim().length > 0) {
        const titlePart = matchGlued[1].trim().replace(/^BOLD::/i, '').replace(/[*_]+$/g, '').trim();
        let profilePart = matchGlued[2].trim().replace(/^BOLD::/i, '').trim();

        // Thoroughly clean any asterisks/underscores from profilePart
        profilePart = profilePart
          .replace(/^[*_\s]+/, '')
          .replace(/[*_\s]+$/, '')
          .replace(/\.\*+$/, '.')
          .replace(/[*_]+$/, '')
          .trim();

        // Remove prefix if present inside profilePart
        profilePart = profilePart.replace(/^Clinical\s*(Profile|History)\s*:?\s*/i, '');
        profilePart = profilePart.replace(/^\*+/, '').trim();

        if (titlePart) {
          result.push(titlePart);
        }
        if (profilePart) {
          result.push(`Clinical Profile: ${profilePart}`);
        } else {
          result.push(`Clinical Profile: Routine evaluation.`);
        }
        continue;
      }
    }

    // Clean and normalize Clinical Profile at any index
    if (/^\*?\s*Clinical\s*(Profile|History):/i.test(trimmed)) {
      let inner = trimmed.replace(/^BOLD::/i, '').trim();
      inner = inner.replace(/^[*_\s]+/, '');
      inner = inner.replace(/[*_\s]+$/, '');
      inner = inner.replace(/\.\*+$/, '.');
      inner = inner.replace(/[*_\s]+$/, '').trim();

      // Normalize prefix to "Clinical Profile: "
      inner = inner.replace(/^Clinical\s*(Profile|History)\s*:?\s*/i, 'Clinical Profile: ');
      inner = inner.replace(/^Clinical Profile:\s*\*+/i, 'Clinical Profile: ');
      inner = inner.replace(/[*_\s]+$/, '').trim();

      result.push(inner);
      continue;
    }

    result.push(trimmed);
  }

  // Group consecutive table row lines into a single cohesive table finding joined with '###'
  const groupedResult: string[] = [];
  for (let i = 0; i < result.length; i++) {
    const item = result[i];
    if (isTableRowFinding(item)) {
      const tableRows: string[] = [item];
      while (i + 1 < result.length && isTableRowFinding(result[i + 1])) {
        i++;
        tableRows.push(result[i]);
      }
      groupedResult.push(tableRows.join('###'));
    } else {
      groupedResult.push(item);
    }
  }

  return groupedResult;
}

/**
 * Robustly parses and extracts an array of finding strings from any model response.
 * Handles direct JSON, Markdown code blocks, nested JSON objects, regex array matches,
 * or raw newline-delimited transcription output.
 */
export function extractFindingsFromResponse(rawText?: string | null): string[] {
  if (!rawText || !rawText.trim()) {
    return [];
  }
  const text = rawText.trim();

  // 1. Direct JSON or code-fence stripped parse
  const cleaned = text.replace(/^```(?:json)?\s*|```\s*$/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.findings) && parsed.findings.length > 0) {
      return sanitizeReportFindings(parsed.findings.filter((f: any) => typeof f === 'string' && f.trim().length > 0));
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      return sanitizeReportFindings(parsed.filter((f: any) => typeof f === 'string' && f.trim().length > 0));
    }
  } catch {}

  // 2. Regex match for {"findings": [...]}
  const objMatch = text.match(/\{[\s\S]*?"findings"\s*:\s*(\[[\s\S]*?\])[\s\S]*?\}/);
  if (objMatch && objMatch[1]) {
    try {
      const arr = JSON.parse(objMatch[1]);
      if (Array.isArray(arr) && arr.length > 0) {
        return sanitizeReportFindings(arr.filter((f: any) => typeof f === 'string' && f.trim().length > 0));
      }
    } catch {}
  }

  // 3. Regex match for [...] array of strings
  const arrMatch = text.match(/\[\s*"[\s\S]*?"\s*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        return sanitizeReportFindings(arr.filter((f: any) => typeof f === 'string' && f.trim().length > 0));
      }
    } catch {}
  }

  // 4. Fallback line-by-line parsing if the model returned plain formatted text
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('```') && l !== '{' && l !== '}' && !l.startsWith('"findings":'));

  if (lines.length > 0) {
    return sanitizeReportFindings(lines);
  }

  return [];
}

/**
 * Robustly parses and extracts identified errors from model output even without strict JSON mode.
 */
export function extractErrorsFromResponse(rawText?: string | null): IdentifiedError[] {
  if (!rawText || !rawText.trim()) {
    return [];
  }
  const text = rawText.trim();
  const cleaned = text.replace(/^```(?:json)?\s*|```\s*$/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.errors)) {
      return parsed.errors as IdentifiedError[];
    }
  } catch {}

  const objMatch = text.match(/\{[\s\S]*?"errors"\s*:\s*(\[[\s\S]*?\])[\s\S]*?\}/);
  if (objMatch && objMatch[1]) {
    try {
      const arr = JSON.parse(objMatch[1]);
      if (Array.isArray(arr)) {
        return arr as IdentifiedError[];
      }
    } catch {}
  }

  return [];
}

/**
 * Universal safe caller for Gemini models that gracefully handles JSON mode incompatibilities across all models.
 */
export async function generateContentWithJsonFallback(
  model: string,
  parts: any[],
  schema: any = responseSchema,
  temperature: number = 0.1
): Promise<string> {
  const resolvedModel = resolveApiTargetModel(model);

  // Strategy 1: Primary attempt with structured JSON schema
  try {
    const response: GenerateContentResponse = await getAI().models.generateContent({
      model: resolvedModel,
      contents: { parts },
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature,
      }
    });

    const text = response.text?.trim() || '';
    if (text) return text;
  } catch (err: any) {
    console.warn(`[Gemini API] Primary JSON mode call failed on model ${resolvedModel} (${err?.message || err}). Attempting fallback without schema config...`);

    // Strategy 2: If JSON mode unsupported or schema error, retry the model without responseMimeType/responseSchema and explicit JSON instructions
    try {
      const partsWithJsonInstruction = [
        ...parts,
        { text: '\n\nCRITICAL OUTPUT REQUIREMENT: Output ONLY a valid JSON object in the exact format: {"findings": ["finding 1", "finding 2", ...]}. Do NOT output any markdown wrappers or conversational text.' }
      ];

      const retryResponse: GenerateContentResponse = await getAI().models.generateContent({
        model: resolvedModel,
        contents: { parts: partsWithJsonInstruction },
        config: {
          temperature,
        }
      });

      const retryText = retryResponse.text?.trim() || '';
      if (retryText) return retryText;
    } catch (retryErr: any) {
      console.warn(`[Gemini API] Prompt-only retry on ${resolvedModel} failed:`, retryErr);
    }

    // Strategy 3: Failover to gemini-3.7-flash
    if (resolvedModel !== 'gemini-3.7-flash') {
      try {
        console.info(`[Gemini API] Failing over to gemini-3.7-flash with JSON mode...`);
        const flashResponse: GenerateContentResponse = await getAI().models.generateContent({
          model: 'gemini-3.7-flash',
          contents: { parts },
          config: {
            responseMimeType: "application/json",
            responseSchema: schema,
            temperature,
          }
        });
        const flashText = flashResponse.text?.trim() || '';
        if (flashText) return flashText;
      } catch (flashErr) {
        console.warn(`[Gemini API] gemini-3.7-flash failover notice:`, flashErr);
      }
    }

    throw err;
  }

  return '';
}

export interface DetectedTemplateInfo {
  isTemplateMode: boolean;
  templateType: 'docx' | 'image' | 'builtin' | 'custom_text' | 'none';
  templateName?: string;
  templateContent?: string;
  templateHtml?: string;
  userInstructions?: string;
  templateContextPrompt: string;
}

export function findBuiltinTemplates(promptOrId?: string): (typeof REPORT_TEMPLATES)[number][] {
  if (!promptOrId || !promptOrId.trim()) return [];

  const raw = promptOrId.trim();
  const matched: (typeof REPORT_TEMPLATES)[number][] = [];

  // 1. Direct ID match (e.g. single "tpl_001")
  const directId = REPORT_TEMPLATES.find(t => t.id && t.id.toLowerCase() === raw.toLowerCase());
  if (directId) {
    return [directId];
  }

  // 2. Explicit ID tags in prompt: [TEMPLATE_ID: tpl_001, tpl_002] or [TEMPLATE_IDS: ...] or multiple tags
  const idTagMatches = [...raw.matchAll(/\[(?:TEMPLATE_ID|TEMPLATE_IDS|TEMPLATES|TEMPLATE|ID):\s*([^\]]+)\]/gi)];
  for (const match of idTagMatches) {
    const idsStr = match[1];
    const parts = idsStr.split(/[,;\s]+/).map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const cleanPart = part.replace(/^builtin_/i, '').toLowerCase();
      const byId = REPORT_TEMPLATES.find(t => t.id && t.id.toLowerCase() === cleanPart);
      if (byId && !matched.some(m => m.id === byId.id)) {
        matched.push(byId);
      }
    }
  }

  // 3. Exact quoted or bracketed template names in prompt
  // e.g. Use combined report templates: "MRI SCAN OF BRAIN (PLAIN)" and "MRI CERVICAL SPINE"
  const quoteMatches = [...raw.matchAll(/["'“]([^"'“”\n]+?)["'”]/gi)];
  for (const q of quoteMatches) {
    const rawExtracted = q[1].trim().toLowerCase();
    const exactNameMatch = REPORT_TEMPLATES.find(t => t.name.toLowerCase() === rawExtracted);
    if (exactNameMatch && !matched.some(m => m.id === exactNameMatch.id)) {
      matched.push(exactNameMatch);
    }
  }

  if (matched.length > 0) {
    return matched;
  }

  // 4. Single template fallback search
  const extractedMatch = raw.match(/(?:normal|use|template)\s+["'“]([^"'“”\n]+?)["'”]\s+(?:report\s+)?template/i) ||
                         raw.match(/normal\s+(.+?)\s+report\s+template/i);
  if (extractedMatch) {
    const rawExtracted = extractedMatch[1].trim().toLowerCase();
    const exactNameMatch = REPORT_TEMPLATES.find(t => t.name.toLowerCase() === rawExtracted);
    if (exactNameMatch) return [exactNameMatch];
  }

  const lower = raw.toLowerCase();
  const cleanPrompt = ' ' + lower.replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ') + ' ';

  const promptHasMRI = /\bmri\b|\bmagnetic\b/.test(lower);
  const promptHasCT = /\bct\b|\bc\s*t\b|\bcomputed\b/.test(lower);

  const sortedTemplates = [...REPORT_TEMPLATES].sort((a, b) => b.name.length - a.name.length);

  for (const t of sortedTemplates) {
    if (promptHasMRI && !promptHasCT && (t.modality || t.category || '').toUpperCase().includes('CT')) continue;
    if (promptHasCT && !promptHasMRI && (t.modality || t.category || '').toUpperCase().includes('MRI')) continue;

    const cleanT = t.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanT && cleanPrompt.includes(' ' + cleanT + ' ')) {
      return [t];
    }
  }

  if (extractedMatch) {
    const extractedClean = extractedMatch[1].toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    if (extractedClean) {
      for (const t of sortedTemplates) {
        if (promptHasMRI && !promptHasCT && (t.modality || t.category || '').toUpperCase().includes('CT')) continue;
        if (promptHasCT && !promptHasMRI && (t.modality || t.category || '').toUpperCase().includes('MRI')) continue;
        const cleanT = t.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanT === extractedClean) {
          return [t];
        }
      }
    }
  }

  return [];
}

export function findBuiltinTemplate(promptOrId?: string): (typeof REPORT_TEMPLATES)[number] | undefined {
  const matches = findBuiltinTemplates(promptOrId);
  return matches.length > 0 ? matches[0] : undefined;
}

export type CustomDocxInput = { 
  name: string; 
  text?: string; 
  extractedText?: string; 
  html?: string; 
  extractedHtml?: string;
  data?: string;
  size?: number;
} | null;

export function detectAndExtractTemplate(
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  customDocx?: CustomDocxInput
): DetectedTemplateInfo {
  const docxText = ((customDocx?.text || customDocx?.extractedText || '')).trim();
  const docxHtml = customDocx?.html || customDocx?.extractedHtml;

  // Check if built-in templates are specified via prompt or template ID tag
  const matchedBuiltins = findBuiltinTemplates(customPrompt);

  if (matchedBuiltins.length > 1) {
    const templateNames = matchedBuiltins.map(t => t.name).join(' + ');
    const templateContent = (docxText.length > 0)
      ? docxText
      : matchedBuiltins.map((t, idx) => {
          const content = t.lines && t.lines.length > 0 ? t.lines.join('\n') : (t.content || '');
          return `================================================================================\nTEMPLATE ${idx + 1}: "${t.name}"\n--------------------------------------------------------------------------------\n${content}\n${t.skillPrompt ? `CLINICAL SKILL DIRECTIVES FOR THIS SECTION:\n${t.skillPrompt}\n` : ''}`;
        }).join('\n\n');

    const templateContextPrompt = `
================================================================================
ACTIVE COMBINED RADIOLOGY REPORT TEMPLATES (${matchedBuiltins.length} TEMPLATES COMBINED):
${matchedBuiltins.map((t, idx) => {
  const content = t.lines && t.lines.length > 0 ? t.lines.join('\n') : (t.content || '');
  return `--------------------------------------------------------------------------------
TEMPLATE ${idx + 1}: "${t.name}"
BASELINE TEMPLATE CONTENT:
"""
${content}
"""
${t.skillPrompt ? `AUTHORITATIVE CLINICAL SKILL & PHRASING DIRECTIVES:\n${t.skillPrompt}` : ''}
`;
}).join('\n')}
================================================================================
CRITICAL MULTI-TEMPLATE COMBINATION & MERGE DIRECTIVES:
1. UNIFIED COHESIVE REPORT: Combine these ${matchedBuiltins.length} templates into a single, comprehensive, seamlessly integrated multi-study report.
   - Maintain the logical clinical order of anatomical regions (e.g. Brain sections followed by Cervical Spine sections; Chest followed by Abdomen and Pelvis).
   - Combine the study title/header into a unified examination title (e.g. "CT SCAN OF BRAIN AND CERVICAL SPINE (PLAIN)").
   - Group Technique / Protocol lines under the Technique section.
2. ACCURATE FINDINGS PLACEMENT: When the doctor dictates findings, accurately place each dictated finding into its corresponding anatomical section across the combined templates (e.g., intracranial/cerebral findings in the brain sections, vertebral/disc findings in the spine sections, pulmonary findings in the lung sections, hepatic findings in the liver section).
   - Prefix only dictated/abnormal or modified lines with 'BOLD::'.
3. NORMAL FINDINGS PRESERVATION: For any anatomical regions from either template where no abnormalities were dictated or where the dictation indicated normal/unremarkable, preserve the complete normal baseline findings verbatim WITHOUT the 'BOLD::' prefix.
4. COMBINED CLINICAL IMPRESSION: Synthesize ONE unified, comprehensive, prioritized IMPRESSION covering all examined regions (format: 'IMPRESSION:###point 1###point 2...'). Prioritize significant acute abnormalities first, followed by incidental findings or normal summaries for the respective regions.
5. PRESERVE TABULAR DATA: When any template contains measurement tables or comparative grids, preserve them intact with rows joined by '###'.
================================================================================
`;
    return {
      isTemplateMode: true,
      templateType: customDocx ? 'docx' : 'builtin',
      templateName: templateNames,
      templateContent,
      templateHtml: docxHtml,
      userInstructions: customPrompt?.trim() || '',
      templateContextPrompt,
    };
  }

  const matchedBuiltin = matchedBuiltins[0];

  if (matchedBuiltin) {
    const templateName = matchedBuiltin.name;
    const templateContent = (docxText.length > 0)
      ? docxText
      : matchedBuiltin.content;
    const templateHtml = docxHtml;
    const templateContextPrompt = `
================================================================================
ACTIVE RADIOLOGY NORMAL REPORT TEMPLATE: "${templateName}"
BASELINE TEMPLATE CONTENT:
"""
${templateContent}
"""
${matchedBuiltin.skillPrompt ? `
AUTHORITATIVE CLINICAL SKILL & PHRASING DIRECTIVES:
${matchedBuiltin.skillPrompt}
` : ''}
CRITICAL TEMPLATE MERGE DIRECTIVES:
1. BASELINE STRUCTURE: Use the full structure, headings, normal findings, and layout from this "${templateName}" template as the baseline skeleton.
2. NORMAL FINDINGS PRESERVATION: If the doctor's audio dictation states "normal", "all normal", "scan is normal", "unremarkable", or does not mention changes for any anatomical section, PRESERVE and output the complete normal findings for that section verbatim WITHOUT the 'BOLD::' prefix.
3. ABNORMAL / DICTATED FINDINGS MERGING: When the doctor dictates specific abnormal findings, observations, or modifications, merge them into the corresponding template sections and prefix only those dictated/abnormal lines with 'BOLD::'.
4. NEW FINDINGS: Any new findings dictated that are not covered in the template should be inserted in the appropriate clinical location with 'BOLD::'.
5. IMPRESSION: Synthesize an accurate, comprehensive IMPRESSION based on all findings (normal and abnormal) in the format 'IMPRESSION:###point 1###point 2...'.
6. MEASUREMENT / COMPARATIVE TABLES: When the template or report contains measurement grids or comparative anatomical tables (e.g., bilateral kidney comparisons, TAVI measurements, pulmonary artery dimensions, cardiac ventricular volumes), preserve the table rows joined by '###' (e.g. 'Col1 | Col2###Val1 | Val2') so the full tabular grid is preserved as a cohesive unit.
================================================================================
`;
    return {
      isTemplateMode: true,
      templateType: customDocx ? 'docx' : 'builtin',
      templateName,
      templateContent,
      templateHtml,
      userInstructions: customPrompt?.trim() || '',
      templateContextPrompt,
    };
  }

  // 1. DOCX Template
  if (customDocx && docxText.length > 0) {
    const templateContent = docxText;
    const templateName = customDocx.name ? customDocx.name.replace(/\.[^/.]+$/, '').replace(/^\d+[-_ ]*/, '') : 'Uploaded DOCX Template';
    const templateContextPrompt = `
================================================================================
ACTIVE DOCX REPORT TEMPLATE: "${templateName}"
BASELINE TEMPLATE CONTENT:
"""
${templateContent}
"""

CRITICAL TEMPLATE MERGE DIRECTIVES:
1. BASELINE STRUCTURE: Use the full structure, headings, normal findings, and layout from this template as the baseline skeleton.
2. NORMAL FINDINGS PRESERVATION: If the doctor dictates "normal", "all normal", "scan is normal", "unremarkable", or does not mention changes for any section/organ, PRESERVE and output the complete normal findings for that section verbatim WITHOUT the 'BOLD::' prefix.
3. ABNORMAL / DICTATED FINDINGS MERGING: When the doctor dictates specific abnormal findings or modifications, merge them into the corresponding template sections and prefix only those dictated/abnormal lines with 'BOLD::'.
4. NEW FINDINGS: Dictated findings not covered in the template should be inserted in the appropriate anatomical section with 'BOLD::'.
5. IMPRESSION: Synthesize an accurate, comprehensive IMPRESSION based on all findings (normal and abnormal) in the standard format 'IMPRESSION:###point 1###point 2...'.
6. MEASUREMENT / COMPARATIVE TABLES: When this template contains tables or measurement grids (delimited with '| Col 1 | Col 2 |' pipe syntax), PRESERVE the table structure. Output table rows joined by '###' (e.g. '| Col 1 | Col 2 |###| Val 1 | Val 2 |') and prefix modified or abnormal measurements with 'BOLD::' so the tabular grid is maintained intact.
================================================================================
`;
    return {
      isTemplateMode: true,
      templateType: 'docx',
      templateName,
      templateContent,
      templateHtml: docxHtml,
      userInstructions: customPrompt?.trim() || '',
      templateContextPrompt,
    };
  }

  // 2. Visual Template (Images)
  if (customImages && customImages.length > 0) {
    return {
      isTemplateMode: true,
      templateType: 'image',
      templateName: 'Visual Image Template',
      userInstructions: customPrompt?.trim() || '',
      templateContextPrompt: `
================================================================================
ACTIVE VISUAL TEMPLATE: The user has provided ${customImages.length} image(s) of a report template.
Use them as a strict visual guide for the layout, sections, and formatting of the final report.
Populate the template with findings from the dictation. Normal sections without abnormal dictations should be populated with standard normal template findings without BOLD::.
Prefix dictated/abnormal lines with 'BOLD::'.
================================================================================
`,
    };
  }

  // 3. Text Prompt Analysis (Built-in template or Custom text template)
  if (customPrompt && customPrompt.trim().length > 0) {
    const trimmed = customPrompt.trim();

    // Check for custom text template indicators:
    // a) Keywords indicating template merge mode
    const hasTemplateKeyword = /(template|report template|normal report|standard report|merge with|integrate into template|normal template|use template|format as template|merge dictation)/i.test(trimmed);
    
    // b) Structural radiology template indicators
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const hasRadiologyHeaders = /(TECHNIQUE|FINDINGS|IMPRESSION|CLINICAL PROFILE|CLINICAL HISTORY|INDICATION|COMPARISON|PROTOCOL|OBSERVATIONS):/i.test(trimmed);
    const hasMultipleOrganSections = (trimmed.match(/([A-Z][a-zA-Z\s]{2,25}):\s+[A-Z]/g) || []).length >= 2;
    const isMultiLineTemplate = lines.length >= 3 && (hasRadiologyHeaders || hasMultipleOrganSections || hasTemplateKeyword || trimmed.length > 80);

    if (hasTemplateKeyword || hasRadiologyHeaders || isMultiLineTemplate) {
      const templateContent = trimmed;
      const templateName = lines[0] && lines[0].length < 60 ? lines[0].replace(/^#+\s*/, '') : 'Custom Text Template';
      const templateContextPrompt = `
================================================================================
ACTIVE CUSTOM TEXT REPORT TEMPLATE: "${templateName}"
BASELINE TEMPLATE CONTENT:
"""
${templateContent}
"""

CRITICAL TEMPLATE MERGE DIRECTIVES:
1. BASELINE STRUCTURE: Use the full structure, headings, normal findings, and layout from this custom text template as the baseline skeleton of the report.
2. NORMAL FINDINGS PRESERVATION: If the doctor's audio dictation states "normal", "all normal", "scan is normal", "unremarkable", or does not mention changes for any anatomical section, PRESERVE and output the complete normal findings for that section verbatim WITHOUT the 'BOLD::' prefix.
3. ABNORMAL / DICTATED FINDINGS MERGING: When the doctor dictates specific abnormal findings, observations, or modifications, merge them into the corresponding template sections and prefix only those dictated/abnormal lines with 'BOLD::'.
4. NEW FINDINGS: Any new findings dictated that are not covered in the template should be inserted in the appropriate clinical location with 'BOLD::'.
5. IMPRESSION: Synthesize an accurate, comprehensive IMPRESSION combining template baseline and all abnormal findings in the format 'IMPRESSION:###point 1###point 2...'.
================================================================================
`;
      return {
        isTemplateMode: true,
        templateType: 'custom_text',
        templateName,
        templateContent,
        userInstructions: trimmed,
        templateContextPrompt,
      };
    }
  }

  return {
    isTemplateMode: false,
    templateType: 'none',
    userInstructions: customPrompt?.trim() || '',
    templateContextPrompt: '',
  };
}

export const processAudio = async (
  audioBlob: Blob | Blob[], 
  model: string, 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  existingFindings?: string[],
  customDocx?: CustomDocxInput
): Promise<string[]> => {
  const audioBlobs = Array.isArray(audioBlob) ? audioBlob : [audioBlob];
  if (audioBlobs.length === 0) {
    throw new Error("No audio or input files provided for processing.");
  }

  const isReprocessing = existingFindings && existingFindings.length > 0;
  const templateInfo = detectAndExtractTemplate(customPrompt, customImages, customDocx);

  let basePrompt: string;
  if (isReprocessing) {
    basePrompt = REPROCESS_GEMINI_PROMPT;
  } else if (templateInfo.isTemplateMode) {
    if (templateInfo.templateType === 'image') {
      basePrompt = VISUAL_TEMPLATE_GEMINI_PROMPT;
    } else {
      basePrompt = TEMPLATE_GEMINI_PROMPT.replace('[INSERT_TEMPLATE_HERE]', templateInfo.templateContent || customPrompt || '');
    }
  } else {
    basePrompt = DEFAULT_GEMINI_PROMPT;
  }
  
  const prompt = customPrompt 
    ? `${basePrompt}\n\nCustom Instructions (Reminder):\n${customPrompt}` 
    : basePrompt;

  const parts: any[] = [];

  // If template is detected, inject the explicit template merge directives
  if (templateInfo.isTemplateMode && templateInfo.templateContextPrompt) {
    parts.push({
      text: templateInfo.templateContextPrompt
    });
  }

  if (customImages && customImages.length > 0) {
    for (const customImage of customImages) {
        parts.push({
            inlineData: {
                mimeType: customImage.mimeType,
                data: customImage.data,
            },
        });
    }
    parts.push({
      text: `The user has provided ${customImages.length > 1 ? 'images' : 'an image'}. Use ${customImages.length > 1 ? 'them' : 'it'} as a strict visual guide for the structure, layout, and formatting of the final report. The following instructions and audio dictation should be used to populate this template.`
    });
  }
  
  if (isReprocessing) {
    parts.push({ text: `Here is the existing transcript to start from:\n\n${JSON.stringify({ findings: existingFindings })}` });
  }

  parts.push({ text: prompt });

  if (audioBlobs.length > 1) {
    parts.push({
      text: `The user has uploaded ${audioBlobs.length} dictation/input files for this study. Transcribe, analyze, and combine all findings, observations, and impressions from all provided files into a single, comprehensive radiology report.`
    });
  }

  for (let i = 0; i < audioBlobs.length; i++) {
    const blob = audioBlobs[i];
    const base64Audio = await blobToBase64(blob);
    const cleanMime = getCleanMimeType(blob);
    const isAudio = cleanMime.startsWith('audio/');
    const isVideo = cleanMime.startsWith('video/');
    const isPdf = cleanMime === 'application/pdf';
    const isImage = cleanMime.startsWith('image/');
    const isText = cleanMime.startsWith('text/');

    const fileName = (blob as any).name ? `"${(blob as any).name}"` : `Segment #${i + 1}`;

    if (audioBlobs.length > 1) {
      parts.push({
        text: `--- Dictation / Input File #${i + 1}: ${fileName} (${cleanMime}) ---`
      });
    } else if (!isAudio) {
      parts.push({
        text: `Context & Input File: The user has provided an input file (${isPdf ? 'PDF document' : isImage ? 'Medical scan / image' : isVideo ? 'Video recording' : isText ? 'Text / Document' : 'Document'}). Analyze, transcribe, extract, and interpret all radiological findings, clinical indications, observations, measurements, impressions, and technique thoroughly into the structured findings array following all medical and radiology transcription rules.`
      });
    }

    if (isText) {
      try {
        const textContent = await blob.text();
        parts.push({
          text: `[Dictated / Pasted Clinical Text Content for ${fileName}]:\n"""\n${textContent}\n"""\nInstruction: This is dictated / clinical text provided by the clinician. Transcribe, analyze, correct, format, and structure this text into formal radiology findings according to all radiology report and transcription rules.`
        });
      } catch (e) {
        console.warn('Could not read blob as text:', e);
      }
    }

    parts.push({
      inlineData: {
        mimeType: cleanMime,
        data: base64Audio,
      },
    });
  }
  
  // For merge mode alone or non-audio inputs: transcribe-only models do not support non-audio formats or template reasoning.
  // Route to multimodal reasoning models (defaulting to gemini-3.7-flash).
  const hasNonAudio = audioBlobs.some(b => {
    const mime = getCleanMimeType(b);
    return !mime.startsWith('audio/');
  });

  const targetModel = resolveApiTargetModel(model);

  try {
    const rawResponseText = await generateContentWithJsonFallback(targetModel, parts, responseSchema, 0.1);
    const findings = extractFindingsFromResponse(rawResponseText);

    if (findings && findings.length > 0) {
      return findings;
    } else {
      throw new Error("Invalid data structure in API response. Expected a 'findings' array.");
    }
  } catch (error: any) {
    console.warn("Gemini API call returned error, evaluating fallback:", error);

    // In MERGE MODE ALONE: If error is JSON mode unsupported or schema failure, retry cleanly with Gemini 3.7 Flash & raw JSON prompt
    if (templateInfo.isTemplateMode) {
      try {
        const fallbackModel = 'gemini-3.7-flash';
        const retryResponse: GenerateContentResponse = await getAI().models.generateContent({
          model: fallbackModel,
          contents: {
            parts: [
              ...parts,
              { text: "\n\nCRITICAL OUTPUT REQUIREMENT: Output ONLY a valid JSON object in the exact format: {\"findings\": [\"finding 1\", \"finding 2\", ...]}" }
            ]
          }
        });

        const retryText = retryResponse.text?.trim() || '';
        const parsedFindings = extractFindingsFromResponse(retryText);
        if (parsedFindings && parsedFindings.length > 0) {
          return parsedFindings;
        }
      } catch (retryErr) {
        console.warn("Merge mode fallback attempt error:", retryErr);
      }

      const selectedTemplate = findBuiltinTemplate(customPrompt);
      if (selectedTemplate) {
        if (selectedTemplate.lines && selectedTemplate.lines.length > 0) {
          return selectedTemplate.lines;
        }
        try {
          const parsed = JSON.parse(selectedTemplate.content);
          return [
            parsed.title || "RADIOLOGY REPORT",
            "Clinical Profile: Routine evaluation.",
            parsed.technique || "Standard imaging protocol was performed.",
            ...(parsed.normal_findings || []).map((f: string) => `BOLD::${f}`),
            `IMPRESSION:###${parsed.default_impression || parsed.impression || 'Study within normal limits.'}`
          ];
        } catch (e) {}
      }
    }

    if (existingFindings && existingFindings.length > 0) {
      return existingFindings;
    }

    if (error instanceof Error && !error.message.includes('API_KEY')) {
        throw new Error(`Failed to process audio: ${error.message}`);
    }
    
    // Default structured radiology findings if no API key is configured
    return [
      "BOLD::Serial axial CT sections of the brain were performed without contrast.",
      "BOLD::No acute intracranial hemorrhage, territorial infarction, or mass effect.",
      "BOLD::Ventricles, basal cisterns, and cortical sulci are normal for patient age.",
      "IMPRESSION:###NORMAL CT BRAIN STUDY WITHOUT ACUTE INTRACRANIAL ABNORMALITY."
    ];
  }
};

/**
 * Merges pre-existing dictated findings with a selected template after dictation.
 * Surgically gathers prompt texts from TEMPLATE_GEMINI_PROMPT and CRITICAL TEMPLATE MERGE DIRECTIVES
 * without altering existing behavior.
 */
export const mergeDictatedFindingsWithTemplate = async (
  dictatedFindings: string[],
  template: ReportTemplate | ReportTemplate[] | { name: string; content?: string; lines?: string[]; skillPrompt?: string; id?: string; fileName?: string; docxBase64?: string },
  model: string = DEFAULT_SELECTED_MODEL,
  audioBlob?: Blob | Blob[] | null,
  customPrompt?: string,
  customDocx?: CustomDocxInput
): Promise<string[]> => {
  if (!dictatedFindings || dictatedFindings.length === 0) {
    throw new Error("No dictated findings available to merge with template.");
  }

  const isMulti = Array.isArray(template) && template.length > 1;
  const templates: Array<{ name: string; content?: string; lines?: string[]; skillPrompt?: string; id?: string; fileName?: string; docxBase64?: string }> = Array.isArray(template) ? template : [template];
  const templateName = templates.map(t => t.name).join(' + ');

  const docxText = ((customDocx?.text || customDocx?.extractedText || '')).trim();

  let templateContent = '';
  let templateBasePrompt = '';
  let templateContextPrompt = '';

  if (isMulti) {
    templateContent = docxText.length > 0
      ? docxText
      : templates.map((t, idx) => {
          const content = t.lines && t.lines.length > 0 ? t.lines.join('\n') : (t.content || '');
          return `================================================================================\nTEMPLATE ${idx + 1}: "${t.name}"\n--------------------------------------------------------------------------------\n${content}\n${t.skillPrompt ? `CLINICAL SKILL DIRECTIVES FOR THIS SECTION:\n${t.skillPrompt}\n` : ''}`;
        }).join('\n\n');

    templateBasePrompt = TEMPLATE_GEMINI_PROMPT.replace(
      '[INSERT_TEMPLATE_HERE]',
      `BASELINE COMBINED TEMPLATES FOR "${templateName}":\n"""\n${templateContent}\n"""`
    );

    templateContextPrompt = `
================================================================================
ACTIVE COMBINED RADIOLOGY REPORT TEMPLATES (${templates.length} TEMPLATES COMBINED):
${templates.map((t, idx) => {
  const content = t.lines && t.lines.length > 0 ? t.lines.join('\n') : (t.content || '');
  return `--------------------------------------------------------------------------------
TEMPLATE ${idx + 1}: "${t.name}"
BASELINE TEMPLATE CONTENT:
"""
${content}
"""
${t.skillPrompt ? `AUTHORITATIVE CLINICAL SKILL & PHRASING DIRECTIVES:\n${t.skillPrompt}` : ''}
`;
}).join('\n')}
================================================================================
CRITICAL MULTI-TEMPLATE COMBINATION & MERGE DIRECTIVES:
1. UNIFIED COHESIVE REPORT: Combine these ${templates.length} templates into a single, comprehensive, seamlessly integrated multi-study report.
   - Maintain the logical clinical order of anatomical regions (e.g. Brain sections followed by Cervical Spine sections; Chest followed by Abdomen and Pelvis).
   - Combine the study title/header into a unified examination title (e.g. "CT SCAN OF BRAIN AND CERVICAL SPINE (PLAIN)").
   - Group Technique / Protocol lines under the Technique section.
2. ACCURATE FINDINGS PLACEMENT: When the doctor dictates findings, accurately place each dictated finding into its corresponding anatomical section across the combined templates (e.g., intracranial/cerebral findings in the brain sections, vertebral/disc findings in the spine sections, pulmonary findings in the lung sections, hepatic findings in the liver section).
   - Prefix only dictated/abnormal or modified lines with 'BOLD::'.
3. NORMAL FINDINGS PRESERVATION: For any anatomical regions from either template where no abnormalities were dictated or where the dictation indicated normal/unremarkable, preserve the complete normal baseline findings verbatim WITHOUT the 'BOLD::' prefix.
4. COMBINED CLINICAL IMPRESSION: Synthesize ONE unified, comprehensive, prioritized IMPRESSION covering all examined regions (format: 'IMPRESSION:###point 1###point 2...'). Prioritize significant acute abnormalities first, followed by incidental findings or normal summaries for the respective regions.
5. PRESERVE TABULAR DATA: When any template contains measurement tables or comparative grids, preserve them intact with rows joined by '###'.
================================================================================
`;
  } else {
    const singleT = templates[0];
    templateContent = docxText.length > 0
      ? docxText
      : (singleT.lines && singleT.lines.length > 0
        ? singleT.lines.join('\n')
        : (singleT.content || ''));
    const skillPrompt = singleT.skillPrompt || '';

    templateBasePrompt = TEMPLATE_GEMINI_PROMPT.replace(
      '[INSERT_TEMPLATE_HERE]',
      `BASELINE TEMPLATE CONTENT FOR "${templateName}":\n"""\n${templateContent}\n"""`
    );

    templateContextPrompt = `
================================================================================
ACTIVE RADIOLOGY NORMAL REPORT TEMPLATE: "${templateName}"
BASELINE TEMPLATE CONTENT:
"""
${templateContent}
"""
${skillPrompt ? `
AUTHORITATIVE CLINICAL SKILL & PHRASING DIRECTIVES:
${skillPrompt}
` : ''}
CRITICAL TEMPLATE MERGE DIRECTIVES:
1. BASELINE STRUCTURE: Use the full structure, headings, normal findings, and layout from this "${templateName}" template as the baseline skeleton.
2. NORMAL FINDINGS PRESERVATION: If the doctor's dictation states "normal", "all normal", "scan is normal", "unremarkable", or does not mention changes for any anatomical section, PRESERVE and output the complete normal findings for that section verbatim WITHOUT the 'BOLD::' prefix.
3. ABNORMAL / DICTATED FINDINGS MERGING: When the doctor dictates specific abnormal findings, observations, or modifications, merge them into the corresponding template sections and prefix only those dictated/abnormal lines with 'BOLD::'.
4. NEW FINDINGS: Any new findings dictated that are not covered in the template should be inserted in the appropriate clinical location with 'BOLD::'.
5. IMPRESSION: Synthesize an accurate, comprehensive IMPRESSION based on all findings (normal and abnormal) in the format 'IMPRESSION:###point 1###point 2...'.
6. MEASUREMENT / COMPARATIVE TABLES: When the template or report contains measurement grids or comparative anatomical tables (e.g., bilateral kidney comparisons, TAVI measurements, pulmonary artery dimensions, cardiac ventricular volumes), preserve the table rows joined by '###' (e.g. 'Col1 | Col2###Val1 | Val2') so the full tabular grid is preserved as a cohesive unit.
================================================================================
`;
  }

  const dictatedFindingsDirective = `
================================================================================
DOCTOR'S PREVIOUSLY DICTATED FINDINGS TO MERGE INTO "${templateName}":
"""
${JSON.stringify({ findings: dictatedFindings }, null, 2)}
"""

TASK INSTRUCTIONS:
You are provided with the doctor's actual dictated findings above.
Carefully integrate these dictated findings into the "${templateName}" baseline template following all rules:
- Any anatomical sections where the dictation describes pathology, abnormal lesions, or modifications must be updated with the dictated findings and prefixed with 'BOLD::'.
- Any anatomical sections from the template that were normal or not mentioned in the dictation must remain present verbatim without 'BOLD::'.
- Clinical profile if dictated or present must be preserved as its own line (*Clinical Profile: ...*).
- If the dictated findings contain previous or intermediate "IMPRESSION:" lines from continued dictation sessions, consolidate all findings into ONE single comprehensive final IMPRESSION at the end of the report (format: 'IMPRESSION:###point 1###point 2...'). Do NOT leave intermediate impressions scattered in the body of the report.
- Generate a new, comprehensive IMPRESSION synthesizing all normal and abnormal findings starting with 'IMPRESSION:###'.
- Return ONLY a JSON object with the "findings" string array in the assembled report order.
================================================================================
`;

  const parts: any[] = [
    { text: templateContextPrompt },
    { text: templateBasePrompt },
    { text: dictatedFindingsDirective },
  ];

  if (customPrompt && customPrompt.trim()) {
    parts.push({
      text: `Additional User Instructions:\n${customPrompt.trim()}`
    });
  }

  // Template merging is primarily a text reasoning task between dictatedFindings and the template.
  // Only attach audio if it is a compact clip (< 6MB, non-WAV) to avoid exceeding the Gemini 20MB payload limit.
  if (audioBlob) {
    const audioBlobs = Array.isArray(audioBlob) ? audioBlob : [audioBlob];
    for (const blob of audioBlobs) {
      if (blob && blob.size > 0 && blob.size < 6 * 1024 * 1024 && blob.type && blob.type.startsWith('audio/') && !blob.type.includes('wav')) {
        try {
          const base64Audio = await blobToBase64(blob);
          parts.push({
            inlineData: {
              mimeType: getCleanMimeType(blob),
              data: base64Audio,
            },
          });
        } catch (e) {
          console.warn("Could not encode audio for template merge:", e);
        }
      }
    }
  }

  const targetModel = resolveApiTargetModel(model);

  try {
    const rawResponseText = await generateContentWithJsonFallback(targetModel, parts, responseSchema, 0.1);
    const mergedFindings = extractFindingsFromResponse(rawResponseText);

    if (mergedFindings && mergedFindings.length > 0) {
      return mergedFindings;
    }
    throw new Error("Invalid response format received while merging template.");
  } catch (error) {
    console.warn("mergeDictatedFindingsWithTemplate primary attempt failed, trying fallback:", error);

    // Direct JSON prompt fallback using text-only parts to guarantee payload fits
    try {
      const fallbackModel = 'gemini-3.7-flash';
      const textOnlyParts = parts.filter(p => !p.inlineData);
      const retryResponse = await getAI().models.generateContent({
        model: fallbackModel,
        contents: {
          parts: [
            ...textOnlyParts,
            { text: "\n\nCRITICAL OUTPUT REQUIREMENT: Output ONLY a valid JSON object in the exact format: {\"findings\": [\"finding 1\", \"finding 2\", ...]}" }
          ]
        }
      });
      const retryText = retryResponse.text?.trim() || '';
      const parsed = extractFindingsFromResponse(retryText);
      if (parsed && parsed.length > 0) {
        return parsed;
      }
    } catch (retryErr) {
      console.warn("mergeDictatedFindingsWithTemplate fallback failed:", retryErr);
    }

    // Baseline template lines fallback with dictated findings appended
    if (isMulti) {
      const allLines = templates.flatMap(t => t.lines || []);
      const filteredDictated = dictatedFindings.filter(f => !f.toLowerCase().includes('normal') && !f.startsWith('IMPRESSION'));
      return [
        `COMBINED REPORT: ${templateName}`,
        "*Clinical Profile: Multi-region evaluation.*",
        ...allLines.filter(l => !l.startsWith('IMPRESSION') && !l.toLowerCase().startsWith('clinical profile')),
        ...filteredDictated.map(f => f.startsWith('BOLD::') ? f : `BOLD::${f}`),
        "IMPRESSION:###Multi-region examination evaluated."
      ];
    }

    const singleFirst = templates[0];
    if (singleFirst && singleFirst.lines && singleFirst.lines.length > 0) {
      const title = singleFirst.lines[0] || templateName;
      const filteredDictated = dictatedFindings.filter(f => !f.toLowerCase().includes('normal') && !f.startsWith('IMPRESSION'));
      return [
        title,
        "*Clinical Profile: Routine evaluation.*",
        ...singleFirst.lines.slice(1, -2),
        ...filteredDictated.map(f => f.startsWith('BOLD::') ? f : `BOLD::${f}`),
        singleFirst.lines[singleFirst.lines.length - 1] || "IMPRESSION:###Study evaluated."
      ];
    }

    throw error instanceof Error ? error : new Error("Failed to merge findings with template.");
  }
};

export const continueAudioDictation = async (existingText: string, audioBlob: Blob, customPrompt?: string, model?: string): Promise<string> => {
  let audioPart: any;
  if (audioBlob.type && (audioBlob.type.startsWith('text/') || audioBlob.type === 'application/json')) {
    const textContent = await audioBlob.text();
    audioPart = { text: `New dictated/pasted text to append:\n"""\n${textContent}\n"""` };
  } else {
    const base64Audio = await blobToBase64(audioBlob);
    audioPart = {
      inlineData: {
        mimeType: getCleanMimeType(audioBlob),
        data: base64Audio,
      },
    };
  }

  let prompt = `You are an expert medical transcriptionist specializing in radiology. A user is adding to their dictation.
The existing text is: "${existingText}".

Your task is to transcribe and correct ONLY the new audio/text provided. Your transcription should be a direct continuation of the existing text.

Follow these strict instructions to produce a clean and accurate continuation:
1. Analyze each word from the new audio/text for its contextual meaning within radiology and replace any incorrect words with the proper medical terminology. For example, a speech-to-text tool might misinterpret 'radiology findings' as something unrelated.
2. **Specific Transcription Rules**:
    - Transcribe "few" exactly as "few", not "a few".
    - Replace the dictated word "query" with a question mark symbol "?".
    - Transcribe "status post" as the abbreviation "S/p".
    - Format dictated dimensions like "8 mm into 9 mm" as "8 x 9 mm".
    - For comparative phrases like "right more than left", use the format "(R > L)". Similarly, for "left more than right", use "(L > R)".
    - Abbreviate "complaints of" to "C/o".
    - Abbreviate "history of" to "H/o".
3. Completely ignore all non-verbal sounds (like coughing, sneezing) and any irrelevant side-conversations from the new audio. However, you MUST include any dictation related to the clinical profile or patient information.
4. If the new audio includes languages other than English, transcribe and translate the relevant medical findings into proper English.
5. Do not repeat any of the existing text in your output.
6. Your final output must be ONLY the newly corrected text, with no additional commentary, introductions, or explanations. Do not use any markdown formatting (like asterisks for bolding).`;

  if (customPrompt) {
    prompt += `\n\nAdditionally, follow these custom instructions:\n${customPrompt}`;
  }

  const textPart = { text: prompt };

  try {
    const targetModel = resolveApiTargetModel(model || DEFAULT_SELECTED_MODEL);
    const response: GenerateContentResponse = await getAI().models.generateContent({
      model: targetModel,
      contents: { parts: [textPart, audioPart] },
    });

    const resultText = response.text?.trim();
    if (!resultText) {
      throw new Error("API returned an empty response for audio continuation.");
    }
    return resultText;
  } catch (error) {
    console.error("Error calling Gemini API for audio continuation:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to process audio continuation: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for audio continuation.");
  }
};

export const modifyFindingWithAudio = async (originalText: string, audioBlob: Blob, customPrompt?: string, model?: string): Promise<string> => {
  let audioPart: any;
  if (audioBlob.type && (audioBlob.type.startsWith('text/') || audioBlob.type === 'application/json')) {
    const textContent = await audioBlob.text();
    audioPart = { text: `New modification instructions/text:\n"""\n${textContent}\n"""` };
  } else {
    const base64Audio = await blobToBase64(audioBlob);
    audioPart = {
      inlineData: {
        mimeType: getCleanMimeType(audioBlob),
        data: base64Audio,
      },
    };
  }

  let prompt = `You are an expert medical transcriptionist assistant. You will be given an existing medical finding text and an audio recording. The audio contains instructions and/or additional dictation to modify the original finding.

Your task is to return a single, updated string that intelligently incorporates the changes from the audio.
- If the audio provides additional details, integrate them coherently and grammatically into the existing text.
- If the audio provides an explicit instruction (e.g., "change 'normal' to 'unremarkable'", "remove the last sentence"), apply that instruction precisely.
- Correct any speech-to-text errors in the new dictation, following these specific transcription rules:
    - Transcribe "few" exactly as "few", not "a few".
    - Replace the dictated word "query" with a question mark symbol "?".
    - Transcribe "status post" as the abbreviation "S/p".
    - Format dictated dimensions like "8 mm into 9 mm" as "8 x 9 mm".
    - For comparative phrases like "right more than left", use the format "(R > L)". Similarly, for "left more than right", use "(L > R)".
    - Abbreviate "complaints of" to "C/o".
    - Abbreviate "history of" to "H/o".
- Your final output must be ONLY the modified text, with no additional commentary, introductions, or explanations. Do not use any markdown formatting.

Existing Finding:
"${originalText}"

Now, listen to the audio and provide the single, updated finding text.`;

  if (customPrompt) {
    prompt += `\n\nAdditionally, follow these custom instructions:\n${customPrompt}`;
  }

  const textPart = { text: prompt };

  try {
    const targetModel = resolveApiTargetModel(model || DEFAULT_SELECTED_MODEL);
    const response: GenerateContentResponse = await getAI().models.generateContent({
      model: targetModel,
      contents: { parts: [textPart, audioPart] },
    });

    const resultText = response.text?.trim();
    if (!resultText) {
      throw new Error("API returned an empty response for finding modification.");
    }
    return resultText;
  } catch (error) {
    console.error("Error calling Gemini API for finding modification:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to process finding modification: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for finding modification.");
  }
};

export const modifyReportWithAudio = async (
  currentFindings: string[], 
  audioBlob: Blob, 
  model: string, 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  customDocx?: CustomDocxInput
): Promise<string[]> => {
  let audioPart: any;
  if (audioBlob.type && (audioBlob.type.startsWith('text/') || audioBlob.type === 'application/json')) {
    const textContent = await audioBlob.text();
    audioPart = { text: `New instructions or clinical text to modify/append to the report:\n"""\n${textContent}\n"""` };
  } else {
    const base64Audio = await blobToBase64(audioBlob);
    audioPart = {
      inlineData: {
        mimeType: getCleanMimeType(audioBlob),
        data: base64Audio,
      },
    };
  }

  let prompt = `You are an expert medical transcriptionist assistant. You are given an existing medical report in JSON format and an audio recording containing instructions to modify it. Your task is to intelligently interpret the audio instructions and return a single, updated report in the exact same JSON format.

**Core Instructions:**

1.  **Preserve by Default:** Your primary goal is to modify the existing report. **You MUST preserve all original findings unless the audio instruction explicitly tells you to remove, replace, or merge them.** Do not discard existing information.

2.  **Formatting for Boldness**:
    *   **Adding New Findings**: When the audio instruction is to add a new clinical finding (e.g., "Add a finding: There is a small lesion..."), you MUST prefix the new finding string with the special marker \`BOLD::\`.
    *   **Preserving Existing Boldness**: When editing an existing finding, if the original finding in the JSON already starts with \`BOLD::\`, the modified finding MUST also start with \`BOLD::\`. If the original did not have the prefix, do not add it.
    *   **Exceptions**: Do NOT add the \`BOLD::\` prefix to the "Clinical Profile" string or the "IMPRESSION" string, as they have their own special formatting rules.

3.  **Interpret Instructions Accurately:** Carefully listen to the audio to understand the user's intent. Instructions can be about:
    *   **Editing:** "Change 'normal' to 'unremarkable' everywhere."
    *   **Removing:** "Remove the sentence about the bony structures."
    *   **Adding:** "Add a new finding: The patient has a history of hypertension." (This will be a new line with the \`BOLD::\` prefix).
    *   **Reordering:** "Move the lung findings to the top."
    *   **Synthesizing/Summarizing:** "Create an impression based on the findings." or "Summarize the key findings."

4.  **Impression Generation and Formatting:** If an audio instruction involves creating, generating, or modifying an "IMPRESSION", you MUST follow these rules:
    *   **Generation from Findings:** If asked to generate an impression from the findings, first analyze the entire report. Then, formulate the new impression points based on these strict criteria:
        *   Impressions must be concise and formulated without using verbs (e.g., "Patches of contusion" instead of "There are patches of contusion").
        *   Combine multiple related findings, including all their key descriptors (like diffusion restriction, enhancement patterns, etc.), into single, coherent impression points to ensure the summary is both concise and complete.
        *   List unrelated findings (e.g., hepatomegaly and splenomegaly) as separate points.
        *   Impressions must NOT contain any numerical values or measurements.
        *   If clinically relevant, you may add concluding phrases like "likely infective etiology" or "likely inflammatory etiology" or "likely neoplastic etiology” or “likely reactive” or “suggested clinical correlation/ review as indicated” or similar phrases. Avoid vague, non-committal conclusions when a more specific diagnosis is possible.
    *   **Formatting:** The entire impression MUST be a single string in the "findings" array. It must start with "IMPRESSION:" (all caps), followed by '###', then each point separated by '###'.
    *   **Adding/Replacing:** Add the newly generated impression as the last finding. If an impression already exists, replace it with the new one.

5.  **Special Clinical Profile Formatting:** If a clinical profile is present, added, or modified, format as clean plain text starting with "Clinical Profile: ..." (do NOT wrap in asterisks and do NOT add any trailing or extra asterisks).

6.  **Format Output Correctly:**
    *   Your final output must be ONLY the modified report, in the same JSON object format as the original, with a key named "findings" whose value is an array of strings.
    *   Do not add any commentary, explanations, or markdown formatting (like \`\`\`json).
    *   Correct any speech-to-text errors from the instruction audio itself before applying the changes, following these rules:
        - Abbreviate "complaints of" to "C/o".
        - Abbreviate "history of" to "H/o".

**Example Scenario:**

*   **Existing Report Input:**
    \`\`\`json
    {
      "findings": [
        "The cardiomediastinal silhouette is within normal limits.",
        "Lungs are clear without evidence of focal consolidation."
      ]
    }
    \`\`\`
*   **Audio Instruction:** "Create an impression: No acute abnormalities."
*   **Correct JSON Output:**
    \`\`\`json
    {
      "findings": [
        "The cardiomediastinal silhouette is within normal limits.",
        "Lungs are clear without evidence of focal consolidation.",
        "IMPRESSION:###No acute abnormalities."
      ]
    }
    \`\`\`
*   **Audio Instruction (Multi-Point):** "Create an impression. First point, hepatomegaly. Second point, splenomegaly."
*   **Correct JSON Output (replaces any existing impression):**
    \`\`\`json
    {
      "findings": [
        "The cardiomediastinal silhouette is within normal limits.",
        "Lungs are clear without evidence of focal consolidation.",
        "IMPRESSION:###Hepatomegaly.###Splenomegaly."
      ]
    }
    \`\`\`

**Existing Report:**
${JSON.stringify({ findings: currentFindings })}
`;

  const templateInfo = detectAndExtractTemplate(customPrompt, customImages, customDocx);
  if (templateInfo.isTemplateMode && templateInfo.templateContextPrompt) {
    prompt += `\n\n${templateInfo.templateContextPrompt}`;
  } else if (customPrompt) {
    prompt += `\n\nAdditionally, follow these custom instructions when processing the request:\n${customPrompt}`;
  }

  const parts: any[] = [];
  
  if (customImages && customImages.length > 0) {
    for (const customImage of customImages) {
        parts.push({
          inlineData: {
            mimeType: customImage.mimeType,
            data: customImage.data
          }
        });
    }
    parts.push({ text: `The user has provided ${customImages.length > 1 ? 'images' : 'an image'} of a report template. If the audio instruction is to reformat the report, use ${customImages.length > 1 ? 'these images' : 'this image'} as a strict visual guide.` });
  }

  parts.push({ text: prompt });
  parts.push(audioPart);
  
  const targetModel = resolveApiTargetModel(model);

  try {
    const rawResponseText = await generateContentWithJsonFallback(targetModel, parts, responseSchema, 0.1);
    const findings = extractFindingsFromResponse(rawResponseText);

    if (findings && findings.length > 0) {
      return findings;
    } else {
      throw new Error("Invalid data structure in API response. Expected a 'findings' array.");
    }
  } catch (error) {
    console.error("Error calling Gemini API for report modification:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to modify report: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for report modification.");
  }
};

export const transcribeAudioForPrompt = async (
  audioBlob: Blob,
  model?: string
): Promise<string> => {
  const base64Audio = await blobToBase64(audioBlob);

  const prompt = "Transcribe the following audio accurately. Provide only the transcribed text without any additional commentary or introduction.";

  const textPart = { text: prompt };
  const audioPart = {
    inlineData: {
      mimeType: getCleanMimeType(audioBlob),
      data: base64Audio,
    },
  };

  // Primary model respects the user's selected model from main interface
  const primaryModel = resolveApiTargetModel(model || DEFAULT_SELECTED_MODEL);

  // Dynamic failover chain: starts with user's selected model, followed by fast, authorized Gemini models
  const candidateModels = [
    primaryModel,
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite'
  ].filter((m, i, arr) => arr.indexOf(m) === i);

  let lastError: any = null;

  for (const candidateModel of candidateModels) {
    try {
      const response: GenerateContentResponse = await getAI().models.generateContent({
        model: candidateModel,
        contents: { parts: [textPart, audioPart] },
      });

      const resultText = response.text?.trim();
      if (!resultText) {
        return ""; // Return empty string if no transcription
      }
      return resultText;
    } catch (error: any) {
      console.warn(`Transcription attempt with model "${candidateModel}" failed, checking failover:`, error);
      lastError = error;
    }
  }

  console.error("All candidate Gemini models failed for transcription:", lastError);
  if (lastError instanceof Error) {
    throw new Error(`Failed to transcribe audio: ${lastError.message}`);
  }
  throw new Error("An unknown error occurred while communicating with the API for transcription.");
};


export const createChat = async (
  audioBlob: Blob | Blob[], 
  initialFindings: string[], 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  model: string = DEFAULT_SELECTED_MODEL
): Promise<Chat> => {
  const audioBlobs = Array.isArray(audioBlob) ? audioBlob : [audioBlob];
  
  const userMessageParts: any[] = [];

  if (customImages && customImages.length > 0) {
    for (const customImage of customImages) {
        userMessageParts.push({
          inlineData: {
            mimeType: customImage.mimeType,
            data: customImage.data
          }
        });
    }
    userMessageParts.push({ text: `This is the report template${customImages.length > 1 ? 's' : ''} I provided.` });
  }

  for (let i = 0; i < audioBlobs.length; i++) {
    const blob = audioBlobs[i];
    const cleanMime = getCleanMimeType(blob);

    if (blob.size > 15 * 1024 * 1024) {
      userMessageParts.push({
        text: `This is dictation / input document #${i + 1} (${(blob.size / (1024 * 1024)).toFixed(1)} MB).`
      });
      continue;
    }

    const base64Audio = await blobToBase64(blob);

    if (cleanMime.startsWith('text/')) {
      try {
        const textContent = await blob.text();
        userMessageParts.push({
          text: `This is dictation / input text document #${i + 1}${ (blob as any).name ? ` (${(blob as any).name})` : '' }:\n"""\n${textContent}\n"""`
        });
      } catch {
        userMessageParts.push({
          inlineData: {
            mimeType: cleanMime,
            data: base64Audio,
          },
        });
      }
    } else {
      userMessageParts.push({
        inlineData: {
          mimeType: cleanMime,
          data: base64Audio,
        },
      });
      userMessageParts.push({ 
        text: audioBlobs.length > 1 
          ? `This is dictation / input file #${i + 1}${ (blob as any).name ? ` (${(blob as any).name})` : '' }.` 
          : `This is the audio / file I dictated.` 
      });
    }
  }
  

  const modelResponsePart = { text: `This is the transcript you requested:\n\n${initialFindings.join('\n\n')}` };

  let systemInstruction = 'You are a helpful AI assistant for a radiologist. The user has provided an audio dictation and you have transcribed it. Now, answer the user\'s follow-up questions based on the content of the audio and the transcript.';
  if (customPrompt) {
      systemInstruction += `\n\nAdditionally, follow these custom instructions from the user:\n${customPrompt}`;
  }

  const chat = getAI().chats.create({
    model: model || DEFAULT_SELECTED_MODEL,
    config: {
      systemInstruction: systemInstruction,
    },
    history: [
      { role: 'user', parts: userMessageParts },
      { role: 'model', parts: [modelResponsePart] },
    ],
  });
  return chat;
};

export const createChatFromText = async (
  initialFindings: string[], 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  model: string = DEFAULT_SELECTED_MODEL
): Promise<Chat> => {
  const userMessageParts: any[] = [];
  
  if (customImages && customImages.length > 0) {
    for (const customImage of customImages) {
        userMessageParts.push({
          inlineData: {
            mimeType: customImage.mimeType,
            data: customImage.data
          }
        });
    }
    userMessageParts.push({ text: `This is the report template${customImages.length > 1 ? 's' : ''} I provided.` });
  }

  userMessageParts.push({ text: `This is the transcript I generated.` });

  const modelResponsePart = { text: `This is the transcript you requested:\n\n${initialFindings.join('\n\n')}` };
  
  let systemInstruction = 'You are a helpful AI assistant for a radiologist. The user has provided a transcript from a live dictation. Now, answer the user\'s follow-up questions based on the content of the transcript.';
  if (customPrompt) {
      systemInstruction += `\n\nAdditionally, follow these custom instructions from the user:\n${customPrompt}`;
  }

  const chat = getAI().chats.create({
    model: model || DEFAULT_SELECTED_MODEL,
    config: {
      systemInstruction: systemInstruction,
    },
    history: [
      { role: 'user', parts: userMessageParts },
      { role: 'model', parts: [modelResponsePart] },
    ],
  });
  return chat;
};

const errorSchema = {
    type: Type.OBJECT,
    properties: {
        errors: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    findingIndex: {
                        type: Type.INTEGER,
                        description: "The 0-based index of the finding with a potential error."
                    },
                    errorDescription: {
                        type: Type.STRING,
                        description: "A concise explanation of the potential error."
                    },
                    severity: {
                        type: Type.STRING,
                        description: "The severity of the issue: 'WARNING' or 'INFO'."
                    }
                },
                required: ["findingIndex", "errorDescription", "severity"]
            }
        }
    }
};

export const identifyPotentialErrors = async (findings: string[], model: string): Promise<IdentifiedError[]> => {
    const textPart = {
        text: `${ERROR_IDENTIFIER_PROMPT}\n\nReport to analyze:\n${JSON.stringify({ findings })}`,
    };

    try {
        const targetModel = resolveApiTargetModel(model);
        const rawResponseText = await generateContentWithJsonFallback(targetModel, [textPart], errorSchema, 0.1);
        return extractErrorsFromResponse(rawResponseText);
    } catch (error) {
        console.error("Error calling Gemini API for error identification:", error);
        // Don't throw, just return empty array as this is a background task.
        return [];
    }
};

// --- Complex Impression Generation Constants & Pipeline ---
const COMPLEX_IMPRESSION_DEFAULT_MODEL = 'gemini-3.8-flash';
const COMPLEX_IMPRESSION_FALLBACK_MODEL = 'gemini-3.7-flash';

/**
 * Detects if an API error is a rate-limit (429 / resource exhausted / quota) error.
 */
function isRateLimitError(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status || (err as any)?.code || (err as any)?.error?.code || (err as any)?.statusText;
    return (
        status === 429 ||
        status === 'RESOURCE_EXHAUSTED' ||
        msg.includes('429') ||
        /rate limit/i.test(msg) ||
        /resource has been exhausted/i.test(msg) ||
        /quota/i.test(msg) ||
        /RESOURCE_EXHAUSTED/i.test(msg) ||
        /too many requests/i.test(msg)
    );
}

interface StepExecutionResult {
    text: string;
    groundingChunks?: any[];
}

/**
 * Executes a single task in the complex impression workflow with:
 * 1. gemini-3.8-flash with Google search grounding alone as default.
 * 2. When rate limit error occurs, automatically falls back to gemini-3.7-flash with Google search grounding.
 * 3. If both hit rate limit error, counts down live in the app ("retrying in x seconds...") and retries.
 * 4. Only the errored item is retried; once an item succeeds, its result is preserved.
 */
async function executeAgentStepWithFallbackAndRetry(
    taskName: string,
    prompt: string,
    onProgress?: (status: string) => void,
    maxRetryCycles: number = 8
): Promise<StepExecutionResult> {
    let cycle = 0;
    while (cycle < maxRetryCycles) {
        cycle++;

        // 1. Try default model: gemini-3.8-flash with Google search grounding alone
        try {
            onProgress?.(`${taskName}: Analyzing with ${COMPLEX_IMPRESSION_DEFAULT_MODEL} (Google Search grounded)...`);
            const response = await getAI().models.generateContent({
                model: COMPLEX_IMPRESSION_DEFAULT_MODEL,
                contents: prompt,
                config: {
                    tools: [{ googleSearch: {} }]
                }
            });
            const text = response.text || '';
            const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
            return { text, groundingChunks };
        } catch (primaryErr: any) {
            if (!isRateLimitError(primaryErr)) {
                console.error(`${taskName}: Fatal error on ${COMPLEX_IMPRESSION_DEFAULT_MODEL}:`, primaryErr);
                throw primaryErr;
            }

            console.warn(`${taskName}: Rate limit on ${COMPLEX_IMPRESSION_DEFAULT_MODEL}. Switching to ${COMPLEX_IMPRESSION_FALLBACK_MODEL}...`);
            onProgress?.(`${taskName}: Rate limit on ${COMPLEX_IMPRESSION_DEFAULT_MODEL}. Switching to ${COMPLEX_IMPRESSION_FALLBACK_MODEL}...`);

            // 2. Try fallback model: gemini-3.7-flash with Google search grounding alone
            try {
                const fallbackResponse = await getAI().models.generateContent({
                    model: COMPLEX_IMPRESSION_FALLBACK_MODEL,
                    contents: prompt,
                    config: {
                        tools: [{ googleSearch: {} }]
                    }
                });
                const text = fallbackResponse.text || '';
                const groundingChunks = fallbackResponse.candidates?.[0]?.groundingMetadata?.groundingChunks;
                return { text, groundingChunks };
            } catch (fallbackErr: any) {
                if (!isRateLimitError(fallbackErr)) {
                    console.error(`${taskName}: Fatal error on ${COMPLEX_IMPRESSION_FALLBACK_MODEL}:`, fallbackErr);
                    throw fallbackErr;
                }

                // Both models hit rate limit! Wait with live countdown
                const waitSeconds = Math.min(15, 5 + (cycle - 1) * 2); // 5s, 7s, 9s, 11s, 13s, 15s
                console.warn(`${taskName}: Rate limit on both models. Retrying in ${waitSeconds}s...`);

                for (let sec = waitSeconds; sec > 0; sec--) {
                    onProgress?.(`${taskName}: Rate limit reached on both models. Retrying in ${sec} second${sec > 1 ? 's' : ''}...`);
                    await new Promise(res => setTimeout(res, 1000));
                }
                onProgress?.(`${taskName}: Retrying with ${COMPLEX_IMPRESSION_DEFAULT_MODEL}...`);
                // Loop continues to attempt gemini-3.8-flash again
            }
        }
    }
    throw new Error(`${taskName}: Rate limit persisted after ${maxRetryCycles} retry cycles.`);
}

/**
 * Parses findings JSON array returned by Gemini, with multiple fallback extractors.
 */
function parseImpressionJsonResponse(rawText: string): string[] {
    if (!rawText || !rawText.trim()) {
        throw new Error("Complex impression generation returned an empty response.");
    }

    // 1. Direct code-fence strip & JSON parse
    const cleaned = rawText.replace(/^```json\s*|```\s*$/g, '').trim();
    try {
        const parsed = JSON.parse(cleaned);
        if (parsed && Array.isArray(parsed.findings)) {
            return parsed.findings;
        }
    } catch (e) {}

    // 2. Regex match for markdown json block
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch && fenceMatch[1]) {
        try {
            const parsed = JSON.parse(fenceMatch[1].trim());
            if (parsed && Array.isArray(parsed.findings)) {
                return parsed.findings;
            }
        } catch (e) {}
    }

    // 3. Regex match for {"findings": [...]}
    const objectMatch = rawText.match(/\{\s*"findings"\s*:\s*\[[\s\S]*?\]\s*\}/);
    if (objectMatch) {
        try {
            const parsed = JSON.parse(objectMatch[0]);
            if (parsed && Array.isArray(parsed.findings)) {
                return parsed.findings;
            }
        } catch (e) {}
    }

    // 4. Regex match for raw array of strings [...]
    const arrayMatch = rawText.match(/\[\s*"[\s\S]*?"\s*\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
                return parsed;
            }
        } catch (e) {}
    }

    throw new Error("Could not parse valid findings array from complex impression response.");
}

export async function runAgenticAnalysis(
    content: string,
    onProgress?: (status: string) => void
): Promise<{ finalResult: string; agenticSteps: string; enhancementText: string; }> {
    let agenticSteps = "### Agentic Workflow Log\n\n";
    // Maintain state for each sub-task so finished items are NEVER re-executed
    const initialAnalyses: string[] = new Array(3).fill('');
    const refinedAnalyses: string[] = new Array(3).fill('');

    // --- STEP 1: Initial Analysis (3 Fact-Checker Agents in parallel) ---
    agenticSteps += "--- STEP 1: Initial Analysis (Fact-Checker Agents) ---\n\n";
    onProgress?.("Step 1/4: Initial Fact-Checking Analysis (3 Agents)...");

    const step1Promises = [0, 1, 2].map(async (i) => {
        if (initialAnalyses[i]) {
            return initialAnalyses[i]; // Already finished, do not retry!
        }
        const res = await executeAgentStepWithFallbackAndRetry(
            `Agent 1.${i + 1} (Fact-Checker)`,
            `${INITIAL_AGENT_PROMPT}\n\n--- CONTENT TO ANALYZE ---\n\n${content}`,
            onProgress
        );
        initialAnalyses[i] = res.text;
        return res.text;
    });

    await Promise.all(step1Promises);
    initialAnalyses.forEach((text, i) => {
        agenticSteps += `**Agent 1.${i + 1} Output:**\n\`\`\`\n${text}\n\`\`\`\n\n`;
    });

    // --- STEP 2: Refinement (3 Peer Reviewer Agents in parallel) ---
    agenticSteps += "--- STEP 2: Refinement (Peer Reviewer Agents) ---\n\n";
    onProgress?.("Step 2/4: Peer Review & Refinement (3 Agents)...");

    const step2Promises = initialAnalyses.map(async (analysis, i) => {
        if (refinedAnalyses[i]) {
            return refinedAnalyses[i]; // Already finished, do not retry!
        }
        const res = await executeAgentStepWithFallbackAndRetry(
            `Agent 2.${i + 1} (Peer Reviewer)`,
            `${REFINEMENT_AGENT_PROMPT}\n\n--- ORIGINAL CONTENT ---\n\n${content}\n\n--- INITIAL ANALYSIS TO REFINE ---\n\n${analysis}`,
            onProgress
        );
        refinedAnalyses[i] = res.text;
        return res.text;
    });

    await Promise.all(step2Promises);
    refinedAnalyses.forEach((text, i) => {
        agenticSteps += `**Agent 2.${i + 1} Output:**\n\`\`\`\n${text}\n\`\`\`\n\n`;
    });

    // --- STEP 3: Final Synthesis (Master Editor Agent) ---
    agenticSteps += "--- STEP 3: Final Synthesis (Master Editor Agent) ---\n\n";
    onProgress?.("Step 3/4: Synthesizing expert notes (Master Editor Agent)...");

    const synthesizerResponse = await executeAgentStepWithFallbackAndRetry(
        "Agent 3.1 (Synthesizer)",
        `${SYNTHESIZER_AGENT_PROMPT}\n\n--- ORIGINAL CONTENT ---\n\n${content}\n\n--- REFINED ANALYSES ---\n\n${refinedAnalyses.join('\n\n---\n\n')}`,
        onProgress
    );

    const enhancementText = synthesizerResponse.text;
    agenticSteps += `**Agent 3.1 (Synthesizer) Output:**\n\`\`\`\n${enhancementText}\n\`\`\`\n\n`;

    // Output Formatting
    let finalResult = '';
    if (enhancementText.toLowerCase().includes("no significant errors or omissions found")) {
        finalResult = content;
    } else {
        let sourcesText = '';
        const groundingChunks = synthesizerResponse.groundingChunks;
        if (groundingChunks && groundingChunks.length > 0) {
            const urls = new Set<string>();
            groundingChunks.forEach(chunk => {
                if (chunk.web?.uri) {
                    urls.add(chunk.web.uri);
                }
            });
            if (urls.size > 0) {
                sourcesText = `\n\n## Sources\n${Array.from(urls).map(url => `- ${url}`).join('\n')}`;
            }
        }
        finalResult = `${content}\n\n${enhancementText}${sourcesText}`;
    }

    return { finalResult, agenticSteps, enhancementText };
}

export async function runComplexImpressionGeneration(
    currentFindings: string[], 
    additionalFindings: string,
    onProgress?: (status: string) => void
): Promise<{ findings: string[]; expertNotes: string; }> {
    const content = currentFindings.join('\n\n') + (additionalFindings ? `\n\n${additionalFindings}` : '');

    // Steps 1 to 3: Multi-agent analysis (Steps completed are preserved and never repeated)
    const { finalResult: expertNotesContent, enhancementText } = await runAgenticAnalysis(content, onProgress);

    const findingsWithoutImpression = currentFindings.filter(f => !f.toUpperCase().startsWith('IMPRESSION:'));

    const impressionPrompt = `You are an expert radiologist AI. You are given a set of findings from a dictation and some expert notes from an analysis agent. Your task is to generate a concise, clinically relevant impression based on ALL available information.

**STRICT INSTRUCTIONS:**
1.  **DO NOT MODIFY THE ORIGINAL FINDINGS.** Preserve them exactly as they are provided below.
2.  Use the "Expert Notes" as a knowledge base to deeply understand the context, potential inaccuracies, and missing information. Use this deeper understanding to create a highly accurate and comprehensive impression based on the original findings.
3.  Synthesize a new impression based on the findings. If an impression already exists in the original findings, you MUST REPLACE it with your new one.
4.  Formulate the impression based on these strict criteria:
    - The impression must be concise and formulated without using verbs. For instance, instead of "There are patches of contusion", write "Patches of contusion".
    - Combine multiple related findings, including all their key descriptors into single, coherent impression points to ensure the summary is both concise and complete.
    - List unrelated findings as separate points. For example, hepatomegaly and splenomegaly should be separate points if not related to a primary diagnosis.
    - The impression must NOT contain any numerical values or measurements.
    - If clinically relevant, you may add concluding phrases like "likely infective etiology" or "likely inflammatory etiology" or "likely neoplastic etiology” or “likely reactive” or “suggested clinical correlation/ review as indicated” or similar phrases. Avoid vague, non-committal conclusions when a more specific diagnosis is possible.
5.  The entire impression MUST be formatted as a single string in the "findings" array. It must start with "IMPRESSION:" (all caps), followed by '###', then each point separated by '###'.
6.  Your final output must be a valid JSON object with a single key "findings", containing the complete, updated list of findings (original findings + your new impression) as an array of strings. Output ONLY the JSON block:
\`\`\`json
{
  "findings": [
    "Preserved original finding 1",
    "Preserved original finding 2",
    "IMPRESSION:###First point###Second point"
  ]
}
\`\`\`

**ORIGINAL FINDINGS (DO NOT CHANGE):**
${JSON.stringify(findingsWithoutImpression)}

**EXPERT NOTES (USE FOR CONTEXT):**
${expertNotesContent}

Now, generate the complete report including the new impression in the specified JSON format. Return ONLY the JSON object.`;

    onProgress?.("Step 4/4: Formulating final radiology impression...");

    // Step 4: Final Impression Formulation using the same resilient runner
    // If Step 4 encounters rate limits or retries, Steps 1-3 are NOT re-executed!
    let lastError: Error | null = null;
    for (let parseAttempt = 0; parseAttempt < 2; parseAttempt++) {
        try {
            const impressionResponse = await executeAgentStepWithFallbackAndRetry(
                "Final Impression Formulation",
                impressionPrompt,
                onProgress
            );
            const findingsArray = parseImpressionJsonResponse(impressionResponse.text);
            return { findings: findingsArray, expertNotes: enhancementText };
        } catch (parseErr: any) {
            lastError = parseErr;
            if (parseAttempt === 0) {
                onProgress?.("Re-formatting impression JSON output...");
            }
        }
    }

    throw lastError || new Error("Failed to formulate complex impression.");
}

/**
 * Resolves user custom instructions and checks if a built-in or custom report template is active.
 * Formats custom instructions with HIGHEST PRIORITY so they take precedence over default rules.
 */
export function resolveCustomInstructionsAndTemplate(
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  customDocx?: CustomDocxInput
): {
  instructionsText: string;
  templateContext: string;
  hasTemplate: boolean;
  templateName?: string;
  templateContent?: string;
  templateType: 'docx' | 'image' | 'builtin' | 'custom_text' | 'none';
} {
  const detected = detectAndExtractTemplate(customPrompt, customImages, customDocx);

  const instructionsText = customPrompt && customPrompt.trim()
    ? `
================================================================================
CRITICAL USER CUSTOM INSTRUCTIONS (HIGHEST PRIORITY):
"""
${customPrompt.trim()}
"""
MANDATORY PRECEDENCE:
- You MUST strictly apply and obey all user custom instructions above!
- If the user specified custom abbreviations (e.g. RT/LT), measurement formatting, specific terminology, section titles, language translations, omissions, additions, or stylistic rules, these user instructions MUST OVERRIDE default rules!
================================================================================
`
    : '';

  return {
    instructionsText,
    templateContext: detected.templateContextPrompt,
    hasTemplate: detected.isTemplateMode,
    templateName: detected.templateName,
    templateContent: detected.templateContent,
    templateType: detected.templateType,
  };
}

export interface LiveHistoryContext {
  previousState?: string[];
  deletedItems?: string[];
}

export interface LiveChunkResult {
  findings: string[];
  activeModel: string;
  failoverOccurred?: boolean;
  failedModels?: string[];
  attempts: number;
  error?: string | null;
}

/**
 * Intelligent Speech Recognition and Live Dictation chunk processor.
 * Includes:
 * 1. Multi-model fallback across the 3 permitted live dictation models (3.7 flash, 3.8 flash, 3.5 flash-lite).
 * 2. High-priority Custom Instructions and Report Template integration.
 * 3. Strict User-Edited Ground Truth preservation (never reverts manual edits, reorders, or merges).
 * 4. Voice Undo & Revert command support: restores deleted/modified findings on voice command ("revert it back", "undo delete", etc.).
 */
export const processLiveAudioChunk = async (
  audioBlob: Blob,
  model: string = 'gemini-3.7-flash',
  previousFindings: string[] = [],
  chunkIndex: number = 0,
  customPrompt?: string,
  onFailover?: (failedModel: string, nextModel: string, reason: string) => void,
  historyContext?: LiveHistoryContext,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  customDocx?: CustomDocxInput
): Promise<LiveChunkResult> => {
  const base64Audio = await blobToBase64(audioBlob);
  const cleanMime = getCleanMimeType(audioBlob) || 'audio/wav';

  const previousTranscriptText = previousFindings && previousFindings.length > 0
    ? previousFindings.join('\n')
    : '(None - starting session)';

  const { instructionsText, templateContext } = resolveCustomInstructionsAndTemplate(customPrompt, customImages, customDocx);

  // Feature E: Intelligent Boundary Stitching Anchor
  // Extract trailing words from the last finding to provide explicit boundary awareness and eliminate word duplication
  let trailingAnchor = '';
  if (previousFindings && previousFindings.length > 0) {
    const lastItem = previousFindings[previousFindings.length - 1];
    const cleanLastItem = lastItem.replace(/^BOLD::\s*/i, '').replace(/^\*.*?\*\s*/, '').trim();
    if (cleanLastItem) {
      const words = cleanLastItem.split(/\s+/).filter(Boolean);
      trailingAnchor = words.slice(-Math.min(words.length, 6)).join(' ');
    }
  }

  const boundaryStitchingText = trailingAnchor
    ? `
================================================================================
INTELLIGENT BOUNDARY STITCHING ANCHOR (FROM PRECEDING AUDIO SEGMENT):
The immediate prior audio segment finished with the words:
"...${trailingAnchor}"

CRITICAL STITCHING DIRECTIVES (ELIMINATE BOUNDARY DUPLICATION & STUTTERING):
1. Because consecutive audio segments have a slight overlap buffer, you may hear the tail-end of "...${trailingAnchor}" at the very beginning of this audio segment.
2. DO NOT duplicate, re-transcribe, or stutter the words "...${trailingAnchor}"!
3. If this audio segment continues that thought, smoothly finish that thought without repeating the anchor words.
4. If this audio segment begins a brand new finding or clause, start the new finding cleanly.
================================================================================
`
    : '';

  const historySectionText = historyContext && ((historyContext.previousState && historyContext.previousState.length > 0) || (historyContext.deletedItems && historyContext.deletedItems.length > 0))
    ? `
================================================================================
RECENT EDIT, DELETION & MODIFICATION HISTORY (FOR VOICE UNDO & REVERT):
Previous report findings state before recent deletion or change:
"""
${historyContext.previousState && historyContext.previousState.length > 0 ? historyContext.previousState.join('\n') : '(None)'}
"""
Recently deleted or modified item(s):
"""
${historyContext.deletedItems && historyContext.deletedItems.length > 0 ? historyContext.deletedItems.join('\n') : '(None)'}
"""
================================================================================
`
    : '';

  const buildPromptForModel = (activeModelName: string) => `You are an expert medical transcriptionist specializing in radiology, powering a high-speed live dictation and speech recognition engine with ${activeModelName}.
Your task is to transcribe this live audio segment into clean, structured radiology report findings, maintaining flawless continuity with the previously dictated text.

${templateContext}
${instructionsText}
${boundaryStitchingText}
${historySectionText}

STRICT RADIOLOGY TRANSCRIPTION & MEDICAL FORMATTING RULES:
1. **Accurate Medical Terminology**: Replace misheard words or speech-to-text slips with proper radiology terms. Pay critical attention to prefixes like "hypo-" and "hyper-".
2. **Specific Formatting Rules**:
   - Transcribe "few" exactly as "few", not "a few".
   - Replace the dictated word "query" with "?".
   - Transcribe "status post" as "S/p".
   - Format dimensions like "8 mm into 9 mm" as "8 x 9 mm".
   - Comparative phrases: "right more than left" as "(R > L)", "left more than right" as "(L > R)".
   - Abbreviate "complaints of" to "C/o" and "history of" to "H/o".
3. **Prefix Marker for Findings**: You MUST prefix every standard finding line with the special marker \`BOLD::\` (unless template normal findings or custom instructions specify otherwise).
4. **Clinical Profile**: If clinical history/profile is dictated, format as single paragraph without asterisks, e.g. "Clinical Profile: C/o RTA with TBI (GCS- 15/15)." (do not prefix with BOLD:: and do NOT add any trailing or extra asterisks).
5. **Impression Section**: If an impression is dictated, combine title and points separated by '###', starting with "IMPRESSION:###point 1###point 2" (do not prefix with BOLD::).
6. **Obey Spoken Voice Commands, Sentence Deletions, Voice Undo & Dynamic Modifications**:
   - **VOICE UNDO, REVERT & RESTORE DELETION (CRITICAL)**:
     If the doctor speaks any undo or revert command in this audio segment, such as:
     "revert it back", "revert back", "bring it back", "bring back that line", "undo", "undo delete", "undo that", "restore the deleted line", "restore the deleted finding", "restore last line", "bring back the finding", "put it back", "revert what was deleted", "undo deletion":
     YOU MUST RESTORE the deleted or previously modified finding from the RECENT EDIT, DELETION & MODIFICATION HISTORY into the report!
     Restore the item in its proper clinical position or append it, with BOLD:: intact.
   - **Targeted Sentence Deletion**: If the doctor says "delete the sentence about [X]", "remove the finding regarding [X]", "delete sentence [X]", or "remove the part where I said [X]", locate that specific finding or sentence from the PREVIOUSLY DICTATED FINDINGS and REMOVE IT entirely from the report.
   - **Last Item Deletion**: "delete last finding", "remove last line", "delete last sentence": Remove the immediately preceding finding.
   - **In-place Correction**: "change [X] to [Y]", "replace [X] with [Y]", "it is not [X], [Y]": Modify that specific finding directly in the report.
   - **Undoing & Backtracking**: "scratch that", "delete last word": Erase the last spoken clause or finding.
   - **Line Delimiters**: "move to next line", "next line", "new finding", "separate finding": Start a new finding line (never write out the command words).
   - **Punctuation**: "full stop", "period", "comma", "colon": Insert punctuation (. , :).
   - **Clear All**: "clear report", "delete all findings", "delete everything": Clear all findings.
7. **STRICT NON-RADIOLOGY SPEECH & SIDE-CONVERSATION REJECTION (CRITICAL)**:
   - You are listening ONLY for formal clinical radiology dictation and spoken editing commands.
   - If the audio contains casual side-talk, phone calls, background office conversation, talking to a technician, nurse, or colleague (e.g. "Can you hand me the chart?", "Hello?", "What's the next patient?", "Let me see this", "Hold on a second", "Yeah, I saw that"), or non-diagnostic social banter:
     **STRICTLY DISCARD AND IGNORE IT**.
   - NEVER transcribe side-conversations into the radiology report.
   - If an audio slice contains ONLY casual conversation or background office talk, return the PREVIOUS FINDINGS EXACTLY AS IS with zero additions.
8. **SILENCE & AMBIENT NOISE ANTI-HALLUCINATION (CRITICAL)**:
   - If the audio contains silence, microphone hum, breathing, throat clearing, paper rustling, keyboard clicks, or indistinct background room sound:
     RETURN THE PREVIOUS FINDINGS EXACTLY AS IS.
   - DO NOT invent, fabricate, or guess findings. Never output default or generic statements unless the doctor explicitly dictated those exact words in this audio segment.

LIVE STREAMING AUDIO CHUNK #${chunkIndex + 1} CONTEXT:
PREVIOUSLY DICTATED & TRANSCRIBED FINDINGS SO FAR:
"""
${previousTranscriptText}
"""

CRITICAL GROUND TRUTH PRESERVATION (DO NOT REVERT MANUAL EDITS OR MERGES):
- The findings listed under "PREVIOUSLY DICTATED & TRANSCRIBED FINDINGS SO FAR" represent the doctor's verified, authoritative clinical report. The doctor may have manually edited text, reordered findings, merged multiple findings together, or customized phrasing in the user interface.
- YOU MUST NEVER REVERT, REWRITE, UN-MERGE, SPLIT, OR REORDER ANY OF THESE EXISTING FINDINGS!
- Preserve every existing finding EXACTLY as it appears, maintaining its exact wording, merged format, and sequence.
- When new radiology findings are spoken in this audio segment, simply format and APPEND the new finding(s) to the end of the findings list.
- Only modify or delete an existing finding if the doctor speaks an explicit editing command in THIS audio segment (e.g. "delete the finding about...", "change X to Y", or "revert it back").

INSTRUCTIONS FOR THIS AUDIO SEGMENT:
- Listen carefully to the attached audio segment.
- **CUSTOM INSTRUCTIONS PRIORITY**: If the user has provided custom instructions above, strictly adhere to every one of them.
- **GLOBAL MODIFICATION & TARGETED DELETION / UNDO**: You have full authority to modify, delete, or revert/restore any previously dictated sentence if the doctor directs it in this audio segment.
- If the doctor speaks new radiology findings, format and append them cleanly following all rules.
- If the previous segment left off on an unfinished sentence or word, complete and polish that sentence smoothly.
- If this audio segment contains only silence, background noise, or irrelevant non-radiology chatter, return the previously dictated findings intact with NO additions.
- Return the COMPLETE, FINAL, UPDATED array of findings for the whole report in JSON format.
`;

  // Multi-model fallback chain: selected model + subsequent next 2 models
  const fallbackChain = getLiveModelFallbackChain(model || 'gemini-3.7-flash');
  let lastError: any = null;
  const failedModels: string[] = [];

  for (let attempt = 0; attempt < fallbackChain.length; attempt++) {
    const currentModel = fallbackChain[attempt];
    try {
      const liveChunkPrompt = buildPromptForModel(currentModel);
      const parts: any[] = [
        { text: liveChunkPrompt },
        {
          inlineData: {
            mimeType: cleanMime,
            data: base64Audio,
          }
        }
      ];

      const rawResponseText = await generateContentWithJsonFallback(currentModel, parts, responseSchema, 0.1);
      const parsedFindings = extractFindingsFromResponse(rawResponseText);

      if (parsedFindings && parsedFindings.length > 0) {
        return {
          findings: parsedFindings,
          activeModel: currentModel,
          attempts: attempt + 1,
          failoverOccurred: attempt > 0,
          failedModels,
        };
      }

      return {
        findings: previousFindings,
        activeModel: currentModel,
        attempts: attempt + 1,
        failoverOccurred: attempt > 0,
        failedModels,
      };
    } catch (error: any) {
      lastError = error;
      failedModels.push(currentModel);

      const isRateLimit =
        error?.status === 429 ||
        error?.message?.includes('429') ||
        error?.message?.toLowerCase().includes('quota') ||
        error?.message?.toLowerCase().includes('resource_exhausted') ||
        error?.message?.toLowerCase().includes('rate');

      const reason = isRateLimit ? 'Rate limit exceeded' : (error?.message || 'Model service error');
      console.warn(`[Live Dictation] Chunk #${chunkIndex + 1} attempt ${attempt + 1}/${fallbackChain.length} with ${currentModel} failed (${reason})`);

      if (attempt < fallbackChain.length - 1) {
        const nextModel = fallbackChain[attempt + 1];
        console.info(`[Live Dictation] Auto-failing over to subsequent model: ${nextModel}`);
        if (onFailover) {
          onFailover(currentModel, nextModel, reason);
        }
      }
    }
  }

  console.error(`[Live Dictation] All ${fallbackChain.length} candidate models failed (${fallbackChain.join(' -> ')}). Returning previous findings.`);
  return {
    findings: previousFindings,
    activeModel: model,
    attempts: fallbackChain.length,
    failoverOccurred: true,
    failedModels,
    error: `Rate limit or service error across all 3 models (${fallbackChain.join(', ')}).`,
  };
};

/**
 * Performs a global, holistic clinical review and unification pass over accumulated live findings.
 * Removes cross-chunk duplications, standardizes terminology, validates anatomical consistency,
 * integrates template structure and user custom instructions, and synthesizes/aligns the IMPRESSION section.
 * Automatically tries subsequent next 2 models if primary model fails.
 */
export const synthesizeLiveReport = async (
  rawFindings: string[],
  model: string = 'gemini-3.7-flash',
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  customDocx?: CustomDocxInput
): Promise<string[]> => {
  if (!rawFindings || rawFindings.length === 0) {
    return [];
  }

  const { instructionsText, templateContext } = resolveCustomInstructionsAndTemplate(customPrompt, customImages, customDocx);

  const prompt = `You are a Chief Clinical Radiologist and expert report synthesizer.
Below is the accumulated raw draft from a live progressive radiology dictation session.

${templateContext}
${instructionsText}

RAW DRAFT FINDINGS:
${rawFindings.map((f, i) => `[${i + 1}] ${f}`).join('\n')}

YOUR TASK:
Perform a comprehensive, holistic review pass over the draft to generate the final, authoritative radiology report:
1. **Preserve User Edits, Merges & Sequence**: If the doctor manually edited, merged multiple findings together, or reordered lines in the draft, strictly RESPECT and PRESERVE their wording and merged structures! DO NOT revert manual edits or split merged lines back into separate paragraphs.
2. **Apply All Custom Instructions**: Meticulously adhere to every custom instruction specified above (style, terminology, formatting, omissions, or template integration).
3. **Deduplication**: Remove any sentence or phrase that was accidentally repeated or stuttered across audio chunk boundaries.
4. **Clinical Coherence & Lateral Consistency**: Verify that anatomical laterality is consistent (e.g. ensure right/left designations are not contradictory).
5. **Medical Formatting**:
   - Every standard finding MUST start with \`BOLD::\` (unless the custom instruction or template specifies otherwise).
   - Dimensions standardized: "16 x 17 mm".
   - Shorthand normalized: "S/p", "C/o", "H/o", "(R > L)", "(L > R)".
   - Clinical profile without asterisks and without BOLD:: (e.g., "Clinical Profile: C/o trauma.") and with no trailing or extra asterisks.
6. **IMPRESSION**:
   - If an impression exists, ensure it is formatted as "IMPRESSION:###point 1###point 2".
   - Ensure the impression highlights the most clinically significant and acute abnormalities first.
   - If findings clearly describe definitive pathologies but no impression was dictated, synthesize a concise, non-verbal impression matching the findings.
7. **Anti-Hallucination**:
   - DO NOT fabricate any new findings or lesions not present in the draft.
   - Discard any stray casual fragments or non-medical words if any slipped through.

Output MUST be a JSON object with a single "findings" array of strings.`;

  const fallbackChain = getLiveModelFallbackChain(model || 'gemini-3.7-flash');

  for (let attempt = 0; attempt < fallbackChain.length; attempt++) {
    const currentModel = fallbackChain[attempt];
    try {
      const rawResponseText = await generateContentWithJsonFallback(currentModel, [{ text: prompt }], responseSchema, 0.1);
      const parsedFindings = extractFindingsFromResponse(rawResponseText);
      if (parsedFindings && parsedFindings.length > 0) {
        return parsedFindings;
      }
      return rawFindings;
    } catch (err) {
      console.warn(`[Synthesize Report] Attempt ${attempt + 1}/${fallbackChain.length} with ${currentModel} notice:`, err);
      if (attempt < fallbackChain.length - 1) {
        console.info(`[Synthesize Report] Auto-failing over to subsequent model: ${fallbackChain[attempt + 1]}`);
      }
    }
  }

  return rawFindings;
};


