/**
 * Smart Dictation & Medical Vocabulary Biasing Engine
 * Inspired by Gemini 3.5 Transcribe Smart Dictation & Custom Vocabulary Biasing
 */
import { applyCustomVocabularyRules, matchSpokenVoiceMacro } from './macroDictionaryService';

// Comprehensive medical & radiology terminology phonetic biasing map
export const MEDICAL_VOCABULARY_BIASING_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // Common speech recognizer mishearings in radiology
  { pattern: /\b(calories\s+motor\s+in\s+the|calories\s+noted\s+in\s+the|calories\s+in\s+the)\b/gi, replacement: 'calculus noted in the' },
  { pattern: /\b(calories\s+motor|calories\s+noted)\b/gi, replacement: 'calculus noted' },
  { pattern: /\b(calories\s+size|size\s+calories)\b/gi, replacement: 'calculus size' },
  { pattern: /\b(calories)\b(?=\s+(?:noted|seen|measuring|measures|in\s+the|at\s+the|within|size|of\s+size|\d+))/gi, replacement: 'calculus' },
  { pattern: /(?<=(?:renal|kidney|gallbladder|gall\s*bladder|gb|urinary|bladder|ureteric|ureter|biliary|duct|cbd|pelvis|calyx|calyceal)\s+)\bcalories\b/gi, replacement: 'calculus' },
  { pattern: /(?<=\d+(?:\.\d+)?\s*(?:mm|cm|x\s*\d+\s*(?:mm|cm))\s+(?:size\s+)?)\bcalories\b/gi, replacement: 'calculus' },
  { pattern: /\b(gall\s+ladder|call\s+ladder|gall\s*ladder)\b/gi, replacement: 'gallbladder' },
  { pattern: /\b(urinary\s+ladder)\b/gi, replacement: 'urinary bladder' },
  { pattern: /\b(call\s+bladder)\b/gi, replacement: 'gallbladder' },
  { pattern: /\b(call\s*stones?)\b/gi, replacement: 'gallstone' },
  { pattern: /\b(liver\s+sis|liver\s+cyst|liver\s+cysts)\b/gi, replacement: 'hepatic cyst' },
  { pattern: /\b(kidney\s+sis|renal\s+sis)\b/gi, replacement: 'renal cyst' },
  { pattern: /\b(hydro\s*nephrosis|hydra\s*nephrosis)\b/gi, replacement: 'hydronephrosis' },
  { pattern: /\b(chole\s*cystitis)\b/gi, replacement: 'cholecystitis' },
  { pattern: /\b(chole\s*lithiasis)\b/gi, replacement: 'cholelithiasis' },
  { pattern: /\b(choledo\s*cho\s*lithiasis|choledo\s*cholithiasis)\b/gi, replacement: 'choledocholithiasis' },
  { pattern: /\b(nephro\s*lithiasis)\b/gi, replacement: 'nephrolithiasis' },
  { pattern: /\b(lymph\s*adenopathy)\b/gi, replacement: 'lymphadenopathy' },
  { pattern: /\b(spleno\s*megaly)\b/gi, replacement: 'splenomegaly' },
  { pattern: /\b(hepato\s*megaly)\b/gi, replacement: 'hepatomegaly' },
  { pattern: /\b(cardio\s*megaly)\b/gi, replacement: 'cardiomegaly' },
  { pattern: /\b(sub\s*dural)\b/gi, replacement: 'subdural' },
  { pattern: /\b(extra\s*dural)\b/gi, replacement: 'extradural' },
  { pattern: /\b(intra\s*cranial)\b/gi, replacement: 'intracranial' },
  { pattern: /\b(intra\s*axial)\b/gi, replacement: 'intra-axial' },
  { pattern: /\b(extra\s*axial)\b/gi, replacement: 'extra-axial' },
  { pattern: /\b(c\s*\.?\s*p\s*\.?\s*angles?|cp\s*angles?)\b/gi, replacement: 'C.P. angle' },
  { pattern: /\b(c\s*\.?\s*t\s*\.?\s*scan|ct\s*scan)\b/gi, replacement: 'CT scan' },
  { pattern: /\b(m\s*\.?\s*r\s*\.?\s*i|mri\s*scan)\b/gi, replacement: 'MRI' },
  { pattern: /\b(u\s*\.?\s*s\s*\.?\s*g|usg\s*scan)\b/gi, replacement: 'USG' },
  { pattern: /\b(p\s*a\s*view|pa\s*view)\b/gi, replacement: 'PA view' },
  { pattern: /\b(a\s*p\s*view|ap\s*view)\b/gi, replacement: 'AP view' },
];

/**
 * Standard medical abbreviations & dimension formatting
 */
export function formatMedicalAbbreviations(text: string): string {
  let formatted = text;

  formatted = formatted
    .replace(/\b(status\s+post|s\/p)\b/gi, 'S/p')
    .replace(/\b(complaints\s+of|c\/o)\b/gi, 'C/o')
    .replace(/\b(history\s+of|h\/o)\b/gi, 'H/o')
    .replace(/\b(right\s+more\s+than\s+left|r\s*>\s*l)\b/gi, '(R > L)')
    .replace(/\b(left\s+more\s+than\s+right|l\s*>\s*r)\b/gi, '(L > R)');

  // Dimensions formatting: "16 by 17 mm" -> "16 x 17 mm", "3.5 by 2.1 by 1.8 cm" -> "3.5 x 2.1 x 1.8 cm"
  formatted = formatted.replace(
    /(\d+(?:\.\d+)?)\s*(?:by|into|x|\*)\s*(\d+(?:\.\d+)?)\s*(?:by|into|x|\*)\s*(\d+(?:\.\d+)?)\s*(cm|mm|m)\b/gi,
    '$1 x $2 x $3 $4'
  );
  formatted = formatted.replace(
    /(\d+(?:\.\d+)?)\s*(?:by|into|x|\*)\s*(\d+(?:\.\d+)?)\s*(cm|mm|m)\b/gi,
    '$1 x $2 $3'
  );

  return formatted;
}

/**
 * Apply medical vocabulary biasing & phonetic corrections
 */
export function applyMedicalBiasing(text: string): string {
  let result = text;
  for (const rule of MEDICAL_VOCABULARY_BIASING_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  result = applyCustomVocabularyRules(result);
  return formatMedicalAbbreviations(result);
}

/**
 * Clean Voice commands for punctuation & symbols (never leaves voice words in sentence)
 */
export function applyVoicePunctuation(text: string): string {
  if (!text) return '';

  let cleaned = text
    .replace(/\b(full stop|period|dot)\b/gi, '.')
    .replace(/\b(comma)\b/gi, ',')
    .replace(/\b(colon)\b/gi, ':')
    .replace(/\b(semi-colon|semicolon)\b/gi, ';')
    .replace(/\b(question mark)\b/gi, '?')
    .replace(/\b(open bracket|open parenthesis|open paren)\b/gi, ' (')
    .replace(/\b(close bracket|close parenthesis|close paren)\b/gi, ') ')
    .replace(/\b(hyphen|dash)\b/gi, ' - ')
    .replace(/\b(forward slash|slash)\b/gi, '/')
    .replace(/\b(percent|percentage)\b/gi, '%')
    .replace(/\b(degrees?)\b/gi, '°')
    .replace(/\b(plus minus|plus or minus)\b/gi, ' ± ')
    .replace(/\b(greater than)\b/gi, ' > ')
    .replace(/\b(less than)\b/gi, ' < ');

  // Clean spacing around punctuation
  cleaned = cleaned
    .replace(/\s+([,.:;?!%°\)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ');

  return cleaned;
}

export interface VoiceCommandExecutionResult {
  action: 'DELIMITER_NEW_LINE' | 'DELIMITER_IMPRESSION' | 'DELIMITER_CLINICAL_PROFILE' | 'DELIMITER_TECHNIQUE' | 'DELETE_LAST_FINDING' | 'DELETE_LAST_WORD' | 'CLEAR_ALL' | 'SELF_CORRECTION' | 'MARK_BOLD' | 'INSERT_MACRO' | 'NONE';
  remainingText: string;
  description?: string;
  target?: string;
  replacement?: string;
  expandedFindings?: string[];
}

/**
 * Evaluate if an utterance is an isolated voice command or starts with one.
 */
export function evaluateVoiceCommand(utterance: string): VoiceCommandExecutionResult {
  const trimmed = utterance.trim();
  if (!trimmed) {
    return { action: 'NONE', remainingText: '' };
  }

  // 0. SPOKEN VOICE MACRO TRIGGER
  const macroMatch = matchSpokenVoiceMacro(trimmed);
  if (macroMatch) {
    return {
      action: 'INSERT_MACRO',
      remainingText: macroMatch.expandedFindings.join('\n'),
      expandedFindings: macroMatch.expandedFindings,
      description: `Inserted macro "${macroMatch.matchedMacro.name}"`,
    };
  }

  // 1. DELETE / CLEAR COMMANDS
  if (/^(?:delete last finding|delete last line|remove last finding|remove last line|delete previous finding|clear last finding|delete that finding)\.?$/i.test(trimmed)) {
    return { action: 'DELETE_LAST_FINDING', remainingText: '', description: 'Deleted last finding' };
  }

  if (/^(?:clear all|delete all|start over|clear report|erase report)\.?$/i.test(trimmed)) {
    return { action: 'CLEAR_ALL', remainingText: '', description: 'Cleared all findings' };
  }

  if (/^(?:delete last word|remove last word|backspace)\.?$/i.test(trimmed)) {
    return { action: 'DELETE_LAST_WORD', remainingText: '', description: 'Deleted last word' };
  }

  if (/^(?:scratch that|delete that|undo that|undo|strike that|cancel that|forget that|erase that)\.?$/i.test(trimmed)) {
    return { action: 'DELETE_LAST_WORD', remainingText: '', description: 'Undid last phrase' };
  }

  // 2. MARK BOLD COMMAND
  if (/^(?:mark as bold|make it bold|bold that|make this bold|bold this)\.?$/i.test(trimmed)) {
    return { action: 'MARK_BOLD', remainingText: '', description: 'Marked as bold' };
  }

  // 3. STRUCTURAL BREAKS AT THE START OF PHRASE
  // E.g. "next line liver is normal" -> action: DELIMITER_NEW_LINE, remaining: "liver is normal"
  const nextLineMatch = trimmed.match(/^(?:move to the next line|move to next line|go to the next line|go to next line|next line|new line|line break|new paragraph|next paragraph|new finding|next finding|separate finding|next point|new point|add finding|another finding|new bullet|next bullet)\s*[:,\.]?\s*(.*)$/i);
  if (nextLineMatch) {
    return { action: 'DELIMITER_NEW_LINE', remainingText: nextLineMatch[1].trim(), description: 'Started new finding' };
  }

  // Impression section
  const impressionMatch = trimmed.match(/^(?:impression section|start impression|new impression|impression|final impression|conclusion section|start conclusion|conclusion)\s*[:,\.]?\s*(.*)$/i);
  if (impressionMatch) {
    return { action: 'DELIMITER_IMPRESSION', remainingText: impressionMatch[1].trim(), description: 'Started Impression section' };
  }

  // Clinical profile
  const clinicalMatch = trimmed.match(/^(?:clinical profile|start clinical profile|patient history|clinical history|indication)\s*[:,\.]?\s*(.*)$/i);
  if (clinicalMatch) {
    return { action: 'DELIMITER_CLINICAL_PROFILE', remainingText: clinicalMatch[1].trim(), description: 'Started Clinical Profile' };
  }

  // Technique
  const techniqueMatch = trimmed.match(/^(?:technique section|technique|protocol)\s*[:,\.]?\s*(.*)$/i);
  if (techniqueMatch) {
    return { action: 'DELIMITER_TECHNIQUE', remainingText: techniqueMatch[1].trim(), description: 'Started Technique section' };
  }

  // 4. SELF-CORRECTION (e.g. "it is not calories calculus", "replace left with right")
  const notPatternMatch = trimmed.match(
    /^(?:it is not|it's not|no not|not)\s+([a-z0-9\s\.\-]+?)\s+(?:it is|it's|,|comma|meaning|instead)?\s*([a-z0-9\s\.\-]+)$/i
  );
  if (notPatternMatch) {
    return {
      action: 'SELF_CORRECTION',
      remainingText: '',
      target: applyVoicePunctuation(notPatternMatch[1]).trim(),
      replacement: applyMedicalBiasing(applyVoicePunctuation(notPatternMatch[2])).trim(),
      description: `Corrected to "${notPatternMatch[2].trim()}"`
    };
  }

  const replaceMatch = trimmed.match(
    /^(?:replace|change|correct|modify)\s+([a-z0-9\s\.\-]+?)\s+(?:with|to|by|into)\s+([a-z0-9\s\.\-]+)$/i
  );
  if (replaceMatch) {
    return {
      action: 'SELF_CORRECTION',
      remainingText: '',
      target: applyVoicePunctuation(replaceMatch[1]).trim(),
      replacement: applyMedicalBiasing(applyVoicePunctuation(replaceMatch[2])).trim(),
      description: `Changed to "${replaceMatch[2].trim()}"`
    };
  }

  const actuallyMatch = trimmed.match(/^(?:actually|i mean|correction)\s+([a-z0-9\s\.\-]+)$/i);
  if (actuallyMatch) {
    return {
      action: 'SELF_CORRECTION',
      remainingText: '',
      target: '',
      replacement: applyMedicalBiasing(applyVoicePunctuation(actuallyMatch[1])).trim(),
      description: `Corrected to "${actuallyMatch[1].trim()}"`
    };
  }

  return { action: 'NONE', remainingText: trimmed };
}

export interface SelfCorrectionResult {
  updatedText: string;
  isHandled: boolean;
  correctionDescription?: string;
}

/**
 * Smart self-correction handler for modifying in-flight text.
 */
export function processSelfCorrection(currentText: string, utterance: string): SelfCorrectionResult {
  const cmd = evaluateVoiceCommand(utterance);

  if (cmd.action === 'DELETE_LAST_WORD') {
    const words = currentText.trim().split(/\s+/);
    if (words.length > 1) {
      words.pop();
      return { updatedText: words.join(' '), isHandled: true, correctionDescription: 'Deleted last word' };
    }
    return { updatedText: '', isHandled: true, correctionDescription: 'Erased finding' };
  }

  if (cmd.action === 'MARK_BOLD') {
    const cleaned = currentText.replace(/^BOLD::/i, '').trim();
    return { updatedText: `BOLD::${cleaned}`, isHandled: true, correctionDescription: 'Marked as bold' };
  }

  if (cmd.action === 'SELF_CORRECTION' && cmd.replacement) {
    if (cmd.target && currentText) {
      const safeTargetRegex = new RegExp(`\\b${escapeRegExp(cmd.target)}\\b`, 'gi');
      if (safeTargetRegex.test(currentText)) {
        const updated = currentText.replace(safeTargetRegex, cmd.replacement);
        return { updatedText: updated, isHandled: true, correctionDescription: cmd.description };
      }
    }

    // Opposite correction (e.g. left vs right)
    if (/\b(right)\b/i.test(cmd.replacement) && /\bleft\b/i.test(currentText)) {
      const updated = currentText.replace(/\bleft\b/gi, 'right');
      return { updatedText: updated, isHandled: true, correctionDescription: 'Changed "left" to "right"' };
    }
    if (/\b(left)\b/i.test(cmd.replacement) && /\bright\b/i.test(currentText)) {
      const updated = currentText.replace(/\bright\b/gi, 'left');
      return { updatedText: updated, isHandled: true, correctionDescription: 'Changed "right" to "left"' };
    }

    // Replace last word
    const words = currentText.trim().split(/\s+/);
    if (words.length > 0) {
      words.pop();
      const updated = `${words.join(' ')} ${cmd.replacement}`.trim();
      return { updatedText: updated, isHandled: true, correctionDescription: cmd.description };
    }
  }

  return { updatedText: currentText, isHandled: false };
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format a completed finding text for display (e.g. prefixing BOLD::, styling uppercase impressions)
 */
export function formatFindingForDisplay(rawText: string): string {
  let cleaned = rawText.trim();
  if (!cleaned) return '';

  // Strip accidental remaining delimiter command phrases from the text
  cleaned = cleaned
    .replace(/\b(move to the next line|move to next line|go to the next line|go to next line|next line|new line|line break|new paragraph|next paragraph|new finding|next finding|separate finding|next point|new point|add finding|another finding)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) return '';

  if (cleaned.startsWith('BOLD::')) {
    const rest = cleaned.slice(6).trim();
    return `BOLD::${capitalizeFirst(rest)}`;
  } else if (cleaned.startsWith('*')) {
    const rest = cleaned.slice(1).trim();
    return `*${capitalizeFirst(rest)}`;
  } else if (cleaned.toUpperCase().startsWith('IMPRESSION:')) {
    return cleaned.toUpperCase();
  } else {
    return `BOLD::${capitalizeFirst(cleaned)}`;
  }
}

function capitalizeFirst(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

