/**
 * Experimental Audio Pre-Filter Service
 *
 * Three-stage client-side + Decision-1 pre-filtering pipeline that runs ONLY when
 * explicitly enabled via the experimental setting:
 *   1. Browser Web Audio Adaptive VAD silence trimming (0 API cost)
 *   2. Gemini Decision 1 (`gemini-decision-1`) non-radiology chatter filtering
 *   3. Size-safe re-encoding (WebCodecs Opus -> pure-TS Ogg/Opus, or 16kHz/12kHz WAV fallback)
 *
 * Strictly preserves all non-audio attachments (PDF, DOC/DOCX, RTF, TXT, images, videos)
 * untouched at their original array positions, and never throws pre-filter failures that
 * would block clinical dictation.
 */

import { executeWithApiKeyFailover } from './apiKeyService';
import { mergeMultipleAudioBlobs, triggerAudioDownload } from './audioMerger';

export const EXPERIMENTAL_AUDIO_FILTER_KEY = 'radiologyExperimentalAudioFilter';
export const VAD_SILENCE_TRIM_ENABLED_KEY = 'radiologyVadSilenceTrimEnabled';
export const DECISION1_CHATTER_FILTER_KEY = 'radiologyDecision1ChatterFilter';
export const PREFILTER_DECISION_MODEL = 'gemini-decision-1';

const DECISIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const DECISION_MAX_SEGMENTS_PER_BATCH = 6;
const DECISION_MAX_BATCH_SPEECH_SEC = 150;
const DECISION_BATCH_SPACING_MS = 0;
const DECISION_MAX_CONCURRENCY = 4;
const DECISION_WAV_FALLBACK_SAMPLE_RATE = 8000;
const DECISION_OPUS_BITRATE = 24000;
const DECISION_MIN_SPEECH_FOR_CHECK_SEC = 5;
const DECISION_DISCARD_NOUL_MAX = 0.25;
const DECISION_DISCARD_CONFIDENCE_MIN = 0.70;
const DECISION_APPROX_TPM_BUDGET = 45000;

const VAD_DEFAULT_FRAME_MS = 20;
const VAD_DEFAULT_MIN_SILENCE_MS = 950;
const VAD_DEFAULT_PADDING_MS = 180;
const VAD_DEFAULT_MIN_SPEECH_MS = 40;
const VAD_MIN_THRESHOLD_RMS = 0.006;
const VAD_MINUS_42_DBFS_RMS = Math.pow(10, -42 / 20); // ~0.007943
const VAD_MAX_THRESHOLD_RMS = 0.025;
const VAD_NOISE_MULTIPLIER = 3.5;

const WINDOW_MAX_GAP_MERGE_SEC = 2.5;
const WINDOW_TARGET_MIN_SPEECH_SEC = 8;
const WINDOW_MAX_SPEECH_SEC = 25;

const INTER_SEGMENT_SPACER_SEC = 0.12;
const SPLICE_FADE_SEC = 0.003;
const NEGLIGIBLE_SAVINGS_RATIO = 0.10;
const SMALL_ORIGINAL_BYTES_LIMIT = 10 * 1024 * 1024;
const WAV_DOWNGRADE_BYTES_LIMIT = 12 * 1024 * 1024;
const SAFE_INLINE_WAV_BYTES_LIMIT = 14 * 1024 * 1024;
const OPUS_TARGET_SAMPLE_RATE = 48000;
const OPUS_TARGET_BITRATE = 32000;
const OPUS_DEFAULT_PRE_SKIP = 312;

export interface AudioPrefilterStats {
  applied: boolean;
  originalDurationSec: number;
  keptDurationSec: number;
  afterVadDurationSec: number;
  silenceRemovedSec: number;
  nonRadiologyRemovedSec: number;
  keptSegmentsCount: number;
  droppedNonRadiologyCount: number;
  originalBytes: number;
  outputBytes: number;
  outputMimeType: string;
  decisionLatencyMs: number;
  usedDecision1: boolean;
  skippedReason?: string;
}

export interface SpeechInterval {
  startSec: number;
  endSec: number;
  durationSec: number;
  peakRms: number;
  meanRms: number;
}

export interface VadDetectionOptions {
  frameMs?: number;
  minSilenceMs?: number;
  paddingMs?: number;
  minSpeechMs?: number;
  minThresholdRms?: number;
  maxThresholdRms?: number;
  noiseMultiplier?: number;
}

export interface VadDetectionResult {
  intervals: SpeechInterval[];
  totalDurationSec: number;
  speechDurationSec: number;
  silenceRemovedSec: number;
  noiseFloorRms: number;
  speechEnvelopeRms: number;
  adaptiveThresholdRms: number;
}

export interface EvaluationWindow {
  index: number;
  intervals: SpeechInterval[];
  originalStartSec: number;
  originalEndSec: number;
  speechDurationSec: number;
}

export interface WindowingOptions {
  maxGapToMergeSec?: number;
  targetMinSpeechSec?: number;
  maxWindowSpeechSec?: number;
}

export interface OpusPacketInput {
  data: Uint8Array;
  durationSamples48k: number;
}

export interface DecisionSegmentOutcome {
  windowIndex: number;
  noul: number;
  confidence: number;
  keep: boolean;
}

export type DecisionsApiCaller = (
  body: { model: string; input: Array<Record<string, any>>; questions: Record<string, any> },
  abortSignal?: AbortSignal
) => Promise<any>;

export interface FilterAudioInputsOptions {
  enabled: boolean;
  /** Opt-in Gemini Decision 1 non-radiology speech filtering (off by default to preserve 100% clinical recall). */
  useDecision1?: boolean;
  abortSignal?: AbortSignal;
  onProgress?: (stage: string) => void;
}

const NON_AUDIO_DOC_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.rtf', '.txt', '.csv', '.md', '.json', '.xml',
  '.html', '.htm', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.zip', '.dcm',
]);

const NON_AUDIO_IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.svg',
  '.heic', '.heif', '.avif', '.ico',
]);

const NON_AUDIO_VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.flv', '.3gp', '.mpeg', '.mpg', '.ts', '.mts', '.ogv',
]);

const AUDIO_EXTENSIONS = new Set([
  '.wav', '.mp3', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.amr', '.wma', '.webm',
]);

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new DOMException('Aborted by user', 'AbortError');
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === 'AbortError'
  ) || (typeof err === 'object' && err !== null && (err as any).name === 'AbortError');
}

function getFileExtension(name: unknown): string {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim().toLowerCase();
  const dotIdx = trimmed.lastIndexOf('.');
  return dotIdx >= 0 ? trimmed.slice(dotIdx) : '';
}

function normalizeMime(rawMime?: string): string {
  return (rawMime || '').split(';')[0].trim().toLowerCase();
}

function isValidMp3SyncHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // Exclude UTF-16 BOMs (FF FE) and JPEG (FF D8)
  if (bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  if (bytes[1] === 0xfe || bytes[1] === 0xff) return false;
  const mpegVersionBits = (bytes[1] >> 3) & 0x03;
  const layerBits = (bytes[1] >> 1) & 0x03;
  const bitrateIdx = (bytes[2] >> 4) & 0x0f;
  const sampleRateIdx = (bytes[2] >> 2) & 0x03;
  return mpegVersionBits !== 0x01 && layerBits !== 0x00 && bitrateIdx !== 0x0f && sampleRateIdx !== 0x03;
}

/**
 * Detects audio container MIME type from leading magic bytes.
 * Reuses the header inspection rules from `services/geminiService.ts` while guarding
 * against non-audio RIFF subtypes (WEBP/AVI) and UTF-16 BOM false positives.
 */
export async function detectAudioMimeFromHeader(blob: Blob): Promise<string | null> {
  try {
    if (!blob || blob.size < 4) return null;
    const headerBuf = await blob.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(headerBuf);
    // RIFF....WAVE -> audio/wav (explicitly excludes WEBP / AVI)
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
    ) {
      return 'audio/wav';
    }
    // EBML header -> audio/webm (track check performed separately for video/webm)
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return 'audio/webm';
    }
    // OggS -> audio/ogg
    if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
      return 'audio/ogg';
    }
    // fLaC -> audio/flac
    if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
      return 'audio/flac';
    }
    // ISO Base Media (ftyp) -> audio/mp4
    if (
      bytes.length >= 8 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    ) {
      return 'audio/mp4';
    }
    // ID3 tag or validated MP3 frame sync -> audio/mp3
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
      isValidMp3SyncHeader(bytes)
    ) {
      return 'audio/mp3';
    }
  } catch {
    // Ignore header read failures
  }
  return null;
}

async function detectNonAudioMagicCategory(blob: Blob): Promise<string | null> {
  try {
    if (!blob || blob.size < 4) return null;
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    // %PDF
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return 'pdf';
    }
    // PK\x03\x04 (ZIP / DOCX / XLSX / PPTX)
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return 'document';
    }
    // OLE2 Compound Document (.doc / .xls / .ppt)
    if (
      bytes.length >= 8 &&
      bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 &&
      bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1
    ) {
      return 'document';
    }
    // {\rtf
    if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) {
      return 'document';
    }
    // PNG
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return 'image';
    }
    // JPEG
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image';
    }
    // GIF8
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return 'image';
    }
    // BMP
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return 'image';
    }
    // TIFF
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    ) {
      return 'image';
    }
    // RIFF....WEBP or RIFF....AVI
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    ) {
      if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image';
      }
      if (bytes[8] === 0x41 && bytes[9] === 0x56 && bytes[10] === 0x49 && bytes[11] === 0x20) {
        return 'video';
      }
    }
    // ISO Base Media QuickTime ('qt  ') or M4V video ('M4V ')
    if (
      bytes.length >= 12 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 &&
      ((bytes[8] === 0x71 && bytes[9] === 0x74 && bytes[10] === 0x20 && bytes[11] === 0x20) ||
       (bytes[8] === 0x4d && bytes[9] === 0x34 && bytes[10] === 0x56 && bytes[11] === 0x20))
    ) {
      return 'video';
    }
  } catch {
    // Ignore header read failures
  }
  return null;
}

async function hasEbmlVideoTrack(blob: Blob): Promise<boolean> {
  try {
    const sliceLen = Math.min(blob.size, 65536);
    if (sliceLen < 8) return false;
    const bytes = new Uint8Array(await blob.slice(0, sliceLen).arrayBuffer());
    if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) {
      return false;
    }
    let ascii = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      ascii += c >= 32 && c <= 126 ? String.fromCharCode(c) : ' ';
    }
    return (
      ascii.includes('V_VP8') ||
      ascii.includes('V_VP9') ||
      ascii.includes('V_AV1') ||
      ascii.includes('V_MPEG') ||
      ascii.includes('V_THEORA')
    );
  } catch {
    return false;
  }
}

async function hasEbmlAudioHeader(blob: Blob): Promise<boolean> {
  try {
    if (blob.size < 4) return false;
    const bytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  } catch {
    return false;
  }
}

/**
 * Strictly classifies an input Blob so non-audio files (PDF, DOCX, DOC, RTF, TXT,
 * images, and videos) are NEVER altered or decoded as audio.
 */
export async function classifyBlobForPrefilter(
  blob: Blob
): Promise<{ isAudio: boolean; mimeType: string; category: string }> {
  if (!blob || blob.size === 0) {
    return { isAudio: false, mimeType: normalizeMime(blob?.type) || 'application/octet-stream', category: 'empty' };
  }

  const rawMime = normalizeMime(blob.type);
  const ext = getFileExtension((blob as any).name);

  // 1. Explicit non-audio filename extensions win unconditionally
  if (ext) {
    if (ext === '.pdf') {
      return { isAudio: false, mimeType: 'application/pdf', category: 'pdf' };
    }
    if (NON_AUDIO_DOC_EXTENSIONS.has(ext)) {
      return {
        isAudio: false,
        mimeType: rawMime || (ext === '.txt' || ext === '.csv' || ext === '.md' || ext === '.json' ? 'text/plain' : 'application/octet-stream'),
        category: 'document',
      };
    }
    if (NON_AUDIO_IMAGE_EXTENSIONS.has(ext)) {
      return { isAudio: false, mimeType: rawMime || `image/${ext.slice(1)}`, category: 'image' };
    }
    if (NON_AUDIO_VIDEO_EXTENSIONS.has(ext)) {
      return { isAudio: false, mimeType: rawMime || `video/${ext.slice(1)}`, category: 'video' };
    }
  }

  // 2. Explicit non-audio MIME types
  if (rawMime === 'application/pdf') {
    return { isAudio: false, mimeType: rawMime, category: 'pdf' };
  }
  if (
    rawMime.startsWith('text/') ||
    rawMime === 'application/json' ||
    rawMime === 'application/xml' ||
    rawMime === 'application/rtf' ||
    rawMime === 'application/msword' ||
    rawMime.startsWith('application/vnd.openxmlformats-officedocument.') ||
    rawMime.startsWith('application/vnd.ms-') ||
    rawMime === 'application/zip'
  ) {
    return { isAudio: false, mimeType: rawMime, category: 'document' };
  }
  if (rawMime.startsWith('image/')) {
    return { isAudio: false, mimeType: rawMime, category: 'image' };
  }
  if (rawMime.startsWith('video/') && rawMime !== 'video/webm') {
    return { isAudio: false, mimeType: rawMime, category: 'video' };
  }

  // 3. Magic-byte check against non-audio formats (protects mislabeled or octet-stream blobs)
  const nonAudioMagic = await detectNonAudioMagicCategory(blob);
  if (nonAudioMagic) {
    return { isAudio: false, mimeType: rawMime || 'application/octet-stream', category: nonAudioMagic };
  }

  // 4. WebM requires distinguishing audio-only dictation recordings from actual video WebM files
  if (rawMime === 'video/webm' || ext === '.webm') {
    const isEbml = await hasEbmlAudioHeader(blob);
    if (!isEbml) {
      if (rawMime === 'video/webm') {
        return { isAudio: false, mimeType: 'video/webm', category: 'video' };
      }
    } else if (await hasEbmlVideoTrack(blob)) {
      return { isAudio: false, mimeType: 'video/webm', category: 'video' };
    } else {
      return { isAudio: true, mimeType: 'audio/webm', category: 'audio' };
    }
  }

  // 5. Check audio header magic bytes when MIME is missing, octet-stream, or generic audio container
  const headerMime = await detectAudioMimeFromHeader(blob);

  // If MIME is audio/*, verify ISO Base Media isn't a video file by extension (already excluded above)
  if (rawMime.startsWith('audio/')) {
    return { isAudio: true, mimeType: headerMime || rawMime, category: 'audio' };
  }

  // Missing or generic MIME: require verified audio magic header OR known audio extension
  if (!rawMime || rawMime === 'application/octet-stream') {
    if (headerMime) {
      return { isAudio: true, mimeType: headerMime, category: 'audio' };
    }
    if (ext && AUDIO_EXTENSIONS.has(ext)) {
      const extMimeMap: Record<string, string> = {
        '.wav': 'audio/wav',
        '.mp3': 'audio/mp3',
        '.ogg': 'audio/ogg',
        '.oga': 'audio/ogg',
        '.opus': 'audio/ogg',
        '.flac': 'audio/flac',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.webm': 'audio/webm',
      };
      return { isAudio: true, mimeType: extMimeMap[ext] || 'audio/ogg', category: 'audio' };
    }
  }

  return { isAudio: false, mimeType: rawMime || 'application/octet-stream', category: 'unknown' };
}

function percentileSorted(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Pure DSP Voice Activity Detector operating on mono Float32 PCM samples.
 * - Scans 20ms frames
 * - Estimates p20 noise floor RMS and p90 speech envelope RMS
 * - Uses conservative adaptive threshold around -42 dBFS / clamped [0.006, 0.025]
 * - Requires >= 950ms continuous silence before cutting between bursts
 * - Applies 180ms pre/post speech margin padding so word onsets/tails are preserved
 */
export function detectSpeechIntervalsFromPcm(
  samples: Float32Array,
  sampleRate: number,
  options: VadDetectionOptions = {}
): VadDetectionResult {
  if (!samples || samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return {
      intervals: [],
      totalDurationSec: 0,
      speechDurationSec: 0,
      silenceRemovedSec: 0,
      noiseFloorRms: 0,
      speechEnvelopeRms: 0,
      adaptiveThresholdRms: VAD_MINUS_42_DBFS_RMS,
    };
  }

  const totalDurationSec = samples.length / sampleRate;
  const frameMs = options.frameMs ?? VAD_DEFAULT_FRAME_MS;
  const minSilenceMs = options.minSilenceMs ?? VAD_DEFAULT_MIN_SILENCE_MS;
  const paddingMs = options.paddingMs ?? VAD_DEFAULT_PADDING_MS;
  const minSpeechMs = options.minSpeechMs ?? VAD_DEFAULT_MIN_SPEECH_MS;
  const minThresholdRms = options.minThresholdRms ?? VAD_MIN_THRESHOLD_RMS;
  const maxThresholdRms = options.maxThresholdRms ?? VAD_MAX_THRESHOLD_RMS;
  const noiseMultiplier = options.noiseMultiplier ?? VAD_NOISE_MULTIPLIER;

  const frameSamples = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const numFrames = Math.ceil(samples.length / frameSamples);
  const frameRms = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSamples;
    const end = Math.min(samples.length, start + frameSamples);
    const len = end - start;
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sumSq += s * s;
    }
    frameRms[f] = len > 0 ? Math.sqrt(sumSq / len) : 0;
  }

  const sortedRms = new Float32Array(frameRms);
  sortedRms.sort();

  const noiseFloorRms = percentileSorted(sortedRms, 0.20);
  // Measure speech envelope from active frames above minThresholdRms so long pauses
  // (>90% silence) do not drag the speech envelope estimate down to the noise floor.
  let aboveFloorCount = 0;
  for (let i = 0; i < sortedRms.length; i++) {
    if (sortedRms[i] >= minThresholdRms) aboveFloorCount++;
  }
  const speechEnvelopeRms =
    aboveFloorCount > 0
      ? percentileSorted(sortedRms.subarray(sortedRms.length - aboveFloorCount), 0.75)
      : percentileSorted(sortedRms, 0.95);

  // Use ~ -42 dBFS floor for typical speech, relaxing down to 0.006 for softer dictation
  const baseFloor =
    options.minThresholdRms !== undefined
      ? minThresholdRms
      : speechEnvelopeRms > 0 && speechEnvelopeRms < 0.02
      ? minThresholdRms
      : Math.max(minThresholdRms, VAD_MINUS_42_DBFS_RMS);

  const rawAdaptive = Math.max(
    baseFloor,
    Math.min(noiseFloorRms * noiseMultiplier, maxThresholdRms)
  );

  // Never let adaptive threshold exceed 45% of speech envelope when genuine speech is faint
  const adaptiveThresholdRms =
    speechEnvelopeRms > 0.004 && speechEnvelopeRms > noiseFloorRms * 1.8
      ? Math.max(minThresholdRms, Math.min(rawAdaptive, Math.max(minThresholdRms, speechEnvelopeRms * 0.45)))
      : rawAdaptive;

  // Classify active frames and reject single-frame transient clicks
  const minSpeechFrames = Math.max(1, Math.round(minSpeechMs / frameMs));
  const active = new Uint8Array(numFrames);
  let runStart = -1;
  for (let f = 0; f <= numFrames; f++) {
    const isAbove = f < numFrames && frameRms[f] >= adaptiveThresholdRms;
    if (isAbove && runStart === -1) {
      runStart = f;
    } else if (!isAbove && runStart !== -1) {
      const runLen = f - runStart;
      // Keep runs >= minSpeechFrames, or loud single-frame plosives (>= 2.5x threshold)
      let runPeak = 0;
      for (let k = runStart; k < f; k++) {
        if (frameRms[k] > runPeak) runPeak = frameRms[k];
      }
      if (runLen >= minSpeechFrames || runPeak >= adaptiveThresholdRms * 2.5) {
        for (let k = runStart; k < f; k++) {
          active[k] = 1;
        }
      }
      runStart = -1;
    }
  }

  // Extract raw active frame runs
  const rawIntervals: Array<{ startFrame: number; endFrame: number }> = [];
  let activeStart = -1;
  for (let f = 0; f <= numFrames; f++) {
    const isOn = f < numFrames && active[f] === 1;
    if (isOn && activeStart === -1) {
      activeStart = f;
    } else if (!isOn && activeStart !== -1) {
      rawIntervals.push({ startFrame: activeStart, endFrame: f });
      activeStart = -1;
    }
  }

  if (rawIntervals.length === 0) {
    return {
      intervals: [],
      totalDurationSec,
      speechDurationSec: 0,
      silenceRemovedSec: totalDurationSec,
      noiseFloorRms,
      speechEnvelopeRms,
      adaptiveThresholdRms,
    };
  }

  // Bridge pauses shorter than minSilenceMs BEFORE padding
  const minSilenceSec = minSilenceMs / 1000;
  const frameDurationSec = frameSamples / sampleRate;
  const bridged: Array<{ startSec: number; endSec: number }> = [];

  for (const seg of rawIntervals) {
    const startSec = seg.startFrame * frameDurationSec;
    const endSec = Math.min(totalDurationSec, seg.endFrame * frameDurationSec);
    if (bridged.length === 0) {
      bridged.push({ startSec, endSec });
    } else {
      const prev = bridged[bridged.length - 1];
      const gapSec = startSec - prev.endSec;
      if (gapSec < minSilenceSec) {
        prev.endSec = Math.max(prev.endSec, endSec);
      } else {
        bridged.push({ startSec, endSec });
      }
    }
  }

  // Apply pre/post speech margin padding and coalesce any overlaps
  const paddingSec = paddingMs / 1000;
  const padded: Array<{ startSec: number; endSec: number }> = [];
  for (const seg of bridged) {
    const startSec = Math.max(0, seg.startSec - paddingSec);
    const endSec = Math.min(totalDurationSec, seg.endSec + paddingSec);
    if (padded.length === 0) {
      padded.push({ startSec, endSec });
    } else {
      const prev = padded[padded.length - 1];
      if (startSec <= prev.endSec) {
        prev.endSec = Math.max(prev.endSec, endSec);
      } else {
        padded.push({ startSec, endSec });
      }
    }
  }

  const intervals: SpeechInterval[] = padded.map((seg) => {
    const startFrame = Math.max(0, Math.floor(seg.startSec / frameDurationSec));
    const endFrame = Math.min(numFrames, Math.ceil(seg.endSec / frameDurationSec));
    let peakRms = 0;
    let sumRms = 0;
    let count = 0;
    for (let f = startFrame; f < endFrame; f++) {
      const r = frameRms[f];
      if (r > peakRms) peakRms = r;
      sumRms += r;
      count++;
    }
    return {
      startSec: seg.startSec,
      endSec: seg.endSec,
      durationSec: Math.max(0, seg.endSec - seg.startSec),
      peakRms,
      meanRms: count > 0 ? sumRms / count : 0,
    };
  });

  const speechDurationSec = intervals.reduce((acc, item) => acc + item.durationSec, 0);
  return {
    intervals,
    totalDurationSec,
    speechDurationSec,
    silenceRemovedSec: Math.max(0, totalDurationSec - speechDurationSec),
    noiseFloorRms,
    speechEnvelopeRms,
    adaptiveThresholdRms,
  };
}

/**
 * Groups closely spaced speech bursts (gap <= 2.5s) into coherent evaluation windows
 * targeting ~8s-25s of speech per window for contextual Decision-1 evaluation.
 */
export function buildEvaluationWindows(
  intervals: SpeechInterval[],
  options: WindowingOptions = {}
): EvaluationWindow[] {
  const valid = intervals
    .filter((i) => Number.isFinite(i.startSec) && Number.isFinite(i.endSec) && i.endSec > i.startSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);

  if (valid.length === 0) return [];

  const maxGapToMergeSec = options.maxGapToMergeSec ?? WINDOW_MAX_GAP_MERGE_SEC;
  const maxWindowSpeechSec = options.maxWindowSpeechSec ?? WINDOW_MAX_SPEECH_SEC;
  const targetMinSpeechSec = options.targetMinSpeechSec ?? WINDOW_TARGET_MIN_SPEECH_SEC;

  const windows: EvaluationWindow[] = [];
  let currentIntervals: SpeechInterval[] = [valid[0]];
  let currentSpeechSec = valid[0].durationSec;
  let currentEndSec = valid[0].endSec;

  for (let i = 1; i < valid.length; i++) {
    const next = valid[i];
    const gapSec = next.startSec - currentEndSec;
    const combinedSpeechSec = currentSpeechSec + next.durationSec;

    const withinGap = gapSec <= maxGapToMergeSec;
    const fitsMaxWindow = combinedSpeechSec <= maxWindowSpeechSec;
    const needsContext = currentSpeechSec < targetMinSpeechSec && combinedSpeechSec <= maxWindowSpeechSec + 4;

    if (withinGap && (fitsMaxWindow || needsContext)) {
      currentIntervals.push(next);
      currentSpeechSec = combinedSpeechSec;
      currentEndSec = Math.max(currentEndSec, next.endSec);
    } else {
      windows.push({
        index: windows.length,
        intervals: currentIntervals,
        originalStartSec: currentIntervals[0].startSec,
        originalEndSec: currentIntervals[currentIntervals.length - 1].endSec,
        speechDurationSec: currentSpeechSec,
      });
      currentIntervals = [next];
      currentSpeechSec = next.durationSec;
      currentEndSec = next.endSec;
    }
  }

  windows.push({
    index: windows.length,
    intervals: currentIntervals,
    originalStartSec: currentIntervals[0].startSec,
    originalEndSec: currentIntervals[currentIntervals.length - 1].endSec,
    speechDurationSec: currentSpeechSec,
  });

  return windows;
}

export function resampleMonoPcm(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }
  const targetLen = Math.max(1, Math.round(samples.length * (toRate / fromRate)));
  const out = new Float32Array(targetLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < targetLen; i++) {
    const srcIdx = i * ratio;
    const idx0 = Math.floor(srcIdx);
    const idx1 = Math.min(idx0 + 1, samples.length - 1);
    const frac = srcIdx - idx0;
    out[i] = (1 - frac) * samples[idx0] + frac * samples[idx1];
  }
  return out;
}

/**
 * Concatenates PCM segments for the provided speech intervals, inserting a 120ms
 * digital silence spacer between non-adjacent intervals and tiny 3ms splice fades.
 */
export function concatPcmIntervals(
  monoSamples: Float32Array,
  sampleRate: number,
  intervals: SpeechInterval[],
  spacerSec = INTER_SEGMENT_SPACER_SEC
): Float32Array {
  if (intervals.length === 0) return new Float32Array(0);
  const spacerSamples = Math.max(0, Math.round(spacerSec * sampleRate));
  const fadeSamples = Math.min(Math.round(SPLICE_FADE_SEC * sampleRate), 256);

  const slices: Float32Array[] = [];
  let totalSamples = 0;

  for (let i = 0; i < intervals.length; i++) {
    const seg = intervals[i];
    const startIdx = Math.max(0, Math.min(monoSamples.length, Math.round(seg.startSec * sampleRate)));
    const endIdx = Math.max(startIdx, Math.min(monoSamples.length, Math.round(seg.endSec * sampleRate)));
    const sliceLen = endIdx - startIdx;
    if (sliceLen <= 0) continue;

    if (slices.length > 0 && spacerSamples > 0) {
      totalSamples += spacerSamples;
    }

    const slice = monoSamples.slice(startIdx, endIdx);
    const actualFade = Math.min(fadeSamples, Math.floor(slice.length / 4));
    if (actualFade > 0) {
      for (let f = 0; f < actualFade; f++) {
        const gain = f / actualFade;
        slice[f] *= gain;
        slice[slice.length - 1 - f] *= gain;
      }
    }

    slices.push(slice);
    totalSamples += slice.length;
  }

  const out = new Float32Array(totalSamples);
  let offset = 0;
  for (let i = 0; i < slices.length; i++) {
    if (i > 0 && spacerSamples > 0) {
      offset += spacerSamples;
    }
    out.set(slices[i], offset);
    offset += slices[i].length;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function encodePcmToWavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, int16, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function encodePcmToWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const bytes = encodePcmToWavBytes(samples, sampleRate);
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' });
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    parts.push(String.fromCharCode(...sub));
  }
  return btoa(parts.join(''));
}

/**
 * Conservative clinical recall threshold for Gemini Decision 1 non-radiology filtering.
 * Drops a window ONLY when noul < 0.25 AND confidence >= 0.70 (keeps on any doubt).
 */
export function shouldDiscardDecisionSegment(noul: number, confidence: number): boolean {
  if (!Number.isFinite(noul) || !Number.isFinite(confidence)) {
    return false;
  }
  return noul < DECISION_DISCARD_NOUL_MAX && confidence >= DECISION_DISCARD_CONFIDENCE_MIN;
}

function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  throwIfAborted(abortSignal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted by user', 'AbortError'));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function defaultCallAudioDecisionsApi(
  body: { model: string; input: Array<Record<string, any>>; questions: Record<string, any> },
  abortSignal?: AbortSignal
): Promise<any> {
  return await executeWithApiKeyFailover(
    async (_client, apiKey) => {
      const res = await fetch(DECISIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error?.message || `Decisions API HTTP ${res.status}: ${res.statusText}`;
        const err: any = new Error(msg);
        err.status = res.status;
        if (res.status === 400 && !msg.toLowerCase().includes('api key') && !msg.toLowerCase().includes('quota')) {
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
      selectedModel: PREFILTER_DECISION_MODEL,
      // Keep failover fast because Decision-1 fails open safely to VAD-trimmed audio
      maxTries: 2,
      delayMs: 250,
      abortSignal,
    }
  );
}

export interface DecisionBatchWindowInput {
  window: EvaluationWindow;
  wavBase64?: string;
  audioBase64?: string;
  mimeType?: string;
}

export function buildDecisionBatchPayload(
  batchWindows: DecisionBatchWindowInput[]
): { model: string; input: Array<Record<string, any>>; questions: Record<string, any> } {
  const input: Array<Record<string, any>> = [
    {
      type: 'text',
      text: 'Evaluate each independently labeled [Segment K] audio clip from a radiology dictation session.\n',
    },
  ];
  const questions: Record<string, any> = {};

  for (let i = 0; i < batchWindows.length; i++) {
    const k = i + 1;
    const audioData = batchWindows[i].audioBase64 ?? batchWindows[i].wavBase64 ?? '';
    const mimeType = batchWindows[i].mimeType || 'audio/wav';
    input.push({ type: 'text', text: `[Segment ${k}]\n` });
    input.push({
      type: 'audio',
      data: audioData,
      mime_type: mimeType,
    });

    questions[`seg_${k}`] = {
      type: 'noul',
      instructions:
        `Examine ONLY [Segment ${k}]. Return true if [Segment ${k}] contains ANY radiology dictation, findings, normal/negative comments, measurements, patient info or clinical profile, study labels, or dictation/formatting voice commands ("next line", "impression", "template", "patient 2", "delete"). Return false ONLY if it is strictly non-dictation office chatter, unrelated phone calls, coughing/throat clearing, or pure noise.`,
      criteria: {
        true_description:
          'ANY radiology dictation, medical findings, normal or negative comments, measurements, patient history/profile, study/modality labels, or dictation/formatting/template voice commands.',
        false_description:
          'Strictly non-dictation background office chatter, unrelated personal or phone conversations, coughing/throat clearing, or pure ambient noise.',
      },
    };
  }

  return {
    model: PREFILTER_DECISION_MODEL,
    input,
    questions,
  };
}

export function groupWindowsIntoDecisionBatches(
  windows: EvaluationWindow[],
  maxPerBatch = DECISION_MAX_SEGMENTS_PER_BATCH,
  maxSpeechSecPerBatch = DECISION_MAX_BATCH_SPEECH_SEC
): EvaluationWindow[][] {
  const batches: EvaluationWindow[][] = [];
  let current: EvaluationWindow[] = [];
  let currentSec = 0;

  for (const w of windows) {
    if (
      current.length > 0 &&
      (current.length >= maxPerBatch || currentSec + w.speechDurationSec > maxSpeechSecPerBatch)
    ) {
      batches.push(current);
      current = [];
      currentSec = 0;
    }
    current.push(w);
    currentSec += w.speechDurationSec;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function isQuotaOrRateLimitError(err: unknown): boolean {
  const anyErr = err as any;
  if (anyErr?.status === 429) return true;
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

function isDecisionBadRequestError(err: unknown): boolean {
  const anyErr = err as any;
  return anyErr?.status === 400 || anyErr?.isNonRetryable === true;
}

async function encodeDecisionBatchItems(
  batch: EvaluationWindow[],
  monoSamples: Float32Array,
  sampleRate: number,
  preferOggOpus: boolean,
  abortSignal?: AbortSignal
): Promise<{ items: DecisionBatchWindowInput[]; usedOgg: boolean }> {
  let usedOgg = false;
  const items = await Promise.all(
    batch.map(async (win): Promise<DecisionBatchWindowInput> => {
      throwIfAborted(abortSignal);
      const segPcm = concatPcmIntervals(monoSamples, sampleRate, win.intervals);

      if (preferOggOpus) {
        const oggBytes = await encodePcmBytesWithWebCodecsOggOpus(segPcm, sampleRate, {
          abortSignal,
          bitrate: DECISION_OPUS_BITRATE,
        });
        if (oggBytes && oggBytes.byteLength > 0) {
          usedOgg = true;
          return {
            window: win,
            audioBase64: uint8ArrayToBase64(oggBytes),
            mimeType: 'audio/ogg',
          };
        }
      }

      const pcmCompact = resampleMonoPcm(segPcm, sampleRate, DECISION_WAV_FALLBACK_SAMPLE_RATE);
      const wavBytes = encodePcmToWavBytes(pcmCompact, DECISION_WAV_FALLBACK_SAMPLE_RATE);
      return {
        window: win,
        wavBase64: uint8ArrayToBase64(wavBytes),
        mimeType: 'audio/wav',
      };
    })
  );
  return { items, usedOgg };
}

/**
 * Evaluates VAD evaluation windows via Gemini Decision 1 using bounded parallel batches
 * and compact Opus/8kHz WAV payloads to drop non-radiology chatter while upholding safety:
 * - Skips Decision-1 when total speech <= 5s or <= 1 window
 * - Never drops 100% of segments
 * - Trips quota circuit breaker cleanly on 429 and keeps remaining VAD segments without stalling
 */
export async function filterWindowsWithDecision1(
  windows: EvaluationWindow[],
  monoSamples: Float32Array,
  sampleRate: number,
  options: {
    abortSignal?: AbortSignal;
    callDecisionsFn?: DecisionsApiCaller;
    batchSpacingMs?: number;
    concurrency?: number;
    onProgress?: (stage: string) => void;
  } = {}
): Promise<{
  keptWindows: EvaluationWindow[];
  droppedWindows: EvaluationWindow[];
  usedDecision1: boolean;
  decisionLatencyMs: number;
  outcomes: DecisionSegmentOutcome[];
  fallbackReason?: string;
}> {
  if (windows.length === 0) {
    return {
      keptWindows: [],
      droppedWindows: [],
      usedDecision1: false,
      decisionLatencyMs: 0,
      outcomes: [],
    };
  }

  const totalSpeechSec = windows.reduce((sum, w) => sum + w.speechDurationSec, 0);
  if (windows.length <= 1 || totalSpeechSec <= DECISION_MIN_SPEECH_FOR_CHECK_SEC) {
    return {
      keptWindows: windows,
      droppedWindows: [],
      usedDecision1: false,
      decisionLatencyMs: 0,
      outcomes: [],
      fallbackReason:
        windows.length <= 1
          ? 'Single evaluation window; skipped Decision-1 latency'
          : 'Short audio (<=5s speech); skipped Decision-1 latency',
    };
  }

  const callDecisions = options.callDecisionsFn ?? defaultCallAudioDecisionsApi;
  const batchSpacingMs = options.batchSpacingMs ?? DECISION_BATCH_SPACING_MS;
  const batches = groupWindowsIntoDecisionBatches(windows);
  const concurrency = Math.max(1, options.concurrency ?? DECISION_MAX_CONCURRENCY);

  const startedAt = Date.now();
  const keepMap = new Map<number, boolean>();
  const outcomes: DecisionSegmentOutcome[] = [];
  let anyBatchSucceeded = false;
  let fallbackReason: string | undefined;

  // Reserve batches up to Free-Tier 50k TPM budget upfront so workers execute concurrently
  const batchesToEvaluate: EvaluationWindow[][] = [];
  let estimatedTokensReserved = 0;
  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    const batchSpeechSec = batch.reduce((s, w) => s + w.speechDurationSec, 0);
    const estimatedBatchTokens = Math.ceil(batchSpeechSec * 32) + batch.length * 160;
    if (bIdx > 0 && estimatedTokensReserved + estimatedBatchTokens > DECISION_APPROX_TPM_BUDGET) {
      for (let remIdx = bIdx; remIdx < batches.length; remIdx++) {
        for (const remWin of batches[remIdx]) {
          keepMap.set(remWin.index, true);
        }
      }
      fallbackReason = 'Decision-1 TPM budget threshold reached; kept remaining segments for safety';
      break;
    }
    batchesToEvaluate.push(batch);
    estimatedTokensReserved += estimatedBatchTokens;
  }

  let nextBatchIdx = 0;
  let completedBatches = 0;
  let quotaCircuitTripped = false;
  let preferOggForDecisions = true;

  const markBatchKept = (batch: EvaluationWindow[]) => {
    for (const win of batch) {
      keepMap.set(win.index, true);
    }
  };

  const runWorker = async () => {
    while (true) {
      throwIfAborted(options.abortSignal);
      const bIdx = nextBatchIdx++;
      if (bIdx >= batchesToEvaluate.length) {
        return;
      }

      const batch = batchesToEvaluate[bIdx];
      if (quotaCircuitTripped) {
        markBatchKept(batch);
        continue;
      }

      if (bIdx > 0 && batchSpacingMs > 0 && concurrency === 1) {
        await sleepWithAbort(batchSpacingMs, options.abortSignal);
      }

      let encoded = await encodeDecisionBatchItems(
        batch,
        monoSamples,
        sampleRate,
        preferOggForDecisions,
        options.abortSignal
      );

      try {
        let data: any;
        try {
          data = await callDecisions(buildDecisionBatchPayload(encoded.items), options.abortSignal);
        } catch (firstErr) {
          if (isAbortError(firstErr) || options.abortSignal?.aborted) {
            throw firstErr;
          }
          // If an environment/endpoint rejects Ogg for Decisions, transparently retry once with compact 8kHz WAV
          if (encoded.usedOgg && isDecisionBadRequestError(firstErr)) {
            preferOggForDecisions = false;
            encoded = await encodeDecisionBatchItems(
              batch,
              monoSamples,
              sampleRate,
              false,
              options.abortSignal
            );
            data = await callDecisions(buildDecisionBatchPayload(encoded.items), options.abortSignal);
          } else {
            throw firstErr;
          }
        }

        anyBatchSucceeded = true;
        const answers = data?.answers || {};
        for (let i = 0; i < batch.length; i++) {
          const win = batch[i];
          const ans = answers[`seg_${i + 1}`];
          const noul = typeof ans?.noul === 'number' ? ans.noul : 1;
          const confidence =
            typeof ans?.confidence === 'number'
              ? ans.confidence
              : typeof ans?.noul === 'number'
              ? Math.max(ans.noul, 1 - ans.noul)
              : 0;
          const discard = shouldDiscardDecisionSegment(noul, confidence);
          keepMap.set(win.index, !discard);
          outcomes.push({
            windowIndex: win.index,
            noul,
            confidence,
            keep: !discard,
          });
        }
      } catch (err) {
        if (isAbortError(err) || options.abortSignal?.aborted) {
          throw err;
        }
        console.warn('[AudioPrefilter] Decision-1 batch failed; keeping batch segments safely:', err);
        markBatchKept(batch);
        if (isQuotaOrRateLimitError(err)) {
          quotaCircuitTripped = true;
        }
        fallbackReason = 'Decision-1 API/quota error; fell back to VAD-trimmed audio';
      } finally {
        completedBatches++;
        if (batchesToEvaluate.length > 1) {
          options.onProgress?.(
            `Filtering non-radiology chatter (${completedBatches}/${batchesToEvaluate.length} batches)...`
          );
        }
      }
    }
  };

  const workerCount = Math.min(concurrency, batchesToEvaluate.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  outcomes.sort((a, b) => a.windowIndex - b.windowIndex);

  const decisionLatencyMs = Date.now() - startedAt;

  if (!anyBatchSucceeded) {
    return {
      keptWindows: windows,
      droppedWindows: [],
      usedDecision1: false,
      decisionLatencyMs,
      outcomes,
      fallbackReason: fallbackReason || 'Decision-1 unavailable; fell back to VAD-trimmed audio',
    };
  }

  const keptWindows = windows.filter((w) => keepMap.get(w.index) !== false);
  const droppedWindows = windows.filter((w) => keepMap.get(w.index) === false);

  // Clinical recall guard: NEVER drop 100% of speech windows
  if (keptWindows.length === 0) {
    return {
      keptWindows: windows,
      droppedWindows: [],
      usedDecision1: true,
      decisionLatencyMs,
      outcomes,
      fallbackReason: 'Decision-1 rejected all segments; kept VAD-trimmed audio as clinical safety fallback',
    };
  }

  return {
    keptWindows,
    droppedWindows,
    usedDecision1: true,
    decisionLatencyMs,
    outcomes,
    fallbackReason,
  };
}

// --- Pure TypeScript RFC 3533 + RFC 7845 Ogg/Opus Container Muxer ---

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function computeOggPageCrc32(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function buildOggPage(params: {
  headerType: number;
  granulePos: number;
  serial: number;
  sequence: number;
  packets: Uint8Array[];
}): Uint8Array {
  const lacingValues: number[] = [];
  let payloadLen = 0;

  for (const pkt of params.packets) {
    payloadLen += pkt.length;
    let remaining = pkt.length;
    while (remaining >= 255) {
      lacingValues.push(255);
      remaining -= 255;
    }
    lacingValues.push(remaining);
  }

  const headerLen = 27 + lacingValues.length;
  const page = new Uint8Array(headerLen + payloadLen);
  const view = new DataView(page.buffer);

  // 'OggS'
  page[0] = 0x4f;
  page[1] = 0x67;
  page[2] = 0x67;
  page[3] = 0x53;
  page[4] = 0; // capture version
  page[5] = params.headerType & 0xff;

  const gp = Math.max(0, Math.floor(params.granulePos));
  const gpLow = gp >>> 0;
  const gpHigh = Math.floor(gp / 0x100000000) >>> 0;
  view.setUint32(6, gpLow, true);
  view.setUint32(10, gpHigh, true);

  view.setUint32(14, params.serial >>> 0, true);
  view.setUint32(18, params.sequence >>> 0, true);
  view.setUint32(22, 0, true); // zeroed before CRC32
  page[26] = lacingValues.length;

  for (let i = 0; i < lacingValues.length; i++) {
    page[27 + i] = lacingValues[i];
  }

  let bodyOffset = headerLen;
  for (const pkt of params.packets) {
    page.set(pkt, bodyOffset);
    bodyOffset += pkt.length;
  }

  const crc = computeOggPageCrc32(page);
  view.setUint32(22, crc, true);
  return page;
}

function buildOpusHeadPacket(preSkip: number, inputSampleRate = OPUS_TARGET_SAMPLE_RATE): Uint8Array {
  const packet = new Uint8Array(19);
  const view = new DataView(packet.buffer);
  writeAscii(view, 0, 'OpusHead');
  packet[8] = 1; // Opus encapsulation version 1
  packet[9] = 1; // mono
  view.setUint16(10, Math.max(0, Math.min(0xffff, Math.round(preSkip))), true);
  view.setUint32(12, inputSampleRate >>> 0, true);
  view.setInt16(16, 0, true); // output gain 0 dB
  packet[18] = 0; // channel mapping family 0
  return packet;
}

function buildOpusTagsPacket(vendor = 'RadiologyDictationPrefilter'): Uint8Array {
  const vendorBytes = new TextEncoder().encode(vendor);
  const packet = new Uint8Array(8 + 4 + vendorBytes.length + 4);
  const view = new DataView(packet.buffer);
  writeAscii(view, 0, 'OpusTags');
  view.setUint32(8, vendorBytes.length, true);
  packet.set(vendorBytes, 12);
  view.setUint32(12 + vendorBytes.length, 0, true); // 0 user comments
  return packet;
}

function parseOpusPacketDurationSamples48k(packet: Uint8Array): number {
  if (!packet || packet.length === 0) return 960;
  const toc = packet[0];
  const config = (toc >> 3) & 0x1f;
  const frameCode = toc & 0x03;

  let samplesPerFrame: number;
  if (config < 12) {
    samplesPerFrame = [480, 960, 1920, 2880][config % 4];
  } else if (config < 16) {
    samplesPerFrame = [480, 960][config % 2];
  } else {
    samplesPerFrame = [120, 240, 480, 960][config % 4];
  }

  let frameCount = 1;
  if (frameCode === 1 || frameCode === 2) {
    frameCount = 2;
  } else if (frameCode === 3 && packet.length >= 2) {
    frameCount = Math.max(1, packet[1] & 0x3f);
  }
  return samplesPerFrame * frameCount;
}

/**
 * Wraps raw 48kHz mono Opus packets into a standard RFC 7845 / RFC 3533 Ogg/Opus byte stream.
 * Zero external dependencies. Verified against ffprobe/ffmpeg.
 */
export function muxOpusPacketsToOgg(
  packets: Array<{ data: Uint8Array; durationSamples48k: number }>,
  preSkip = OPUS_DEFAULT_PRE_SKIP
): Uint8Array {
  const serial = 0x52414431; // 'RAD1'
  const pages: Uint8Array[] = [];
  let pageSeq = 0;

  // Page 0: OpusHead (BOS = 0x02)
  pages.push(
    buildOggPage({
      headerType: 0x02,
      granulePos: 0,
      serial,
      sequence: pageSeq++,
      packets: [buildOpusHeadPacket(preSkip, OPUS_TARGET_SAMPLE_RATE)],
    })
  );

  // Page 1: OpusTags (EOS if no audio packets follow)
  pages.push(
    buildOggPage({
      headerType: packets.length === 0 ? 0x04 : 0x00,
      granulePos: 0,
      serial,
      sequence: pageSeq++,
      packets: [buildOpusTagsPacket()],
    })
  );

  if (packets.length > 0) {
    // Group audio packets into Ogg pages (<= 255 lacing entries and <= 50 packets per page)
    let pagePackets: Uint8Array[] = [];
    let pageSegmentsCount = 0;
    let cumulativeSamples = 0;
    let pageEndGranule = 0;

    for (let i = 0; i < packets.length; i++) {
      const pkt = packets[i];
      const pktSegs = Math.floor(pkt.data.length / 255) + 1;
      const pktSamples =
        pkt.durationSamples48k > 0
          ? Math.round(pkt.durationSamples48k)
          : parseOpusPacketDurationSamples48k(pkt.data);

      if (pagePackets.length > 0 && (pageSegmentsCount + pktSegs > 255 || pagePackets.length >= 50)) {
        pages.push(
          buildOggPage({
            headerType: 0x00,
            granulePos: pageEndGranule,
            serial,
            sequence: pageSeq++,
            packets: pagePackets,
          })
        );
        pagePackets = [];
        pageSegmentsCount = 0;
      }

      pagePackets.push(pkt.data);
      pageSegmentsCount += pktSegs;
      cumulativeSamples += pktSamples;
      pageEndGranule = cumulativeSamples;
    }

    // Final audio page with EOS flag (0x04)
    pages.push(
      buildOggPage({
        headerType: 0x04,
        granulePos: pageEndGranule,
        serial,
        sequence: pageSeq++,
        packets: pagePackets,
      })
    );
  }

  const totalLen = pages.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of pages) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const opusSupportCache = new Map<number, boolean>();

async function isOpusWebCodecsSupported(bitrate: number): Promise<boolean> {
  const cached = opusSupportCache.get(bitrate);
  if (cached !== undefined) return cached;
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return false;
  }
  const config: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate: OPUS_TARGET_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate,
  };
  try {
    const support = await AudioEncoder.isConfigSupported(config);
    const ok = Boolean(support.supported);
    opusSupportCache.set(bitrate, ok);
    return ok;
  } catch {
    opusSupportCache.set(bitrate, false);
    return false;
  }
}

async function encodePcmBytesWithWebCodecsOggOpus(
  monoSamples: Float32Array,
  sampleRate: number,
  options: { abortSignal?: AbortSignal; bitrate?: number } = {}
): Promise<Uint8Array | null> {
  const bitrate = options.bitrate ?? OPUS_TARGET_BITRATE;
  if (!(await isOpusWebCodecsSupported(bitrate))) {
    return null;
  }

  const config: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate: OPUS_TARGET_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate,
  };

  throwIfAborted(options.abortSignal);
  const pcm48k = resampleMonoPcm(monoSamples, sampleRate, OPUS_TARGET_SAMPLE_RATE);
  if (pcm48k.length === 0) return null;

  const packets: OpusPacketInput[] = [];
  let preSkip = OPUS_DEFAULT_PRE_SKIP;
  let preSkipDetected = false;
  let encodeError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);

      const rawDesc = metadata?.decoderConfig?.description;
      if (!preSkipDetected && rawDesc) {
        const descBytes =
          rawDesc instanceof ArrayBuffer
            ? new Uint8Array(rawDesc)
            : ArrayBuffer.isView(rawDesc)
            ? new Uint8Array(rawDesc.buffer, rawDesc.byteOffset, rawDesc.byteLength)
            : null;
        if (
          descBytes &&
          descBytes.byteLength >= 12 &&
          descBytes[0] === 0x4f &&
          descBytes[1] === 0x70 &&
          descBytes[2] === 0x75 &&
          descBytes[3] === 0x73 &&
          descBytes[4] === 0x48 &&
          descBytes[5] === 0x65 &&
          descBytes[6] === 0x61 &&
          descBytes[7] === 0x64
        ) {
          const dv = new DataView(descBytes.buffer, descBytes.byteOffset, descBytes.byteLength);
          preSkip = dv.getUint16(10, true);
          preSkipDetected = true;
        }
      }

      const durationSamples48k =
        chunk.duration && chunk.duration > 0
          ? Math.max(120, Math.round((chunk.duration * OPUS_TARGET_SAMPLE_RATE) / 1_000_000))
          : parseOpusPacketDurationSamples48k(buf);
      packets.push({ data: buf, durationSamples48k });
    },
    error: (err: DOMException) => {
      encodeError = err;
    },
  });

  try {
    encoder.configure(config);
    // Feed 4-second frames to minimize AudioData wrappers & queue stalls on long audio
    const blockSize = OPUS_TARGET_SAMPLE_RATE * 4;
    for (let offset = 0; offset < pcm48k.length; offset += blockSize) {
      throwIfAborted(options.abortSignal);
      if (encodeError) throw encodeError;

      while (encoder.encodeQueueSize > 32) {
        await sleepWithAbort(5, options.abortSignal);
        if (encodeError) throw encodeError;
      }

      const frameLen = Math.min(blockSize, pcm48k.length - offset);
      const slice = pcm48k.subarray(offset, offset + frameLen);
      const timestampUs = Math.round((offset / OPUS_TARGET_SAMPLE_RATE) * 1_000_000);
      const audioData = new AudioData({
        format: 'f32',
        sampleRate: OPUS_TARGET_SAMPLE_RATE,
        numberOfFrames: frameLen,
        numberOfChannels: 1,
        timestamp: timestampUs,
        data: slice as Float32Array<ArrayBuffer>,
      });
      try {
        encoder.encode(audioData);
      } finally {
        audioData.close();
      }
    }

    await encoder.flush();
    if (encodeError) throw encodeError;
    if (packets.length === 0) return null;

    return muxOpusPacketsToOgg(packets, preSkip);
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('[AudioPrefilter] WebCodecs Opus encoding failed, falling back to WAV:', err);
    return null;
  } finally {
    try {
      if (encoder.state !== 'closed') {
        encoder.close();
      }
    } catch {
      // Ignore close error
    }
  }
}

async function encodePcmWithWebCodecsOggOpus(
  monoSamples: Float32Array,
  sampleRate: number,
  abortSignal?: AbortSignal
): Promise<Blob | null> {
  const oggBytes = await encodePcmBytesWithWebCodecsOggOpus(monoSamples, sampleRate, { abortSignal });
  if (!oggBytes) return null;
  return new Blob([oggBytes.buffer as ArrayBuffer], { type: 'audio/ogg' });
}

async function encodeCompactAudioBlob(
  monoSamples: Float32Array,
  sampleRate: number,
  abortSignal?: AbortSignal
): Promise<{ blob: Blob; mimeType: string }> {
  const oggBlob = await encodePcmWithWebCodecsOggOpus(monoSamples, sampleRate, abortSignal);
  if (oggBlob && oggBlob.size > 0) {
    return { blob: oggBlob, mimeType: 'audio/ogg' };
  }

  // Fallback to 16kHz mono PCM WAV (or 12kHz if predicted > 12MB)
  const durationSec = monoSamples.length / sampleRate;
  const predicted16kBytes = Math.round(durationSec * 16000) * 2 + 44;
  const targetRate = predicted16kBytes > WAV_DOWNGRADE_BYTES_LIMIT ? 12000 : 16000;
  const wavPcm = resampleMonoPcm(monoSamples, sampleRate, targetRate);
  return {
    blob: encodePcmToWavBlob(wavPcm, targetRate),
    mimeType: 'audio/wav',
  };
}

function extractMonoPcmFromAudioBuffer(buffer: AudioBuffer): Float32Array {
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;
  if (numChannels <= 1) {
    return buffer.getChannelData(0);
  }
  const chData: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    chData.push(buffer.getChannelData(c));
  }
  const mono = new Float32Array(length);
  const inv = 1 / numChannels;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      sum += chData[c][i];
    }
    mono[i] = sum * inv;
  }
  return mono;
}

async function decodeBlobToMonoPcm(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  const AudioContextClass =
    typeof window !== 'undefined'
      ? window.AudioContext || (window as any).webkitAudioContext
      : undefined;

  if (!AudioContextClass) {
    throw new Error('AudioContext is unavailable in this environment.');
  }

  const audioCtx = new AudioContextClass();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const samples = extractMonoPcmFromAudioBuffer(audioBuffer);
    return { samples: new Float32Array(samples), sampleRate: audioBuffer.sampleRate };
  } finally {
    if (audioCtx.state !== 'closed') {
      await audioCtx.close().catch(() => {});
    }
  }
}

async function prefilterSingleAudioBlob(
  blob: Blob,
  cleanMime: string,
  options: { useDecision1?: boolean; abortSignal?: AbortSignal; onProgress?: (stage: string) => void }
): Promise<{
  blob: Blob;
  applied: boolean;
  originalDurationSec: number;
  keptDurationSec: number;
  afterVadDurationSec: number;
  silenceRemovedSec: number;
  nonRadiologyRemovedSec: number;
  keptSegmentsCount: number;
  droppedNonRadiologyCount: number;
  outputMimeType: string;
  decisionLatencyMs: number;
  usedDecision1: boolean;
  skippedReason?: string;
}> {
  throwIfAborted(options.abortSignal);
  options.onProgress?.('Decoding audio for silence analysis...');

  let decoded: { samples: Float32Array; sampleRate: number };
  try {
    decoded = await decodeBlobToMonoPcm(blob);
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('[AudioPrefilter] Audio decode failed; keeping original audio untouched:', err);
    return {
      blob,
      applied: false,
      originalDurationSec: 0,
      keptDurationSec: 0,
      afterVadDurationSec: 0,
      silenceRemovedSec: 0,
      nonRadiologyRemovedSec: 0,
      keptSegmentsCount: 0,
      droppedNonRadiologyCount: 0,
      outputMimeType: cleanMime,
      decisionLatencyMs: 0,
      usedDecision1: false,
      skippedReason: 'Web Audio decode unavailable or failed; kept original audio',
    };
  }

  throwIfAborted(options.abortSignal);
  const { samples, sampleRate } = decoded;
  const originalDurationSec = samples.length / sampleRate;

  options.onProgress?.('Removing extended silence via adaptive VAD...');
  const vad = detectSpeechIntervalsFromPcm(samples, sampleRate);

  if (vad.intervals.length === 0) {
    return {
      blob,
      applied: false,
      originalDurationSec,
      keptDurationSec: originalDurationSec,
      afterVadDurationSec: originalDurationSec,
      silenceRemovedSec: 0,
      nonRadiologyRemovedSec: 0,
      keptSegmentsCount: 0,
      droppedNonRadiologyCount: 0,
      outputMimeType: cleanMime,
      decisionLatencyMs: 0,
      usedDecision1: false,
      skippedReason: 'No speech above VAD threshold; kept original audio for safety',
    };
  }

  const windows = buildEvaluationWindows(vad.intervals);
  const afterVadDurationSec = vad.speechDurationSec;
  const silenceRemovedSec = vad.silenceRemovedSec;

  const decisionRes = options.useDecision1
    ? (options.onProgress?.('Filtering non-radiology chatter with Decision-1...'),
      await filterWindowsWithDecision1(windows, samples, sampleRate, {
        abortSignal: options.abortSignal,
        onProgress: options.onProgress,
      }))
    : {
        keptWindows: windows,
        droppedWindows: [],
        usedDecision1: false,
        decisionLatencyMs: 0,
        outcomes: [],
        fallbackReason: undefined,
      };

  const keptIntervals = decisionRes.keptWindows.flatMap((w) => w.intervals);
  const nonRadiologyRemovedSec = decisionRes.droppedWindows.reduce(
    (sum, w) => sum + w.speechDurationSec,
    0
  );
  const expectedKeptSpeechSec = Math.max(0, afterVadDurationSec - nonRadiologyRemovedSec);
  const trimmedRatio =
    originalDurationSec > 0 ? (originalDurationSec - expectedKeptSpeechSec) / originalDurationSec : 0;

  // Avoid unnecessary re-encoding or file inflation when savings are negligible on <=10MB files
  if (trimmedRatio < NEGLIGIBLE_SAVINGS_RATIO && blob.size <= SMALL_ORIGINAL_BYTES_LIMIT) {
    return {
      blob,
      applied: false,
      originalDurationSec,
      keptDurationSec: originalDurationSec,
      afterVadDurationSec,
      silenceRemovedSec: 0,
      nonRadiologyRemovedSec: 0,
      keptSegmentsCount: decisionRes.keptWindows.length,
      droppedNonRadiologyCount: 0,
      outputMimeType: cleanMime,
      decisionLatencyMs: decisionRes.decisionLatencyMs,
      usedDecision1: decisionRes.usedDecision1,
      skippedReason: 'Negligible trimming (<10%) and original <= 10MB; kept original audio',
    };
  }

  throwIfAborted(options.abortSignal);
  options.onProgress?.('Encoding compact filtered audio...');
  const concatenated = concatPcmIntervals(samples, sampleRate, keptIntervals);
  if (concatenated.length === 0) {
    return {
      blob,
      applied: false,
      originalDurationSec,
      keptDurationSec: originalDurationSec,
      afterVadDurationSec,
      silenceRemovedSec: 0,
      nonRadiologyRemovedSec: 0,
      keptSegmentsCount: windows.length,
      droppedNonRadiologyCount: 0,
      outputMimeType: cleanMime,
      decisionLatencyMs: decisionRes.decisionLatencyMs,
      usedDecision1: decisionRes.usedDecision1,
      skippedReason: 'Concatenated output empty; kept original audio',
    };
  }

  const encoded = await encodeCompactAudioBlob(concatenated, sampleRate, options.abortSignal);
  const outputDurationSec = concatenated.length / sampleRate;

  // Never inflate past original when WAV fallback exceeds safe Gemini inline limits or savings are negligible
  const isInflationUnsafe =
    encoded.blob.size > blob.size &&
    (trimmedRatio < NEGLIGIBLE_SAVINGS_RATIO ||
      (encoded.mimeType === 'audio/wav' && encoded.blob.size > SAFE_INLINE_WAV_BYTES_LIMIT));

  if (isInflationUnsafe) {
    return {
      blob,
      applied: false,
      originalDurationSec,
      keptDurationSec: originalDurationSec,
      afterVadDurationSec,
      silenceRemovedSec: 0,
      nonRadiologyRemovedSec: 0,
      keptSegmentsCount: decisionRes.keptWindows.length,
      droppedNonRadiologyCount: 0,
      outputMimeType: cleanMime,
      decisionLatencyMs: decisionRes.decisionLatencyMs,
      usedDecision1: decisionRes.usedDecision1,
      skippedReason: 'Encoded output would inflate payload without safe savings; kept original audio',
    };
  }

  return {
    blob: encoded.blob,
    applied: true,
    originalDurationSec,
    keptDurationSec: outputDurationSec,
    afterVadDurationSec,
    silenceRemovedSec,
    nonRadiologyRemovedSec,
    keptSegmentsCount: decisionRes.keptWindows.length,
    droppedNonRadiologyCount: decisionRes.droppedWindows.length,
    outputMimeType: encoded.mimeType,
    decisionLatencyMs: decisionRes.decisionLatencyMs,
    usedDecision1: decisionRes.usedDecision1,
    skippedReason: decisionRes.fallbackReason,
  };
}

export interface FilterAudioInputsResult {
  filteredInput: Blob | Blob[];
  stats: AudioPrefilterStats | null;
  compactedAudioBlob: Blob | null;
}

/** Extracts only genuine audio blobs from a single Blob or mixed attachment array. */
export async function extractAudioBlobs(input: Blob | Blob[] | null | undefined): Promise<Blob[]> {
  if (!input) return [];
  const items = Array.isArray(input) ? input : [input];
  const audioBlobs: Blob[] = [];
  for (const item of items) {
    if (!item || item.size === 0) continue;
    const classification = await classifyBlobForPrefilter(item);
    if (classification.isAudio) {
      audioBlobs.push(item);
    }
  }
  return audioBlobs;
}

/**
 * Combines one or more audio blobs into a single playable compacted audio Blob
 * (Ogg/Opus via WebCodecs when available, falling back to compact WAV).
 * Non-audio attachments are excluded automatically.
 */
export async function combineAudioBlobsToCompact(
  input: Blob | Blob[] | null | undefined,
  options?: { abortSignal?: AbortSignal }
): Promise<Blob | null> {
  const audioBlobs = await extractAudioBlobs(input);
  if (audioBlobs.length === 0) return null;
  if (audioBlobs.length === 1) return audioBlobs[0];

  throwIfAborted(options?.abortSignal);

  try {
    const decodedList = await Promise.all(audioBlobs.map((b) => decodeBlobToMonoPcm(b)));
    throwIfAborted(options?.abortSignal);

    const maxRate = decodedList.reduce((m, d) => Math.max(m, d.sampleRate), 16000);
    const targetRate = Math.max(16000, Math.min(OPUS_TARGET_SAMPLE_RATE, maxRate));
    const spacerSamples = Math.max(0, Math.round(INTER_SEGMENT_SPACER_SEC * targetRate));

    const resampled = decodedList.map((d) =>
      d.sampleRate === targetRate ? d.samples : resampleMonoPcm(d.samples, d.sampleRate, targetRate)
    );
    const totalLen = resampled.reduce(
      (sum, arr, idx) => sum + arr.length + (idx > 0 ? spacerSamples : 0),
      0
    );
    if (totalLen === 0) return audioBlobs[0];

    const combined = new Float32Array(totalLen);
    let offset = 0;
    for (let i = 0; i < resampled.length; i++) {
      if (i > 0) offset += spacerSamples;
      combined.set(resampled[i], offset);
      offset += resampled[i].length;
    }

    const encoded = await encodeCompactAudioBlob(combined, targetRate, options?.abortSignal);
    return encoded.blob;
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('[AudioPrefilter] Compact combination decode failed; falling back to standard merge:', err);
    return mergeMultipleAudioBlobs(audioBlobs);
  }
}

/**
 * Downloads the original unfiltered audio from a single Blob or mixed Blob[].
 * Skips non-audio attachments (PDF, DOCX, images) and merges multiple audio clips when needed.
 */
export async function downloadOriginalAudioInput(
  input: Blob | Blob[] | null | undefined,
  baseName = 'radiology-dictation'
): Promise<boolean> {
  if (!input) return false;
  let audioBlobs = await extractAudioBlobs(input);
  if (audioBlobs.length === 0) {
    const fallback = (Array.isArray(input) ? input : [input]).filter((b) => b && b.size > 0);
    if (fallback.length === 0) return false;
    audioBlobs = [fallback[0]];
  }
  const toDownload =
    audioBlobs.length === 1 ? audioBlobs[0] : await mergeMultipleAudioBlobs(audioBlobs);
  if (!toDownload || toDownload.size === 0) return false;
  triggerAudioDownload(toDownload, baseName);
  return true;
}

/** Downloads the compacted Decision-1 audio Blob with its proper extension. */
export function downloadCompactedAudioBlob(
  compactedBlob: Blob | null | undefined,
  baseName = 'radiology-dictation-compacted-decision1'
): boolean {
  if (!compactedBlob || compactedBlob.size === 0) return false;
  triggerAudioDownload(compactedBlob, baseName);
  return true;
}

/** Formats seconds into a compact human-readable duration for pre-filter stats badges. */
export function formatPrefilterDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec < 60) {
    return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
  }
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return remSec === 60 ? `${mins + 1}m 0s` : `${mins}m ${remSec}s`;
}

/** Builds a concise summary of removed silence and non-radiology chatter for badges. */
export function formatPrefilterRemovedSummary(stats: AudioPrefilterStats): string {
  const removedParts: string[] = [];
  if (stats.silenceRemovedSec > 0) {
    removedParts.push(`-${formatPrefilterDuration(stats.silenceRemovedSec)} silence`);
  }
  if (stats.nonRadiologyRemovedSec > 0) {
    removedParts.push(`-${formatPrefilterDuration(stats.nonRadiologyRemovedSec)} chatter`);
  }
  return removedParts.length > 0 ? ` (${removedParts.join(', ')})` : '';
}

/** Combines pre-filter telemetry when continuation dictations are appended. */
export function mergePrefilterStats(
  prev: AudioPrefilterStats | null | undefined,
  next: AudioPrefilterStats | null
): AudioPrefilterStats | null {
  if (!next?.applied) return prev ?? null;
  if (!prev?.applied) return next;
  const mimes = Array.from(new Set([prev.outputMimeType, next.outputMimeType].filter(Boolean)));
  return {
    applied: true,
    originalDurationSec: Number((prev.originalDurationSec + next.originalDurationSec).toFixed(3)),
    keptDurationSec: Number((prev.keptDurationSec + next.keptDurationSec).toFixed(3)),
    afterVadDurationSec: Number((prev.afterVadDurationSec + next.afterVadDurationSec).toFixed(3)),
    silenceRemovedSec: Number((prev.silenceRemovedSec + next.silenceRemovedSec).toFixed(3)),
    nonRadiologyRemovedSec: Number((prev.nonRadiologyRemovedSec + next.nonRadiologyRemovedSec).toFixed(3)),
    keptSegmentsCount: prev.keptSegmentsCount + next.keptSegmentsCount,
    droppedNonRadiologyCount: prev.droppedNonRadiologyCount + next.droppedNonRadiologyCount,
    originalBytes: prev.originalBytes + next.originalBytes,
    outputBytes: prev.outputBytes + next.outputBytes,
    outputMimeType: mimes.join(', '),
    decisionLatencyMs: prev.decisionLatencyMs + next.decisionLatencyMs,
    usedDecision1: prev.usedDecision1 || next.usedDecision1,
  };
}

/**
 * Main experimental pre-filter entry point.
 * When `options.enabled` is false, returns `{ filteredInput: input, stats: null, compactedAudioBlob: null }`
 * immediately with zero processing. Non-audio blobs (PDF, DOCX, DOC, RTF, TXT, images, videos) are
 * returned unchanged at their exact original positions.
 */
export async function filterAudioInputsForModel(
  input: Blob | Blob[],
  options: FilterAudioInputsOptions
): Promise<FilterAudioInputsResult> {
  if (!options.enabled) {
    return { filteredInput: input, stats: null, compactedAudioBlob: null };
  }

  throwIfAborted(options.abortSignal);

  const isArray = Array.isArray(input);
  const items = isArray ? input : [input];
  const originalBytes = items.reduce((sum, b) => sum + (b ? b.size : 0), 0);

  if (items.length === 0) {
    return {
      filteredInput: input,
      stats: {
        applied: false,
        originalDurationSec: 0,
        keptDurationSec: 0,
        afterVadDurationSec: 0,
        silenceRemovedSec: 0,
        nonRadiologyRemovedSec: 0,
        keptSegmentsCount: 0,
        droppedNonRadiologyCount: 0,
        originalBytes: 0,
        outputBytes: 0,
        outputMimeType: 'application/octet-stream',
        decisionLatencyMs: 0,
        usedDecision1: false,
        skippedReason: 'No input blobs provided',
      },
      compactedAudioBlob: null,
    };
  }

  const outputItems: Blob[] = new Array(items.length);
  const filteredAudioBlobs: Blob[] = [];
  let audioCount = 0;
  let anyApplied = false;
  let anyUsedDecision1 = false;
  let totalOriginalDurationSec = 0;
  let totalKeptDurationSec = 0;
  let totalAfterVadDurationSec = 0;
  let totalSilenceRemovedSec = 0;
  let totalNonRadiologyRemovedSec = 0;
  let totalKeptSegmentsCount = 0;
  let totalDroppedNonRadiologyCount = 0;
  let totalDecisionLatencyMs = 0;
  const outputMimes = new Set<string>();
  const skipReasons: string[] = [];

  for (let i = 0; i < items.length; i++) {
    throwIfAborted(options.abortSignal);
    const item = items[i];
    if (!item || item.size === 0) {
      outputItems[i] = item;
      continue;
    }

    const classification = await classifyBlobForPrefilter(item);
    if (!classification.isAudio) {
      // Strictly preserve PDF, DOCX, TXT, image, and video blobs unchanged at exact index
      outputItems[i] = item;
      continue;
    }

    audioCount++;
    const res = await prefilterSingleAudioBlob(item, classification.mimeType, {
      useDecision1: Boolean(options.useDecision1),
      abortSignal: options.abortSignal,
      onProgress: options.onProgress,
    });

    outputItems[i] = res.blob;
    filteredAudioBlobs.push(res.blob);
    if (res.applied) anyApplied = true;
    if (res.usedDecision1) anyUsedDecision1 = true;
    totalOriginalDurationSec += res.originalDurationSec;
    totalKeptDurationSec += res.keptDurationSec;
    totalAfterVadDurationSec += res.afterVadDurationSec;
    totalSilenceRemovedSec += res.silenceRemovedSec;
    totalNonRadiologyRemovedSec += res.nonRadiologyRemovedSec;
    totalKeptSegmentsCount += res.keptSegmentsCount;
    totalDroppedNonRadiologyCount += res.droppedNonRadiologyCount;
    totalDecisionLatencyMs += res.decisionLatencyMs;
    outputMimes.add(res.outputMimeType);
    if (res.skippedReason) {
      skipReasons.push(res.skippedReason);
    }
  }

  const outputBytes = outputItems.reduce((sum, b) => sum + (b ? b.size : 0), 0);

  if (audioCount === 0) {
    return {
      filteredInput: input,
      stats: {
        applied: false,
        originalDurationSec: 0,
        keptDurationSec: 0,
        afterVadDurationSec: 0,
        silenceRemovedSec: 0,
        nonRadiologyRemovedSec: 0,
        keptSegmentsCount: 0,
        droppedNonRadiologyCount: 0,
        originalBytes,
        outputBytes: originalBytes,
        outputMimeType: items[0]?.type || 'application/octet-stream',
        decisionLatencyMs: 0,
        usedDecision1: false,
        skippedReason: 'No genuine audio inputs detected',
      },
      compactedAudioBlob: null,
    };
  }

  let compactedAudioBlob: Blob | null = null;
  if (anyApplied) {
    compactedAudioBlob =
      filteredAudioBlobs.length === 1
        ? filteredAudioBlobs[0]
        : await combineAudioBlobsToCompact(filteredAudioBlobs, {
            abortSignal: options.abortSignal,
          });
  }

  const resolvedMimeType = compactedAudioBlob?.type
    ? compactedAudioBlob.type
    : outputMimes.size === 1
    ? Array.from(outputMimes)[0]
    : outputMimes.size > 1
    ? Array.from(outputMimes).join(', ')
    : 'audio/ogg';

  return {
    filteredInput: isArray ? outputItems : outputItems[0],
    compactedAudioBlob,
    stats: {
      applied: anyApplied,
      originalDurationSec: Number(totalOriginalDurationSec.toFixed(3)),
      keptDurationSec: Number(totalKeptDurationSec.toFixed(3)),
      afterVadDurationSec: Number(totalAfterVadDurationSec.toFixed(3)),
      silenceRemovedSec: Number(totalSilenceRemovedSec.toFixed(3)),
      nonRadiologyRemovedSec: Number(totalNonRadiologyRemovedSec.toFixed(3)),
      keptSegmentsCount: totalKeptSegmentsCount,
      droppedNonRadiologyCount: totalDroppedNonRadiologyCount,
      originalBytes,
      outputBytes: compactedAudioBlob && filteredAudioBlobs.length > 1 ? compactedAudioBlob.size : outputBytes,
      outputMimeType: resolvedMimeType,
      decisionLatencyMs: totalDecisionLatencyMs,
      usedDecision1: anyUsedDecision1,
      skippedReason: !anyApplied && skipReasons.length > 0 ? skipReasons[0] : undefined,
    },
  };
}
