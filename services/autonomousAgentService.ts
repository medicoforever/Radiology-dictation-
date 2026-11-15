/**
 * AUTONOMOUS AGENT ORCHESTRATOR SERVICE
 * (C) 2024-2026 RADDOC™ - Medical AI Dictation Suite
 * 
 * Implements Riley Brown's "Personal Superapp" architecture:
 * 1. Agent-Readable State: Generates a single-pass, structured JSON Execution Manifest.
 * 2. Shell + Slices: Coordinates functional slices behind the scenes (Single Dictation,
 *    Batch Processing, Template Matching, Multi-Region Merge, Google Drive Auto-Save,
 *    and HTML Report Exports).
 * 3. Cross-Turn Entity Resolution: Consolidates fragmented findings for the same patient
 *    even when the doctor returns to an earlier patient later in the recording.
 * 4. Acoustic Telemetry: Plays success and error audio chimes via Web Audio API.
 */

import { Type } from "@google/genai";
import { executeWithApiKeyFailover } from "./apiKeyService";
import { ALL_RADNITO_TEMPLATES, BuiltInTemplateItem, getTemplateDocxBase64 } from "./builtInTemplates";
import { mergeDictatedFindingsWithTemplate, resolveApiTargetModel } from "./geminiService";
import { autoSaveSingleDictation, autoSaveBatchDictations, isDriveConnected, SaveResult } from "./googleDriveService";
import { generateSingleDictationHTML, generateBatchDictationHTML } from "./htmlGenerator";
import { downloadFile } from "./docxService";
import { playAutonomousSuccessSound, playAutonomousErrorSound } from "./soundService";
import type { DocxTemplateData } from "../components/ui/CustomPromptInput";
import { 
  addMacroFromAutonomous, 
  addVocabularyRuleFromAutonomous, 
  expandMacrosInFindings, 
  getMacroPromptContext 
} from "./macroDictionaryService";
import { autoSyncReport, checkAndAutoSyncReport } from "./workstationSync";

export interface AutonomousAttachedFile {
  id: string;
  file: File;
  alias?: string;
  index: number;
  textContent?: string;
  isTextNote?: boolean;
}

export interface AutonomousPatientItem {
  patientId: string;
  patientName: string;
  targetMode: 'single' | 'batch';
  findings: string[];
  targetTemplateName?: string;
  mergeDirectives?: string;
  customPrompt?: string;
  saveToDrive?: boolean;
  downloadHtml?: boolean;
  attachedFileIndices?: number[];
}

export interface AutonomousMacroCreation {
  name: string;
  text: string;
}

export interface AutonomousVocabularyCreation {
  pattern: string;
  replacement: string;
}

export interface AutonomousExecutionPlan {
  summary: string;
  totalPatientsDetected: number;
  globalDirectives: {
    saveToDrive: boolean;
    downloadHtml: boolean;
    syncToWorkstation: boolean;
  };
  macrosToCreate?: AutonomousMacroCreation[];
  vocabularyToCreate?: AutonomousVocabularyCreation[];
  patients: AutonomousPatientItem[];
  rawTranscript?: string;
}

export interface AutonomousExecutionResult {
  success: boolean;
  summary: string;
  totalPatients: number;
  singlePatient?: {
    name: string;
    findings: string[];
    templateUsed?: string;
    attachedFilesCount?: number;
  } | null;
  batchPatients: Array<{
    name: string;
    findings: string[];
    templateUsed?: string;
    attachedFilesCount?: number;
  }>;
  driveSaved: boolean;
  driveFileName?: string;
  htmlDownloaded: boolean;
  workstationSynced: boolean;
  macrosCreated?: string[];
  vocabularyCreated?: string[];
  handedOverFilesSummary?: Array<{
    patientName: string;
    fileNames: string[];
  }>;
  error?: string;
}

/**
 * Converts a Blob to a base64 string
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result as string;
      const base64 = res.includes(',') ? res.split(',')[1] : res;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Fuzzy matches a template name against the built-in clinical templates
 */
export function findTemplateByFuzzyName(query?: string): BuiltInTemplateItem | null {
  if (!query || !query.trim()) return null;
  let q = query.toLowerCase().trim();
  // Normalize common spoken modality abbreviations
  q = q.replace(/\bmr\b/g, 'mri').replace(/\bcat\b/g, 'ct').replace(/\bus\b/g, 'ultrasound').replace(/\bxray\b/g, 'x-ray');

  // 1. Exact or startsWith match
  const exact = ALL_RADNITO_TEMPLATES.find(
    t => t.name.toLowerCase() === q || t.id.toLowerCase() === q
  );
  if (exact) return exact;

  // 2. Query contains template name or vice-versa
  const direct = ALL_RADNITO_TEMPLATES.find(
    t => t.name.toLowerCase().includes(q) || q.includes(t.name.toLowerCase())
  );
  if (direct) return direct;

  // 3. Keyword matching (modality + anatomy)
  const tokens = q.split(/\s+/).filter(tok => tok.length >= 2);
  let bestMatch: BuiltInTemplateItem | null = null;
  let maxScore = 0;

  for (const t of ALL_RADNITO_TEMPLATES) {
    const tName = t.name.toLowerCase();
    const tDesc = (t.description || '').toLowerCase();
    const tMod = (t.modality || '').toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (tok === 'mri' || tok === 'mr') {
        if (tMod === 'mr' || tName.includes('mri')) score += 5;
      } else if (tok === 'ct') {
        if (tMod === 'ct' || tName.includes('ct') || tName.includes('c.t.')) score += 5;
      } else if (tok === 'contrast') {
        if (tName.includes('contrast')) score += 4;
      } else if (tName.includes(tok)) {
        score += 3;
      } else if (tDesc.includes(tok)) {
        score += 1;
      }
    }
    if (score > maxScore) {
      maxScore = score;
      bestMatch = t;
    }
  }

  return maxScore >= 3 ? bestMatch : null;
}

const AUTONOMOUS_AGENT_SYSTEM_PROMPT = `You are RADDOC Autonomous Radiology Director, an expert AI medical workstation agent.
You analyze a single, continuous audio recording where a radiologist speaks in natural human language, giving clinical findings, patient details, and application control directives.

YOUR CORE TASKS:
1. MULTI-PATIENT DETECTION & STRICT ISOLATION OF INDIVIDUAL REPORTS:
   - When the radiologist dictates multiple patients or a batch of cases (e.g. "batch dictation with five patients", "Patient 1 ... Patient 2 ... Patient 3 ..."):
     * STRICT REPORT PARTITIONING (ZERO CROSS-CONTAMINATION): Each patient must have their own separate, independent entry in the "patients" array.
     * TOTAL ISOLATION RULE: NEVER include, append, or accumulate subsequent patients' findings (Patient 2, Patient 3, Patient 4, Patient 5...) inside Patient 1's findings array!
     * Patient 1's "findings" array MUST contain ONLY Patient 1's clinical findings and observations.
     * Patient 2's "findings" array MUST contain ONLY Patient 2's clinical findings and observations.
     * Patient 3's "findings" array MUST contain ONLY Patient 3's clinical findings and observations.
     * Patient 4's "findings" array MUST contain ONLY Patient 4's clinical findings and observations.
     * Patient 5's "findings" array MUST contain ONLY Patient 5's clinical findings and observations.
     * Each patient report is 100% independent, clean, and non-redundant.
   - Cross-Turn Addenda / Corrections: If the radiologist moves to another patient and then later in the recording returns to an earlier patient (e.g., "Oh, going back to Patient 1...", "For that first CT Brain patient, also add that there is a 4mm nodule...", "And one more finding for John Doe..."), CONSOLIDATE that specific addition into that specific patient's report findings. Do NOT create duplicate split reports.

2. TARGET MODE ROUTING (Single Dictation vs Batch Mode):
   - Determine whether each patient should go into 'single' mode or 'batch' mode.
   - If the doctor specifies "in batch dictation", "batch mode", "add 5 patients in batch", or dictates a series of batch cases, route ALL of those patients to targetMode: 'batch'.
   - If the doctor says "single dictation", "single mode", or "record this first patient in single dictation", route that patient to targetMode: 'single'.
   - If not explicitly mentioned:
     * If only 1 patient is dictated, assign targetMode: 'single'.
     * If multiple patients are dictated without specific mode commands, assign the first patient to 'single' (active workstation report) and all subsequent patients to 'batch' (queued reports).

3. TEMPLATE ASSIGNMENT & SPOKEN STRUCTURAL/HEADING MODIFICATIONS:
   - Identify if a template is requested for any patient (e.g., "CT Brain Trauma", "Chest X-Ray Normal", "MRI Lumbar Spine", "Abdomen USG", "PNS Sinusitis").
   - Spoken Template & Heading Alterations: The doctor may dictate structural modifications to the template in the same breath as scan findings (e.g., "change the CT extremity heading in that template to CT right arm", "change title to CT SCAN OF RIGHT FOREARM", "rename pelvis heading to lower abdomen", "omit bladder section"). Capture these in "mergeDirectives" and ensure the target heading/title in the generated report reflects the modified heading.
   - Crucial: Strip and remove spoken alteration commands from the patient's "findings" array so they never appear as report body findings.
   - Extract any specific merge instructions (e.g., "merge focusing on rib fractures", "when merging, omit normal sinus paragraphs", "replace impression with acute findings").

4. SPOKEN MACRO & DICTIONARY CREATION:
   - Detect spoken commands to create or register new macros: e.g. "create macro [name] with text [text]", "add macro [name] saying [text]", "save macro [name] with findings [text]".
     Add to "macrosToCreate": [{ "name": "...", "text": "..." }].
   - Detect spoken vocabulary or dictionary additions/corrections: e.g. "add word [word] to dictionary", "in dictionary replace [error] with [correction]", "add vocabulary rule [pattern] to [replacement]".
     Add to "vocabularyToCreate": [{ "pattern": "...", "replacement": "..." }].

5. STORAGE, SYNC & EXPORT DIRECTIVES:
   - Detect if the user says to save to Google Drive (e.g., "save to google drive", "auto-save to drive", "sync this report to drive") -> globalDirectives.saveToDrive = true.
   - Detect if the user says to download HTML (e.g., "download html", "download all htmls", "export html report", "download batch html") -> globalDirectives.downloadHtml = true.
   - Detect if the user says to sync to workstation (e.g., "sync to workstation", "send to workstation", "workstation sync", "sync report") -> globalDirectives.syncToWorkstation = true.

6. CLINICAL FINDINGS PURITY & MACRO EXPANSION:
   - Transcribe each patient's actual observations into clean, line-by-line radiology findings. Remove conversational meta-instructions (like "put this in batch", "going back to patient 1", "save to drive") from the clinical findings array itself.
   - If the doctor dictates a known macro trigger or says "macro [name]", expand the macro text directly into the patient's findings.

7. ATTACHED FILES HANDOFF (ZERO-READ PRINCIPLE):
   - The user may upload reference files (such as scans, prior reports, images, documents) and optionally assign names/labels to them or refer to them as "first uploaded file", "File 1", "Brain MRI scan", etc.
   - You MUST NOT read or parse the file contents yourself; your job is strictly to assign/hand over the referenced file(s) to the appropriate patient report(s) based on what the doctor dictates in the audio (e.g. "attach the first uploaded file to Patient 1", "use the Brain MRI for Patient 2", "attach all files to batch").
   - Set "attachedFileIndices" in the patient item to an array of 1-based indices (e.g., [1, 2]) of any files to hand over.

8. CLINICAL FIDELITY VS. EXPLICIT AI SYNTHESIS (CRITICAL ANTI-LITERAL RULE):
   - DEFAULT RULE (REAL CLINICAL FINDINGS): What the radiologist speaks are the real clinical findings and ground truth. Transcribe each patient's actual observations accurately and faithfully into the findings array without inventing, hallucinating, or replacing them with textbook synthetic descriptions (e.g. if the doctor dictates "right slipped capital femoral epiphysis with Trethowan sign", transcribe that real observation faithfully).
   - EXPLICIT SYNTHESIS ONLY: High-level AI pathology synthesis (generating complete line-by-line findings across sequences/planes from scratch, such as comprehensive Glioblastoma imaging features) MUST ONLY activate when the doctor EXPLICITLY instructs the AI to generate it by itself (e.g. phrases containing "by yourself", "include detailed glioblastoma findings by yourself", "add detailed findings for X by yourself", "generate findings for X by yourself", "synthesize detailed findings for X").
   - When the doctor explicitly commands AI synthesis (e.g. "for a patient create 1 batch dictation and add detailed glioblastoma findings by yourself and merge it with Mr brain template"):
     * Synthesize realistic, authoritative, comprehensive, anatomically detailed line-by-line radiological findings corresponding to that pathology and modality (e.g. for glioblastoma in MR Brain: describe the thick irregular peripheral ring enhancement with central necrosis on post-contrast T1, extensive perilesional T2/FLAIR vasogenic edema along white matter tracts, multiple internal foci of microhemorrhage and neovascularity on SWI, restricted diffusion along the solid hypercellular rim on DWI/ADC, mass effect with sulcal effacement, ventricular compression, midline shift, and uncal/subfalcine herniation).
     * Set "targetTemplateName" to the matching template.
     * Include an authoritative, clinical IMPRESSION adhering to the Smart Bullet Formatting in Impression rules.
   - ANTI-LITERAL RULE: In either case, NEVER insert conversational meta-instruction phrases like "detailed glioblastoma findings by yourself" or "add glioblastoma findings" verbatim into the patient's findings array or report body!

9. SMART BULLET FORMATTING IN IMPRESSION:
   - Explicit No-Bullet Directives: If the radiologist commands a point to be added without bullet (e.g. "add this point without bullet in impression", "without bullet", "no bullet"), that point MUST start flush from the left margin WITHOUT ANY bullet symbol (no '•', '-', or '*').
   - Single-Line / Lead-In Summaries: Statements such as "findings are s/o...", narrative summary paragraphs, or single normal summary sentences now start flush with the beginning of the line without any bullet point (e.g. "IMPRESSION:###Normal study without acute abnormality." or "IMPRESSION:###Findings are s/o acute appendicitis.").
   - Discrete / Multi-Point Findings: When the impression consists of 2 or more discrete clinical findings, each individual finding is cleanly formatted with bullet points (• Point 1, • Point 2) starting from the left margin, EXCEPT for points instructed without bullets.

10. TECHNIQUE & PROTOCOL DIRECTIVE:
   - If the template or report lacks a Technique / Protocol section or sentence, do NOT add or invent "Standard imaging protocol was performed." or any placeholder protocol line. Omit it completely unless explicitly present in the template or dictated by the radiologist.

11. CLINICAL PROFILE FORMATTING & SPOKEN STYLE DIRECTIVES:
   - Default: format clinical profile in single asterisks (*Clinical Profile: ...*), which renders as italic alone.
   - If the doctor dictates formatting commands for Clinical Profile (e.g., "keep clinical profile sentence underlined bold and unitalic", "bold and underline clinical profile", "make clinical profile not italic", "underline clinical profile"):
     * Obey the requested style formatting!
     * Prefix the Clinical Profile line with style tags: e.g. [STYLE:bold,underline,unitalic]*Clinical Profile: ...* or BOLD::UNDERLINE::UNITALIC::*Clinical Profile: ...*.
     * Strip out the conversational command phrase completely from the clinical history text!

12. IMPRESSION & SPOKEN NO-BULLET DIRECTIVES:
   - If the doctor dictates to add a point without bullet in impression (e.g. "add this point without bullet in impression", "in impression add without bullet: ...", "no bullet for this point"):
     * Incorporate the point into the IMPRESSION.
     * That specific point MUST start flush with the beginning of the line without any bullet symbol (no '•', '-', or '*').
     * Remove the spoken instruction phrase like "add this point without bullet in impression" so only the clinical observation appears.

OUTPUT JSON FORMAT:
Respond with ONLY valid JSON adhering to this schema:
{
  "summary": "High-level summary of what was parsed and orchestrated",
  "totalPatientsDetected": 2,
  "globalDirectives": {
    "saveToDrive": true,
    "downloadHtml": true,
    "syncToWorkstation": true
  },
  "macrosToCreate": [
    {
      "name": "age-related",
      "text": "Mild diffuse cerebral cortical atrophy and prominent sulci consistent with patient age."
    }
  ],
  "vocabularyToCreate": [
    {
      "pattern": "cole cystitis",
      "replacement": "cholecystitis"
    }
  ],
  "patients": [
    {
      "patientId": "pt_1",
      "patientName": "Patient 1 (CT Brain)",
      "targetMode": "single",
      "findings": [
        "C.T.SCAN OF BRAIN (PLAIN)",
        "Partial right cervical rib noted on the right side.",
        "Mild mucosal thickening in the right maxillary sinus."
      ],
      "targetTemplateName": "C.T.SCAN OF BRAIN (PLAIN)",
      "mergeDirectives": "Include maxillary sinus finding from addendum",
      "customPrompt": "",
      "attachedFileIndices": [1]
    },
    {
      "patientId": "pt_2",
      "patientName": "Patient 2 (Chest X-Ray)",
      "targetMode": "batch",
      "findings": [
        "CHEST PA VIEW",
        "Lungs appear clear with no focal consolidation or pleural effusion.",
        "Normal cardiothoracic ratio."
      ],
      "targetTemplateName": "CHEST PA VIEW",
      "mergeDirectives": "",
      "customPrompt": "",
      "attachedFileIndices": []
    }
  ]
}`;

/**
 * Processes an autonomous audio dictation with the user-selected model
 */
export async function parseAutonomousAudioDictation(
  audioBlob: Blob,
  selectedModel: string,
  attachedFiles?: AutonomousAttachedFile[]
): Promise<AutonomousExecutionPlan> {
  const targetModel = resolveApiTargetModel(selectedModel);
  const base64Audio = await blobToBase64(audioBlob);
  const mimeType = audioBlob.type || 'audio/webm';
  const macroContext = getMacroPromptContext();

  let attachedFilesManifest = '';
  if (attachedFiles && attachedFiles.length > 0) {
    attachedFilesManifest = `\n================================================================================
ATTACHED FILES & CLINICAL TEXT NOTES (Available for handoff):
The user has attached the following file(s) and typed/pasted clinical text note(s) into this session.
DO NOT read or parse large binary file contents yourself.
Assign/hand over files or notes to the appropriate patient report(s) based on what the doctor dictates in the audio (e.g., "attach the first uploaded file to Patient 1", "use the prior report note for Patient 2", "attach all files to batch").
${attachedFiles.map(f => {
  const typeLabel = f.isTextNote ? 'Typed/Pasted Text Note' : (f.file.type || 'file');
  const preview = f.textContent ? ` [Content Preview: "${f.textContent.slice(0, 150).replace(/\s+/g, ' ')}${f.textContent.length > 150 ? '...' : ''}"]` : '';
  return `- File #${f.index}: "${f.alias ? f.alias : f.file.name}" (Filename: ${f.file.name}, Type: ${typeLabel}, Size: ${(f.file.size / 1024).toFixed(1)} KB)${preview}`;
}).join('\n')}
If the doctor mentions assigning any of these files or notes to a patient, set their 1-based file indices in "attachedFileIndices" for that patient.
================================================================================\n`;
  }

  return executeWithApiKeyFailover(
    async (client) => {
      const promptInstruction = `${AUTONOMOUS_AGENT_SYSTEM_PROMPT}\n${macroContext}\n${attachedFilesManifest}\nExecute autonomous orchestration for this audio dictation. Return the structured JSON execution plan now.`;

      const parts: any[] = [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Audio,
          },
        },
        {
          text: promptInstruction
        }
      ];

      // Request structured JSON output
      const response = await client.models.generateContent({
        model: targetModel,
        contents: {
          role: 'user',
          parts: parts
        },
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        }
      });

      const responseText = response.text || '';
      if (!responseText.trim()) {
        throw new Error("Autonomous agent returned an empty response.");
      }

      // Parse JSON response
      let cleanJson = responseText.trim();
      if (cleanJson.startsWith('```json')) {
        cleanJson = cleanJson.replace(/^```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```\s*/, '').replace(/```\s*$/, '');
      }

      const plan: AutonomousExecutionPlan = JSON.parse(cleanJson);
      if (!plan.patients || !Array.isArray(plan.patients)) {
        throw new Error("Invalid plan structure: 'patients' array is missing.");
      }

      return plan;
    },
    { selectedModel: targetModel }
  );
}

const AUTONOMOUS_FEEDBACK_SYSTEM_PROMPT = `You are RADDOC Autonomous Radiology Director, an expert AI medical workstation agent.
You previously orchestrated an autonomous radiology session that generated reports and workstation dispatches.
Now, the radiologist has provided direct FEEDBACK, corrections, and modifications via spoken dictation and/or written instructions.

YOUR CORE RESPONSIBILITY:
Carefully inspect the previous execution manifest and all current patient findings, and accurately apply the doctor's feedback/modifications.
Modify only the patient reports, findings, impressions, templates, headings, or workstation settings specified by the doctor.

CRITICAL DIRECTIVES FOR APPLYING FEEDBACK:
1. PRECISE ENTITY TARGETING:
   - Identify which patient(s) the doctor is addressing (e.g., "for patient 1", "in John Doe's CT", "for the knee MRI", "for the second case", "in batch patient 2").
   - If the doctor speaks about a single patient without naming them and only 1 patient exists, apply the changes to that patient.
   - If the doctor adds a new patient, append them to the "patients" array.
2. MODIFICATIONS & FINDINGS REFINEMENT:
   - Specific Finding Edits: If the doctor corrects or adds a finding (e.g. "change liver finding to mild fatty infiltration", "remove the fracture sentence", "add 3mm nodule in right upper lobe"), modify that patient's findings accordingly.
   - Impression Edits: If the doctor changes or refines the impression (e.g. "change impression to acute uncomplicated appendicitis", "add recommendation for surgical review"), update the impression lines following the Smart Bullet Formatting in Impression rules.
3. SPOKEN TEMPLATE & HEADING ALTERATIONS:
   - If the doctor says "change template to [X]" or "use [X] template instead", update targetTemplateName to match.
   - If the doctor says "change heading to [X]" (e.g. "change CT extremity heading to CT right arm"), update mergeDirectives to include the heading alteration.
   - Crucial: Strip and remove spoken modification commands from the patient's "findings" array so they never appear as report body findings.
4. CLINICAL FIDELITY VS. EXPLICIT SYNTHESIS:
   - What the doctor speaks is the ground truth. Preserve the real clinical observations faithfully.
   - Full textbook multi-sequence pathology generation activates ONLY if the doctor explicitly commands "by yourself".
5. PRESERVE UNTOUCHED REPORTS:
   - Any patients or settings not referenced or modified in the doctor's feedback MUST be preserved with their existing findings and configurations.
6. SMART BULLET FORMATTING IN IMPRESSION:
   - Single-Line / Lead-In Summaries: Statements such as "findings are s/o...", narrative summary paragraphs, or single normal summary sentences now start flush with the beginning of the line without any bullet point (e.g. "IMPRESSION:###Normal study without acute abnormality.").
   - Discrete / Multi-Point Findings: When the impression consists of 2 or more discrete clinical findings, each individual finding is cleanly formatted with bullet points (• Point 1, • Point 2) starting from the left margin (e.g. "IMPRESSION:###• Point 1###• Point 2").
7. OUTPUT FORMAT:
   - Respond ONLY with a valid JSON AutonomousExecutionPlan adhering to the exact schema:
   {
     "summary": "Clear, concise summary of the specific feedback modifications applied",
     "totalPatientsDetected": 1,
     "globalDirectives": {
       "saveToDrive": true,
       "downloadHtml": true,
       "syncToWorkstation": true
     },
     "macrosToCreate": [],
     "vocabularyToCreate": [],
     "patients": [
       {
         "patientId": "pt_1",
         "patientName": "Patient Name",
         "targetMode": "single",
         "findings": ["Line 1", "Line 2"],
         "targetTemplateName": "Template Name",
         "mergeDirectives": "",
         "attachedFileIndices": []
       }
     ]
   }`;

/**
 * Processes feedback/modification dictation or notes for an existing autonomous execution plan.
 * Provides the full context of the previous plan, findings, and attached files to the AI agent.
 */
export async function parseAutonomousFeedbackDictation(
  previousPlan: AutonomousExecutionPlan,
  previousResult: AutonomousExecutionResult,
  feedbackAudioBlob?: Blob | null,
  feedbackText?: string,
  selectedModel: string = 'gemini-2.5-pro',
  attachedFiles?: AutonomousAttachedFile[]
): Promise<AutonomousExecutionPlan> {
  const targetModel = resolveApiTargetModel(selectedModel);
  const macroContext = getMacroPromptContext();

  let attachedFilesManifest = '';
  if (attachedFiles && attachedFiles.length > 0) {
    attachedFilesManifest = `\n================================================================================
ATTACHED FILES & CLINICAL TEXT NOTES (Available for handoff):
${attachedFiles.map(f => {
  const typeLabel = f.isTextNote ? 'Typed/Pasted Text Note' : (f.file.type || 'file');
  const preview = f.textContent ? ` [Content Preview: "${f.textContent.slice(0, 150).replace(/\s+/g, ' ')}${f.textContent.length > 150 ? '...' : ''}"]` : '';
  return `- File #${f.index}: "${f.alias ? f.alias : f.file.name}" (Filename: ${f.file.name}, Type: ${typeLabel}, Size: ${(f.file.size / 1024).toFixed(1)} KB)${preview}`;
}).join('\n')}
================================================================================\n`;
  }

  const previousContextSummary = `
================================================================================
EXISTING AUTONOMOUS PLAN & PATIENT REPORTS (TO BE MODIFIED):
Previous Summary: "${previousPlan.summary}"
Global Directives: ${JSON.stringify(previousPlan.globalDirectives)}
Total Current Patients: ${previousPlan.patients.length}

CURRENT PATIENT REPORTS:
${previousPlan.patients.map((p, idx) => {
  return `--------------------------------------------------------------------------------
PATIENT #${idx + 1}: "${p.patientName}" (ID: ${p.patientId})
- Target Mode: ${p.targetMode}
- Applied Template: ${p.targetTemplateName || 'None'}
- Merge Directives: ${p.mergeDirectives || 'None'}
- Attached File Indices: ${JSON.stringify(p.attachedFileIndices || [])}
- Current Transcribed Findings (${p.findings.length} lines):
${p.findings.map(f => `  * ${f}`).join('\n')}
`;
}).join('\n')}
================================================================================
`;

  return executeWithApiKeyFailover(
    async (client) => {
      const promptInstruction = `${AUTONOMOUS_FEEDBACK_SYSTEM_PROMPT}
${previousContextSummary}
${macroContext}
${attachedFilesManifest}
${feedbackText ? `DOCTOR'S WRITTEN FEEDBACK & MODIFICATION INSTRUCTIONS:\n"""\n${feedbackText.trim()}\n"""\n` : ''}
Execute feedback modifications now. Return the updated structured JSON execution plan.`;

      const parts: any[] = [];

      if (feedbackAudioBlob && feedbackAudioBlob.size > 0) {
        const base64Audio = await blobToBase64(feedbackAudioBlob);
        const mimeType = feedbackAudioBlob.type || 'audio/webm';
        parts.push({
          inlineData: {
            mimeType: mimeType,
            data: base64Audio,
          },
        });
      }

      parts.push({
        text: promptInstruction
      });

      const response = await client.models.generateContent({
        model: targetModel,
        contents: {
          role: 'user',
          parts: parts
        },
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        }
      });

      const responseText = response.text || '';
      if (!responseText.trim()) {
        throw new Error("Autonomous agent returned an empty response for feedback.");
      }

      let cleanJson = responseText.trim();
      if (cleanJson.startsWith('```json')) {
        cleanJson = cleanJson.replace(/^```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```\s*/, '').replace(/```\s*$/, '');
      }

      const plan: AutonomousExecutionPlan = JSON.parse(cleanJson);
      if (!plan.patients || !Array.isArray(plan.patients)) {
        throw new Error("Invalid plan structure: 'patients' array is missing in feedback response.");
      }

      // Preserve patient IDs if AI omitted them
      plan.patients = plan.patients.map((p, idx) => ({
        ...p,
        patientId: p.patientId || previousPlan.patients[idx]?.patientId || `pt_${idx + 1}`,
        targetMode: p.targetMode || previousPlan.patients[idx]?.targetMode || 'single',
        findings: (p.findings && p.findings.length > 0) ? p.findings : (previousPlan.patients[idx]?.findings || [])
      }));

      return plan;
    },
    { selectedModel: targetModel }
  );
}

/**
 * Executes the generated Autonomous Plan:
 * 1. Resolves and applies templates & merges for single and batch patients.
 * 2. Saves to Google Drive if requested and Drive is connected.
 * 3. Downloads HTML files if requested.
 * 4. Dispatches state updates to Single Mode and Batch Mode.
 * 5. Plays acoustic feedback chimes (success or error).
 */
export async function executeAutonomousPlan(
  plan: AutonomousExecutionPlan,
  context: {
    selectedModel: string;
    audioBlob?: Blob | null;
    attachedFiles?: AutonomousAttachedFile[];
    onApplySingleReport: (
      findings: string[], 
      patientName: string, 
      audioBlob?: Blob | null,
      customImages?: Array<{ data: string; mimeType: string }>,
      extraFiles?: File[],
      customPrompt?: string,
      customDocx?: DocxTemplateData | null,
      templateUsed?: string
    ) => void;
    onApplyBatchReports: (batches: Array<{
      name: string;
      findings: string[];
      audioBlobs: Blob[];
      selectedModel: string;
      customPrompt?: string;
      customDocx?: DocxTemplateData | null;
      customImages?: Array<{ data: string; mimeType: string }>;
      extraFiles?: File[];
    }>) => void;
    onDriveSaved?: (result: SaveResult) => void;
  }
): Promise<AutonomousExecutionResult> {
  try {
    // 0. Spoken Macro & Dictionary Creation (if dictated)
    const macrosCreated: string[] = [];
    if (plan.macrosToCreate && plan.macrosToCreate.length > 0) {
      for (const m of plan.macrosToCreate) {
        if (m.name && m.text) {
          try {
            addMacroFromAutonomous(m.name, m.text);
            macrosCreated.push(m.name);
          } catch (mErr) {
            console.warn(`Failed to create spoken macro ${m.name}:`, mErr);
          }
        }
      }
    }

    const vocabularyCreated: string[] = [];
    if (plan.vocabularyToCreate && plan.vocabularyToCreate.length > 0) {
      for (const v of plan.vocabularyToCreate) {
        if (v.pattern && v.replacement) {
          try {
            addVocabularyRuleFromAutonomous(v.pattern, v.replacement);
            vocabularyCreated.push(`${v.pattern} -> ${v.replacement}`);
          } catch (vErr) {
            console.warn(`Failed to create vocabulary rule for ${v.pattern}:`, vErr);
          }
        }
      }
    }

    const handedOverFilesSummary: Array<{ patientName: string; fileNames: string[] }> = [];

    // Helper to resolve attached files by 1-based index
    const resolveFilesForIndices = async (indices?: number[]) => {
      if (!indices || indices.length === 0 || !context.attachedFiles || context.attachedFiles.length === 0) {
        return { images: [] as Array<{ data: string; mimeType: string }>, otherFiles: [] as File[], fileNames: [] as string[] };
      }
      const matched = context.attachedFiles.filter(f => indices.includes(f.index));
      const images: Array<{ data: string; mimeType: string }> = [];
      const otherFiles: File[] = [];
      const fileNames: string[] = [];

      for (const m of matched) {
        fileNames.push(m.alias || m.file.name);
        if (m.file.type.startsWith('image/')) {
          try {
            const b64 = await blobToBase64(m.file);
            images.push({ data: b64, mimeType: m.file.type });
          } catch {
            otherFiles.push(m.file);
          }
        } else {
          otherFiles.push(m.file);
        }
      }
      return { images, otherFiles, fileNames };
    };

    const singlePatientItem = plan.patients.find(p => p.targetMode === 'single');
    const batchPatientItems = plan.patients.filter(p => p.targetMode === 'batch');

    let processedSingle: { name: string; findings: string[]; templateUsed?: string; attachedFilesCount?: number } | null = null;
    const processedBatches: Array<{ 
      name: string; 
      findings: string[]; 
      templateUsed?: string; 
      customPrompt?: string;
      customDocx?: DocxTemplateData | null;
      customImages?: Array<{ data: string; mimeType: string }>;
      extraFiles?: File[];
      attachedFilesCount?: number;
    }> = [];

    // 1. Process Single Mode Patient (if any)
    if (singlePatientItem) {
      // Expand user voice macros into findings
      let finalFindings = expandMacrosInFindings([...singlePatientItem.findings]);
      let templateUsed: string | undefined = undefined;
      let singleDocx: DocxTemplateData | null = null;
      let singlePrompt = singlePatientItem.customPrompt || '';

      if (singlePatientItem.targetTemplateName) {
        const matched = findTemplateByFuzzyName(singlePatientItem.targetTemplateName);
        if (matched) {
          templateUsed = matched.name;
          try {
            const docxB64 = matched.docxBase64 || await getTemplateDocxBase64(matched.id);
            if (docxB64) {
              singleDocx = {
                data: docxB64,
                size: Math.round((docxB64.length * 3) / 4),
                name: `${matched.name}.docx`,
                extractedText: matched.lines ? matched.lines.join('\n') : matched.name
              };
            }
          } catch (e) {
            console.warn('Could not load docx for single template:', e);
          }

          singlePrompt = `[TEMPLATE_ID: ${matched.id}] Merged with template: ${matched.name}. ${singlePatientItem.mergeDirectives || ''}`.trim();

          let effectiveDirectives = singlePatientItem.mergeDirectives || '';
          const handedOverNotes = context.attachedFiles?.filter(
            f => (singlePatientItem.attachedFileIndices || []).includes(f.index) && f.textContent
          );
          if (handedOverNotes && handedOverNotes.length > 0) {
            const notesText = handedOverNotes
              .map(n => `[Attached Reference Note - "${n.alias || n.file.name}"]:\n${n.textContent}`)
              .join('\n\n');
            effectiveDirectives = `${effectiveDirectives}\n\nClinical Reference Notes for Context:\n${notesText}`.trim();
          }

          try {
            finalFindings = await mergeDictatedFindingsWithTemplate(
              finalFindings,
              matched,
              context.selectedModel,
              undefined,
              effectiveDirectives
            );
          } catch (mergeErr) {
            console.warn(`Template merge for ${singlePatientItem.patientName} failed, using raw findings:`, mergeErr);
          }
        }
      }

      // Resolve handed-over attached files
      const singleFiles = await resolveFilesForIndices(singlePatientItem.attachedFileIndices);
      if (singleFiles.fileNames.length > 0) {
        handedOverFilesSummary.push({
          patientName: singlePatientItem.patientName,
          fileNames: singleFiles.fileNames
        });
      }

      processedSingle = {
        name: singlePatientItem.patientName,
        findings: finalFindings,
        templateUsed,
        attachedFilesCount: singleFiles.fileNames.length
      };

      // Dispatch to Single Dictation state with audioBlob, attached files, and RTF template config
      context.onApplySingleReport(
        finalFindings, 
        singlePatientItem.patientName, 
        context.audioBlob, 
        singleFiles.images, 
        singleFiles.otherFiles,
        singlePrompt,
        singleDocx,
        templateUsed
      );

      // Handle Single Drive Save
      if (plan.globalDirectives.saveToDrive || singlePatientItem.saveToDrive) {
        if (isDriveConnected()) {
          try {
            const driveRes = await autoSaveSingleDictation(finalFindings, singlePatientItem.patientName);
            if (context.onDriveSaved) {
              context.onDriveSaved(driveRes);
            }
          } catch (driveErr) {
            console.warn("Drive auto-save failed:", driveErr);
          }
        }
      }

      // Handle Single HTML Download
      if (plan.globalDirectives.downloadHtml || singlePatientItem.downloadHtml) {
        try {
          const htmlContent = generateSingleDictationHTML(finalFindings);
          const safeName = singlePatientItem.patientName.replace(/[^a-zA-Z0-9_-]/g, '_');
          downloadFile(htmlContent, `${safeName}_Report.html`, 'text/html;charset=utf-8');
        } catch (htmlErr) {
          console.warn("Single HTML download failed:", htmlErr);
        }
      }
    }

    // 2. Process Batch Mode Patients (if any)
    if (batchPatientItems.length > 0) {
      for (const bp of batchPatientItems) {
        // Expand user voice macros into findings
        let finalFindings = expandMacrosInFindings([...bp.findings]);
        let templateUsed: string | undefined = undefined;
        let bpDocx: DocxTemplateData | null = null;
        let bpPrompt = bp.customPrompt || '';

        if (bp.targetTemplateName) {
          const matched = findTemplateByFuzzyName(bp.targetTemplateName);
          if (matched) {
            templateUsed = matched.name;
            try {
              const docxB64 = matched.docxBase64 || await getTemplateDocxBase64(matched.id);
              if (docxB64) {
                bpDocx = {
                  data: docxB64,
                  size: Math.round((docxB64.length * 3) / 4),
                  name: `${matched.name}.docx`,
                  extractedText: matched.lines ? matched.lines.join('\n') : matched.name
                };
              }
            } catch (e) {
              console.warn('Could not load docx for batch template:', e);
            }

            bpPrompt = `[TEMPLATE_ID: ${matched.id}] Merged with template: ${matched.name}. ${bp.mergeDirectives || ''}`.trim();

            let effectiveBpDirectives = bp.mergeDirectives || '';
            const handedOverBpNotes = context.attachedFiles?.filter(
              f => (bp.attachedFileIndices || []).includes(f.index) && f.textContent
            );
            if (handedOverBpNotes && handedOverBpNotes.length > 0) {
              const notesText = handedOverBpNotes
                .map(n => `[Attached Reference Note - "${n.alias || n.file.name}"]:\n${n.textContent}`)
                .join('\n\n');
              effectiveBpDirectives = `${effectiveBpDirectives}\n\nClinical Reference Notes for Context:\n${notesText}`.trim();
            }

            try {
              finalFindings = await mergeDictatedFindingsWithTemplate(
                finalFindings,
                matched,
                context.selectedModel,
                undefined,
                effectiveBpDirectives
              );
            } catch (mergeErr) {
              console.warn(`Batch template merge for ${bp.patientName} failed:`, mergeErr);
            }
          }
        }

        // Resolve handed-over attached files for this batch item
        const bpFiles = await resolveFilesForIndices(bp.attachedFileIndices);
        if (bpFiles.fileNames.length > 0) {
          handedOverFilesSummary.push({
            patientName: bp.patientName,
            fileNames: bpFiles.fileNames
          });
        }

        processedBatches.push({
          name: bp.patientName,
          findings: finalFindings,
          templateUsed,
          customPrompt: bpPrompt || bp.mergeDirectives || '',
          customDocx: bpDocx,
          customImages: bpFiles.images,
          extraFiles: bpFiles.otherFiles,
          attachedFilesCount: bpFiles.fileNames.length
        });
      }

      // Dispatch to Batch Processor state with audioBlobs, RTF docx, and handed-over files
      context.onApplyBatchReports(
        processedBatches.map(b => ({
          name: b.name,
          findings: b.findings,
          audioBlobs: context.audioBlob ? [context.audioBlob] : [],
          selectedModel: context.selectedModel,
          customPrompt: b.customPrompt,
          customDocx: b.customDocx,
          customImages: b.customImages,
          extraFiles: b.extraFiles,
        }))
      );

      // Handle Batch Drive Save
      if (plan.globalDirectives.saveToDrive) {
        if (isDriveConnected()) {
          try {
            const batchDrivePayload = processedBatches.map((b, idx) => ({
              id: `auto_${Date.now()}_${idx}`,
              name: b.name,
              findings: b.findings
            }));
            const driveRes = await autoSaveBatchDictations(batchDrivePayload);
            if (context.onDriveSaved) {
              context.onDriveSaved(driveRes);
            }
          } catch (driveErr) {
            console.warn("Batch Drive auto-save failed:", driveErr);
          }
        }
      }

      // Handle Batch HTML Download
      if (plan.globalDirectives.downloadHtml) {
        try {
          const reportBatches = processedBatches.map((b, idx) => ({
            id: `batch_${idx}`,
            name: b.name,
            findings: b.findings
          }));
          const htmlContent = generateBatchDictationHTML(reportBatches);
          downloadFile(htmlContent, `Autonomous_Batch_Reports_${Date.now()}.html`, 'text/html;charset=utf-8');
        } catch (htmlErr) {
          console.warn("Batch HTML download failed:", htmlErr);
        }
      }
    }

    // 3. Handle Spoken Workstation Sync
    let workstationSynced = false;
    if (plan.globalDirectives.syncToWorkstation) {
      const token = localStorage.getItem("workstation_sync_token");
      const id = localStorage.getItem("workstation_gist_id");
      if (token && id) {
        try {
          if (processedSingle) {
            await autoSyncReport(token, id, { findings: processedSingle.findings });
          } else if (processedBatches.length > 0) {
            await autoSyncReport(token, id, {
              batches: processedBatches.map((b, idx) => ({ id: `auto_${idx}`, name: b.name, findings: b.findings }))
            });
          } else {
            checkAndAutoSyncReport(100);
          }
          workstationSynced = true;
        } catch (syncErr) {
          console.warn("Spoken Workstation sync execution failed:", syncErr);
        }
      } else {
        console.log("Workstation credentials not configured, skipping spoken sync.");
      }
    }

    // Play pleasant acoustic success chime
    playAutonomousSuccessSound();

    return {
      success: true,
      summary: plan.summary,
      totalPatients: plan.patients.length,
      singlePatient: processedSingle,
      batchPatients: processedBatches,
      driveSaved: !!plan.globalDirectives.saveToDrive && isDriveConnected(),
      htmlDownloaded: !!plan.globalDirectives.downloadHtml,
      workstationSynced,
      macrosCreated,
      vocabularyCreated,
      handedOverFilesSummary,
    };
  } catch (error: any) {
    // Play error telemetry buzz on failure
    playAutonomousErrorSound();
    console.error("Autonomous plan execution error:", error);
    return {
      success: false,
      summary: "Autonomous execution encountered an error.",
      totalPatients: 0,
      batchPatients: [],
      driveSaved: false,
      htmlDownloaded: false,
      workstationSynced: false,
      error: error?.message || String(error)
    };
  }
}
