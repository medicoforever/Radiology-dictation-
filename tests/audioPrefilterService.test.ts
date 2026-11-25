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
  type SpeechInterval,
} from '../services/audioPrefilterService';
import { safeLocalStorage } from '../services/storageService';

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

  // 5) API/quota error falls back gracefully to VAD-trimmed windows
  const errRes = await filterWindowsWithDecision1(twoWins, pcm, sr, {
    batchSpacingMs: 0,
    callDecisionsFn: async () => {
      throw new Error('429 RESOURCE_EXHAUSTED');
    },
  });
  assert.equal(errRes.usedDecision1, false);
  assert.equal(errRes.keptWindows.length, 2);
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
  } finally {
    (globalThis as any).window = prevWindow;
  }
});
