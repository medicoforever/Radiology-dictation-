// Audio Notification and Alert Service for Radiology Dictation
// Dedicated alert engine for interrupted recording errors styled after
// the standard, pleasant Windows notification chime (E5 -> B5 -> E6).
// Operates reliably even when the browser is minimized or in a background tab.

let audioCtx: AudioContext | null = null;
let cachedAudioElement: HTMLAudioElement | null = null;
let titleBlinkerInterval: any = null;
let originalPageTitle: string = '';

/**
 * Generates a standard, pleasant Windows-style notification chime WAV as a base64 Data URI.
 * Uses a classic 3-tone ascending major bell arpeggio:
 * E5 (659.25 Hz) -> B5 (987.77 Hz) -> E6 (1318.51 Hz)
 * with a soft, natural acoustic bell envelope (sine wave with gentle harmonics).
 */
function createWindowsNotificationWavDataUri(): string {
  const sampleRate = 44100;
  const notes = [
    { freq: 659.25, duration: 0.085, decayRate: 10.0 }, // E5
    { freq: 987.77, duration: 0.095, decayRate: 9.0 },  // B5
    { freq: 1318.51, duration: 0.380, decayRate: 5.5 }, // E6 (lingers softly)
  ];

  let totalDuration = 0;
  for (const n of notes) totalDuration += n.duration;
  const totalSamples = Math.floor(sampleRate * totalDuration);

  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF container header
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1 = mono)
  view.setUint32(24, sampleRate, true); // SampleRate (44.1 kHz for crisp bell quality)
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample (16-bit)
  writeString(36, 'data');
  view.setUint32(40, totalSamples * 2, true);

  let sampleOffset = 0;
  for (const note of notes) {
    const noteSamples = Math.floor(sampleRate * note.duration);
    const attackSamples = Math.floor(sampleRate * 0.005); // 5ms soft click-free attack

    for (let i = 0; i < noteSamples && (sampleOffset + i) < totalSamples; i++) {
      const noteT = i / sampleRate;
      let env = 1.0;

      // Soft attack ramp to eliminate clicks
      if (i < attackSamples) {
        env = i / attackSamples;
      } else {
        // Natural exponential decay matching acoustic bells
        env = Math.exp(-noteT * note.decayRate);
      }

      const t = (sampleOffset + i) / sampleRate;
      // Windows chime timbre: Pure fundamental sine + soft warm 2nd harmonic + subtle 3rd
      const f1 = Math.sin(2 * Math.PI * note.freq * t);
      const f2 = 0.22 * Math.sin(2 * Math.PI * (note.freq * 2) * t);
      const f3 = 0.06 * Math.sin(2 * Math.PI * (note.freq * 3) * t);
      const wave = (f1 + f2 + f3) * 0.78;

      const sampleVal = Math.floor(wave * env * 26000);
      view.setInt16(44 + (sampleOffset + i) * 2, sampleVal, true);
    }
    sampleOffset += noteSamples;
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 8192) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + 8192, len)))
    );
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

/**
 * Returns or creates the pre-loaded HTMLAudioElement for instant background playback.
 */
function getAlertAudioElement(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!cachedAudioElement) {
    try {
      const dataUri = createWindowsNotificationWavDataUri();
      cachedAudioElement = new Audio(dataUri);
      cachedAudioElement.volume = 1.0;
      cachedAudioElement.preload = 'auto';
    } catch (err) {
      console.debug('Failed to construct alert Audio element:', err);
    }
  }
  return cachedAudioElement;
}

/**
 * Gets or initializes the Web Audio API AudioContext.
 */
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch (err) {
    console.debug('Failed to initialize AudioContext:', err);
    return null;
  }
}

/**
 * Pre-warms and unlocks audio playback mechanisms on user gesture (e.g. clicking Record).
 * This ensures that subsequent alerts in minimized or background tabs bypass autoplay restrictions.
 */
export function unlockAudioContext(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const audio = getAlertAudioElement();
    if (audio) {
      audio.load();
    }
  } catch {}
}

/**
 * Plays a pleasant, smooth bell tone via Web Audio API.
 */
function playChimeNote(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
  volume = 0.35
): void {
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    // Fast soft attack, smooth natural exponential decay
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  } catch (err) {
    console.debug('Failed to play chime note:', err);
  }
}

/**
 * Plays the standard Windows notification chime specifically when an audio recording
 * is interrupted or an unsaved session is detected.
 *
 * Uses dual-pipeline output (HTML5 Audio + Web Audio API) to ensure playback
 * succeeds even if the browser is minimized, hidden behind another app, or throttling timers.
 */
export function playRecordingInterruptedSound(): void {
  let htmlAudioPlayed = false;

  // Pipeline 1: HTML5 Audio Element (reliable when tab/browser is minimized)
  try {
    const audio = getAlertAudioElement();
    if (audio) {
      audio.currentTime = 0;
      audio.volume = 1.0;
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            htmlAudioPlayed = true;
          })
          .catch((err) => {
            console.debug('HTMLAudioElement play fallback triggering Web Audio:', err);
            playWebAudioChimeFallback();
          });
      }
    }
  } catch (err) {
    console.debug('Pipeline 1 audio element error:', err);
  }

  // Helper for Web Audio API chime synthesis
  const playWebAudioChimeFallback = () => {
    try {
      const ctx = getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        const now = ctx.currentTime + 0.01;
        playChimeNote(ctx, 659.25, now, 0.085, 0.40);       // E5
        playChimeNote(ctx, 987.77, now + 0.085, 0.095, 0.40); // B5
        playChimeNote(ctx, 1318.51, now + 0.180, 0.380, 0.45); // E6
      }
    } catch (err) {
      console.debug('Web Audio chime error:', err);
    }
  };

  // If HTML audio takes longer than 60ms to confirm play or was blocked, trigger Web Audio
  setTimeout(() => {
    if (!htmlAudioPlayed) {
      playWebAudioChimeFallback();
    }
  }, 60);

  // Visual Alert: Flash document title so Windows/OS taskbar flashes amber/yellow
  startTitleAlert('⚠️ RECORDING INTERRUPTED!');

  // Desktop notification if minimized and permission was granted
  if (
    typeof document !== 'undefined' &&
    document.hidden &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    try {
      new Notification('⚠️ Dictation Interrupted', {
        body: 'Audio recording stopped unexpectedly. Auto-saved backup is available to restore.',
        requireInteraction: true,
      });
    } catch {}
  }
}

let repeatingAlertTimer: any = null;
let repeatingAlertWorker: Worker | null = null;

function createRepeatingWorkerTimer(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    const script = `
      let timer = null;
      self.onmessage = function(e) {
        if (e.data && e.data.action === 'start') {
          if (timer) clearInterval(timer);
          timer = setInterval(function() {
            self.postMessage('trigger');
          }, e.data.interval || 10000);
        } else if (e.data && e.data.action === 'stop') {
          if (timer) clearInterval(timer);
          timer = null;
        }
      };
    `;
    const blob = new Blob([script], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  } catch {
    return null;
  }
}

/**
 * Plays the Windows alert sound repeatedly at a specified interval (default: 10 seconds)
 * until one of the recovery actions is selected (Discard Backup, Save File, or Restore & Transcribe).
 * Uses a dedicated Web Worker timer so that minimized background tabs are NOT throttled by the browser.
 */
export function startRepeatingInterruptedAlert(intervalMs = 10000): void {
  // Prevent duplicate concurrent timers
  stopRepeatingInterruptedAlert();

  // 1. Play first chime immediately
  playRecordingInterruptedSound();

  // 2. Schedule recurring chimes every 10 seconds
  try {
    const worker = createRepeatingWorkerTimer();
    if (worker) {
      repeatingAlertWorker = worker;
      worker.onmessage = (e) => {
        if (e.data === 'trigger') {
          playRecordingInterruptedSound();
        }
      };
      worker.postMessage({ action: 'start', interval: intervalMs });
    } else {
      repeatingAlertTimer = setInterval(() => {
        playRecordingInterruptedSound();
      }, intervalMs);
    }
  } catch (err) {
    repeatingAlertTimer = setInterval(() => {
      playRecordingInterruptedSound();
    }, intervalMs);
  }
}

/**
 * Stops the 10-second recurring alert chime and resets visual title flashing.
 * Called as soon as the user selects any option: Discard Backup, Save File, or Restore & Transcribe.
 */
export function stopRepeatingInterruptedAlert(): void {
  if (repeatingAlertWorker) {
    try {
      repeatingAlertWorker.postMessage({ action: 'stop' });
      repeatingAlertWorker.terminate();
    } catch {}
    repeatingAlertWorker = null;
  }
  if (repeatingAlertTimer) {
    clearInterval(repeatingAlertTimer);
    repeatingAlertTimer = null;
  }
  stopTitleAlert();
}

/**
 * Normal recording start tone — intentionally no-op per user requirement:
 * "for this kind of error only, i want the audio alert."
 */
export function playRecordingStartSound(): void {
  // Silent on normal start
}

/**
 * Normal recording stop tone — intentionally no-op per user requirement:
 * "for this kind of error only, i want the audio alert."
 */
export function playRecordingStopSound(): void {
  // Silent on normal stop
}

/**
 * Starts flashing the document title to visually alert the user in the OS taskbar.
 */
export function startTitleAlert(alertText = '⚠️ RECORDING INTERRUPTED!'): void {
  if (typeof document === 'undefined') return;
  if (!originalPageTitle) {
    originalPageTitle = document.title;
  }
  if (titleBlinkerInterval) {
    clearInterval(titleBlinkerInterval);
  }
  let toggle = false;
  titleBlinkerInterval = setInterval(() => {
    document.title = toggle ? alertText : '⚠️ RESTORE DICTATION';
    toggle = !toggle;
  }, 1000);

  const handleClear = () => {
    stopTitleAlert();
    window.removeEventListener('focus', handleClear);
    document.removeEventListener('click', handleClear);
  };
  window.addEventListener('focus', handleClear);
  document.addEventListener('click', handleClear);
}

/**
 * Restores original document title.
 */
export function stopTitleAlert(): void {
  if (titleBlinkerInterval) {
    clearInterval(titleBlinkerInterval);
    titleBlinkerInterval = null;
  }
  if (originalPageTitle && typeof document !== 'undefined') {
    document.title = originalPageTitle;
  }
}

