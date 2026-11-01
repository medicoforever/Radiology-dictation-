import React, { useState, useEffect, useRef } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import {
  parseAutonomousAudioDictation,
  executeAutonomousPlan,
  AutonomousExecutionResult,
  AutonomousExecutionPlan,
  AutonomousAttachedFile
} from '../services/autonomousAgentService';
import type { DocxTemplateData } from './ui/CustomPromptInput';
import { SaveResult } from '../services/googleDriveService';
import { triggerAudioDownload } from '../services/audioMerger';
import MicIcon from './icons/MicIcon';
import StopIcon from './icons/StopIcon';
import SparklesIcon from './icons/SparklesIcon';
import WarningIcon from './icons/WarningIcon';
import DownloadIcon from './icons/DownloadIcon';
import UploadIcon from './icons/UploadIcon';
import CopyIcon from './icons/CopyIcon';
import PencilIcon from './icons/PencilIcon';

interface AutonomousModeViewProps {
  selectedModel: string;
  singleFindingsCount?: number;
  onApplySingleReport: (
    findings: string[], 
    patientName: string, 
    audioBlob?: Blob | null,
    customImages?: Array<{ data: string; mimeType: string }>,
    extraFiles?: File[],
    customPrompt?: string,
    customDocx?: DocxTemplateData | null,
    templateUsed?: string
  ) => void;
  onApplyBatchReports: (batches: Array<{
    name: string;
    findings: string[];
    audioBlobs: Blob[];
    selectedModel: string;
    customPrompt?: string;
    customDocx?: DocxTemplateData | null;
    customImages?: Array<{ data: string; mimeType: string }>;
    extraFiles?: File[];
  }>) => void;
  onNavigateToSingle: () => void;
  onNavigateToBatch: () => void;
  onSaveToDrive?: (result: SaveResult) => void;
}

export const AutonomousModeView: React.FC<AutonomousModeViewProps> = ({
  selectedModel,
  singleFindingsCount = 0,
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
  } = useAudioRecorder();

  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [executionStep, setExecutionStep] = useState<string>('');
  const [executionResult, setExecutionResult] = useState<AutonomousExecutionResult | null>(null);
  const [lastPlan, setLastPlan] = useState<AutonomousExecutionPlan | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Agent State modal
  const [showAgentStateModal, setShowAgentStateModal] = useState(false);
  const [activeModalTab, setActiveModalTab] = useState<'json' | 'markdown'>('json');
  const [copiedState, setCopiedState] = useState(false);

  // Workspace context stats
  const [batchCount, setBatchCount] = useState<number>(0);
  const [singleModeStatus, setSingleModeStatus] = useState<'Empty' | 'Active'>('Empty');
  const templateCount = 72;

  // Staged files attached to the autonomous session
  const [attachedFiles, setAttachedFiles] = useState<AutonomousAttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioUploadInputRef = useRef<HTMLInputElement>(null);

  // Drag and Drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Text Note Composer / Editor modal
  const [isTextModalOpen, setIsTextModalOpen] = useState(false);
  const [textNoteTitle, setTextNoteTitle] = useState('');
  const [textNoteAlias, setTextNoteAlias] = useState('');
  const [textNoteContent, setTextNoteContent] = useState('');
  const [editingFileId, setEditingFileId] = useState<string | null>(null);

  // Sync workspace stats from localStorage
  useEffect(() => {
    try {
      const rawBatches = localStorage.getItem('radiologyDictationBatchMode');
      if (rawBatches) {
        const parsed = JSON.parse(rawBatches);
        if (Array.isArray(parsed)) {
          setBatchCount(parsed.length);
        }
      } else {
        setBatchCount(0);
      }
    } catch {
      setBatchCount(0);
    }

    try {
      const rawSingle = localStorage.getItem('radiologyDictationSingleMode');
      if (rawSingle) {
        const parsed = JSON.parse(rawSingle);
        if (parsed && ((parsed.findings && parsed.findings.length > 0) || parsed.patientName || (parsed.impression && parsed.impression.length > 0))) {
          setSingleModeStatus('Active');
        } else {
          setSingleModeStatus(singleFindingsCount > 0 ? 'Active' : 'Empty');
        }
      } else if (singleFindingsCount > 0) {
        setSingleModeStatus('Active');
      } else {
        setSingleModeStatus('Empty');
      }
    } catch {
      setSingleModeStatus(singleFindingsCount > 0 ? 'Active' : 'Empty');
    }
  }, [singleFindingsCount, executionResult]);

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

  // Global paste handler to automatically capture files or text notes
  useEffect(() => {
    const handleGlobalPaste = async (e: ClipboardEvent) => {
      const activeEl = document.activeElement;
      const isInput = activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA';
      if (isInput) return; // Allow normal typing in inputs

      if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
        e.preventDefault();
        const files = Array.from(e.clipboardData.files);
        await addFilesToState(files);
        return;
      }

      const text = e.clipboardData?.getData('text');
      if (text && text.trim()) {
        e.preventDefault();
        setEditingFileId(null);
        setTextNoteContent(text);
        const firstLine = text.trim().split('\n')[0].slice(0, 24).replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
        setTextNoteTitle(firstLine ? `${firstLine}.txt` : `Pasted_Note_${attachedFiles.length + 1}.txt`);
        setTextNoteAlias('Prior Report');
        setIsTextModalOpen(true);
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [attachedFiles.length]);

  // Add files to state with automatic text detection
  const addFilesToState = async (files: File[]) => {
    const startIndex = attachedFiles.length;
    const newItems: AutonomousAttachedFile[] = [];

    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      let textContent: string | undefined = undefined;
      let isTextNote = false;

      // Detect plain text, markdown, json, csv, rtf files and read snippet
      if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.md') || file.name.endsWith('.json') || file.name.endsWith('.csv')) {
        try {
          textContent = await file.text();
          isTextNote = true;
        } catch {
          // ignore
        }
      }

      newItems.push({
        id: `auto_file_${Date.now()}_${idx}`,
        file,
        index: startIndex + idx + 1,
        alias: '',
        textContent,
        isTextNote
      });
    }

    setAttachedFiles(prev => [...prev, ...newItems]);
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      await addFilesToState(files);
    }
    if (e.target) e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      await addFilesToState(files);
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setTextNoteContent(text);
        if (!textNoteTitle.trim()) {
          const firstLine = text.trim().split('\n')[0].slice(0, 24).replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
          setTextNoteTitle(firstLine ? `${firstLine}.txt` : `Pasted_Note_${attachedFiles.length + 1}.txt`);
        }
        if (!textNoteAlias.trim()) {
          setTextNoteAlias('Prior Report');
        }
      }
    } catch (err) {
      console.warn('Clipboard read permission unavailable or denied:', err);
    }
  };

  const handleSaveTextNote = () => {
    if (!textNoteContent.trim()) return;

    if (editingFileId) {
      // Update existing text note
      setAttachedFiles(prev => prev.map(f => {
        if (f.id === editingFileId) {
          const finalTitle = textNoteTitle.trim() || f.file.name;
          const fileName = finalTitle.includes('.') ? finalTitle : `${finalTitle}.txt`;
          const updatedBlob = new Blob([textNoteContent], { type: 'text/plain;charset=utf-8' });
          const updatedFile = new File([updatedBlob], fileName, { type: 'text/plain', lastModified: Date.now() });
          return {
            ...f,
            file: updatedFile,
            alias: textNoteAlias.trim() || f.alias,
            textContent: textNoteContent,
            isTextNote: true
          };
        }
        return f;
      }));
    } else {
      // Create new text note
      const count = attachedFiles.length + 1;
      const defaultTitle = `Clinical_Note_${count}.txt`;
      const rawTitle = textNoteTitle.trim() || defaultTitle;
      const fileName = rawTitle.includes('.') ? rawTitle : `${rawTitle}.txt`;
      const blob = new Blob([textNoteContent], { type: 'text/plain;charset=utf-8' });
      const file = new File([blob], fileName, { type: 'text/plain', lastModified: Date.now() });

      const newNote: AutonomousAttachedFile = {
        id: `auto_file_${Date.now()}_note`,
        file,
        index: count,
        alias: textNoteAlias.trim() || (textNoteTitle.trim() ? textNoteTitle.trim().replace(/\.[^/.]+$/, "") : 'Clinical Note'),
        textContent: textNoteContent,
        isTextNote: true
      };

      setAttachedFiles(prev => [...prev, newNote]);
    }

    setTextNoteTitle('');
    setTextNoteAlias('');
    setTextNoteContent('');
    setEditingFileId(null);
    setIsTextModalOpen(false);
  };

  const handleOpenEditTextNote = (item: AutonomousAttachedFile) => {
    setEditingFileId(item.id);
    setTextNoteTitle(item.file.name);
    setTextNoteAlias(item.alias || '');
    setTextNoteContent(item.textContent || '');
    setIsTextModalOpen(true);
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

  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setRecordedBlob(file);
      setExecutionResult(null);
      setErrorMessage(null);
    }
    if (e.target) e.target.value = '';
  };

  const handleDownloadLastAudio = () => {
    if (recordedBlob) {
      triggerAudioDownload(recordedBlob, 'autonomous-dictation');
    } else {
      setErrorMessage('No voice audio captured yet in this session. Start dictation or upload an audio file first.');
    }
  };

  const handleExecuteAutonomousSession = async () => {
    if (!recordedBlob) return;

    setIsProcessing(true);
    setErrorMessage(null);
    setExecutionResult(null);

    try {
      setExecutionStep(`Analyzing spoken audio with ${selectedModel}...`);
      const plan: AutonomousExecutionPlan = await parseAutonomousAudioDictation(
        recordedBlob,
        selectedModel,
        attachedFiles
      );
      setLastPlan(plan);

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

  // Helper to determine file badge representation
  const getFileTypeBadge = (item: AutonomousAttachedFile) => {
    if (item.isTextNote) {
      return {
        icon: '📝',
        label: 'Text Note',
        classes: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60'
      };
    }
    const name = item.file.name.toLowerCase();
    const type = (item.file.type || '').toLowerCase();

    if (type.startsWith('image/') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp')) {
      return {
        icon: '🖼️',
        label: 'Image',
        classes: 'bg-indigo-950/80 text-indigo-300 border-indigo-700/60'
      };
    }
    if (name.endsWith('.pdf') || type === 'application/pdf') {
      return {
        icon: '📄',
        label: 'PDF',
        classes: 'bg-red-950/80 text-red-300 border-red-700/60'
      };
    }
    if (name.endsWith('.docx') || name.endsWith('.doc')) {
      return {
        icon: '📑',
        label: 'Word',
        classes: 'bg-blue-950/80 text-blue-300 border-blue-700/60'
      };
    }
    if (name.endsWith('.dcm') || name.endsWith('.dicom') || type.includes('dicom')) {
      return {
        icon: '🩻',
        label: 'DICOM',
        classes: 'bg-cyan-950/80 text-cyan-300 border-cyan-700/60'
      };
    }
    if (type.startsWith('audio/') || name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.m4a') || name.endsWith('.webm')) {
      return {
        icon: '🎧',
        label: 'Audio',
        classes: 'bg-amber-950/80 text-amber-300 border-amber-700/60'
      };
    }
    return {
      icon: '📁',
      label: 'Document',
      classes: 'bg-slate-800 text-slate-300 border-slate-700'
    };
  };

  // Riley Brown Agent-Readable State generators (Plain JSON & Markdown)
  const generateStateJson = (): string => {
    if (lastPlan) {
      return JSON.stringify(lastPlan, null, 2);
    }

    return JSON.stringify({
      superapp: "Radiology Autonomous Superapp",
      architecture: "Riley Brown Superapp Blueprint (Shell + Slices, Agent-Readable State)",
      activeModel: selectedModel,
      workspace: {
        singleMode: {
          status: singleModeStatus,
        },
        batchQueue: {
          count: batchCount,
        },
        templatesAvailable: templateCount,
        stagedHandoverFiles: attachedFiles.map(f => ({
          index: f.index,
          fileName: f.file.name,
          isTextNote: Boolean(f.isTextNote),
          sizeKB: Math.round(f.file.size / 1024),
          type: f.file.type || 'document',
          spokenAlias: f.alias || `File #${f.index}`,
          contentSnippet: f.textContent ? f.textContent.slice(0, 120) : undefined
        })),
        audioCaptured: Boolean(recordedBlob),
        lastExecution: executionResult ? {
          success: executionResult.success,
          totalPatients: executionResult.totalPatients,
          summary: executionResult.summary,
          driveSaved: executionResult.driveSaved,
          htmlDownloaded: executionResult.htmlDownloaded,
          workstationSynced: executionResult.workstationSynced
        } : null
      }
    }, null, 2);
  };

  const generateStateMarkdown = (): string => {
    if (lastPlan) {
      let md = `# Autonomous Execution Manifest\n\n`;
      md += `- **Generated At:** ${new Date().toLocaleString()}\n`;
      md += `- **Model Used:** \`${selectedModel}\`\n`;
      md += `- **Global Summary:** ${lastPlan.summary}\n`;
      md += `- **Drive Save Requested:** ${lastPlan.globalDirectives.saveToDrive ? 'Yes' : 'No'}\n`;
      md += `- **HTML Export Requested:** ${lastPlan.globalDirectives.downloadAllHtml ? 'Yes' : 'No'}\n`;
      md += `- **Workstation Sync Requested:** ${lastPlan.globalDirectives.syncToWorkstation ? 'Yes' : 'No'}\n\n`;
      
      md += `## Patients Dispatched (${lastPlan.patients.length})\n\n`;
      lastPlan.patients.forEach((p, idx) => {
        md += `### ${idx + 1}. ${p.patientName} (${p.targetMode === 'batch' ? 'Batch Queue' : 'Single Dictation'})\n`;
        if (p.templateName) {
          md += `- **Template:** ${p.templateName}\n`;
        }
        if (p.mergeInstructions) {
          md += `- **Merge Instructions:** ${p.mergeInstructions}\n`;
        }
        if (p.attachedFileIndices && p.attachedFileIndices.length > 0) {
          md += `- **Attached Files Handed Over:** ${p.attachedFileIndices.map(i => `File #${i}`).join(', ')}\n`;
        }
        md += `- **Transcribed Findings (${p.findings.length}):**\n`;
        p.findings.forEach(f => {
          md += `  - ${f}\n`;
        });
        md += `\n`;
      });

      if (lastPlan.macrosToCreate && lastPlan.macrosToCreate.length > 0) {
        md += `## Spoken Macros Created\n\n`;
        lastPlan.macrosToCreate.forEach(m => {
          md += `- **Trigger:** \`${m.trigger}\` → **Expansion:** "${m.expansion}"\n`;
        });
        md += `\n`;
      }

      if (lastPlan.vocabularyCorrections && lastPlan.vocabularyCorrections.length > 0) {
        md += `## Vocabulary Corrections\n\n`;
        lastPlan.vocabularyCorrections.forEach(v => {
          md += `- **Replace:** "${v.spokenWord}" → **With:** "${v.replacementWord}"\n`;
        });
        md += `\n`;
      }

      return md;
    }

    let md = `# Radiology Superapp Workspace State\n\n`;
    md += `*Riley Brown Architecture: Rule 1 — Agent-Readable State (Everything is JSON or Markdown)*\n\n`;
    md += `- **Active AI Model:** \`${selectedModel}\`\n`;
    md += `- **Single Mode Status:** ${singleModeStatus}\n`;
    md += `- **Batch Queue:** ${batchCount} cases queued\n`;
    md += `- **Available Templates:** ${templateCount}\n`;
    md += `- **Staged Handover Files & Notes:** ${attachedFiles.length}\n`;
    md += `- **Audio Recording Captured:** ${recordedBlob ? 'Yes' : 'No'}\n\n`;
    
    if (attachedFiles.length > 0) {
      md += `## Staged Handover Files & Text Notes\n`;
      attachedFiles.forEach(f => {
        const noteBadge = f.isTextNote ? ' *(Text Note)*' : '';
        const snippet = f.textContent ? `\n  > "${f.textContent.slice(0, 100).replace(/\n/g, ' ')}${f.textContent.length > 100 ? '...' : ''}"` : '';
        md += `- **#${f.index}:** \`${f.file.name}\`${noteBadge} (${(f.file.size / 1024).toFixed(1)} KB) — *Spoken Alias:* "${f.alias || `File #${f.index}`}"${snippet}\n`;
      });
      md += `\n`;
    }
    
    md += `## Slices Overview\n`;
    md += `- **Slice 1 (Single Mode):** Active instant dictation with RTF format support\n`;
    md += `- **Slice 2 (Batch Queue):** Multi-patient queuing and parallel dispatch\n`;
    md += `- **Slice 3 (Template System):** 72 built-in docx templates and variable injection\n`;
    md += `- **Slice 4 (Agent Bridge):** Zero-Read file & text note router, spoken macro creator, and auto-export\n`;

    return md;
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6 animate-fadeIn pb-12">
      {/* Main Autonomous Director Card matching dark slate aesthetic */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-7 shadow-2xl text-slate-100 space-y-6">
        
        {/* Top Header: Title, Description, and Action Buttons */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <SparklesIcon className="w-6 h-6 text-indigo-400 shrink-0" />
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
                Autonomous Voice &amp; File Orchestrator
              </h2>
            </div>
            <p className="text-xs sm:text-sm text-slate-400 mt-1.5 max-w-2xl leading-relaxed">
              Dictate naturally to control Single Mode, Batch Mode, Templates, Macros, File Handovers, HTML Exports, and Google Drive in one go.
            </p>
          </div>

          <div className="flex items-center gap-2.5 shrink-0 self-start sm:self-center">
            <button
              type="button"
              onClick={handleDownloadLastAudio}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 transition-colors cursor-pointer shadow-sm disabled:opacity-50"
              title="Download the last recorded or uploaded voice audio"
            >
              <DownloadIcon className="w-4 h-4 text-slate-300" />
              <span>Download Last Audio</span>
            </button>
            <button
              type="button"
              onClick={() => setShowAgentStateModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 transition-colors cursor-pointer shadow-sm"
              title="Inspect Riley Brown's Agent-Readable State (Manifest & Markdown)"
            >
              <span className="font-mono text-indigo-400 font-bold">&lt;/&gt;</span>
              <span>Agent State (.md / .json)</span>
            </button>
          </div>
        </div>

        {/* Live Workspace Context Bar */}
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-300">
            <span className="font-bold text-white">Live Workspace Context:</span>
            <span>Single Mode: <strong className={singleModeStatus === 'Active' ? 'text-emerald-400 font-semibold' : 'text-slate-200 font-semibold'}>{singleModeStatus}</strong></span>
            <span className="text-slate-600">·</span>
            <span>Batch Queue: <strong className="text-slate-200 font-semibold">{batchCount} {batchCount === 1 ? 'batch' : 'batches'}</strong></span>
            <span className="text-slate-600">·</span>
            <span>Templates: <strong className="text-slate-200 font-semibold">{templateCount}</strong></span>
            <span className="text-slate-600">·</span>
            <span>Model: <strong className="text-indigo-400 font-mono font-semibold">{selectedModel}</strong></span>
          </div>

          <div className="flex items-center gap-2 text-xs shrink-0">
            <button
              type="button"
              onClick={onNavigateToSingle}
              className="text-indigo-400 hover:text-indigo-300 font-semibold transition-colors cursor-pointer"
            >
              View Single
            </button>
            <span className="text-slate-600">·</span>
            <button
              type="button"
              onClick={onNavigateToBatch}
              className="text-indigo-400 hover:text-indigo-300 font-semibold transition-colors cursor-pointer"
            >
              View Batches
            </button>
          </div>
        </div>

        {/* Primary Action Buttons: Start Dictation & Upload Voice Audio */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          {/* Record / Stop Button */}
          <button
            type="button"
            onClick={isRecording ? handleStopRecording : handleStartRecording}
            disabled={isProcessing}
            className={`w-full sm:w-auto px-7 py-3.5 rounded-xl font-bold text-sm sm:text-base flex items-center justify-center gap-2.5 transition-all shadow-lg cursor-pointer ${
              isRecording
                ? 'bg-red-600 hover:bg-red-700 text-white ring-4 ring-red-500/30 animate-pulse'
                : 'bg-gradient-to-r from-blue-600 via-indigo-600 to-indigo-700 hover:from-blue-500 hover:to-indigo-600 text-white ring-2 ring-indigo-500/20 active:scale-95'
            } disabled:opacity-50`}
          >
            {isRecording ? (
              <>
                <StopIcon className="w-5 h-5" />
                <span>Stop Recording ({formatTime(recordingDuration)})</span>
              </>
            ) : (
              <>
                <MicIcon className="w-5 h-5 text-indigo-200" />
                <span>Start Autonomous Dictation</span>
              </>
            )}
          </button>

          {/* Upload Voice Audio */}
          <input
            type="file"
            ref={audioUploadInputRef}
            onChange={handleAudioUpload}
            accept="audio/*,.webm,.wav,.mp3,.m4a,.ogg"
            className="hidden"
          />
          <button
            type="button"
            onClick={() => audioUploadInputRef.current?.click()}
            disabled={isRecording || isProcessing}
            className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-slate-800 hover:bg-slate-700/90 border border-slate-700 text-slate-200 font-semibold text-sm sm:text-base flex items-center justify-center gap-2.5 transition-colors cursor-pointer shadow-md disabled:opacity-50"
          >
            <UploadIcon className="w-5 h-5 text-slate-400" />
            <span>Upload Voice Audio</span>
          </button>
        </div>

        {/* Audio Player & Execute Console (when audio is captured) */}
        {recordedBlob && !isRecording && (
          <div className="bg-slate-950/70 border border-indigo-900/50 rounded-xl p-4 flex flex-col items-center gap-3 animate-fadeIn">
            <div className="flex items-center justify-between w-full text-xs text-slate-300">
              <span className="font-semibold text-emerald-400 flex items-center gap-1.5">
                <span>✓ Voice Audio Ready</span>
                <span className="text-slate-400 font-mono">({(recordedBlob.size / 1024 / 1024).toFixed(2)} MB)</span>
              </span>
              <span className="text-slate-400">Target Model: <strong className="text-indigo-300 font-mono">{selectedModel}</strong></span>
            </div>

            {audioUrl && (
              <audio controls src={audioUrl} className="w-full h-10 rounded-lg" />
            )}

            <div className="flex flex-wrap items-center gap-2.5 w-full">
              <button
                type="button"
                onClick={handleExecuteAutonomousSession}
                disabled={isProcessing}
                className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-sm shadow-md hover:shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <SparklesIcon className="w-4 h-4 text-emerald-100" />
                <span>Execute Autonomous Plan</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadLastAudio}
                className="py-3 px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold text-xs transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                title="Download this audio recording"
              >
                <DownloadIcon className="w-4 h-4 text-slate-400" />
                <span>Save Audio</span>
              </button>
              <button
                type="button"
                onClick={handleResetSession}
                className="py-3 px-3.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-400 hover:text-slate-200 text-xs transition-colors cursor-pointer"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {/* Processing Indicator */}
        {isProcessing && (
          <div className="p-4 rounded-xl bg-indigo-950/40 border border-indigo-800/70 space-y-3 animate-pulse text-center">
            <div className="flex items-center justify-center gap-2 text-indigo-300 font-bold text-sm">
              <div className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin"></div>
              <span>{executionStep || 'Orchestrating autonomous actions...'}</span>
            </div>
            <p className="text-xs text-slate-400">
              Using model <strong className="text-indigo-300 font-mono">{selectedModel}</strong> to transcribe, resolve patient addenda, and dispatch reports.
            </p>
          </div>
        )}

        {/* Error Alert with Dismissal */}
        {errorMessage && (
          <div className="p-4 rounded-xl bg-red-950/50 border border-red-800 text-red-200 flex items-start gap-3 shadow-md animate-fadeIn">
            <WarningIcon className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 text-xs sm:text-sm space-y-1">
              <p className="font-bold">Autonomous Execution Notice</p>
              <p>{errorMessage}</p>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="text-xs font-semibold text-red-400 hover:text-red-300 underline shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Attached Files & Clinical Notes for Handover Section */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`rounded-xl border transition-all ${
            isDraggingOver 
              ? 'border-dashed border-2 border-indigo-500 bg-indigo-950/60 ring-4 ring-indigo-500/20' 
              : 'border-slate-800 bg-slate-950/40'
          } p-4 sm:p-5 space-y-3 relative`}
        >
          {isDraggingOver && (
            <div className="absolute inset-0 bg-indigo-950/80 backdrop-blur-xs rounded-xl flex items-center justify-center z-20 pointer-events-none">
              <div className="text-center space-y-1.5">
                <span className="text-3xl">📥</span>
                <p className="text-sm font-bold text-white">Drop any file(s) here</p>
                <p className="text-xs text-indigo-300">All file formats supported (PDF, DICOM, images, Word, text, scans)</p>
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base text-indigo-400">📚</span>
                <h3 className="text-sm font-bold text-white">
                  Attached Files &amp; Text Notes ({attachedFiles.length})
                </h3>
              </div>
              <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
                Attach any kind of file (PDFs, DICOM, images, Word docs, text) or type/paste clinical text notes &amp; prior reports. Give items a spoken recognition alias or refer to them as &quot;first file&quot;, &quot;prior report note&quot;, etc. Main AI hands them over based on your voice instructions.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {/* Add Any File input and button */}
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFilesSelected}
                multiple
                accept="*/*"
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-indigo-950/70 hover:bg-indigo-900 border border-indigo-700/60 text-indigo-300 transition-colors cursor-pointer"
                title="Upload any file from your computer (PDFs, DICOM, images, Word docx, text files, scans, audio, etc.)"
              >
                <UploadIcon className="w-3.5 h-3.5 text-indigo-400" />
                <span>+ Add Any File(s)</span>
              </button>

              {/* Type or Paste Text button */}
              <button
                type="button"
                onClick={() => {
                  setEditingFileId(null);
                  setTextNoteTitle('');
                  setTextNoteAlias('');
                  setTextNoteContent('');
                  setIsTextModalOpen(true);
                }}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors cursor-pointer"
                title="Type or paste text directly (prior reports, EHR clinical notes, discharge summaries, etc.)"
              >
                <span className="text-emerald-400 text-sm">📝</span>
                <span>+ Type / Paste Text</span>
              </button>
            </div>
          </div>

          {/* Empty State / Helpful Guidance */}
          {attachedFiles.length === 0 && (
            <div className="py-6 px-4 rounded-xl border border-dashed border-slate-800/80 bg-slate-900/40 text-center space-y-2">
              <div className="flex flex-wrap items-center justify-center gap-2 text-slate-400 text-xs sm:text-sm">
                <span>📁 All file types supported</span>
                <span className="text-slate-600">·</span>
                <span>📝 Typing &amp; Pasting text supported</span>
                <span className="text-slate-600">·</span>
                <span>📥 Drag &amp; Drop or Ctrl+V anytime</span>
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Attach scans, PDFs, DICOM, Word docs, images, or paste EHR clinical notes and prior reports.
              </p>
              <div className="flex items-center justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold cursor-pointer underline"
                >
                  Browse Files
                </button>
                <span className="text-slate-600 text-xs">or</span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingFileId(null);
                    setTextNoteTitle('');
                    setTextNoteAlias('');
                    setTextNoteContent('');
                    setIsTextModalOpen(true);
                  }}
                  className="text-xs text-emerald-400 hover:text-emerald-300 font-semibold cursor-pointer underline"
                >
                  Paste / Type Text Note
                </button>
              </div>
            </div>
          )}

          {/* Staged Attached Files & Text Notes Cards */}
          {attachedFiles.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-slate-800">
              {attachedFiles.map((item) => {
                const badge = getFileTypeBadge(item);
                const wordCount = item.textContent 
                  ? item.textContent.trim().split(/\s+/).filter(Boolean).length 
                  : 0;

                return (
                  <div
                    key={item.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-lg bg-slate-900/90 border border-slate-800 text-xs hover:border-slate-700/80 transition-colors"
                  >
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <span className="px-2 py-0.5 rounded-md font-mono font-bold bg-indigo-950 border border-indigo-700/50 text-indigo-300 shrink-0 mt-0.5">
                        #{item.index}
                      </span>

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${badge.classes}`}>
                            {badge.icon} {badge.label}
                          </span>
                          <span className="font-semibold text-slate-200 truncate block max-w-xs sm:max-w-md" title={item.file.name}>
                            {item.file.name}
                          </span>
                          <span className="text-[11px] text-slate-500">
                            {item.isTextNote && wordCount > 0 ? `${wordCount} words · ` : ''}
                            {(item.file.size / 1024).toFixed(1)} KB
                          </span>
                        </div>

                        {/* Text note preview snippet */}
                        {item.textContent && (
                          <p className="text-[11px] text-slate-400 italic line-clamp-1 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800/80">
                            &quot;{item.textContent.slice(0, 110).trim()}{item.textContent.length > 110 ? '...' : ''}&quot;
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                      <input
                        type="text"
                        placeholder={`Spoken alias (e.g. "Brain MRI" or "Prior Report")`}
                        value={item.alias || ''}
                        onChange={(e) => handleUpdateAlias(item.id, e.target.value)}
                        className="text-xs px-2.5 py-1.5 rounded-md border border-slate-700 bg-slate-950 text-slate-100 placeholder-slate-500 w-44 sm:w-56 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                        title="Give this file or note a spoken recognition name so you can refer to it easily in your dictation"
                      />

                      {/* View / Edit Button for Text Notes */}
                      {(item.isTextNote || item.textContent) && (
                        <button
                          type="button"
                          onClick={() => handleOpenEditTextNote(item)}
                          className="px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold transition-colors flex items-center gap-1 cursor-pointer"
                          title="View or edit this text note"
                        >
                          <PencilIcon className="w-3 h-3 text-emerald-400" />
                          <span>Edit</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleRemoveFile(item.id)}
                        className="p-1.5 text-slate-400 hover:text-red-400 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
                        title="Remove attached item"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Examples Section */}
        <div className="space-y-2.5">
          <div className="text-xs font-semibold text-slate-400">
            Examples of what you can say in a single Autonomous Dictation:
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            {/* Card 1 */}
            <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1.5">
              <div className="font-bold text-white">
                Non-Linear Single + Batch Dictation:
              </div>
              <p className="text-slate-400 italic leading-relaxed">
                &quot;Use single dictation for Patient Ramesh: CT Brain shows right MCA infarct. Now use batch mode and create 5 patients... Oh, and back to Ramesh in single mode, add 4mm midline shift and merge with CT Brain Plain template.&quot;
              </p>
            </div>

            {/* Card 2 */}
            <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1.5">
              <div className="font-bold text-white">
                File Handover, Drive Save &amp; HTML Export:
              </div>
              <p className="text-slate-400 italic leading-relaxed">
                &quot;Hand over the first uploaded file to Single Mode, put the 2nd and 3rd files into Batch Mode, save everything to Google Drive, and download all HTMLs of the batch.&quot;
              </p>
            </div>
          </div>
        </div>

        {/* Execution Results Dashboard */}
        {executionResult && executionResult.success && (
          <div className="rounded-xl border border-emerald-500/30 bg-slate-950/80 p-5 space-y-5 animate-fadeIn">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                  ✓ Plan Executed Successfully
                </span>
                <h3 className="text-lg font-bold text-white">
                  Autonomous Dispatch Summary
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-950 border border-indigo-700/60 text-indigo-300">
                  {executionResult.totalPatients} Patients Processed
                </span>
                {executionResult.driveSaved && (
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-950 border border-emerald-700/60 text-emerald-300">
                    Drive Saved ✓
                  </span>
                )}
                {executionResult.htmlDownloaded && (
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-950 border border-blue-700/60 text-blue-300">
                    HTML Downloaded ✓
                  </span>
                )}
                {executionResult.workstationSynced && (
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-950 border border-amber-700/60 text-amber-300">
                    Workstation Synced ✓
                  </span>
                )}
              </div>
            </div>

            <p className="text-xs sm:text-sm text-slate-300 bg-slate-900 p-3 rounded-lg border border-slate-800 italic">
              &quot;{executionResult.summary}&quot;
            </p>

            {/* Handed Over Files Notification */}
            {executionResult.handedOverFilesSummary && executionResult.handedOverFilesSummary.length > 0 && (
              <div className="p-3.5 rounded-lg bg-indigo-950/40 border border-indigo-800/60 text-xs space-y-1">
                <p className="font-bold text-indigo-300 flex items-center gap-1.5">
                  <span>📎 Handed Over Files &amp; Notes (Zero-Read Principle):</span>
                </p>
                {executionResult.handedOverFilesSummary.map((item, idx) => (
                  <p key={idx} className="text-slate-300 pl-2">
                    • <strong>{item.patientName}:</strong> {item.fileNames.join(', ')}
                  </p>
                ))}
              </div>
            )}

            {/* Spoken Macros & Vocabulary Created Notice */}
            {((executionResult.macrosCreated && executionResult.macrosCreated.length > 0) || 
              (executionResult.vocabularyCreated && executionResult.vocabularyCreated.length > 0)) && (
              <div className="p-3.5 rounded-lg bg-purple-950/40 border border-purple-800/60 text-xs space-y-1">
                {executionResult.macrosCreated && executionResult.macrosCreated.length > 0 && (
                  <p className="text-purple-300">
                    ✨ <strong>Spoken Macros Created:</strong> {executionResult.macrosCreated.join(', ')}
                  </p>
                )}
                {executionResult.vocabularyCreated && executionResult.vocabularyCreated.length > 0 && (
                  <p className="text-purple-300">
                    📖 <strong>Dictionary Rules Added:</strong> {executionResult.vocabularyCreated.join(', ')}
                  </p>
                )}
              </div>
            )}

            {/* Slices Cards: Single Report & Batch Queue */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Single Dictation Slice Card */}
              {executionResult.singlePatient && (
                <div className="p-4 rounded-xl border border-indigo-900/60 bg-slate-900/90 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-sm text-indigo-300">
                      <MicIcon className="w-4 h-4 text-indigo-400" />
                      <span>Single Dictation Slice</span>
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-950 border border-indigo-700/50 text-indigo-300">
                      Active Report
                    </span>
                  </div>
                  <div className="text-xs space-y-1 text-slate-300">
                    <p><strong>Patient:</strong> {executionResult.singlePatient.name}</p>
                    <p><strong>Findings:</strong> {executionResult.singlePatient.findings.length} findings transcribed &amp; merged</p>
                    {executionResult.singlePatient.templateUsed && (
                      <p><strong>Template (RTF Ready):</strong> {executionResult.singlePatient.templateUsed}</p>
                    )}
                    {executionResult.singlePatient.attachedFilesCount ? (
                      <p><strong>Attached Items:</strong> {executionResult.singlePatient.attachedFilesCount} handed over</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={onNavigateToSingle}
                    className="w-full py-2.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-sm transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <span>Open Active Single Report</span>
                    <span>→</span>
                  </button>
                </div>
              )}

              {/* Batch Processing Slice Card */}
              {executionResult.batchPatients && executionResult.batchPatients.length > 0 && (
                <div className="p-4 rounded-xl border border-purple-900/60 bg-slate-900/90 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-sm text-purple-300">
                      <span className="text-base">📑</span>
                      <span>Batch Queue Slice</span>
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-950 border border-purple-700/50 text-purple-300">
                      {executionResult.batchPatients.length} Cases Queued
                    </span>
                  </div>
                  <div className="text-xs space-y-1 text-slate-300 max-h-32 overflow-y-auto">
                    {executionResult.batchPatients.map((bp, i) => (
                      <div key={i} className="flex items-center justify-between py-1 border-b border-slate-800 last:border-none">
                        <span className="font-medium truncate max-w-[180px]">{bp.name}</span>
                        <span className="text-slate-400">
                          {bp.findings.length} findings
                          {bp.attachedFilesCount ? ` • ${bp.attachedFilesCount} file(s)` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={onNavigateToBatch}
                    className="w-full py-2.5 px-3 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs shadow-sm transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
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
                className="py-2.5 px-6 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs transition-colors cursor-pointer"
              >
                Start Another Autonomous Session
              </button>
            </div>
          </div>
        )}

      </div>

      {/* Type / Paste Clinical Text Note Modal */}
      {isTextModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-5 animate-fadeIn">
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-2xl w-full flex flex-col shadow-2xl text-slate-100 overflow-hidden">
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="text-xl">📝</span>
                <div>
                  <h3 className="text-base font-bold text-white">
                    {editingFileId ? 'Edit Clinical Text Note' : 'Type or Paste Clinical Text Note'}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Paste prior reports, clinical history, operative notes, or type reference text for voice handover.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsTextModalOpen(false);
                  setEditingFileId(null);
                }}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 sm:p-5 space-y-4">
              {/* Quick Paste Button & Toolbar */}
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={handlePasteFromClipboard}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-700/60 text-indigo-300 text-xs font-semibold transition-colors cursor-pointer"
                  title="Paste clipboard text directly into the text editor"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  <span>Paste from Clipboard</span>
                </button>

                {textNoteContent && (
                  <button
                    type="button"
                    onClick={() => setTextNoteContent('')}
                    className="text-xs text-slate-400 hover:text-red-400 transition-colors cursor-pointer"
                  >
                    Clear Text
                  </button>
                )}
              </div>

              {/* Title & Spoken Alias Inputs */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">
                    Document Title / Filename:
                  </label>
                  <input
                    type="text"
                    placeholder={`e.g. Prior CT Brain Report.txt`}
                    value={textNoteTitle}
                    onChange={(e) => setTextNoteTitle(e.target.value)}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-slate-100 placeholder-slate-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">
                    Spoken Recognition Alias:
                  </label>
                  <input
                    type="text"
                    placeholder={`e.g. Prior Report or Clinical History`}
                    value={textNoteAlias}
                    onChange={(e) => setTextNoteAlias(e.target.value)}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-slate-100 placeholder-slate-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Clinical Text Area */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <label className="font-semibold text-slate-300">
                    Clinical Text Content:
                  </label>
                  <span>
                    {textNoteContent.trim() ? textNoteContent.trim().split(/\s+/).filter(Boolean).length : 0} words · {textNoteContent.length} chars
                  </span>
                </div>
                <textarea
                  rows={8}
                  placeholder="Paste or type prior radiology findings, surgical notes, patient clinical history, or discharge summary here..."
                  value={textNoteContent}
                  onChange={(e) => setTextNoteContent(e.target.value)}
                  className="w-full text-xs p-3 rounded-xl border border-slate-700 bg-slate-950 text-slate-100 placeholder-slate-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none font-mono leading-relaxed resize-y"
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-950/60 border-t border-slate-800 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setIsTextModalOpen(false);
                  setEditingFileId(null);
                }}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveTextNote}
                disabled={!textNoteContent.trim()}
                className="px-5 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold shadow-md transition-all cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
              >
                {editingFileId ? 'Save Changes' : '+ Attach Text Document'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Riley Brown Agent State Modal (JSON Manifest / Markdown) */}
      {showAgentStateModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-5 animate-fadeIn">
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl text-slate-100 overflow-hidden">
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-indigo-400 font-bold text-lg">&lt;/&gt;</span>
                <div>
                  <h3 className="text-base font-bold text-white">
                    Agent-Readable State (.json / .md)
                  </h3>
                  <p className="text-xs text-slate-400">
                    Riley Brown Architecture: Plain-text state allowing autonomous agents to inspect and manipulate slices.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAgentStateModal(false)}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Modal Tabs & Actions */}
            <div className="px-4 py-2.5 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
                <button
                  type="button"
                  onClick={() => setActiveModalTab('json')}
                  className={`px-3 py-1 rounded-md font-semibold transition-colors cursor-pointer ${
                    activeModalTab === 'json'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  JSON Manifest
                </button>
                <button
                  type="button"
                  onClick={() => setActiveModalTab('markdown')}
                  className={`px-3 py-1 rounded-md font-semibold transition-colors cursor-pointer ${
                    activeModalTab === 'markdown'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Markdown Summary
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  const content = activeModalTab === 'json' ? generateStateJson() : generateStateMarkdown();
                  navigator.clipboard.writeText(content);
                  setCopiedState(true);
                  setTimeout(() => setCopiedState(false), 2000);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 transition-colors cursor-pointer"
              >
                {copiedState ? (
                  <span className="text-emerald-400 font-bold">✓ Copied!</span>
                ) : (
                  <>
                    <CopyIcon className="w-3.5 h-3.5" />
                    <span>Copy {activeModalTab.toUpperCase()}</span>
                  </>
                )}
              </button>
            </div>

            {/* Code Viewer Body */}
            <div className="p-4 overflow-y-auto flex-1 font-mono text-xs bg-slate-950 text-slate-300 leading-relaxed selection:bg-indigo-600 selection:text-white">
              <pre className="whitespace-pre-wrap break-words">
                {activeModalTab === 'json' ? generateStateJson() : generateStateMarkdown()}
              </pre>
            </div>

            {/* Modal Footer */}
            <div className="p-3 bg-slate-900 border-t border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setShowAgentStateModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AutonomousModeView;
