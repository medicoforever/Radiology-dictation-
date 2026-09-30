/**
 * Audio Merging Service
 * Decodes multiple audio blobs (WebM, WAV, MP3, OGG) using Web Audio API
 * and produces a clean, universally playable 16-bit PCM WAV audio file.
 * Falls back to Blob concatenation if audio decoding is unsupported or fails.
 */

/**
 * Merges two audio blobs sequentially into a single unified audio file.
 */
export async function mergeAudioBlobs(blob1: Blob, blob2: Blob): Promise<Blob> {
  return mergeMultipleAudioBlobs([blob1, blob2]);
}

/**
 * Trims leading and trailing padding silence from an AudioBuffer using window-based RMS energy analysis.
 * This directly and reliably eliminates the Chromium MediaRecorder WebM timestamp offset bug,
 * where AudioContext.decodeAudioData prepends hours or minutes of padding silence
 * (causing 290MB+ file bloat) because WebM clusters use uptime/performance timestamps.
 */
function trimAudioBufferSilence(
  audioCtx: AudioContext,
  buffer: AudioBuffer,
  paddingSec = 0.2
): AudioBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const totalLength = buffer.length;

  if (totalLength === 0) return buffer;

  // Window size: ~30ms (e.g. 1440 samples at 48kHz, 720 at 24kHz)
  const windowSize = Math.max(256, Math.round(0.03 * sampleRate));
  const numWindows = Math.floor(totalLength / windowSize);

  if (numWindows === 0) return buffer;

  // Extract channel pointers
  const chData: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    chData.push(buffer.getChannelData(ch));
  }

  // Compute RMS energy for each 30ms window (downmixed to mono for energy measurement)
  const windowRms = new Float32Array(numWindows);
  let peakRms = 0;

  for (let w = 0; w < numWindows; w++) {
    const offset = w * windowSize;
    let sumSquares = 0;
    for (let i = 0; i < windowSize; i++) {
      let sample = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sample += chData[ch][offset + i];
      }
      sample /= numChannels;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / windowSize);
    windowRms[w] = rms;
    if (rms > peakRms) {
      peakRms = rms;
    }
  }

  // If the entire buffer is extremely quiet (peak RMS < 0.003), keep at most 2 seconds of audio
  if (peakRms < 0.003) {
    const fallbackLength = Math.min(totalLength, sampleRate * 2);
    // In Chromium WebM bug, if there is a long buffer, speech is located at the end
    const startSample = Math.max(0, totalLength - fallbackLength);
    const fallbackBuf = audioCtx.createBuffer(numChannels, fallbackLength, sampleRate);
    for (let ch = 0; ch < numChannels; ch++) {
      fallbackBuf.getChannelData(ch).set(buffer.getChannelData(ch).subarray(startSample, startSample + fallbackLength));
    }
    return fallbackBuf;
  }

  // Speech threshold: at least 0.006 (-44 dBFS), or 12% of peak speech level (whichever is higher)
  // This cleanly rejects ambient noise floor, decoder priming transients, and DC offsets
  const speechThreshold = Math.max(0.006, Math.min(0.035, peakRms * 0.12));

  // Find first active window: require 2 consecutive windows above threshold to ignore transient clicks/startup pops
  let firstActiveWin = -1;
  for (let w = 0; w < numWindows; w++) {
    if (windowRms[w] >= speechThreshold) {
      if (w + 1 < numWindows && windowRms[w + 1] >= speechThreshold * 0.65) {
        firstActiveWin = w;
        break;
      }
    }
  }

  // Find last active window from the end: require 2 consecutive windows above threshold
  let lastActiveWin = -1;
  for (let w = numWindows - 1; w >= 0; w--) {
    if (windowRms[w] >= speechThreshold) {
      if (w > 0 && windowRms[w - 1] >= speechThreshold * 0.65) {
        lastActiveWin = w;
        break;
      }
    }
  }

  // If strict consecutive check failed (e.g. very brief sound), fallback to single window check
  if (firstActiveWin === -1 || lastActiveWin === -1 || firstActiveWin > lastActiveWin) {
    for (let w = 0; w < numWindows; w++) {
      if (windowRms[w] >= 0.004) {
        firstActiveWin = w;
        break;
      }
    }
    for (let w = numWindows - 1; w >= 0; w--) {
      if (windowRms[w] >= 0.004) {
        lastActiveWin = w;
        break;
      }
    }
  }

  if (firstActiveWin === -1 || lastActiveWin === -1 || firstActiveWin > lastActiveWin) {
    return buffer;
  }

  const paddingSamples = Math.round(paddingSec * sampleRate);
  const startSample = Math.max(0, firstActiveWin * windowSize - paddingSamples);
  const endSample = Math.min(totalLength - 1, (lastActiveWin + 1) * windowSize + paddingSamples);
  const trimmedLength = endSample - startSample + 1;

  if (trimmedLength >= totalLength) {
    return buffer;
  }

  const trimmedBuffer = audioCtx.createBuffer(numChannels, trimmedLength, sampleRate);
  for (let ch = 0; ch < numChannels; ch++) {
    trimmedBuffer.getChannelData(ch).set(
      buffer.getChannelData(ch).subarray(startSample, endSample + 1)
    );
  }

  return trimmedBuffer;
}

/**
 * Merges an array of audio blobs sequentially into a single unified audio file (WAV).
 */
export async function mergeMultipleAudioBlobs(blobs: Blob[]): Promise<Blob> {
  const validBlobs = blobs.filter(b => b && b.size > 0);
  if (validBlobs.length === 0) return new Blob([], { type: 'audio/webm' });
  if (validBlobs.length === 1) return validBlobs[0];

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) {
      return new Blob(validBlobs, { type: validBlobs[0].type || 'audio/webm' });
    }

    const audioCtx = new AudioContextClass();
    try {
      const arrayBuffers = await Promise.all(validBlobs.map(b => b.arrayBuffer()));
      const rawAudioBuffers = await Promise.all(
        arrayBuffers.map(ab => audioCtx.decodeAudioData(ab.slice(0)))
      );

      // Trim leading/trailing padding silence caused by Chromium timestamp offset bug
      const audioBuffers = rawAudioBuffers.map(buf => trimAudioBufferSilence(audioCtx, buf));

      // Voice dictation standard: 24,000 Hz 1-channel (mono) provides crystal-clear medical voice
      // quality while keeping merged WAV files extremely compact (< 1MB for typical dictations)
      const targetSampleRate = Math.min(audioBuffers[0].sampleRate, 24000);
      const targetChannels = 1;

      // Calculate total sample length taking resampling into account
      const resampledLengths = audioBuffers.map(buf => {
        return buf.sampleRate === targetSampleRate
          ? buf.length
          : Math.round(buf.length * (targetSampleRate / buf.sampleRate));
      });

      const totalSamples = resampledLengths.reduce((acc, len) => acc + len, 0);
      const mergedBuffer = audioCtx.createBuffer(targetChannels, totalSamples, targetSampleRate);

      const out = mergedBuffer.getChannelData(0);
      let offset = 0;

      for (let i = 0; i < audioBuffers.length; i++) {
        const buf = audioBuffers[i];
        const targetLen = resampledLengths[i];
        const numSrcChannels = buf.numberOfChannels;

        // Downmix or copy to mono channel
        let srcChannelData: Float32Array;
        if (numSrcChannels === 1) {
          srcChannelData = buf.getChannelData(0);
        } else {
          // Average channels to mono
          const ch0 = buf.getChannelData(0);
          const ch1 = buf.getChannelData(1);
          srcChannelData = new Float32Array(buf.length);
          for (let s = 0; s < buf.length; s++) {
            srcChannelData[s] = (ch0[s] + ch1[s]) * 0.5;
          }
        }

        if (buf.sampleRate === targetSampleRate) {
          out.set(srcChannelData, offset);
        } else {
          // Linear interpolation resampling
          const ratio = buf.sampleRate / targetSampleRate;
          for (let s = 0; s < targetLen; s++) {
            const srcIdx = s * ratio;
            const idx0 = Math.floor(srcIdx);
            const idx1 = Math.min(idx0 + 1, buf.length - 1);
            const weight = srcIdx - idx0;
            out[offset + s] = (1 - weight) * (srcChannelData[idx0] || 0) + weight * (srcChannelData[idx1] || 0);
          }
        }
        offset += targetLen;
      }

      return audioBufferToWavBlob(mergedBuffer);
    } finally {
      if (audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
    }
  } catch (err) {
    console.warn('AudioContext merge failed, falling back to container concatenation:', err);
    return new Blob(validBlobs, { type: validBlobs[0].type || 'audio/webm' });
  }
}

/**
 * Encodes an AudioBuffer into standard 16-bit PCM WAV format.
 */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const length = buffer.length * numChannels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + length);
  const view = new DataView(arrayBuffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, length, true);

  // Write samples
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Triggers browser download of an audio blob with appropriate filename and extension.
 */
export function triggerAudioDownload(blob: Blob, baseName: string = 'radiology-dictation'): void {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    document.body.appendChild(a);
    a.style.display = 'none';
    a.href = url;

    const ext = blob.type === 'audio/wav'
      ? 'wav'
      : blob.type === 'audio/mpeg' || blob.type === 'audio/mp3'
      ? 'mp3'
      : blob.type.includes('ogg')
      ? 'ogg'
      : 'webm';

    a.download = `${baseName}.${ext}`;
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
  } catch (err) {
    console.error('Failed to trigger audio download:', err);
  }
}
