
import React, { useRef, useState, useEffect } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { AppStatus } from '../types';
import MicIcon from './icons/MicIcon';
import YinYangMicIcon from './icons/YinYangMicIcon';
import StopIcon from './icons/StopIcon';
import PauseIcon from './icons/PauseIcon';
import ResumeIcon from './icons/ResumeIcon';
import UploadIcon from './icons/UploadIcon';
import DownloadIcon from './icons/DownloadIcon';
import WarningIcon from './icons/WarningIcon';
import { ClipboardPaste, FileText, Trash2, CheckCircle2 } from 'lucide-react';
import PasteTextModal from './PasteTextModal';
import { stopRepeatingInterruptedAlert } from '../services/soundService';
import { triggerAudioDownload } from '../services/audioMerger';

interface AudioRecorderProps {
  status: AppStatus;
  setStatus: (status: AppStatus) => void;
  onRecordingComplete: (audioBlob: Blob | Blob[]) => void;
  onMultipleFilesUploaded?: (files: File[]) => void;
}

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}:${remMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

const AudioRecorder: React.FC<AudioRecorderProps> = ({ status, setStatus, onRecordingComplete, onMultipleFilesUploaded }) => {
  const {
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
  } = useAudioRecorder();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [isStarting, setIsStarting] = React.useState(false);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
  const [clipboardPastedText, setClipboardPastedText] = useState('');
  const dragCounter = useRef(0);

  // Staged session state for "Upload files" / "Paste text" workflows
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [stagedAudioBlob, setStagedAudioBlob] = useState<Blob | null>(null);
  const [stagedAudioUrl, setStagedAudioUrl] = useState<string | null>(null);
  const [isStagedMode, setIsStagedMode] = useState<boolean>(false);

  useEffect(() => {
    if (stagedAudioBlob) {
      const url = URL.createObjectURL(stagedAudioBlob);
      setStagedAudioUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setStagedAudioUrl(null);
    }
  }, [stagedAudioBlob]);

  // If all staged items are removed while not recording, revert staged mode
  useEffect(() => {
    if (isStagedMode && stagedFiles.length === 0 && !stagedAudioBlob && !isRecording) {
      setIsStagedMode(false);
    }
  }, [isStagedMode, stagedFiles.length, stagedAudioBlob, isRecording]);

  // Global Ctrl+V listener to directly capture text pastes when not actively recording
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      if (isRecording || status === AppStatus.Recording) return;
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const text = e.clipboardData?.getData('text');
      if (text && text.trim().length > 0) {
        e.preventDefault();
        setClipboardPastedText(text);
        setIsPasteModalOpen(true);
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [isRecording, status]);

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      setStagedFiles(prev => [...prev, ...files]);
      setIsStagedMode(true);
    }
  };

  const handleStart = async () => {
    setIsStarting(true);
    try {
      await startRecording();
      setStatus(AppStatus.Recording);
    } catch (err) {
      console.warn("Start recording failed or permission denied:", err);
    } finally {
      setIsStarting(false);
    }
  };
  
  const handleStop = async () => {
    const audioBlob = await stopRecording();
    setStatus(AppStatus.Idle);
    if (audioBlob) {
      onRecordingComplete(audioBlob);
    }
  };

  const handleStartStagedRecording = async () => {
    setIsStarting(true);
    try {
      await startRecording();
      setStatus(AppStatus.Recording);
    } catch (err) {
      console.warn("Start staged recording failed:", err);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopStagedRecording = async () => {
    const audioBlob = await stopRecording();
    setStatus(AppStatus.Idle);
    if (audioBlob && audioBlob.size > 0) {
      setStagedAudioBlob(audioBlob);
    }
  };

  const handleFinishStagedSession = async () => {
    let finalAudio = stagedAudioBlob;
    if (isRecording) {
      const blob = await stopRecording();
      setStatus(AppStatus.Idle);
      if (blob && blob.size > 0) {
        finalAudio = blob;
      }
    }
    const allItems: Blob[] = [];
    if (finalAudio && finalAudio.size > 0) {
      allItems.push(finalAudio);
    }
    allItems.push(...stagedFiles);

    if (allItems.length === 0) return;

    setStagedFiles([]);
    setStagedAudioBlob(null);
    setIsStagedMode(false);

    if (allItems.length === 1) {
      onRecordingComplete(allItems[0]);
    } else {
      onRecordingComplete(allItems);
    }
  };

  const handleCancelStagedSession = async () => {
    if (isRecording) {
      try {
        await stopRecording();
      } catch (e) {}
      setStatus(AppStatus.Idle);
    }
    setStagedFiles([]);
    setStagedAudioBlob(null);
    setIsStagedMode(false);
  };

  const handleDownloadStagedAudio = () => {
    if (stagedAudioBlob) {
      triggerAudioDownload(stagedAudioBlob, `dictation_${new Date().toISOString().slice(0, 10)}`);
    }
  };

  const handleCenterClick = () => {
    if (isStarting || isRequestingMic) return;
    if (isRecording) {
      if (isStagedMode) {
        handleStopStagedRecording();
      } else {
        handleStop();
      }
    } else {
      if (isStagedMode) {
        handleStartStagedRecording();
      } else {
        handleStart();
      }
    }
  };

  const handleRecover = async () => {
    stopRepeatingInterruptedAlert();
    const recoveredBlob = await recoverUnsavedSession();
    if (recoveredBlob && recoveredBlob.size > 0) {
      onRecordingComplete(recoveredBlob);
    }
  };

  const handleDownloadRecovered = () => {
    stopRepeatingInterruptedAlert();
    const recoveredBlob = getUnsavedSessionBlob();
    if (recoveredBlob) {
      const url = URL.createObjectURL(recoveredBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recovered_dictation_${new Date().toISOString().slice(0, 10)}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const handlePauseToggle = () => {
    if (isPaused) {
      resumeRecording();
    } else {
      pauseRecording();
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      setStagedFiles(prev => [...prev, ...files]);
      setIsStagedMode(true);
    }
    if (event.target) {
      event.target.value = "";
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const recordingText = isPaused ? 'Recording Paused' : 'Recording in Progress...';
  const recordingSubtext = isPaused ? 'Click the resume button to continue.' : 'Click the stop button when you are finished.';

  const formattedTime = unsavedSession
    ? new Date(unsavedSession.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  const formattedSize = unsavedSession
    ? `${(unsavedSession.totalBytes / 1024).toFixed(1)} KB`
    : '';

  return (
    <div 
      className={`relative flex flex-col items-center justify-center p-3 sm:p-6 rounded-2xl border-2 border-dashed transition-colors duration-200 ${
        isDragging 
          ? 'border-blue-500 bg-blue-50/80 dark:bg-blue-900/40' 
          : 'border-transparent'
      }`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-blue-50/95 dark:bg-slate-800/95 rounded-2xl border-2 border-dashed border-blue-500 p-6 pointer-events-none shadow-xl">
          <UploadIcon className="w-16 h-16 text-blue-600 dark:text-blue-400 animate-bounce mb-3" />
          <p className="text-xl font-bold text-blue-700 dark:text-blue-300">
            Drop File Here
          </p>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">
            Release to upload and begin transcription & analysis (Audio, PDF, Image, Video, DOCX, etc.)
          </p>
        </div>
      )}

      {interruptedNotice && (
        <div className="w-full max-w-xl mb-4 p-4 rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800/70 shadow-sm flex items-start justify-between gap-3 text-rose-800 dark:text-rose-200 animate-fadeIn">
          <div className="flex items-start gap-3">
            <WarningIcon className="w-6 h-6 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
            <div>
              <p className="font-semibold text-sm sm:text-base">
                Dictation Interrupted & Auto-Saved
              </p>
              <p className="text-xs sm:text-sm text-rose-700 dark:text-rose-300 mt-0.5">
                {interruptedNotice}
              </p>
            </div>
          </div>
          <button
            onClick={clearInterruptedNotice}
            className="text-rose-500 hover:text-rose-700 dark:hover:text-rose-300 text-sm p-1 rounded-md"
            title="Dismiss notification"
          >
            ✕
          </button>
        </div>
      )}

      {unsavedSession && !isRecording && (
        <div className="w-full max-w-xl mb-6 p-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700/60 shadow-sm flex flex-col gap-3">
          <div className="flex items-center gap-3 text-amber-800 dark:text-amber-200">
            <WarningIcon className="w-6 h-6 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="font-semibold text-sm sm:text-base">
                Interrupted Audio Recording Detected
              </p>
              <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
                Found audio chunks auto-saved at {formattedTime} ({formattedSize}). Restore it to avoid losing your dictation.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-1 border-t border-amber-200 dark:border-amber-800/50 justify-end">
            <button
              onClick={discardUnsavedSession}
              className="px-3 py-1.5 text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-amber-100 dark:hover:bg-amber-800/40 rounded-lg transition-colors"
            >
              Discard Backup
            </button>
            <button
              onClick={handleDownloadRecovered}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs sm:text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-200/60 dark:bg-amber-800/60 hover:bg-amber-200 rounded-lg transition-colors"
            >
              <DownloadIcon className="w-4 h-4" />
              Save File
            </button>
            <button
              onClick={handleRecover}
              className="px-4 py-1.5 text-xs sm:text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500 rounded-lg shadow transition-colors"
            >
              Restore & Transcribe
            </button>
          </div>
        </div>
      )}

      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileSelect} 
        className="hidden" 
        accept="audio/*,video/*,image/*,.pdf,.doc,.docx,.txt,.csv,.rtf,.webm,.mp4,.mp3,.wav,.m4a,.png,.jpg,.jpeg"
        multiple
        aria-hidden="true"
      />
      <div className="relative mb-4 flex flex-col items-center">
        {/* Animated pulse ring during recording */}
        {isRecording && !isPaused && (
          <div className="absolute inset-0 rounded-full bg-red-500/40 dark:bg-red-500/30 animate-ping pointer-events-none scale-110" />
        )}
        {isRecording && (
          <div className="absolute -inset-1.5 rounded-full ring-4 ring-red-500/70 animate-pulse pointer-events-none" />
        )}

        {/* Interactive Yin-Yang Microphone Button */}
        <button
          type="button"
          onClick={handleCenterClick}
          disabled={isStarting || isRequestingMic}
          className={`group relative w-28 h-28 sm:w-32 sm:h-32 rounded-full shadow-2xl flex items-center justify-center transition-all duration-300 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-400/50 cursor-pointer ${
            isRecording
              ? 'hover:scale-105 active:scale-95 shadow-red-500/30 ring-2 ring-red-500'
              : 'hover:scale-105 active:scale-95 hover:shadow-2xl hover:shadow-blue-500/20'
          } ${isStarting || isRequestingMic ? 'opacity-85 cursor-wait' : ''}`}
          aria-label={isRecording ? "Stop Recording" : "Start Recording"}
          title={
            isRecording
              ? "Recording in progress... Click to stop"
              : "Click to start recording"
          }
        >
          {/* Yin-Yang Mic Graphic created by user */}
          <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center bg-[#0A0B0E] p-1 border-2 border-slate-700/50 dark:border-slate-600 shadow-inner">
            <YinYangMicIcon className="w-full h-full transform transition-transform duration-300 group-hover:rotate-6" />
          </div>

          {/* Loading / Accessing Mic spinner overlay */}
          {(isStarting || isRequestingMic) && (
            <div className="absolute inset-0 rounded-full bg-black/65 backdrop-blur-xs flex flex-col items-center justify-center text-white z-10">
              <span className="inline-block w-8 h-8 border-3 border-white border-t-transparent rounded-full animate-spin"></span>
            </div>
          )}

          {/* Active recording live indicator badge */}
          {isRecording && !isStagedMode && (
            <div className="absolute -bottom-1 right-1 bg-red-600 text-white rounded-full p-1.5 shadow-lg flex items-center justify-center z-10 border-2 border-white dark:border-slate-900" title={isPaused ? "Recording paused" : "Recording live"}>
              <span className={`w-3 h-3 rounded-full ${isPaused ? 'bg-yellow-300' : 'bg-white animate-ping'}`} />
            </div>
          )}

          {/* Staged mode completed audio indicator badge */}
          {isStagedMode && stagedAudioBlob && !isRecording && (
            <div className="absolute -top-1 -right-1 bg-green-600 text-white rounded-full p-1.5 shadow-lg flex items-center justify-center z-10 border-2 border-white dark:border-slate-900" title="Dictation audio ready">
              <CheckCircle2 className="w-4 h-4 text-white" />
            </div>
          )}
        </button>
      </div>

      {isRecording && !isStagedMode && (
        <div className="flex items-center gap-2 mb-3 px-3.5 py-1 rounded-full bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 font-mono text-sm font-semibold shadow-xs">
          <span className={`w-2.5 h-2.5 rounded-full ${isPaused ? 'bg-yellow-500' : 'bg-red-600 animate-ping'}`}></span>
          <span>{formatDuration(recordingDuration)}</span>
          {isPaused && <span className="text-xs font-sans text-yellow-600 dark:text-yellow-400 font-medium">(Paused)</span>}
        </div>
      )}
      <h2 className="text-2xl font-semibold text-slate-700 dark:text-slate-200 mb-2">
        {isRecording && !isStagedMode ? recordingText : isStagedMode ? 'Review & Finish Dictation' : 'Ready to Dictate or Upload'}
      </h2>
      <p className="text-slate-500 dark:text-slate-400 mb-6 text-center">
        {isRecording && !isStagedMode ? recordingSubtext : isStagedMode ? 'Review staged items, add optional audio or more files/text, then click Finish.' : 'Click below to start recording, or upload any number of files (Audio, PDF, Images, DOCX, Video, etc.) as context or dictation.'}
      </p>
      
      {error && <p className="text-red-500 mb-4">{error}</p>}
      
      {isStagedMode ? (
        <div className="w-full max-w-xl flex flex-col gap-4 bg-slate-50 dark:bg-slate-800/60 p-4 sm:p-5 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm animate-fadeIn">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 pb-3">
            <div>
              <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <span>Staged Files &amp; Dictation</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 font-semibold">
                  {stagedFiles.length + (stagedAudioBlob ? 1 : 0)} items
                </span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Record accompanying audio (or skip), add more files or text, then click Finish when ready.
              </p>
            </div>
          </div>

          {/* Staged Items List */}
          <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
            {stagedAudioBlob && (
              <div className="flex items-center justify-between p-2.5 bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-xl">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
                    <MicIcon className="w-4 h-4 text-white" />
                  </div>
                  <div className="truncate">
                    <span className="text-xs font-bold text-blue-900 dark:text-blue-200 block truncate">Audio Dictation</span>
                    <span className="text-[11px] text-blue-700 dark:text-blue-300">{(stagedAudioBlob.size / 1024).toFixed(0)} KB</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {stagedAudioUrl && (
                    <audio src={stagedAudioUrl} controls className="h-7 w-32 sm:w-48" />
                  )}
                  <button
                    type="button"
                    onClick={handleDownloadStagedAudio}
                    className="p-1.5 text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors"
                    title="Download recorded audio"
                    aria-label="Download recorded audio"
                  >
                    <DownloadIcon className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setStagedAudioBlob(null)}
                    className="p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                    title="Remove recorded audio"
                    aria-label="Remove recorded audio"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {stagedFiles.map((file, idx) => (
              <div key={`${file.name}-${idx}`} className="flex items-center justify-between p-2.5 bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700/80 rounded-xl">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0">
                    {file.type.startsWith('text/') || file.name.endsWith('.txt') ? (
                      <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    ) : (
                      <UploadIcon className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                    )}
                  </div>
                  <div className="truncate">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 block truncate" title={file.name}>
                      {file.name}
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setStagedFiles(prev => prev.filter((_, i) => i !== idx))}
                  className="p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors shrink-0"
                  title="Remove file"
                  aria-label="Remove file"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          {/* Option to record / not record audio */}
          {!stagedAudioBlob && (
            <div className="p-3 bg-white dark:bg-slate-900/60 rounded-xl border border-dashed border-slate-300 dark:border-slate-700">
              {isRecording ? (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse"></span>
                    <span className="text-xs font-bold text-red-700 dark:text-red-300">
                      {isPaused ? 'Recording Paused' : 'Recording Dictation...'}
                    </span>
                    <span className="text-xs font-mono font-semibold text-red-600 dark:text-red-400">
                      {formatDuration(recordingDuration)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                    <button
                      type="button"
                      onClick={handlePauseToggle}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 hover:bg-amber-200 transition-colors"
                    >
                      {isPaused ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      type="button"
                      onClick={handleStopStagedRecording}
                      className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-red-600 hover:bg-red-700 text-white shadow-xs transition-colors"
                    >
                      Done Recording
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300 block">Record Audio Dictation</span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">Optional: record dictation to accompany these files or leave without audio</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleStartStagedRecording}
                    disabled={isStarting || isRequestingMic}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-xs transition-colors"
                  >
                    <MicIcon className="w-3.5 h-3.5 text-white" />
                    <span>Record Audio</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Option to select again the files / paste text also along with it */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={triggerFileSelect}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold text-xs transition-colors"
                title="Select and add more files"
              >
                <UploadIcon className="w-3.5 h-3.5" />
                <span>+ Add More Files</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setClipboardPastedText('');
                  setIsPasteModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-bold text-xs transition-colors"
                title="Paste text dictation or notes to accompany this session"
              >
                <ClipboardPaste className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                <span>+ Paste Text</span>
              </button>
            </div>
          </div>

          {/* Finish & Cancel Actions */}
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-700 mt-1">
            <button
              type="button"
              onClick={handleCancelStagedSession}
              className="text-xs font-semibold text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 transition-colors"
            >
              Cancel / Start Over
            </button>
            <button
              type="button"
              onClick={handleFinishStagedSession}
              disabled={stagedFiles.length === 0 && !stagedAudioBlob && !isRecording}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-white font-bold text-sm shadow-md transition-all hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Finish</span>
            </button>
          </div>
        </div>
      ) : !isRecording ? (
        <div className="flex flex-col items-center gap-3 w-full max-w-xl">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5 sm:gap-3 w-full flex-wrap">
              <button
                onClick={handleStart}
                disabled={status === AppStatus.Recording || isStarting || isRequestingMic}
                className="w-full sm:w-auto flex items-center justify-center gap-2 bg-blue-600 text-white font-bold py-3.5 px-6 rounded-full hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-300 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg disabled:opacity-75 disabled:hover:scale-100 disabled:cursor-wait min-h-[48px]"
                aria-label="Start Recording"
              >
                {(isStarting || isRequestingMic) ? (
                  <>
                    <span className="inline-block w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    Accessing Mic...
                  </>
                ) : (
                  <>
                    <YinYangMicIcon className="w-6 h-6 shrink-0" />
                    Start Recording
                  </>
                )}
              </button>
              <button
                onClick={triggerFileSelect}
                className="w-full sm:w-auto flex items-center justify-center gap-2 bg-slate-200 text-slate-700 font-bold py-3.5 px-6 rounded-full hover:bg-slate-300 focus:outline-none focus:ring-4 focus:ring-slate-300 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600 dark:focus:ring-slate-500 min-h-[48px]"
                aria-label="Upload Files (Audio, PDF, Image, Video, Doc)"
              >
                <UploadIcon className="w-6 h-6"/>
                Upload File(s)
              </button>
              <button
                onClick={() => {
                  setClipboardPastedText('');
                  setIsPasteModalOpen(true);
                }}
                className="w-full sm:w-auto flex items-center justify-center gap-2 bg-blue-50 text-blue-700 font-bold py-3.5 px-6 rounded-full hover:bg-blue-100 border border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-900/60 focus:outline-none focus:ring-4 focus:ring-blue-200 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-md min-h-[48px]"
                aria-label="Paste Dictation Text"
                title="Paste text dictation, PACS notes, or EHR findings"
              >
                <ClipboardPaste className="w-5 h-5 text-blue-600 dark:text-blue-400"/>
                Paste Text
              </button>
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500 flex items-center justify-center gap-1.5 mt-1 text-center flex-wrap">
            <span>Upload or drag &amp; drop any number of files (Audio, PDF, Images, DOCX)</span>
            <span className="hidden sm:inline">•</span>
            <span>Paste any number of texts</span>
          </p>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 w-full max-w-md">
          <button
            onClick={handlePauseToggle}
            className={`w-full sm:w-auto flex items-center justify-center gap-2 font-bold py-3.5 px-7 rounded-full focus:outline-none focus:ring-4 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg min-h-[48px] ${
              isPaused 
                ? 'bg-green-500 text-white hover:bg-green-600 focus:ring-green-300' 
                : 'bg-yellow-500 text-white hover:bg-yellow-600 focus:ring-yellow-300'
            }`}
            aria-label={isPaused ? "Resume Recording" : "Pause Recording"}
          >
            {isPaused ? <ResumeIcon className="w-5 h-5"/> : <PauseIcon className="w-5 h-5"/>}
            {isPaused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={handleStop}
            disabled={!isRecording}
            className="w-full sm:w-auto flex items-center justify-center gap-2 bg-red-600 text-white font-bold py-3.5 px-8 rounded-full hover:bg-red-700 focus:outline-none focus:ring-4 focus:ring-red-300 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg min-h-[48px]"
            aria-label="Stop Recording"
          >
            <StopIcon className="w-5 h-5"/>
            Stop Recording
          </button>
        </div>
      )}

      <PasteTextModal
        isOpen={isPasteModalOpen}
        onClose={() => setIsPasteModalOpen(false)}
        initialText={clipboardPastedText}
        onProcessSingle={(files) => {
          if (files && files.length > 0) {
            setStagedFiles(prev => [...prev, ...files]);
            setIsStagedMode(true);
          }
          setIsPasteModalOpen(false);
        }}
        onProcessBatch={(files) => {
          if (onMultipleFilesUploaded) {
            onMultipleFilesUploaded(files);
            setIsPasteModalOpen(false);
          } else {
            if (files && files.length > 0) {
              setStagedFiles(prev => [...prev, ...files]);
              setIsStagedMode(true);
            }
            setIsPasteModalOpen(false);
          }
        }}
      />
    </div>
  );
};

export default AudioRecorder;