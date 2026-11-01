import React, { useState, useEffect, useRef, useCallback } from 'react';
import ChatInterface from './ChatInterface';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { continueAudioDictation, modifyFindingWithAudio, modifyReportWithAudio, runComplexImpressionGeneration, transcribeAudioForPrompt, detectAndExtractTemplate, mergeDictatedFindingsWithTemplate } from '../services/geminiService';
import Spinner from './ui/Spinner';
import PencilIcon from './icons/PencilIcon';
import MicPlusIcon from './icons/MicPlusIcon';
import StopIcon from './icons/StopIcon';
import { generateSingleDictationHTML } from '../services/htmlGenerator';
import SelectionCopier from './ui/SelectionCopier';
import MicPencilIcon from './icons/MicPencilIcon';
import MicScribbleIcon from './icons/MicScribbleIcon';
import ReorderIcon from './icons/ReorderIcon';
import MergeIcon from './icons/MergeIcon';
import CustomPromptInput from './ui/CustomPromptInput';
import { IdentifiedError } from '../types';
import { AVAILABLE_MODELS, REPORT_TEMPLATES, ReportTemplate } from '../constants';
import WarningIcon from './icons/WarningIcon';
import BrainIcon from './icons/BrainIcon';
import MicIcon from './icons/MicIcon';
import DownloadIcon from './icons/DownloadIcon';
import TrashIcon from './icons/TrashIcon';
import PauseIcon from './icons/PauseIcon';
import ResumeIcon from './icons/ResumeIcon';
import UploadIcon from './icons/UploadIcon';
import SparklesIcon from './icons/SparklesIcon';
import TemplateSelectionModal from './ui/TemplateSelectionModal';
import { getTemplateDocxBase64 } from '../services/builtInTemplates';
import ImageIcon from './icons/ImageIcon';
import { mergeAudioBlobs, triggerAudioDownload } from '../services/audioMerger';
import { generateDocxFromMarkdown, downloadFile, isTableRowFinding, parseTableRow, parseMarkdownTable, tableToPlainText } from '../services/docxService';
import { stopRepeatingInterruptedAlert } from '../services/soundService';
import RichTextReportEditor from './RichTextReportEditor';
import type { DocxTemplateData } from './ui/CustomPromptInput';
import { CheckSquare, CheckCircle2, FileAudio, FolderDown, RotateCcw, ClipboardPaste, FileText, Trash2, Plus } from 'lucide-react';
import QuickMacroInsertPopover from './QuickMacroInsertPopover';
import PasteTextModal from './PasteTextModal';
import { 
  saveDictateChangesAudio, 
  getDictateChangesAudio, 
  deleteDictateChangesAudio, 
  hasStoredDictateChangesAudio 
} from '../services/audioStorage';

interface ChatMessage {
  author: 'You' | 'AI';
  text: string;
}

interface ResultsDisplayProps {
  findings: string[];
  onReset: () => void;
  audioBlob: Blob | Blob[] | null;
  chatHistory: ChatMessage[];
  isChatting: boolean;
  onSendMessage: (message: string | Blob) => void;
  onSwitchToBatch: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  onReprocess: (extraFiles?: File[]) => void;
  onUpdateFinding: (index: number, newText: string) => void;
  onAllFindingsUpdate: (findings: string[]) => void;
  onContinueDictation: (newAudioBlob: Blob, mergedBlob?: Blob) => Promise<void>;
  onAudioBlobUpdate?: (newBlob: Blob) => void;
  customPrompt: string;
  onCustomPromptChange: (prompt: string) => void;
  customImages?: Array<{ data: string; mimeType: string }>;
  onCustomImagesChange: (images: Array<{ data: string; mimeType: string }>) => void;
  customDocx?: DocxTemplateData | null;
  onCustomDocxChange?: (docx: DocxTemplateData | null) => void;
  isLive?: boolean;
  onStopLive?: () => void;
  liveStatus?: string;
  liveError?: string | null;
  onPauseLive?: () => void;
  onResumeLive?: () => void;
  audioLevel?: number;
  isPausedLive?: boolean;
  identifiedErrors?: IdentifiedError[];
  errorCheckStatus?: 'idle' | 'checking' | 'complete';
  onOpenMacrosModal?: () => void;
}

const formatAudioDuration = (totalSeconds: number): string => {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const parseStructuredFinding = (finding: string) => {
  const parts = finding.split('###');
  if (parts.length > 1 && parts[0].trim() !== '') {
    const isTable = isTableRowFinding(finding) || parts.every(p => p.includes('|'));
    return {
      isStructured: true,
      isTable,
      title: parts[0],
      points: parts.slice(1).filter(p => p.trim() !== ''),
      tableLines: parts.map(p => p.trim()).filter(Boolean),
    };
  }
  const isTable = isTableRowFinding(finding);
  return {
    isStructured: false,
    isTable,
    title: finding,
    points: [],
    tableLines: isTable ? [finding] : [],
  };
};

export const renderTableFinding = (lines: string[]) => {
  const rows = lines.map(line => parseTableRow(line));
  if (rows.length === 0) return null;
  const maxCols = Math.max(...rows.map(r => r.length), 1);
  const header = rows[0];
  const body = rows.slice(1);

  return (
    <div className="overflow-x-auto my-2 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xs bg-white dark:bg-slate-900">
      <table className="w-full text-xs text-left border-collapse">
        <thead>
          <tr className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-bold border-b border-slate-200 dark:border-slate-700">
            {header.map((col, idx) => (
              <th key={idx} className="px-3 py-2 border-r last:border-r-0 border-slate-200 dark:border-slate-700">
                {col.replace(/^BOLD::/i, '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rIdx) => (
            <tr 
              key={rIdx} 
              className={`border-b last:border-b-0 border-slate-200 dark:border-slate-800 ${
                rIdx % 2 === 1 ? 'bg-slate-50/60 dark:bg-slate-850/50' : 'bg-white dark:bg-slate-900'
              }`}
            >
              {Array.from({ length: maxCols }).map((_, cIdx) => {
                const val = row[cIdx] || '';
                const isBold = val.startsWith('BOLD::');
                const cleanVal = val.replace(/^BOLD::/, '');
                return (
                  <td key={cIdx} className="px-3 py-2 border-r last:border-r-0 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300">
                    {isBold ? <strong>{cleanVal}</strong> : cleanVal}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const isReportTitle = (text: string, index: number): boolean => {
  if (index !== 0) return false;
  const t = text.replace(/BOLD::/g, '').trim();
  if (!t) return false;
  if (t === 'C.T.SCAN OF BRAIN (PLAIN)') return true;
  if (/^(MRI|CT|C\.T\.|USG|ULTRASOUND|X-RAY|NCCT|CECT|HRCT|PET-CT|DEXA)\b/i.test(t)) return true;
  if (t === t.toUpperCase() && t.length < 120 && !t.startsWith('IMPRESSION') && !t.startsWith('*')) return true;
  return false;
};

export const sanitizeTitleText = (text: string): string => {
  return text
    .replace(/^BOLD::/i, '')
    .replace(/\s*clinical\s*(profile|history)\s*:?.*$/i, '')
    .trim();
};

export const isClinicalProfileFinding = (text: string): boolean => {
  const clean = text.replace(/^BOLD::/i, '').replace(/^[*_\s]+|[*_\s]+$/g, '').trim();
  return /^clinical\s*(profile|history):/i.test(clean);
};

export const formatClinicalProfileText = (text: string): string => {
  let clean = text.replace(/^BOLD::/i, '').trim();
  clean = clean.replace(/^[*_\s]+/, '');
  clean = clean.replace(/[*_\s]+$/, '');
  clean = clean.replace(/\.\*+$/, '.');
  clean = clean.replace(/[*_]+$/, '').trim();
  clean = clean.replace(/^Clinical\s*(Profile|History)\s*:?\s*/i, 'Clinical Profile: ');
  clean = clean.replace(/^Clinical Profile:\s*\*+/i, 'Clinical Profile: ');
  clean = clean.replace(/[*_\s]+$/, '').trim();
  clean = clean.replace(/^[*_\s]+/, '').trim();
  return clean.trim();
};


declare const ClipboardItem: any;

const ResultsDisplay: React.FC<ResultsDisplayProps> = ({ 
  findings, 
  onReset, 
  audioBlob, 
  chatHistory, 
  isChatting, 
  onSendMessage, 
  onSwitchToBatch,
  selectedModel,
  onModelChange,
  onReprocess,
  onUpdateFinding,
  onAllFindingsUpdate,
  onContinueDictation,
  onAudioBlobUpdate,
  customPrompt,
  onCustomPromptChange,
  customImages,
  onCustomImagesChange,
  customDocx,
  onCustomDocxChange,
  isLive = false,
  onStopLive,
  liveStatus,
  liveError,
  onPauseLive,
  onResumeLive,
  audioLevel = 0,
  isPausedLive = false,
  identifiedErrors = [],
  errorCheckStatus = 'idle',
  onOpenMacrosModal,
}) => {
  const [isAllCopied, setIsAllCopied] = useState<boolean>(false);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set<number>());
  const [copyNotification, setCopyNotification] = useState<{ text: string; visible: boolean }>({ text: '', visible: false });
  const [multiSelectMode, setMultiSelectMode] = useState<boolean>(false);

  // Detect if user is in "Merging with template" mode using comprehensive detector
  const detectedTemplate = detectAndExtractTemplate(customPrompt, customImages, customDocx);
  const isTemplateMergeMode = Boolean(
    detectedTemplate.isTemplateMode ||
    customDocx ||
    (customImages && customImages.length > 0) ||
    (customPrompt && (
      customPrompt.toLowerCase().includes('template') ||
      customPrompt.toLowerCase().includes('docx') ||
      customPrompt.toLowerCase().includes('merge') ||
      customPrompt.toLowerCase().includes('normal')
    ))
  );

  const activeTemplateName = detectedTemplate.templateName
    ? detectedTemplate.templateName
    : (customDocx?.name
      ? customDocx.name.replace(/\.[^/.]+$/, '').replace(/^\d+[-_ ]*/, '')
      : (customImages && customImages.length > 0
        ? 'Reference Image Template'
        : (customPrompt?.match(/normal (.*?) report template/i)?.[1] || 'Radiology Template')));

  // State to toggle RTF editor view (defaults to open in template merge mode, or user toggleable)
  const [showRtfEditor, setShowRtfEditor] = useState<boolean>(true);

  // State for Post-Dictation Template Merging
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);
  const [isMergingTemplate, setIsMergingTemplate] = useState<boolean>(false);
  const [mergingTemplateName, setMergingTemplateName] = useState<string | null>(null);

  const handleSelectTemplateToMerge = async (template: ReportTemplate | ReportTemplate[]) => {
    setIsTemplateModalOpen(false);
    setIsMergingTemplate(true);
    setUndoState(findings); // Save snapshot for instant undo

    const templates = Array.isArray(template) ? template : [template];
    const isMulti = templates.length > 1;
    const templateName = templates.map(t => t.name).join(' + ');
    setMergingTemplateName(templateName);

    let docxData: DocxTemplateData;
    let promptText: string;

    if (isMulti) {
      const ids = templates.map(t => t.id).filter(Boolean).join(', ');
      const names = templates.map(t => `"${t.name}"`).join(' and ');
      promptText = `[TEMPLATE_ID: ${ids}] Use combined report templates: ${names}. Integrate my dictation into a unified multi-region report with findings properly placed in their respective anatomical sections and generate a synthesized impression.`;

      const combinedExtractedText = templates.map(t => {
        const content = t.lines ? t.lines.join('\n') : (t.content || '');
        return `=== TEMPLATE: ${t.name} ===\n${content}`;
      }).join('\n\n');

      let firstDocx = '';
      for (const t of templates) {
        if (t.docxBase64) {
          firstDocx = t.docxBase64;
          break;
        } else if (t.id) {
          try {
            const d = await getTemplateDocxBase64(t.id);
            if (d) {
              firstDocx = d;
              break;
            }
          } catch (e) {}
        }
      }

      docxData = {
        name: `${templateName}.docx`,
        data: firstDocx,
        size: firstDocx ? Math.round(firstDocx.length * 0.75) : 0,
        extractedText: combinedExtractedText,
      };
    } else {
      const singleT = templates[0];
      let docx = singleT.docxBase64;
      if (!docx && singleT.id) {
        try {
          docx = await getTemplateDocxBase64(singleT.id);
        } catch (err) {
          console.warn('Error loading docx for template:', err);
        }
      }
      const extractedText = singleT.lines ? singleT.lines.join('\n') : singleT.content;
      docxData = {
        name: singleT.fileName || `${singleT.name}.docx`,
        data: docx || '',
        size: docx ? Math.round(docx.length * 0.75) : 0,
        extractedText,
      };
      promptText = `[TEMPLATE_ID: ${singleT.id}] Use the normal "${singleT.name}" report template. Integrate my dictation and generate a new impression.`;
    }

    if (onCustomDocxChange) {
      onCustomDocxChange(docxData);
    }
    onCustomPromptChange(promptText);

    try {
      const merged = await mergeDictatedFindingsWithTemplate(
        findings,
        templates,
        selectedModel,
        audioBlob,
        promptText,
        docxData
      );
      onAllFindingsUpdate(merged);
      showNotification(`Merged with ${templateName}!`);
    } catch (err) {
      console.error("Failed to merge dictated findings with template:", err);
      showNotification(`Merge failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsMergingTemplate(false);
      setMergingTemplateName(null);
    }
  };

  // State for Edit Mode
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>('');

  const [dictateEditingIndex, setDictateEditingIndex] = useState<number | null>(null);
  const [dictatingIndex, setDictatingIndex] = useState<number | null>(null);
  const [processingIndex, setProcessingIndex] = useState<number | null>(null);
  const [continuationError, setContinuationError] = useState<{ index: number; message: string } | null>(null);
  const modifyRecorder = useAudioRecorder();
  const { startRecording: startModifyRecording, stopRecording: stopModifyRecording, error: modifyRecorderError } = modifyRecorder;
  const rowDictationRecorder = useAudioRecorder();
  const { startRecording: startRowDictationRecording, stopRecording: stopRowDictationRecording, error: rowDictationRecorderError } = rowDictationRecorder;

  // State for 'Continue Dictation' feature
  const continuationRecorder = useAudioRecorder();
  const { 
    startRecording: startContinuingRecording, 
    stopRecording: stopContinuingRecording, 
    error: continueRecorderError,
    unsavedSession: continueUnsavedSession,
    recoverUnsavedSession: recoverContinueSession,
    discardUnsavedSession: discardContinueSession,
    getUnsavedSessionBlob: getContinueRecoveredBlob,
  } = continuationRecorder;
  const [continuationState, setContinuationState] = useState<{ status: 'idle' | 'recording' | 'processing'; error: string | null }>({ status: 'idle', error: null });
  const [mergedContinuationBlob, setMergedContinuationBlob] = useState<Blob | null>(null);
  const [isMergingAudio, setIsMergingAudio] = useState(false);
  const [isRecoveringContinue, setIsRecoveringContinue] = useState(false);

  // State for 'Dictate Report Changes' feature
  const [modificationState, setModificationState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [modificationError, setModificationError] = useState<string | null>(null);
  const modificationRecorder = useAudioRecorder();
  const {
    startRecording: startGlobalModificationRecording,
    stopRecording: stopGlobalModificationRecording,
    pauseRecording: pauseGlobalModificationRecording,
    resumeRecording: resumeGlobalModificationRecording,
    isPaused: isModificationPaused,
    recordingDuration: modificationDuration,
    unsavedSession: modifyUnsavedSession,
    recoverUnsavedSession: recoverModifySession,
    discardUnsavedSession: discardModifySession,
    getUnsavedSessionBlob: getModifyRecoveredBlob,
  } = modificationRecorder;
  const [isRecoveringModify, setIsRecoveringModify] = useState(false);

  // Stored and Retrieved Changes Audio
  const [storedModificationBlob, setStoredModificationBlob] = useState<Blob | null>(null);
  const [storedModificationMeta, setStoredModificationMeta] = useState<{ timestamp: number; size: number; mimeType: string; name?: string } | null>(null);
  const [storedModificationAudioUrl, setStoredModificationAudioUrl] = useState<string | null>(null);
  const [hasPersistedChangesAudio, setHasPersistedChangesAudio] = useState<boolean>(() => hasStoredDictateChangesAudio());
  const [isRetrievingChangesAudio, setIsRetrievingChangesAudio] = useState(false);
  const [isApplyingStoredChanges, setIsApplyingStoredChanges] = useState(false);
  const modificationFileInputRef = useRef<HTMLInputElement>(null);

  // Staged files / pasted text for Dictate Report Changes
  const [stagedModificationFiles, setStagedModificationFiles] = useState<File[]>([]);
  const [isModificationPasteModalOpen, setIsModificationPasteModalOpen] = useState(false);
  const [modificationClipboardPastedText, setModificationClipboardPastedText] = useState('');

  // Synchronize object URL for stored changes audio preview and playback
  useEffect(() => {
    if (storedModificationBlob) {
      const url = URL.createObjectURL(storedModificationBlob);
      setStoredModificationAudioUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setStoredModificationAudioUrl(null);
    }
  }, [storedModificationBlob]);

  // Check and retrieve any previously stored dictate changes audio on mount
  useEffect(() => {
    getDictateChangesAudio().then((record) => {
      if (record && record.blob && record.blob.size > 0) {
        setHasPersistedChangesAudio(true);
        setStoredModificationBlob(record.blob);
        setStoredModificationMeta(record.meta);
      } else {
        setHasPersistedChangesAudio(false);
      }
    }).catch(err => {
      console.debug('Notice checking stored changes audio:', err);
    });
  }, []);

  // State for 'Complex Impression Generation' feature
  const [isComplexGeneratorVisible, setIsComplexGeneratorVisible] = useState(false);
  const [complexInput, setComplexInput] = useState('');
  const [agenticStatus, setAgenticStatus] = useState<'idle' | 'processing' | 'error'>('idle');
  const [agenticError, setAgenticError] = useState<string | null>(null);
  const [agenticProgressText, setAgenticProgressText] = useState<string>('');
  const complexInputRecorder = useAudioRecorder();
  const [expertNotes, setExpertNotes] = useState<string | null>(null);
  // FIX: Add state to handle transcription loading state for the complex impression mic.
  const [isTranscribingComplex, setIsTranscribingComplex] = useState(false);


  // State for selection copier
  const [selectionSnippets, setSelectionSnippets] = useState<Record<number, string>>({});
  const [copier, setCopier] = useState<{ visible: boolean; x: number; y: number; text: string } | null>(null);
  const findingsContainerRef = useRef<HTMLDivElement>(null);

  // State for Drag and Drop
  const [reorderMode, setReorderMode] = useState<boolean>(false);
  const [mergeMode, setMergeMode] = useState<boolean>(false);
  const [clickMergeSource, setClickMergeSource] = useState<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [undoState, setUndoState] = useState<string[] | null>(null);
  const [isMakingSelection, setIsMakingSelection] = useState<boolean>(false);

  // States for extra file(s) / image(s) / text for Update Transcript
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [showExtraOptions, setShowExtraOptions] = useState<boolean>(false);
  const [extraTextExpanded, setExtraTextExpanded] = useState<boolean>(false);
  const extraFileInputRef = useRef<HTMLInputElement>(null);
  const extraImageInputRef = useRef<HTMLInputElement>(null);

  const handleExtraFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(e.target.files || []);
    if (files.length > 0) {
      const imageFiles: File[] = files.filter((f: File) => f.type.startsWith('image/'));
      const otherFiles: File[] = files.filter((f: File) => !f.type.startsWith('image/'));

      if (imageFiles.length > 0) {
        imageFiles.forEach((imgFile: File) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (reader.result) {
              const base64data = (reader.result as string).split(',')[1];
              onCustomImagesChange([...(customImages || []), { data: base64data, mimeType: imgFile.type }]);
            }
          };
          reader.readAsDataURL(imgFile);
        });
      }

      if (otherFiles.length > 0) {
        setExtraFiles(prev => [...prev, ...otherFiles]);
      }
      setShowExtraOptions(true);
    }
    if (e.target) e.target.value = '';
  };

  const handleExtraImagesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(e.target.files || []);
    if (files.length > 0) {
      files.forEach((imgFile: File) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (reader.result) {
            const base64data = (reader.result as string).split(',')[1];
            onCustomImagesChange([...(customImages || []), { data: base64data, mimeType: imgFile.type }]);
          }
        };
        reader.readAsDataURL(imgFile);
      });
      setShowExtraOptions(true);
    }
    if (e.target) e.target.value = '';
  };

  const handleRemoveExtraFile = (index: number) => {
    setExtraFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleRemoveCustomImage = (index: number) => {
    onCustomImagesChange((customImages || []).filter((_, i) => i !== index));
  };

  useEffect(() => {
    // Keep viewport positioned at the top of the report findings when results display loads
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  useEffect(() => {
    const container = findingsContainerRef.current;
    if (!container) return;

    const handleMouseDown = () => {
      setIsMakingSelection(true);
    };

    const handleMouseUp = () => {
      setIsMakingSelection(false);
    };

    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      if (container) {
          container.removeEventListener('mousedown', handleMouseDown);
      }
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (modifyRecorderError && dictateEditingIndex !== null) {
      setContinuationError({ index: dictateEditingIndex, message: modifyRecorderError });
      setDictateEditingIndex(null);
    }
  }, [modifyRecorderError, dictateEditingIndex]);

  useEffect(() => {
    if (rowDictationRecorderError && dictatingIndex !== null) {
      setContinuationError({ index: dictatingIndex, message: rowDictationRecorderError });
      setDictatingIndex(null);
    }
  }, [rowDictationRecorderError, dictatingIndex]);

  useEffect(() => {
    if (continueRecorderError) {
      setContinuationState({ status: 'idle', error: continueRecorderError });
    }
  }, [continueRecorderError]);

  useEffect(() => {
    if (modificationRecorder.error) {
      setModificationError(modificationRecorder.error);
      setModificationState('idle');
    }
  }, [modificationRecorder.error]);

  useEffect(() => {
    if (complexInputRecorder.error) {
        setAgenticError(complexInputRecorder.error);
    }
  }, [complexInputRecorder.error]);


  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      // Small timeout to let click events fire first
      setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          if (!multiSelectMode) setCopier(null);
          return;
        }
        
        const selectedText = selection.toString().trim();
        if (selectedText.length === 0) {
          if (!multiSelectMode) setCopier(null);
          return;
        }

        const range = selection.getRangeAt(0);
        let parentElement = range.commonAncestorContainer;
        if (parentElement.nodeType === Node.TEXT_NODE) {
          parentElement = parentElement.parentElement!;
        }
        
        const findingItem = (parentElement as HTMLElement).closest('.finding-item');
        
        if (findingItem && findingItem.contains(parentElement)) {
          const indexStr = findingItem.getAttribute('data-finding-index');
          if (indexStr) {
            const index = parseInt(indexStr, 10);

            if (multiSelectMode) {
              setSelectionSnippets(prev => ({ ...prev, [index]: selectedText }));
            } else {
              setCopier({
                visible: true,
                x: event.clientX,
                y: event.clientY,
                text: selectedText,
              });
            }
          }
        } else {
          if (!multiSelectMode) setCopier(null);
        }
      }, 10);
    };

    const container = findingsContainerRef.current;
    container?.addEventListener('mouseup', handleMouseUp as EventListener);
    
    return () => {
      container?.removeEventListener('mouseup', handleMouseUp as EventListener);
    };
  }, [multiSelectMode]);


  const showNotification = (text: string) => {
    setCopyNotification({ text, visible: true });
    setTimeout(() => setCopyNotification({ text: '', visible: false }), 2000);
  };
  
  const copyToClipboard = async (plainText: string, htmlText: string) => {
    try {
      const htmlBlob = new Blob([htmlText], { type: 'text/html' });
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      // The type definition for ClipboardItem is not standard in all environments, so we use `any`
      const clipboardItem = new (window as any).ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob,
      });
      await navigator.clipboard.write([clipboardItem]);
      return true;
    } catch (err) {
      console.error('Failed to copy rich text, falling back to plain text: ', err);
      try {
        await navigator.clipboard.writeText(plainText);
        return true;
      } catch (fallbackErr) {
        console.error('Failed to copy text with fallback: ', fallbackErr);
        return false;
      }
    }
  };

  const getValidFindingIndices = useCallback((): Set<number> => {
    const valid = new Set<number>();
    findings.forEach((f, i) => {
      if (f && f.trim() !== '') {
        valid.add(i);
      }
    });
    return valid;
  }, [findings]);

  const copySelection = async (indices: Set<number>) => {
    if (indices.size === 0) {
      showNotification('Selection cleared.');
      return;
    }

    const sortedIndices = Array.from(indices).sort((a, b) => a - b);
    
    const { plain, html } = sortedIndices.reduce((acc, i) => {
      const snippet = selectionSnippets[i];
      if (snippet) {
        acc.plain.push(snippet);
        acc.html.push(`<strong>${snippet}</strong>`);
      } else {
        const finding = findings[i];
        const isBold = finding.includes('BOLD::');
        const cleanFinding = finding.replace(/BOLD::/g, '');
        const isTitle = isReportTitle(cleanFinding, i);
        const displayFinding = isTitle ? sanitizeTitleText(cleanFinding) : cleanFinding;
        const isClinicalProfile = isClinicalProfileFinding(displayFinding);
        const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(displayFinding);
        const isImpression = isStructured && !isTable && title.trim().toUpperCase() === 'IMPRESSION:';
        const isItalic = !isTable && (isClinicalProfile || (!isStructured && displayFinding.startsWith('*') && displayFinding.endsWith('*')));

        if (isTitle) {
          acc.plain.push(displayFinding);
          acc.html.push(`<p style="text-align:center;"><strong><u>${displayFinding}</u></strong></p>`);
        } else if (isClinicalProfile) {
          const profText = formatClinicalProfileText(displayFinding);
          acc.plain.push(profText);
          acc.html.push(`<p><em>${profText}</em></p>`);
        } else if (isTable) {
          acc.plain.push(tableToPlainText(tableLines));
          acc.html.push(parseMarkdownTable(tableLines));
        } else if (isImpression) {
            acc.plain.push(`${title.toUpperCase()}\n${points.map(p => `• ${p}`).join('\n')}`);
            acc.html.push(`<p><strong style="text-decoration: underline;">${title.toUpperCase()}</strong></p><ul>${points.map(p => `<li><strong>${p}</strong></li>`).join('')}</ul>`);
        } else if (isStructured) {
          acc.plain.push([title, ...points].join('\n'));
          let htmlContent = isBold ? `<p><strong>${title}</strong></p>` : `<p>${title}</p>`;
          htmlContent += points.map(p => isBold ? `<p><strong>${p}</strong></p>` : `<p>${p}</p>`).join('');
          acc.html.push(htmlContent);
        } else {
          if (isItalic) {
              const italicText = cleanFinding.replace(/^\*+|\*+$/g, '').trim();
              acc.plain.push(italicText);
              acc.html.push(`<p><em>${italicText}</em></p>`);
          } else {
              acc.plain.push(cleanFinding);
              acc.html.push(isBold ? `<p><strong>${cleanFinding}</strong></p>` : `<p>${cleanFinding}</p>`);
          }
        }
      }
      return acc;
    }, { plain: [] as string[], html: [] as string[] });

    const plainText = plain.join('\n\n');
    const htmlText = html.join('');

    const success = await copyToClipboard(plainText, htmlText);
    const totalValid = getValidFindingIndices().size;
    const isSubset = indices.size > 0 && indices.size < totalValid;
    const deselectedCount = totalValid - indices.size;
    const notificationText = success
      ? isSubset
        ? `Copied ${indices.size} finding${indices.size > 1 ? 's' : ''} (${deselectedCount} deselected)!`
        : `Copied ${indices.size} finding${indices.size > 1 ? 's' : ''}!`
      : 'Copy failed!';
    showNotification(notificationText);
  };
  
  const handleMultiSelectToggle = (index: number) => {
    // Check if we are *entering* multi-select mode with a fresh text selection
    if (!multiSelectMode) {
      setMultiSelectMode(true);
      setCopier(null); // Hide copier when entering multi-select
      
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim();
      
      if (selection && selectedText && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const startNode = range.startContainer;
        const parentFindingItem = (startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode as HTMLElement)?.closest('.finding-item');
        
        if (parentFindingItem) {
            const selectedIndexStr = parentFindingItem.getAttribute('data-finding-index');
            if (selectedIndexStr) {
                const selectedIndex = parseInt(selectedIndexStr, 10);
                // If the current selection is on the item we are toggling, save the snippet.
                if (selectedIndex === index) {
                    setSelectionSnippets(prev => ({ ...prev, [index]: selectedText }));
                }
            }
        }
      }
    }

    const newSelectedIndices = new Set<number>(selectedIndices);
    if (newSelectedIndices.has(index)) {
      newSelectedIndices.delete(index);
      // Remove snippet if deselecting
      setSelectionSnippets(prev => {
        const newSnippets = {...prev};
        delete newSnippets[index];
        return newSnippets;
      });
    } else {
      newSelectedIndices.add(index);
    }
    setSelectedIndices(newSelectedIndices);
    copySelection(newSelectedIndices);
  };
  
  const handleFindingClick = async (index: number) => {
    // Prevent single-copy if user is selecting text
    if (window.getSelection()?.toString().length) {
      return;
    }

    if (multiSelectMode) {
      handleMultiSelectToggle(index);
      return;
    }
    
    // Single-copy logic
    const findingToCopy = findings[index];
    const isBold = findingToCopy.includes('BOLD::');
    const cleanFinding = findingToCopy.replace(/BOLD::/g, '');
    const isTitle = isReportTitle(cleanFinding, index);
    const displayFinding = isTitle ? sanitizeTitleText(cleanFinding) : cleanFinding;
    const isClinicalProfile = isClinicalProfileFinding(displayFinding);
    const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(displayFinding);
    const isImpression = isStructured && !isTable && title.trim().toUpperCase() === 'IMPRESSION:';
    const isItalic = !isTable && (isClinicalProfile || (!isStructured && displayFinding.startsWith('*') && displayFinding.endsWith('*')));

    let plainText: string;
    let htmlText: string;

    if (isTitle) {
      plainText = displayFinding;
      htmlText = `<p style="text-align:center;"><strong><u>${displayFinding}</u></strong></p>`;
    } else if (isClinicalProfile) {
      const profText = formatClinicalProfileText(displayFinding);
      plainText = profText;
      htmlText = `<p><em>${profText}</em></p>`;
    } else if (isTable) {
      plainText = tableToPlainText(tableLines);
      htmlText = parseMarkdownTable(tableLines);
    } else if (isImpression) {
        plainText = `${title.toUpperCase()}\n${points.map(p => `• ${p}`).join('\n')}`;
        htmlText = `<p><strong style="text-decoration: underline;">${title.toUpperCase()}</strong></p><ul>${points.map(p => `<li><strong>${p}</strong></li>`).join('')}</ul>`;
    } else if (isStructured) {
        plainText = [title, ...points].join('\n');
        let htmlContent = isBold ? `<p><strong>${title}</strong></p>` : `<p>${title}</p>`;
        htmlContent += points.map(p => isBold ? `<p><strong>${p}</strong></p>` : `<p>${p}</p>`).join('');
        htmlText = htmlContent;
    } else {
        if (isItalic) {
            plainText = cleanFinding.replace(/^\*+|\*+$/g, '').trim();
            htmlText = `<p><em>${plainText}</em></p>`;
        } else {
            plainText = cleanFinding;
            htmlText = isBold ? `<p><strong>${cleanFinding}</strong></p>` : `<p>${cleanFinding}</p>`;
        }
    }
    
    const success = await copyToClipboard(plainText, htmlText);
    
    if(success) {
      // Briefly highlight the copied item
      setSelectedIndices(new Set([index]));
      // Explicitly type the new Set to be Set<number> to match the state type.
      // FIX: Explicitly type new Set() as Set<number> to match state type.
      setTimeout(() => setSelectedIndices(new Set<number>()), 500);
      showNotification('Copied!');
    } else {
      showNotification('Copy failed!');
    }
  };

  const handleSelectionHandleClick = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    handleMultiSelectToggle(index);
  };


  const handleCopyAll = async () => {
    if (!findings || findings.length === 0) return;

    const allTextPlain = findings.map((f, i) => {
      const cleanFinding = f.replace(/BOLD::/g, '');
      const isTitle = isReportTitle(cleanFinding, i);
      const displayFinding = isTitle ? sanitizeTitleText(cleanFinding) : cleanFinding;
      if (isClinicalProfileFinding(displayFinding)) {
        return formatClinicalProfileText(displayFinding);
      }
      const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(displayFinding);
      const isImpression = isStructured && !isTable && title.trim().toUpperCase() === 'IMPRESSION:';

      if (isTable) {
        return tableToPlainText(tableLines);
      }
      if (isImpression) {
          return `${title.toUpperCase()}\n${points.map(p => `• ${p}`).join('\n')}`;
      }
      if (isStructured) {
        return [title, ...points].join('\n');
      }
      if (displayFinding.startsWith('*') && displayFinding.endsWith('*')) {
        return displayFinding.replace(/^\*+|\*+$/g, '').trim();
      }
      return displayFinding;
    }).join('\n\n');

    const allTextHtml = findings.map((f, i) => {
      const isBold = f.includes('BOLD::');
      const cleanFinding = f.replace(/BOLD::/g, '');
      const isTitle = isReportTitle(cleanFinding, i);
      const displayFinding = isTitle ? sanitizeTitleText(cleanFinding) : cleanFinding;
      if (isClinicalProfileFinding(displayFinding)) {
        const profText = formatClinicalProfileText(displayFinding);
        return `<p><em>${profText}</em></p>`;
      }
      const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(displayFinding);
      const isImpression = isStructured && !isTable && title.trim().toUpperCase() === 'IMPRESSION:';
      
      if (isTitle) {
          return `<p style="text-align:center;"><strong><u>${displayFinding}</u></strong></p>`;
      }
      if (isTable) {
          return parseMarkdownTable(tableLines);
      }
      if (isImpression) {
          return `<p><strong style="text-decoration: underline;">${title.toUpperCase()}</strong></p><ul>${points.map(p => `<li><strong>${p}</strong></li>`).join('')}</ul>`;
      }
      if (isStructured) {
        let htmlContent = isBold ? `<p><strong>${title}</strong></p>` : `<p>${title}</p>`;
        htmlContent += points.map(p => isBold ? `<p><strong>${p}</strong></p>` : `<p>${p}</p>`).join('');
        return htmlContent;
      }
      if (displayFinding.startsWith('*') && displayFinding.endsWith('*')) {
        return `<p><em>${displayFinding.replace(/^\*+|\*+$/g, '').trim()}</em></p>`;
      }
      return isBold ? `<p><strong>${displayFinding}</strong></p>` : `<p>${displayFinding}</p>`;
    }).join('');

    const success = await copyToClipboard(allTextPlain, allTextHtml);
    if (success) {
        setIsAllCopied(true);
        setTimeout(() => setIsAllCopied(false), 2000);
        const allValid = getValidFindingIndices();
        setSelectedIndices(allValid);
        setMultiSelectMode(true);
        showNotification('Copied all! Click any finding or checkbox to deselect.');
    } else {
        showNotification('Copy failed!');
    }
  };

  const handleSelectAll = async () => {
    const allValid = getValidFindingIndices();
    if (allValid.size === 0) return;
    setSelectedIndices(allValid);
    setMultiSelectMode(true);
    await copySelection(allValid);
    showNotification(`Selected & copied all ${allValid.size} findings! Click any to deselect.`);
  };

  const handleDeselectAll = () => {
    setSelectedIndices(new Set<number>());
    setSelectionSnippets({});
    showNotification('All findings deselected.');
  };

  const handleDownload = () => {
    const rawTarget = mergedContinuationBlob || audioBlob;
    if (!rawTarget) return;
    const targetBlob = Array.isArray(rawTarget) ? rawTarget.find(b => b.type?.startsWith('audio/')) || rawTarget[0] : rawTarget;
    if (!targetBlob) return;
    triggerAudioDownload(targetBlob, mergedContinuationBlob ? 'radiology-dictation-merged' : 'radiology-dictation');
  };

  const handleDownloadMerged = (blobToDownload?: Blob | null) => {
    const rawTarget = blobToDownload || mergedContinuationBlob || audioBlob;
    if (!rawTarget) return;
    const targetBlob = Array.isArray(rawTarget) ? rawTarget.find(b => b.type?.startsWith('audio/')) || rawTarget[0] : rawTarget;
    if (!targetBlob) return;
    triggerAudioDownload(targetBlob, 'radiology-dictation-merged');
  };
  
  const handleRecordNew = useCallback(() => {
    setExpertNotes(null);
    onReset();
  }, [onReset]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Support Alt+N / Option+N for instant New Dictation
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        const target = e.target as HTMLElement | null;
        if (target) {
          const tagName = target.tagName?.toUpperCase();
          if (tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable) {
            return;
          }
        }
        e.preventDefault();
        handleRecordNew();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRecordNew]);

  const handleDownloadHTML = () => {
    if (!findings || findings.length === 0) return;
    try {
      const htmlContent = generateSingleDictationHTML(findings);
      downloadFile(htmlContent, 'radiology-report.html', 'text/html;charset=utf-8');
    } catch (err) {
      console.error('Failed to generate or download HTML:', err);
      showNotification('Failed to create HTML file.');
    }
  };

  // --- Edit Mode Handlers ---
  const handleStartEdit = (index: number) => {
    setUndoState(null);
    setEditingIndex(index);

    const findingToEdit = findings[index];
    const isBold = findingToEdit.includes('BOLD::');
    const cleanFinding = findingToEdit.replace(/BOLD::/g, '');
    
    const isClinicalProfile = isClinicalProfileFinding(cleanFinding);
    const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
    const textForEditing = isClinicalProfile
      ? formatClinicalProfileText(cleanFinding)
      : isStructured
      ? [title, ...points].join('\n')
      : cleanFinding;
    
    setEditingText(textForEditing);
    setDictateEditingIndex(null);
    setDictatingIndex(null);
    setProcessingIndex(null);
    setContinuationError(null);
    setSelectedIndices(new Set<number>());
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditingText('');
  };

  const handleDeleteFinding = (indexToDelete: number) => {
    setUndoState([...findings]);
    const updatedFindings = findings.filter((_, i) => i !== indexToDelete);
    onAllFindingsUpdate(updatedFindings);
    if (editingIndex === indexToDelete) {
      setEditingIndex(null);
      setEditingText('');
    }
    // Update selectedIndices so that indices shift properly
    setSelectedIndices(prev => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < indexToDelete) {
          next.add(idx);
        } else if (idx > indexToDelete) {
          next.add(idx - 1);
        }
      }
      if (next.size > 0 && multiSelectMode) {
        copySelection(next);
      }
      return next;
    });
    setSelectionSnippets(prev => {
      const next: Record<number, string> = {};
      const snippets = prev as Record<string, string>;
      for (const [keyStr, val] of Object.entries(snippets)) {
        const key = Number(keyStr);
        if (key < indexToDelete) {
          next[key] = String(val);
        } else if (key > indexToDelete) {
          next[key - 1] = String(val);
        }
      }
      return next;
    });
  };

  const handleSaveEdit = () => {
    if (editingIndex !== null) {
      setUndoState(findings);
      const originalFinding = findings[editingIndex];
      const isBold = originalFinding.startsWith('BOLD::');
      const { isStructured } = parseStructuredFinding(originalFinding);

      let newText = editingText;
      if (isStructured) {
        newText = editingText.split('\n').filter(line => line.trim() !== '').join('###');
      } else if (isClinicalProfileFinding(editingText)) {
        const profText = formatClinicalProfileText(editingText);
        newText = profText;
      }
      
      if(isBold && !newText.startsWith('BOLD::') && !isClinicalProfileFinding(newText)) {
        newText = `BOLD::${newText}`;
      }
      
      onUpdateFinding(editingIndex, newText);
    }
    handleCancelEdit();
  };

  const handleStartRowDictation = async (index: number) => {
    setUndoState(null);
    if (isLive) onPauseLive?.();
    setEditingIndex(null);
    setProcessingIndex(null);
    setContinuationError(null);
    setSelectedIndices(new Set<number>());
    setDictateEditingIndex(null);
    setDictatingIndex(index);
    await startRowDictationRecording();
  };

  const handleStopRowDictation = async () => {
    if (dictatingIndex === null) return;

    const audioBlob = await stopRowDictationRecording();
    const currentIndex = dictatingIndex;
    setDictatingIndex(null);

    if (audioBlob && audioBlob.size > 0) {
      setProcessingIndex(currentIndex);
      setUndoState(findings);
      try {
        const existingText = findings[currentIndex];
        const newText = await continueAudioDictation(existingText, audioBlob, customPrompt, selectedModel);
        const separator = existingText.trim().length > 0 && !existingText.endsWith(' ') ? ' ' : '';
        const updatedText = existingText + separator + newText.trim();
        onUpdateFinding(currentIndex, updatedText);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unknown error occurred.';
        setContinuationError({ index: currentIndex, message });
      } finally {
        setProcessingIndex(null);
      }
    }
    if (isLive) onResumeLive?.();
  };

  const handleStartDictateEdit = async (index: number) => {
    setUndoState(null);
    if (isLive) onPauseLive?.();
    setEditingIndex(null);
    setProcessingIndex(null);
    setContinuationError(null);
    // Explicitly type the new Set to be Set<number> to match the state type.
    // FIX: Explicitly type new Set() as Set<number> to match state type.
    setSelectedIndices(new Set<number>());
    setDictatingIndex(null);
    setDictateEditingIndex(index);
    await startModifyRecording();
  };

  const handleStopDictateEdit = async () => {
    if (dictateEditingIndex === null) return;

    const audioBlob = await stopModifyRecording();
    const currentIndex = dictateEditingIndex;
    setDictateEditingIndex(null);

    if (audioBlob && audioBlob.size > 0) {
        setProcessingIndex(currentIndex);
        setUndoState(findings);
        try {
            const existingText = findings[currentIndex];
            const modifiedText = await modifyFindingWithAudio(existingText, audioBlob, customPrompt, selectedModel);
            onUpdateFinding(currentIndex, modifiedText);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'An unknown error occurred.';
            setContinuationError({ index: currentIndex, message });
        } finally {
            setProcessingIndex(null);
        }
    }
    if (isLive) onResumeLive?.();
  };

  const handleStartContinue = async () => {
    setUndoState(null);
    setContinuationState({ status: 'recording', error: null });
    await startContinuingRecording();
  };

  const handleStopContinue = async () => {
    setContinuationState({ status: 'processing', error: null });
    try {
      const newRecordedBlob = await stopContinuingRecording();
      if (newRecordedBlob && newRecordedBlob.size > 0) {
        setIsMergingAudio(true);
        // Immediately merge audio right at the moment Stop is clicked!
        let merged: Blob;
        if (audioBlob) {
          const baseBlob = Array.isArray(audioBlob) ? (audioBlob.find(b => b.type?.startsWith('audio/')) || audioBlob[0]) : audioBlob;
          merged = await mergeAudioBlobs(baseBlob, newRecordedBlob);
        } else {
          merged = newRecordedBlob;
        }
        setMergedContinuationBlob(merged);
        onAudioBlobUpdate?.(merged);
        setIsMergingAudio(false);

        // Process with Gemini continuation in background
        setUndoState(findings);
        await onContinueDictation(newRecordedBlob, merged);
        setContinuationState({ status: 'idle', error: null });
      } else {
        setContinuationState({ status: 'idle', error: null });
      }
    } catch (err) {
      setIsMergingAudio(false);
      const message = err instanceof Error ? err.message : 'An unknown error occurred.';
      setContinuationState({ status: 'idle', error: message });
    }
  };
  
  const handleCopyFromCopier = async (text: string) => {
    const success = await copyToClipboard(text, `<strong>${text}</strong>`);
    showNotification(success ? 'Copied selection!' : 'Copy failed!');
    setCopier(null);
  };

  const handleStartModification = async () => {
    setUndoState(null);
    if (isLive) onPauseLive?.();
    setModificationError(null);
    try {
      await startGlobalModificationRecording();
      setModificationState('recording');
    } catch (err) {
      console.warn("Failed to start modification recording:", err);
      setModificationState('idle');
    }
  };

  const handleStopModification = async () => {
    try {
      const audioBlob = await stopGlobalModificationRecording();
      if (audioBlob && audioBlob.size > 0) {
        // Automatically persist changes audio to IndexedDB
        await saveDictateChangesAudio(audioBlob, 'Voice Changes Dictation');
        setStoredModificationBlob(audioBlob);
        setStoredModificationMeta({
          timestamp: Date.now(),
          size: audioBlob.size,
          mimeType: audioBlob.type || 'audio/webm',
          name: 'Voice Changes Dictation'
        });
        setHasPersistedChangesAudio(true);

        // If audio dictate given then without using other file, we can apply it like how at the start.
        // If there are also staged files, combine them; otherwise apply just audio only!
        const allItems: Blob[] = [audioBlob, ...stagedModificationFiles];

        setModificationState('processing');
        try {
          setUndoState(findings);
          const newFindings = await modifyReportWithAudio(
            findings, 
            allItems.length === 1 ? allItems[0] : allItems, 
            selectedModel, 
            customPrompt, 
            customImages
          );
          onAllFindingsUpdate(newFindings);
          setStagedModificationFiles([]);
          showNotification('Changes applied and voice dictation stored in browser!');
        } catch (err) {
          const message = err instanceof Error ? err.message : 'An unknown error occurred.';
          setModificationError(message);
        } finally {
          setModificationState('idle');
        }
      } else {
        setModificationState('idle');
      }
    } catch (err) {
      console.warn('Error stopping modification recording:', err);
      setModificationState('idle');
    }
    if (isLive) onResumeLive?.();
  };

  const handleRetrieveStoredChangesAudio = async () => {
    setIsRetrievingChangesAudio(true);
    setModificationError(null);
    try {
      const record = await getDictateChangesAudio();
      if (record && record.blob && record.blob.size > 0) {
        setStoredModificationBlob(record.blob);
        setStoredModificationMeta(record.meta);
        setHasPersistedChangesAudio(true);
        showNotification('Retrieved stored dictation changes audio from browser!');
      } else {
        setHasPersistedChangesAudio(false);
        showNotification('No stored changes audio found in database.');
      }
    } catch (err) {
      console.error('Failed to retrieve stored changes audio:', err);
      setModificationError('Failed to retrieve stored audio.');
    } finally {
      setIsRetrievingChangesAudio(false);
    }
  };

  const handleSaveCurrentChangesAudio = async () => {
    if (!storedModificationBlob) return;
    try {
      await saveDictateChangesAudio(storedModificationBlob, storedModificationMeta?.name || 'Voice Changes Dictation');
      setHasPersistedChangesAudio(true);
      showNotification('Audio successfully stored in browser storage (IndexedDB)!');
    } catch (err) {
      console.error('Failed to store changes audio:', err);
      showNotification('Failed to store audio in browser.');
    }
  };

  const handleDiscardStoredChangesAudio = async () => {
    try {
      await deleteDictateChangesAudio();
      setStoredModificationBlob(null);
      setStoredModificationMeta(null);
      setHasPersistedChangesAudio(false);
      showNotification('Stored changes audio deleted from browser.');
    } catch (err) {
      console.error('Failed to delete stored changes audio:', err);
    }
  };

  const handleApplyStoredChangesAudio = async () => {
    const allItems: Blob[] = [];
    if (storedModificationBlob && storedModificationBlob.size > 0) {
      allItems.push(storedModificationBlob);
    }
    allItems.push(...stagedModificationFiles);

    if (allItems.length === 0) return;
    setIsApplyingStoredChanges(true);
    setModificationError(null);
    try {
      setUndoState(findings);
      const newFindings = await modifyReportWithAudio(
        findings, 
        allItems.length === 1 ? allItems[0] : allItems, 
        selectedModel, 
        customPrompt, 
        customImages
      );
      onAllFindingsUpdate(newFindings);
      setStagedModificationFiles([]);
      showNotification('Changes applied using stored audio/files!');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred.';
      setModificationError(message);
    } finally {
      setIsApplyingStoredChanges(false);
    }
  };

  const handleDownloadChangesAudio = () => {
    if (!storedModificationBlob) return;
    triggerAudioDownload(storedModificationBlob, `dictate-changes-${new Date().toISOString().slice(0, 10)}`);
  };

  const handleUploadChangesFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(e.target.files || []);
    if (files.length > 0) {
      setStagedModificationFiles(prev => [...prev, ...files]);
      const audioFile: File | undefined = files.find((f: File) => f.type.startsWith('audio/'));
      if (audioFile && !storedModificationBlob) {
        saveDictateChangesAudio(audioFile, audioFile.name).then(() => {
          setStoredModificationBlob(audioFile);
          setStoredModificationMeta({
            timestamp: Date.now(),
            size: audioFile.size,
            mimeType: audioFile.type || 'audio/webm',
            name: audioFile.name
          });
          setHasPersistedChangesAudio(true);
        }).catch(() => {});
      }
      showNotification(`Added ${files.length} file(s) for report changes`);
    }
    if (e.target) e.target.value = '';
  };

  const handleApplyStagedModification = async () => {
    const allItems: Blob[] = [];
    if (storedModificationBlob) {
      allItems.push(storedModificationBlob);
    }
    allItems.push(...stagedModificationFiles);

    if (allItems.length === 0) return;

    setModificationState('processing');
    setModificationError(null);
    try {
      setUndoState(findings);
      const newFindings = await modifyReportWithAudio(
        findings,
        allItems.length === 1 ? allItems[0] : allItems,
        selectedModel,
        customPrompt,
        customImages
      );
      onAllFindingsUpdate(newFindings);
      setStagedModificationFiles([]);
      showNotification('Changes applied to report!');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred.';
      setModificationError(message);
    } finally {
      setModificationState('idle');
    }
  };

  const handleDownloadRecoveredContinue = async () => {
    setIsRecoveringContinue(true);
    try {
      const recoveredBlob = await getContinueRecoveredBlob();
      if (recoveredBlob) {
        triggerAudioDownload(recoveredBlob, 'recovered-continuation-audio');
      }
    } catch (err) {
      console.error('Failed to download recovered continuation:', err);
    } finally {
      setIsRecoveringContinue(false);
    }
  };

  const handleRestoreAndAppendContinue = async () => {
    setIsRecoveringContinue(true);
    try {
      const newRecordedBlob = await recoverContinueSession();
      if (newRecordedBlob && newRecordedBlob.size > 0) {
        setIsMergingAudio(true);
        let merged: Blob;
        if (audioBlob) {
          const baseBlob = Array.isArray(audioBlob) ? (audioBlob.find(b => b.type?.startsWith('audio/')) || audioBlob[0]) : audioBlob;
          merged = await mergeAudioBlobs(baseBlob, newRecordedBlob);
        } else {
          merged = newRecordedBlob;
        }
        setMergedContinuationBlob(merged);
        onAudioBlobUpdate?.(merged);
        setIsMergingAudio(false);

        setUndoState(findings);
        await onContinueDictation(newRecordedBlob, merged);
      }
    } catch (err) {
      setIsMergingAudio(false);
      console.error('Failed to restore and append continuation:', err);
    } finally {
      setIsRecoveringContinue(false);
    }
  };

  const handleDiscardContinue = async () => {
    stopRepeatingInterruptedAlert();
    await discardContinueSession();
  };

  const handleDownloadRecoveredModify = async () => {
    setIsRecoveringModify(true);
    try {
      const recoveredBlob = await getModifyRecoveredBlob();
      if (recoveredBlob) {
        triggerAudioDownload(recoveredBlob, 'recovered-dictate-changes-audio');
      }
    } catch (err) {
      console.error('Failed to download recovered modification audio:', err);
    } finally {
      setIsRecoveringModify(false);
    }
  };

  const handleRestoreAndApplyModify = async () => {
    setIsRecoveringModify(true);
    try {
      const recoveredBlob = await recoverModifySession();
      if (recoveredBlob && recoveredBlob.size > 0) {
        await saveDictateChangesAudio(recoveredBlob, 'Recovered Voice Changes');
        setStoredModificationBlob(recoveredBlob);
        setStoredModificationMeta({
          timestamp: Date.now(),
          size: recoveredBlob.size,
          mimeType: recoveredBlob.type || 'audio/webm',
          name: 'Recovered Voice Changes'
        });
        setHasPersistedChangesAudio(true);

        setModificationState('processing');
        const modifiedFindings = await modifyReportWithAudio(findings, recoveredBlob, selectedModel, customPrompt, customImages);
        onAllFindingsUpdate(modifiedFindings);
        setModificationState('idle');
        showNotification('Restored and stored voice changes audio!');
      }
    } catch (err) {
      console.error('Failed to restore and apply modification:', err);
      setModificationError(err instanceof Error ? err.message : 'Failed to apply changes.');
      setModificationState('idle');
    } finally {
      setIsRecoveringModify(false);
    }
  };

  const handleDiscardModify = async () => {
    stopRepeatingInterruptedAlert();
    await discardModifySession();
  };

  // --- Complex Impression Handlers ---
    const handleComplexMicClick = async () => {
        setAgenticError(null);
        if (complexInputRecorder.isRecording) {
            setIsTranscribingComplex(true);
            try {
                const audioBlob = await complexInputRecorder.stopRecording();
                if (audioBlob && audioBlob.size > 0) {
                    const transcript = await transcribeAudioForPrompt(audioBlob, selectedModel);
                    setComplexInput(prev => prev ? `${prev} ${transcript}` : transcript);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred during transcription.';
                setAgenticError(message);
            } finally {
                setIsTranscribingComplex(false);
            }
        } else {
            try {
                await complexInputRecorder.startRecording();
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to access microphone.';
                setAgenticError(message);
            }
        }
    };

    const handleGenerateComplexImpression = async () => {
        setAgenticStatus('processing');
        setAgenticError(null);
        setAgenticProgressText('Starting complex impression workflow...');
        setExpertNotes(null); // Clear previous notes
        try {
            setUndoState(findings);
            const result = await runComplexImpressionGeneration(
                findings, 
                complexInput,
                (statusText) => setAgenticProgressText(statusText)
            );
            onAllFindingsUpdate(result.findings);
            setExpertNotes(result.expertNotes); // Set new notes
            setIsComplexGeneratorVisible(false);
            setComplexInput('');
            setAgenticStatus('idle');
            setAgenticProgressText('');
        } catch (err) {
            const message = err instanceof Error ? err.message : 'An unknown error occurred.';
            setAgenticError(`Failed to generate impression: ${message}`);
            setAgenticStatus('error');
            setAgenticProgressText('');
        }
    };

    const handleDownloadExpertNotes = async () => {
        if (!expertNotes) return;
        try {
            const docxBlob = await generateDocxFromMarkdown(expertNotes, 'Expert Notes');
            downloadFile(
                docxBlob,
                'expert-notes.docx',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            );
        } catch (err) {
            console.error('Failed to generate authentic docx notes:', err);
            showNotification('Failed to generate Word document.');
        }
    };

  // --- Drag and Drop Handlers ---
  const handleToggleReorderMode = () => {
    setUndoState(null);
    setReorderMode(prev => !prev);
    setMergeMode(false);
    setClickMergeSource(null);
  };
  const handleToggleMergeMode = () => {
    setUndoState(null);
    setClickMergeSource(null);
    setDragOverIndex(null);
    setDraggedIndex(null);
    dragItem.current = null;
    setMergeMode(prev => !prev);
    setReorderMode(false);
  };

  // Reorder Drag Handlers
  const handleReorderDragStart = (e: React.DragEvent | undefined, index: number) => {
    dragItem.current = index;
    setDraggedIndex(index);
    if (e && e.dataTransfer) {
      try {
        e.dataTransfer.setData("text/plain", index.toString());
        e.dataTransfer.effectAllowed = "move";
      } catch (_) {}
    }
  };

  const handleReorderDragEnd = () => {
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
        setUndoState(findings);
        let newFindings = [...findings];
        const draggedItemContent = newFindings.splice(dragItem.current, 1)[0];
        newFindings.splice(dragOverItem.current, 0, draggedItemContent);
        onAllFindingsUpdate(newFindings);
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggedIndex(null);
  };

  // Touch Drag Support for Mobile & Tablets
  const touchDragRef = useRef<{
    sourceIndex: number;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);

  const handleRowTouchStart = (e: React.TouchEvent, index: number) => {
    if (!reorderMode && !mergeMode) return;
    const touch = e.touches[0];
    touchDragRef.current = {
      sourceIndex: index,
      startX: touch.clientX,
      startY: touch.clientY,
      isDragging: false,
    };
  };

  const handleRowTouchMove = (e: React.TouchEvent) => {
    if (!reorderMode && !mergeMode) return;
    if (!touchDragRef.current) return;
    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - touchDragRef.current.startX);
    const deltaY = Math.abs(touch.clientY - touchDragRef.current.startY);

    // If moved more than 6px, initiate touch drag
    if (!touchDragRef.current.isDragging && (deltaX > 6 || deltaY > 6)) {
      touchDragRef.current.isDragging = true;
      const src = touchDragRef.current.sourceIndex;
      if (reorderMode) {
        dragItem.current = src;
        setDraggedIndex(src);
      } else if (mergeMode) {
        dragItem.current = src;
        setDraggedIndex(src);
      }
    }

    if (touchDragRef.current.isDragging) {
      if (e.cancelable) {
        e.preventDefault();
      }
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetItem = el?.closest('.finding-item');
      if (targetItem) {
        const targetIdxStr = targetItem.getAttribute('data-finding-index');
        if (targetIdxStr !== null) {
          const targetIdx = parseInt(targetIdxStr, 10);
          if (!isNaN(targetIdx)) {
            if (reorderMode) {
              dragOverItem.current = targetIdx;
            } else if (mergeMode) {
              setDragOverIndex(targetIdx);
            }
          }
        }
      }
    }
  };

  const handleRowTouchEnd = () => {
    if (!reorderMode && !mergeMode) return;
    const state = touchDragRef.current;
    touchDragRef.current = null;
    if (!state) return;

    if (state.isDragging) {
      if (reorderMode) {
        handleReorderDragEnd();
      } else if (mergeMode) {
        if (dragOverIndex !== null && state.sourceIndex !== dragOverIndex) {
          executeMerge(state.sourceIndex, dragOverIndex);
        } else {
          setDraggedIndex(null);
          setDragOverIndex(null);
          dragItem.current = null;
        }
      }
    } else {
      // Tap without dragging in mergeMode: tap-to-merge
      if (mergeMode) {
        handleMergeItemClick(state.sourceIndex);
      }
    }
  };

  // Execute Merge safely between sourceIndex and targetIndex
  const executeMerge = (sourceIndex: number, targetIndex: number) => {
    if (
      typeof sourceIndex !== 'number' ||
      typeof targetIndex !== 'number' ||
      isNaN(sourceIndex) ||
      isNaN(targetIndex) ||
      sourceIndex === targetIndex ||
      sourceIndex < 0 ||
      sourceIndex >= findings.length ||
      targetIndex < 0 ||
      targetIndex >= findings.length
    ) {
      setDragOverIndex(null);
      setDraggedIndex(null);
      setClickMergeSource(null);
      return;
    }

    const sourceFinding = findings[sourceIndex];
    const targetFinding = findings[targetIndex];

    if (sourceFinding === undefined || targetFinding === undefined || typeof sourceFinding !== 'string' || typeof targetFinding !== 'string') {
      setDragOverIndex(null);
      setDraggedIndex(null);
      setClickMergeSource(null);
      return;
    }

    // Store pre-merge state for undo
    setUndoState(findings);

    const mergedText = `${targetFinding.trim()} ${sourceFinding.trim()}`.trim();

    const newFindings = findings
      .map((finding, index) => (index === targetIndex ? mergedText : finding))
      .filter((_, index) => index !== sourceIndex);

    onAllFindingsUpdate(newFindings);

    setDragOverIndex(null);
    setDraggedIndex(null);
    setClickMergeSource(null);
  };

  // Merge Drag Handlers
  const handleMergeDragStart = (e: React.DragEvent, index: number) => {
    dragItem.current = index;
    setDraggedIndex(index);
    try {
      e.dataTransfer.setData("text/plain", index.toString());
      e.dataTransfer.setData("sourceIndex", index.toString());
      e.dataTransfer.effectAllowed = "copyMove";
    } catch {
      // Ignore dataTransfer errors in sandboxed iframes
    }
  };

  const handleMergeDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    let sourceIndex: number | null = null;

    // Prioritize in-memory dragItem ref (immune to iframe / browser dataTransfer stripping)
    if (dragItem.current !== null && !isNaN(dragItem.current)) {
      sourceIndex = dragItem.current;
    } else if (draggedIndex !== null && !isNaN(draggedIndex)) {
      sourceIndex = draggedIndex;
    } else {
      try {
        const textData = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("sourceIndex");
        if (textData && textData.trim() !== "") {
          const parsed = parseInt(textData.trim(), 10);
          if (!isNaN(parsed)) {
            sourceIndex = parsed;
          }
        }
      } catch {
        // Ignore dataTransfer errors
      }
    }

    if (sourceIndex !== null) {
      executeMerge(sourceIndex, targetIndex);
    }

    dragItem.current = null;
    setDragOverIndex(null);
    setDraggedIndex(null);
    setClickMergeSource(null);
  };

  const handleMergeItemClick = (index: number) => {
    if (clickMergeSource === null) {
      setClickMergeSource(index);
    } else if (clickMergeSource === index) {
      // Clicking same item deselects it
      setClickMergeSource(null);
    } else {
      // Merge selected source item into this target item
      executeMerge(clickMergeSource, index);
    }
  };
  
  const handleUndo = () => {
    if (undoState) {
      onAllFindingsUpdate(undoState);
      setUndoState(null); // Can only undo once.
    }
  };

  const ErrorLegend = () => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400 mb-4 p-2 rounded-md bg-slate-100 dark:bg-slate-700/50">
      <strong>Error Key:</strong>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
        <span>Potential Error</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-sky-500"></div>
        <span>Clarification</span>
      </div>
    </div>
  );


  return (
    <div className="p-4">
      <TemplateSelectionModal 
        isOpen={isTemplateModalOpen}
        onClose={() => setIsTemplateModalOpen(false)}
        templates={REPORT_TEMPLATES}
        onSelectTemplate={handleSelectTemplateToMerge}
      />
      {copier && copier.visible && (
        <SelectionCopier 
          x={copier.x}
          y={copier.y}
          textToCopy={copier.text}
          onCopy={handleCopyFromCopier}
          onClose={() => setCopier(null)}
        />
      )}
      {copyNotification.visible && (
        <div className="fixed bottom-20 right-5 bg-slate-800 text-white text-sm font-bold py-2 px-4 rounded-lg shadow-lg z-50 transition-all duration-300 ease-in-out" role="alert">
          {copyNotification.text}
        </div>
      )}

      {isMergingTemplate && (
        <div className="mb-4 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700/80 flex items-center gap-3 animate-fade-in shadow-xs" role="status">
          <Spinner className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
              Merging dictated findings with {mergingTemplateName || 'template'}...
            </p>
            <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
              Preserving normal template findings, updating dictated findings with bold formatting, and synthesizing impression.
            </p>
          </div>
        </div>
      )}

      {isLive && (
        <div className="mb-6 p-4 bg-slate-900 text-white rounded-xl shadow-lg border border-slate-700 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
                <div className="relative flex items-center justify-center">
                    <div className={`w-3.5 h-3.5 rounded-full ${isPausedLive ? 'bg-amber-400' : 'bg-emerald-400 animate-ping'} absolute`}></div>
                    <div className={`w-3.5 h-3.5 rounded-full ${isPausedLive ? 'bg-amber-500' : 'bg-emerald-500'} relative`}></div>
                </div>
                <div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs uppercase tracking-wider font-semibold text-emerald-400">
                            {isPausedLive ? 'Session Paused' : 'Live Dictation Active'}
                        </span>
                        <span className="text-xs bg-emerald-950/80 border border-emerald-700/60 px-2 py-0.5 rounded font-mono text-emerald-300">
                            Real-Time Voice Stream
                        </span>
                    </div>
                    <p className="font-medium text-sm text-slate-200 mt-0.5">
                        {liveError ? liveError : liveStatus || 'Listening for speech & medical voice commands...'}
                    </p>
                </div>
            </div>

            {/* Real-time Audio Level Visualizer */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800/80 rounded-lg border border-slate-700">
                <span className="text-xs text-slate-400 font-mono mr-1">Mic</span>
                {[0.4, 0.8, 1.2, 0.6, 1.0, 0.5, 0.9, 0.7].map((factor, idx) => {
                    const barHeight = isPausedLive ? 4 : Math.max(4, Math.min(24, Math.round((audioLevel * factor * 0.28) + 4)));
                    return (
                        <div
                            key={idx}
                            style={{ height: `${barHeight}px` }}
                            className={`w-1 rounded-full transition-all duration-75 ${
                                audioLevel > 15 ? 'bg-emerald-400' : 'bg-slate-600'
                            }`}
                        />
                    );
                })}
            </div>
        </div>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Corrected Findings</h2>
            {errorCheckStatus === 'checking' && (
                <div className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                    <Spinner className="w-4 h-4" />
                    <span>Checking for errors...</span>
                </div>
            )}
        </div>
      </div>

      {errorCheckStatus === 'complete' && identifiedErrors.length > 0 && <ErrorLegend />}

      {!isLive && audioBlob && (
        <div className="bg-slate-100 dark:bg-slate-900/50 p-3.5 rounded-xl mb-4 shadow-sm border border-slate-200/80 dark:border-slate-800">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <label htmlFor="model-select-reprocess" className="text-sm font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">Process again with:</label>
              <select 
                  id="model-select-reprocess"
                  value={selectedModel}
                  onChange={(e) => onModelChange(e.target.value)}
                  className="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 w-full sm:w-auto dark:bg-slate-700 dark:border-slate-600 dark:text-white"
                  aria-label="Select AI model for reprocessing"
              >
                  {AVAILABLE_MODELS.map((model) => (
                      <option key={model.value} value={model.value}>{model.label}</option>
                  ))}
              </select>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end flex-wrap">
              <button
                type="button"
                onClick={() => setShowExtraOptions(prev => !prev)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all border ${
                  showExtraOptions || extraFiles.length > 0 || (customImages && customImages.length > 0)
                    ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                    : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
                }`}
                title="Add extra files, images, or instructions to update the transcript"
              >
                <span>📎</span>
                <span>Add File(s) / Image(s) / Text</span>
                {(extraFiles.length > 0 || (customImages && customImages.length > 0) || customPrompt.trim().length > 0) && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-blue-600 text-white font-bold">
                    {extraFiles.length + (customImages?.length || 0) + (customPrompt.trim().length > 0 ? 1 : 0)}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setIsTemplateModalOpen(true)}
                disabled={isMergingTemplate}
                className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 px-3.5 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto flex-shrink-0 disabled:opacity-50 shadow-xs"
                title="Select a normal report template and merge with the current dictation findings"
              >
                <SparklesIcon className="w-3.5 h-3.5 text-yellow-300" />
                <span>Merge with Template</span>
              </button>

              <button
                onClick={() => {
                  setExpertNotes(null);
                  setUndoState(findings);
                  onReprocess(extraFiles.length > 0 ? extraFiles : undefined);
                  setExtraFiles([]);
                }}
                className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto flex-shrink-0"
              >
                Update Transcript
              </button>
            </div>
          </div>

          {/* Collapsible / Expandable Extra Options Panel */}
          {showExtraOptions && (
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/80 flex flex-col gap-3">
              <input 
                type="file" 
                ref={extraFileInputRef} 
                onChange={handleExtraFilesSelected} 
                multiple 
                accept="audio/*,video/*,image/*,.pdf,.doc,.docx,.txt,.csv,.rtf,.webm,.mp4,.mp3,.wav,.m4a,.png,.jpg,.jpeg" 
                className="hidden" 
                aria-hidden="true" 
              />
              <input 
                type="file" 
                ref={extraImageInputRef} 
                onChange={handleExtraImagesSelected} 
                multiple 
                accept="image/*" 
                className="hidden" 
                aria-hidden="true" 
              />

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => extraFileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 transition-colors shadow-xs"
                >
                  <UploadIcon className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                  <span>+ Add File(s) (Audio, PDF, DOCX, TXT)</span>
                </button>

                <button
                  type="button"
                  onClick={() => extraImageInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 transition-colors shadow-xs"
                >
                  <ImageIcon className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span>+ Add Image(s) / Scan</span>
                </button>

                <button
                  type="button"
                  onClick={() => setExtraTextExpanded(prev => !prev)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors shadow-xs ${
                    extraTextExpanded || customPrompt.trim().length > 0
                      ? 'bg-blue-100 dark:bg-blue-900/60 border-blue-400 text-blue-800 dark:text-blue-200'
                      : 'bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  <PencilIcon className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>{extraTextExpanded ? 'Hide Extra Text' : '+ Add Extra Text / Notes'}</span>
                </button>
              </div>

              {/* Staged Extra Files List */}
              {extraFiles.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Attached Files:</span>
                  {extraFiles.map((file, fIdx) => (
                    <div key={`extra-f-${fIdx}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-800 text-xs font-medium text-blue-900 dark:text-blue-200">
                      <span className="truncate max-w-[140px]" title={file.name}>{file.name}</span>
                      <span className="text-[10px] text-blue-600 dark:text-blue-400">({(file.size / 1024).toFixed(0)} KB)</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveExtraFile(fIdx)}
                        className="text-blue-500 hover:text-red-600 dark:hover:text-red-400 font-bold ml-0.5"
                        title="Remove file"
                        aria-label={`Remove file ${file.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Staged Extra Images List */}
              {customImages && customImages.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Reference Images:</span>
                  {customImages.map((img, iIdx) => (
                    <div key={`extra-img-${iIdx}`} className="relative group inline-flex items-center gap-1 p-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                      <img src={`data:${img.mimeType};base64,${img.data}`} alt="Ref" className="w-8 h-8 rounded object-cover" />
                      <button
                        type="button"
                        onClick={() => handleRemoveCustomImage(iIdx)}
                        className="text-slate-400 hover:text-red-600 dark:hover:text-red-400 font-bold px-1 text-xs"
                        title="Remove image"
                        aria-label="Remove image"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Staged Extra Text Area */}
              {(extraTextExpanded || customPrompt.trim().length > 0) && (
                <div className="flex flex-col gap-1.5 pt-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Extra Instructions / Text Notes for Update:
                    </label>
                    {customPrompt.trim().length > 0 && (
                      <button
                        type="button"
                        onClick={() => onCustomPromptChange('')}
                        className="text-[11px] text-red-500 hover:underline"
                      >
                        Clear Text
                      </button>
                    )}
                  </div>
                  <textarea
                    value={customPrompt}
                    onChange={(e) => onCustomPromptChange(e.target.value)}
                    placeholder="Add any extra notes, clinical corrections, or dictation instructions to apply to this transcript update..."
                    className="w-full text-xs p-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:outline-none resize-y min-h-[60px]"
                    rows={2}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

       <CustomPromptInput
          prompt={customPrompt}
          onPromptChange={onCustomPromptChange}
          images={customImages}
          onImagesChange={onCustomImagesChange}
          customDocx={customDocx}
          onCustomDocxChange={onCustomDocxChange}
          isLiveMode={isLive}
          selectedModel={selectedModel}
          className="mb-6"
        />

      {/* Embedded / Inline Rich Text Format (RTF) Editor - ONLY active when Template Merge Mode is selected */}
      {isTemplateMergeMode && (
        <>
          {/* Quick Toggle Bar for RTF in Template Merge Mode */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4 p-2 bg-slate-100 dark:bg-slate-800/80 rounded-xl border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRtfEditor(prev => !prev)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  showRtfEditor
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50'
                }`}
              >
                <span>📄</span>
                <span>{showRtfEditor ? 'Hide Rich Text (RTF) Editor' : 'Show Rich Text (RTF) Editor'}</span>
                <span className="ml-1 text-[10px] bg-white/20 text-white px-1.5 py-0.2 rounded-full">Template Mode</span>
              </button>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
              <span>{findings.length} findings loaded</span>
              <span className="font-semibold text-blue-600 dark:text-blue-400">• Template: {activeTemplateName}</span>
            </div>
          </div>

          {showRtfEditor && (
            <div className="mb-8 p-4 sm:p-5 bg-gradient-to-br from-blue-50/70 to-indigo-50/50 dark:from-slate-800/80 dark:to-blue-950/40 border border-blue-200/80 dark:border-blue-800/60 rounded-2xl shadow-sm animate-fade-in">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 pb-3 border-b border-blue-200/60 dark:border-blue-900/50">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xl">📄</span>
                    <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                      Rich Text Format (RTF) Editor & Template Output
                    </h3>
                    <span className="text-[11px] bg-blue-600 text-white font-bold px-2 py-0.5 rounded-full shadow-xs">
                      Template Mode
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {customDocx?.name 
                      ? `Merged into institution Word document: "${customDocx.name}". Edit formatting directly with live RTF tools or export to Word (.docx) / RTF.` 
                      : `Merged with "${activeTemplateName}" template structure. Edit formatting and headings directly in rich text format.`}
                  </p>
                </div>
                <a
                  href="#usual-html-report-section"
                  className="text-xs font-bold text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline flex-shrink-0"
                >
                  Usual HTML Findings Below ↓
                </a>
              </div>

              <RichTextReportEditor
                findings={findings}
                templateName={activeTemplateName}
                onUpdateFindings={onAllFindingsUpdate}
                onOpenMacrosModal={onOpenMacrosModal}
              />
            </div>
          )}
        </>
      )}

      {/* USUAL HTML REPORT AND FINDINGS */}
      <div id="usual-html-report-section">
        {isTemplateMergeMode && showRtfEditor && (
          <div className="pt-4 pb-2 border-t-2 border-slate-200 dark:border-slate-800 mb-4 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm sm:text-base font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                <span>Standard HTML Report & Findings Cards</span>
                <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                  Usual Output
                </span>
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Card-by-card findings with voice editing, continuation, reordering, and HTML report export.
              </p>
            </div>
          </div>
        )}

      {!isLive && <p className="text-slate-600 dark:text-slate-400 mb-6">Click any finding to copy it. To select multiple findings, click the circle on the left of each item. Use the 'Continue Dictation' button at the bottom to add more findings to this report.</p>}
      <div className="text-sm text-slate-500 dark:text-slate-400 mb-6 p-3 bg-slate-100 dark:bg-slate-700/50 rounded-lg flex flex-col sm:flex-row gap-4 items-center">
        <div className="flex items-center gap-2">
            <MicIcon className="w-5 h-5 flex-shrink-0" />
            <span>Use this to <strong>continue dictation</strong>.</span>
        </div>
        <div className="flex items-center gap-2">
            <MicPencilIcon className="w-5 h-5 flex-shrink-0" />
            <span>Use this to <strong>dictate changes</strong> or corrections to an existing finding.</span>
        </div>
      </div>
      {findings.length > 0 && (
        <div className="flex items-center justify-between gap-2 mb-4 p-2 bg-slate-100/70 dark:bg-slate-800/70 rounded-xl border border-slate-200/80 dark:border-slate-700/80 min-h-[46px]">
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs sm:text-sm font-semibold text-slate-600 dark:text-slate-300">
                {findings.filter(f => f && f.trim()).length} findings{multiSelectMode ? ` (${selectedIndices.size} selected)` : ''}
              </span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 flex-nowrap overflow-x-auto no-scrollbar shrink-0">
              {undoState && (
                <button
                  onClick={handleUndo}
                  className="text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg bg-yellow-400 text-yellow-900 hover:bg-yellow-500 transition-colors shadow-sm shrink-0"
                  aria-label="Undo last modification"
                >
                  Undo
                </button>
              )}
              <QuickMacroInsertPopover
                onOpenManagerModal={onOpenMacrosModal}
                onInsertMacroFindings={(expandedLines, macro) => {
                  setUndoState(findings);
                  onAllFindingsUpdate([...findings, ...expandedLines]);
                  setCopyNotification({
                    text: `Inserted macro: ${macro.name}`,
                    visible: true,
                  });
                  setTimeout(() => setCopyNotification({ text: '', visible: false }), 2500);
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setMultiSelectMode(prev => {
                    const next = !prev;
                    if (!next) {
                      setSelectedIndices(new Set<number>());
                      setSelectionSnippets({});
                    }
                    return next;
                  });
                }}
                className={`text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm shrink-0 ${
                  multiSelectMode
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
                }`}
                title="Toggle Multi-select Mode to select and copy multiple findings"
              >
                <CheckSquare className={`w-4 h-4 ${multiSelectMode ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`} />
                {multiSelectMode ? 'Done' : 'Multi-select'}
              </button>
              <button
                  onClick={handleToggleMergeMode}
                  className={`text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm shrink-0 ${mergeMode ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'}`}
                >
                <MergeIcon className={`w-4 h-4 ${mergeMode ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`} />
                {mergeMode ? 'Done' : 'Merge'}
              </button>
              <button
                  onClick={handleToggleReorderMode}
                  className={`text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm shrink-0 ${reorderMode ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'}`}
                >
                <ReorderIcon className={`w-4 h-4 ${reorderMode ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`} />
                {reorderMode ? 'Done' : 'Reorder'}
              </button>
              {multiSelectMode ? (
                <button
                  type="button"
                  onClick={selectedIndices.size === getValidFindingIndices().size ? handleDeselectAll : handleSelectAll}
                  className="text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg transition-colors bg-blue-100 hover:bg-blue-200 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200 dark:hover:bg-blue-900/80 border border-blue-300/80 dark:border-blue-700/80 shadow-sm shrink-0"
                  title={selectedIndices.size === getValidFindingIndices().size ? "Deselect all findings" : "Select all findings and copy"}
                >
                  {selectedIndices.size === getValidFindingIndices().size ? 'Deselect All' : 'Select All'}
                </button>
              ) : (
                <button
                  onClick={handleCopyAll}
                  className={`text-xs sm:text-sm font-semibold py-1.5 px-3.5 rounded-lg transition-colors shadow-sm flex items-center gap-1.5 shrink-0 ${isAllCopied ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                  title="Copy all findings to clipboard with instant deselect option"
                >
                  {isAllCopied ? 'Copied!' : 'Copy All'}
                </button>
              )}
            </div>
        </div>
      )}


      {/* Merge Mode Guidance Banner */}
      {mergeMode && (
        <div className="mb-3 p-2.5 sm:p-3 bg-blue-50/90 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-blue-900 dark:text-blue-200 animate-fade-in shadow-xs">
          <div className="flex items-center gap-2">
            <MergeIcon className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <span>
              <strong>Merge Mode:</strong> Drag a finding from anywhere on the row onto another, or tap two rows to merge.
              {clickMergeSource !== null && (
                <span className="ml-2 font-bold text-amber-700 dark:text-amber-300">
                  (Row #{clickMergeSource + 1} selected — tap target row to merge)
                </span>
              )}
            </span>
          </div>
          {clickMergeSource !== null && (
            <button
              type="button"
              onClick={() => setClickMergeSource(null)}
              className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 underline font-semibold"
            >
              Cancel Selection
            </button>
          )}
        </div>
      )}

      {/* Reorder Mode Guidance Banner */}
      {reorderMode && (
        <div className="mb-3 p-2.5 sm:p-3 bg-blue-50/90 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-xl flex items-center gap-2 text-xs sm:text-sm text-blue-900 dark:text-blue-200 animate-fade-in shadow-xs">
          <ReorderIcon className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <span>
            <strong>Reorder Mode:</strong> Drag any row from anywhere on the card up or down to change its position in the report.
          </span>
        </div>
      )}

      <div ref={findingsContainerRef} className="space-y-3 min-h-[150px]">
        {findings.map((finding, index) => {
          if (!finding && index === findings.length - 1) return null; // Don't render the trailing empty string from split
          
          const isBold = finding.includes('BOLD::');
          const cleanFinding = finding.replace(/BOLD::/g, '');
          const isTitle = isReportTitle(cleanFinding, index);
          const displayFinding = isTitle ? sanitizeTitleText(cleanFinding) : cleanFinding;
          const isClinicalProfile = isClinicalProfileFinding(displayFinding);
          const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(displayFinding);
          const isItalic = !isTable && (isClinicalProfile || (!isStructured && displayFinding.startsWith('*') && displayFinding.endsWith('*')));
          
          let textToDisplay: string;
          if (isClinicalProfile) {
            textToDisplay = formatClinicalProfileText(displayFinding);
          } else if (isItalic) {
            textToDisplay = displayFinding.replace(/^\*+|\*+$/g, '').trim();
          } else if (isStructured) {
            textToDisplay = title;
          } else {
            textToDisplay = displayFinding;
          }

          const textContainerClasses = isTitle
            ? 'text-center font-bold underline'
            : isItalic
            ? 'italic'
            : isBold
            ? 'font-bold'
            : '';

          const isSelected = selectedIndices.has(index);
          const isEditingThis = editingIndex === index;
          const isDictatingThis = dictatingIndex === index;
          const isDictateEditingThis = dictateEditingIndex === index;
          const isProcessingThis = processingIndex === index;
          const hasErrorThis = continuationError?.index === index;
          const isCurrentlyActive = isEditingThis || isProcessingThis || hasErrorThis || isDictateEditingThis || isDictatingThis;
          const isDraggingThis = draggedIndex === index;
          const isDragOverTarget = mergeMode && dragOverIndex === index && draggedIndex !== index;
          const isClickMergeSource = mergeMode && clickMergeSource === index;
          
          const errorsForThisFinding = identifiedErrors.filter(e => e.findingIndex === index);
          
          let highestSeverity: IdentifiedError['severity'] | null = null;
          if (errorsForThisFinding.length > 0) {
              if (errorsForThisFinding.some(e => e.severity === 'WARNING')) {
                  highestSeverity = 'WARNING';
              } else {
                  highestSeverity = 'INFO';
              }
          }

          const hasError = highestSeverity !== null;
          
          const errorClasses = {
              WARNING: 'bg-yellow-50 border-yellow-500 dark:bg-yellow-900/20 dark:border-yellow-500',
              INFO: 'bg-sky-50 border-sky-500 dark:bg-sky-900/20 dark:border-sky-500',
          };
          const iconErrorClasses = {
              WARNING: 'text-yellow-600 dark:text-yellow-400',
              INFO: 'text-sky-600 dark:text-sky-400',
          };
          const tooltipErrorClasses = {
              WARNING: 'text-yellow-400',
              INFO: 'text-sky-400',
          };
          
          const isImpression = isStructured && title.trim().toUpperCase() === 'IMPRESSION:';


          return (
            <div
              key={index}
              data-finding-index={index}
              draggable={!isCurrentlyActive && (reorderMode || mergeMode)}
              onDragStart={
                !isCurrentlyActive && reorderMode ? (e) => handleReorderDragStart(e, index) :
                !isCurrentlyActive && mergeMode ? (e) => handleMergeDragStart(e, index) :
                undefined
              }
              onDragEnd={
                reorderMode ? handleReorderDragEnd :
                mergeMode ? () => { setDraggedIndex(null); setDragOverIndex(null); dragItem.current = null; } :
                undefined
              }
              onDragEnter={reorderMode ? () => (dragOverItem.current = index) : undefined}
              onDrop={
                reorderMode ? handleReorderDragEnd :
                mergeMode ? (e) => handleMergeDrop(e, index) :
                undefined
              }
              onDragOver={mergeMode || reorderMode ? (e) => e.preventDefault() : undefined}
              onDragEnterCapture={mergeMode ? (e) => { e.preventDefault(); setDragOverIndex(index); } : undefined}
              onDragLeaveCapture={mergeMode ? (e) => { e.preventDefault(); setDragOverIndex(null); } : undefined}
              onTouchStart={!isCurrentlyActive ? (e) => handleRowTouchStart(e, index) : undefined}
              onTouchMove={!isCurrentlyActive ? handleRowTouchMove : undefined}
              onTouchEnd={!isCurrentlyActive ? handleRowTouchEnd : undefined}
              className={`finding-item relative group p-3 ${(reorderMode || mergeMode) ? 'pl-16 select-none cursor-grab active:cursor-grabbing' : 'pl-11 cursor-pointer'} pr-28 sm:pr-24 border-l-4 rounded-r-lg transition-all duration-200 ${
                  isDragOverTarget
                  ? 'bg-green-100 border-green-500 dark:bg-green-900/30 dark:border-green-500 ring-2 ring-green-200 dark:ring-green-700'
                  : isClickMergeSource
                  ? 'bg-amber-100 border-amber-500 dark:bg-amber-900/40 dark:border-amber-400 ring-2 ring-amber-300 dark:ring-amber-600 shadow-md'
                  : isSelected && !isCurrentlyActive
                  ? 'bg-blue-100 border-blue-600 dark:bg-blue-900/30 dark:border-blue-500 shadow-md'
                  : hasError
                  ? errorClasses[highestSeverity!]
                  : 'bg-slate-50 border-blue-500 dark:bg-slate-700/50 dark:border-blue-500'
              } ${!isCurrentlyActive && !(reorderMode || mergeMode) ? 'hover:bg-blue-50 dark:hover:bg-slate-700' : ''} ${isDraggingThis ? 'opacity-50 bg-slate-200 dark:bg-slate-600' : ''}`}
              role="button"
              aria-pressed={isSelected && !isCurrentlyActive}
              tabIndex={isCurrentlyActive ? -1 : 0}
              onClick={
                isCurrentlyActive
                  ? undefined
                  : mergeMode
                  ? () => handleMergeItemClick(index)
                  : reorderMode
                  ? undefined
                  : () => handleFindingClick(index)
              }
              onKeyDown={
                isCurrentlyActive
                  ? undefined
                  : (e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        if (mergeMode) handleMergeItemClick(index);
                        else if (!reorderMode) handleFindingClick(index);
                      }
                    }
              }
            >
              {(reorderMode || mergeMode) && (
                  <div 
                    className="absolute left-1.5 top-0 bottom-0 w-6 flex items-center justify-center cursor-grab active:cursor-grabbing text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 select-none z-10 pointer-events-none" 
                    aria-hidden="true"
                  >
                      {reorderMode && <ReorderIcon />}
                      {mergeMode && (
                        <MergeIcon className={`w-4 h-4 ${dragOverIndex === index ? 'text-green-600 dark:text-green-400 scale-125' : isClickMergeSource ? 'text-amber-600 dark:text-amber-400 scale-110' : ''} transition-all`} />
                      )}
                  </div>
              )}

              <div
                  onClick={(e) => { e.stopPropagation(); !isCurrentlyActive && handleSelectionHandleClick(e, index); }}
                  className={`absolute ${(reorderMode || mergeMode) ? 'left-8' : 'left-0'} top-0 bottom-0 w-8 flex items-center justify-center touch-manipulation z-20 ${isCurrentlyActive ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-disabled={isCurrentlyActive}
                  aria-label="Toggle selection for this finding"
                  title="Click to select for multi-select copy"
              >
                  <div className={`w-5 h-5 rounded-full border-2 transition-colors flex items-center justify-center text-[10px] font-bold ${isSelected && !isCurrentlyActive ? 'bg-blue-600 border-blue-600 dark:bg-blue-500 dark:border-blue-500 text-white' : 'border-slate-400 bg-white group-hover:border-blue-500 dark:border-slate-500 dark:bg-slate-600 dark:group-hover:border-blue-400'}`}>
                      {isSelected && !isCurrentlyActive && '✓'}
                  </div>
              </div>

              {isEditingThis ? (
                <div className="flex flex-col gap-2">
                    <textarea 
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      className="w-full p-2 border rounded-md font-semibold text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none dark:bg-slate-900 dark:text-white dark:border-slate-600"
                      rows={Math.max(3, editingText.split('\n').length)}
                      autoFocus
                    />
                    <div className="flex justify-end gap-2">
                      <button onClick={handleCancelEdit} className="text-sm font-semibold py-1 px-3 rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-600 dark:text-slate-300 dark:hover:bg-slate-500">Cancel</button>
                      <button onClick={handleSaveEdit} className="text-sm font-semibold py-1 px-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700">Save</button>
                    </div>
                </div>
              ) : isProcessingThis ? (
                <div className="flex items-center gap-2">
                    <Spinner className="w-5 h-5" />
                    <p className="font-semibold text-slate-600 dark:text-slate-300">Processing...</p>
                </div>
              ) : hasErrorThis ? (
                <div className="text-red-600 dark:text-red-400">
                    <p className="font-semibold">Error:</p>
                    <p className="text-sm">{continuationError.message}</p>
                    <button onClick={() => setContinuationError(null)} className="text-sm text-blue-600 hover:underline mt-1 dark:text-blue-400">Try again</button>
                </div>
              ) : (
                <>
                  <div
                    className={`text-slate-700 dark:text-slate-200 whitespace-pre-wrap ${
                      (reorderMode || mergeMode)
                        ? 'select-none pointer-events-none'
                        : !isCurrentlyActive
                        ? 'cursor-pointer'
                        : 'cursor-default'
                    } ${textContainerClasses}`}
                  >
                    {isTable ? (
                      renderTableFinding(tableLines)
                    ) : isImpression ? (
                        <>
                            <span className="font-bold underline uppercase">{title}</span>
                            <ul className="list-disc list-inside pl-4 mt-1">
                                {points.map((point, i) => (
                                    <li key={i} className="font-bold">{point}</li>
                                ))}
                            </ul>
                        </>
                    ) : isStructured ? (
                      <>
                        <span>{title}</span>
                        {points.map((point, i) => (<span key={i} className="block">{point}</span>))}
                      </>
                    ) : (
                      textToDisplay
                    )}
                  </div>
                  {isDictatingThis ? (
                     <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2 bg-white dark:bg-slate-800 p-1 rounded-full shadow-lg border border-slate-200 dark:border-slate-700">
                        <div className="w-3 h-3 bg-red-500 rounded-full animate-ping ml-1"></div>
                        <button onClick={handleStopRowDictation} aria-label="Stop dictation" className="p-1 text-slate-600 dark:text-slate-300 hover:text-red-600 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                            <StopIcon className="w-5 h-5" />
                        </button>
                    </div>
                  ) : isDictateEditingThis ? (
                     <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2 bg-white dark:bg-slate-800 p-1 rounded-full shadow-lg border border-slate-200 dark:border-slate-700">
                        <div className="w-3 h-3 bg-blue-500 rounded-full animate-ping ml-1"></div>
                        <button onClick={handleStopDictateEdit} aria-label="Stop dictation edit" className="p-1 text-slate-600 dark:text-slate-300 hover:text-red-600 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                            <StopIcon className="w-5 h-5" />
                        </button>
                    </div>
                  ) : !reorderMode && !mergeMode && (
                    <div 
                      onClick={(e) => e.stopPropagation()} 
                      className={`absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-100 sm:opacity-0 ${!isMakingSelection && 'sm:group-hover:opacity-100'} focus-within:opacity-100 transition-opacity bg-white/95 dark:bg-slate-800/95 border border-slate-200/80 dark:border-slate-700/80 p-1 rounded-lg shadow-sm z-10`}
                    >
                       {hasError && (
                            <div className="group/tooltip relative flex items-center">
                              <WarningIcon className={`w-5 h-5 ${iconErrorClasses[highestSeverity!]}`} />
                              <div className="absolute bottom-full mb-2 -right-1/2 translate-x-1/2 w-64 p-2 text-xs text-white bg-slate-800 rounded-md shadow-lg opacity-0 group-hover/tooltip:opacity-100 transition-opacity pointer-events-none z-10">
                                <ul className="list-disc list-inside text-left">
                                  {errorsForThisFinding.map((error, i) => (
                                    <li key={i} className={tooltipErrorClasses[error.severity]}>{error.errorDescription}</li>
                                  ))}
                                </ul>
                                <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-slate-800"></div>
                              </div>
                            </div>
                          )}
                      <button onClick={() => handleStartEdit(index)} aria-label="Edit text" className="p-1.5 sm:p-1 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors touch-manipulation" title="Edit row">
                        <PencilIcon />
                      </button>
                      <button onClick={() => handleStartRowDictation(index)} aria-label="Continue dictation" className="p-1.5 sm:p-1 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors touch-manipulation" title="Continue dictation for this row">
                        <MicIcon className="w-5 h-5" />
                      </button>
                      <button onClick={() => handleStartDictateEdit(index)} aria-label="Dictate changes" className="p-1.5 sm:p-1 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors touch-manipulation" title="Dictate changes to row">
                        <MicPencilIcon />
                      </button>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteFinding(index);
                        }} 
                        aria-label="Delete this row" 
                        title="Delete row"
                        className="p-1.5 sm:p-1 text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 rounded-full hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors touch-manipulation"
                      >
                        <TrashIcon className="w-5 h-5" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
        {findings.length === 0 && !isLive && (
            <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                <p>No findings have been transcribed yet.</p>
            </div>
        )}
        {findings.length === 0 && isLive && (
            <div className="border-2 border-dashed border-emerald-300 dark:border-emerald-700/60 bg-emerald-50/50 dark:bg-emerald-950/20 rounded-xl p-6 sm:p-8 text-center my-4">
                <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center text-emerald-600 dark:text-emerald-300">
                    <MicIcon className="w-6 h-6 animate-pulse" />
                </div>
                <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-1">
                    Listening to your dictation...
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 max-w-md mx-auto mb-4">
                    Speak your findings clearly into the microphone. Voice commands like <em>"next line"</em> and <em>"new finding"</em> are formatted in real-time.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                    <button
                        onClick={() => {
                            const sampleFindings = [
                                "BOLD::Serial axial CT sections of the brain were performed without contrast.",
                                "BOLD::No acute intracranial hemorrhage, territorial infarction, or mass effect.",
                                "BOLD::Ventricles, basal cisterns, and cortical sulci are normal for patient age.",
                                "IMPRESSION:###NORMAL CT BRAIN STUDY WITHOUT ACUTE INTRACRANIAL ABNORMALITY."
                            ];
                            onAllFindingsUpdate(sampleFindings);
                        }}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors"
                    >
                        ⚡ Insert Sample Findings
                    </button>
                    {window.self !== window.top && (
                        <a
                            href={window.location.href}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-slate-700 hover:bg-slate-800 text-slate-100 rounded-lg text-xs font-semibold shadow-sm transition-colors"
                        >
                            ↗️ Open in New Tab (Full Mic Access)
                        </a>
                    )}
                </div>
                <div className="mt-4 inline-flex items-center gap-2 text-xs bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-800 px-3 py-1.5 rounded-full text-slate-700 dark:text-slate-300 shadow-sm">
                    <span>💡 Tip: Say <strong>"new finding"</strong> or <strong>"move to next line"</strong> to separate points</span>
                </div>
            </div>
        )}
      </div>
      
      <div className="mt-6 p-4 border rounded-lg bg-slate-50 dark:bg-slate-700/50 dark:border-slate-700">
        {modifyUnsavedSession && modificationState !== 'recording' && (
          <div className="w-full mb-3 p-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700/60 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 animate-in fade-in duration-200">
            <div className="flex items-center gap-2.5 text-amber-800 dark:text-amber-200">
              <WarningIcon className="w-5 h-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-semibold text-xs sm:text-sm">
                  Interrupted Report Changes Audio Detected
                </p>
                <p className="text-[11px] sm:text-xs text-amber-700 dark:text-amber-300">
                  Found auto-saved audio from {new Date(modifyUnsavedSession.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                onClick={handleDiscardModify}
                disabled={isRecoveringModify}
                className="px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-amber-100 dark:hover:bg-amber-800/40 rounded-md transition-colors cursor-pointer"
              >
                Discard
              </button>
              <button
                onClick={handleDownloadRecoveredModify}
                disabled={isRecoveringModify}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-200 bg-amber-200/60 dark:bg-amber-800/60 hover:bg-amber-200 rounded-md transition-colors cursor-pointer"
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                {isRecoveringModify ? 'Saving...' : 'Save WAV'}
              </button>
              <button
                onClick={handleRestoreAndApplyModify}
                disabled={isRecoveringModify}
                className="px-3 py-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-md shadow transition-colors cursor-pointer"
              >
                {isRecoveringModify ? 'Applying...' : 'Restore & Apply Changes'}
              </button>
            </div>
          </div>
        )}
        <input
          type="file"
          ref={modificationFileInputRef}
          onChange={handleUploadChangesFiles}
          className="hidden"
          accept="audio/*,video/*,image/*,.pdf,.doc,.docx,.txt,.csv,.rtf,.webm,.mp4,.mp3,.wav,.m4a,.png,.jpg,.jpeg"
          multiple
          aria-hidden="true"
        />

        <div className="flex flex-col gap-3">
          <div className="flex items-start sm:items-center gap-3 flex-col sm:flex-row justify-between">
            <div className="flex items-start sm:items-center gap-3">
              <MicScribbleIcon className="w-8 h-8 text-slate-600 dark:text-slate-300 flex-shrink-0" />
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-semibold text-slate-800 dark:text-slate-200">Dictate Report Changes</h4>
                  {hasPersistedChangesAudio && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                      Audio Stored
                    </span>
                  )}
                  {stagedModificationFiles.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                      <FileText className="w-3 h-3 text-blue-600 dark:text-blue-400" />
                      {stagedModificationFiles.length} file{stagedModificationFiles.length > 1 ? 's' : ''} staged
                    </span>
                  )}
                </div>
                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                  Dictate changes, upload any file (audio, text, PDF, images), or paste notes to modify the report. Stored changes audio is preserved in browser.
                </p>
              </div>
            </div>

            <div className="flex-shrink-0 w-full sm:w-auto">
              {modificationState === 'recording' ? (
                <div className="flex items-center justify-between sm:justify-end gap-2 bg-red-50 dark:bg-red-950/40 p-1.5 sm:p-2 rounded-xl border border-red-200 dark:border-red-900">
                  <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 font-mono text-xs font-bold">
                    <span className={`w-2.5 h-2.5 rounded-full ${isModificationPaused ? 'bg-yellow-400' : 'bg-red-600 animate-ping'}`}></span>
                    <span>{formatAudioDuration(modificationDuration)}</span>
                    {isModificationPaused && <span className="text-[10px] font-sans text-yellow-600 dark:text-yellow-400 font-medium">(Paused)</span>}
                  </div>
                  <button
                    type="button"
                    onClick={isModificationPaused ? resumeGlobalModificationRecording : pauseGlobalModificationRecording}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 transition-colors cursor-pointer"
                  >
                    {isModificationPaused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    onClick={handleStopModification}
                    className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white font-bold py-1.5 px-3 rounded-lg text-xs shadow-sm transition-colors cursor-pointer"
                  >
                    <StopIcon className="w-4 h-4" />
                    <span>Stop & Apply</span>
                  </button>
                </div>
              ) : modificationState === 'processing' || isApplyingStoredChanges ? (
                <div className="flex items-center justify-center gap-2 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl text-slate-800 dark:text-slate-200 text-xs font-semibold">
                  <Spinner className="w-4 h-4" />
                  <span>Applying Changes to Report...</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap justify-start sm:justify-end">
                  <button
                    type="button"
                    onClick={handleStartModification}
                    className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold py-2 px-4 rounded-xl text-xs sm:text-sm shadow-sm transition-all hover:scale-[1.02] cursor-pointer"
                    title="Click to start dictating changes with your microphone"
                  >
                    <MicIcon className="w-4 h-4" />
                    <span>Start Dictating Changes</span>
                  </button>

                  {/* Retrieve Stored Audio button */}
                  {hasPersistedChangesAudio && !storedModificationBlob && (
                    <button
                      type="button"
                      onClick={handleRetrieveStoredChangesAudio}
                      disabled={isRetrievingChangesAudio}
                      className="inline-flex items-center gap-1.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 font-bold py-2 px-3.5 rounded-xl text-xs sm:text-sm shadow-xs transition-colors cursor-pointer"
                      title="Retrieve previously stored changes audio from browser IndexedDB"
                    >
                      <FolderDown className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                      <span>{isRetrievingChangesAudio ? 'Retrieving...' : 'Retrieve Stored Audio'}</span>
                    </button>
                  )}

                  {/* Upload any kind of file(s) */}
                  <button
                    type="button"
                    onClick={() => modificationFileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold py-2 px-3 rounded-xl text-xs sm:text-sm shadow-xs transition-colors cursor-pointer"
                    title="Upload any file (audio, text, PDF, image, document) to dictate or apply changes"
                  >
                    <UploadIcon className="w-4 h-4" />
                    <span>Upload File(s)</span>
                  </button>

                  {/* Paste Text button */}
                  <button
                    type="button"
                    onClick={() => {
                      setModificationClipboardPastedText('');
                      setIsModificationPasteModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold py-2 px-3 rounded-xl text-xs sm:text-sm shadow-xs transition-colors cursor-pointer"
                    title="Paste text notes, dictation snippets, or EHR text to apply changes"
                  >
                    <ClipboardPaste className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <span>Paste Text</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Staged Files for Report Changes */}
          {stagedModificationFiles.length > 0 && modificationState !== 'recording' && (
            <div className="mt-1 p-3 bg-blue-50/70 dark:bg-blue-950/30 rounded-xl border border-blue-200 dark:border-blue-900/60 shadow-xs flex flex-col gap-2.5 animate-in fade-in duration-150">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                    Staged Changes ({stagedModificationFiles.length} item{stagedModificationFiles.length > 1 ? 's' : ''})
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Ready to apply alone or dictate voice instructions with "Start Dictating Changes" above.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => modificationFileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    <span>Add Files</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setModificationClipboardPastedText('');
                      setIsModificationPasteModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750 transition-colors cursor-pointer"
                  >
                    <ClipboardPaste className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    <span>Paste Text</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setStagedModificationFiles([])}
                    className="text-xs font-medium text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 px-2 py-1 transition-colors cursor-pointer"
                  >
                    Clear All
                  </button>
                </div>
              </div>

              {/* List of staged files */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {stagedModificationFiles.map((file, idx) => {
                  const isAudio = file.type.startsWith('audio/') || /\.(webm|wav|mp3|m4a|ogg|aac)$/i.test(file.name);
                  const isText = file.type.startsWith('text/') || /\.(txt|csv|md|rtf)$/i.test(file.name);
                  return (
                    <div
                      key={`${file.name}-${idx}`}
                      className="flex items-center justify-between p-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs shadow-2xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {isAudio ? (
                          <FileAudio className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        ) : isText ? (
                          <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                        ) : (
                          <UploadIcon className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
                        )}
                        <span className="truncate font-medium text-slate-800 dark:text-slate-200 max-w-[140px]" title={file.name}>
                          {file.name}
                        </span>
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {(file.size / 1024).toFixed(0)} KB
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setStagedModificationFiles(prev => prev.filter((_, i) => i !== idx))}
                        className="p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded transition-colors cursor-pointer ml-1"
                        title="Remove file"
                        aria-label="Remove file"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Action bar to apply staged modification */}
              <div className="flex items-center justify-end pt-1 border-t border-blue-200/60 dark:border-blue-900/40">
                <button
                  type="button"
                  onClick={handleApplyStagedModification}
                  disabled={modificationState === 'processing' || isApplyingStoredChanges}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <SparklesIcon className="w-3.5 h-3.5" />
                  <span>Apply Changes Now</span>
                </button>
              </div>
            </div>
          )}

          {/* Stored / Retrieved Changes Audio Player & Controls */}
          {storedModificationBlob && modificationState !== 'recording' && (
            <div className="mt-2 p-3 bg-white dark:bg-slate-800/90 rounded-xl border border-blue-200 dark:border-blue-900/60 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3 animate-in fade-in duration-150">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                  <FileAudio className="w-5 h-5" />
                </div>
                <div className="min-w-0 truncate">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate max-w-[220px]" title={storedModificationMeta?.name || 'Voice Changes Dictation'}>
                      {storedModificationMeta?.name || 'Voice Changes Dictation'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                      Stored in Browser
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                    {storedModificationMeta?.size ? `${(storedModificationMeta.size / 1024).toFixed(1)} KB` : `${(storedModificationBlob.size / 1024).toFixed(1)} KB`}
                    {storedModificationMeta?.timestamp ? ` • ${new Date(storedModificationMeta.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
                  </p>
                </div>
              </div>

              {/* Audio playback & action buttons */}
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {storedModificationAudioUrl && (
                  <audio src={storedModificationAudioUrl} controls className="h-7 w-44 sm:w-56" />
                )}

                <button
                  type="button"
                  onClick={handleDownloadChangesAudio}
                  className="p-1.5 text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                  title="Download stored changes audio file"
                  aria-label="Download stored changes audio"
                >
                  <DownloadIcon className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={handleSaveCurrentChangesAudio}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 transition-colors cursor-pointer"
                  title="Store audio into browser IndexedDB"
                >
                  <span>Store Audio</span>
                </button>

                <button
                  type="button"
                  onClick={handleApplyStoredChangesAudio}
                  disabled={isApplyingStoredChanges || modificationState === 'processing'}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition-colors disabled:opacity-50 cursor-pointer"
                  title="Re-apply or apply changes to report with this audio"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${isApplyingStoredChanges ? 'animate-spin' : ''}`} />
                  <span>{isApplyingStoredChanges ? 'Applying...' : 'Apply Changes'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleDiscardStoredChangesAudio}
                  className="p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                  title="Discard and delete stored changes audio"
                  aria-label="Discard stored changes audio"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Banner when audio is stored in database but not yet loaded into active state */}
          {hasPersistedChangesAudio && !storedModificationBlob && modificationState !== 'recording' && (
            <div className="mt-1 p-2.5 bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 rounded-xl flex items-center justify-between gap-2 text-xs text-indigo-900 dark:text-indigo-200 animate-in fade-in">
              <div className="flex items-center gap-2">
                <FolderDown className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <span>Previously recorded changes audio is preserved in browser storage.</span>
              </div>
              <button
                type="button"
                onClick={handleRetrieveStoredChangesAudio}
                disabled={isRetrievingChangesAudio}
                className="font-bold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 cursor-pointer"
              >
                <span>{isRetrievingChangesAudio ? 'Retrieving...' : 'Retrieve Stored Audio'}</span>
                <span>→</span>
              </button>
            </div>
          )}
        </div>
        {modificationError && <p className="text-red-500 dark:text-red-400 text-sm mt-2">{modificationError}</p>}
      </div>

    {/* Complex Impression Generator Section */}
    {!isLive && isComplexGeneratorVisible && (
        <div className="mt-6 p-4 border-2 border-dashed rounded-lg bg-slate-50 dark:bg-slate-700/50 dark:border-slate-600">
            {agenticStatus === 'processing' ? (
                <div className="flex flex-col items-center justify-center p-6 text-center">
                    <Spinner className="w-8 h-8 text-purple-600 mb-3" />
                    <p className="font-semibold text-slate-800 dark:text-slate-200">
                        Generating Complex Impression
                    </p>
                    <p className="text-sm font-medium text-purple-600 dark:text-purple-400 mt-2 px-3 py-1.5 rounded-lg bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-800/50 max-w-lg animate-pulse">
                        {agenticProgressText || 'Running agentic analysis...'}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                        Default: gemini-3.8-flash (Search Grounded) • Automatic failover & retry
                    </p>
                </div>
            ) : (
                <>
                    <div className="flex items-start sm:items-center gap-3 flex-col sm:flex-row">
                        <BrainIcon className="w-8 h-8 text-slate-600 dark:text-slate-300 flex-shrink-0" />
                        <div className="flex-grow">
                            <h4 className="font-semibold text-slate-800 dark:text-slate-200">Additional Findings for Complex Impression</h4>
                            <p className="text-sm text-slate-600 dark:text-slate-400">
                                Provide relevant findings from patient history or other reports to generate a more comprehensive impression.
                            </p>
                        </div>
                    </div>
                    <div className="relative mt-4">
                        <textarea
                            value={complexInput}
                            onChange={(e) => setComplexInput(e.target.value)}
                            placeholder="e.g., 'Patient has a history of metastatic lung cancer.' or 'Recent blood work shows elevated white cell count.'"
                            className="w-full p-2 pr-12 border border-slate-300 rounded-md text-sm bg-white text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500 focus:outline-none dark:bg-slate-900 dark:text-white dark:border-slate-600 dark:placeholder-slate-400"
                            rows={3}
                            aria-label="Additional findings for complex impression"
                        />
                        <button
                            onClick={handleComplexMicClick}
                            disabled={isTranscribingComplex}
                            className={`absolute bottom-2 right-2 p-1.5 rounded-full text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                complexInputRecorder.isRecording
                                ? 'bg-red-600 hover:bg-red-700 animate-pulse'
                                : 'bg-blue-600 hover:bg-blue-700'
                            }`}
                            aria-label={complexInputRecorder.isRecording ? 'Stop dictating' : 'Dictate additional findings'}
                        >
                            {isTranscribingComplex ? <Spinner className="w-5 h-5 text-white" /> : complexInputRecorder.isRecording ? <StopIcon className="w-5 h-5" /> : <MicIcon className="w-5 h-5" />}
                        </button>
                    </div>
                    {agenticError && <p className="text-red-500 dark:text-red-400 text-sm mt-2">{agenticError}</p>}
                    <div className="mt-4 flex justify-end gap-2">
                        <button onClick={() => setIsComplexGeneratorVisible(false)} className="bg-slate-200 text-slate-800 font-bold py-2 px-4 rounded-lg hover:bg-slate-300 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500">
                            Cancel
                        </button>
                        <button onClick={handleGenerateComplexImpression} disabled={isTranscribingComplex} className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                            Generate Impression
                        </button>
                    </div>
                </>
            )}
        </div>
    )}


      {!isLive && (
        <ChatInterface 
          history={chatHistory} 
          isChatting={isChatting} 
          onSendMessage={onSendMessage} 
          selectedModel={selectedModel}
        />
      )}

      <div className="mt-8 pt-6 border-t dark:border-slate-700 flex flex-col sm:flex-row justify-center items-center gap-4 flex-wrap">
        {isLive ? (
            <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto justify-center">
                {isPausedLive ? (
                    <button
                        onClick={onResumeLive}
                        className="w-full sm:w-auto flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold py-3 px-6 rounded-full hover:bg-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-300 transition-all shadow-md min-h-[48px]"
                        aria-label="Resume Live Session"
                    >
                        <ResumeIcon className="w-5 h-5" />
                        Resume Dictation
                    </button>
                ) : (
                    <button
                        onClick={onPauseLive}
                        className="w-full sm:w-auto flex items-center justify-center gap-2 bg-amber-500 text-white font-bold py-3 px-6 rounded-full hover:bg-amber-600 focus:outline-none focus:ring-4 focus:ring-amber-300 transition-all shadow-md min-h-[48px]"
                        aria-label="Pause Live Session"
                    >
                        <PauseIcon className="w-5 h-5" />
                        Pause Dictation
                    </button>
                )}
                <button
                    onClick={onStopLive}
                    className="w-full sm:w-auto flex items-center justify-center gap-2 bg-red-600 text-white font-bold py-3 px-8 rounded-full hover:bg-red-700 focus:outline-none focus:ring-4 focus:ring-red-300 transition-all duration-300 ease-in-out transform hover:scale-105 shadow-lg min-h-[48px]"
                    aria-label="Stop Live Session"
                >
                    <StopIcon className="w-6 h-6" />
                    Stop Live Dictation
                </button>
            </div>
        ) : (
          <div className="w-full flex flex-col items-center gap-3">
            {continueUnsavedSession && continuationState.status !== 'recording' && (
              <div className="w-full mb-3 p-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700/60 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in duration-200">
                <div className="flex items-center gap-3 text-amber-800 dark:text-amber-200">
                  <WarningIcon className="w-6 h-6 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div>
                    <p className="font-semibold text-sm sm:text-base">
                      Interrupted Continuation Audio Detected
                    </p>
                    <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
                      Found continuation audio chunks auto-saved at {new Date(continueUnsavedSession.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ({Math.round(continueUnsavedSession.totalBytes / 1024)} KB).
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 justify-end">
                  <button
                    onClick={handleDiscardContinue}
                    disabled={isRecoveringContinue}
                    className="px-3 py-1.5 text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-amber-100 dark:hover:bg-amber-800/40 rounded-lg transition-colors cursor-pointer"
                  >
                    Discard
                  </button>
                  <button
                    onClick={handleDownloadRecoveredContinue}
                    disabled={isRecoveringContinue}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs sm:text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-200/60 dark:bg-amber-800/60 hover:bg-amber-200 rounded-lg transition-colors cursor-pointer"
                  >
                    <DownloadIcon className="w-4 h-4" />
                    Save WAV Audio
                  </button>
                  <button
                    onClick={handleRestoreAndAppendContinue}
                    disabled={isRecoveringContinue}
                    className="px-4 py-1.5 text-xs sm:text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500 rounded-lg shadow transition-colors cursor-pointer"
                  >
                    {isRecoveringContinue ? 'Restoring...' : 'Restore & Transcribe'}
                  </button>
                </div>
              </div>
            )}
            {continuationState.status === 'idle' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap justify-center items-center gap-2.5 sm:gap-3 w-full">
            <button
              onClick={handleRecordNew}
              className="bg-blue-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-all shadow-sm w-full lg:w-auto flex items-center justify-center gap-2 min-h-[44px]"
            >
              <MicIcon className="w-4 h-4" />
              Record New Dictation
            </button>
            <button
              onClick={handleStartContinue}
              disabled={!audioBlob && !mergedContinuationBlob}
              className="bg-emerald-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-opacity-50 transition-all shadow-sm w-full lg:w-auto disabled:bg-emerald-300 dark:disabled:bg-emerald-900/40 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-h-[44px]"
            >
              <MicPlusIcon className="w-4 h-4" />
              Continue Dictation
            </button>
            <button
                onClick={() => setIsComplexGeneratorVisible(true)}
                className="bg-purple-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-50 transition-all shadow-sm w-full lg:w-auto flex items-center justify-center gap-2 min-h-[44px]"
            >
                <BrainIcon className="w-4 h-4" />
                Complex Impression
            </button>
            {expertNotes && (
                <button
                    onClick={handleDownloadExpertNotes}
                    className="bg-teal-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-opacity-50 transition-all shadow-sm w-full lg:w-auto flex items-center justify-center gap-2 min-h-[44px]"
                >
                    <DownloadIcon className="w-4 h-4" />
                    Download Expert Notes
                </button>
            )}
            <button
              onClick={handleDownload}
              disabled={!audioBlob && !mergedContinuationBlob}
              className="bg-slate-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-opacity-50 transition-all shadow-sm disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed w-full lg:w-auto flex items-center justify-center gap-2 min-h-[44px]"
            >
              <DownloadIcon className="w-4 h-4" />
              Download Audio
            </button>
            <button
              onClick={handleDownloadHTML}
              disabled={!findings || findings.length === 0}
              className="bg-emerald-700 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-opacity-50 transition-all shadow-sm disabled:bg-emerald-300 dark:disabled:bg-emerald-900/40 disabled:cursor-not-allowed w-full lg:w-auto flex items-center justify-center gap-2 min-h-[44px]"
            >
              <DownloadIcon className="w-4 h-4" />
              Download HTML
            </button>
          </div>
        ) : null}
        {continuationState.status === 'recording' && (
            <div className="w-full flex items-center justify-center gap-4 bg-red-100 dark:bg-red-900/20 p-3 rounded-xl border border-red-200 dark:border-red-800/40">
              <div className="flex items-center gap-2">
                  <div className="w-3 h-3 bg-red-500 rounded-full animate-ping"></div>
                  <span className="font-semibold text-red-700 dark:text-red-300">Recording additional dictation...</span>
              </div>
              <button
                  onClick={handleStopContinue}
                  className="flex items-center justify-center gap-2 bg-red-600 text-white font-bold py-2 px-5 rounded-lg hover:bg-red-700 active:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 shadow-sm transition-all"
                  aria-label="Stop continuing dictation"
              >
                  <StopIcon className="w-5 h-5"/>
                  Stop
              </button>
            </div>
        )}
        {continuationState.status === 'processing' && (
            <div className="w-full flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-100 dark:bg-slate-800/90 p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <div className="flex items-center gap-3">
                    <Spinner className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                    <div>
                        <span className="font-semibold text-slate-800 dark:text-slate-200 text-sm block">
                            Processing new dictation into report...
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                            {isMergingAudio ? 'Merging audio...' : 'Merged audio is ready and available to download.'}
                        </span>
                    </div>
                </div>
                {(mergedContinuationBlob || audioBlob) && (
                    <button
                        onClick={() => handleDownloadMerged(mergedContinuationBlob || audioBlob)}
                        className="flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-800 active:bg-slate-900 text-white font-bold py-2.5 px-4 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400 transition-all shadow-sm text-sm whitespace-nowrap min-h-[40px] w-full sm:w-auto"
                        title="Download the full merged audio file recorded so far"
                    >
                        <DownloadIcon className="w-4 h-4"/>
                        Download Audio (Merged)
                    </button>
                )}
            </div>
        )}
          </div>
        )}
      </div>
      {continuationState.error && (
        <div className="mt-4 p-3.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/60 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-red-600 dark:text-red-400 font-medium" role="alert">{continuationState.error}</p>
          {(mergedContinuationBlob || audioBlob) && (
            <button
              onClick={() => handleDownloadMerged(mergedContinuationBlob || audioBlob)}
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-800 text-white font-semibold py-1.5 px-3.5 rounded-lg text-xs transition-colors shadow-sm whitespace-nowrap"
            >
              <DownloadIcon className="w-3.5 h-3.5"/>
              Download Audio (Merged)
            </button>
          )}
        </div>
      )}
      </div>

      {multiSelectMode && (
          <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 dark:bg-slate-800/95 text-white rounded-full shadow-2xl border border-slate-700/80 flex items-center gap-2.5 sm:gap-3 px-3.5 sm:px-4 py-2 transition-all duration-300 ease-in-out backdrop-blur-xs">
            <div className="flex items-center gap-1.5">
              <CheckSquare className="w-4 h-4 text-blue-400 shrink-0" />
              <p className="text-xs sm:text-sm font-semibold whitespace-nowrap">
                {selectedIndices.size}/{getValidFindingIndices().size} selected
              </p>
            </div>
            <button
              type="button"
              onClick={selectedIndices.size === getValidFindingIndices().size ? handleDeselectAll : handleSelectAll}
              className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-2.5 py-1 rounded-full font-medium transition-colors cursor-pointer whitespace-nowrap"
            >
              {selectedIndices.size === getValidFindingIndices().size ? 'Deselect All' : 'Select All'}
            </button>
            {selectedIndices.size > 0 && selectedIndices.size < getValidFindingIndices().size && (
              <button
                type="button"
                onClick={handleDeselectAll}
                className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-2.5 py-1 rounded-full font-medium transition-colors cursor-pointer whitespace-nowrap"
                title="Clear selected findings"
              >
                Clear
              </button>
            )}
            <div className="h-4 w-[1px] bg-slate-700"></div>
            <label htmlFor="multi-select-toggle-single" className="flex items-center cursor-pointer select-none">
              <span className="mr-2 text-xs font-semibold text-slate-400">Done</span>
              <div className="relative">
                <input 
                  type="checkbox" 
                  id="multi-select-toggle-single" 
                  className="sr-only peer" 
                  checked={multiSelectMode}
                  onChange={() => {
                    setMultiSelectMode(false);
                    setSelectedIndices(new Set<number>());
                    setSelectionSnippets({});
                  }}
                />
                <div className="w-11 h-6 bg-slate-700 rounded-full peer-checked:bg-blue-600 transition-colors border border-slate-600"></div>
                <div className="absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform peer-checked:translate-x-5 shadow-xs"></div>
              </div>
            </label>
          </div>
      )}

      {/* Paste Text Modal for Dictating Changes */}
      <PasteTextModal
        isOpen={isModificationPasteModalOpen}
        onClose={() => setIsModificationPasteModalOpen(false)}
        initialText={modificationClipboardPastedText}
        onProcessSingle={(files: File[]) => {
          setStagedModificationFiles(prev => [...prev, ...files]);
          setIsModificationPasteModalOpen(false);
          setModificationClipboardPastedText('');
          showNotification(`Added ${files.length} text/file item(s) for report changes`);
        }}
        mode="single"
      />
    </div>
  );
};

export default ResultsDisplay;
