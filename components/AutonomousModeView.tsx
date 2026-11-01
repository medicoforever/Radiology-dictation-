import React, { useState, useEffect, useRef } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import {
  parseAutonomousAudioDictation,
  executeAutonomousPlan,
  AutonomousExecutionResult,
  AutonomousExecutionPlan,
  AutonomousAttachedFile
} from '../services/autonomousAgentService';
import { SaveResult } from '../services/googleDriveService';
import { triggerAudioDownload } from '../services/audioMerger';
import MicIcon from './icons/MicIcon';
import StopIcon from './icons/StopIcon';
import SparklesIcon from './icons/SparklesIcon';
import BrainIcon from './icons/BrainIcon';
import WarningIcon from './icons/WarningIcon';
import DownloadIcon from './icons/DownloadIcon';
import UploadIcon from './icons/UploadIcon';
import ImageIcon from './icons/ImageIcon';

interface AutonomousModeViewProps {
  selectedModel: string;
  onApplySingleReport: (
    findings: string[], 
    patientName: string, 
    audioBlob?: Blob | null,
    customImages?: Array<{ data: string; mimeType: string }>,
    extraFiles?: File[]
  ) => void;
  onApplyBatchReports: (batches: Array<{
    name: string;
    findings: string[];
    audioBlobs: Blob[];
    selectedModel: string;
    customPrompt?: string;
    customImages?: Array<{ data: string; mimeType: string }>;
    extraFiles?: File[];
  }>) => void;
  onNavigateToSingle: () => void;
  onNavigateToBatch: () => void;
  onSaveToDrive?: (result: SaveResult) => void;
}

export const AutonomousModeView: React.FC<AutonomousModeViewProps> = ({
  selectedModel,
  onApplySingleReport,
  onApplyBatchReports,
  onNavigateToSingle,
  onNavigateToBatch,
  onSaveToDrive,
}) => {
  const {
    isRecording,
    recordingDuration,
    startRecording,
    stopRecording,
    error: recorderError,
  } = useAudioRecorder();

  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [executionStep, setExecutionStep] = useState<string>('');
  const [executionResult, setExecutionResult] = useState<AutonomousExecutionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showExamples, setShowExamples] = useState(false);

  // Staged files attached to the autonomous session
  const [attachedFiles, setAttachedFiles] = useState<AutonomousAttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Format recording timer: mm:ss
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Clean up object URL when blob changes
  useEffect(() => {
    if (recordedBlob) {
      const url = URL.createObjectURL(recordedBlob);
      setAudioUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setAudioUrl(null);
    }
  }, [recordedBlob]);

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setAttachedFiles(prev => {
        const startIndex = prev.length;
        const newItems: AutonomousAttachedFile[] = files.map((file, idx) => ({
          id: `auto_file_${Date.now()}_${idx}`,
          file,
          index: startIndex + idx + 1,
          alias: ''
        }));
        return [...prev, ...newItems];
      });
    }
    if (e.target) e.target.value = '';
  };

  const handleUpdateAlias = (id: string, alias: string) => {
    setAttachedFiles(prev => prev.map(f => f.id === id ? { ...f, alias } : f));
  };

  const handleRemoveFile = (id: string) => {
    setAttachedFiles(prev => {
      const remaining = prev.filter(f => f.id !== id);
      return remaining.map((f, idx) => ({ ...f, index: idx + 1 }));
    });
  };

  const handleStartRecording = async () => {
    setErrorMessage(null);
    setExecutionResult(null);
    setRecordedBlob(null);
    try {
      await startRecording();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Could not access microphone.');
    }
  };

  const handleStopRecording = async () => {
    try {
      const blob = await stopRecording();
      setRecordedBlob(blob);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to capture audio recording.');
    }
  };

  const handleExecuteAutonomousSession = async () => {
    if (!recordedBlob) return;

    setIsProcessing(true);
    setErrorMessage(null);
    setExecutionResult(null);

    try {
      setExecutionStep('Analyzing spoken audio with ' + selectedModel + '...');
      const plan: AutonomousExecutionPlan = await parseAutonomousAudioDictation(
        recordedBlob,
        selectedModel,
        attachedFiles
      );

      setExecutionStep('Correlating patients, handing over files & merging templates...');
      const result = await executeAutonomousPlan(plan, {
        selectedModel,
        audioBlob: recordedBlob,
        attachedFiles,
        onApplySingleReport,
        onApplyBatchReports,
        onDriveSaved: onSaveToDrive,
      });

      if (!result.success) {
        setErrorMessage(result.error || 'Autonomous execution failed.');
      } else {
        setExecutionResult(result);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to parse and execute autonomous instructions.');
    } finally {
      setIsProcessing(false);
      setExecutionStep('');
    }
  };

  const handleResetSession = () => {
    setRecordedBlob(null);
    setExecutionResult(null);
    setErrorMessage(null);
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6 animate-fadeIn pb-12">
      {/* Superapp Director Banner */}
      <div className="bg-gradient-to-r from-blue-900/90 via-indigo-900/90 to-purple-900/90 text-white rounded-2xl p-4 sm:p-6 shadow-xl border border-blue-700/50 relative overflow-hidden">
        <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="p-2 rounded-xl bg-blue-500/30 border border-blue-400/40">
                <BrainIcon className="w-6 h-6 text-blue-300" />
              </div>
              <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white flex items-center gap-2">
                Autonomous Superapp Director
                <span className="text-xs bg-amber-400 text-slate-900 font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Agentic
                </span>
              </h2>
            </div>
            <p className="text-xs sm:text-sm text-blue-200/90 max-w-xl">
              Dictate naturally in human language. The autonomous agent dissects multiple patients, consolidates fragmented addenda across turns, hands over attached files, routes cases between Single &amp; Batch modes, applies templates, merges instructions, and triggers Google Drive auto-saves &amp; HTML exports behind the scenes.
            </p>
          </div>

          <div className="shrink-0 self-start sm:self-center">
            <div className="px-3 py-1.5 rounded-xl bg-black/40 backdrop-blur-md border border-white/20 text-xs font-mono text-blue-200 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>Model: <strong>{selectedModel}</strong></span>
            </div>
          </div>
        </div>
      </div>

      {/* Spoken Examples Accordion */}
      <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-xs">
        <button
          type="button"
          onClick={() => setShowExamples(!showExamples)}
          className="w-full p-3.5 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
        >
          <div className="flex items-center gap-2 text-xs sm:text-sm font-bold text-slate-700 dark:text-slate-200">
            <SparklesIcon className="w-4 h-4 text-indigo-500" />
            <span>How to speak to the Autonomous Director (Examples &amp; Natural Commands)</span>
          </div>
          <span className="text-xs text-indigo-600 dark:text-indigo-400 font-semibold">
            {showExamples ? 'Hide Tips ▲' : 'Show Tips ▼'}
          </span>
        </button>

        {showExamples && (
          <div className="p-4 bg-slate-50/70 dark:bg-slate-900/40 border-t border-slate-200/60 dark:border-slate-700/60 space-y-3 text-xs sm:text-sm text-slate-600 dark:text-slate-300">
            <div className="p-3 bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200/70 dark:border-blue-800/50 rounded-lg">
              <p className="font-semibold text-blue-900 dark:text-blue-200 mb-1">
                🗣️ Multi-Patient + Interleaved Dictation + File Reference Example:
              </p>
              <p className="italic text-slate-700 dark:text-slate-300">
                &quot;Patient 1 is John Doe, 45 male, CT Brain. In single dictation mode with the CT Brain Plain template. Attach the first uploaded file to this patient. Serial axial sections normal, no hemorrhage... Next patient is Patient 2, Chest X-Ray, put this in batch mode with normal chest template, and hand over the chest scan file to it... Oh, and going back to Patient 1, also note mild mucosal thickening in the right maxillary sinus... Save all reports to Google Drive and download all HTMLs.&quot;
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700">
                <strong>Routing:</strong> &quot;Use single dictation for this&quot;, &quot;Add the next 3 patients to batch mode&quot;.
              </div>
              <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700">
                <strong>Templates &amp; Merging:</strong> &quot;Apply CT Trauma template and merge focusing on rib fractures&quot;.
              </div>
              <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700">
                <strong>Attached Files Handover:</strong> &quot;Attach the first uploaded file to Patient 1&quot;, &quot;Hand over the brain scan to Patient 2&quot;.
              </div>
              <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700">
                <strong>Cloud &amp; Storage:</strong> &quot;Save this to Google Drive&quot;, &quot;Auto-save to drive&quot;.
              </div>
              <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700">
                <strong>Spoken Macros:</strong> &quot;Create macro normal-cxr with text Clear lung fields...&quot;, &quot;Insert macro age-related&quot;.
              </div>
              <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700">
                <strong>Sync &amp; Dictionary:</strong> &quot;Sync to workstation&quot;, &quot;Add word choledocholithiasis to dictionary&quot;.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Attached Files Input Station (Upload anytime before, during live, or after dictation) */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 sm:p-5 shadow-sm border border-slate-200 dark:border-slate-700 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <span>📎 Attached Files for Handover</span>
              {attachedFiles.length > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300">
                  {attachedFiles.length} file{attachedFiles.length > 1 ? 's' : ''} staged
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Upload scans, prior reports, or documents anytime — even while recording! The main AI routes them to the right report based on your speech without reading them.
            </p>
          </div>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFilesSelected}
            multiple
            className="hidden"
            aria-hidden="true"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-600 transition-colors shadow-xs cursor-pointer shrink-0"
          >
            <UploadIcon className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>+ Add File(s) / Scan</span>
          </button>
        </div>

        {/* Attached Files Staging List */}
        {attachedFiles.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-slate-200/70 dark:border-slate-700/70">
            {attachedFiles.map((item) => (
              <div
                key={item.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700/80 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-2 py-0.5 rounded-md font-mono font-bold bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 shrink-0">
                    File #{item.index}
                  </span>
                  <div className="truncate">
                    <span className="font-semibold text-slate-800 dark:text-slate-200 truncate block" title={item.file.name}>
                      {item.file.name}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      {(item.file.size / 1024).toFixed(0)} KB • {item.file.type || 'file'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <input
                    type="text"
                    placeholder={`Spoken alias (e.g. "Brain MRI" or "Prior Report")`}
                    value={item.alias || ''}
                    onChange={(e) => handleUpdateAlias(item.id, e.target.value)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder-slate-400 w-48 sm:w-64 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    title="Give this file a spoken recognition name so you can refer to it easily in your dictation"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveFile(item.id)}
                    className="p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                    title="Remove file"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recording Console */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 sm:p-8 shadow-md border border-slate-200 dark:border-slate-700 text-center flex flex-col items-center justify-center space-y-6">
        {/* Mic Button & Pulse Effect */}
        <div className="relative">
          {isRecording && (
            <span className="absolute -inset-3 rounded-full bg-red-500/20 animate-ping pointer-events-none"></span>
          )}
          <button
            type="button"
            onClick={isRecording ? handleStopRecording : handleStartRecording}
            disabled={isProcessing}
            className={`w-24 h-24 sm:w-28 sm:h-28 rounded-full flex flex-col items-center justify-center transition-all duration-300 shadow-xl cursor-pointer ${
              isRecording
                ? 'bg-red-600 hover:bg-red-700 text-white ring-8 ring-red-500/30 scale-105'
                : 'bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-600 hover:scale-105 text-white ring-8 ring-blue-500/20'
            } disabled:opacity-50 disabled:pointer-events-none`}
            aria-label={isRecording ? 'Stop Recording' : 'Start Autonomous Recording'}
          >
            {isRecording ? (
              <StopIcon className="w-10 h-10" />
            ) : (
              <MicIcon className="w-10 h-10" />
            )}
            <span className="text-[11px] font-bold uppercase tracking-wider mt-1">
              {isRecording ? 'Stop' : 'Dictate'}
            </span>
          </button>
        </div>

        {/* Recording Timer & Status */}
        <div>
          {isRecording ? (
            <div className="space-y-1">
              <div className="text-3xl sm:text-4xl font-mono font-black text-red-600 dark:text-red-400">
                {formatTime(recordingDuration)}
              </div>
              <p className="text-xs sm:text-sm font-semibold text-slate-500 dark:text-slate-400 animate-pulse">
                🎙️ Listening... Speak naturally across multiple patients, templates, and commands.
              </p>
            </div>
          ) : recordedBlob ? (
            <div className="space-y-1">
              <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400 flex items-center justify-center gap-1.5">
                <span>✓ Audio captured successfully</span>
                <span>({(recordedBlob.size / 1024 / 1024).toFixed(2)} MB)</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Ready to analyze and orchestrate across your application slices.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-base sm:text-lg font-bold text-slate-700 dark:text-slate-200">
                Tap the microphone to begin autonomous dictation
              </div>
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                No complex forms or tool calling required. Speak everything in one continuous voice stream.
              </p>
            </div>
          )}
        </div>

        {/* Audio Player Preview & Download Button (if recorded and idle) */}
        {audioUrl && !isRecording && !isProcessing && (
          <div className="w-full max-w-md pt-2 flex flex-col items-center gap-3">
            <audio controls src={audioUrl} className="w-full h-10 rounded-lg shadow-xs" />
            <div className="flex flex-wrap items-center gap-2.5 w-full">
              <button
                type="button"
                onClick={handleExecuteAutonomousSession}
                className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold text-sm shadow-md hover:shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <SparklesIcon className="w-4 h-4" />
                <span>Execute Autonomous Plan</span>
              </button>
              <button
                type="button"
                onClick={() => recordedBlob && triggerAudioDownload(recordedBlob, 'autonomous-dictation')}
                className="py-3 px-3.5 rounded-xl bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold text-xs transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                title="Download this audio recording to your device"
              >
                <DownloadIcon className="w-4 h-4" />
                <span>Save Audio</span>
              </button>
              <button
                type="button"
                onClick={handleResetSession}
                className="py-3 px-3.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 font-semibold text-xs transition-colors cursor-pointer"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {/* Processing Indicator */}
        {isProcessing && (
          <div className="w-full max-w-md p-4 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 space-y-3 animate-pulse">
            <div className="flex items-center justify-center gap-2 text-blue-700 dark:text-blue-300 font-bold text-sm">
              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              <span>{executionStep || 'Orchestrating autonomous actions...'}</span>
            </div>
            <p className="text-xs text-blue-600/80 dark:text-blue-400/80 text-center">
              Using model <strong>{selectedModel}</strong> to transcribe, resolve patient addenda, and dispatch reports.
            </p>
          </div>
        )}
      </div>

      {/* Error Banner with Acoustic Alert */}
      {errorMessage && (
        <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border-2 border-red-300 dark:border-red-800 text-red-900 dark:text-red-200 flex items-start gap-3 shadow-md animate-fadeIn">
          <WarningIcon className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1 text-xs sm:text-sm space-y-1">
            <p className="font-bold">Autonomous Execution Notice</p>
            <p>{errorMessage}</p>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-xs font-semibold text-red-700 dark:text-red-300 underline shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Execution Results Dashboard (Riley Brown Superapp Card) */}
      {executionResult && executionResult.success && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-xl border-2 border-emerald-500/40 dark:border-emerald-500/30 space-y-6 animate-fadeIn">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-700">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                ✓ Plan Executed Successfully
              </span>
              <h3 className="text-lg sm:text-xl font-black text-slate-800 dark:text-slate-100">
                Autonomous Dispatch Summary
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">
                {executionResult.totalPatients} Patients Processed
              </span>
              {executionResult.driveSaved && (
                <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
                  Drive Saved ✓
                </span>
              )}
              {executionResult.htmlDownloaded && (
                <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200">
                  HTML Downloaded ✓
                </span>
              )}
              {executionResult.workstationSynced && (
                <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                  Workstation Synced ✓
                </span>
              )}
              {recordedBlob && (
                <button
                  type="button"
                  onClick={() => triggerAudioDownload(recordedBlob, 'autonomous-dictation')}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-600 transition-colors cursor-pointer"
                  title="Download the full audio recording to your device"
                >
                  <DownloadIcon className="w-3.5 h-3.5" />
                  <span>Download Audio</span>
                </button>
              )}
            </div>
          </div>

          <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200/60 dark:border-slate-700/60 italic">
            &quot;{executionResult.summary}&quot;
          </p>

          {/* Handed Over Files Notification */}
          {executionResult.handedOverFilesSummary && executionResult.handedOverFilesSummary.length > 0 && (
            <div className="p-3.5 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 text-xs space-y-1.5">
              <p className="font-bold text-indigo-900 dark:text-indigo-200 flex items-center gap-1.5">
                <span>📎 Handed Over Files (Zero-Read Principle):</span>
              </p>
              {executionResult.handedOverFilesSummary.map((item, idx) => (
                <p key={idx} className="text-slate-700 dark:text-slate-300 pl-2">
                  • <strong>{item.patientName}:</strong> {item.fileNames.join(', ')}
                </p>
              ))}
            </div>
          )}

          {/* Spoken Macros & Vocabulary Created Notice */}
          {((executionResult.macrosCreated && executionResult.macrosCreated.length > 0) || 
            (executionResult.vocabularyCreated && executionResult.vocabularyCreated.length > 0)) && (
            <div className="p-3.5 rounded-xl bg-purple-50/80 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/60 text-xs space-y-1">
              {executionResult.macrosCreated && executionResult.macrosCreated.length > 0 && (
                <p className="text-purple-900 dark:text-purple-200 font-semibold">
                  ✨ <strong>Spoken Macros Created:</strong> {executionResult.macrosCreated.join(', ')}
                </p>
              )}
              {executionResult.vocabularyCreated && executionResult.vocabularyCreated.length > 0 && (
                <p className="text-purple-900 dark:text-purple-200 font-semibold">
                  📖 <strong>Dictionary Rules Added:</strong> {executionResult.vocabularyCreated.join(', ')}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Single Dictation Slice Card */}
            {executionResult.singlePatient && (
              <div className="p-4 rounded-xl border border-blue-200 dark:border-blue-800/60 bg-blue-50/50 dark:bg-blue-950/20 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-sm text-blue-900 dark:text-blue-200">
                    <MicIcon className="w-4 h-4 text-blue-600" />
                    <span>Single Dictation Slice</span>
                  </div>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-200/60 dark:bg-blue-800 text-blue-900 dark:text-blue-200">
                    Active Report
                  </span>
                </div>
                <div className="text-xs space-y-1 text-slate-700 dark:text-slate-300">
                  <p><strong>Patient:</strong> {executionResult.singlePatient.name}</p>
                  <p><strong>Findings:</strong> {executionResult.singlePatient.findings.length} findings transcribed &amp; merged</p>
                  {executionResult.singlePatient.templateUsed && (
                    <p><strong>Template:</strong> {executionResult.singlePatient.templateUsed}</p>
                  )}
                  {executionResult.singlePatient.attachedFilesCount ? (
                    <p><strong>Attached Files:</strong> {executionResult.singlePatient.attachedFilesCount} handed over</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={onNavigateToSingle}
                  className="w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span>Open Active Single Report</span>
                  <span>→</span>
                </button>
              </div>
            )}

            {/* Batch Processing Slice Card */}
            {executionResult.batchPatients && executionResult.batchPatients.length > 0 && (
              <div className="p-4 rounded-xl border border-purple-200 dark:border-purple-800/60 bg-purple-50/50 dark:bg-purple-950/20 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-sm text-purple-900 dark:text-purple-200">
                    <span className="text-base">📑</span>
                    <span>Batch Queue Slice</span>
                  </div>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-200/60 dark:bg-purple-800 text-purple-900 dark:text-purple-200">
                    {executionResult.batchPatients.length} Cases Queued
                  </span>
                </div>
                <div className="text-xs space-y-1 text-slate-700 dark:text-slate-300 max-h-32 overflow-y-auto">
                  {executionResult.batchPatients.map((bp, i) => (
                    <div key={i} className="flex items-center justify-between py-0.5 border-b border-purple-100 dark:border-purple-900/40 last:border-none">
                      <span className="font-medium truncate max-w-[180px]">{bp.name}</span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {bp.findings.length} findings
                        {bp.attachedFilesCount ? ` • ${bp.attachedFilesCount} file(s)` : ''}
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={onNavigateToBatch}
                  className="w-full py-2 px-3 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span>View All in Batch Mode</span>
                  <span>→</span>
                </button>
              </div>
            )}
          </div>

          <div className="pt-2 flex justify-center">
            <button
              type="button"
              onClick={handleResetSession}
              className="py-2.5 px-6 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 font-bold text-xs transition-colors cursor-pointer"
            >
              Start Another Autonomous Session
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AutonomousModeView;
