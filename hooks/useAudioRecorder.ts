import { useState, useRef, useCallback, useEffect } from 'react';
import {
  saveActiveSession,
  clearActiveSession,
  saveCompletedRecording,
  getUnsavedActiveSession,
  UnsavedSession,
} from '../services/audioStorage';
import {
  startRepeatingInterruptedAlert,
  stopRepeatingInterruptedAlert,
  unlockAudioContext,
} from '../services/soundService';

type AudioRecorderResult = {
  isRecording: boolean;
  isPaused: boolean;
  isRequestingMic: boolean;
  recordingDuration: number;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  error: string | null;
  interruptedNotice: string | null;
  clearInterruptedNotice: () => void;
  unsavedSession: UnsavedSession | null;
  getUnsavedSessionBlob: () => Blob | null;
  recoverUnsavedSession: () => Promise<Blob | null>;
  discardUnsavedSession: () => Promise<void>;
};

/**
 * Creates an inline Web Worker ticker that runs immune to Chrome background/minimized tab throttling.
 */
function createBackgroundWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    const workerScript = `
      let timer = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (timer) clearInterval(timer);
          timer = setInterval(function() {
            self.postMessage('tick');
          }, 1000);
        } else if (e.data === 'stop') {
          if (timer) clearInterval(timer);
          timer = null;
        }
      };
    `;
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  } catch (err) {
    console.debug('Background worker creation failed:', err);
    return null;
  }
}

export const useAudioRecorder = (): AudioRecorderResult => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isRequestingMic, setIsRequestingMic] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [interruptedNotice, setInterruptedNotice] = useState<string | null>(null);
  const [unsavedSession, setUnsavedSession] = useState<UnsavedSession | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>('');
  const streamRef = useRef<MediaStream | null>(null);
  const sessionStartTimeRef = useRef<number>(Date.now());
  const isUserInitiatedStopRef = useRef<boolean>(false);
  const isRecordingRef = useRef<boolean>(false);
  const isPausedRef = useRef<boolean>(false);
  const lastChunkTimestampRef = useRef<number>(Date.now());
  const hasAlertedUnsavedRef = useRef<boolean>(false);
  const workerRef = useRef<Worker | null>(null);
  const fallbackIntervalRef = useRef<any>(null);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  // Check for unsaved session on hook load, playing alert if an interrupted session was detected
  const checkUnsavedSession = useCallback(async () => {
    try {
      let session = await getUnsavedActiveSession();
      if (!session && typeof window !== 'undefined' && localStorage.getItem('has_unsaved_session')) {
        await new Promise(r => setTimeout(r, 300));
        session = await getUnsavedActiveSession();
      }
      if (session && session.chunks.length > 0 && session.totalBytes > 0) {
        setUnsavedSession(session);
        // Alert the user immediately and repeat every 10 seconds until an option is selected
        if (!hasAlertedUnsavedRef.current) {
          hasAlertedUnsavedRef.current = true;
          startRepeatingInterruptedAlert(10000);
        }
      } else {
        setUnsavedSession(null);
      }
    } catch (err) {
      console.warn('Error checking unsaved audio session:', err);
    }
  }, []);

  useEffect(() => {
    checkUnsavedSession();
  }, [checkUnsavedSession]);

  // Warn user before refreshing/closing tab while recording
  useEffect(() => {
    if (!isRecording) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'An audio dictation is currently recording. Leaving will stop the recording.';
      return e.returnValue;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isRecording]);

  const handleUnexpectedStop = useCallback(async (reason: string) => {
    if (isUserInitiatedStopRef.current) return;
    console.warn('Recording stopped unexpectedly:', reason);

    // Stop workers & timers
    if (workerRef.current) {
      workerRef.current.postMessage('stop');
    }
    if (fallbackIntervalRef.current) {
      clearInterval(fallbackIntervalRef.current);
      fallbackIntervalRef.current = null;
    }

    // 1. Play alert chime immediately and repeat every 10 seconds until an action is selected
    startRepeatingInterruptedAlert(10000);

    // 2. Save accumulated chunks to IndexedDB to ensure zero data loss
    const currentChunks = [...audioChunksRef.current];
    if (currentChunks.length > 0) {
      const savedBlob = new Blob(currentChunks, { type: mimeTypeRef.current || 'audio/webm' });
      await saveActiveSession(currentChunks, mimeTypeRef.current || 'audio/webm', sessionStartTimeRef.current);
      await saveCompletedRecording(savedBlob, mimeTypeRef.current || 'audio/webm');
      setUnsavedSession({
        timestamp: sessionStartTimeRef.current,
        mimeType: mimeTypeRef.current || 'audio/webm',
        chunks: currentChunks,
        totalBytes: savedBlob.size,
      });
    }

    // 3. Clean up tracks and reset state
    streamRef.current?.getTracks().forEach(track => {
      try { track.stop(); } catch (e) {}
    });
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setIsPaused(false);

    setInterruptedNotice(
      `Dictation stopped (${reason}). An alert sound was played, and your audio has been preserved in storage.`
    );
  }, []);

  // Worker-based un-throttled watchdog and timer
  useEffect(() => {
    if (!isRecording) {
      if (workerRef.current) {
        workerRef.current.postMessage('stop');
      }
      if (fallbackIntervalRef.current) {
        clearInterval(fallbackIntervalRef.current);
        fallbackIntervalRef.current = null;
      }
      return;
    }

    const worker = createBackgroundWorker();
    workerRef.current = worker;

    const handleTick = () => {
      if (!isRecordingRef.current || isUserInitiatedStopRef.current) return;

      // Update timer when not paused
      if (!isPausedRef.current) {
        setRecordingDuration(prev => prev + 1);
      }

      // Watchdog checks that execute reliably even when minimized:
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === 'inactive' &&
        !isUserInitiatedStopRef.current
      ) {
        handleUnexpectedStop('Browser paused or ended recording in background');
        return;
      }

      // Check if tracks ended or were muted
      if (streamRef.current) {
        const tracks = streamRef.current.getAudioTracks();
        const hasEndedTrack = tracks.some(t => t.readyState === 'ended');
        if (hasEndedTrack) {
          handleUnexpectedStop('Microphone disconnected or track ended');
          return;
        }
      }

      // Stalled chunk check (if active, not paused, and no audio chunk arrived for > 7s)
      if (!isPausedRef.current && Date.now() - lastChunkTimestampRef.current > 7000) {
        handleUnexpectedStop('Audio input stalled or ceased producing audio chunks');
        return;
      }
    };

    if (worker) {
      worker.onmessage = (e) => {
        if (e.data === 'tick') {
          handleTick();
        }
      };
      worker.postMessage('start');
    } else {
      fallbackIntervalRef.current = setInterval(handleTick, 1000);
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.postMessage('stop');
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (fallbackIntervalRef.current) {
        clearInterval(fallbackIntervalRef.current);
        fallbackIntervalRef.current = null;
      }
    };
  }, [isRecording, handleUnexpectedStop]);

  const clearInterruptedNotice = useCallback(() => {
    setInterruptedNotice(null);
    stopRepeatingInterruptedAlert();
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    setInterruptedNotice(null);
    stopRepeatingInterruptedAlert();
    setIsRequestingMic(true);
    isUserInitiatedStopRef.current = false;
    lastChunkTimestampRef.current = Date.now();
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      console.warn("Recording is already in progress.");
      setIsRequestingMic(false);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg = "Audio recording is not supported in this browser environment.";
      setError(msg);
      setIsRequestingMic(false);
      throw new Error(msg);
    }

    // Stop any stale tracks
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach(track => track.stop());
      } catch (e) {}
      streamRef.current = null;
    }

    try {
      clearActiveSession().catch(e => console.warn('Failed to clear active session:', e));
      setUnsavedSession(null);

      // Pre-warm audio contexts and request notification permissions while on user click
      unlockAudioContext();
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }

      sessionStartTimeRef.current = Date.now();

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        });
      } catch (firstErr) {
        console.warn("Advanced audio constraints failed, retrying standard constraints:", firstErr);
        await new Promise(r => setTimeout(r, 150));
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      streamRef.current = stream;
      audioChunksRef.current = [];
      lastChunkTimestampRef.current = Date.now();

      // Monitor audio tracks for disconnections and mute events
      stream.getAudioTracks().forEach(track => {
        track.addEventListener('ended', () => {
          if (!isUserInitiatedStopRef.current && isRecordingRef.current) {
            handleUnexpectedStop('Microphone disconnected or track ended');
          }
        });
        track.addEventListener('mute', () => {
          if (!isUserInitiatedStopRef.current && isRecordingRef.current) {
            handleUnexpectedStop('Microphone muted by OS or hardware');
          }
        });
      });
      
      const MimeTypes = [
        'audio/webm; codecs=opus',
        'audio/ogg; codecs=opus',
        'audio/webm',
        'audio/ogg',
        'audio/mp4',
        'audio/aac',
      ];
      const supportedMimeType = MimeTypes.find(type => MediaRecorder.isTypeSupported(type));
      const options = supportedMimeType ? { mimeType: supportedMimeType } : undefined;
      mimeTypeRef.current = options?.mimeType || 'audio/webm';

      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.addEventListener("dataavailable", (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          lastChunkTimestampRef.current = Date.now();
          audioChunksRef.current.push(event.data);
          saveActiveSession(audioChunksRef.current, mimeTypeRef.current, sessionStartTimeRef.current).catch((e) =>
            console.warn('Failed to auto-save active recording session:', e)
          );
        }
      });

      mediaRecorder.addEventListener('stop', () => {
        if (!isUserInitiatedStopRef.current && isRecordingRef.current) {
          handleUnexpectedStop('Recording session ended unexpectedly');
        }
      });

      mediaRecorder.addEventListener('error', (event) => {
        console.error('MediaRecorder error event:', event);
        if (!isUserInitiatedStopRef.current && isRecordingRef.current) {
          handleUnexpectedStop('Audio hardware error during recording');
        }
      });

      // Start recording with 1000ms timeslice to ensure continuous data output
      mediaRecorder.start(1000);
      setIsRecording(true);
      setIsPaused(false);
      setIsRequestingMic(false);
      setRecordingDuration(0);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setIsRequestingMic(false);
      setIsRecording(false);

      let errorMessage = "Could not access the microphone. Please check your microphone connection.";
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          errorMessage = "Microphone permission denied. Please allow microphone access in your browser settings.";
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          errorMessage = "No microphone detected. Please check if your microphone is securely plugged in.";
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          errorMessage = "Microphone is busy or in use by another tab/app. Please close other audio apps or refresh.";
        } else if (err.message) {
          errorMessage = err.message;
        }
      }

      setError(errorMessage);
      throw new Error(errorMessage);
    }
  }, [handleUnexpectedStop]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
    }
  }, []);

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      lastChunkTimestampRef.current = Date.now();
    }
  }, []);

  const stopRecording = useCallback((): Promise<Blob> => {
    isUserInitiatedStopRef.current = true;
    stopRepeatingInterruptedAlert();

    if (workerRef.current) {
      workerRef.current.postMessage('stop');
    }
    if (fallbackIntervalRef.current) {
      clearInterval(fallbackIntervalRef.current);
      fallbackIntervalRef.current = null;
    }

    return new Promise((resolve, reject) => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        const recorder = mediaRecorderRef.current;

        const cleanupAndSetState = async () => {
          streamRef.current?.getTracks().forEach(track => {
            try { track.stop(); } catch (e) {}
          });
          streamRef.current = null;
          mediaRecorderRef.current = null;
          setIsRecording(false);
          setIsPaused(false);
        };
        
        recorder.addEventListener("stop", async () => {
          const newAudioBlob = new Blob(audioChunksRef.current, { type: mimeTypeRef.current });
          await cleanupAndSetState();
          await saveCompletedRecording(newAudioBlob, mimeTypeRef.current);
          await clearActiveSession();
          setUnsavedSession(null);
          resolve(newAudioBlob);
        }, { once: true });

        recorder.addEventListener("error", async (event) => {
          console.error("MediaRecorder error:", event);
          await cleanupAndSetState();
          reject(new Error("An error occurred during recording."));
        }, { once: true });

        try {
          recorder.stop();
        } catch (stopErr) {
          console.warn('Error during recorder.stop():', stopErr);
          cleanupAndSetState().then(() => {
            const fallbackBlob = new Blob(audioChunksRef.current, { type: mimeTypeRef.current });
            resolve(fallbackBlob);
          });
        }
      } else {
        const fallbackBlob = new Blob(audioChunksRef.current, { type: mimeTypeRef.current });
        setIsRecording(false);
        setIsPaused(false);
        resolve(fallbackBlob);
      }
    });
  }, []);

  const getUnsavedSessionBlob = useCallback((): Blob | null => {
    if (!unsavedSession || unsavedSession.chunks.length === 0) return null;
    return new Blob(unsavedSession.chunks, { type: unsavedSession.mimeType || 'audio/webm' });
  }, [unsavedSession]);

  const recoverUnsavedSession = useCallback(async (): Promise<Blob | null> => {
    stopRepeatingInterruptedAlert();
    if (!unsavedSession || unsavedSession.chunks.length === 0) return null;
    const recoveredBlob = new Blob(unsavedSession.chunks, { type: unsavedSession.mimeType || 'audio/webm' });
    await saveCompletedRecording(recoveredBlob, unsavedSession.mimeType);
    await clearActiveSession();
    setUnsavedSession(null);
    setInterruptedNotice(null);
    return recoveredBlob;
  }, [unsavedSession]);

  const discardUnsavedSession = useCallback(async () => {
    stopRepeatingInterruptedAlert();
    await clearActiveSession();
    setUnsavedSession(null);
    setInterruptedNotice(null);
  }, []);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.postMessage('stop');
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (fallbackIntervalRef.current) {
        clearInterval(fallbackIntervalRef.current);
        fallbackIntervalRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch (e) {}
      }
      streamRef.current?.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      stopRepeatingInterruptedAlert();
    };
  }, []);

  return {
    isRecording,
    isPaused,
    isRequestingMic,
    recordingDuration,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    error,
    interruptedNotice,
    clearInterruptedNotice,
    unsavedSession,
    getUnsavedSessionBlob,
    recoverUnsavedSession,
    discardUnsavedSession,
  };
};
