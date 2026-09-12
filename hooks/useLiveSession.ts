import { useState, useRef, useCallback, useEffect } from 'react';
import {
  startRepeatingInterruptedAlert,
  stopRepeatingInterruptedAlert,
  unlockAudioContext,
} from '../services/soundService';
import { processLiveAudioChunk, synthesizeLiveReport, LiveHistoryContext } from '../services/geminiService';

interface LiveHistorySnapshot {
  findings: string[];
  deletedItems: string[];
  timestamp: number;
}

/**
 * Computes energy and Voice Activity Detection (VAD) metrics for a PCM sample range.
 */
export interface AudioEnergyAnalysis {
  rms: number;
  peak: number;
  speechRatio: number;
  hasSpeech: boolean;
}

export function analyzePcmEnergy(
  pcmChunks: Int16Array[],
  startSample: number,
  endSample: number,
  speechThreshold: number = 420,
  minSpeechRatio: number = 0.035
): AudioEnergyAnalysis {
  let totalAvailable = 0;
  for (const c of pcmChunks) totalAvailable += c.length;

  const clampedStart = Math.max(0, Math.min(startSample, totalAvailable));
  const clampedEnd = Math.max(clampedStart, Math.min(endSample, totalAvailable));
  const totalSamples = clampedEnd - clampedStart;

  if (totalSamples <= 0) {
    return { rms: 0, peak: 0, speechRatio: 0, hasSpeech: false };
  }

  let sumSquares = 0;
  let peak = 0;
  let speechSamplesCount = 0;

  let runningSampleIdx = 0;
  for (const chunk of pcmChunks) {
    const chunkLen = chunk.length;
    const chunkStart = runningSampleIdx;
    const chunkEnd = runningSampleIdx + chunkLen;

    if (chunkEnd > clampedStart && chunkStart < clampedEnd) {
      const takeStart = Math.max(0, clampedStart - chunkStart);
      const takeEnd = Math.min(chunkLen, clampedEnd - chunkStart);
      for (let i = takeStart; i < takeEnd; i++) {
        const val = chunk[i];
        const absVal = Math.abs(val);
        if (absVal > peak) peak = absVal;
        sumSquares += val * val;
        if (absVal >= speechThreshold) {
          speechSamplesCount++;
        }
      }
    }
    runningSampleIdx += chunkLen;
    if (runningSampleIdx >= clampedEnd) break;
  }

  const rms = Math.sqrt(sumSquares / totalSamples);
  const speechRatio = speechSamplesCount / totalSamples;
  // Speech is present if speech frames ratio exceeds minimum threshold OR if RMS & peak indicate human vocalization
  const hasSpeech = (speechRatio >= minSpeechRatio && peak >= 1200) || (rms >= 500 && peak >= 2200);

  return { rms, peak, speechRatio, hasSpeech };
}

/**
 * Convert recorded Int16Array PCM chunks into standard 16kHz 16-bit Mono WAV Blob
 */
export function pcmToWavBlob(pcmChunks: Int16Array[], sampleRate = 16000): Blob {
  let totalSamples = 0;
  for (const chunk of pcmChunks) {
    totalSamples += chunk.length;
  }
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, totalSamples * 2, true);

  let offset = 44;
  for (const chunk of pcmChunks) {
    for (let i = 0; i < chunk.length; i++, offset += 2) {
      view.setInt16(offset, chunk[i], true);
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Slice an exact sample range from the recorded 16kHz PCM chunks and output a valid Mono 16-bit WAV Blob
 */
export function pcmRangeToWavBlob(
  pcmChunks: Int16Array[],
  startSample: number,
  endSample: number,
  sampleRate = 16000
): Blob {
  let totalAvailable = 0;
  for (const c of pcmChunks) totalAvailable += c.length;

  const clampedStart = Math.max(0, Math.min(startSample, totalAvailable));
  const clampedEnd = Math.max(clampedStart, Math.min(endSample, totalAvailable));
  const numSamples = clampedEnd - clampedStart;

  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let outOffset = 44;
  let runningSampleIdx = 0;

  for (const chunk of pcmChunks) {
    const chunkLen = chunk.length;
    const chunkStart = runningSampleIdx;
    const chunkEnd = runningSampleIdx + chunkLen;

    if (chunkEnd > clampedStart && chunkStart < clampedEnd) {
      const takeStart = Math.max(0, clampedStart - chunkStart);
      const takeEnd = Math.min(chunkLen, clampedEnd - chunkStart);
      for (let i = takeStart; i < takeEnd; i++) {
        view.setInt16(outOffset, chunk[i], true);
        outOffset += 2;
      }
    }
    runningSampleIdx += chunkLen;
    if (runningSampleIdx >= clampedEnd) break;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export const useLiveSession = () => {
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recordedPcmChunksRef = useRef<Int16Array[]>([]);
  const onTranscriptUpdateRef = useRef<((lines: string[]) => void) | null>(null);
  const isSessionActiveRef = useRef<boolean>(false);
  const isPausedRef = useRef(isPaused);

  // Progressive Low-Latency Flash Chunking Engine state
  const sessionStartTimeRef = useRef<number>(0);
  const accumulatedPauseDurationRef = useRef<number>(0);
  const pauseStartTimeRef = useRef<number>(0);
  const totalSamplesCountRef = useRef<number>(0);
  const lastProcessedSampleRef = useRef<number>(0);
  const currentChunkIndexRef = useRef<number>(0);
  const isProcessingChunkRef = useRef<boolean>(false);
  const schedulerIntervalRef = useRef<any>(null);
  const selectedModelRef = useRef<string>('gemini-3.7-flash');
  const customPromptRef = useRef<string>('');

  // Voice Activity & Silence Gating state (VAD)
  const lastSpeechTimestampRef = useRef<number>(0);
  const speechDetectedInWindowRef = useRef<boolean>(false);

  // Findings state: purely authoritative findings returned by Gemini model
  const committedFindingsRef = useRef<string[]>([]);
  // Last findings dispatched to Gemini in an active in-flight chunk
  const lastDispatchedFindingsRef = useRef<string[]>([]);
  // Version counter for manual edits by user (incremented on each manual edit/reorder/merge/delete)
  const userEditVersionRef = useRef<number>(0);
  // Version snapshot at the start of current in-flight chunk
  const chunkStartVersionRef = useRef<number>(0);
  // Deletion / edit history stack for voice undo / revert ("revert it back", "undo delete", etc.)
  const historyStackRef = useRef<LiveHistorySnapshot[]>([]);
  // Recently deleted items
  const lastDeletedItemsRef = useRef<string[]>([]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    isSessionActiveRef.current = isSessionActive;
  }, [isSessionActive]);

  // Synchronize state from UI manual edits, deletions, reorders, or merges
  const syncFindings = useCallback((updatedFindings: string[]) => {
    // Record history snapshot if findings were deleted or modified
    if (committedFindingsRef.current.length > 0) {
      const deleted = committedFindingsRef.current.filter(item => !updatedFindings.includes(item));
      if (deleted.length > 0) {
        lastDeletedItemsRef.current = deleted;
      }
      historyStackRef.current.push({
        findings: [...committedFindingsRef.current],
        deletedItems: deleted,
        timestamp: Date.now(),
      });
      if (historyStackRef.current.length > 20) {
        historyStackRef.current.shift();
      }
    }
    userEditVersionRef.current += 1;
    committedFindingsRef.current = [...updatedFindings];
  }, []);

  // Synchronize custom instructions or template prompt from UI dynamically
  const syncCustomPrompt = useCallback((prompt: string) => {
    customPromptRef.current = prompt || '';
  }, []);

  const emitFindings = useCallback(() => {
    if (!onTranscriptUpdateRef.current) return;
    onTranscriptUpdateRef.current([...committedFindingsRef.current]);
  }, []);

  /**
   * Dispatches a slice of recorded audio to Gemini Flash model (e.g. gemini-3.7-flash)
   * with complete medical prompt and previous dictation text for seamless context continuation.
   * Performs local VAD validation to ensure silence/noise is never sent to the model.
   */
  const dispatchLiveChunk = useCallback(async (startSample: number, endSample: number, chunkIdx: number) => {
    if (isProcessingChunkRef.current) return;

    // Acoustic Voice Activity Verification before dispatching API call
    const vadMetrics = analyzePcmEnergy(recordedPcmChunksRef.current, startSample, endSample);
    if (!vadMetrics.hasSpeech) {
      // Pure silence or ambient room sound — advance without invoking Gemini to prevent hallucinations
      lastProcessedSampleRef.current = endSample;
      currentChunkIndexRef.current = chunkIdx + 1;
      setStatus(`🎙️ Ambient room silence filtered. Listening for clinical speech...`);
      return;
    }

    isProcessingChunkRef.current = true;

    const modelName = selectedModelRef.current || 'gemini-3.7-flash';
    const timeLabel = chunkIdx === 0 ? '0s-5s' : chunkIdx === 1 ? '0s-10s' : `${Math.round(startSample / 16000)}s-${Math.round(endSample / 16000)}s`;
    setStatus(`⚡ Transcribing [${timeLabel}] with ${modelName}...`);

    const chunkBlob = pcmRangeToWavBlob(recordedPcmChunksRef.current, startSample, endSample, 16000);

    // Record baseline and version snapshot for in-flight conflict protection
    chunkStartVersionRef.current = userEditVersionRef.current;
    lastDispatchedFindingsRef.current = [...committedFindingsRef.current];

    const historyContext: LiveHistoryContext = {
      previousState: historyStackRef.current.length > 0
        ? historyStackRef.current[historyStackRef.current.length - 1].findings
        : [],
      deletedItems: lastDeletedItemsRef.current || [],
    };

    try {
      const result = await processLiveAudioChunk(
        chunkBlob,
        modelName,
        committedFindingsRef.current,
        chunkIdx,
        customPromptRef.current,
        (failedModel, nextModel, reason) => {
          setStatus(`⚡ Auto-failover: ${failedModel} failed (${reason}) — switching to subsequent model ${nextModel}...`);
        },
        historyContext
      );

      const updatedFindings = Array.isArray(result) ? result : result.findings;
      const activeModel = Array.isArray(result) ? modelName : (result.activeModel || modelName);

      if (activeModel !== selectedModelRef.current) {
        selectedModelRef.current = activeModel;
      }

      if (Array.isArray(updatedFindings)) {
        const userEditedDuringInFlight = userEditVersionRef.current > chunkStartVersionRef.current;

        if (userEditedDuringInFlight) {
          // Manual edit/reorder/merge occurred WHILE this chunk was being processed!
          // Strictly protect user's manual modifications from being clobbered:
          const baseline = lastDispatchedFindingsRef.current;
          const baselineSet = new Set(baseline);
          // Extract only genuinely newly spoken findings generated by the audio
          const newlyAddedFindings = updatedFindings.filter(f => !baselineSet.has(f));

          if (newlyAddedFindings.length > 0) {
            committedFindingsRef.current = [...committedFindingsRef.current, ...newlyAddedFindings];
          }
          emitFindings();
        } else {
          // Normal flow: track deletion history if Gemini deleted or removed items
          if (committedFindingsRef.current.length > 0) {
            const deleted = committedFindingsRef.current.filter(item => !updatedFindings.includes(item));
            if (deleted.length > 0) {
              lastDeletedItemsRef.current = deleted;
              historyStackRef.current.push({
                findings: [...committedFindingsRef.current],
                deletedItems: deleted,
                timestamp: Date.now(),
              });
              if (historyStackRef.current.length > 20) {
                historyStackRef.current.shift();
              }
            }
          }
          committedFindingsRef.current = updatedFindings;
          emitFindings();
        }
      }

      lastProcessedSampleRef.current = endSample;
      currentChunkIndexRef.current = chunkIdx + 1;
      setStatus(`🎙️ Live Dictation active (${Math.round(endSample / 16000)}s elapsed with ${activeModel}). Listening...`);
    } catch (err: any) {
      console.warn(`Live chunk #${chunkIdx + 1} processing issue:`, err);
      // Keep lastProcessedSampleRef untouched so subsequent interval recovers the audio
    } finally {
      isProcessingChunkRef.current = false;
    }
  }, [emitFindings]);



  const stopAudio = useCallback(() => {
    isSessionActiveRef.current = false;

    // Clear progressive chunk scheduler
    if (schedulerIntervalRef.current) {
      clearInterval(schedulerIntervalRef.current);
      schedulerIntervalRef.current = null;
    }

    // Disconnect script processor
    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
      } catch (e) {}
      scriptProcessorRef.current = null;
    }

    // Close AudioContext
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch (e) {}
      audioContextRef.current = null;
    }

    // Stop MediaStream tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
      mediaStreamRef.current = null;
    }

    setAudioLevel(0);
  }, []);

  const startSession = useCallback(async (
    onTranscriptUpdate: (lines: string[]) => void,
    customPrompt?: string,
    model: string = 'gemini-3.7-flash'
  ) => {
    stopRepeatingInterruptedAlert();
    stopAudio();
    setError(null);
    setStatus(`Initializing microphone stream for low-latency ${model}...`);
    recordedPcmChunksRef.current = [];
    committedFindingsRef.current = [];
    lastDispatchedFindingsRef.current = [];
    userEditVersionRef.current = 0;
    chunkStartVersionRef.current = 0;
    historyStackRef.current = [];
    lastDeletedItemsRef.current = [];
    totalSamplesCountRef.current = 0;
    lastProcessedSampleRef.current = 0;
    currentChunkIndexRef.current = 0;
    isProcessingChunkRef.current = false;
    lastSpeechTimestampRef.current = 0;
    speechDetectedInWindowRef.current = false;
    sessionStartTimeRef.current = Date.now();
    accumulatedPauseDurationRef.current = 0;
    pauseStartTimeRef.current = 0;
    selectedModelRef.current = model || 'gemini-3.7-flash';
    customPromptRef.current = customPrompt || '';
    onTranscriptUpdateRef.current = onTranscriptUpdate;
    onTranscriptUpdate([]);
    setIsPaused(false);
    setIsSessionActive(true);
    isSessionActiveRef.current = true;

    // Unlock audio context for potential interruption alert
    unlockAudioContext();

    // 1. Setup AudioContext and Audio Analyzer for live volume visualizer and 16kHz WAV recording
    let stream: MediaStream | null = null;
    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtxClass({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        });
      } catch (err1) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      mediaStreamRef.current = stream;

      // Monitor for unexpected microphone disconnection or hardware muting
      stream.getAudioTracks().forEach(track => {
        track.addEventListener('ended', () => {
          if (isSessionActiveRef.current) {
            startRepeatingInterruptedAlert(10000);
            setError('Microphone was disconnected or turned off.');
            setIsSessionActive(false);
            isSessionActiveRef.current = false;
            stopAudio();
          }
        });
        track.addEventListener('mute', () => {
          if (isSessionActiveRef.current) {
            startRepeatingInterruptedAlert(10000);
            setError('Microphone was muted by OS or hardware.');
            setIsSessionActive(false);
            isSessionActiveRef.current = false;
            stopAudio();
          }
        });
      });

      const source = audioCtx.createMediaStreamSource(stream);
      const scriptProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
      scriptProcessorRef.current = scriptProcessor;

      scriptProcessor.onaudioprocess = (e) => {
        if (isPausedRef.current) return;

        const inputData = e.inputBuffer.getChannelData(0);
        
        // Calculate audio RMS volume level and detect human vocal presence
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < inputData.length; i++) {
          const sample = inputData[i];
          const absVal = Math.abs(sample);
          if (absVal > peak) peak = absVal;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / inputData.length);
        const level = Math.min(100, Math.round(rms * 450));
        setAudioLevel(level);

        // Vocal presence detection: human speech typically has peak > 0.035 and rms > 0.012
        if (peak > 0.035 || rms > 0.012) {
          lastSpeechTimestampRef.current = Date.now();
          speechDetectedInWindowRef.current = true;
        }

        // Convert Float32 to 16-bit linear PCM
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Save recorded PCM chunk for slice sending & final WAV generation
        recordedPcmChunksRef.current.push(pcm16);
        totalSamplesCountRef.current += pcm16.length;
      };

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioCtx.destination);
    } catch (audioErr: any) {
      console.warn('Audio capture setup notice:', audioErr);
      setError('Microphone permission required for Live Dictation. Please allow microphone access.');
    }

    // 2. Start Progressive Semantic Chunking Scheduler
    // Evaluates every 200ms for semantic thought boundaries (e.g. pauses)
    // or duration thresholds to guarantee low latency without arbitrary mid-sentence cuts.
    schedulerIntervalRef.current = setInterval(() => {
      if (!isSessionActiveRef.current || isPausedRef.current || isProcessingChunkRef.current) {
        return;
      }

      const totalSamples = totalSamplesCountRef.current;
      const unprocessedSamples = totalSamples - lastProcessedSampleRef.current;
      const unprocessedSec = unprocessedSamples / 16000;

      // Ensure at least 2.0s of audio has accumulated before attempting dispatch
      if (unprocessedSec < 2.0) {
        return;
      }

      const chunkIdx = currentChunkIndexRef.current;
      const hasSpeechInWindow = speechDetectedInWindowRef.current;
      const timeSinceSpeech = Date.now() - lastSpeechTimestampRef.current;

      let shouldProcess = false;

      if (hasSpeechInWindow) {
        // Speech was detected in this segment.
        // Trigger condition:
        // 1. Natural clause/sentence boundary: doctor finished speaking and paused for >= 750ms, with >= 2.5s audio
        // 2. OR sustained speech length reached >= 7.5s (to keep display updated progressively)
        if ((timeSinceSpeech >= 750 && unprocessedSec >= 2.5) || unprocessedSec >= 7.5) {
          shouldProcess = true;
        }
      } else {
        // No speech detected in this window (pure silence or idle room hum)
        // If 5.0 seconds of silence have elapsed, advance pointer without making API call
        if (unprocessedSec >= 5.0) {
          lastProcessedSampleRef.current = totalSamples;
          setStatus(`🎙️ Ambient room silence filtered. Listening for radiology dictation...`);
          return;
        }
      }

      if (shouldProcess && unprocessedSamples > 0) {
        speechDetectedInWindowRef.current = false;
        // 0.25s (4000 samples) phonetic overlap buffer for natural word boundary continuity
        const startSample = chunkIdx === 0 ? 0 : Math.max(0, lastProcessedSampleRef.current - 4000);
        const endSample = totalSamples;

        dispatchLiveChunk(startSample, endSample, chunkIdx);
      }
    }, 200);

    setStatus(`🎙️ Live Dictation active (${model}). Speak clearly...`);
  }, [stopAudio, dispatchLiveChunk]);

  const pauseSession = useCallback(() => {
    setIsPaused(true);
    pauseStartTimeRef.current = Date.now();
    setStatus('Live dictation paused.');
    if (audioContextRef.current && audioContextRef.current.state === 'running') {
      try { audioContextRef.current.suspend(); } catch (e) {}
    }
    setAudioLevel(0);
  }, []);

  const resumeSession = useCallback(() => {
    if (pauseStartTimeRef.current > 0) {
      accumulatedPauseDurationRef.current += Date.now() - pauseStartTimeRef.current;
      pauseStartTimeRef.current = 0;
    }
    setIsPaused(false);
    setStatus(`🎙️ Live Dictation Active (${selectedModelRef.current}). Listening...`);
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      try { audioContextRef.current.resume(); } catch (e) {}
    }
  }, []);

  const stopSession = useCallback(async () => {
    setIsSessionActive(false);
    isSessionActiveRef.current = false;
    setIsPaused(false);

    if (schedulerIntervalRef.current) {
      clearInterval(schedulerIntervalRef.current);
      schedulerIntervalRef.current = null;
    }

    // Wait if a chunk is currently in flight
    if (isProcessingChunkRef.current) {
      setStatus('Finalizing active audio clause...');
      let waitCount = 0;
      while (isProcessingChunkRef.current && waitCount < 30) {
        await new Promise(r => setTimeout(r, 100));
        waitCount++;
      }
    }

    // Process any remaining un-sent audio segment (> 0.8s) ONLY if speech is detected
    const totalSamples = totalSamplesCountRef.current;
    const unprocessedSamples = totalSamples - lastProcessedSampleRef.current;

    if (unprocessedSamples > 12000 && recordedPcmChunksRef.current.length > 0) {
      const startSample = Math.max(0, lastProcessedSampleRef.current - 4000);
      const endSample = totalSamples;
      const vadMetrics = analyzePcmEnergy(recordedPcmChunksRef.current, startSample, endSample);

      if (vadMetrics.hasSpeech) {
        setStatus(`Finalizing remaining clinical speech with ${selectedModelRef.current || 'gemini-3.7-flash'}...`);
        const finalChunkBlob = pcmRangeToWavBlob(recordedPcmChunksRef.current, startSample, endSample, 16000);

        const historyContext: LiveHistoryContext = {
          previousState: historyStackRef.current.length > 0
            ? historyStackRef.current[historyStackRef.current.length - 1].findings
            : [],
          deletedItems: lastDeletedItemsRef.current || [],
        };

        try {
          const finalResult = await processLiveAudioChunk(
            finalChunkBlob,
            selectedModelRef.current || 'gemini-3.7-flash',
            committedFindingsRef.current,
            currentChunkIndexRef.current,
            customPromptRef.current,
            (failedModel, nextModel) => {
              setStatus(`⚡ Finalizing: Switched to ${nextModel}...`);
            },
            historyContext
          );
          const finalFindings = Array.isArray(finalResult) ? finalResult : finalResult.findings;
          if (Array.isArray(finalFindings) && finalFindings.length > 0) {
            committedFindingsRef.current = finalFindings;
          }
        } catch (e) {
          console.warn('Final audio chunk processing notice:', e);
        }
      }
    }

    // Comprehensive Holistic Synthesis Pass:
    // Review entire report end-to-end to eliminate redundancies across chunk boundaries,
    // standardize anatomical terminology, and construct a cohesive, authoritative IMPRESSION.
    if (committedFindingsRef.current.length > 0) {
      setStatus(`Harmonizing and reviewing comprehensive radiology report with ${selectedModelRef.current}...`);
      try {
        const synthesizedReport = await synthesizeLiveReport(
          committedFindingsRef.current,
          selectedModelRef.current || 'gemini-3.7-flash',
          customPromptRef.current
        );
        if (Array.isArray(synthesizedReport) && synthesizedReport.length > 0) {
          committedFindingsRef.current = synthesizedReport;
        }
      } catch (synthErr) {
        console.warn('Final report synthesis notice:', synthErr);
      }
    }

    emitFindings();

    // Create high-fidelity 16kHz WAV Blob from all recorded PCM chunks
    let finalAudioBlob: Blob | null = null;
    if (recordedPcmChunksRef.current.length > 0) {
      finalAudioBlob = pcmToWavBlob(recordedPcmChunksRef.current, 16000);
    }

    stopAudio();
    stopRepeatingInterruptedAlert();
    setStatus('Live dictation complete.');

    return {
      transcript: committedFindingsRef.current.join('\n'),
      audioBlob: finalAudioBlob,
    };
  }, [stopAudio, emitFindings]);

  useEffect(() => {
    return () => {
      stopAudio();
      stopRepeatingInterruptedAlert();
    };
  }, [stopAudio]);

  return {
    status,
    error,
    isSessionActive,
    isPaused,
    audioLevel,
    startSession,
    stopSession,
    pauseSession,
    resumeSession,
    syncFindings,
    syncCustomPrompt,
  };
};


