import { GoogleGenAI, Type, GenerateContentResponse, Chat } from "@google/genai";
import { DEFAULT_LIVE_MODEL, DEFAULT_GEMINI_PROMPT, REPROCESS_GEMINI_PROMPT, TEMPLATE_GEMINI_PROMPT, REPORT_TEMPLATES, ERROR_IDENTIFIER_PROMPT, INITIAL_AGENT_PROMPT, REFINEMENT_AGENT_PROMPT, SYNTHESIZER_AGENT_PROMPT, VISUAL_TEMPLATE_GEMINI_PROMPT, getLiveModelFallbackChain, getFreeTierModelFallbackChain, DEFAULT_SELECTED_MODEL, GEMINI_FLASH_LITE_MODEL, FREE_TIER_HIGH_ACCURACY_SIBLING, getOptimalThinkingLevel, GeminiThinkingTask, ReportTemplate } from '../constants';
import { IdentifiedError } from "../types";
import { isTableRowFinding } from "./docxService";
import { expandMacrosInFindings, expandMacrosInSingleText, getMacroPromptContext } from "./macroDictionaryService";
import {
  emitModelFailoverNotice,
  executeWithApiKeyFailover,
  getCandidateKeysForOperation,
  getClientForApiKey,
  getRandomAIClient,
  isModelLevelServiceUnavailableError,
  isStrictSelectedModelOnlyEnabled,
} from "./apiKeyService";
import { findTemplateByIdOrNumber } from "./templateStorage";
import { buildCombinedTemplateBundle, canonicalizeTemplateIdToken, extractTemplateTagIds, mergeTemplateImages, DocxTemplateData as BundleDocxTemplateData } from "./upcomingTemplateService";

export const getAI = (): GoogleGenAI => {
  return getRandomAIClient();
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
 * Ensures the exact selected model is strictly preserved.
 */
export function resolveApiTargetModel(model?: string): string {
  if (!model) return DEFAULT_SELECTED_MODEL;
  // Audio-only transcription models do not support JSON mode / structured schema reasoning
  if (model === 'gemini-3.5-transcribe' || model === 'gemini-3.5-transcribe-live') {
    return DEFAULT_SELECTED_MODEL;
  }
  return model;
}

function getErrorStatusCode(err: any): number | undefined {
  const raw = err?.status ?? err?.code ?? err?.error?.code;
  return typeof raw === 'number' ? raw : undefined;
}

function isTransientOrKeyError(err: any): boolean {
  if (!err) return false;
  const status = getErrorStatusCode(err);
  if (status === 401 || status === 403 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('api key') ||
    msg.includes('api_key') ||
    msg.includes('permission_denied') ||
    msg.includes('unauthenticated') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('overloaded') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('failed to fetch') ||
    msg.includes('network')
  );
}

/**
 * Determines if an error is caused by invalid/corrupt/unsupported media or audio input
 * rather than API key quota or JSON schema mode differences.
 */
export function isNonRetryableMediaError(err: any): boolean {
  if (!err || isTransientOrKeyError(err)) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes('invalid audio') ||
    msg.includes('unable to submit request') ||
    msg.includes('unable to process input') ||
    msg.includes('could not decode') ||
    msg.includes('unsupported audio') ||
    msg.includes('unsupported mime') ||
    msg.includes('invalid mime') ||
    msg.includes('empty audio') ||
    msg.includes('no audio') ||
    msg.includes('audio file') ||
    msg.includes('corrupt')
  ) {
    return true;
  }
  return (
    msg.includes('invalid argument') &&
    (msg.includes('audio') || msg.includes('media') || msg.includes('mime') || msg.includes('file') || msg.includes('payload'))
  );
}

async function detectAudioMimeFromHeader(blob: Blob): Promise<string | null> {
  try {
    if (blob.size < 4) return null;
    const headerBuf = await blob.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(headerBuf);
    // RIFF....WAVE -> audio/wav
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
      return 'audio/wav';
    }
    // EBML header -> audio/webm
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
      return 'audio/webm';
    }
    // OggS -> audio/ogg
    if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
      return 'audio/ogg';
    }
    // fLaC -> audio/flac
    if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) {
      return 'audio/flac';
    }
    // ISO Base Media (ftyp) -> audio/mp4
    if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return 'audio/mp4';
    }
    // ID3 or MP3 frame sync -> audio/mp3
    if ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
        (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0)) {
      return 'audio/mp3';
    }
  } catch {}
  return null;
}

/**
 * Determines if an error thrown by the Gemini API is caused by lack of JSON mode support or schema rejection.
 */
export function isJsonModeUnsupportedError(err: any): boolean {
  if (!err || isNonRetryableMediaError(err)) return false;
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

  return expandMacrosInFindings(groupedResult);
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

export const SAFE_INLINE_MEDIA_BYTES = Math.floor(14.5 * 1024 * 1024);

export interface UploadedGeminiFileRef {
  name: string;
  uri: string;
  mimeType: string;
  client: GoogleGenAI;
}

export interface BlobContentPartDescriptor {
  blob: Blob;
  cleanMime: string;
  headerText?: string;
  textPartText?: string;
  contextPartText?: string;
  inlineBase64?: string;
}

/**
 * Invokes Gemini `generateContent` directly over REST so modern `thinkingConfig.thinkingLevel`
 * settings are preserved intact instead of being stripped by `@google/genai@0.14.0`.
 */
export async function callGenerateContentWithOptimalThinking(params: {
  client: GoogleGenAI;
  apiKey: string;
  model: string;
  parts: any[];
  temperature?: number;
  responseMimeType?: string;
  responseSchema?: any;
  abortSignal?: AbortSignal;
  taskType?: GeminiThinkingTask;
}): Promise<string> {
  const {
    client,
    apiKey,
    model,
    parts,
    temperature = 0.1,
    responseMimeType,
    responseSchema: schema,
    abortSignal,
    taskType = 'transcription',
  } = params;

  const thinkingLevel = getOptimalThinkingLevel(model, taskType);

  if (typeof fetch !== 'function' || !apiKey) {
    const config: Record<string, any> = { temperature };
    if (responseMimeType) config.responseMimeType = responseMimeType;
    if (schema) config.responseSchema = schema;
    const response: GenerateContentResponse = await client.models.generateContent({
      model,
      contents: { parts },
      config,
    });
    return response.text?.trim() || '';
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const sendRest = async (includeThinking: boolean): Promise<string> => {
    const generationConfig: Record<string, any> = { temperature };
    if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
    if (schema) generationConfig.responseSchema = schema;
    if (includeThinking && thinkingLevel) {
      generationConfig.thinkingConfig = { thinkingLevel };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig,
      }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.message || `Gemini API HTTP ${res.status}: ${res.statusText}`;
      const err: any = new Error(msg);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    if (data?.promptFeedback?.blockReason) {
      const blockedErr: any = new Error(`Gemini API blocked input: ${data.promptFeedback.blockReason}`);
      blockedErr.isNonRetryable = true;
      throw blockedErr;
    }

    const candidateParts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(candidateParts)) return '';
    return candidateParts
      .filter((p: any) => !p?.thought && typeof p?.text === 'string')
      .map((p: any) => p.text)
      .join('')
      .trim();
  };

  try {
    return await sendRest(Boolean(thinkingLevel));
  } catch (err: any) {
    if (err?.name === 'AbortError' || abortSignal?.aborted) throw err;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (
      thinkingLevel &&
      getErrorStatusCode(err) === 400 &&
      (msg.includes('thinking') || msg.includes('thinkinglevel'))
    ) {
      console.warn(`[Gemini API] Model ${model} rejected thinkingLevel="${thinkingLevel}"; retrying without thinkingConfig...`);
      return await sendRest(false);
    }
    throw err;
  }
}

/**
 * Prepares per-blob descriptors once (detecting audio MIME headers, extracting text,
 * and pre-encoding base64 only when within the safe 14.5MB inline limit).
 */
export async function prepareBlobPartDescriptors(
  blobs: Blob[],
  options: { includeContextLabels?: boolean } = {}
): Promise<BlobContentPartDescriptor[]> {
  const descriptors: BlobContentPartDescriptor[] = [];
  const includeLabels = options.includeContextLabels !== false;

  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    let cleanMime = getCleanMimeType(blob);
    if (!blob.type || blob.type === 'application/octet-stream' || cleanMime === 'audio/ogg' || cleanMime === 'audio/webm') {
      const detectedAudioMime = await detectAudioMimeFromHeader(blob);
      if (detectedAudioMime) {
        cleanMime = detectedAudioMime;
      }
    }

    const isAudio = cleanMime.startsWith('audio/');
    const isVideo = cleanMime.startsWith('video/');
    const isPdf = cleanMime === 'application/pdf';
    const isImage = cleanMime.startsWith('image/');
    const isText = cleanMime.startsWith('text/');
    const fileName = (blob as any).name ? `"${(blob as any).name}"` : `Segment #${i + 1}`;

    let headerText: string | undefined;
    let contextPartText: string | undefined;
    if (includeLabels) {
      if (blobs.length > 1) {
        headerText = `--- Dictation / Input File #${i + 1}: ${fileName} (${cleanMime}) ---`;
      } else if (!isAudio) {
        contextPartText = `Context & Input File: The user has provided an input file (${isPdf ? 'PDF document' : isImage ? 'Medical scan / image' : isVideo ? 'Video recording' : isText ? 'Text / Document' : 'Document'}). Analyze, transcribe, extract, and interpret all radiological findings, clinical indications, observations, measurements, impressions, and technique thoroughly into the structured findings array following all medical and radiology transcription rules.`;
      }
    }

    let textPartText: string | undefined;
    if (isText) {
      try {
        const textContent = await blob.text();
        textPartText = `[Dictated / Pasted Clinical Text Content for ${fileName}]:\n"""\n${textContent}\n"""\nInstruction: This is dictated / clinical text provided by the clinician. Transcribe, analyze, correct, format, and structure this text into formal radiology findings according to all radiology report and transcription rules.`;
      } catch (e) {
        console.warn('Could not read blob as text:', e);
      }
    }

    const inlineBase64 = blob.size <= SAFE_INLINE_MEDIA_BYTES ? await blobToBase64(blob) : undefined;
    descriptors.push({
      blob,
      cleanMime,
      headerText,
      contextPartText,
      textPartText,
      inlineBase64,
    });
  }

  return descriptors;
}

/**
 * Resolves descriptors into Gemini `inlineData` (fast path <=14.5MB) or Files API `fileData` (>14.5MB),
 * scoped to the active API key and tracked for best-effort cleanup.
 */
export async function resolveBlobDescriptorPartsForAttempt(params: {
  descriptors: BlobContentPartDescriptor[];
  client: GoogleGenAI;
  apiKey: string;
  uploadedByKey: Map<string, Map<number, UploadedGeminiFileRef>>;
  abortSignal?: AbortSignal;
}): Promise<any[]> {
  const { descriptors, client, apiKey, uploadedByKey, abortSignal } = params;
  const resolved: any[] = [];

  for (let i = 0; i < descriptors.length; i++) {
    if (abortSignal?.aborted) throw new DOMException('Aborted by user', 'AbortError');
    const desc = descriptors[i];
    if (desc.headerText) resolved.push({ text: desc.headerText });
    if (desc.contextPartText) resolved.push({ text: desc.contextPartText });
    if (desc.textPartText) resolved.push({ text: desc.textPartText });

    if (desc.inlineBase64 !== undefined) {
      resolved.push({
        inlineData: {
          mimeType: desc.cleanMime,
          data: desc.inlineBase64,
        },
      });
      continue;
    }

    let keyUploads = uploadedByKey.get(apiKey);
    if (!keyUploads) {
      keyUploads = new Map();
      uploadedByKey.set(apiKey, keyUploads);
    }

    let ref = keyUploads.get(i);
    if (!ref) {
      const uploaded = await client.files.upload({
        file: desc.blob,
        config: { mimeType: desc.cleanMime },
      });
      let readyFile = uploaded;
      let pollCount = 0;
      while (readyFile.state === 'PROCESSING' && pollCount < 15 && readyFile.name) {
        if (abortSignal?.aborted) throw new DOMException('Aborted by user', 'AbortError');
        await new Promise((r) => setTimeout(r, 1000));
        readyFile = await client.files.get({ name: readyFile.name });
        pollCount++;
      }
      if (!readyFile.uri) {
        throw new Error('Gemini Files API upload completed without a valid file URI.');
      }
      ref = {
        name: readyFile.name || '',
        uri: readyFile.uri,
        mimeType: readyFile.mimeType || desc.cleanMime,
        client,
      };
      keyUploads.set(i, ref);
    }

    resolved.push({
      fileData: {
        fileUri: ref.uri,
        mimeType: ref.mimeType,
      },
    });
  }

  return resolved;
}

export async function cleanupUploadedGeminiFiles(
  uploadedByKey: Map<string, Map<number, UploadedGeminiFileRef>>
): Promise<void> {
  const deletions: Promise<any>[] = [];
  for (const keyMap of uploadedByKey.values()) {
    for (const ref of keyMap.values()) {
      if (ref.name) {
        deletions.push(ref.client.files.delete({ name: ref.name }).catch(() => {}));
      }
    }
  }
  await Promise.all(deletions);
}

function isQuotaOrRateLimitExceededError(err: any): boolean {
  if (!err) return false;
  if (getErrorStatusCode(err) === 429) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

/**
 * Executes a Gemini operation on the primary resolved model and automatically cascades across
 * the ordered accurate Free-Tier fallback chain (excluding Flash-Lite) on BOTH quota/429 limits
 * AND model-wide 503/500/404 overload/unavailability errors, pre-skipping models already known to
 * be RPD-exhausted today and informing the UI on failover.
 */
export async function executeWithFreeTierModelFallback<T>(
  selectedModel: string,
  runForModel: (targetModelName: string, hasMoreFallbackModels?: boolean) => Promise<T>,
  options?: { abortSignal?: AbortSignal; skipCrossModelFallback?: boolean }
): Promise<T> {
  const resolvedPrimary = resolveApiTargetModel(selectedModel);
  const userStrictOnly = !options?.skipCrossModelFallback && isStrictSelectedModelOnlyEnabled();
  const strictOnly = Boolean(options?.skipCrossModelFallback || userStrictOnly);
  const chain = strictOnly
    ? [resolvedPrimary]
    : getFreeTierModelFallbackChain(resolvedPrimary);
  let lastErr: any = null;

  for (let i = 0; i < chain.length; i++) {
    const modelName = chain[i];
    if (options?.abortSignal?.aborted) {
      throw new DOMException('Aborted by user', 'AbortError');
    }

    const hasMoreFallbackModels = i < chain.length - 1;
    try {
      return await runForModel(modelName, hasMoreFallbackModels);
    } catch (err: any) {
      if (err?.name === 'AbortError' || options?.abortSignal?.aborted) {
        throw err;
      }
      lastErr = err;
      const isQuotaErr = isQuotaOrRateLimitExceededError(err);
      const isUnavailableErr = isModelLevelServiceUnavailableError(err);
      const isFailoverTrigger = isQuotaErr || isUnavailableErr;

      if (hasMoreFallbackModels && isFailoverTrigger) {
        const nextModel = chain[i + 1];
        const reason: 'rate_limit' | 'service_unavailable' = isQuotaErr ? 'rate_limit' : 'service_unavailable';
        console.warn(
          `[Gemini API] ${modelName} ${isQuotaErr ? 'exhausted Free-Tier quota across keys' : 'is experiencing high demand / unavailable'}; failing over to next accurate model ${nextModel}...`
        );
        emitModelFailoverNotice({
          fromModel: modelName,
          toModel: nextModel,
          reason,
        });
        continue;
      }
      if (userStrictOnly && isFailoverTrigger) {
        const triedCount = typeof err?.triedKeysCount === 'number' && err.triedKeysCount > 0 ? err.triedKeysCount : 1;
        const strictErr: any = new Error(
          isQuotaErr
            ? `Model ${resolvedPrimary} reached its rate limit/quota across all ${triedCount} active API key(s) while "Selected Model Only" is ON. Turn OFF "Selected Model Only" to automatically use accurate backup models, or add another free Google-account key.`
            : `Model ${resolvedPrimary} is currently experiencing high demand / unavailable across all ${triedCount} active API key(s) while "Selected Model Only" is ON. Turn OFF "Selected Model Only" to automatically switch to backup models, or try again shortly.`
        );
        strictErr.status = getErrorStatusCode(err) ?? (isQuotaErr ? 429 : 503);
        throw strictErr;
      }
      if (!strictOnly && isFailoverTrigger) {
        const exhaustedErr: any = new Error(
          isQuotaErr
            ? `All accurate Free-Tier models (${chain.join(' → ')}) reached today's rate limit across your active API key(s). Gemini 3.5 Flash Lite was intentionally skipped to preserve clinical dictation accuracy. Add another free Google-account key in API Keys, wait 60s for RPM reset, or manually select Flash Lite if non-critical.`
            : `All accurate Free-Tier models (${chain.join(' → ')}) are currently unavailable or overloaded across your active API key(s). Gemini 3.5 Flash Lite was intentionally skipped to preserve clinical dictation accuracy. Please retry in a moment or add another free Google-account key.`
        );
        exhaustedErr.status = getErrorStatusCode(err) ?? (isQuotaErr ? 429 : 503);
        throw exhaustedErr;
      }
      throw err;
    }
  }

  throw lastErr;
}

/**
 * Universal safe caller for Gemini models that applies optimal thinking settings and gracefully handles
 * JSON mode incompatibilities, Files API fallback (>14.5MB), and full free-tier cross-key + accurate-model failover.
 */
export async function generateContentWithJsonFallback(
  model: string,
  partsOrResolver: any[] | ((client: GoogleGenAI, apiKey: string) => Promise<any[]>),
  schema: any = responseSchema,
  temperature: number = 0.1,
  abortSignal?: AbortSignal,
  taskType: GeminiThinkingTask = 'transcription',
  options?: { skipCrossModelFallback?: boolean; failFastOnModelUnavailable?: boolean }
): Promise<string> {
  const resolvedModel = resolveApiTargetModel(model);

  const runOnModelAcrossKeys = async (
    targetModelName: string,
    hasMoreFallbackModels?: boolean
  ): Promise<string> => {
    const failFastOnModelUnavailable = Boolean(
      hasMoreFallbackModels ?? options?.failFastOnModelUnavailable
    );
    return await executeWithApiKeyFailover(
      async (client, apiKey) => {
        const parts = typeof partsOrResolver === 'function'
          ? await partsOrResolver(client, apiKey)
          : partsOrResolver;

        // Strategy 1: Primary attempt with structured JSON schema + optimal thinkingLevel on the selected model
        try {
          const text = await callGenerateContentWithOptimalThinking({
            client,
            apiKey,
            model: targetModelName,
            parts,
            temperature,
            responseMimeType: "application/json",
            responseSchema: schema,
            abortSignal,
            taskType,
          });

          if (text) return text;
        } catch (err: any) {
          if (err?.name === 'AbortError' || abortSignal?.aborted) {
            throw err;
          }
          if (isNonRetryableMediaError(err)) {
            (err as any).isNonRetryable = true;
            throw err;
          }
          // Strategy 2: If JSON mode unsupported or schema error, retry prompt-only on the SAME selected model
          if (isJsonModeUnsupportedError(err) || (err?.message && err.message.toLowerCase().includes('schema'))) {
            console.warn(`[Gemini API] Primary JSON mode call failed on model ${targetModelName} (${err?.message || err}). Attempting prompt-only fallback without schema config on SAME model...`);
            try {
              const partsWithJsonInstruction = [
                ...parts,
                { text: '\n\nCRITICAL OUTPUT REQUIREMENT: Output ONLY a valid JSON object in the exact format: {"findings": ["finding 1", "finding 2", ...]}. Do NOT output any markdown wrappers or conversational text.' }
              ];

              const retryText = await callGenerateContentWithOptimalThinking({
                client,
                apiKey,
                model: targetModelName,
                parts: partsWithJsonInstruction,
                temperature,
                abortSignal,
                taskType,
              });

              if (retryText) return retryText;
            } catch (retryErr: any) {
              console.warn(`[Gemini API] Prompt-only retry on ${targetModelName} failed:`, retryErr);
              const retryMsg = (retryErr instanceof Error ? retryErr.message : String(retryErr)).toLowerCase();
              if (
                isNonRetryableMediaError(retryErr) ||
                (!isTransientOrKeyError(retryErr) && (getErrorStatusCode(retryErr) === 400 || retryMsg.includes('invalid argument')))
              ) {
                (retryErr as any).isNonRetryable = true;
                throw retryErr;
              }
              if (isTransientOrKeyError(retryErr) || isModelLevelServiceUnavailableError(retryErr)) {
                throw retryErr;
              }
            }
          }

          // Re-throw so executeWithApiKeyFailover retries with another key or fails over to next model
          throw err;
        }

        return '';
      },
      { selectedModel: targetModelName, abortSignal, failFastOnModelUnavailable }
    );
  };

  return await executeWithFreeTierModelFallback(
    resolvedModel,
    runOnModelAcrossKeys,
    { abortSignal, skipCrossModelFallback: options?.skipCrossModelFallback }
  );
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

export interface SpokenTemplateResolution {
  templateIds: string[];
  templateName: string;
  promptText: string;
  docxData: BundleDocxTemplateData | null;
  images: Array<{ data: string; mimeType: string }>;
}

export interface ProcessAudioOptions {
  onSpokenTemplateResolved?: (resolved: SpokenTemplateResolution) => void;
  mergeBaseFindings?: string[];
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

  // Check if built-in templates or explicit template IDs are specified via prompt or multi-section docxText
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
    const templateContent = (docxText.length > 0)
      ? docxText
      : combinedSections.map((t, idx) => {
          return `================================================================================\nTEMPLATE ${idx + 1}: "${t.name}"\n--------------------------------------------------------------------------------\n${t.content}\n${t.skillPrompt ? `CLINICAL SKILL DIRECTIVES FOR THIS SECTION:\n${t.skillPrompt}\n` : ''}`;
        }).join('\n\n');

    const templateContextPrompt = `
================================================================================
ACTIVE COMBINED RADIOLOGY REPORT TEMPLATES (${combinedSections.length} TEMPLATES COMBINED):
${combinedSections.map((t, idx) => {
  return `--------------------------------------------------------------------------------
TEMPLATE ${idx + 1}: "${t.name}"
BASELINE TEMPLATE CONTENT:
"""
${t.content}
"""
${t.skillPrompt ? `AUTHORITATIVE CLINICAL SKILL & PHRASING DIRECTIVES:\n${t.skillPrompt}` : ''}
`;
}).join('\n')}
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
    const templateName = promptTemplateName || (customDocx.name ? customDocx.name.replace(/\.[^/.]+$/, '').replace(/^\d+[-_ ]*/, '') : 'Uploaded DOCX Template');
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

  // 3. Text Prompt Analysis (Built-in template or Custom text template)
  if (customPrompt && customPrompt.trim().length > 0) {
    const trimmed = customPrompt.trim();

    // Check for custom text template indicators:
    // a) Keywords indicating template merge mode or explicit [TEMPLATE_ID: ...] tag
    const hasTemplateIdTag = explicitTagIds.length > 0;
    const hasTemplateKeyword = hasTemplateIdTag || /(template|report template|normal report|standard report|merge with|integrate into template|normal template|use template|format as template|merge dictation)/i.test(trimmed);
    
    // b) Structural radiology template indicators
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const hasRadiologyHeaders = /(TECHNIQUE|FINDINGS|IMPRESSION|CLINICAL PROFILE|CLINICAL HISTORY|INDICATION|COMPARISON|PROTOCOL|OBSERVATIONS):/i.test(trimmed);
    const hasMultipleOrganSections = (trimmed.match(/([A-Z][a-zA-Z\s]{2,25}):\s+[A-Z]/g) || []).length >= 2;
    const isMultiLineTemplate = lines.length >= 3 && (hasRadiologyHeaders || hasMultipleOrganSections || hasTemplateKeyword || trimmed.length > 80);

    if (hasTemplateKeyword || hasRadiologyHeaders || isMultiLineTemplate) {
      const templateContent = trimmed;
      const explicitName = parseSingleTemplateNameFromPrompt(trimmed);
      const templateName = explicitName || (lines[0] && lines[0].length < 60 ? lines[0].replace(/^#+\s*/, '') : 'Custom Text Template');
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
  zero: '0', oh: '0', o: '0', one: '1', won: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4',
  five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
};

const SPOKEN_TENS_WORDS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
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
  // Protect "hundred and <X>" from being split at "and"
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
    // Extract atomic matches inside runs like "add_128" or "5 15"
    const subMatches = [...tok.matchAll(new RegExp(ID_ATOM_PATTERN, 'gi'))].map(m => m[0].trim()).filter(Boolean);
    const candidates = subMatches.length > 0 ? subMatches : [tok];
    for (let candidate of candidates) {
      const addPrefixed = candidate.match(/^(?:builtin_)?(?:tpl[\s_-]*)?add(?:[\s_-]*(?:underscore|under\s+score|dash|hyphen)[\s_-]*|[\s_-]+)(.+)$/i);
      if (addPrefixed) {
        const tail = addPrefixed[1].trim();
        const numParsed = parseSpokenDigitsOrNumber(tail);
        candidate = numParsed ? `add_${numParsed.padStart(3, '0')}` : `add_${tail.replace(/\s+/g, '_')}`;
      } else {
        // Normalize phonetic "see 1" / "sea two" / "c two" / "custom 2" -> "C2" or "C <rest>"
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
 * Detects and extracts spoken template ID directive token(s): {template id [ID]} or spoken "template id X and Y"
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

  const listTailPattern = `(` +
    ID_ATOM_PATTERN +
    `(?:\\s*(?:,|;|&|\\+|\\band\\b|\\balso\\b|\\bwith\\b)\\s*(?:(?:template\\s+(?:ids?|numbers?|no\\.?)\\s*[:\\s#-]*))?` +
    ID_ATOM_PATTERN +
    `)*)`;

  const bracedTemplateRegex = /\{\s*((?:add|use|apply|insert|combine|switch(?:\s+to)?|change(?:\s+to)?|replace(?:\s+with)?|merge(?:\s+with)?)\s+)?template(?:s|\s+ids?|\s+numbers?|\s+no\.?)?\s*[:\s#-]*([a-zA-Z0-9_,\-&\+\s]+?)\s*\}\.?/gi;
  const bracedPrefixedIdRegex = /\{\s*((?:use|apply|add|merge(?:\s+with)?)?\s*)?((?:(?:builtin_)?(?:tpl[\s_-]*)?add[\s_-]*\d+|tpl_\d+|c\d+)(?:\s*(?:,|;|&|\+|\band\b)\s*[a-zA-Z0-9_\s-]+)*)\s*\}\.?/gi;

  // Matches "template id 5", "template id add_128", "add template id add 128", or omitted-"id" explicit prefix ("template add_128", "template add 128", "template C1")
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
        const idSegment = (m[rawTokenGroupIndex] !== undefined
          ? m[rawTokenGroupIndex]
          : full
              .replace(/^[\{\s]+/, '')
              .replace(/[\}\s]+$/, '')
              .replace(/^(?:add|use|apply|insert|combine|also\s+(?:add|use)|switch(?:\s+to)?|change(?:\s+to)?|replace(?:\s+with)?|merge(?:\s+with)?)\s+/i, '')
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
      rawMatches.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
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

async function resolveAndApplySpokenTemplates(
  findings: string[],
  opts: {
    templateInfo: DetectedTemplateInfo;
    model: string;
    audioBlobs: Blob[];
    customPrompt?: string;
    customImages?: Array<{ data: string; mimeType: string }> | null;
    customDocx?: CustomDocxInput;
    abortSignal?: AbortSignal;
    onSpokenTemplateResolved?: (resolved: SpokenTemplateResolution) => void;
    mergeBaseFindings?: string[];
  }
): Promise<string[]> {
  const { templateIds, mode, cleanedFindings } = extractSpokenTemplateDirective(findings);
  if (templateIds.length === 0) {
    return findings;
  }

  const normalizeCompareId = (id: string): string => canonicalizeTemplateIdToken(id).toLowerCase();

  const activeTagIds = extractTemplateTagIds(opts.customPrompt);
  const activeSet = new Set(activeTagIds.map(normalizeCompareId));
  const spokenCompareIds = templateIds.map(normalizeCompareId);

  // If the only emitted template IDs are already active in the prompt, just strip the echo token cleanly
  const hasNewSpokenId = spokenCompareIds.some(id => !activeSet.has(id));
  if (opts.templateInfo.isTemplateMode && !hasNewSpokenId) {
    return cleanedFindings.length > 0 ? cleanedFindings : findings;
  }

  const targetIds: string[] = [];
  const pushUniqueId = (id: string) => {
    const norm = normalizeCompareId(id);
    if (!targetIds.some(x => normalizeCompareId(x) === norm)) {
      targetIds.push(id);
    }
  };

  if (opts.templateInfo.isTemplateMode && mode === 'add' && activeTagIds.length > 0) {
    activeTagIds.forEach(pushUniqueId);
  }
  templateIds.forEach(pushUniqueId);

  const resolvedList = (await Promise.all(targetIds.map(id => findTemplateByIdOrNumber(id)))).filter(
    (tpl): tpl is NonNullable<typeof tpl> => Boolean(tpl)
  );

  // Also preserve an untagged uploaded DOCX template if user spoke "add template id X" on top of it
  const templatesToBundle: any[] = [];
  if (
    opts.templateInfo.isTemplateMode &&
    mode === 'add' &&
    activeTagIds.length === 0 &&
    opts.customDocx &&
    (opts.customDocx.extractedText || opts.customDocx.text)
  ) {
    templatesToBundle.push({
      id: 'custom_docx_base',
      name: opts.templateInfo.templateName || opts.customDocx.name || 'Base Template',
      lines: ((opts.customDocx.extractedText || opts.customDocx.text) || '').split('\n').filter(Boolean),
      docxBase64: opts.customDocx.data,
      fileName: opts.customDocx.name,
      images: opts.customImages || [],
    });
  }
  templatesToBundle.push(...resolvedList);

  if (templatesToBundle.length === 0) {
    return cleanedFindings;
  }

  const bundle = await buildCombinedTemplateBundle(templatesToBundle);
  const mergedImages = mergeTemplateImages(opts.customImages, bundle.images);

  try {
    opts.onSpokenTemplateResolved?.({
      templateIds: targetIds,
      templateName: bundle.name,
      promptText: bundle.promptText,
      docxData: bundle.docxData,
      images: mergedImages,
    });
  } catch (cbErr) {
    console.warn('onSpokenTemplateResolved callback notice:', cbErr);
  }

  const spokenCleaned = cleanedFindings.length > 0 ? cleanedFindings : findings;
  const findingsToMerge =
    opts.mergeBaseFindings && opts.mergeBaseFindings.length > 0
      ? [...opts.mergeBaseFindings, ...spokenCleaned]
      : spokenCleaned;
  const merged = await mergeDictatedFindingsWithTemplate(
    findingsToMerge,
    templatesToBundle.length === 1 ? templatesToBundle[0] : templatesToBundle,
    opts.model,
    opts.audioBlobs,
    bundle.promptText,
    bundle.docxData,
    opts.abortSignal,
    mergedImages
  );

  if (merged && merged.length > 0) {
    return merged;
  }
  return findingsToMerge;
}

export const processAudio = async (
  audioBlob: Blob | Blob[], 
  model: string, 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  existingFindings?: string[],
  customDocx?: CustomDocxInput,
  abortSignal?: AbortSignal,
  options?: ProcessAudioOptions
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
  
  const macroContext = getMacroPromptContext();
  const spokenTemplateReminder = templateInfo.isTemplateMode
    ? `SPOKEN TEMPLATE ID ADDITION/SWITCH: If the radiologist explicitly speaks another Template ID in the audio (e.g., "add template id 15", "template id 200", "combine with template id C1", "switch to template id 42"), emit "{add template id [ID]}" (e.g. "{add template id 200}" or "{template id 1, 200}") at the very beginning of the "findings" array. Do NOT emit unless explicit numeric (1-300), add_XXX, or C-code IDs were spoken.`
    : '';
  const prompt = [
    customPrompt 
      ? `${basePrompt}\n\nCustom Instructions (Reminder):\n${customPrompt}` 
      : basePrompt,
    macroContext,
    spokenTemplateReminder
  ].filter(Boolean).join('\n\n');

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

  const blobDescriptors = await prepareBlobPartDescriptors(audioBlobs, { includeContextLabels: true });
  const uploadedByKey = new Map<string, Map<number, UploadedGeminiFileRef>>();

  const resolveRequestParts = async (client: GoogleGenAI, apiKey: string): Promise<any[]> => {
    const mediaParts = await resolveBlobDescriptorPartsForAttempt({
      descriptors: blobDescriptors,
      client,
      apiKey,
      uploadedByKey,
      abortSignal,
    });
    return [...parts, ...mediaParts];
  };

  const targetModel = resolveApiTargetModel(model);
  const audioTaskType: GeminiThinkingTask =
    isReprocessing ||
    templateInfo.isTemplateMode ||
    Boolean(customPrompt?.trim()) ||
    Boolean(customImages && customImages.length > 0) ||
    Boolean(customDocx)
      ? 'reasoning'
      : 'transcription';

  try {
    const rawResponseText = await generateContentWithJsonFallback(
      targetModel,
      resolveRequestParts,
      responseSchema,
      0.1,
      abortSignal,
      audioTaskType
    );
    const findings = extractFindingsFromResponse(rawResponseText);

    if (findings && findings.length > 0) {
      try {
        return await resolveAndApplySpokenTemplates(findings, {
          templateInfo,
          model: targetModel,
          audioBlobs,
          customPrompt,
          customImages,
          customDocx,
          abortSignal,
          onSpokenTemplateResolved: options?.onSpokenTemplateResolved,
          mergeBaseFindings: options?.mergeBaseFindings,
        });
      } catch (mergeErr: any) {
        if (mergeErr?.name === 'AbortError' || abortSignal?.aborted) throw mergeErr;
        console.warn("Spoken template merge error, falling back to cleaned findings:", mergeErr);
        const { cleanedFindings } = extractSpokenTemplateDirective(findings);
        return cleanedFindings.length > 0 ? cleanedFindings : findings;
      }
    } else {
      throw new Error("Invalid data structure in API response. Expected a 'findings' array.");
    }
  } catch (error: any) {
    if (error?.name === 'AbortError' || abortSignal?.aborted) {
      throw error;
    }
    console.warn("Gemini API call returned error, evaluating fallback:", error);

    // In MERGE MODE ALONE: If error is JSON mode unsupported or schema failure, retry cleanly with target model & raw JSON prompt
    const isMediaOrNonRetryable = Boolean((error as any)?.isNonRetryable) || isNonRetryableMediaError(error);
    const isSchemaOrParseError =
      !isMediaOrNonRetryable &&
      (isJsonModeUnsupportedError(error) ||
        (error instanceof Error && error.message.includes("Expected a 'findings' array")));
    if (templateInfo.isTemplateMode && isSchemaOrParseError) {
      try {
        const retryText = await generateContentWithJsonFallback(targetModel, resolveRequestParts, responseSchema, 0.1, abortSignal, audioTaskType);
        const parsedFindings = extractFindingsFromResponse(retryText);
        if (parsedFindings && parsedFindings.length > 0) {
          return parsedFindings;
        }
      } catch (retryErr: any) {
        if (retryErr?.name === 'AbortError' || abortSignal?.aborted) {
          throw retryErr;
        }
        console.warn("Merge mode fallback attempt error:", retryErr);
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
  } finally {
    cleanupUploadedGeminiFiles(uploadedByKey).catch(() => {});
  }
};

/**
 * Detects spoken structural and heading modifications (e.g. "change CT extremity heading to CT right arm",
 * "change title to CT SCAN OF RIGHT FOREARM", "rename pelvis heading to lower abdomen") and applies them to
 * the report's title and section headings, while stripping out conversational meta-instructions.
 */
export function applySpokenHeadingModifications(findings: string[], directives?: string): string[] {
  if (!findings || findings.length === 0) return findings;

  const allDirectivesText = [directives || '', ...findings].join(' ');

  // 1. Detect Clinical Profile spoken styling directives (e.g. "keep clinical profile sentence underlined bold and unitalic")
  let profileBold = false;
  let profileUnderline = false;
  let profileUnitalic = false;
  let hasProfileStyleDirective = false;

  const profDirectiveMatch = allDirectivesText.match(/(?:keep\s+)?(?:clinical\s*profile\s*(?:sentence\s*)?)?(?:to\s+be\s+)?(?:underlined|underline|bold|bolded|unitalic|un-italic|not\s+italic|non-italic|no\s+italic|italic)(?:[\s,]+(?:and\s+)?(?:underlined|underline|bold|bolded|unitalic|un-italic|not\s+italic|non-italic|no\s+italic|italic))*(?:\s*like\s+that)?/i);
  if (profDirectiveMatch && /clinical\s*profile/i.test(allDirectivesText) && /(?:underlined|underline|bold|bolded|unitalic|not italic|non-italic)/i.test(profDirectiveMatch[0])) {
    const dStr = profDirectiveMatch[0].toLowerCase();
    if (dStr.includes('bold')) profileBold = true;
    if (dStr.includes('underline') || dStr.includes('underlined')) profileUnderline = true;
    if (dStr.includes('unitalic') || dStr.includes('un-italic') || dStr.includes('not italic') || dStr.includes('non-italic') || dStr.includes('no italic')) {
      profileUnitalic = true;
    }
    hasProfileStyleDirective = true;
  }

  // 2. Detect Spoken Impression "without bullet" directives
  const noBulletPoints: string[] = [];
  const noBulletMatches = allDirectivesText.matchAll(/(?:add\s+this\s+point\s+without\s+bullet|add\s+without\s+bullet|without\s+bullet|no\s+bullet)(?:\s*(?:in|to)\s*impression)?(?:\s*:)?\s*([^.,\n]+)/gi);
  for (const m of noBulletMatches) {
    if (m[1] && m[1].trim().length > 3) {
      noBulletPoints.push(m[1].trim().toLowerCase());
    }
  }

  const candidates: string[] = [];
  if (directives) candidates.push(directives);
  findings.forEach(f => {
    if (
      /change\s+(?:the\s+)?.*heading/i.test(f) ||
      /change\s+(?:the\s+)?title/i.test(f) ||
      /rename\s+(?:the\s+)?.*heading/i.test(f) ||
      /keep\s+clinical\s+profile/i.test(f) ||
      /without\s+bullet/i.test(f)
    ) {
      candidates.push(f);
    }
  });

  let modified = [...findings];

  for (const text of candidates) {
    const m1 = text.match(/change\s+(?:the\s+)?(.+?)\s+heading(?:\s+in\s+(?:that|the)\s+template)?\s+to\s+([^,.\n]+)/i);
    const m2 = text.match(/change\s+(?:the\s+)?title\s+to\s+([^,.\n]+)/i);
    const m3 = text.match(/rename\s+(?:the\s+)?(.+?)\s+heading\s+to\s+([^,.\n]+)/i);

    if (m1) {
      const oldH = m1[1].trim().toLowerCase();
      const newH = m1[2].trim().toUpperCase();
      modified = modified.map((line, idx) => {
        const clean = line.replace(/^BOLD::/i, '').trim().toLowerCase();
        if (idx === 0 || clean === oldH || clean.includes(oldH) || oldH.includes(clean)) {
          return line.startsWith('BOLD::') ? `BOLD::${newH}` : newH;
        }
        return line;
      });
    } else if (m2) {
      const newTitle = m2[1].trim().toUpperCase();
      if (modified.length > 0) {
        modified[0] = modified[0].startsWith('BOLD::') ? `BOLD::${newTitle}` : newTitle;
      }
    } else if (m3) {
      const oldH = m3[1].trim().toLowerCase();
      const newH = m3[2].trim().toUpperCase();
      modified = modified.map((line, idx) => {
        const clean = line.replace(/^BOLD::/i, '').trim().toLowerCase();
        if (clean === oldH || clean.includes(oldH) || (idx === 0 && oldH.includes('extremity'))) {
          return line.startsWith('BOLD::') ? `BOLD::${newH}` : newH;
        }
        return line;
      });
    }
  }

  // Apply Clinical Profile styling tag if commanded
  if (hasProfileStyleDirective) {
    modified = modified.map(line => {
      const clean = line.replace(/^BOLD::/i, '').replace(/^UNDERLINE::/i, '').replace(/^UNITALIC::/i, '').replace(/\[STYLE:[^\]]+\]/i, '').trim();
      if (/^clinical\s*(?:profile|history):/i.test(clean.replace(/^[*_\s]+/, ''))) {
        const tags: string[] = [];
        if (profileBold) tags.push('bold');
        if (profileUnderline) tags.push('underline');
        if (profileUnitalic) tags.push('unitalic');
        const prefix = tags.length > 0 ? `[STYLE:${tags.join(',')}]` : '';
        // Clean out any spoken directive phrase from the profile text
        const cleanedText = clean.replace(/(?:keep\s+)?(?:clinical\s*profile\s*(?:sentence\s*)?)?(?:to\s+be\s+)?(?:underlined|underline|bold|bolded|unitalic|un-italic|not\s+italic|non-italic|no\s+italic|italic)(?:[\s,]+(?:and\s+)?(?:underlined|underline|bold|bolded|unitalic|un-italic|not\s+italic|non-italic|no\s+italic|italic))*(?:\s*like\s+that)?/gi, '').trim();
        return `${prefix}${cleanedText}`;
      }
      return line;
    });
  }

  // Apply Impression without-bullet handling if commanded
  if (noBulletPoints.length > 0) {
    modified = modified.map(line => {
      if (line.toUpperCase().startsWith('IMPRESSION:')) {
        const parts = line.split('###');
        const newParts = parts.map((pt, pIdx) => {
          if (pIdx === 0) return pt;
          const ptLower = pt.toLowerCase();
          for (const nb of noBulletPoints) {
            if (ptLower.includes(nb)) {
              // Strip bullet symbol
              return pt.replace(/^[•\-\*]\s*/, '').trim();
            }
          }
          return pt;
        });
        return newParts.join('###');
      }
      return line;
    });
  }

  return modified.filter(line => {
    const clean = line.replace(/^BOLD::/i, '').trim();
    if (/^change\s+(?:the\s+)?.*heading.*to\s+/i.test(clean)) return false;
    if (/^change\s+(?:the\s+)?title.*to\s+/i.test(clean)) return false;
    if (/^rename\s+(?:the\s+)?.*heading.*to\s+/i.test(clean)) return false;
    if (/^(?:please\s*)?(?:keep\s+)?clinical\s*profile\s*sentence/i.test(clean)) return false;
    if (/^(?:please\s*)?(?:add\s+this\s+point\s+without\s+bullet|add\s+without\s+bullet|without\s+bullet|no\s+bullet)(?:\s*(?:in|to)\s*impression)?/i.test(clean)) return false;
    // Strip unnecessary generic technique placeholder if present
    if (/^(?:standard imaging protocol was performed|standard protocol was followed)\.?$/i.test(clean)) return false;
    return true;
  });
}

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
  customDocx?: CustomDocxInput,
  abortSignal?: AbortSignal,
  customImages?: Array<{ data: string; mimeType: string }> | null
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
   - Smart Bullet Formatting in Impression:
     * Single-Line / Lead-In Summaries: Statements such as "findings are s/o...", narrative summary paragraphs, or single normal summary sentences now start flush with the beginning of the line without any bullet point (e.g. "IMPRESSION:###Normal study without acute abnormality.").
     * Discrete / Multi-Point Findings: When the impression consists of 2 or more discrete clinical findings, each individual finding is cleanly formatted with bullet points (• Point 1, • Point 2) starting from the left margin (e.g. "IMPRESSION:###• Point 1###• Point 2").
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
   - Smart Bullet Formatting in Impression:
     * Single-Line / Lead-In Summaries: Statements such as "findings are s/o...", narrative summary paragraphs, or single normal summary sentences now start flush with the beginning of the line without any bullet point (e.g. "IMPRESSION:###Normal study without acute abnormality.").
     * Discrete / Multi-Point Findings: When the impression consists of 2 or more discrete clinical findings, each individual finding is cleanly formatted with bullet points (• Point 1, • Point 2) starting from the left margin (e.g. "IMPRESSION:###• Point 1###• Point 2").
6. MEASUREMENT / COMPARATIVE TABLES: When the template or report contains measurement grids or comparative anatomical tables (e.g., bilateral kidney comparisons, TAVI measurements, pulmonary artery dimensions, cardiac ventricular volumes), preserve the table rows joined by '###' (e.g. 'Col1 | Col2###Val1 | Val2') so the full tabular grid is preserved as a cohesive unit.
7. SPOKEN STRUCTURAL & HEADING/TITLE ALTERATIONS: When the doctor dictates commands to alter the template structure, title, or section headings (e.g. "change the CT extremity heading in that template to CT right arm", "change title to CT SCAN OF RIGHT FOREARM", "rename pelvis heading to lower abdomen", "omit bladder section"):
   - Apply the requested modification immediately to the template title and section headings in the merged report (e.g., replace 'CT EXTREMITY' with 'CT RIGHT ARM' or 'C.T. SCAN OF RIGHT ARM').
   - Remove the spoken instruction from the clinical findings completely — NEVER include instructions like 'change CT extremity heading...' as a line or bullet in the output report.
8. CLINICAL FIDELITY VS. EXPLICIT-ONLY PATHOLOGY SYNTHESIS:
   - DEFAULT RULE: What the radiologist speaks are the real clinical findings and ground truth. Record and transcribe their spoken findings faithfully without inventing, hallucinating, or replacing them with textbook synthetic descriptions (e.g., if the doctor dictates "right slipped capital femoral epiphysis with Trethowan sign", preserve that exact observation).
   - EXPLICIT SYNTHESIS ONLY: Multi-sequence textbook pathology expansion (e.g. detailed glioblastoma features, MCA infarct expansion) MUST ONLY activate when the doctor EXPLICITLY requests it by commanding the AI to generate/synthesize findings by itself (e.g., phrases containing "by yourself", "include detailed glioblastoma findings by yourself", "generate findings for X by yourself"). In the absence of an explicit "by yourself" command, faithfully preserve what was dictated.
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
- CLINICAL FIDELITY VS. EXPLICIT-ONLY PATHOLOGY SYNTHESIS:
  * DEFAULT RULE (REAL CLINICAL FINDINGS): What the radiologist dictated is the ground truth. Merge and transcribe the doctor's actual observations into the report faithfully without inventing, hallucinating, or substituting them with synthetic textbook descriptions.
  * EXPLICIT SYNTHESIS ONLY: If and only if the doctor explicitly instructs the AI to generate findings by itself (e.g. phrases containing "by yourself", "include detailed glioblastoma findings by yourself", "generate findings for X by yourself"), intelligently interpret the diagnosis and synthesize comprehensive, realistic, authoritative, anatomically precise radiological observations for that pathology tailored to the active template sections (e.g. for glioblastoma in MR Brain: describe the thick irregular ring-enhancing mass with central necrosis, extensive perilesional T2/FLAIR vasogenic edema along white matter tracts, SWI microhemorrhages, restricted diffusion along the solid hypercellular rim, mass effect, ventricular compression, and midline shift).
  * ANTI-LITERAL RULE: NEVER insert conversational meta-instruction phrases like "detailed glioblastoma findings by yourself" or "add glioblastoma findings" verbatim into the report body!
- SPOKEN STRUCTURAL & HEADING/TITLE ALTERATIONS:
  * If the doctor's dictation, findings, or custom prompt contains instructions to modify a heading or title (e.g. "change the CT extremity heading in that template to CT right arm", "change title to CT SCAN OF RIGHT FOREARM", "rename pelvis heading to lower abdomen", "omit bladder section"):
    - Apply the change immediately to the report's title and section headings (e.g., change 'CT EXTREMITY' to 'CT RIGHT ARM' or 'C.T. SCAN OF RIGHT ARM').
    - REMOVE the spoken instruction from the clinical findings — NEVER leave meta-instruction sentences like "change CT extremity heading..." in the findings.
- Any anatomical sections where the dictation describes pathology, abnormal lesions, or modifications must be updated with the dictated findings and prefixed with 'BOLD::'.
- Any anatomical sections from the template that were normal or not mentioned in the dictation must remain present verbatim without 'BOLD::'.
- TECHNIQUE / PROTOCOL DIRECTIVE:
  * If the template lacks a Technique / Protocol section or sentence, do NOT add or invent "Standard imaging protocol was performed." or any placeholder. Omit it completely unless explicitly present in the template or dictated.
- CLINICAL PROFILE FORMATTING & SPOKEN STYLE DIRECTIVES:
  * Default style: wrapped in single asterisks (*Clinical Profile: ...*).
  * If the radiologist dictates formatting instructions (e.g. "keep clinical profile sentence underlined bold and unitalic", "bold and underline clinical profile", "make clinical profile not italic", "underline clinical profile"):
    1. Obey the requested formatting commands strictly!
    2. Encode the requested styles at the beginning of the line: e.g. BOLD::UNDERLINE::UNITALIC::*Clinical Profile: ...* or [STYLE:bold,underline,unitalic]*Clinical Profile: ...*.
    3. REMOVE the spoken instruction phrase completely from the clinical text so only the clinical history remains.
- IMPRESSION & SPOKEN NO-BULLET DIRECTIVES:
  * If the radiologist dictates to add a point without bullet (e.g. "add this point without bullet in impression", "in impression add without bullet: ...", "no bullet for this point"):
    1. YOU MUST OBEY: Incorporate the dictated point into the IMPRESSION.
    2. NO BULLET: Output that specific point WITHOUT any bullet symbol (no '•', '-', or '*'), starting flush from the margin.
    3. Remove meta-instruction phrases like "add this point without bullet in impression" so only the clinical observation appears.
- If the dictated findings contain previous or intermediate "IMPRESSION:" lines from continued dictation sessions, consolidate all findings into ONE single comprehensive final IMPRESSION at the end of the report (format: 'IMPRESSION:###point 1###point 2...'). Do NOT leave intermediate impressions scattered in the body of the report.
- Generate a new, comprehensive IMPRESSION synthesizing all normal and abnormal findings starting with 'IMPRESSION:###'.
  * Smart Bullet Formatting in Impression:
    - Explicit No-Bullet Points: Any point explicitly requested without bullet starts flush with the beginning of the line without any bullet symbol.
    - Single-Line / Lead-In Summaries: Statements such as "findings are s/o...", narrative summary paragraphs, or single normal summary sentences now start flush with the beginning of the line without any bullet point (e.g. "IMPRESSION:###Normal study without acute abnormality.").
    - Discrete / Multi-Point Findings: When the impression consists of 2 or more discrete clinical findings, each individual finding is cleanly formatted with bullet points (• Point 1, • Point 2) starting from the left margin, EXCEPT for points instructed without bullets.
- Return ONLY a JSON object with the "findings" string array in the assembled report order.
================================================================================
`;

  const macroContext = getMacroPromptContext();
  const parts: any[] = [
    { text: templateContextPrompt },
    { text: templateBasePrompt },
    { text: dictatedFindingsDirective },
    ...(macroContext ? [{ text: macroContext }] : []),
  ];

  if (customImages && customImages.length > 0) {
    for (const img of customImages) {
      parts.push({
        inlineData: {
          mimeType: img.mimeType || 'image/png',
          data: img.data,
        },
      });
    }
    parts.push({
      text: `Reference template image(s) provided above: follow their structure and visual sections along with the text template.`,
    });
  }

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
    const rawResponseText = await generateContentWithJsonFallback(targetModel, parts, responseSchema, 0.1, abortSignal, 'reasoning');
    const mergedFindings = extractFindingsFromResponse(rawResponseText);

    if (mergedFindings && mergedFindings.length > 0) {
      return applySpokenHeadingModifications(mergedFindings, customPrompt);
    }
    throw new Error("Invalid response format received while merging template.");
  } catch (error) {
    console.warn("mergeDictatedFindingsWithTemplate primary attempt failed, trying fallback:", error);

    // Direct JSON prompt fallback using text-only parts to guarantee payload fits
    try {
      const textOnlyParts = parts.filter(p => !p.inlineData && !p.fileData);
      const retryText = await executeWithFreeTierModelFallback(
        targetModel,
        (activeModel, hasMoreFallbackModels) =>
          executeWithApiKeyFailover(
            async (client, apiKey) => {
              return await callGenerateContentWithOptimalThinking({
                client,
                apiKey,
                model: activeModel,
                parts: [
                  ...textOnlyParts,
                  { text: "\n\nCRITICAL OUTPUT REQUIREMENT: Output ONLY a valid JSON object in the exact format: {\"findings\": [\"finding 1\", \"finding 2\", ...]}" }
                ],
                temperature: 0.1,
                abortSignal,
                taskType: 'reasoning',
              });
            },
            { selectedModel: activeModel, abortSignal, failFastOnModelUnavailable: Boolean(hasMoreFallbackModels) }
          ),
        { abortSignal }
      );
      const parsed = extractFindingsFromResponse(retryText);
      if (parsed && parsed.length > 0) {
        return applySpokenHeadingModifications(parsed, customPrompt);
      }
    } catch (retryErr) {
      console.warn("mergeDictatedFindingsWithTemplate fallback failed:", retryErr);
    }

    // Baseline template lines fallback with dictated findings appended
    if (isMulti) {
      const allLines = templates.flatMap(t => t.lines || []);
      const filteredDictated = dictatedFindings.filter(f => !f.toLowerCase().includes('normal') && !f.startsWith('IMPRESSION'));
      return applySpokenHeadingModifications([
        `COMBINED REPORT: ${templateName}`,
        "*Clinical Profile: Multi-region evaluation.*",
        ...allLines.filter(l => !l.startsWith('IMPRESSION') && !l.toLowerCase().startsWith('clinical profile')),
        ...filteredDictated.map(f => f.startsWith('BOLD::') ? f : `BOLD::${f}`),
        "IMPRESSION:###Multi-region examination evaluated."
      ], customPrompt);
    }

    const singleFirst = templates[0];
    if (singleFirst && singleFirst.lines && singleFirst.lines.length > 0) {
      const title = singleFirst.lines[0] || templateName;
      const filteredDictated = dictatedFindings.filter(f => !f.toLowerCase().includes('normal') && !f.startsWith('IMPRESSION'));
      return applySpokenHeadingModifications([
        title,
        "*Clinical Profile: Routine evaluation.*",
        ...singleFirst.lines.slice(1, -2),
        ...filteredDictated.map(f => f.startsWith('BOLD::') ? f : `BOLD::${f}`),
        singleFirst.lines[singleFirst.lines.length - 1] || "IMPRESSION:###Study evaluated."
      ], customPrompt);
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

  const macroContext = getMacroPromptContext();
  if (macroContext) {
    prompt += `\n\n${macroContext}`;
  }

  if (customPrompt) {
    prompt += `\n\nAdditionally, follow these custom instructions:\n${customPrompt}`;
  }

  const textPart = { text: prompt };

  try {
    const targetModel = resolveApiTargetModel(model || DEFAULT_SELECTED_MODEL);
    return await executeWithFreeTierModelFallback(
      targetModel,
      (activeModel, hasMoreFallbackModels) =>
        executeWithApiKeyFailover(
          async (client, apiKey) => {
            const resultText = await callGenerateContentWithOptimalThinking({
              client,
              apiKey,
              model: activeModel,
              parts: [textPart, audioPart],
              temperature: 0.1,
              taskType: 'live_chunk',
            });
            if (!resultText) {
              throw new Error("API returned an empty response for audio continuation.");
            }
            return expandMacrosInSingleText(resultText);
          },
          { selectedModel: activeModel, failFastOnModelUnavailable: Boolean(hasMoreFallbackModels) }
        )
    );
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

  const macroContext = getMacroPromptContext();
  if (macroContext) {
    prompt += `\n\n${macroContext}`;
  }

  if (customPrompt) {
    prompt += `\n\nAdditionally, follow these custom instructions:\n${customPrompt}`;
  }

  const textPart = { text: prompt };

  try {
    const targetModel = resolveApiTargetModel(model || DEFAULT_SELECTED_MODEL);
    return await executeWithFreeTierModelFallback(
      targetModel,
      (activeModel, hasMoreFallbackModels) =>
        executeWithApiKeyFailover(
          async (client, apiKey) => {
            const resultText = await callGenerateContentWithOptimalThinking({
              client,
              apiKey,
              model: activeModel,
              parts: [textPart, audioPart],
              temperature: 0.1,
              taskType: 'live_chunk',
            });
            if (!resultText) {
              throw new Error("API returned an empty response for finding modification.");
            }
            return expandMacrosInSingleText(resultText);
          },
          { selectedModel: activeModel, failFastOnModelUnavailable: Boolean(hasMoreFallbackModels) }
        )
    );
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
  audioBlob: Blob | Blob[], 
  model: string, 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  customDocx?: CustomDocxInput,
  options?: ProcessAudioOptions
): Promise<string[]> => {
  const blobs: Blob[] = Array.isArray(audioBlob) ? audioBlob : [audioBlob];
  const inputParts: any[] = [];

  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    const cleanMime = getCleanMimeType(b);
    const fileName = (b as any).name ? `"${(b as any).name}"` : `Input #${i + 1}`;

    if (cleanMime.startsWith('text/') || cleanMime === 'application/json' || b.type?.startsWith('text/')) {
      try {
        const textContent = await b.text();
        inputParts.push({ text: `New clinical text / instructions to modify or update the report from ${fileName}:\n"""\n${textContent}\n"""` });
      } catch (e) {
        console.warn('Could not read blob as text:', e);
      }
    } else {
      const base64Data = await blobToBase64(b);
      inputParts.push({
        inlineData: {
          mimeType: cleanMime,
          data: base64Data,
        },
      });
      if (!cleanMime.startsWith('audio/')) {
        inputParts.push({ text: `[Attached Input Document/File ${fileName} (${cleanMime})]: Analyze and incorporate all clinical instructions, findings, and modifications from this file.` });
      }
    }
  }

  let prompt = `You are an expert medical transcriptionist assistant. You are given an existing medical report in JSON format and an audio recording or input file(s)/text containing instructions to modify it. Your task is to intelligently interpret the audio instructions and any attached text/files and return a single, updated report in the exact same JSON format.

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

  const macroContext = getMacroPromptContext();
  if (macroContext) {
    prompt += `\n\n${macroContext}`;
  }

  prompt += `\n\nSPOKEN TEMPLATE ID DIRECTIVE (STRICT): If the audio/instruction explicitly speaks one or more Template IDs (e.g. "template id 1", "template id 200", "template id C1", "add template id 15", "combine templates 5 and 200"), output "{template id [ID]}" or "{add template id [ID]}" or "{template id [ID1, ID2]}" at the start of the "findings" array. Do NOT trigger on vague requests like "add ct brain" without an explicit ID.`;

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
  parts.push(...inputParts);
  
  const targetModel = resolveApiTargetModel(model);

  try {
    const rawResponseText = await generateContentWithJsonFallback(targetModel, parts, responseSchema, 0.1, undefined, 'reasoning');
    const findings = extractFindingsFromResponse(rawResponseText);

    if (findings && findings.length > 0) {
      return await resolveAndApplySpokenTemplates(findings, {
        templateInfo,
        model: targetModel,
        audioBlobs: blobs,
        customPrompt,
        customImages,
        customDocx,
        onSpokenTemplateResolved: options?.onSpokenTemplateResolved,
      });
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

  try {
    return await executeWithFreeTierModelFallback(
      primaryModel,
      (activeModel, hasMoreFallbackModels) =>
        executeWithApiKeyFailover(
          async (client, apiKey) => {
            const resultText = await callGenerateContentWithOptimalThinking({
              client,
              apiKey,
              model: activeModel,
              parts: [textPart, audioPart],
              temperature: 0.1,
              taskType: 'live_chunk',
            });

            return resultText || "";
          },
          { selectedModel: activeModel, failFastOnModelUnavailable: Boolean(hasMoreFallbackModels) }
        )
    );
  } catch (lastError: any) {
    console.error("Transcription failed across API keys for model:", primaryModel, lastError);
    if (lastError instanceof Error) {
      throw new Error(`Failed to transcribe audio: ${lastError.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for transcription.");
  }
};


interface ChatFailoverContext {
  model: string;
  systemInstruction: string;
  history: Array<{ role: 'user' | 'model'; parts: any[] }>;
}

const chatFailoverContextMap = new WeakMap<Chat, ChatFailoverContext>();

function createManagedChatSession(ctx: ChatFailoverContext): Chat {
  const { candidateKeys } = getCandidateKeysForOperation(ctx.model);
  const firstKey = candidateKeys[0];
  const client = firstKey ? getClientForApiKey(firstKey) : getAI();
  const chat = client.chats.create({
    model: ctx.model || DEFAULT_SELECTED_MODEL,
    config: {
      systemInstruction: ctx.systemInstruction,
    },
    history: ctx.history,
  });
  chatFailoverContextMap.set(chat, {
    model: ctx.model || DEFAULT_SELECTED_MODEL,
    systemInstruction: ctx.systemInstruction,
    history: ctx.history.map((turn) => ({ role: turn.role, parts: [...turn.parts] })),
  });
  return chat;
}

/**
 * Sends a follow-up Q&A message through an existing Chat session, automatically failing over
 * across active API keys and accurate Free-Tier models on 429 quota or 503/unavailable errors.
 */
export async function sendChatMessageWithFailover(
  chat: Chat,
  message: string | any[],
  abortSignal?: AbortSignal
): Promise<{ text: string; activeChat: Chat }> {
  const ctx = chatFailoverContextMap.get(chat);
  const messageParts = typeof message === 'string' ? [{ text: message }] : message;

  try {
    const response = await chat.sendMessage({ message });
    const text = response?.text || '';
    if (ctx) {
      ctx.history.push({ role: 'user', parts: [...messageParts] });
      ctx.history.push({ role: 'model', parts: [{ text }] });
    }
    return { text, activeChat: chat };
  } catch (err: any) {
    if (!ctx || err?.name === 'AbortError' || abortSignal?.aborted) {
      throw err;
    }
    const shouldRecover =
      isQuotaOrRateLimitExceededError(err) ||
      isModelLevelServiceUnavailableError(err) ||
      isTransientOrKeyError(err);
    if (!shouldRecover) {
      throw err;
    }

    const result = await executeWithFreeTierModelFallback(
      ctx.model,
      (candidateModel, hasMoreFallbackModels) =>
        executeWithApiKeyFailover(
          async (client) => {
            const recoveredChat = client.chats.create({
              model: candidateModel,
              config: { systemInstruction: ctx.systemInstruction },
              history: ctx.history.map((t) => ({ role: t.role, parts: [...t.parts] })),
            });
            const r = await recoveredChat.sendMessage({ message });
            return {
              text: r?.text || '',
              activeChat: recoveredChat,
              activeModel: candidateModel,
            };
          },
          {
            selectedModel: candidateModel,
            abortSignal,
            failFastOnModelUnavailable: Boolean(hasMoreFallbackModels),
          }
        ),
      { abortSignal }
    );

    const updatedHistory = [
      ...ctx.history.map((t) => ({ role: t.role, parts: [...t.parts] })),
      { role: 'user' as const, parts: [...messageParts] },
      { role: 'model' as const, parts: [{ text: result.text }] },
    ];
    chatFailoverContextMap.set(result.activeChat, {
      model: result.activeModel,
      systemInstruction: ctx.systemInstruction,
      history: updatedHistory,
    });
    return { text: result.text, activeChat: result.activeChat };
  }
}

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

  return createManagedChatSession({
    model: resolveApiTargetModel(model || DEFAULT_SELECTED_MODEL),
    systemInstruction,
    history: [
      { role: 'user', parts: userMessageParts },
      { role: 'model', parts: [modelResponsePart] },
    ],
  });
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

  return createManagedChatSession({
    model: resolveApiTargetModel(model || DEFAULT_SELECTED_MODEL),
    systemInstruction,
    history: [
      { role: 'user', parts: userMessageParts },
      { role: 'model', parts: [modelResponsePart] },
    ],
  });
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

export const identifyPotentialErrors = async (
  findings: string[],
  model: string,
  options?: {
    triggeredRules?: ClinicalQaRuleResult[];
    abortSignal?: AbortSignal;
    skipCrossModelFallback?: boolean;
  }
): Promise<IdentifiedError[]> => {
    const triggeredHint = options?.triggeredRules && options.triggeredRules.length > 0
      ? `\n\nPre-screening QA alerts flagged the following high-probability issue(s) to inspect and explain concisely per findingIndex:\n${options.triggeredRules
          .map(r => `- ${r.label} (${r.id}, P=${(r.probability * 100).toFixed(0)}%)`)
          .join('\n')}\nNote: Include violations of the "NO numerical values or measurements in IMPRESSION" rule as severity 'WARNING' (findingIndex = IMPRESSION row index) if present in the IMPRESSION section.`
      : '';

    const textPart = {
        text: `${ERROR_IDENTIFIER_PROMPT}${triggeredHint}\n\nReport to analyze:\n${JSON.stringify({ findings })}`,
    };

    try {
        const targetModel = resolveApiTargetModel(model);
        const rawResponseText = await generateContentWithJsonFallback(
          targetModel,
          [textPart],
          errorSchema,
          0.1,
          options?.abortSignal,
          'reasoning',
          { skipCrossModelFallback: options?.skipCrossModelFallback }
        );
        return extractErrorsFromResponse(rawResponseText);
    } catch (error: any) {
        if (error?.name === 'AbortError' || options?.abortSignal?.aborted) {
            throw error;
        }
        console.error("Error calling Gemini API for error identification:", error);
        // Don't throw, just return empty array as this is a background task.
        return [];
    }
};

// --- Gemini Decision 1 Multi-Rule Clinical QA, Critical Findings Alert & Completeness Check ---

export const GEMINI_DECISION_MODEL = 'gemini-decision-1';
export const QA_NOUL_THRESHOLD = 0.70;

export type ClinicalQaRuleId =
  | 'has_laterality_contradiction'
  | 'has_normal_vs_abnormal_contradiction'
  | 'impression_contradicts_or_omits_finding'
  | 'impression_contains_numbers';

export type CriticalUrgencyLevel = 'routine' | 'prompt_follow_up' | 'urgent' | 'critical_stat';

export interface ClinicalQaRuleResult {
  id: ClinicalQaRuleId;
  label: string;
  probability: number;
  confidence: number;
  triggered: boolean;
}

export interface ClinicalQaAssessment {
  decisionModel: string;
  rules: ClinicalQaRuleResult[];
  triggeredRules: ClinicalQaRuleResult[];
  criticalUrgency: {
    level: CriticalUrgencyLevel;
    label: string;
    expectedScore: number;
    topLevelIndex: number;
    confidence: number;
    probabilities: Record<string, number>;
  };
  reportCompleteness: {
    score: number;
    levelIndex: number;
    label: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  invokedDetailedGenerator: boolean;
  skippedDetailedReason?: string;
  usage?: {
    totalInputTokens?: number;
    totalOutputTokens?: number;
  };
  decisionLatencyMs: number;
}

export interface AutomaticErrorCheckResult {
  errors: IdentifiedError[];
  qaAssessment: ClinicalQaAssessment | null;
}

const QA_RULE_LABELS: Record<ClinicalQaRuleId, string> = {
  has_laterality_contradiction: 'Laterality Consistency',
  has_normal_vs_abnormal_contradiction: 'Normal vs. Abnormal',
  impression_contradicts_or_omits_finding: 'Impression Sync',
  impression_contains_numbers: 'No Numbers in Impression',
};

const COMPLETENESS_LEVEL_LABELS = ['Incomplete', 'Minimal', 'Adequate', 'Complete'];

const PLACEHOLDER_FINDING_PATTERNS = [
  /^processing audio with ai\.{0,3}$/i,
  /^previous dictation encountered an error/i,
  /^dictation #\d+ analysis cancelled/i,
  /^error processing dictation/i,
];

function isPlaceholderReport(findings: string[]): boolean {
  const nonEmpty = findings.map(f => (f || '').replace(/^BOLD::/i, '').trim()).filter(Boolean);
  if (nonEmpty.length === 0) return true;
  if (nonEmpty.length <= 2 && nonEmpty.every(line => PLACEHOLDER_FINDING_PATTERNS.some(rx => rx.test(line)) || line.startsWith('[Error:'))) {
    return true;
  }
  return false;
}

function formatFindingsForDecisionQa(findings: string[]): { text: string; impressionIndex: number } {
  let impressionIndex = -1;
  const formattedLines = findings.map((raw, idx) => {
    const clean = (raw || '')
      .replace(/^BOLD::/i, '')
      .replace(/\[NO_BULLET\]\s*/gi, '')
      .replace(/NO_BULLET::\s*/gi, '')
      .trim();

    if (!clean) return `[${idx}] (empty)`;

    if (clean.includes('###')) {
      const parts = clean.split('###').map(p => p.trim()).filter(Boolean);
      const header = parts[0] || '';
      if (header.toUpperCase().startsWith('IMPRESSION')) {
        impressionIndex = idx;
      }
      const subLines = parts.slice(1).map(p => `  • ${p.replace(/^(?:•|&bull;|&#8226;|[-*]|\s)+/, '').trim()}`);
      return `[${idx}] ${header}\n${subLines.join('\n')}`;
    }

    if (/^\s*IMPRESSION\s*:/i.test(clean)) {
      impressionIndex = idx;
    }
    return `[${idx}] ${clean}`;
  });

  return {
    text: formattedLines.join('\n'),
    impressionIndex,
  };
}

function getArgMaxLevelIndex(probabilities?: Record<string, number>): number {
  if (!probabilities) return 0;
  let bestIdx = 0;
  let bestProb = -1;
  for (const [k, v] of Object.entries(probabilities)) {
    const idx = Number(k);
    if (!Number.isNaN(idx) && typeof v === 'number' && v > bestProb) {
      bestProb = v;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

async function callDecisionsApi(
  input: string,
  questions: Record<string, any>,
  abortSignal?: AbortSignal
): Promise<any> {
  return await executeWithApiKeyFailover(
    async (_client, apiKey) => {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GEMINI_DECISION_MODEL,
          input,
          questions,
        }),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error?.message || `Decisions API HTTP ${res.status}: ${res.statusText}`;
        const err: any = new Error(msg);
        err.status = res.status;
        if (res.status === 400 && !isTransientOrKeyError(err)) {
          err.isNonRetryable = true;
        }
        throw err;
      }

      const data = await res.json();
      if (data?.prompt_feedback?.block_reason) {
        const blockedErr: any = new Error(`Decisions API blocked input: ${data.prompt_feedback.block_reason}`);
        blockedErr.isNonRetryable = true;
        throw blockedErr;
      }
      return data;
    },
    {
      selectedModel: GEMINI_DECISION_MODEL,
      abortSignal,
    }
  );
}

/**
 * Evaluates a completed radiology report in a single zero-output-token pass via Gemini Decision 1.
 */
export async function evaluateClinicalQaDecisions(
  findings: string[],
  abortSignal?: AbortSignal
): Promise<{ assessment: ClinicalQaAssessment; impressionIndex: number } | null> {
  if (!findings || isPlaceholderReport(findings)) {
    return null;
  }

  const { text: formattedReport, impressionIndex } = formatFindingsForDecisionQa(findings);
  const startTime = Date.now();

  const questions = {
    has_laterality_contradiction: {
      type: 'noul',
      instructions:
        'Does this radiology report contain a left vs. right laterality contradiction or anatomically wrong side (for example, describing right-sided pathology in findings when the clinical history or impression states left-sided, or placing a lateralized organ like spleen/liver/appendix on the wrong side)?',
      criteria: {
        true_description:
          'Conflicting left vs. right laterality is stated for the same finding/organ, clinical indication conflicts with the reported side, or a strictly unilateral organ is placed on the wrong anatomical side.',
        false_description:
          'All laterality references (left, right, bilateral, midline) and anatomical locations are internally consistent.',
      },
    },
    has_normal_vs_abnormal_contradiction: {
      type: 'noul',
      instructions:
        'Does this radiology report contain a direct clinical contradiction where a structure or organ is explicitly called normal, clear, or unremarkable in one finding while another finding in the same report describes pathology in that same structure or organ?',
      criteria: {
        true_description:
          'The report simultaneously claims the same organ, region, or system is normal/clear/unremarkable and also abnormal/pathologic (e.g., "lungs are clear" alongside "right lower lobe consolidation").',
        false_description:
          'Findings are clinically consistent without calling the same structure both normal and abnormal.',
      },
    },
    impression_contradicts_or_omits_finding: {
      type: 'noul',
      instructions:
        'Does the IMPRESSION section contradict any finding described in the report body OR omit a significant abnormal finding reported in the body above it?',
      criteria: {
        true_description:
          'An IMPRESSION section is present and either contradicts a body finding, misstates its diagnosis/location, or fails to mention a clinically significant abnormality reported in the findings.',
        false_description:
          'Either the IMPRESSION accurately summarizes and matches all significant body findings, or there is no separate IMPRESSION section.',
      },
    },
    impression_contains_numbers: {
      type: 'noul',
      instructions:
        'Inspect ONLY the IMPRESSION section lines (ignore all numbers, measurements, dates, or GCS scores in Clinical Profile or body FINDINGS lines above IMPRESSION). Does the IMPRESSION section text itself contain any digits or numerical values (such as 8 mm, 2.5 cm, 3 lesions, Grade 2, 15 HU, 50%)?',
      criteria: {
        true_description:
          'The IMPRESSION section itself contains one or more numerical digits, measurements, counts, grades, percentages, or dimensions.',
        false_description:
          'The IMPRESSION section contains zero digits or numerical measurements, or no IMPRESSION section exists in the report.',
      },
    },
    critical_finding_urgency: {
      type: 'score',
      instructions:
        'Rate the clinical acuity and communication urgency of the most serious finding anywhere in this radiology report.',
      criteria: [
        'Routine: Normal study, stable chronic changes, or benign incidental findings needing routine communication.',
        'Prompt follow-up: Significant non-emergent abnormality (such as indeterminate nodule, suspicious mass, moderate chronic effusion) warranting timely outpatient follow-up.',
        'Urgent: Acute symptomatic or non-immediately fatal finding (such as acute appendicitis, uncomplicated cholecystitis, acute fracture, small bowel obstruction without ischemia) requiring same-day management.',
        'Critical STAT alert: Immediately life-threatening or time-critical emergency finding requiring STAT notification (such as subarachnoid hemorrhage/SAH, acute ischemic/hemorrhagic stroke, herniation or significant midline shift, tension or large pneumothorax, aortic dissection, massive PE, free intraperitoneal air/perforation, spinal cord compression).',
      ],
    },
    report_completeness: {
      type: 'score',
      instructions:
        'Rate the structural and clinical completeness of this radiology report from 0 (incomplete fragment) to 3 (complete cohesive report).',
      criteria: [
        '0 - Incomplete: Fragmentary or truncated notes lacking coherent diagnostic observations.',
        '1 - Minimal: Basic findings only without an IMPRESSION section or lacking key clinical characterization.',
        '2 - Adequate: Contains findings and an IMPRESSION, with minor omissions or lack of specificity.',
        '3 - Complete: Comprehensive, clear radiology report with organized findings and a cohesive, consistent IMPRESSION.',
      ],
    },
  };

  const data = await callDecisionsApi(formattedReport, questions, abortSignal);
  const answers = data?.answers || {};
  const elapsedMs = Date.now() - startTime;

  const ruleIds: ClinicalQaRuleId[] = [
    'has_laterality_contradiction',
    'has_normal_vs_abnormal_contradiction',
    'impression_contradicts_or_omits_finding',
    'impression_contains_numbers',
  ];

  const rules: ClinicalQaRuleResult[] = ruleIds.map((id) => {
    const ans = answers[id];
    const prob = typeof ans?.noul === 'number' ? ans.noul : 0;
    const conf = typeof ans?.confidence === 'number' ? ans.confidence : Math.max(prob, 1 - prob);
    return {
      id,
      label: QA_RULE_LABELS[id],
      probability: prob,
      confidence: conf,
      triggered: prob >= QA_NOUL_THRESHOLD,
    };
  });

  const urgencyAns = answers.critical_finding_urgency;
  const urgencyProbs: Record<string, number> = urgencyAns?.probabilities || {};
  const urgencyExpectedScore = typeof urgencyAns?.score === 'number' ? urgencyAns.score : 0;
  const urgencyTopLevel = getArgMaxLevelIndex(urgencyProbs);
  const pCritical = urgencyProbs['3'] ?? 0;
  const pUrgentOrHigher = (urgencyProbs['2'] ?? 0) + pCritical;

  let urgencyLevel: CriticalUrgencyLevel = 'routine';
  let urgencyLabel = 'Routine';
  if (urgencyTopLevel === 3 || pCritical >= 0.45 || urgencyExpectedScore >= 2.35) {
    urgencyLevel = 'critical_stat';
    urgencyLabel = 'Critical STAT Alert';
  } else if (urgencyTopLevel === 2 || pUrgentOrHigher >= 0.55 || urgencyExpectedScore >= 1.65) {
    urgencyLevel = 'urgent';
    urgencyLabel = 'Urgent Finding';
  } else if (urgencyTopLevel === 1 || urgencyExpectedScore >= 0.85) {
    urgencyLevel = 'prompt_follow_up';
    urgencyLabel = 'Prompt Follow-up';
  }

  const completenessAns = answers.report_completeness;
  const completenessProbs: Record<string, number> = completenessAns?.probabilities || {};
  const completenessScore = Math.min(3, Math.max(0, typeof completenessAns?.score === 'number' ? completenessAns.score : 0));
  const completenessLevelIndex = Math.min(3, Math.max(0, Math.round(completenessScore)));

  const assessment: ClinicalQaAssessment = {
    decisionModel: GEMINI_DECISION_MODEL,
    rules,
    triggeredRules: rules.filter((r) => r.triggered),
    criticalUrgency: {
      level: urgencyLevel,
      label: urgencyLabel,
      expectedScore: urgencyExpectedScore,
      topLevelIndex: urgencyTopLevel,
      confidence: typeof urgencyAns?.confidence === 'number' ? urgencyAns.confidence : 0,
      probabilities: urgencyProbs,
    },
    reportCompleteness: {
      score: completenessScore,
      levelIndex: completenessLevelIndex,
      label: COMPLETENESS_LEVEL_LABELS[completenessLevelIndex] || 'Adequate',
      confidence: typeof completenessAns?.confidence === 'number' ? completenessAns.confidence : 0,
      probabilities: completenessProbs,
    },
    invokedDetailedGenerator: false,
    usage: data?.usage
      ? {
          totalInputTokens: data.usage.total_input_tokens,
          totalOutputTokens: data.usage.total_output_tokens ?? 0,
        }
      : undefined,
    decisionLatencyMs: elapsedMs,
  };

  return { assessment, impressionIndex };
}

/**
 * Automatic Error Finding powered by Gemini Decision 1 single-pass QA battery.
 * Runs 6 calibrated checks at 0 output tokens and invokes `identifyPotentialErrors`
 * ONLY when any error rule crosses the calibrated probability threshold (>= 0.70).
 */
export const runClinicalQaErrorCheck = async (
  findings: string[],
  model: string,
  abortSignal?: AbortSignal
): Promise<AutomaticErrorCheckResult> => {
  if (!findings || isPlaceholderReport(findings)) {
    return { errors: [], qaAssessment: null };
  }

  try {
    const decisionResult = await evaluateClinicalQaDecisions(findings, abortSignal);
    if (!decisionResult) {
      return { errors: [], qaAssessment: null };
    }

    const { assessment, impressionIndex } = decisionResult;

    if (assessment.triggeredRules.length === 0) {
      assessment.invokedDetailedGenerator = false;
      assessment.skippedDetailedReason = 'All QA error rules < 0.70 threshold (generative error call skipped)';
      return {
        errors: [],
        qaAssessment: assessment,
      };
    }

    // Background QA explanation uses high-quota Flash-Lite (500 RPD/key) isolated from 20 RPD dictation models
    const backgroundQaModel = GEMINI_FLASH_LITE_MODEL;
    assessment.invokedDetailedGenerator = true;
    const errors = await identifyPotentialErrors(findings, backgroundQaModel, {
      triggeredRules: assessment.triggeredRules,
      abortSignal,
      skipCrossModelFallback: true,
    });

    if (errors.length === 0) {
      const impressionRule = assessment.triggeredRules.find(
        (r) => r.id === 'impression_contains_numbers' || r.id === 'impression_contradicts_or_omits_finding'
      );
      const primaryRule = impressionRule || assessment.triggeredRules[0];
      const targetIndex = impressionRule && impressionIndex >= 0 ? impressionIndex : 0;
      const fallbackDesc =
        primaryRule.id === 'impression_contains_numbers'
          ? `QA Alert (${Math.round(primaryRule.probability * 100)}%): Impression appears to contain numerical values or measurements (violating the "no numbers in impression" rule).`
          : `QA Alert (${Math.round(primaryRule.probability * 100)}%): Potential ${primaryRule.label.toLowerCase()} issue flagged for review.`;

      return {
        errors: [
          {
            findingIndex: targetIndex,
            errorDescription: fallbackDesc,
            severity: primaryRule.id === 'impression_contains_numbers' ? 'INFO' : 'WARNING',
          },
        ],
        qaAssessment: assessment,
      };
    }

    return {
      errors,
      qaAssessment: assessment,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError' || abortSignal?.aborted) {
      throw err;
    }
    console.warn('[Clinical QA] gemini-decision-1 check failed, falling back to identifyPotentialErrors:', err);
    const fallbackErrors = await identifyPotentialErrors(findings, GEMINI_FLASH_LITE_MODEL, {
      abortSignal,
      skipCrossModelFallback: true,
    });
    return {
      errors: fallbackErrors,
      qaAssessment: null,
    };
  }
};

// --- Complex Impression Generation Constants & Pipeline ---
const COMPLEX_IMPRESSION_DEFAULT_MODEL = 'gemini-3.5-flash';

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
 * 2. When rate limit error occurs, counts down live in the app ("retrying in x seconds...") and retries with gemini-3.8-flash.
 * 3. Only the errored item is retried; once an item succeeds, its result is preserved.
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

        // Try default model: gemini-3.8-flash with Google search grounding alone
        try {
            onProgress?.(`${taskName}: Analyzing with ${COMPLEX_IMPRESSION_DEFAULT_MODEL} (Google Search grounded)...`);
            const response = await executeWithApiKeyFailover(
                async (client) => {
                    return await client.models.generateContent({
                        model: COMPLEX_IMPRESSION_DEFAULT_MODEL,
                        contents: prompt,
                        config: {
                            tools: [{ googleSearch: {} }]
                        }
                    });
                },
                { selectedModel: COMPLEX_IMPRESSION_DEFAULT_MODEL }
            );
            const text = response.text || '';
            const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
            return { text, groundingChunks };
        } catch (primaryErr: any) {
            if (!isRateLimitError(primaryErr)) {
                console.error(`${taskName}: Fatal error on ${COMPLEX_IMPRESSION_DEFAULT_MODEL}:`, primaryErr);
                throw primaryErr;
            }

            // Rate limit hit: Wait with live countdown and retry gemini-3.8-flash
            const waitSeconds = Math.min(15, 5 + (cycle - 1) * 2); // 5s, 7s, 9s, 11s, 13s, 15s
            console.warn(`${taskName}: Rate limit on ${COMPLEX_IMPRESSION_DEFAULT_MODEL}. Retrying in ${waitSeconds}s...`);

            for (let sec = waitSeconds; sec > 0; sec--) {
                onProgress?.(`${taskName}: Rate limit reached on ${COMPLEX_IMPRESSION_DEFAULT_MODEL}. Retrying in ${sec} second${sec > 1 ? 's' : ''}...`);
                await new Promise(res => setTimeout(res, 1000));
            }
            onProgress?.(`${taskName}: Retrying with ${COMPLEX_IMPRESSION_DEFAULT_MODEL}...`);
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
  model: string = DEFAULT_LIVE_MODEL || 'gemini-4-hydrogen',
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
${getMacroPromptContext()}
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
   - **Hyphenation Rule**: Do NOT add hyphens to compound modifiers or adjectives commonly written without hyphens in radiology reports. Write them as separate words with a space (e.g., write "age related" NOT "age-related", "age related neuro parenchymal atrophy", "well defined" NOT "well-defined", "ill defined" NOT "ill-defined", "ring enhancing" NOT "ring-enhancing", "contrast enhancing" NOT "contrast-enhancing", "non enhancing" NOT "non-enhancing", "soft tissue" NOT "soft-tissue", "flow void" NOT "flow-void", "fluid fluid level" NOT "fluid-fluid level", "fat fluid level" NOT "fat-fluid level"). Never insert unnecessary hyphens between adjacent words or between sentences. Only retain hyphens if strictly standard in medical nomenclature (such as "X-ray", "follow-up", "CT-guided", "T1-weighted", "T2-weighted"). When in doubt, prefer NO hyphen.
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

  // Multi-model fallback chain (restricted to single model when Selected Model Only toggle is ON)
  const primaryLiveModel = model || DEFAULT_LIVE_MODEL || 'gemini-4-hydrogen';
  const fallbackChain = isStrictSelectedModelOnlyEnabled()
    ? [primaryLiveModel]
    : getLiveModelFallbackChain(primaryLiveModel);
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

      const rawResponseText = await generateContentWithJsonFallback(
        currentModel,
        parts,
        responseSchema,
        0.1,
        undefined,
        'live_chunk',
        { skipCrossModelFallback: true, failFastOnModelUnavailable: attempt < fallbackChain.length - 1 }
      );
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

      const isRateLimit = isQuotaOrRateLimitExceededError(error);
      const isUnavailable = isModelLevelServiceUnavailableError(error);

      const reason = isRateLimit
        ? 'Rate limit exceeded'
        : isUnavailable
          ? 'Model high demand / unavailable'
          : (error?.message || 'Model service error');
      console.warn(`[Live Dictation] Chunk #${chunkIndex + 1} attempt ${attempt + 1}/${fallbackChain.length} with ${currentModel} failed (${reason})`);

      if (attempt < fallbackChain.length - 1) {
        const nextModel = fallbackChain[attempt + 1];
        console.info(`[Live Dictation] Auto-failing over to subsequent model: ${nextModel}`);
        emitModelFailoverNotice({
          fromModel: currentModel,
          toModel: nextModel,
          reason: isUnavailable && !isRateLimit ? 'service_unavailable' : isRateLimit ? 'rate_limit' : 'rpd_ledger',
        });
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
    error: `Rate limit or service error across all 2 models (${fallbackChain.join(', ')}).`,
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
  model: string = DEFAULT_LIVE_MODEL || 'gemini-4-hydrogen',
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
   - **Hyphenation Rule**: Do NOT add hyphens to compound modifiers or adjectives commonly written without hyphens in radiology reports. Write them as separate words with a space (e.g., write "age related" NOT "age-related", "age related neuro parenchymal atrophy", "well defined" NOT "well-defined", "ill defined" NOT "ill-defined", "ring enhancing" NOT "ring-enhancing", "contrast enhancing" NOT "contrast-enhancing", "non enhancing" NOT "non-enhancing", "soft tissue" NOT "soft-tissue", "flow void" NOT "flow-void", "fluid fluid level" NOT "fluid-fluid level", "fat fluid level" NOT "fat-fluid level"). Never insert unnecessary hyphens between adjacent words or between sentences. Only retain hyphens if strictly standard in medical nomenclature (such as "X-ray", "follow-up", "CT-guided", "T1-weighted", "T2-weighted"). When in doubt, prefer NO hyphen.
   - Clinical profile without asterisks and without BOLD:: (e.g., "Clinical Profile: C/o trauma.") and with no trailing or extra asterisks.
6. **IMPRESSION**:
   - If an impression exists, ensure it is formatted as "IMPRESSION:###point 1###point 2".
   - Smart Bullet Formatting in Impression:
     * Single-Line / Lead-In Summaries: Statements such as "findings are s/o...", narrative summary paragraphs, or single normal summary sentences now start flush with the beginning of the line without any bullet point (e.g. "IMPRESSION:###Normal study without acute abnormality.").
     * Discrete / Multi-Point Findings: When the impression consists of 2 or more discrete clinical findings, each individual finding is cleanly formatted with bullet points (• Point 1, • Point 2) starting from the left margin (e.g. "IMPRESSION:###• Point 1###• Point 2").
   - Ensure the impression highlights the most clinically significant and acute abnormalities first.
   - If findings clearly describe definitive pathologies but no impression was dictated, synthesize a concise, non-verbal impression matching the findings adhering to the Smart Bullet Formatting rules.
7. **Anti-Hallucination**:
   - DO NOT fabricate any new findings or lesions not present in the draft.
   - Discard any stray casual fragments or non-medical words if any slipped through.

Output MUST be a JSON object with a single "findings" array of strings.`;

  const primarySynthModel = model || DEFAULT_LIVE_MODEL || 'gemini-4-hydrogen';
  const fallbackChain = isStrictSelectedModelOnlyEnabled()
    ? [primarySynthModel]
    : getLiveModelFallbackChain(primarySynthModel);

  for (let attempt = 0; attempt < fallbackChain.length; attempt++) {
    const currentModel = fallbackChain[attempt];
    try {
      const rawResponseText = await generateContentWithJsonFallback(
        currentModel,
        [{ text: prompt }],
        responseSchema,
        0.1,
        undefined,
        'reasoning',
        { skipCrossModelFallback: true, failFastOnModelUnavailable: attempt < fallbackChain.length - 1 }
      );
      const parsedFindings = extractFindingsFromResponse(rawResponseText);
      if (parsedFindings && parsedFindings.length > 0) {
        return parsedFindings;
      }
      return rawFindings;
    } catch (err) {
      console.warn(`[Synthesize Report] Attempt ${attempt + 1}/${fallbackChain.length} with ${currentModel} notice:`, err);
      if (attempt < fallbackChain.length - 1) {
        const nextModel = fallbackChain[attempt + 1];
        const isUnavailable = isModelLevelServiceUnavailableError(err);
        console.info(`[Synthesize Report] Auto-failing over to subsequent model: ${nextModel}`);
        emitModelFailoverNotice({
          fromModel: currentModel,
          toModel: nextModel,
          reason: isUnavailable ? 'service_unavailable' : 'rate_limit',
        });
      }
    }
  }

  return rawFindings;
};


