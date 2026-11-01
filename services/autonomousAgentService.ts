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
  const q = query.toLowerCase().trim();

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
  const tokens = q.split(/\s+/).filter(tok => tok.length > 2);
  let bestMatch: BuiltInTemplateItem | null = null;
  let maxScore = 0;

  for (const t of ALL_RADNITO_TEMPLATES) {
    const tName = t.name.toLowerCase();
    const tDesc = (t.description || '').toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (tName.includes(tok)) score += 3;
      else if (tDesc.includes(tok)) score += 1;
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
1. MULTI-PATIENT DETECTION & CROSS-TURN ENTITY CONSOLIDATION:
   - The radiologist may dictate Patient 1, move to Patient 2 in batch mode, and then later in the recording return to Patient 1 (e.g., "Oh, going back to Patient 1...", "For that first CT Brain patient, also add that there is a 4mm nodule...", "And one more finding for John Doe...").
   - You MUST identify all patients mentioned by name, number, or anatomical study, and CONSOLIDATE all later findings, addenda, and corrections into that specific patient's report findings. Do NOT create duplicate split reports for the same patient.

2. TARGET MODE ROUTING (Single Dictation vs Batch Mode):
   - Determine whether each patient should go into 'single' mode or 'batch' mode.
   - If the doctor says "single dictation", "single mode", or "record this first patient in single dictation", route that patient to targetMode: 'single'.
   - If the doctor says "batch mode", "add 5 things to batch", or dictates a queue of subsequent patients, route them to targetMode: 'batch'.
   - If not explicitly mentioned:
     * If only 1 patient is dictated, assign targetMode: 'single'.
     * If multiple patients are dictated without specific mode commands, assign the first patient to 'single' (active workstation report) and all subsequent patients to 'batch' (queued reports).

3. TEMPLATE ASSIGNMENT & MERGE DIRECTIVES:
   - Identify if a template is requested for any patient (e.g., "CT Brain Trauma", "Chest X-Ray Normal", "MRI Lumbar Spine", "Abdomen USG", "PNS Sinusitis").
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
ATTACHED FILES MANIFEST (Available for handoff):
The user has uploaded the following file(s) into this session.
DO NOT read or parse the file contents yourself.
Assign/hand over files to the appropriate patient report(s) based on what the doctor dictates in the audio (e.g., "attach the first uploaded file to Patient 1", "use the Brain MRI for Patient 2", "attach all files to batch").
${attachedFiles.map(f => `- File #${f.index}: "${f.alias ? f.alias : f.file.name}" (Filename: ${f.file.name}, MIME: ${f.file.type || 'unknown'}, Size: ${(f.file.size / 1024).toFixed(0)} KB)`).join('\n')}
If the doctor mentions assigning any of these files to a patient, set their 1-based file indices in "attachedFileIndices" for that patient.
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
                base64: docxB64,
                name: `${matched.name}.docx`,
                extractedText: matched.lines ? matched.lines.join('\n') : matched.name
              };
            }
          } catch (e) {
            console.warn('Could not load docx for single template:', e);
          }

          singlePrompt = `[TEMPLATE_ID: ${matched.id}] Merged with template: ${matched.name}. ${singlePatientItem.mergeDirectives || ''}`.trim();

          try {
            finalFindings = await mergeDictatedFindingsWithTemplate(
              finalFindings,
              matched,
              context.selectedModel,
              context.audioBlob,
              singlePatientItem.mergeDirectives || ''
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
                  base64: docxB64,
                  name: `${matched.name}.docx`,
                  extractedText: matched.lines ? matched.lines.join('\n') : matched.name
                };
              }
            } catch (e) {
              console.warn('Could not load docx for batch template:', e);
            }

            bpPrompt = `[TEMPLATE_ID: ${matched.id}] Merged with template: ${matched.name}. ${bp.mergeDirectives || ''}`.trim();

            try {
              finalFindings = await mergeDictatedFindingsWithTemplate(
                finalFindings,
                matched,
                context.selectedModel,
                context.audioBlob,
                bp.mergeDirectives || ''
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
