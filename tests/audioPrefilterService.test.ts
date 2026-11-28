import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  EXPERIMENTAL_AUDIO_FILTER_KEY,
  classifyBlobForPrefilter,
  detectAudioMimeFromHeader,
  detectSpeechIntervalsFromPcm,
  buildEvaluationWindows,
  concatPcmIntervals,
  shouldDiscardDecisionSegment,
  groupWindowsIntoDecisionBatches,
  buildDecisionBatchPayload,
  filterWindowsWithDecision1,
  muxOpusPacketsToOgg,
  encodePcmToWavBytes,
  filterAudioInputsForModel,
  extractAudioBlobs,
  combineAudioBlobsToCompact,
  downloadOriginalAudioInput,
  downloadCompactedAudioBlob,
  mergePrefilterStats,
  type SpeechInterval,
} from '../services/audioPrefilterService';
import { safeLocalStorage } from '../services/storageService';
import {
  AVAILABLE_MODELS,
  DEFAULT_SELECTED_MODEL,
  FREE_TIER_MEDIUM_MODELS,
  GEMINI_FLASH_LITE_MODEL,
  LIVE_DICTATION_MODELS,
  ROBOTICS_QUALITY_DIRECTIVES,
  getFreeTierModelFallbackChain,
  getLiveModelFallbackChain,
  getModelDisplayLabel,
  getOptimalThinkingLevel,
  resolveQuotaPoolModel,
} from '../constants';
import {
  MODEL_FAILOVER_EVENT,
  clearAllModelUnavailableCooldowns,
  clearModelTemporarilyUnavailable,
  executeWithApiKeyFailover,
  getCandidateKeysForOperation,
  getOverloadedModelStates,
  getTotalActiveApiKeyCount,
  isModelTemporarilyUnavailable,
  isNetworkFetchError,
  isRetryTopTierAllKeysOn503Enabled,
  lockBuiltinKeys,
  markModelTemporarilyUnavailable,
  resetApiKeyHealthState,
  setMediumProsePolishEnabled,
  setModelFallbackPolicy,
  setRetryTopTierAllKeysOn503Enabled,
  setUserApiKeys,
  unlockBuiltinKeys,
} from '../services/apiKeyService';
import {
  deleteUploadedFile,
  generateContentWithJsonFallback,
  generateContentWithJsonFallbackMeta,
  processAudio,
  runClinicalQaErrorCheck,
  uploadBlobViaFilesApi,
  waitForUploadedFileActive,
} from '../services/geminiService';
import {
  deleteDictateChangesAudio,
  getDictateChangesAudio,
  hasStoredDictateChangesAudio,
  saveDictateChangesAudio,
} from '../services/audioStorage';
import {
  LIVE_CHUNK_MAX_SEC,
  LIVE_CHUNK_MIN_SPEECH_SEC,
  LIVE_CHUNK_SILENCE_MS,
} from '../hooks/useLiveSession';

function makeSineBurst(sampleRate: number, durationSec: number, amplitude: number, freqHz = 320): Float32Array {
  const len = Math.round(sampleRate * durationSec);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function makeNoise(sampleRate: number, durationSec: number, amplitude: number): Float32Array {
  const len = Math.round(sampleRate * durationSec);
  const out = new Float32Array(len);
  let seed = 1337;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const u = (seed / 0xffffffff) * 2 - 1;
    out[i] = u * amplitude;
  }
  return out;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

test('storageService validateAndCleanStorage cleans corrupted experimental audio filter key', () => {
  const store = new Map<string, string>();
  const mockLocalStorage = {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, val: string) {
      store.set(key, String(val));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };

  const prevWindow = (globalThis as any).window;
  (globalThis as any).window = { localStorage: mockLocalStorage };
  try {
    store.set(EXPERIMENTAL_AUDIO_FILTER_KEY, '{corrupt_json');
    store.set('radiologyErrorCheckEnabled', 'true');
    safeLocalStorage.validateAndCleanStorage();
    assert.equal(store.has(EXPERIMENTAL_AUDIO_FILTER_KEY), false);
    assert.equal(store.get('radiologyErrorCheckEnabled'), 'true');

    store.set(EXPERIMENTAL_AUDIO_FILTER_KEY, 'true');
    safeLocalStorage.validateAndCleanStorage();
    assert.equal(store.get(EXPERIMENTAL_AUDIO_FILTER_KEY), 'true');
  } finally {
    (globalThis as any).window = prevWindow;
  }
});

test('filterAudioInputsForModel immediately no-ops when disabled', async () => {
  const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
  const resSingle = await filterAudioInputsForModel(audio, { enabled: false });
  assert.equal(resSingle.filteredInput, audio);
  assert.equal(resSingle.stats, null);

  const list = [audio, new Blob(['hello'], { type: 'text/plain' })];
  const resArr = await filterAudioInputsForModel(list, { enabled: false });
  assert.equal(resArr.filteredInput, list);
  assert.equal(resArr.stats, null);
});

test('strict non-audio safety protects PDF, DOCX, DOC, RTF, TXT, images, and videos', async () => {
  const makeNamedBlob = (bytes: Uint8Array | string, name: string, type = '') => {
    const b = new Blob([bytes as any], { type });
    Object.defineProperty(b, 'name', { value: name });
    return b;
  };

  // PDF by extension, MIME, and magic bytes even when octet-stream
  const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob(pdfMagic, 'report.pdf', ''))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(new Blob([pdfMagic], { type: 'application/octet-stream' }))).isAudio, false);

  // DOCX (PK ZIP magic) and DOC (OLE2 magic) and RTF
  const docxMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const docMagic = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const rtfMagic = new Uint8Array([0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31]);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob(docxMagic, 'scan.docx', ''))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(new Blob([docxMagic], { type: 'application/octet-stream' }))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob(docMagic, 'scan.doc', ''))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob(rtfMagic, 'note.rtf', ''))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob('Findings: normal', 'notes.txt', ''))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob('{"a":1}', 'meta.json', ''))).isAudio, false);

  // Images (including RIFF....WEBP which shares RIFF prefix with WAV)
  const webpMagic = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  assert.equal((await classifyBlobForPrefilter(new Blob([webpMagic], { type: '' }))).isAudio, false);
  assert.equal(await detectAudioMimeFromHeader(new Blob([webpMagic])), null);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'xray.png', 'image/png'))).isAudio, false);

  // Videos (including WebM with V_VP9 track vs audio-only WebM with A_OPUS)
  const ebmlVideo = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01,
    ...Buffer.from('V_VP9', 'ascii'),
  ]);
  const ebmlAudioOnly = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01,
    ...Buffer.from('A_OPUS', 'ascii'),
  ]);
  assert.equal((await classifyBlobForPrefilter(new Blob([ebmlVideo], { type: 'video/webm' }))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob(ebmlVideo, 'screen.webm', ''))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(new Blob([ebmlAudioOnly], { type: 'video/webm' }))).isAudio, true);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob(ebmlAudioOnly, 'dictation.webm', ''))).isAudio, true);
  assert.equal((await classifyBlobForPrefilter(makeNamedBlob(new Uint8Array(16), 'cine.mp4', ''))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(new Blob([new Uint8Array(16)], { type: 'video/mp4' }))).isAudio, false);
  assert.equal((await classifyBlobForPrefilter(new Blob([new Uint8Array([0xff, 0xfe, 0x41, 0x00])], { type: 'application/octet-stream' }))).isAudio, false);

  // Genuine WAV detected via header even when type is octet-stream
  const wavBlob = new Blob([encodePcmToWavBytes(makeSineBurst(16000, 0.2, 0.2), 16000)], {
    type: 'application/octet-stream',
  });
  const wavClass = await classifyBlobForPrefilter(wavBlob);
  assert.equal(wavClass.isAudio, true);
  assert.equal(wavClass.mimeType, 'audio/wav');

  // Mixed array preserves exact non-audio references at exact indices
  const pdfRef = makeNamedBlob(pdfMagic, 'referral.pdf', 'application/pdf');
  const docxRef = makeNamedBlob(docxMagic, 'template.docx');
  const txtRef = new Blob(['history'], { type: 'text/plain' });
  const imgRef = makeNamedBlob(webpMagic, 'ct.webp', 'image/webp');
  const mixedRes = await filterAudioInputsForModel([pdfRef, docxRef, txtRef, imgRef], { enabled: true });
  assert.equal(Array.isArray(mixedRes.filteredInput), true);
  const outArr = mixedRes.filteredInput as Blob[];
  assert.equal(outArr[0], pdfRef);
  assert.equal(outArr[1], docxRef);
  assert.equal(outArr[2], txtRef);
  assert.equal(outArr[3], imgRef);
  assert.equal(mixedRes.stats?.applied, false);
  assert.equal(mixedRes.stats?.skippedReason, 'No genuine audio inputs detected');
});

test('DSP VAD detects speech intervals, rejects short clicks, bridges <950ms pauses, and pads 180ms margins', () => {
  const sr = 16000;
  // Pure silence -> 0 intervals
  const silent = new Float32Array(sr * 2);
  const silentRes = detectSpeechIntervalsFromPcm(silent, sr);
  assert.equal(silentRes.intervals.length, 0);

  // Build: 1.5s silence + 1.0s speech + 0.7s short pause (<950ms, should merge) + 1.0s speech
  //        + 1.8s long pause (>=950ms, should split) + 1.2s speech + 1.5s silence
  const click = new Float32Array(Math.round(sr * 0.015)); // 15ms transient (<2 frames)
  click.fill(0.015);
  const noiseAt0_4s = makeNoise(sr, 0.4, 0.001);
  const pcm = concatFloat32([
    noiseAt0_4s,
    click,
    makeNoise(sr, 1.085, 0.001),
    makeSineBurst(sr, 1.0, 0.12),   // speech 1: ~1.5s..2.5s
    makeNoise(sr, 0.7, 0.001),      // 700ms pause (<950ms)
    makeSineBurst(sr, 1.0, 0.10),   // speech 2: ~3.2s..4.2s (merged with speech 1)
    makeNoise(sr, 1.8, 0.001),      // 1800ms pause (>=950ms)
    makeSineBurst(sr, 1.2, 0.11),   // speech 3: ~6.0s..7.2s
    makeNoise(sr, 1.5, 0.001),
  ]);

  const vad = detectSpeechIntervalsFromPcm(pcm, sr);
  assert.equal(vad.intervals.length, 2);
  // First interval covers ~1.5s..4.2s with 180ms padding -> ~1.32s..4.38s
  assert.ok(vad.intervals[0].startSec <= 1.36 && vad.intervals[0].startSec >= 1.25);
  assert.ok(vad.intervals[0].endSec >= 4.34 && vad.intervals[0].endSec <= 4.45);
  // Second interval covers ~6.0s..7.2s with 180ms padding -> ~5.82s..7.38s
  assert.ok(vad.intervals[1].startSec <= 5.86 && vad.intervals[1].startSec >= 5.75);
  assert.ok(vad.intervals[1].endSec >= 7.34 && vad.intervals[1].endSec <= 7.45);
  assert.ok(vad.silenceRemovedSec > 3.5);

  // Concatenation inserts 120ms silence spacer between the 2 intervals
  const stitched = concatPcmIntervals(pcm, sr, vad.intervals);
  const expectedSamples =
    Math.round(vad.intervals[0].durationSec * sr) +
    Math.round(vad.intervals[1].durationSec * sr) +
    Math.round(0.12 * sr);
  assert.ok(Math.abs(stitched.length - expectedSamples) <= 4);
});

test('DSP VAD handles elevated noise floor and faint speech in long silence', () => {
  const sr = 16000;
  // 10s of steady 0.004 noise + 1.5s speech at 0.08 amplitude
  const pcm = concatFloat32([
    makeNoise(sr, 5.0, 0.004),
    makeSineBurst(sr, 1.5, 0.08),
    makeNoise(sr, 5.0, 0.004),
  ]);
  const vad = detectSpeechIntervalsFromPcm(pcm, sr);
  assert.equal(vad.intervals.length, 1);
  assert.ok(vad.adaptiveThresholdRms >= 0.0079);
  assert.ok(vad.intervals[0].durationSec >= 1.7 && vad.intervals[0].durationSec <= 2.1);
});

test('buildEvaluationWindows groups gaps <= 2.5s targeting ~8-25s and splits > 2.5s or > 25s', () => {
  const intervals: SpeechInterval[] = [
    { startSec: 0, endSec: 5, durationSec: 5, peakRms: 0.1, meanRms: 0.05 },
    { startSec: 6.5, endSec: 12.5, durationSec: 6, peakRms: 0.1, meanRms: 0.05 },   // gap 1.5s -> merge (11s)
    { startSec: 14.0, endSec: 26.0, durationSec: 12, peakRms: 0.1, meanRms: 0.05 }, // gap 1.5s -> merge (23s <= 25s)
    { startSec: 27.0, endSec: 34.0, durationSec: 7, peakRms: 0.1, meanRms: 0.05 },  // gap 1.0s, but 23+7=30 > 25 -> split
    { startSec: 38.0, endSec: 41.0, durationSec: 3, peakRms: 0.1, meanRms: 0.05 },  // gap 4.0s (>2.5s) -> split
  ];
  const windows = buildEvaluationWindows(intervals);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].intervals.length, 3);
  assert.equal(windows[0].speechDurationSec, 23);
  assert.equal(windows[1].intervals.length, 1);
  assert.equal(windows[1].speechDurationSec, 7);
  assert.equal(windows[2].intervals.length, 1);
  assert.equal(windows[2].speechDurationSec, 3);
});

test('Decision-1 gating logic: threshold, short skip, batching, 100%-drop guard, and error fallback', async () => {
  // Conservative clinical recall threshold: discard ONLY if noul < 0.25 && confidence >= 0.70
  assert.equal(shouldDiscardDecisionSegment(0.10, 0.85), true);
  assert.equal(shouldDiscardDecisionSegment(0.249, 0.70), true);
  assert.equal(shouldDiscardDecisionSegment(0.10, 0.69), false);
  assert.equal(shouldDiscardDecisionSegment(0.25, 0.99), false);
  assert.equal(shouldDiscardDecisionSegment(0.55, 0.90), false);
  assert.equal(shouldDiscardDecisionSegment(NaN, 0.99), false);

  const sr = 16000;
  const pcm = makeSineBurst(sr, 40, 0.1);

  // 1) Short speech (<=5s) skips Decision-1
  const shortWin = buildEvaluationWindows([
    { startSec: 0, endSec: 2, durationSec: 2, peakRms: 0.1, meanRms: 0.05 },
    { startSec: 6, endSec: 8, durationSec: 2, peakRms: 0.1, meanRms: 0.05 },
  ]);
  let called = 0;
  const shortRes = await filterWindowsWithDecision1(shortWin, pcm, sr, {
    callDecisionsFn: async () => {
      called++;
      return {};
    },
  });
  assert.equal(shortRes.usedDecision1, false);
  assert.equal(called, 0);
  assert.equal(shortRes.keptWindows.length, 2);

  // 2) Batching respects max 6 segments AND max ~90s per request
  const sevenWindows = buildEvaluationWindows(
    Array.from({ length: 7 }, (_, i) => ({
      startSec: i * 10,
      endSec: i * 10 + 4,
      durationSec: 4,
      peakRms: 0.1,
      meanRms: 0.05,
    }))
  );
  const batches = groupWindowsIntoDecisionBatches(sevenWindows);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 6);
  assert.equal(batches[1].length, 1);

  const payload = buildDecisionBatchPayload([
    { window: sevenWindows[0], wavBase64: 'QUJD' },
    { window: sevenWindows[1], wavBase64: 'REVG' },
  ]);
  assert.equal(payload.model, 'gemini-decision-1');
  assert.equal(payload.questions.seg_1.type, 'noul');
  assert.equal(payload.questions.seg_2.type, 'noul');
  assert.ok(payload.input.some((item) => item.type === 'text' && item.text === '[Segment 1]\n'));
  assert.ok(payload.input.some((item) => item.type === 'audio' && item.mime_type === 'audio/wav' && item.data === 'QUJD'));

  // 3) Selective drop keeps clinical dictation and drops confident office chatter
  const twoBatchRes = await filterWindowsWithDecision1(sevenWindows, pcm, sr, {
    batchSpacingMs: 0,
    callDecisionsFn: async (req) => {
      const qCount = Object.keys(req.questions).length;
      if (qCount === 6) {
        return {
          answers: {
            seg_1: { noul: 0.92, confidence: 0.92 }, // keep
            seg_2: { noul: 0.10, confidence: 0.88 }, // discard
            seg_3: { noul: 0.15, confidence: 0.60 }, // keep (low confidence)
            seg_4: { noul: 0.25, confidence: 0.95 }, // keep (threshold boundary)
            seg_5: { noul: 0.80, confidence: 0.80 }, // keep
            seg_6: { noul: 0.05, confidence: 0.95 }, // discard
          },
        };
      }
      return {
        answers: {
          seg_1: { noul: 0.78, confidence: 0.85 }, // keep
        },
      };
    },
  });
  assert.equal(twoBatchRes.usedDecision1, true);
  assert.deepEqual(
    twoBatchRes.keptWindows.map((w) => w.index),
    [0, 2, 3, 4, 6]
  );
  assert.deepEqual(
    twoBatchRes.droppedWindows.map((w) => w.index),
    [1, 5]
  );

  // 4) 100%-drop safety fallback keeps all windows
  const twoWins = sevenWindows.slice(0, 2);
  const allDropRes = await filterWindowsWithDecision1(twoWins, pcm, sr, {
    batchSpacingMs: 0,
    callDecisionsFn: async () => ({
      answers: {
        seg_1: { noul: 0.02, confidence: 0.99 },
        seg_2: { noul: 0.03, confidence: 0.99 },
      },
    }),
  });
  assert.equal(allDropRes.keptWindows.length, 2);
  assert.equal(allDropRes.droppedWindows.length, 0);

  // 5) API/quota error trips circuit breaker fast and falls back gracefully to VAD-trimmed windows
  let errCalls = 0;
  const errRes = await filterWindowsWithDecision1(sevenWindows, pcm, sr, {
    batchSpacingMs: 0,
    concurrency: 1,
    callDecisionsFn: async () => {
      errCalls++;
      throw new Error('429 RESOURCE_EXHAUSTED');
    },
  });
  assert.equal(errRes.usedDecision1, false);
  assert.equal(errRes.keptWindows.length, 7);
  assert.equal(errCalls, 1); // 2nd batch skipped immediately after 429 circuit trip

  // 6) Parallel execution runs concurrent batches and keeps deterministic sorted outcomes
  const manyWindows = buildEvaluationWindows(
    Array.from({ length: 18 }, (_, i) => ({
      startSec: i * 10,
      endSec: i * 10 + 4,
      durationSec: 4,
      peakRms: 0.1,
      meanRms: 0.05,
    }))
  );
  let activeInFlight = 0;
  let peakInFlight = 0;
  const parallelRes = await filterWindowsWithDecision1(manyWindows, pcm, sr, {
    concurrency: 3,
    callDecisionsFn: async (req) => {
      activeInFlight++;
      if (activeInFlight > peakInFlight) peakInFlight = activeInFlight;
      await new Promise((r) => setTimeout(r, 20));
      activeInFlight--;
      const qCount = Object.keys(req.questions).length;
      const answers: Record<string, { noul: number; confidence: number }> = {};
      for (let i = 1; i <= qCount; i++) {
        // Verify compact 8kHz WAV fallback was used without WebCodecs
        assert.equal((req.input.find((p) => p.type === 'audio') as any)?.mime_type, 'audio/wav');
        answers[`seg_${i}`] = i === 2 ? { noul: 0.05, confidence: 0.95 } : { noul: 0.95, confidence: 0.95 };
      }
      return { answers };
    },
  });
  assert.equal(peakInFlight, 3);
  assert.equal(parallelRes.usedDecision1, true);
  assert.equal(parallelRes.droppedWindows.length, 3); // seg_2 dropped in each of 3 batches
  assert.deepEqual(
    parallelRes.outcomes.map((o) => o.windowIndex),
    manyWindows.map((w) => w.index)
  );
});

test('muxOpusPacketsToOgg produces valid Ogg/Opus pages and passes ffprobe/ffmpeg when available', () => {
  // Structural unit test with synthetic >255 and exact-255 packet lengths
  const pktExact255 = new Uint8Array(255).fill(0x78); // TOC=0x78 (20ms SILK)
  const pktLong300 = new Uint8Array(300).fill(0x78);
  const oggBytes = muxOpusPacketsToOgg(
    [
      { data: pktExact255, durationSamples48k: 960 },
      { data: pktLong300, durationSamples48k: 960 },
    ],
    312
  );

  // Verify OggS magic, OpusHead, OpusTags, BOS, EOS
  assert.equal(Buffer.from(oggBytes.subarray(0, 4)).toString('ascii'), 'OggS');
  assert.equal(oggBytes[5], 0x02); // BOS
  assert.equal(Buffer.from(oggBytes.subarray(28, 36)).toString('ascii'), 'OpusHead');
  assert.ok(Buffer.from(oggBytes).includes(Buffer.from('OpusTags', 'ascii')));

  // Verify exact-255 lacing rule on page 2 ([255, 0, 255, 45])
  const tagsPageIdx = Buffer.from(oggBytes).indexOf(Buffer.from('OggS', 'ascii'), 4);
  const audioPageIdx = Buffer.from(oggBytes).indexOf(Buffer.from('OggS', 'ascii'), tagsPageIdx + 4);
  assert.ok(audioPageIdx > tagsPageIdx);
  assert.equal(oggBytes[audioPageIdx + 5], 0x04); // EOS on final page
  assert.equal(oggBytes[audioPageIdx + 26], 4); // 4 lacing entries
  assert.deepEqual(
    Array.from(oggBytes.subarray(audioPageIdx + 27, audioPageIdx + 31)),
    [255, 0, 255, 45]
  );

  // If ffmpeg & ffprobe are installed, generate real Opus packets, remux via muxOpusPacketsToOgg, and validate!
  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
  if (hasFfmpeg && hasFfprobe) {
    // Generate 1 second of 48kHz mono Opus inside Ogg via ffmpeg, extract raw Opus packets, and re-mux with muxOpusPacketsToOgg
    const gen = spawnSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000:duration=1.0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-f', 'ogg',
      'pipe:1',
    ]);
    assert.equal(gen.status, 0);
    const srcOgg = new Uint8Array(gen.stdout);
    const rawOpusPackets: Array<{ data: Uint8Array; durationSamples48k: number }> = [];

    // Parse source Ogg pages past OpusHead and OpusTags to extract raw Opus frames
    let pos = 0;
    let pageNum = 0;
    while (pos + 27 <= srcOgg.length) {
      assert.equal(Buffer.from(srcOgg.subarray(pos, pos + 4)).toString('ascii'), 'OggS');
      const segCount = srcOgg[pos + 26];
      const lacing = srcOgg.subarray(pos + 27, pos + 27 + segCount);
      let dataOff = pos + 27 + segCount;
      let pktLen = 0;
      for (let i = 0; i < lacing.length; i++) {
        pktLen += lacing[i];
        if (lacing[i] < 255) {
          const pkt = srcOgg.slice(dataOff, dataOff + pktLen);
          dataOff += pktLen;
          pktLen = 0;
          if (pageNum >= 2) {
            rawOpusPackets.push({ data: pkt, durationSamples48k: 960 });
          }
        }
      }
      pos = dataOff;
      pageNum++;
    }

    assert.ok(rawOpusPackets.length >= 40);
    const remuxed = muxOpusPacketsToOgg(rawOpusPackets, 312);

    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=format_name,probe_score:stream=codec_name,sample_rate,channels', '-of', 'json', 'pipe:0'],
      { input: Buffer.from(remuxed) }
    );
    assert.equal(probe.status, 0, probe.stderr?.toString());
    const parsed = JSON.parse(probe.stdout.toString('utf8'));
    assert.equal(parsed.format.format_name, 'ogg');
    assert.equal(parsed.format.probe_score, 100);
    assert.equal(parsed.streams[0].codec_name, 'opus');
    assert.equal(parsed.streams[0].sample_rate, '48000');
    assert.equal(parsed.streams[0].channels, 1);

    const decodeCheck = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], {
      input: Buffer.from(remuxed),
    });
    assert.equal(decodeCheck.status, 0, decodeCheck.stderr?.toString());
  }
});

test('filterAudioInputsForModel end-to-end with mocked AudioContext trims silence and preserves non-audio siblings', async () => {
  const sr = 16000;
  // 4s silence + 2s speech + 4s silence = 10s total (only ~2s speech -> 80% silence trimmed, skips Decision-1)
  const pcmWithSilence = concatFloat32([
    new Float32Array(sr * 4),
    makeSineBurst(sr, 2.0, 0.15),
    new Float32Array(sr * 4),
  ]);
  const wavBlob = new Blob([encodePcmToWavBytes(pcmWithSilence, sr)], { type: 'audio/wav' });
  const pdfBlob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });

  let closed = false;
  const prevWindow = (globalThis as any).window;
  (globalThis as any).window = {
    AudioContext: class MockAudioContext {
      state = 'running';
      async decodeAudioData() {
        return {
          sampleRate: sr,
          numberOfChannels: 1,
          length: pcmWithSilence.length,
          getChannelData() {
            return pcmWithSilence;
          },
        };
      }
      async close() {
        this.state = 'closed';
        closed = true;
      }
    },
  };

  try {
    const res = await filterAudioInputsForModel([pdfBlob, wavBlob], { enabled: true });
    assert.equal(closed, true);
    assert.ok(Array.isArray(res.filteredInput));
    const out = res.filteredInput as Blob[];
    assert.equal(out[0], pdfBlob); // PDF untouched
    assert.notEqual(out[1], wavBlob); // WAV trimmed
    assert.ok(out[1].size < wavBlob.size * 0.5);
    assert.equal(res.stats?.applied, true);
    assert.equal(res.stats?.usedDecision1, false);
    assert.ok(res.compactedAudioBlob instanceof Blob);
    assert.equal(res.compactedAudioBlob, out[1]);
    assert.ok((res.stats?.silenceRemovedSec ?? 0) >= 7.0);
    assert.ok((res.stats?.keptDurationSec ?? 0) <= 2.6);

    // Negligible savings (<10% trimmed) on <=10MB file keeps original blob untouched
    const mostlySpeech = makeSineBurst(sr, 4.0, 0.15);
    const fullSpeechWav = new Blob([encodePcmToWavBytes(mostlySpeech, sr)], { type: 'audio/wav' });
    (globalThis as any).window.AudioContext = class MockFullSpeechCtx {
      state = 'running';
      async decodeAudioData() {
        return {
          sampleRate: sr,
          numberOfChannels: 1,
          length: mostlySpeech.length,
          getChannelData: () => mostlySpeech,
        };
      }
      async close() {
        this.state = 'closed';
      }
    };
    const noTrimRes = await filterAudioInputsForModel(fullSpeechWav, { enabled: true });
    assert.equal(noTrimRes.filteredInput, fullSpeechWav);
    assert.equal(noTrimRes.stats?.applied, false);
    assert.equal(noTrimRes.compactedAudioBlob, null);

    // Decode failure gracefully returns original blob without crashing
    (globalThis as any).window.AudioContext = class MockFailingCtx {
      state = 'running';
      async decodeAudioData() {
        throw new Error('DOMException: Unable to decode audio data');
      }
      async close() {
        this.state = 'closed';
      }
    };
    const errRes = await filterAudioInputsForModel(fullSpeechWav, { enabled: true });
    assert.equal(errRes.filteredInput, fullSpeechWav);
    assert.equal(errRes.stats?.applied, false);
    assert.equal(errRes.compactedAudioBlob, null);
  } finally {
    (globalThis as any).window = prevWindow;
  }
});

test('filterAudioInputsForModel combines multi-audio inputs and downloads original + compacted cleanly', async () => {
  const sr = 16000;
  const pcmWithSilence = concatFloat32([
    new Float32Array(sr * 3),
    makeSineBurst(sr, 2.0, 0.15),
    new Float32Array(sr * 3),
  ]);
  const wav1 = new Blob([encodePcmToWavBytes(pcmWithSilence, sr)], { type: 'audio/wav' });
  const wav2 = new Blob([encodePcmToWavBytes(pcmWithSilence, sr)], { type: 'audio/wav' });
  const pdfBlob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });

  const extracted = await extractAudioBlobs([pdfBlob, wav1, wav2]);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0], wav1);
  assert.equal(extracted[1], wav2);

  const downloads: Array<{ filename: string; mimeType: string; size: number }> = [];
  const prevWindow = (globalThis as any).window;
  const prevDoc = (globalThis as any).document;
  const prevCreateUrl = URL.createObjectURL;
  const prevRevokeUrl = URL.revokeObjectURL;

  (globalThis as any).window = {
    AudioContext: class MockMultiAudioContext {
      state = 'running';
      createBuffer(channels: number, length: number, sampleRate: number) {
        const chArrs = Array.from({ length: channels }, () => new Float32Array(length));
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          getChannelData: (c: number) => chArrs[c],
        };
      }
      async decodeAudioData() {
        return {
          sampleRate: sr,
          numberOfChannels: 1,
          length: pcmWithSilence.length,
          getChannelData: () => pcmWithSilence,
        };
      }
      async close() {
        this.state = 'closed';
      }
    },
    URL: {
      revokeObjectURL: () => {},
    },
  };
  (globalThis as any).document = {
    body: { appendChild: () => {} },
    createElement: () => ({
      style: {},
      href: '',
      download: '',
      click() {
        const idx = downloads.length - 1;
        if (idx >= 0) downloads[idx].filename = this.download;
      },
      remove() {},
    }),
  };
  (URL as any).createObjectURL = (blob: Blob) => {
    downloads.push({ filename: '', mimeType: blob.type, size: blob.size });
    return 'blob:mock';
  };
  (URL as any).revokeObjectURL = () => {};

  try {
    const multiRes = await filterAudioInputsForModel([wav1, pdfBlob, wav2], { enabled: true });
    assert.equal(multiRes.stats?.applied, true);
    assert.ok(multiRes.compactedAudioBlob instanceof Blob);
    assert.ok((multiRes.compactedAudioBlob?.size ?? 0) > 0);
    assert.equal((multiRes.filteredInput as Blob[])[1], pdfBlob);

    const combinedDirect = await combineAudioBlobsToCompact([pdfBlob, wav1, wav2]);
    assert.ok(combinedDirect instanceof Blob);
    assert.ok((combinedDirect?.size ?? 0) > 0);

    const origOk = await downloadOriginalAudioInput([pdfBlob, wav1, wav2], 'radiology-dictation-original');
    const compOk = downloadCompactedAudioBlob(multiRes.compactedAudioBlob, 'radiology-dictation-compacted-decision1');
    assert.equal(origOk, true);
    assert.equal(compOk, true);
    assert.equal(downloads.length, 2);
    assert.equal(downloads[0].filename, 'radiology-dictation-original.wav');
    assert.equal(downloads[1].filename, 'radiology-dictation-compacted-decision1.wav');

    const mergedStats = mergePrefilterStats(multiRes.stats, multiRes.stats);
    assert.equal(mergedStats?.applied, true);
    assert.equal(mergedStats?.keptSegmentsCount, (multiRes.stats?.keptSegmentsCount ?? 0) * 2);
  } finally {
    (globalThis as any).window = prevWindow;
    (globalThis as any).document = prevDoc;
    (URL as any).createObjectURL = prevCreateUrl;
    (URL as any).revokeObjectURL = prevRevokeUrl;
  }
});

test('AVAILABLE_MODELS and LIVE_DICTATION_MODELS expose exact 8 free-tier selectable models in order', () => {
  assert.equal(DEFAULT_SELECTED_MODEL, 'gemini-4-hydrogen');
  const expectedOrder = [
    'gemini-4-hydrogen',
    'gemini-3.8-flash',
    'gemini-robotics-er-2-preview',
    'gemini-3.6-flash',
    'gemini-3-flash-preview',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
  ];
  assert.deepEqual(AVAILABLE_MODELS.map((m) => m.value), expectedOrder);
  assert.deepEqual(LIVE_DICTATION_MODELS.map((m) => m.value), expectedOrder);
  assert.deepEqual(FREE_TIER_MEDIUM_MODELS, [
    'gemini-robotics-er-2-preview',
    'gemini-3.6-flash',
    'gemini-3-flash-preview',
  ]);

  assert.equal(AVAILABLE_MODELS[0].label, 'Gemini 4 Hydrogen');
  assert.equal(AVAILABLE_MODELS[0].tier, 'top');
  assert.equal(AVAILABLE_MODELS[2].label, 'Gemini Robotics ER-2 Preview');
  assert.equal(AVAILABLE_MODELS[2].tier, 'medium');
  assert.equal(AVAILABLE_MODELS[3].label, 'Gemini 3.6 Flash');
  assert.equal(AVAILABLE_MODELS[3].quotaBucket, 'gemini-3.6-flash');
  assert.equal(AVAILABLE_MODELS[4].label, 'Gemini 3 Flash Preview');
  assert.equal(AVAILABLE_MODELS[5].quotaBucket, 'gemini-3.6-flash');
  assert.equal(AVAILABLE_MODELS[6].tier, 'low');
  assert.equal(AVAILABLE_MODELS[7].label, 'Gemini 3.1 Pro Preview');
  assert.equal(AVAILABLE_MODELS[7].tier, 'top');
  for (const m of AVAILABLE_MODELS) {
    assert.equal('paidOnly' in m, false);
  }
  assert.equal(getModelDisplayLabel('gemini-3-flash-preview'), 'Gemini 3 Flash Preview');
  assert.equal(getModelDisplayLabel('gemini-4-hydrogen'), 'Gemini 4 Hydrogen');
});

test('filterAudioInputsForModel uses VAD-Only Ogg/Opus 32 kbps with zero Decision-1 API calls on multi-window speech', async () => {
  const sr = 16000;
  // Build >25s multi-segment speech with long pauses so old pipeline would have triggered Decision-1 API batches
  const pcmMulti = concatFloat32([
    new Float32Array(sr * 3),
    makeSineBurst(sr, 4.0, 0.15),
    new Float32Array(sr * 3),
    makeSineBurst(sr, 4.0, 0.15),
    new Float32Array(sr * 3),
    makeSineBurst(sr, 4.0, 0.15),
    new Float32Array(sr * 3),
  ]);
  const wavBlob = new Blob([encodePcmToWavBytes(pcmMulti, sr)], { type: 'audio/wav' });

  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  const prevAudioEncoder = (globalThis as any).AudioEncoder;
  const prevAudioData = (globalThis as any).AudioData;

  let fetchCalls = 0;
  let configuredBitrate = 0;
  let configuredRate = 0;

  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error('Decision-1 fetch must not be called in VAD-Only pre-trim mode');
  }) as any;

  (globalThis as any).window = {
    AudioContext: class MockVadAudioContext {
      state = 'running';
      async decodeAudioData() {
        return {
          sampleRate: sr,
          numberOfChannels: 1,
          length: pcmMulti.length,
          getChannelData: () => pcmMulti,
        };
      }
      async close() {
        this.state = 'closed';
      }
    },
  };

  class MockAudioData {
    close() {}
  }

  class MockAudioEncoder {
    state = 'unconfigured';
    encodeQueueSize = 0;
    private onOutput: (chunk: any, metadata?: any) => void;
    constructor(init: { output: (chunk: any, metadata?: any) => void }) {
      this.onOutput = init.output;
    }
    static async isConfigSupported(cfg: { codec: string; bitrate?: number }) {
      return { supported: cfg.codec === 'opus' };
    }
    configure(cfg: { bitrate?: number; sampleRate?: number }) {
      this.state = 'configured';
      configuredBitrate = cfg.bitrate ?? 0;
      configuredRate = cfg.sampleRate ?? 0;
    }
    encode() {
      const dummyOpus = new Uint8Array([0x78, 0x01, 0x02, 0x03]);
      this.onOutput({
        byteLength: dummyOpus.byteLength,
        duration: 20000,
        copyTo: (dst: Uint8Array) => dst.set(dummyOpus),
      });
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }

  (globalThis as any).AudioData = MockAudioData;
  (globalThis as any).AudioEncoder = MockAudioEncoder;

  try {
    const res = await filterAudioInputsForModel(wavBlob, { enabled: true });
    assert.equal(fetchCalls, 0);
    assert.equal(configuredBitrate, 32000);
    assert.equal(configuredRate, 48000);
    assert.equal(res.stats?.applied, true);
    assert.equal(res.stats?.usedDecision1, false);
    assert.equal(res.stats?.decisionLatencyMs, 0);
    assert.equal(res.stats?.nonRadiologyRemovedSec, 0);
    assert.equal(res.stats?.droppedNonRadiologyCount, 0);
    assert.equal(res.stats?.outputMimeType, 'audio/ogg');
    assert.ok((res.stats?.silenceRemovedSec ?? 0) >= 10);
    assert.ok(res.compactedAudioBlob instanceof Blob);
    assert.equal(res.compactedAudioBlob?.type, 'audio/ogg');

    const header = new Uint8Array(await res.compactedAudioBlob!.slice(0, 36).arrayBuffer());
    assert.equal(Buffer.from(header.subarray(0, 4)).toString('ascii'), 'OggS');
    assert.equal(Buffer.from(header.subarray(28, 36)).toString('ascii'), 'OpusHead');
  } finally {
    (globalThis as any).window = prevWindow;
    globalThis.fetch = prevFetch;
    if (prevAudioEncoder === undefined) delete (globalThis as any).AudioEncoder;
    else (globalThis as any).AudioEncoder = prevAudioEncoder;
    if (prevAudioData === undefined) delete (globalThis as any).AudioData;
    else (globalThis as any).AudioData = prevAudioData;
  }
});

function createMockBrowserEnv() {
  const localMap = new Map<string, string>();
  const sessionMap = new Map<string, string>();
  const makeStorage = (map: Map<string, string>) => ({
    get length() {
      return map.size;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, val: string) {
      map.set(key, String(val));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
  });
  return {
    localMap,
    sessionMap,
    window: {
      localStorage: makeStorage(localMap),
      sessionStorage: makeStorage(sessionMap),
      dispatchEvent: () => true,
    },
  };
}

test('adaptive 503 cooldown steps 5m -> 15m -> 30m -> 60m, persists to sessionStorage, and resets on 200', () => {
  const prevWindow = (globalThis as any).window;
  const mockEnv = createMockBrowserEnv();
  (globalThis as any).window = mockEnv.window;

  try {
    resetApiKeyHealthState();
    clearAllModelUnavailableCooldowns();

    const t0 = 1_700_000_000_000;
    const s1 = markModelTemporarilyUnavailable('gemini-4-hydrogen', t0)!;
    assert.equal(s1.strikes, 1);
    assert.equal(s1.remainingMs, 5 * 60_000);
    assert.equal(isModelTemporarilyUnavailable('gemini-4-hydrogen', t0 + 4 * 60_000), true);
    assert.equal(isModelTemporarilyUnavailable('gemini-4-hydrogen', t0 + 5 * 60_000 + 1), false);

    // Strike 2 after 5m expiry escalates to 15m
    const t1 = t0 + 5 * 60_000 + 1000;
    const s2 = markModelTemporarilyUnavailable('gemini-4-hydrogen', t1)!;
    assert.equal(s2.strikes, 2);
    assert.equal(s2.remainingMs, 15 * 60_000);

    // Strike 3 escalates to 30m, Strike 4+ caps at 60m
    const t2 = t1 + 15 * 60_000 + 1000;
    const s3 = markModelTemporarilyUnavailable('gemini-4-hydrogen', t2)!;
    assert.equal(s3.strikes, 3);
    assert.equal(s3.remainingMs, 30 * 60_000);

    const t3 = t2 + 30 * 60_000 + 1000;
    const s4 = markModelTemporarilyUnavailable('gemini-4-hydrogen', t3)!;
    assert.equal(s4.strikes, 4);
    assert.equal(s4.remainingMs, 60 * 60_000);

    const s5 = markModelTemporarilyUnavailable('gemini-4-hydrogen', t3 + 60 * 60_000 + 1000)!;
    assert.equal(s5.strikes, 5);
    assert.equal(s5.remainingMs, 60 * 60_000);

    // sessionStorage persisted + getOverloadedModelStates reports active cooldown
    assert.ok(mockEnv.sessionMap.has('raddoc_overloaded_models_v1'));
    const activeStates = getOverloadedModelStates(t3 + 60 * 60_000 + 2000);
    assert.equal(activeStates.length, 1);
    assert.equal(activeStates[0].model, 'gemini-4-hydrogen');

    // Reset on 200 OK restores strike counter back to 1 (5m)
    clearModelTemporarilyUnavailable('gemini-4-hydrogen');
    assert.equal(isModelTemporarilyUnavailable('gemini-4-hydrogen', t3 + 60 * 60_000 + 2000), false);
    const afterReset = markModelTemporarilyUnavailable('gemini-4-hydrogen', t3 + 70 * 60_000)!;
    assert.equal(afterReset.strikes, 1);
    assert.equal(afterReset.remainingMs, 5 * 60_000);
  } finally {
    clearAllModelUnavailableCooldowns();
    (globalThis as any).window = prevWindow;
  }
});

test('key-count-aware 503 caps: 1 try for <=2 keys, 2 tries for >=3 keys (failFast), and >=2-key Top-Tier willing retry option', async () => {
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  const mockEnv = createMockBrowserEnv();
  (globalThis as any).window = mockEnv.window;

  try {
    resetApiKeyHealthState();
    setModelFallbackPolicy('top_and_medium');
    setRetryTopTierAllKeysOn503Enabled(false);
    lockBuiltinKeys();

    // 1) <= 2 keys with failFastOnModelUnavailable: true -> caps 503 tries at 1
    setUserApiKeys(['AIzaSyTestKeyOne0001', 'AIzaSyTestKeyTwo0002']);
    assert.equal(getTotalActiveApiKeyCount(), 2);
    let tries2 = 0;
    await assert.rejects(
      () =>
        executeWithApiKeyFailover(
          async () => {
            tries2++;
            const err: any = new Error('503 UNAVAILABLE high demand');
            err.status = 503;
            throw err;
          },
          { selectedModel: 'gemini-4-hydrogen', failFastOnModelUnavailable: true, delayMs: 0 }
        ),
      /503/
    );
    assert.equal(tries2, 1);

    // 2) >= 3 keys (e.g. 9 keys unlocked) with failFastOnModelUnavailable: true -> caps 503 tries at 2, catches ~22% shedding
    setUserApiKeys([]);
    unlockBuiltinKeys('1198');
    const { candidateKeys: unlockedPool } = getCandidateKeysForOperation('gemini-4-hydrogen');
    assert.equal(unlockedPool.length, 9);
    assert.equal(getTotalActiveApiKeyCount(), 9);

    let tries9Systemic = 0;
    await assert.rejects(
      () =>
        executeWithApiKeyFailover(
          async () => {
            tries9Systemic++;
            const err: any = new Error('503 model overloaded');
            err.status = 503;
            throw err;
          },
          { selectedModel: 'gemini-3.8-flash', failFastOnModelUnavailable: true, delayMs: 0 }
        ),
      /503/
    );
    assert.equal(tries9Systemic, 2);

    // Recovers on key #2 when key #1 experiences probabilistic 503 shedding
    let tries9Probabilistic = 0;
    const recoveredVal = await executeWithApiKeyFailover(
      async () => {
        tries9Probabilistic++;
        if (tries9Probabilistic === 1) {
          const err: any = new Error('503 transient shedding');
          err.status = 503;
          throw err;
        }
        return 'ok-on-2nd-key';
      },
      { selectedModel: 'gemini-4-hydrogen', failFastOnModelUnavailable: true, delayMs: 0 }
    );
    assert.equal(recoveredVal, 'ok-on-2nd-key');
    assert.equal(tries9Probabilistic, 2);

    // 3) failFastOnModelUnavailable: false (selected_only) caps 503 at min(N, 3), while allowFullPoolOn503 / 429 uses all 9
    setModelFallbackPolicy('selected_only');
    let triesSelectedOnly503 = 0;
    await assert.rejects(
      () =>
        executeWithApiKeyFailover(
          async () => {
            triesSelectedOnly503++;
            const err: any = new Error('503 unavailable');
            err.status = 503;
            throw err;
          },
          { selectedModel: 'gemini-4-hydrogen', failFastOnModelUnavailable: false, delayMs: 0 }
        ),
      /503/
    );
    assert.equal(triesSelectedOnly503, 3);

    let triesFullPoolOn503 = 0;
    await assert.rejects(
      () =>
        executeWithApiKeyFailover(
          async () => {
            triesFullPoolOn503++;
            const err: any = new Error('503 unavailable');
            err.status = 503;
            throw err;
          },
          { selectedModel: 'gemini-4-hydrogen', failFastOnModelUnavailable: false, allowFullPoolOn503: true, delayMs: 0 }
        ),
      /503/
    );
    assert.equal(triesFullPoolOn503, 9);

    let triesFullPoolOn429 = 0;
    await assert.rejects(
      () =>
        executeWithApiKeyFailover(
          async () => {
            triesFullPoolOn429++;
            const err: any = new Error('429 RESOURCE_EXHAUSTED');
            err.status = 429;
            throw err;
          },
          { selectedModel: 'gemini-4-hydrogen', failFastOnModelUnavailable: false, delayMs: 0 }
        ),
      /429/
    );
    assert.equal(triesFullPoolOn429, 9);

    // 4) >= 2 active keys + isRetryTopTierAllKeysOn503Enabled() retries ALL active keys on Top-Tier before failing over
    setModelFallbackPolicy('top_and_medium');
    setRetryTopTierAllKeysOn503Enabled(true);
    assert.equal(isRetryTopTierAllKeysOn503Enabled(), true);
    resetApiKeyHealthState();

    let topTierAttempts = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('gemini-4-hydrogen')) {
        topTierAttempts++;
        if (topTierAttempts < 9) {
          return new Response(JSON.stringify({ error: { message: '503 busy' } }), { status: 503 });
        }
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"findings":["BOLD::Recovered on 9th key."]}' }] } }] }),
          { status: 200 }
        );
      }
      throw new Error(`Should not fail over before trying all 9 keys: ${url}`);
    }) as any;

    const topRetryRes = await generateContentWithJsonFallbackMeta('gemini-4-hydrogen', [{ text: 'Transcribe' }]);
    assert.equal(topRetryRes.winningModel, 'gemini-4-hydrogen');
    assert.equal(topTierAttempts, 9);

    // With < 2 keys (only 1 key), Top-Tier stays strictly at 1 try even if setting is true
    lockBuiltinKeys();
    setUserApiKeys(['AIzaSySingleKeyOnly0001']);
    assert.equal(getTotalActiveApiKeyCount(), 1);
    let singleKeyHydrogenTries = 0;
    let fallback38Tries = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('gemini-4-hydrogen')) {
        singleKeyHydrogenTries++;
        return new Response(JSON.stringify({ error: { message: '503 busy' } }), { status: 503 });
      }
      if (String(url).includes('gemini-3.8-flash')) {
        fallback38Tries++;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"findings":["BOLD::Fallback 3.8 ok."]}' }] } }] }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as any;

    const singleKeyRes = await generateContentWithJsonFallbackMeta('gemini-4-hydrogen', [{ text: 'Transcribe' }]);
    assert.equal(singleKeyHydrogenTries, 1);
    assert.equal(fallback38Tries, 1);
    assert.equal(singleKeyRes.winningModel, 'gemini-3.8-flash');

    // Custom keys are strictly ordered before built-in 9 backup keys
    unlockBuiltinKeys('1198');
    setUserApiKeys(['AIzaSyCustomKeyPriority001']);
    const { candidateKeys: combinedPool, isCustom, hasBuiltinBackup } = getCandidateKeysForOperation('gemini-4-hydrogen');
    assert.equal(isCustom, true);
    assert.equal(hasBuiltinBackup, true);
    assert.equal(combinedPool[0], 'AIzaSyCustomKeyPriority001');
    assert.equal(combinedPool.length, 10);
    assert.equal(getTotalActiveApiKeyCount(), 10);
  } finally {
    setRetryTopTierAllKeysOn503Enabled(false);
    resetApiKeyHealthState();
    (globalThis as any).window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});

test('tiered fallback chains dedup aliases, exclude flash-lite & 3.1-pro from auto-fallback, and respect policies', () => {
  assert.equal(resolveQuotaPoolModel('gemini-3.5-flash'), 'gemini-3.6-flash');
  assert.equal(resolveQuotaPoolModel('gemini-3.7-flash'), 'gemini-3.8-flash');

  // top_and_medium includes Top + Medium (3.6-flash before 3-flash-preview), excludes 3.5-flash-lite & 3.1-pro-preview
  const fullChain = getFreeTierModelFallbackChain('gemini-4-hydrogen', 'top_and_medium');
  assert.deepEqual(fullChain, [
    'gemini-4-hydrogen',
    'gemini-3.8-flash',
    'gemini-robotics-er-2-preview',
    'gemini-3.6-flash',
    'gemini-3-flash-preview',
  ]);
  assert.equal(fullChain.includes(GEMINI_FLASH_LITE_MODEL), false);
  assert.equal(fullChain.includes('gemini-3.1-pro-preview'), false);

  // Explicit 3.1-pro-preview puts it at index 0 with normal fallback chain behind it
  const explicitPro = getFreeTierModelFallbackChain('gemini-3.1-pro-preview', 'top_and_medium');
  assert.equal(explicitPro[0], 'gemini-3.1-pro-preview');
  assert.equal(explicitPro[1], 'gemini-4-hydrogen');

  // Alias deduplication: 3.5-flash removes 3.6-flash; 3.7-flash removes 3.8-flash
  const alias35 = getFreeTierModelFallbackChain('gemini-3.5-flash', 'top_and_medium');
  assert.equal(alias35[0], 'gemini-3.5-flash');
  assert.equal(alias35.includes('gemini-3.6-flash'), false);

  const alias37 = getFreeTierModelFallbackChain('gemini-3.7-flash', 'top_and_medium');
  assert.equal(alias37[0], 'gemini-3.7-flash');
  assert.equal(alias37.includes('gemini-3.8-flash'), false);

  // top_only excludes Medium and Low models
  assert.deepEqual(
    getFreeTierModelFallbackChain('gemini-4-hydrogen', 'top_only'),
    ['gemini-4-hydrogen', 'gemini-3.8-flash']
  );

  // selected_only returns strictly the selected model
  assert.deepEqual(
    getFreeTierModelFallbackChain('gemini-robotics-er-2-preview', 'selected_only'),
    ['gemini-robotics-er-2-preview']
  );

  // Live fallback chain also excludes flash-lite unless explicitly selected
  const liveDefault = getLiveModelFallbackChain('gemini-4-hydrogen', 'top_and_medium');
  assert.equal(liveDefault.includes(GEMINI_FLASH_LITE_MODEL), false);
  const liveExplicitLite = getLiveModelFallbackChain(GEMINI_FLASH_LITE_MODEL, 'top_and_medium');
  assert.equal(liveExplicitLite[0], GEMINI_FLASH_LITE_MODEL);
});

test('getOptimalThinkingLevel calibrates Robotics high thinking, quality directives, and 2-pass Flash-Lite polish', async () => {
  assert.equal(getOptimalThinkingLevel('gemini-4-hydrogen', 'transcription'), 'low');
  assert.equal(getOptimalThinkingLevel('gemini-4-hydrogen', 'reasoning'), 'medium');
  assert.equal(getOptimalThinkingLevel('gemini-3.8-flash', 'transcription'), 'medium');
  assert.equal(getOptimalThinkingLevel('gemini-3.6-flash', 'reasoning'), 'medium');
  assert.equal(getOptimalThinkingLevel('gemini-3.5-flash', 'live_chunk'), 'medium');
  assert.equal(getOptimalThinkingLevel('gemini-robotics-er-2-preview', 'transcription'), 'high');
  assert.equal(getOptimalThinkingLevel('gemini-robotics-er-2-preview', 'reasoning'), 'high');
  assert.equal(getOptimalThinkingLevel('gemini-robotics-er-2-preview', 'live_chunk'), 'low');
  assert.equal(getOptimalThinkingLevel('gemini-3-flash-preview', 'transcription'), 'low');
  assert.equal(getOptimalThinkingLevel('gemini-3-flash-preview', 'live_chunk'), 'minimal');
  assert.equal(getOptimalThinkingLevel('gemini-3.5-flash-lite', 'transcription'), 'minimal');
  assert.equal(getOptimalThinkingLevel('gemini-3.5-flash-lite', 'reasoning'), 'high');

  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  const mockEnv = createMockBrowserEnv();
  (globalThis as any).window = mockEnv.window;

  try {
    resetApiKeyHealthState();
    setModelFallbackPolicy('top_and_medium');
    setMediumProsePolishEnabled(true);
    setUserApiKeys(['AIzaSyTestRoboticsKey0001']);

    const capturedCalls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const parsedBody = JSON.parse(String(init?.body || '{}'));
      capturedCalls.push({ url: String(url), body: parsedBody });

      if (String(url).includes('gemini-robotics-er-2-preview')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'internal reasoning', thought: true },
                    {
                      text: JSON.stringify({
                        findings: [
                          'BOLD::Undisplaced occipital bone fracture with extra axial hematoma.',
                          'IMPRESSION:###• Undisplaced occipital bone fracture.###• Extra axial hematoma.',
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Stage-2 Flash-Lite polish call
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      findings: [
                        'BOLD::Undisplaced occipital bone fracture with extra axial hematoma (polished).',
                        'IMPRESSION:###• Undisplaced occipital bone fracture.###• Extra axial hematoma.',
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as any;

    const audioBlob = new Blob([encodePcmToWavBytes(makeSineBurst(16000, 0.3, 0.1), 16000)], { type: 'audio/wav' });
    const out = await processAudio(audioBlob, 'gemini-robotics-er-2-preview');

    assert.equal(capturedCalls.length, 2);
    // Pass 1: Robotics ER-2 with thinkingLevel: 'high' and ROBOTICS_QUALITY_DIRECTIVES injected
    assert.ok(capturedCalls[0].url.includes('gemini-robotics-er-2-preview:generateContent'));
    assert.equal(capturedCalls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'high');
    const roboticsTextParts = capturedCalls[0].body.contents[0].parts
      .map((p: any) => p.text || '')
      .join('\n');
    assert.ok(roboticsTextParts.includes('Undisplaced'));
    assert.ok(roboticsTextParts.includes('extra axial'));
    assert.ok(roboticsTextParts.includes(ROBOTICS_QUALITY_DIRECTIVES));

    // Pass 2: Flash-Lite text polish with thinkingLevel: 'high'
    assert.ok(capturedCalls[1].url.includes(`${GEMINI_FLASH_LITE_MODEL}:generateContent`));
    assert.equal(capturedCalls[1].body.generationConfig.thinkingConfig.thinkingLevel, 'high');
    assert.ok(out[0].includes('(polished)'));

    // Verify Top-tier model skips ROBOTICS_QUALITY_DIRECTIVES and skips Flash-Lite Stage-2 polish
    capturedCalls.length = 0;
    await generateContentWithJsonFallback('gemini-4-hydrogen', [{ text: 'Transcribe' }]);
    assert.equal(capturedCalls.length, 1);
    assert.equal(capturedCalls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
    assert.equal(
      capturedCalls[0].body.contents[0].parts.some((p: any) => String(p.text || '').includes('CLINICAL PRECISION')),
      false
    );
  } finally {
    setMediumProsePolishEnabled(false);
    resetApiKeyHealthState();
    (globalThis as any).window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});

test('direct fetch Files API avoids User-Agent/Content-Length, network fetch errors fail over cleanly, and plain-English notices emit', async () => {
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  const mockEnv = createMockBrowserEnv();
  const dispatchedEvents: any[] = [];
  (mockEnv.window as any).dispatchEvent = (evt: any) => {
    dispatchedEvents.push(evt);
    return true;
  };
  (globalThis as any).window = mockEnv.window;

  try {
    resetApiKeyHealthState();
    setModelFallbackPolicy('top_and_medium');
    lockBuiltinKeys();
    setUserApiKeys(['AIzaSyDirectFilesKey0001', 'AIzaSyDirectFilesKey0002']);

    // 1) Pure fetch Files API omits forbidden User-Agent & Content-Length headers
    const sentHeaderNames: string[][] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers || {}) as Record<string, string>;
      sentHeaderNames.push(Object.keys(headers).map((h) => h.toLowerCase()));
      const u = String(url);
      if (u.includes('/upload/v1beta/files')) {
        return new Response(null, {
          status: 200,
          headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/session_123' },
        });
      }
      if (u.includes('/upload/session_123')) {
        return new Response(
          JSON.stringify({
            file: {
              name: 'files/abc123',
              uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
              mimeType: 'audio/wav',
              state: 'PROCESSING',
            },
          }),
          { status: 200 }
        );
      }
      if (u.endsWith('/v1beta/files/abc123') && init?.method === 'GET') {
        return new Response(
          JSON.stringify({
            name: 'files/abc123',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
            mimeType: 'audio/wav',
            state: 'ACTIVE',
          }),
          { status: 200 }
        );
      }
      if (u.endsWith('/v1beta/files/abc123') && init?.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as any;

    const uploaded = await uploadBlobViaFilesApi(new Blob(['abc'], { type: 'audio/wav' }), 'audio/wav', 'AIzaSyDirectFilesKey0001', 'clip.wav');
    assert.equal(uploaded.name, 'files/abc123');
    const active = await waitForUploadedFileActive(uploaded.name, 'AIzaSyDirectFilesKey0001');
    assert.equal(active.state, 'ACTIVE');
    await deleteUploadedFile(uploaded.name, 'AIzaSyDirectFilesKey0001');

    for (const hdrList of sentHeaderNames) {
      assert.equal(hdrList.includes('user-agent'), false);
      assert.equal(hdrList.includes('content-length'), false);
      assert.equal(hdrList.includes('x-goog-api-key'), true);
    }

    // 2) Repeated network fetch failures on gemini-3-flash-preview fail over to next model cleanly
    assert.equal(isNetworkFetchError(new Error('exception TypeError: Failed to fetch sending request')), true);
    dispatchedEvents.length = 0;

    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('gemini-3-flash-preview')) {
        throw new Error('exception TypeError: Failed to fetch sending request');
      }
      if (u.includes('gemini-4-hydrogen')) {
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"findings":["BOLD::Recovered after network drop."]}' }] } }] }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as any;

    const failoverRes = await generateContentWithJsonFallbackMeta('gemini-3-flash-preview', [{ text: 'Transcribe' }]);
    assert.equal(failoverRes.winningModel, 'gemini-4-hydrogen');
    assert.ok(failoverRes.text.includes('Recovered after network drop.'));
    const failoverEvt = dispatchedEvents.find((e) => e?.type === MODEL_FAILOVER_EVENT);
    assert.ok(failoverEvt);
    assert.equal(failoverEvt.detail.fromModelLabel, 'Gemini 3 Flash Preview');
    assert.equal(failoverEvt.detail.toModelLabel, 'Gemini 4 Hydrogen');
    assert.equal(/503|429|Strike/i.test(failoverEvt.detail.userMessage), false);

    // 3) Plain-English error message on strict model failure (no raw 503/429/Strike jargon)
    setModelFallbackPolicy('selected_only');
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
    }) as any;
    await assert.rejects(
      () => generateContentWithJsonFallbackMeta('gemini-4-hydrogen', [{ text: 'Transcribe' }]),
      (err: any) => {
        const msg = String(err?.message || '');
        assert.ok(msg.includes('Gemini 4 Hydrogen'));
        assert.equal(/\b(?:503|429|Strike)\b/i.test(msg), false);
        return true;
      }
    );

    // 4) Scoped dictate_changes audio metadata isolation & delete cleanup
    await saveDictateChangesAudio(new Blob(['a'], { type: 'audio/webm' }), 'Edit A', 'scopeA');
    await saveDictateChangesAudio(new Blob(['b'], { type: 'audio/webm' }), 'Edit B', 'scopeB');
    assert.equal(hasStoredDictateChangesAudio('scopeA'), true);
    assert.equal(hasStoredDictateChangesAudio('scopeB'), true);
    assert.equal(hasStoredDictateChangesAudio('scopeC'), false);
    await deleteDictateChangesAudio('scopeA');
    assert.equal(hasStoredDictateChangesAudio('scopeA'), false);
    assert.equal(hasStoredDictateChangesAudio('scopeB'), true);
    await deleteDictateChangesAudio();
    assert.equal(hasStoredDictateChangesAudio('scopeB'), false);
    assert.equal(await getDictateChangesAudio('scopeB'), null);
  } finally {
    setModelFallbackPolicy('top_and_medium');
    resetApiKeyHealthState();
    (globalThis as any).window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});

test('runClinicalQaErrorCheck isolates detailed error identification strictly onto Flash-Lite', async () => {
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  const mockEnv = createMockBrowserEnv();
  (globalThis as any).window = mockEnv.window;

  try {
    resetApiKeyHealthState();
    setModelFallbackPolicy('top_and_medium');
    setUserApiKeys(['AIzaSyQaIsolationKey0001']);

    const calledModels: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/v1beta/decisions')) {
        return new Response(
          JSON.stringify({
            answers: {
              has_laterality_contradiction: { noul: 0.91, confidence: 0.95 },
              has_normal_vs_abnormal_contradiction: { noul: 0.05, confidence: 0.95 },
              impression_contradicts_or_omits_finding: { noul: 0.05, confidence: 0.95 },
              impression_contains_numbers: { noul: 0.02, confidence: 0.95 },
              critical_finding_urgency: { score: 1, probabilities: { '1': 0.9 } },
              report_completeness: { score: 3, probabilities: { '3': 0.95 } },
            },
          }),
          { status: 200 }
        );
      }
      calledModels.push(u);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      errors: [{ findingIndex: 0, errorDescription: 'Laterality conflict.', severity: 'WARNING' }],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }) as any;

    const qaRes = await runClinicalQaErrorCheck(
      ['Right kidney stone.', 'IMPRESSION:###Left nephrolithiasis.'],
      'gemini-4-hydrogen'
    );
    assert.equal(qaRes.errors.length, 1);
    assert.equal(calledModels.length, 1);
    assert.ok(calledModels[0].includes(`${GEMINI_FLASH_LITE_MODEL}:generateContent`));
    assert.equal(calledModels[0].includes('gemini-4-hydrogen'), false);

    // Also when Decisions API fails, fallback still uses Flash-Lite exclusively (and never cascades to 4-hydrogen/3.8)
    calledModels.length = 0;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/v1beta/decisions')) {
        return new Response(JSON.stringify({ error: { message: 'Decisions unavailable' } }), { status: 503 });
      }
      calledModels.push(u);
      return new Response(JSON.stringify({ error: { message: '429 quota' } }), { status: 429 });
    }) as any;

    const fallbackRes = await runClinicalQaErrorCheck(['Lungs clear.'], 'gemini-4-hydrogen');
    assert.deepEqual(fallbackRes.errors, []);
    assert.equal(calledModels.length, 1);
    assert.ok(calledModels[0].includes(`${GEMINI_FLASH_LITE_MODEL}:generateContent`));
  } finally {
    resetApiKeyHealthState();
    (globalThis as any).window = prevWindow;
    globalThis.fetch = prevFetch;
  }
});

test('useLiveSession 5-RPM cadence constants and storageService enum/JSON validation', () => {
  assert.equal(LIVE_CHUNK_MIN_SPEECH_SEC, 3.0);
  assert.equal(LIVE_CHUNK_SILENCE_MS, 900);
  assert.equal(LIVE_CHUNK_MAX_SEC, 12.0);

  const prevWindow = (globalThis as any).window;
  const mockEnv = createMockBrowserEnv();
  (globalThis as any).window = mockEnv.window;

  try {
    mockEnv.localMap.set('raddoc_retry_top_tier_all_keys_on_503', 'true');
    mockEnv.localMap.set('raddoc_model_fallback_policy', 'top_only');
    mockEnv.localMap.set('raddoc_medium_prose_polish', 'true');
    safeLocalStorage.validateAndCleanStorage();

    // Valid enum & JSON entries are preserved
    assert.equal(mockEnv.localMap.get('raddoc_retry_top_tier_all_keys_on_503'), 'true');
    assert.equal(mockEnv.localMap.get('raddoc_model_fallback_policy'), 'top_only');
    assert.equal(mockEnv.localMap.get('raddoc_medium_prose_polish'), 'true');

    // Invalid enum / corrupt JSON entries are purged
    mockEnv.localMap.set('raddoc_model_fallback_policy', 'invalid_policy');
    mockEnv.localMap.set('raddoc_retry_top_tier_all_keys_on_503', '{bad_json');
    mockEnv.sessionMap.set('raddoc_overloaded_models_v1', '{bad_session');
    safeLocalStorage.validateAndCleanStorage();

    assert.equal(mockEnv.localMap.has('raddoc_model_fallback_policy'), false);
    assert.equal(mockEnv.localMap.has('raddoc_retry_top_tier_all_keys_on_503'), false);
    assert.equal(mockEnv.sessionMap.has('raddoc_overloaded_models_v1'), false);
  } finally {
    (globalThis as any).window = prevWindow;
  }
});
