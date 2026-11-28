import { REPORT_TEMPLATES } from '../constants';
import {
  BuiltInTemplateItem,
  getBuiltInTemplateNumber,
  resolveBuiltInTemplateByNumber,
} from './builtInTemplates';
import { findTemplateByIdOrNumber, getTemplateDisplayId } from './templateStorage';
import {
  CombinedTemplateBundle,
  DocxTemplateData,
  buildCombinedTemplateBundle,
  canonicalizeTemplateIdToken,
  extractTemplateTagIds,
  mergeTemplateImages,
  normalizeTemplateTagId,
} from './upcomingTemplateService';

export {
  buildCombinedTemplateBundle,
  canonicalizeTemplateIdToken,
  extractTemplateTagIds,
  findTemplateByIdOrNumber,
  getBuiltInTemplateNumber,
  getTemplateDisplayId,
  mergeTemplateImages,
  normalizeTemplateTagId,
  resolveBuiltInTemplateByNumber,
};
export type { BuiltInTemplateItem, CombinedTemplateBundle, DocxTemplateData };

export interface DetectedTemplateInfo {
  isTemplateMode: boolean;
  templateType: 'docx' | 'image' | 'builtin' | 'custom_text' | 'none';
  templateName?: string;
  templateContent?: string;
  templateHtml?: string;
  userInstructions?: string;
  templateContextPrompt: string;
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

export interface PatientReportSegment {
  id: string;
  label: string;
  patientName?: string;
  templateIds?: string[];
  templateName?: string;
  findings: string[];
}

export function findBuiltinTemplates(promptOrId?: string): (typeof REPORT_TEMPLATES)[number][] {
  if (!promptOrId || !promptOrId.trim()) return [];

  const raw = promptOrId.trim();
  const matched: (typeof REPORT_TEMPLATES)[number][] = [];

  // 1. Direct ID match (e.g. single "tpl_001", "tpl_add_128", "add_128", or "1")
  const directCanon = canonicalizeTemplateIdToken(raw).toLowerCase();
  const directId = REPORT_TEMPLATES.find(
    t => t.id && (t.id.toLowerCase() === raw.toLowerCase() || t.id.toLowerCase() === directCanon)
  );
  if (directId) {
    return [directId];
  }

  // 2. Explicit ID tags in prompt: [TEMPLATE_ID: tpl_001, tpl_add_128] or [TEMPLATE_ID: 1, add_128]
  const idTagMatches = [...raw.matchAll(/\[(?:TEMPLATE_ID|TEMPLATE_IDS|TEMPLATES|TEMPLATE|ID):\s*([^\]]+)\]/gi)];
  for (const match of idTagMatches) {
    const idsStr = match[1].replace(/\b((?:builtin_)?(?:tpl[\s_-]*)?add)[\s_-]+(\d+)\b/gi, '$1_$2');
    const parts = idsStr.split(/[,;\s]+/).map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const cleanPart = canonicalizeTemplateIdToken(part).toLowerCase();
      const byId = REPORT_TEMPLATES.find(t => t.id && t.id.toLowerCase() === cleanPart);
      if (byId && !matched.some(m => m.id === byId.id)) {
        matched.push(byId);
      }
    }
  }

  // 3. Exact quoted or bracketed template names in prompt
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
  const extractedMatch =
    raw.match(/(?:normal|use|template)\s+["'“]([^"'“”\n]+?)["'”]\s+(?:report\s+)?template/i) ||
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

function parseCombinedNamesFromPrompt(customPrompt?: string): string[] {
  if (!customPrompt) return [];
  const match = customPrompt.match(/Use combined report templates:\s*([^\n.]+)/i);
  if (!match) return [];
  const quoted = [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1].trim()).filter(Boolean);
  if (quoted.length > 0) return quoted;
  return match[1].split(/\s+(?:and|\+)\s+|,/i).map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function parseSingleTemplateNameFromPrompt(customPrompt?: string): string | null {
  if (!customPrompt) return null;
  const m = customPrompt.match(/Merged with template:\s*([^\n.]+?)(?:\.|\n|$)/i);
  return m && m[1] ? m[1].trim() : null;
}

export function detectAndExtractTemplate(
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  customDocx?: CustomDocxInput
): DetectedTemplateInfo {
  const docxText = ((customDocx?.text || customDocx?.extractedText || '')).trim();
  const docxHtml = customDocx?.html || customDocx?.extractedHtml;

  const matchedBuiltins = findBuiltinTemplates(customPrompt);
  const explicitTagIds = extractTemplateTagIds(customPrompt);
  const parsedDocxSections = docxText
    ? docxText
        .split(/(?=^===\s*TEMPLATE:)/m)
        .map(s => s.trim())
        .filter(s => /^===\s*TEMPLATE:/i.test(s))
        .map(block => {
          const headerMatch = block.match(/^===\s*TEMPLATE:\s*(.+?)\s*===/i);
          const name = headerMatch ? headerMatch[1].trim() : 'Template Section';
          const body = block.replace(/^===\s*TEMPLATE:[^\n]*\n?/i, '').trim();
          const builtinMatch = matchedBuiltins.find(b => b.name.toLowerCase() === name.toLowerCase());
          return {
            name,
            content: body || (builtinMatch?.lines?.join('\n') || builtinMatch?.content || ''),
            skillPrompt: builtinMatch?.skillPrompt || '',
          };
        })
    : [];

  const isExplicitCombined =
    matchedBuiltins.length > 1 ||
    explicitTagIds.length > 1 ||
    parsedDocxSections.length > 1 ||
    /Use combined report templates:/i.test(customPrompt || '');

  if (isExplicitCombined) {
    let combinedSections: Array<{ name: string; content: string; skillPrompt?: string }> = [];
    if (parsedDocxSections.length > 1) {
      combinedSections = parsedDocxSections;
    } else if (matchedBuiltins.length > 1 && explicitTagIds.length <= matchedBuiltins.length) {
      combinedSections = matchedBuiltins.map(t => ({
        name: t.name,
        content: t.lines && t.lines.length > 0 ? t.lines.join('\n') : (t.content || ''),
        skillPrompt: t.skillPrompt || '',
      }));
    } else {
      const promptNames = parseCombinedNamesFromPrompt(customPrompt);
      const count = Math.max(promptNames.length, matchedBuiltins.length, explicitTagIds.length);
      for (let idx = 0; idx < count; idx++) {
        const name = promptNames[idx] || matchedBuiltins[idx]?.name || explicitTagIds[idx] || `Template ${idx + 1}`;
        const builtinMatch =
          matchedBuiltins.find(b => b.name.toLowerCase() === name.toLowerCase()) ||
          matchedBuiltins[idx];
        combinedSections.push({
          name,
          content:
            (builtinMatch?.lines && builtinMatch.lines.length > 0
              ? builtinMatch.lines.join('\n')
              : builtinMatch?.content) || '',
          skillPrompt: builtinMatch?.skillPrompt || '',
        });
      }
    }

    const templateNames = combinedSections.map(s => s.name).join(' + ');
    const templateContent =
      docxText.length > 0
        ? docxText
        : combinedSections
            .map((t, idx) => {
              return `================================================================================\nTEMPLATE ${idx + 1}: "${t.name}"\n--------------------------------------------------------------------------------\n${t.content}\n${t.skillPrompt ? `CLINICAL SKILL DIRECTIVES FOR THIS SECTION:\n${t.skillPrompt}\n` : ''}`;
            })
            .join('\n\n');

    const templateContextPrompt = `
================================================================================
ACTIVE COMBINED RADIOLOGY REPORT TEMPLATES (${combinedSections.length} TEMPLATES COMBINED):
${combinedSections
  .map((t, idx) => {
    return `--------------------------------------------------------------------------------
TEMPLATE ${idx + 1}: "${t.name}"
BASELINE TEMPLATE CONTENT:
"""
${t.content}
"""
${t.skillPrompt ? `AUTHORITATIVE CLINICAL SKILL & PHRASING DIRECTIVES:\n${t.skillPrompt}` : ''}
`;
  })
  .join('\n')}
================================================================================
CRITICAL MULTI-TEMPLATE COMBINATION & MERGE DIRECTIVES:
1. UNIFIED COHESIVE REPORT: Combine these ${combinedSections.length} templates into a single, comprehensive, seamlessly integrated multi-study report.
   - Maintain the logical clinical order of anatomical regions (e.g. Brain sections followed by Cervical Spine sections; Chest followed by Abdomen and Pelvis).
   - Combine the study title/header into a unified examination title (e.g. "CT SCAN OF BRAIN AND CERVICAL SPINE (PLAIN)").
   - Group Technique / Protocol lines under the Technique section.
2. ACCURATE FINDINGS PLACEMENT: When the doctor dictates findings, accurately place each dictated finding into its corresponding anatomical section across the combined templates (e.g., intracranial/cerebral findings in the brain sections, vertebral/disc findings in the spine sections, pulmonary findings in the lung sections, hepatic findings in the liver section).
   - Prefix only dictated/abnormal or modified lines with 'BOLD::'.
3. NORMAL FINDINGS PRESERVATION: For any anatomical regions from either template where no abnormalities were dictated or where the dictation indicated normal/unremarkable, preserve the complete normal baseline findings verbatim WITHOUT the 'BOLD::' prefix.
4. COMBINED CLINICAL IMPRESSION: Synthesize ONE unified, comprehensive, prioritized IMPRESSION covering all examined regions (format: 'IMPRESSION:###point 1###point 2...'). Prioritize significant acute abnormalities first, followed by incidental findings or normal summaries for the respective regions.
   - Smart Bullet Formatting in Impression:
     * Single-Line / Lead-In Summaries: Statements such as "findings are s/o...", narrative summary paragraphs, or single normal summary sentences now start flush with the beginning of the line without any bullet point (e.g. "IMPRESSION:###Normal study without acute abnormality.").
     * Discrete / Multi-Point Findings: When the impression consists of 2 or more discrete clinical findings, each individual finding is cleanly formatted with bullet points (• Point 1, • Point 2) starting from the left margin (e.g. "IMPRESSION:###• Point 1###• Point 2").
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
    const templateContent = docxText.length > 0 ? docxText : matchedBuiltin.content;
    const templateHtml = docxHtml;
    const templateContextPrompt = `
================================================================================
ACTIVE RADIOLOGY NORMAL REPORT TEMPLATE: "${templateName}"
BASELINE TEMPLATE CONTENT:
"""
${templateContent}
"""
${
  matchedBuiltin.skillPrompt
    ? `
AUTHORITATIVE CLINICAL SKILL & PHRASING DIRECTIVES:
${matchedBuiltin.skillPrompt}
`
    : ''
}
CRITICAL TEMPLATE MERGE DIRECTIVES:
1. BASELINE STRUCTURE: Use the full structure, headings, normal findings, and layout from this "${templateName}" template as the baseline skeleton.
2. NORMAL FINDINGS PRESERVATION: If the doctor's audio dictation states "normal", "all normal", "scan is normal", "unremarkable", or does not mention changes for any anatomical section, PRESERVE and output the complete normal findings for that section verbatim WITHOUT the 'BOLD::' prefix.
3. ABNORMAL / DICTATED FINDINGS MERGING: When the doctor dictates specific abnormal findings, observations, or modifications, merge them into the corresponding template sections and prefix only those dictated/abnormal lines with 'BOLD::'.
4. NEW FINDINGS: Any new findings dictated that are not covered in the template should be inserted in the appropriate clinical location with 'BOLD::'.
5. IMPRESSION: Synthesize an accurate, comprehensive IMPRESSION based on all findings (normal and abnormal) in the format 'IMPRESSION:###point 1###point 2...'.
   - Smart Bullet Formatting in Impression:
     * Single-Line / Lead-In Summaries: Statements such as "findings are s/o...", narrative summary paragraphs, or single normal summary sentences now start flush with the beginning of the line without any bullet point (e.g. "IMPRESSION:###Normal study without acute abnormality.").
     * Discrete / Multi-Point Findings: When the impression consists of 2 or more discrete clinical findings, each individual finding is cleanly formatted with bullet points (• Point 1, • Point 2) starting from the left margin (e.g. "IMPRESSION:###• Point 1###• Point 2").
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
    const promptTemplateName = parseSingleTemplateNameFromPrompt(customPrompt);
    const templateName =
      promptTemplateName ||
      (customDocx.name ? customDocx.name.replace(/\.[^/.]+$/, '').replace(/^\d+[-_ ]*/, '') : 'Uploaded DOCX Template');
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
    const explicitPromptName = parseSingleTemplateNameFromPrompt(customPrompt);
    const promptTextTrimmed = customPrompt?.trim() || '';
    return {
      isTemplateMode: true,
      templateType: 'image',
      templateName: explicitPromptName || 'Visual Image Template',
      templateContent: promptTextTrimmed || undefined,
      userInstructions: promptTextTrimmed,
      templateContextPrompt: `
================================================================================
ACTIVE VISUAL TEMPLATE: The user has provided ${customImages.length} image(s) of a report template${explicitPromptName ? ` ("${explicitPromptName}")` : ''}.
Use them as a strict visual guide for the layout, sections, and formatting of the final report.
${promptTextTrimmed ? `ADDITIONAL TEMPLATE CONTEXT:\n${promptTextTrimmed}\n` : ''}
Populate the template with findings from the dictation. Normal sections without abnormal dictations should be populated with standard normal template findings without BOLD::.
Prefix dictated/abnormal lines with 'BOLD::'.
================================================================================
`,
    };
  }

  // 3. Text Prompt Analysis (Custom text template)
  if (customPrompt && customPrompt.trim().length > 0) {
    const trimmed = customPrompt.trim();

    const hasTemplateIdTag = explicitTagIds.length > 0;
    const hasTemplateKeyword =
      hasTemplateIdTag ||
      /(template|report template|normal report|standard report|merge with|integrate into template|normal template|use template|format as template|merge dictation)/i.test(
        trimmed
      );

    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const hasRadiologyHeaders =
      /(TECHNIQUE|FINDINGS|IMPRESSION|CLINICAL PROFILE|CLINICAL HISTORY|INDICATION|COMPARISON|PROTOCOL|OBSERVATIONS):/i.test(
        trimmed
      );
    const hasMultipleOrganSections = (trimmed.match(/([A-Z][a-zA-Z\s]{2,25}):\s+[A-Z]/g) || []).length >= 2;
    const isMultiLineTemplate =
      lines.length >= 3 && (hasRadiologyHeaders || hasMultipleOrganSections || hasTemplateKeyword || trimmed.length > 80);

    if (hasTemplateKeyword || hasRadiologyHeaders || isMultiLineTemplate) {
      const templateContent = trimmed;
      const explicitName = parseSingleTemplateNameFromPrompt(trimmed);
      const templateName =
        explicitName || (lines[0] && lines[0].length < 60 ? lines[0].replace(/^#+\s*/, '') : 'Custom Text Template');
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

const UNIT_OR_TEEN_PATTERN = `(?:zero|oh|o|one|won|two|to|too|three|four|for|five|six|seven|eight|ate|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)`;
const TENS_WORD_PATTERN = `(?:twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)`;
const SPOKEN_NUM_PHRASE = `(?:(?:one|two|three)\\s+hundred(?:\\s+and)?(?:\\s+${TENS_WORD_PATTERN})?(?:[\\s-]+${UNIT_OR_TEEN_PATTERN})?|(?:one|two|three)[\\s-]+(?:${TENS_WORD_PATTERN}(?:[\\s-]+${UNIT_OR_TEEN_PATTERN})?|${UNIT_OR_TEEN_PATTERN}(?:[\\s-]+${UNIT_OR_TEEN_PATTERN})?)|${TENS_WORD_PATTERN}(?:[\\s-]+${UNIT_OR_TEEN_PATTERN})?|${UNIT_OR_TEEN_PATTERN}|\\d+)`;
const SPOKEN_JOINER = `(?:[\\s_-]*(?:underscore|under\\s+score|dash|hyphen)[\\s_-]*|[\\s_-]+)`;
const ADD_ID_ATOM_PATTERN = `(?:(?:builtin_)?(?:tpl[\\s_-]*)?add${SPOKEN_JOINER}${SPOKEN_NUM_PHRASE})`;
const CUSTOM_ID_ATOM_PATTERN = `(?:(?:see|sea|custom|c)(?:[\\s_-]*\\d+|${SPOKEN_JOINER}(?:${TENS_WORD_PATTERN}(?:[\\s-]+${UNIT_OR_TEEN_PATTERN})?|${UNIT_OR_TEEN_PATTERN})))`;
const ID_ATOM_PATTERN = `(?:${ADD_ID_ATOM_PATTERN}|(?:builtin_)?(?:tpl_|cust_|template_)\\d+|${CUSTOM_ID_ATOM_PATTERN}|${SPOKEN_NUM_PHRASE})`;

const SPOKEN_UNIT_WORDS: Record<string, string> = {
  zero: '0',
  oh: '0',
  o: '0',
  one: '1',
  won: '1',
  two: '2',
  to: '2',
  too: '2',
  three: '3',
  four: '4',
  for: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  ate: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
};

const SPOKEN_TENS_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function parseSpokenDigitsOrNumber(phrase: string): string | null {
  const clean = phrase.trim().toLowerCase().replace(/[-\s]+/g, ' ');
  if (!clean) return null;
  if (/^\d+$/.test(clean)) return String(parseInt(clean, 10));
  const tokens = clean.split(' ').filter(t => t && t !== 'and');
  if (tokens.length === 0) return null;

  if (!tokens.includes('hundred')) {
    const first = SPOKEN_UNIT_WORDS[tokens[0]] !== undefined ? parseInt(SPOKEN_UNIT_WORDS[tokens[0]], 10) : NaN;
    if (tokens.length === 3 && !isNaN(first) && first >= 0 && first <= 9) {
      const sTen = SPOKEN_TENS_WORDS[tokens[1]];
      const sOne = SPOKEN_UNIT_WORDS[tokens[1]] !== undefined ? parseInt(SPOKEN_UNIT_WORDS[tokens[1]], 10) : NaN;
      const tOne = SPOKEN_UNIT_WORDS[tokens[2]] !== undefined ? parseInt(SPOKEN_UNIT_WORDS[tokens[2]], 10) : NaN;
      if (first >= 1 && sTen !== undefined && !isNaN(tOne) && tOne >= 1 && tOne <= 9) {
        return String(first * 100 + sTen + tOne);
      }
      if (!isNaN(sOne) && sOne >= 0 && sOne <= 9 && !isNaN(tOne) && tOne >= 0 && tOne <= 9) {
        return String(first * 100 + sOne * 10 + tOne);
      }
    }
    if (tokens.length === 2 && !isNaN(first) && first >= 1 && first <= 9) {
      const sTen = SPOKEN_TENS_WORDS[tokens[1]];
      const sTeen = SPOKEN_UNIT_WORDS[tokens[1]] !== undefined ? parseInt(SPOKEN_UNIT_WORDS[tokens[1]], 10) : NaN;
      if (sTen !== undefined) return String(first * 100 + sTen);
      if (!isNaN(sTeen) && sTeen >= 10 && sTeen <= 19) return String(first * 100 + sTeen);
    }
  }

  let total = 0;
  let current = 0;
  for (const tok of tokens) {
    if (SPOKEN_UNIT_WORDS[tok] !== undefined) {
      current += parseInt(SPOKEN_UNIT_WORDS[tok], 10);
    } else if (SPOKEN_TENS_WORDS[tok] !== undefined) {
      current += SPOKEN_TENS_WORDS[tok];
    } else if (tok === 'hundred') {
      current = (current === 0 ? 1 : current) * 100;
    } else if (/^\d+$/.test(tok)) {
      current += parseInt(tok, 10);
    } else {
      return null;
    }
  }
  total += current;
  return total > 0 ? String(total) : null;
}

function splitSpokenIdList(rawSegment: string): string[] {
  if (!rawSegment) return [];
  const protectedText = rawSegment
    .replace(/\bhundred\s+and\b/gi, 'hundred__and')
    .replace(/\b(?:template\s+(?:ids?|numbers?|no\.?)|templates?)\s*[:#-]*/gi, ',')
    .replace(/\b(?:and|also|plus|with|&|\+)\b/gi, ',');
  const rawTokens = protectedText
    .split(/[,;]+/)
    .map(t => t.replace(/hundred__and/g, 'hundred and').trim())
    .filter(Boolean);

  const ids: string[] = [];
  for (const tok of rawTokens) {
    const subMatches = [...tok.matchAll(new RegExp(ID_ATOM_PATTERN, 'gi'))].map(m => m[0].trim()).filter(Boolean);
    const candidates = subMatches.length > 0 ? subMatches : [tok];
    for (let candidate of candidates) {
      const addPrefixed = candidate.match(
        /^(?:builtin_)?(?:tpl[\s_-]*)?add(?:[\s_-]*(?:underscore|under\s+score|dash|hyphen)[\s_-]*|[\s_-]+)(.+)$/i
      );
      if (addPrefixed) {
        const tail = addPrefixed[1].trim();
        const numParsed = parseSpokenDigitsOrNumber(tail);
        candidate = numParsed ? `add_${numParsed.padStart(3, '0')}` : `add_${tail.replace(/\s+/g, '_')}`;
      } else {
        const customPrefixed = candidate.match(/^(?:see|sea|custom|c)[\s-]+(.+)$/i);
        if (customPrefixed) {
          const tail = customPrefixed[1].trim().toLowerCase();
          candidate = /^\d+$/.test(tail)
            ? `C${tail}`
            : SPOKEN_UNIT_WORDS[tail]
              ? `C${SPOKEN_UNIT_WORDS[tail]}`
              : `C ${tail}`;
        }
      }
      if (candidate && !ids.some(x => x.toLowerCase() === candidate.toLowerCase())) {
        ids.push(candidate);
      }
    }
  }
  return ids;
}

/**
 * Detects and extracts spoken template ID directive token(s): {template id [ID]} or spoken "template id X and Y".
 * Supports numeric IDs, supplemental "add_XXX" / "add XXX" IDs, custom C-IDs, and multiple combined IDs.
 */
export function extractSpokenTemplateDirective(findings: string[]): {
  templateId: string | null;
  templateIds: string[];
  mode: 'add' | 'replace';
  cleanedFindings: string[];
} {
  if (!findings || findings.length === 0) {
    return { templateId: null, templateIds: [], mode: 'add', cleanedFindings: [] };
  }

  const detectedIds: string[] = [];
  let mode: 'add' | 'replace' = 'add';
  const cleaned: string[] = [];

  const listTailPattern =
    `(` +
    ID_ATOM_PATTERN +
    `(?:\\s*(?:,|;|&|\\+|\\band\\b|\\balso\\b|\\bwith\\b)\\s*(?:(?:template\\s+(?:ids?|numbers?|no\\.?)\\s*[:\\s#-]*))?` +
    ID_ATOM_PATTERN +
    `)*)`;

  const bracedTemplateRegex =
    /\{\s*((?:add|use|apply|insert|combine|switch(?:\s+to)?|change(?:\s+to)?|replace(?:\s+with)?|merge(?:\s+with)?)\s+)?template(?:s|\s+ids?|\s+numbers?|\s+no\.?)?\s*[:\s#-]*([a-zA-Z0-9_,\-&\+\s]+?)\s*\}\.?/gi;
  const bracedPrefixedIdRegex =
    /\{\s*((?:use|apply|add|merge(?:\s+with)?)?\s*)?((?:(?:builtin_)?(?:tpl[\s_-]*)?add[\s_-]*\d+|tpl_\d+|c\d+)(?:\s*(?:,|;|&|\+|\band\b)\s*[a-zA-Z0-9_\s-]+)*)\s*\}\.?/gi;

  const unbracedRegex = new RegExp(
    `(?:^|\\b)((?:add|use|apply|insert|combine|also\\s+(?:add|use)|switch(?:\\s+to)?|change(?:\\s+to)?|replace(?:\\s+with)?|merge(?:\\s+with)?)\\s+)?(?:template(?:s)?\\s+(?:ids?|numbers?|no\\.?)|combined\\s+templates?)\\s*[:\\s#-]*` +
      listTailPattern +
      `\\b\\.?`,
    'gi'
  );
  const explicitPrefixedTagRegex = new RegExp(
    `(?:^|\\b)((?:add|use|apply|insert|combine|also\\s+(?:add|use)|switch(?:\\s+to)?|change(?:\\s+to)?|replace(?:\\s+with)?|merge(?:\\s+with)?)\\s+)?(?:template\\s+(?:` +
      ADD_ID_ATOM_PATTERN +
      `|` +
      CUSTOM_ID_ATOM_PATTERN +
      `|(?:builtin_)?(?:tpl_|cust_)\\d+)|(?:tpl_add_\\d+|add_\\d+|add_(?:${UNIT_OR_TEEN_PATTERN}|${TENS_WORD_PATTERN})))(?:\\s*(?:,|;|&|\\+|\\band\\b|\\balso\\b|\\bwith\\b)\\s*(?:template(?:\\s+(?:ids?|numbers?|no\\.?))?\\s*[:\\s#-]*)?` +
      ID_ATOM_PATTERN +
      `)*\\b\\.?`,
    'gi'
  );

  const candidateRegexes: Array<{ regex: RegExp; rawTokenGroupIndex: number }> = [
    { regex: bracedTemplateRegex, rawTokenGroupIndex: 2 },
    { regex: bracedPrefixedIdRegex, rawTokenGroupIndex: 2 },
    { regex: unbracedRegex, rawTokenGroupIndex: 2 },
    { regex: explicitPrefixedTagRegex, rawTokenGroupIndex: 99 },
  ];

  for (const rawFinding of findings) {
    if (!rawFinding) continue;
    const isBold = /^BOLD::/i.test(rawFinding);
    let working = rawFinding.replace(/^BOLD::/i, '').trim();

    const rawMatches: Array<{ start: number; end: number; verb: string; idSegment: string }> = [];
    for (const { regex, rawTokenGroupIndex } of candidateRegexes) {
      regex.lastIndex = 0;
      for (const m of working.matchAll(regex)) {
        if (m.index === undefined) continue;
        const full = m[0];
        const idSegment =
          (m[rawTokenGroupIndex] !== undefined
            ? m[rawTokenGroupIndex]
            : full
                .replace(/^[\{\s]+/, '')
                .replace(/[\}\s]+$/, '')
                .replace(
                  /^(?:add|use|apply|insert|combine|also\s+(?:add|use)|switch(?:\s+to)?|change(?:\s+to)?|replace(?:\s+with)?|merge(?:\s+with)?)\s+/i,
                  ''
                )
                .replace(/^(?:template(?:s)?\s+(?:ids?|numbers?|no\.?)?\s*[:\s#-]*)/i, '')) || '';
        rawMatches.push({
          start: m.index,
          end: m.index + full.length,
          verb: (m[1] || '').toLowerCase(),
          idSegment,
        });
      }
    }

    if (rawMatches.length > 0) {
      rawMatches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
      const accepted: typeof rawMatches = [];
      for (const item of rawMatches) {
        const prev = accepted[accepted.length - 1];
        if (prev && item.start < prev.end) continue;
        accepted.push(item);
      }

      for (const item of accepted) {
        if (/(?:switch|change|replace)/i.test(item.verb)) {
          mode = 'replace';
        }
        const ids = splitSpokenIdList(item.idSegment);
        for (const id of ids) {
          if (!detectedIds.some(existing => existing.toLowerCase() === id.toLowerCase())) {
            detectedIds.push(id);
          }
        }
      }

      for (let idx = accepted.length - 1; idx >= 0; idx--) {
        const span = accepted[idx];
        working = `${working.slice(0, span.start)} ${working.slice(span.end)}`;
      }

      const stripped = working
        .replace(/\s+/g, ' ')
        .replace(/^[:\s\-.,;]+/, '')
        .replace(/[:\s\-.,;]+$/, '')
        .trim();
      if (stripped.length > 0 && !/^(?:please|and|also|instead)$/i.test(stripped)) {
        cleaned.push(isBold ? `BOLD::${stripped}` : stripped);
      }
    } else {
      cleaned.push(rawFinding);
    }
  }

  return {
    templateId: detectedIds[0] || null,
    templateIds: detectedIds,
    mode,
    cleanedFindings: cleaned,
  };
}

/**
 * Parses a multi-patient divider line such as:
 * - "BOLD::--- PATIENT 2 REPORT ---"
 * - "--- PATIENT 2: John Doe ---"
 * - "PATIENT 2 REPORT: Jane Smith"
 */
export function parsePatientSeparatorLine(line: string): {
  isSeparator: boolean;
  patientNumber?: number;
  patientName?: string;
  rawLabel?: string;
} {
  if (!line || typeof line !== 'string') return { isSeparator: false };
  const clean = line.replace(/^BOLD::/i, '').trim();
  if (!clean) return { isSeparator: false };

  const dashedMatch = clean.match(/^-{2,}\s*PATIENT\b([\s\S]*?)\s*-{2,}$/i);
  if (dashedMatch) {
    const body = (dashedMatch[1] || '').replace(/^[:\s#-]+/, '').trim();
    if (!body || /^REPORT$/i.test(body)) {
      return { isSeparator: true };
    }
    const numAndRest = body.match(/^(\d+)(?:\s+REPORT)?(?:\s*[:\-]\s*(.+)|\s+\((.+)\))?$/i);
    if (numAndRest) {
      const patientNumber = parseInt(numAndRest[1], 10);
      const detail = (numAndRest[2] || numAndRest[3] || '').replace(/^REPORT\s*[:\-]?\s*/i, '').trim();
      const patientName = detail && !/^REPORT$/i.test(detail) ? detail : undefined;
      return {
        isSeparator: true,
        patientNumber: !isNaN(patientNumber) ? patientNumber : undefined,
        patientName,
      };
    }
    return {
      isSeparator: true,
      patientName: body,
    };
  }

  const plainHeaderMatch = clean.match(/^PATIENT\s+(\d+)\s*(?:REPORT(?:\s*[:\-]\s*(.+))?|:\s*(.+))$/i);
  if (plainHeaderMatch && clean.length <= 100 && !clean.endsWith('.')) {
    const patientNumber = parseInt(plainHeaderMatch[1], 10);
    const detail = (plainHeaderMatch[2] || plainHeaderMatch[3] || '').trim();
    return {
      isSeparator: true,
      patientNumber: !isNaN(patientNumber) ? patientNumber : undefined,
      patientName: detail && !/^REPORT$/i.test(detail) ? detail : undefined,
    };
  }

  return { isSeparator: false };
}

function isLikelyExamTitleStart(line: string): boolean {
  const clean = line.replace(/^BOLD::/i, '').replace(/[*_~`#]+/g, '').trim();
  if (!clean || clean.length >= 110 || clean.endsWith('.')) return false;
  if (/^(?:IMPRESSION|TECHNIQUE|CLINICAL\s*(?:PROFILE|HISTORY))/i.test(clean)) return false;
  if (/^(?:MRI|M\.R\.I\.|MR|CT|C\.?T\.?|USG|ULTRASOUND|X-?RAY|NCCT|CECT|HRCT|PET-?CT|PET\/CT|DEXA|MAMMOGRAM)\b/i.test(clean)) {
    return true;
  }
  if (/^(?:PLAIN|CONTRAST|NON-?CONTRAST|CONTRAST\s+ENHANCED|HIGH\s+RESOLUTION|SCAN\s+OF|STUDY\s+OF|EXAMINATION\s+OF)\b/i.test(clean)) {
    return true;
  }
  if (/VIEW\s*$/i.test(clean) && clean.length < 80) return true;
  return clean === clean.toUpperCase() && clean.length > 4;
}

/**
 * Splits a flat findings array containing 1 or more patients into structured per-patient segments.
 * Strips per-patient `{template id ...}` directives into `segment.templateIds` while preserving
 * each patient's own exam title, clinical profile, findings, and IMPRESSION cleanly.
 */
export function splitMultiPatientFindings(findings: string[]): PatientReportSegment[] {
  if (!findings || !Array.isArray(findings) || findings.length === 0) {
    return [];
  }

  const normalized = findings.map(f => (typeof f === 'string' ? f.trim() : '')).filter(Boolean);
  if (normalized.length === 0) return [];

  interface RawChunk {
    patientNumber?: number;
    patientName?: string;
    lines: string[];
  }

  const chunks: RawChunk[] = [];
  let current: RawChunk | null = null;
  let sawExplicitSeparator = false;

  for (const line of normalized) {
    const sep = parsePatientSeparatorLine(line);
    if (sep.isSeparator) {
      sawExplicitSeparator = true;
      if (current && current.lines.length > 0) {
        chunks.push(current);
      }
      current = {
        patientNumber: sep.patientNumber,
        patientName: sep.patientName,
        lines: [],
      };
      continue;
    }

    if (!current) {
      current = { lines: [] };
    }
    current.lines.push(line);
  }

  if (current && current.lines.length > 0) {
    chunks.push(current);
  }

  // Fallback split only if no explicit separator lines existed AND multiple IMPRESSION sections appear
  if (!sawExplicitSeparator && chunks.length === 1) {
    const lines = chunks[0].lines;
    const impressionIndices = lines
      .map((l, idx) => (/^(?:BOLD::\s*)?IMPRESSION:/i.test(l) ? idx : -1))
      .filter(idx => idx >= 0);

    if (impressionIndices.length >= 2) {
      const splitChunks: RawChunk[] = [];
      let startIdx = 0;
      for (let i = 0; i < impressionIndices.length - 1; i++) {
        const impIdx = impressionIndices[i];
        const nextLine = lines[impIdx + 1];
        if (
          nextLine &&
          (isLikelyExamTitleStart(nextLine) ||
            /^\*?\s*Clinical\s*(?:Profile|History):/i.test(nextLine.replace(/^BOLD::/i, '').trim()) ||
            extractSpokenTemplateDirective([nextLine]).templateIds.length > 0)
        ) {
          splitChunks.push({ lines: lines.slice(startIdx, impIdx + 1) });
          startIdx = impIdx + 1;
        }
      }
      if (startIdx < lines.length) {
        splitChunks.push({ lines: lines.slice(startIdx) });
      }
      if (splitChunks.length > 1) {
        chunks.splice(0, chunks.length, ...splitChunks);
      }
    }
  }

  return chunks.map((chunk, idx) => {
    const n = chunk.patientNumber ?? idx + 1;
    const { templateIds, cleanedFindings } = extractSpokenTemplateDirective(chunk.lines);
    const cleanName = chunk.patientName?.trim();
    const label = cleanName
      ? (/^patient\b/i.test(cleanName) ? cleanName : `Patient ${n}: ${cleanName}`)
      : `Patient ${n}`;

    return {
      id: `patient_${idx + 1}`,
      label,
      ...(cleanName ? { patientName: cleanName } : {}),
      ...(templateIds.length > 0 ? { templateIds } : {}),
      findings: cleanedFindings.length > 0 ? cleanedFindings : chunk.lines,
    };
  });
}

/**
 * Joins multiple patient segments back into a flat `string[]` report with clear
 * `BOLD::--- PATIENT N ... ---` dividers so flat callers and `splitMultiPatientFindings`
 * stay 100% round-trip compatible.
 */
export function joinMultiPatientFindings(
  segments: Array<Pick<PatientReportSegment, 'patientName' | 'findings'>>
): string[] {
  if (!segments || segments.length === 0) return [];
  if (segments.length === 1) {
    return [...segments[0].findings];
  }
  const combined: string[] = [];
  segments.forEach((seg, idx) => {
    const num = idx + 1;
    const hasCustomHeader = idx === 0 && Boolean(seg.patientName);
    if (idx > 0 || hasCustomHeader) {
      const headerText = seg.patientName
        ? `BOLD::--- PATIENT ${num}: ${seg.patientName} ---`
        : `BOLD::--- PATIENT ${num} REPORT ---`;
      combined.push(headerText);
    }
    combined.push(...seg.findings);
  });
  return combined;
}
