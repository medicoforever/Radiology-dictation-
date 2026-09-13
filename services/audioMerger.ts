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
      const audioBuffers = await Promise.all(
        arrayBuffers.map(ab => audioCtx.decodeAudioData(ab.slice(0)))
      );

      const targetSampleRate = audioBuffers[0].sampleRate;
      let targetChannels = 1;
      for (const buf of audioBuffers) {
        if (buf.numberOfChannels > targetChannels) {
          targetChannels = buf.numberOfChannels;
        }
      }

      // Calculate total sample length taking resampling into account
      const resampledLengths = audioBuffers.map(buf => {
        return buf.sampleRate === targetSampleRate
          ? buf.length
          : Math.round(buf.length * (targetSampleRate / buf.sampleRate));
      });

      const totalSamples = resampledLengths.reduce((acc, len) => acc + len, 0);
      const mergedBuffer = audioCtx.createBuffer(targetChannels, totalSamples, targetSampleRate);

      for (let channel = 0; channel < targetChannels; channel++) {
        const out = mergedBuffer.getChannelData(channel);
        let offset = 0;

        for (let i = 0; i < audioBuffers.length; i++) {
          const buf = audioBuffers[i];
          const srcChannelData = buf.getChannelData(Math.min(channel, buf.numberOfChannels - 1));
          const targetLen = resampledLengths[i];

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
