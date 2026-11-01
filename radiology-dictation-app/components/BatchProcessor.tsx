import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { processAudio, createChat, blobToBase64, continueAudioDictation, base64ToBlob, modifyFindingWithAudio, modifyReportWithAudio, identifyPotentialErrors, runComplexImpressionGeneration, transcribeAudioForPrompt, detectAndExtractTemplate, mergeDictatedFindingsWithTemplate } from '../services/geminiService';
import { saveAudioBlob, getAudioBlob, clearUnusedAudioBlobs } from '../services/audioStorage';
import { mergeMultipleAudioBlobs, triggerAudioDownload } from '../services/audioMerger';
import { ClipboardPaste, X, CheckSquare } from 'lucide-react';
import PasteTextModal from './PasteTextModal';
import RichTextReportEditor from './RichTextReportEditor';
import TemplateSelectionModal from './ui/TemplateSelectionModal';
import { getTemplateDocxBase64 } from '../services/builtInTemplates';
import { getUpcomingTemplate, clearUpcomingTemplate, subscribeToUpcomingTemplate, UpcomingTemplateConfig } from '../services/upcomingTemplateService';

import Spinner from './ui/Spinner';
import MicIcon from './icons/MicIcon';
import StopIcon from './icons/StopIcon';
import PauseIcon from './icons/PauseIcon';
import ResumeIcon from './icons/ResumeIcon';
import UploadIcon from './icons/UploadIcon';
import ChevronDownIcon from './icons/ChevronDownIcon';
import { Chat } from '@google/genai';
import ChatInterface from './ChatInterface';
import PencilIcon from './icons/PencilIcon';
import MicPlusIcon from './icons/MicPlusIcon';
import TrashIcon from './icons/TrashIcon';
import { generateBatchDictationHTML } from '../services/htmlGenerator';
import SelectionCopier from './ui/SelectionCopier';
import MicPencilIcon from './icons/MicPencilIcon';
import DownloadIcon from './icons/DownloadIcon';
import ReorderIcon from './icons/ReorderIcon';
import MergeIcon from './icons/MergeIcon';
import MicScribbleIcon from './icons/MicScribbleIcon';
import CustomPromptInput, { DocxTemplateData } from './ui/CustomPromptInput';
import ImageIcon from './icons/ImageIcon';
import SparklesIcon from './icons/SparklesIcon';
import { IdentifiedError } from '../types';
import { AVAILABLE_MODELS, REPORT_TEMPLATES, ReportTemplate } from '../constants';
import WarningIcon from './icons/WarningIcon';
import BrainIcon from './icons/BrainIcon';
import { autoSaveBatchDictations, SaveResult, BatchFolderInfo, isDriveConnected, subscribeToAuth } from '../services/googleDriveService';
import { generateDocxFromMarkdown, downloadFile, isTableRowFinding, parseTableRow, parseMarkdownTable, tableToPlainText } from '../services/docxService';
import { isClinicalProfileFinding, formatClinicalProfileText } from './ResultsDisplay';

const BATCH_DRIVE_FOLDER_KEY = 'radiologyDictationBatchDriveFolder';
const BATCH_SESSION_TIMESTAMP_KEY = 'radiologyDictationBatchSessionTimestamp';
const BATCH_DRIVE_SYNCED_HASH_KEY = 'radiologyDictationBatchDriveSyncedHash';


type BatchStatus = 'idle' | 'recording' | 'paused' | 'complete' | 'processing' | 'error';

interface ChatMessage {
  author: 'You' | 'AI';
  text: string;
}

interface Batch {
    id: string;
    name: string;
    audioBlobs: Blob[];
    findings: string[] | null;
    status: BatchStatus;
    selectedModel: string;
    customPrompt: string;
    customImages?: Array<{ data: string; mimeType: string }>;
    customDocx?: DocxTemplateData | null;
    extraFiles?: File[];
    error?: string;
    chat?: Chat | null;
    chatHistory?: ChatMessage[];
    isChatting?: boolean;
    identifiedErrors?: IdentifiedError[];
    errorCheckStatus?: 'idle' | 'checking' | 'complete';
}

interface BatchProcessorProps {
    onBack: () => void;
    selectedModel: string;
    isErrorCheckEnabled: boolean;
    initialFiles?: File[] | null;
    onClearInitialFiles?: () => void;
    onSaveToDrive?: (result: SaveResult) => void;
}

const BATCH_MODE_STORAGE_KEY = 'radiologyDictationBatchMode';
const BATCH_GLOBAL_PROMPT_KEY = 'radiologyDictationBatchGlobalPrompt';
const BATCH_GLOBAL_IMAGES_KEY = 'radiologyDictationBatchGlobalImages';

// Define serializable types for localStorage metadata
interface SerializableAudioBlob {
    data: string;
    type: string;
}
interface SerializableBatch extends Omit<Batch, 'audioBlobs' | 'chat' | 'extraFiles'> {
    audioCount?: number;
    audioBlobs?: SerializableAudioBlob[];
}

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

const renderBatchTableFinding = (lines: string[]) => {
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


declare const ClipboardItem: any;

const getCleanMimeType = (blob: Blob): string => {
    let mimeType = blob.type;
    if (!mimeType) {
        return 'audio/ogg';
    }
    if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) {
        return 'audio/webm';
    }
    return mimeType.split(';')[0];
};

const BatchProcessor: React.FC<BatchProcessorProps> = ({ 
    onBack, 
    selectedModel, 
    isErrorCheckEnabled, 
    initialFiles, 
    onClearInitialFiles,
    onSaveToDrive
}) => {
    const [batches, setBatches] = useState<Batch[]>([]);
    const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
    const {
        isRecording: isMainRecording,
        isPaused: isMainPaused,
        stopRecording: stopMainRecording,
        startRecording: startMainRecording,
        pauseRecording: pauseMainRecording,
        resumeRecording: resumeMainRecording,
        error: mainRecorderError,
        unsavedSession,
        getUnsavedSessionBlob,
        recoverUnsavedSession,
        discardUnsavedSession
    } = useAudioRecorder();
    const { isRecording: isContinuationRecording, startRecording: startContinuationRecording, stopRecording: stopContinuationRecording, error: continuationRecorderError } = useAudioRecorder();
    const { startRecording: startBatchContinuation, stopRecording: stopBatchContinuation, error: batchContinuationError } = useAudioRecorder();
    const [continuationState, setContinuationState] = useState<{ batchId: string | null; status: 'idle' | 'recording' | 'processing'; error: string | null }>({ batchId: null, status: 'idle', error: null });
    const [isBusy, setIsBusy] = useState(false);
    const [openAccordion, setOpenAccordion] = useState<string | null>(null);
    
    const [selections, setSelections] = useState<Record<string, Set<number>>>({});
    const [allCopiedId, setAllCopiedId] = useState<string | null>(null);
    const [isAllBatchesCopied, setIsAllBatchesCopied] = useState(false);
    const [copyNotification, setCopyNotification] = useState<{ text: string; visible: boolean }>({ text: '', visible: false });
    const [multiSelectMode, setMultiSelectMode] = useState<boolean>(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploadTargetBatchId, setUploadTargetBatchId] = useState<string | null>(null);

    // State for Edit Mode
    const [editingState, setEditingState] = useState<{ batchId: string; index: number } | null>(null);
    const [editingText, setEditingText] = useState<string>('');
    const [dictatingState, setDictatingState] = useState<{ batchId: string; index: number } | null>(null);
    const [dictateEditingState, setDictateEditingState] = useState<{ batchId: string; index: number } | null>(null);
    const [processingState, setProcessingState] = useState<{ batchId: string; index: number } | null>(null);
    const [continuationError, setContinuationError] = useState<{ batchId: string; index: number; message: string } | null>(null);
    const modifyRecorder = useAudioRecorder();
    
    // State for selection copier
    const [selectionSnippets, setSelectionSnippets] = useState<Record<string, Record<number, string>>>({});
    const [copier, setCopier] = useState<{ visible: boolean; x: number; y: number; text: string } | null>(null);
    const findingsContainerRef = useRef<HTMLDivElement>(null);

    // State for Drag and Drop
    const [reorderBatchId, setReorderBatchId] = useState<string | null>(null);
    const [mergeBatchId, setMergeBatchId] = useState<string | null>(null);
    const [clickMergeBatchState, setClickMergeBatchState] = useState<{ batchId: string; index: number } | null>(null);
    const [draggedState, setDraggedState] = useState<{ batchId: string; index: number } | null>(null);
    const [dragOverState, setDragOverState] = useState<{ batchId: string; index: number } | null>(null);
    const dragItem = useRef<{ batchId: string; index: number } | null>(null);
    const dragOverItem = useRef<{ batchId: string; index: number } | null>(null);
    const touchDragRef = useRef<{ batchId: string; sourceIndex: number; startX: number; startY: number; isDragging: boolean } | null>(null);
    const [undoStates, setUndoStates] = useState<Record<string, string[]>>({});
    const [batchRtfViewIds, setBatchRtfViewIds] = useState<Record<string, boolean>>({});

    const handleUpdateBatchFindings = (batchId: string, newFindings: string[]) => {
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, findings: newFindings } : b));
    };

    // State for Post-Dictation Template Merging per batch
    const [templateModalBatchId, setTemplateModalBatchId] = useState<string | null>(null);
    const [mergingBatchId, setMergingBatchId] = useState<string | null>(null);
    const [mergingTemplateName, setMergingTemplateName] = useState<string | null>(null);

    const handleSelectBatchTemplateToMerge = async (template: ReportTemplate | ReportTemplate[]) => {
        const batchId = templateModalBatchId;
        if (!batchId) return;
        setTemplateModalBatchId(null);

        const targetBatch = batches.find(b => b.id === batchId);
        if (!targetBatch || !targetBatch.findings) return;

        const templates = Array.isArray(template) ? template : [template];
        const isMulti = templates.length > 1;
        const templateName = templates.map(t => t.name).join(' + ');

        setMergingBatchId(batchId);
        setMergingTemplateName(templateName);
        setUndoStates(prev => ({ ...prev, [batchId]: [...targetBatch.findings!] }));

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

        // Update batch configuration with template
        setBatches(prev => prev.map(b => b.id === batchId ? {
            ...b,
            customPrompt: promptText,
            customDocx: docxData,
        } : b));

        try {
            const mergedFindings = await mergeDictatedFindingsWithTemplate(
                targetBatch.findings,
                templates,
                targetBatch.selectedModel || selectedModel,
                targetBatch.audioBlobs,
                promptText,
                docxData
            );

            setBatches(prev => prev.map(b => b.id === batchId ? {
                ...b,
                findings: mergedFindings,
            } : b));

            showNotification(`Merged ${targetBatch.name} with ${templateName}!`);

            // Auto-save to Google Drive
            setTimeout(() => {
                setBatches(current => {
                    saveBatchesToDrive(current);
                    return current;
                });
            }, 100);
        } catch (err) {
            console.error(`Failed to merge batch ${batchId} with template:`, err);
            showNotification(`Failed to merge with template: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setMergingBatchId(null);
            setMergingTemplateName(null);
        }
    };

    // State for 'Dictate Report Changes' feature
    const [modificationState, setModificationState] = useState<{ batchId: string | null; status: 'idle' | 'recording' | 'processing' }>({ batchId: null, status: 'idle' });
    const [modificationError, setModificationError] = useState<{ batchId: string | null; message: string | null }>({ batchId: null, message: null });
    const modificationRecorder = useAudioRecorder();

    // State for reordering entire batches
    const [isBatchReorderMode, setIsBatchReorderMode] = useState(false);
    const [expandedBatchPromptIds, setExpandedBatchPromptIds] = useState<Record<string, boolean>>({});
    const [dragOverBatchIndex, setDragOverBatchIndex] = useState<number | null>(null);
    const batchDragItem = useRef<number | null>(null);

    const [globalCustomPrompt, setGlobalCustomPrompt] = useState<string>(() => {
        return localStorage.getItem(BATCH_GLOBAL_PROMPT_KEY) || '';
    });
    const [globalCustomImages, setGlobalCustomImages] = useState<Array<{ data: string; mimeType: string }>>(() => {
        try {
            const saved = localStorage.getItem(BATCH_GLOBAL_IMAGES_KEY);
            return saved ? JSON.parse(saved) : [];
        } catch {
            return [];
        }
    });
    const [upcomingTemplate, setUpcomingTemplateState] = useState<UpcomingTemplateConfig | null>(() => getUpcomingTemplate());

    useEffect(() => {
        setUpcomingTemplateState(getUpcomingTemplate());
        const unsubscribe = subscribeToUpcomingTemplate((config) => {
            setUpcomingTemplateState(config);
            if (config) {
                // Prepopulate idle/unprocessed batches that don't have custom edits yet
                setBatches(prev => prev.map(b => (!b.findings && (!b.customPrompt || b.customPrompt === globalCustomPrompt)) ? {
                    ...b,
                    customPrompt: config.promptText,
                    customDocx: config.docxData || null
                } : b));
            } else {
                // If cleared, revert batches that had the upcoming template back to globalCustomPrompt
                setBatches(prev => prev.map(b => (!b.findings && b.customPrompt && b.customPrompt.startsWith('[TEMPLATE_ID:')) ? {
                    ...b,
                    customPrompt: globalCustomPrompt,
                    customDocx: null
                } : b));
            }
        });
        return unsubscribe;
    }, [globalCustomPrompt]);
    const [isMakingSelection, setIsMakingSelection] = useState<boolean>(false);

    // State for 'Complex Impression Generation' per batch
    const [complexGeneratorVisibleForBatchId, setComplexGeneratorVisibleForBatchId] = useState<string | null>(null);
    const [complexInputs, setComplexInputs] = useState<Record<string, string>>({});
    const [agenticStates, setAgenticStates] = useState<Record<string, 'idle' | 'processing' | 'error'>>({});
    const [agenticErrors, setAgenticErrors] = useState<Record<string, string | null>>({});
    const [agenticProgressTexts, setAgenticProgressTexts] = useState<Record<string, string>>({});
    const [expertNotesForBatches, setExpertNotesForBatches] = useState<Record<string, string | null>>({});
    const [isTranscribingComplex, setIsTranscribingComplex] = useState<Record<string, boolean>>({});
    const complexInputRecorder = useAudioRecorder();
    
    // For triggering error checks
    const processedFindingsRef = useRef<Map<string, string>>(new Map());

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

    const clearUndoStateForBatch = (batchId: string) => {
        setUndoStates(prev => {
            if (prev[batchId]) {
                const newStates = { ...prev };
                delete newStates[batchId];
                return newStates;
            }
            return prev;
        });
    };
    
    const [isRestored, setIsRestored] = useState(false);
    const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
    const [pasteModalTargetBatchId, setPasteModalTargetBatchId] = useState<string | null>(null);
    const [clipboardPastedText, setClipboardPastedText] = useState('');
    const [driveBatchFolder, setDriveBatchFolder] = useState<BatchFolderInfo | null>(null);
    const [batchExtraOptionsOpen, setBatchExtraOptionsOpen] = useState<{ [batchId: string]: boolean }>({});
    const [batchExtraTextOpen, setBatchExtraTextOpen] = useState<{ [batchId: string]: boolean }>({});

    const handleBatchExtraFilesSelected = (batchId: string, event: React.ChangeEvent<HTMLInputElement>) => {
        const files: File[] = Array.from(event.target.files || []);
        if (files.length > 0) {
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            const otherFiles = files.filter(f => !f.type.startsWith('image/'));

            if (imageFiles.length > 0) {
                imageFiles.forEach(imgFile => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        if (reader.result) {
                            const base64data = (reader.result as string).split(',')[1];
                            setBatches(prev => prev.map(b => b.id === batchId ? {
                                ...b,
                                customImages: [...(b.customImages || []), { data: base64data, mimeType: imgFile.type }]
                            } : b));
                        }
                    };
                    reader.readAsDataURL(imgFile);
                });
            }

            if (otherFiles.length > 0) {
                setBatches(prev => prev.map(b => b.id === batchId ? {
                    ...b,
                    extraFiles: [...(b.extraFiles || []), ...otherFiles]
                } : b));
            }
            setBatchExtraOptionsOpen(prev => ({ ...prev, [batchId]: true }));
        }
        if (event.target) event.target.value = '';
    };

    const handleBatchExtraImagesSelected = (batchId: string, event: React.ChangeEvent<HTMLInputElement>) => {
        const files: File[] = Array.from(event.target.files || []);
        if (files.length > 0) {
            files.forEach(imgFile => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    if (reader.result) {
                        const base64data = (reader.result as string).split(',')[1];
                        setBatches(prev => prev.map(b => b.id === batchId ? {
                            ...b,
                            customImages: [...(b.customImages || []), { data: base64data, mimeType: imgFile.type }]
                        } : b));
                    }
                };
                reader.readAsDataURL(imgFile);
            });
            setBatchExtraOptionsOpen(prev => ({ ...prev, [batchId]: true }));
        }
        if (event.target) event.target.value = '';
    };

    const handleRemoveBatchExtraFile = (batchId: string, index: number) => {
        setBatches(prev => prev.map(b => b.id === batchId ? {
            ...b,
            extraFiles: (b.extraFiles || []).filter((_, i) => i !== index)
        } : b));
    };

    const handleRemoveBatchCustomImage = (batchId: string, index: number) => {
        setBatches(prev => prev.map(b => b.id === batchId ? {
            ...b,
            customImages: (b.customImages || []).filter((_, i) => i !== index)
        } : b));
    };

    // Global Ctrl+V listener to directly capture text pastes when not actively recording or typing
    useEffect(() => {
        const handleGlobalPaste = (e: ClipboardEvent) => {
            if (activeBatchId) return;
            const target = e.target as HTMLElement;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }
            const text = e.clipboardData?.getData('text');
            if (text && text.trim().length > 0) {
                e.preventDefault();
                setClipboardPastedText(text);
                setPasteModalTargetBatchId(null);
                setIsPasteModalOpen(true);
            }
        };
        window.addEventListener('paste', handleGlobalPaste);
        return () => window.removeEventListener('paste', handleGlobalPaste);
    }, [activeBatchId]);

    const handlePasteBatches = (files: File[]) => {
        if (pasteModalTargetBatchId) {
            // Append files to the target batch
            setBatches(prev => prev.map(b => {
                if (b.id === pasteModalTargetBatchId) {
                    return {
                        ...b,
                        audioBlobs: [...b.audioBlobs, ...files],
                        status: 'complete'
                    };
                }
                return b;
            }));
            setPasteModalTargetBatchId(null);
        } else {
            // Create a new batch for each file
            const currentUpcoming = getUpcomingTemplate();
            const newBatches: Batch[] = files.map((file, idx) => ({
                id: `batch-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
                name: file.name.replace(/\.[^/.]+$/, "").replace(/_/g, " ") || `Batch ${batches.length + idx + 1}`,
                audioBlobs: [file],
                findings: null,
                status: 'complete',
                selectedModel: selectedModel,
                customPrompt: currentUpcoming ? currentUpcoming.promptText : globalCustomPrompt,
                customDocx: currentUpcoming ? (currentUpcoming.docxData || null) : null,
                customImages: [...globalCustomImages],
            }));
            setBatches(prev => [...prev, ...newBatches]);
        }
    };
    const [driveSyncedBatchHash, setDriveSyncedBatchHash] = useState<string | null>(null);
    const driveBatchFolderRef = useRef<BatchFolderInfo | null>(null);
    const driveSyncedBatchHashRef = useRef<string | null>(null);
    const isSavingDriveRef = useRef<boolean>(false);
    const batchSessionTimestampRef = useRef<number | null>(null);

    // Keep refs in sync with state
    useEffect(() => {
        driveBatchFolderRef.current = driveBatchFolder;
    }, [driveBatchFolder]);
    useEffect(() => {
        driveSyncedBatchHashRef.current = driveSyncedBatchHash;
    }, [driveSyncedBatchHash]);

     // Load state from localStorage & IndexedDB on initial render
    useEffect(() => {
        const loadState = async () => {
            try {
                const savedStateJSON = localStorage.getItem(BATCH_MODE_STORAGE_KEY);
                if (savedStateJSON) {
                    const savedBatches: SerializableBatch[] = JSON.parse(savedStateJSON);
                    
                    const restoredBatches: Batch[] = await Promise.all(savedBatches.map(async (savedBatch) => {
                        const audioBlobs: Blob[] = [];

                        // 1. Load audio blobs from IndexedDB by key
                        const count = savedBatch.audioCount ?? (savedBatch.audioBlobs ? savedBatch.audioBlobs.length : 0);
                        for (let idx = 0; idx < count; idx++) {
                            const blob = await getAudioBlob(`batch_audio_${savedBatch.id}_${idx}`);
                            if (blob) {
                                audioBlobs.push(blob);
                            } else if (savedBatch.audioBlobs && savedBatch.audioBlobs[idx]?.data) {
                                // Fallback to legacy base64 if present
                                try {
                                    audioBlobs.push(base64ToBlob(savedBatch.audioBlobs[idx].data, savedBatch.audioBlobs[idx].type));
                                } catch (e) {
                                    console.warn(`Could not decode legacy base64 audio for batch ${savedBatch.name}:`, e);
                                }
                            }
                        }
                        
                        let chat: Chat | null = null;
                        // Recreate chat session for batches that have been processed
                        if (savedBatch.status === 'complete' && savedBatch.findings && audioBlobs.length > 0) {
                            try {
                                const mergedBlob = await mergeMultipleAudioBlobs(audioBlobs);
                                chat = await createChat(mergedBlob, savedBatch.findings, savedBatch.customPrompt, savedBatch.customImages, savedBatch.selectedModel || selectedModel);
                            } catch (e) {
                                console.error(`Failed to recreate chat for batch ${savedBatch.name}:`, e);
                            }
                        }

                        const { audioCount: _, audioBlobs: __, ...batchFields } = savedBatch;

                        return {
                            ...batchFields,
                            audioBlobs,
                            chat,
                        };
                    }));
                    
                    if (restoredBatches.length > 0) {
                        setBatches(restoredBatches);
                        // Open the first processed batch accordion for better UX
                        const firstProcessed = restoredBatches.find(b => b.findings);
                        if (firstProcessed) {
                            setOpenAccordion(firstProcessed.id);
                        }
                    }

                    const savedFolderRaw = localStorage.getItem(BATCH_DRIVE_FOLDER_KEY);
                    if (savedFolderRaw) {
                        try {
                            setDriveBatchFolder(JSON.parse(savedFolderRaw));
                        } catch {}
                    }
                    const savedSessionTimestamp = localStorage.getItem(BATCH_SESSION_TIMESTAMP_KEY);
                    if (savedSessionTimestamp) {
                        batchSessionTimestampRef.current = parseInt(savedSessionTimestamp, 10);
                    }
                    const savedHash = localStorage.getItem(BATCH_DRIVE_SYNCED_HASH_KEY);
                    if (savedHash) {
                        setDriveSyncedBatchHash(savedHash);
                    }
                }
            } catch (error) {
                console.error("Failed to load batch state from localStorage/IndexedDB:", error);
                localStorage.removeItem(BATCH_MODE_STORAGE_KEY);
            } finally {
                setIsRestored(true);
            }
        };
        loadState();
    }, []);

    const saveBatchesToDrive = useCallback(async (currentBatches: Batch[], force = false) => {
        const completed = currentBatches.filter(b => b.findings && b.findings.length > 0);
        if (completed.length === 0) return;

        if (isSavingDriveRef.current) return;

        if (!batchSessionTimestampRef.current) {
            batchSessionTimestampRef.current = Date.now();
            localStorage.setItem(BATCH_SESSION_TIMESTAMP_KEY, String(batchSessionTimestampRef.current));
        }

        const currentHash = completed.map(b => `${b.id}:${(b.findings || []).join('|')}`).join(';;;');
        if (!force && currentHash === driveSyncedBatchHashRef.current) {
            return;
        }

        if (!isDriveConnected()) {
            return;
        }

        isSavingDriveRef.current = true;
        driveSyncedBatchHashRef.current = currentHash; // synchronously prevent re-entry

        try {
            const res = await autoSaveBatchDictations(
                currentBatches,
                driveBatchFolderRef.current,
                batchSessionTimestampRef.current
            );

            if (res.success) {
                if (res.batchFolder) {
                    setDriveBatchFolder(res.batchFolder);
                    driveBatchFolderRef.current = res.batchFolder;
                    localStorage.setItem(BATCH_DRIVE_FOLDER_KEY, JSON.stringify(res.batchFolder));
                }
                setDriveSyncedBatchHash(currentHash);
                localStorage.setItem(BATCH_DRIVE_SYNCED_HASH_KEY, currentHash);

                if (onSaveToDrive) {
                    onSaveToDrive(res);
                }
            }
        } catch (e) {
            console.warn('Drive batch auto-save error:', e);
        } finally {
            isSavingDriveRef.current = false;
        }
    }, [onSaveToDrive]);

    // Reconnection listener: automatically upload completed batches when Drive is reconnected
    useEffect(() => {
        let wasConnected = isDriveConnected();
        const unsubscribe = subscribeToAuth((user, token) => {
            const isNowConnected = Boolean(user && token && isDriveConnected());
            if (isNowConnected && !wasConnected) {
                wasConnected = true;
                setBatches(currentBatches => {
                    const completed = currentBatches.filter(b => b.findings && b.findings.length > 0);
                    if (completed.length > 0) {
                        saveBatchesToDrive(currentBatches);
                    }
                    return currentBatches;
                });
            } else if (!isNowConnected) {
                wasConnected = false;
            }
        });
        return () => unsubscribe();
    }, [saveBatchesToDrive]);

    // Handle initialFiles passed from App (e.g. when multiple files uploaded from single mode)
    useEffect(() => {
        if (isRestored && initialFiles && initialFiles.length > 0) {
            const currentUpcoming = getUpcomingTemplate();
            const newBatches: Batch[] = initialFiles.map((file, idx) => ({
                id: `batch-${Date.now()}-${idx}`,
                name: file.name.replace(/\.[^/.]+$/, "") || `Dictation Batch ${Date.now() + idx}`,
                audioBlobs: [file],
                findings: null,
                status: 'complete',
                selectedModel: selectedModel,
                customPrompt: currentUpcoming ? currentUpcoming.promptText : globalCustomPrompt,
                customDocx: currentUpcoming ? (currentUpcoming.docxData || null) : null,
                customImages: [...globalCustomImages],
            }));
            setBatches(prev => [...prev, ...newBatches]);
            if (onClearInitialFiles) {
                onClearInitialFiles();
            }
        }
    }, [isRestored, initialFiles]);

    // Save state to localStorage & IndexedDB whenever batches change
    useEffect(() => {
        if (!isRestored) return; // Do not overwrite or delete until initial restoration completes

        const saveState = async () => {
            if (batches.length === 0) {
                if (localStorage.getItem(BATCH_MODE_STORAGE_KEY)) {
                    localStorage.removeItem(BATCH_MODE_STORAGE_KEY);
                }
                clearUnusedAudioBlobs([]).catch(() => {});
                return;
            }
            
            try {
                const usedKeys: string[] = [];
                const serializableBatches: SerializableBatch[] = await Promise.all(
                    batches.map(async (batch) => {
                        // Store audio blobs safely in IndexedDB
                        await Promise.all(
                            batch.audioBlobs.map(async (blob, idx) => {
                                const key = `batch_audio_${batch.id}_${idx}`;
                                usedKeys.push(key);
                                await saveAudioBlob(key, blob);
                            })
                        );

                        const { chat, audioBlobs, ...rest } = batch;

                        return {
                            ...rest,
                            audioCount: audioBlobs.length,
                        };
                    })
                );

                localStorage.setItem(BATCH_MODE_STORAGE_KEY, JSON.stringify(serializableBatches));
                clearUnusedAudioBlobs(usedKeys).catch(() => {});
            } catch (error) {
                console.error("Failed to save batch state:", error);
            }
        };
        
        saveState();
    }, [batches, isRestored]);

    useEffect(() => {
        localStorage.setItem(BATCH_GLOBAL_PROMPT_KEY, globalCustomPrompt);
    }, [globalCustomPrompt]);

    useEffect(() => {
        localStorage.setItem(BATCH_GLOBAL_IMAGES_KEY, JSON.stringify(globalCustomImages));
    }, [globalCustomImages]);


    // useEffect to run error check in background for batches
    useEffect(() => {
        // If globally disabled, clear all errors and stop
        if (!isErrorCheckEnabled) {
            const needsClearing = batches.some(b => b.identifiedErrors && b.identifiedErrors.length > 0);
            if (needsClearing) {
                setBatches(prev => prev.map(b => ({ ...b, identifiedErrors: [], errorCheckStatus: 'idle' })));
            }
            processedFindingsRef.current.clear();
            return;
        }

        batches.forEach(batch => {
            if (batch.findings && batch.findings.length > 0) {
                const findingsKey = JSON.stringify(batch.findings);
                const lastProcessedKey = processedFindingsRef.current.get(batch.id);

                if (findingsKey !== lastProcessedKey) {
                    // Findings have changed, run the check
                    processedFindingsRef.current.set(batch.id, findingsKey);

                    // Set status to checking
                    setBatches(prev => prev.map(b => b.id === batch.id ? { ...b, errorCheckStatus: 'checking', identifiedErrors: [] } : b));
                    
                    identifyPotentialErrors(batch.findings, batch.selectedModel)
                    .then(errors => {
                        setBatches(prev => prev.map(b => b.id === batch.id ? { ...b, identifiedErrors: errors, errorCheckStatus: 'complete' } : b));
                    })
                    .catch(err => {
                        console.error(`Error check failed for batch ${batch.id}:`, err);
                        setBatches(prev => prev.map(b => b.id === batch.id ? { ...b, errorCheckStatus: 'complete' } : b));
                    });
                }
            } else if (processedFindingsRef.current.has(batch.id)) {
                // Findings were cleared, remove from tracking
                processedFindingsRef.current.delete(batch.id);
            }
        });
    }, [batches, isErrorCheckEnabled]);


    // Add mouse up handler for text selection
    useEffect(() => {
        const handleMouseUp = (event: MouseEvent) => {
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
            const batchId = findingItem.getAttribute('data-batch-id');
            const indexStr = findingItem.getAttribute('data-finding-index');

            if (batchId && indexStr) {
                const index = parseInt(indexStr, 10);
                
                if (multiSelectMode) {
                setSelectionSnippets(prev => ({
                    ...prev,
                    [batchId]: {
                    ...(prev[batchId] || {}),
                    [index]: selectedText,
                    },
                }));
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
    
    useEffect(() => {
        if (mainRecorderError && activeBatchId) {
             setBatches(prevBatches =>
                prevBatches.map(b =>
                    b.id === activeBatchId ? { ...b, status: 'error', error: mainRecorderError } : b
                )
            );
            setActiveBatchId(null);
            setIsBusy(false);
        }
    }, [mainRecorderError, activeBatchId]);

    useEffect(() => {
        if (continuationRecorderError && dictatingState) {
            setContinuationError({ ...dictatingState, message: continuationRecorderError });
            setDictatingState(null);
        }
    }, [continuationRecorderError, dictatingState]);

    useEffect(() => {
        if (modifyRecorder.error && dictateEditingState) {
            setContinuationError({ ...dictateEditingState, message: modifyRecorder.error });
            setDictateEditingState(null);
        }
    }, [modifyRecorder.error, dictateEditingState]);

    useEffect(() => {
        if (batchContinuationError && continuationState.batchId) {
            setContinuationState({ batchId: continuationState.batchId, status: 'idle', error: batchContinuationError });
        }
    }, [batchContinuationError, continuationState.batchId]);

    useEffect(() => {
        if (modificationRecorder.error && modificationState.batchId) {
            setModificationError({ batchId: modificationState.batchId, message: modificationRecorder.error });
            setModificationState({ batchId: null, status: 'idle' });
        }
    }, [modificationRecorder.error, modificationState.batchId]);

    useEffect(() => {
      if (complexInputRecorder.error) {
        if (complexGeneratorVisibleForBatchId) {
            setAgenticErrors(prev => ({ ...prev, [complexGeneratorVisibleForBatchId]: complexInputRecorder.error }));
        }
      }
    }, [complexInputRecorder.error, complexGeneratorVisibleForBatchId]);

    const addBatch = () => {
        handleAddNewBatch();
    };

    useEffect(() => {
        const handleTrigger = () => {
            handleAddNewBatch();
        };
        window.addEventListener('app-trigger-new-batch-dictation', handleTrigger);
        return () => window.removeEventListener('app-trigger-new-batch-dictation', handleTrigger);
    }, [batches.length, selectedModel, globalCustomPrompt, globalCustomImages]);

    const handleAddNewBatch = () => {
        const newId = crypto.randomUUID();
        const nextBatchNumber = batches.length + 1;
        const currentUpcoming = getUpcomingTemplate();
        const newBatch: Batch = {
            id: newId,
            name: `Dictation #${nextBatchNumber}`,
            audioBlobs: [],
            findings: null,
            status: 'idle',
            isChatting: false,
            selectedModel: selectedModel,
            customPrompt: currentUpcoming ? currentUpcoming.promptText : globalCustomPrompt,
            customDocx: currentUpcoming ? (currentUpcoming.docxData || null) : null,
            customImages: [...globalCustomImages],
        };
        setBatches(prev => [...prev, newBatch]);
        showNotification(`Created Dictation #${nextBatchNumber}`);
        setTimeout(() => {
            const cardEl = document.getElementById(`batch-card-${newId}`);
            if (cardEl) {
                cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 120);
    };
    
    const removeBatch = (id: string) => {
        if (isMainRecording) {
            alert("Please stop recording before removing a dictation batch.");
            return;
        }
        setBatches(prev => prev.filter(b => b.id !== id));
        // Clean up associated state
        setComplexInputs(prev => { const next = {...prev}; delete next[id]; return next; });
        setAgenticStates(prev => { const next = {...prev}; delete next[id]; return next; });
        setAgenticErrors(prev => { const next = {...prev}; delete next[id]; return next; });
        setExpertNotesForBatches(prev => { const next = {...prev}; delete next[id]; return next; });
    };

    const clearAllBatches = () => {
        if (isMainRecording) {
            alert("Please stop recording before clearing all batches.");
            return;
        }
        if (batches.length > 0) {
            setBatches([]);
            // Clean up all associated state
            setComplexInputs({});
            setAgenticStates({});
            setAgenticErrors({});
            setExpertNotesForBatches({});
            setDriveBatchFolder(null);
            setDriveSyncedBatchHash(null);
            batchSessionTimestampRef.current = null;
            localStorage.removeItem(BATCH_DRIVE_FOLDER_KEY);
            localStorage.removeItem(BATCH_SESSION_TIMESTAMP_KEY);
            localStorage.removeItem(BATCH_DRIVE_SYNCED_HASH_KEY);
        }
    };


    const updateBatchName = (id: string, name: string) => {
        setBatches(prev => prev.map(b => b.id === id ? { ...b, name } : b));
    };

    const updateBatchModel = (id: string, model: string) => {
        setBatches(prev => prev.map(b => b.id === id ? { ...b, selectedModel: model } : b));
    };

    const updateBatchCustomPrompt = (id: string, prompt: string) => {
        setBatches(prev => prev.map(b => b.id === id ? { ...b, customPrompt: prompt } : b));
    };

    const updateBatchCustomImages = (id: string, images: Array<{ data: string; mimeType: string }>) => {
        setBatches(prev => prev.map(b => b.id === id ? { ...b, customImages: images } : b));
    };

    const updateBatchCustomDocx = (id: string, docx: DocxTemplateData | null) => {
        setBatches(prev => prev.map(b => b.id === id ? { ...b, customDocx: docx } : b));
    };

    const handleRecordOrResume = async (batch: Batch) => {
        if (isBusy) return;
        setIsBusy(true);

        const targetBatchId = batch.id;
        const currentActiveBatchId = activeBatchId;

        try {
            // If we are currently recording another batch, stop it first and save its blob
            if (isMainRecording && currentActiveBatchId && currentActiveBatchId !== targetBatchId) {
                const capturedBlob = await stopMainRecording();
                
                // Save the blob from the previously recording batch
                setBatches(prevBatches => 
                    prevBatches.map(b => {
                        if (b.id === currentActiveBatchId) {
                            return {
                                ...b,
                                audioBlobs: [...(b.audioBlobs || []), capturedBlob],
                                status: 'complete' as BatchStatus,
                            };
                        }
                        return b;
                    })
                );
            } else if (isMainRecording && currentActiveBatchId === targetBatchId) {
                // If clicking on the same batch that's recording, just return
                setIsBusy(false);
                return;
            }

            // Start recording for the target batch
            await startMainRecording();
            setActiveBatchId(targetBatchId);
            
            // Update the target batch status to recording
            setBatches(prevBatches => 
                prevBatches.map(b => {
                    if (b.id === targetBatchId) {
                        return {
                            ...b,
                            status: 'recording' as BatchStatus,
                        };
                    }
                    return b;
                })
            );
        } catch (error) {
            console.error('Error in handleRecordOrResume:', error);
            setActiveBatchId(null);
        } finally {
            setIsBusy(false);
        }
    };
    
    const handlePauseToggle = () => {
        if (isBusy || !isMainRecording) return;
    
        if (isMainPaused) {
            resumeMainRecording();
        } else {
            pauseMainRecording();
        }
    };
    
    const handleStop = async () => {
        if (isBusy || !isMainRecording || !activeBatchId) return;
        
        const batchIdToStop = activeBatchId;
        setIsBusy(true);
    
        try {
            const blob = await stopMainRecording();
            
            // Update the batch with the new blob atomically
            setBatches(prevBatches => 
                prevBatches.map(b => {
                    if (b.id === batchIdToStop) {
                        return {
                            ...b,
                            audioBlobs: [...(b.audioBlobs || []), blob],
                            status: 'complete' as BatchStatus,
                        };
                    }
                    return b;
                })
            );
            
            setActiveBatchId(null);
        } catch (error) {
            console.error('Error in handleStop:', error);
            // Even if there's an error, try to update the status
            setBatches(prevBatches =>
                prevBatches.map(b => 
                    b.id === batchIdToStop 
                        ? { ...b, status: 'error' as BatchStatus, error: String(error) }
                        : b
                )
            );
            setActiveBatchId(null);
        } finally {
            setIsBusy(false);
        }
    };
    
    const [isGeneralDragging, setIsGeneralDragging] = useState(false);
    const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);
    const [isUploadReplace, setIsUploadReplace] = useState(false);
    const generalDragCounter = useRef(0);
    const batchProcessingIdRef = useRef<Record<string, number>>({});

    const handleCancelBatchProcessing = (batchId: string) => {
        batchProcessingIdRef.current[batchId] = (batchProcessingIdRef.current[batchId] || 0) + 1;
        setBatches(prev => prev.map(b => {
            if (b.id === batchId && b.status === 'processing') {
                return {
                    ...b,
                    status: b.findings ? 'complete' : 'idle'
                };
            }
            return b;
        }));
    };

    const triggerUpload = (batchId: string | null = null, replace: boolean = false) => {
        if (isMainRecording) return;
        setIsUploadReplace(replace);
        setUploadTargetBatchId(batchId);
        fileInputRef.current?.click();
    };

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files: File[] = Array.from(event.target.files || []);
        if (files.length > 0) {
            if (uploadTargetBatchId) {
                const newFiles = isUploadReplace ? [files[0]] : files;
                setBatches(prev => prev.map(b => 
                    b.id === uploadTargetBatchId 
                        ? { 
                            ...b, 
                            audioBlobs: isUploadReplace ? [files[0]] : [...b.audioBlobs, ...files], 
                            status: 'complete', 
                            findings: null, 
                            error: undefined 
                          } 
                        : b
                ));
                setUploadTargetBatchId(null);
                setIsUploadReplace(false);
            } else {
                const currentUpcoming = getUpcomingTemplate();
                const newBatches: Batch[] = files.map((file, idx) => ({
                    id: `batch-${Date.now()}-${idx}`,
                    name: file.name.replace(/\.[^/.]+$/, "") || `Dictation Batch ${batches.length + idx + 1}`,
                    audioBlobs: [file],
                    findings: null,
                    status: 'complete',
                    selectedModel: selectedModel,
                    customPrompt: currentUpcoming ? currentUpcoming.promptText : globalCustomPrompt,
                    customDocx: currentUpcoming ? (currentUpcoming.docxData || null) : null,
                    customImages: [...globalCustomImages],
                }));
                setBatches(prev => [...prev, ...newBatches]);
            }
        }
        if (event.target) event.target.value = "";
    };

    // Drag and Drop Audio File Upload Handlers
    const handleGeneralDragEnter = (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            generalDragCounter.current++;
            setIsGeneralDragging(true);
        }
    };

    const handleGeneralDragLeave = (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            generalDragCounter.current--;
            if (generalDragCounter.current <= 0) {
                generalDragCounter.current = 0;
                setIsGeneralDragging(false);
            }
        }
    };

    const handleGeneralDragOver = (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const handleGeneralDrop = (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            generalDragCounter.current = 0;
            setIsGeneralDragging(false);

            const files: File[] = Array.from(e.dataTransfer.files);

            if (files.length > 0) {
                const currentUpcoming = getUpcomingTemplate();
                const newBatches: Batch[] = files.map((file, idx) => ({
                    id: `batch-${Date.now()}-${idx}`,
                    name: file.name.replace(/\.[^/.]+$/, "") || `Dictation Batch ${batches.length + idx + 1}`,
                    audioBlobs: [file],
                    findings: null,
                    status: 'complete',
                    selectedModel: selectedModel,
                    customPrompt: currentUpcoming ? currentUpcoming.promptText : globalCustomPrompt,
                    customDocx: currentUpcoming ? (currentUpcoming.docxData || null) : null,
                    customImages: [...globalCustomImages],
                }));
                setBatches(prev => [...prev, ...newBatches]);
            }
        }
    };

    const handleCardDragOver = (e: React.DragEvent, batchId: string) => {
        if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            setDragOverCardId(batchId);
        }
    };

    const handleCardDragLeave = (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            setDragOverCardId(null);
        }
    };

    const handleCardDrop = (e: React.DragEvent, batchId: string) => {
        if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            setDragOverCardId(null);

            const files = Array.from(e.dataTransfer.files);

            if (files.length > 0) {
                setBatches(prev => prev.map(b => 
                    b.id === batchId 
                        ? { ...b, audioBlobs: [...b.audioBlobs, ...files], status: 'complete', findings: null, error: undefined }
                        : b
                ));
            }
        }
    };

    const handleRecoverBatch = async () => {
        const recoveredBlob = await recoverUnsavedSession();
        if (recoveredBlob && recoveredBlob.size > 0) {
            const newBatch: Batch = {
                id: `batch-${Date.now()}`,
                name: `Recovered Dictation ${batches.length + 1}`,
                audioBlobs: [recoveredBlob],
                findings: null,
                status: 'complete',
                selectedModel: selectedModel,
                customPrompt: globalCustomPrompt,
                customImages: [...globalCustomImages],
            };
            setBatches(prev => [newBatch, ...prev]);
        }
    };

    const handleDownloadRecoveredBatch = () => {
        const recoveredBlob = getUnsavedSessionBlob();
        if (recoveredBlob) {
            const url = URL.createObjectURL(recoveredBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `recovered_batch_dictation_${new Date().toISOString().slice(0, 10)}.webm`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    };

    const handleProcessAll = async () => {
        const batchesToProcess = batches.filter(b => (b.status === 'complete' || b.status === 'paused') && b.audioBlobs.length > 0 && !b.findings);
        if (batchesToProcess.length === 0) return;

        batchesToProcess.forEach(b => {
            batchProcessingIdRef.current[b.id] = (batchProcessingIdRef.current[b.id] || 0) + 1;
        });

        setBatches(prev => prev.map(b => batchesToProcess.find(p => p.id === b.id) ? {...b, status: 'processing'} : b));

        await Promise.all(batchesToProcess.map(async (batch) => {
            if (batch.audioBlobs.length === 0) return;
            const currentReqId = batchProcessingIdRef.current[batch.id];
            try {
                const mergedBlob = await mergeMultipleAudioBlobs(batch.audioBlobs);
                const currentUpcoming = getUpcomingTemplate();
                const effectivePrompt = batch.customPrompt || (currentUpcoming ? currentUpcoming.promptText : globalCustomPrompt);
                const effectiveDocx = batch.customDocx || (currentUpcoming ? (currentUpcoming.docxData || null) : null);
                const findings = await processAudio(mergedBlob, batch.selectedModel, effectivePrompt, batch.customImages, undefined, effectiveDocx);
                
                if (batchProcessingIdRef.current[batch.id] !== currentReqId) return;

                const chatSession = await createChat(mergedBlob, findings, effectivePrompt, batch.customImages, batch.selectedModel);
                const aiGreeting = "I have reviewed the audio and transcript for this dictation. How can I help you further?";
                const initialChatHistory = [{ author: 'AI' as const, text: `${findings.join('\n\n')}\n\n${aiGreeting}` }];

                if (batchProcessingIdRef.current[batch.id] !== currentReqId) return;

                setBatches(prev => prev.map(b => b.id === batch.id ? { ...b, status: 'complete', findings, chat: chatSession, chatHistory: initialChatHistory, isChatting: false } : b));
            } catch (err) {
                if (batchProcessingIdRef.current[batch.id] !== currentReqId) return;
                const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
                setBatches(prev => prev.map(b => b.id === batch.id ? { ...b, status: 'error', error: errorMessage } : b));
            }
        }));

        // Automatically archive processed batch reports as HTML to Google Drive in hidden background
        setTimeout(() => {
            setBatches(currentBatches => {
                saveBatchesToDrive(currentBatches);
                return currentBatches;
            });
        }, 100);
    };
    
    const handleReprocessBatch = async (batchId: string) => {
        const batch = batches.find(b => b.id === batchId);
        const allBlobs = [...(batch?.audioBlobs || []), ...(batch?.extraFiles || [])];
        if (!batch || allBlobs.length === 0) return;

        if (batch && batch.findings) {
            setUndoStates(prev => ({ ...prev, [batchId]: [...batch.findings!] }));
        }

        const currentReqId = (batchProcessingIdRef.current[batchId] || 0) + 1;
        batchProcessingIdRef.current[batchId] = currentReqId;

        setBatches(prev => prev.map(b => b.id === batchId ? {...b, status: 'processing', error: undefined } : b));

        try {
            const findings = await processAudio(allBlobs, batch.selectedModel, batch.customPrompt, batch.customImages, undefined, batch.customDocx);
            
            if (batchProcessingIdRef.current[batchId] !== currentReqId) return;

            const chatSession = await createChat(allBlobs, findings, batch.customPrompt, batch.customImages, batch.selectedModel);
            const aiGreeting = "I have reviewed the audio and transcript for this dictation. How can I help you further?";
            const initialChatHistory = [{ author: 'AI' as const, text: `${findings.join('\n\n')}\n\n${aiGreeting}` }];

            if (batchProcessingIdRef.current[batchId] !== currentReqId) return;

            setBatches(prev => {
                const updated = prev.map(b => b.id === batchId ? { ...b, audioBlobs: allBlobs, extraFiles: [], status: 'complete', findings, chat: chatSession, chatHistory: initialChatHistory, isChatting: false } : b);
                saveBatchesToDrive(updated);
                return updated;
            });
        } catch (err) {
            if (batchProcessingIdRef.current[batchId] !== currentReqId) return;
            const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
            setBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: 'error', error: errorMessage, findings: null } : b));
        }
    };

    const handleSendMessage = async (batchId: string, message: string | Blob) => {
        const batchIndex = batches.findIndex(b => b.id === batchId);
        if (batchIndex === -1) return;

        const batch = batches[batchIndex];
        if (!batch.chat || batch.isChatting) return;

        const userMessageText = typeof message === 'string' ? message : '[Audio Message]';
        const updatedHistory = [...(batch.chatHistory || []), { author: 'You' as const, text: userMessageText }];
        
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, isChatting: true, chatHistory: updatedHistory } : b));

        try {
            let response;
            if (typeof message === 'string') {
                response = await batch.chat.sendMessage({ message });
            } else {
                const base64Audio = await blobToBase64(message);
                const audioPart = {
                    inlineData: { mimeType: getCleanMimeType(message), data: base64Audio },
                };
                const textPart = { text: "Please analyze this audio in the context of our conversation." };
                response = await batch.chat.sendMessage({ message: [audioPart, textPart] });
            }
            const responseText = response.text;
            setBatches(prev => prev.map(b => b.id === batchId ? {...b, chatHistory: [...updatedHistory, { author: 'AI' as const, text: responseText }]} : b));
        } catch (err) {
            console.error("Chat error:", err);
            const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
            setBatches(prev => prev.map(b => b.id === batchId ? {...b, chatHistory: [...updatedHistory, { author: 'AI' as const, text: `Sorry, I encountered an error: ${errorMessage}` }]} : b));
        } finally {
            setBatches(prev => prev.map(b => b.id === batchId ? {...b, isChatting: false} : b));
        }
    };

    const handleUpdateFindingForBatch = (batchId: string, findingIndex: number, newText: string) => {
        setBatches(prevBatches => prevBatches.map(b => {
            if (b.id === batchId && b.findings) {
                const updatedFindings = [...b.findings];
                updatedFindings[findingIndex] = newText;
                return { ...b, findings: updatedFindings };
            }
            return b;
        }));
    };
    
    const showNotification = (text: string) => {
      setCopyNotification({ text, visible: true });
      setTimeout(() => setCopyNotification({ text: '', visible: false }), 2000);
    };

    const copyToClipboard = async (plainText: string, htmlText: string) => {
        try {
          const htmlBlob = new Blob([htmlText], { type: 'text/html' });
          const textBlob = new Blob([plainText], { type: 'text/plain' });
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

    const copyBatchSelection = async (batchId: string, selection: Set<number>) => {
      const batch = batches.find(b => b.id === batchId);
      if (!batch || !batch.findings) return;

      if (selection.size === 0) {
        showNotification('Selection cleared.');
        return;
      }

      const sortedIndices = Array.from(selection).sort((a, b) => a - b);
      
      const { plain, html } = sortedIndices.reduce((acc, i) => {
        const snippet = (selectionSnippets[batchId] || {})[i];
        if (snippet) {
          acc.plain.push(snippet);
          acc.html.push(`<strong>${snippet}</strong>`);
        } else {
          const finding = batch.findings![i];
          const isBold = finding.includes('BOLD::');
          const cleanFinding = finding.replace(/BOLD::/g, '');
          const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
          const isClinicalProfile = isClinicalProfileFinding(cleanFinding);
          const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(cleanFinding);
          const isImpression = isStructured && !isTable && title.trim().toUpperCase() === 'IMPRESSION:';
          const isItalic = !isTable && (isClinicalProfile || (!isStructured && cleanFinding.startsWith('*') && cleanFinding.endsWith('*')));
          
          if (isTitle) {
            acc.plain.push(cleanFinding);
            acc.html.push(`<p style="text-align:center;"><strong><u>${cleanFinding}</u></strong></p>`);
          } else if (isClinicalProfile) {
            const profText = formatClinicalProfileText(cleanFinding);
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
                acc.plain.push(cleanFinding.slice(1, -1));
                acc.html.push(`<p><em>${cleanFinding.slice(1, -1)}</em></p>`);
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
      const validCount = (batch.findings || []).filter(f => f && f.trim() !== '').length;
      const isSubset = selection.size > 0 && selection.size < validCount;
      const deselectedCount = validCount - selection.size;
      const notificationText = success
        ? isSubset
          ? `Copied ${selection.size} finding${selection.size > 1 ? 's' : ''} for ${batch.name} (${deselectedCount} deselected)!`
          : `Copied ${selection.size} finding${selection.size > 1 ? 's' : ''} for ${batch.name}!`
        : 'Copy failed!';
      showNotification(notificationText);
    };

    const handleMultiSelectToggleForBatch = (batchId: string, findingIndex: number) => {
        if (!multiSelectMode) {
            setMultiSelectMode(true);
            setCopier(null);

            const selection = window.getSelection();
            const selectedText = selection?.toString().trim();

            if (selection && selectedText && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const startNode = range.startContainer;
                const parentFindingItem = (startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode as HTMLElement)?.closest('.finding-item');
                
                if (parentFindingItem) {
                    const selectedBatchId = parentFindingItem.getAttribute('data-batch-id');
                    const selectedIndexStr = parentFindingItem.getAttribute('data-finding-index');
                    if (selectedBatchId && selectedIndexStr) {
                        const selectedIndex = parseInt(selectedIndexStr, 10);
                        if (selectedBatchId === batchId && selectedIndex === findingIndex) {
                            setSelectionSnippets(prev => ({
                                ...prev,
                                [batchId]: {
                                ...(prev[batchId] || {}),
                                [findingIndex]: selectedText,
                                },
                            }));
                        }
                    }
                }
            }
        }
        const newSelections = { ...selections };
        const batchSelection = new Set<number>(newSelections[batchId] || []);
        
        if (batchSelection.has(findingIndex)) {
            batchSelection.delete(findingIndex);
            setSelectionSnippets(prev => {
                const newBatchSnippets = { ...(prev[batchId] || {}) };
                delete newBatchSnippets[findingIndex];
                return { ...prev, [batchId]: newBatchSnippets };
            });
        } else {
            batchSelection.add(findingIndex);
        }
        newSelections[batchId] = batchSelection;
        setSelections(newSelections);
        copyBatchSelection(batchId, batchSelection);
    };

    const handleFindingClickForBatch = async (batchId: string, findingIndex: number) => {
        if (window.getSelection()?.toString().length) {
            return;
        }

        if (multiSelectMode) {
            handleMultiSelectToggleForBatch(batchId, findingIndex);
            return;
        }

        const batch = batches.find(b => b.id === batchId);
        if (!batch || !batch.findings) return;
        
        const findingToCopy = batch.findings[findingIndex];
        const isBold = findingToCopy.includes('BOLD::');
        const cleanFinding = findingToCopy.replace(/BOLD::/g, '');
        const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
        const isClinicalProfile = isClinicalProfileFinding(cleanFinding);
        const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(cleanFinding);
        const isImpression = isStructured && !isTable && title.trim().toUpperCase() === 'IMPRESSION:';
        const isItalic = !isTable && (isClinicalProfile || (!isStructured && cleanFinding.startsWith('*') && cleanFinding.endsWith('*')));
        let plainText: string;
        let htmlText: string;
        
        if (isTitle) {
          plainText = cleanFinding;
          htmlText = `<p style="text-align:center;"><strong><u>${cleanFinding}</u></strong></p>`;
        } else if (isClinicalProfile) {
          plainText = formatClinicalProfileText(cleanFinding);
          htmlText = `<p><em>${plainText}</em></p>`;
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
                plainText = cleanFinding.slice(1, -1);
                htmlText = `<p><em>${plainText}</em></p>`;
            } else {
                plainText = cleanFinding;
                htmlText = isBold ? `<p><strong>${cleanFinding}</strong></p>` : `<p>${cleanFinding}</p>`;
            }
        }

        const success = await copyToClipboard(plainText, htmlText);

        if (success) {
            setSelections({ [batchId]: new Set([findingIndex]) });
            setTimeout(() => setSelections({}), 500);
            showNotification('Copied!');
        } else {
            showNotification('Copy failed!');
        }
    };
    
    const handleSelectionHandleClickForBatch = (e: React.MouseEvent, batchId: string, findingIndex: number) => {
        e.stopPropagation();
        handleMultiSelectToggleForBatch(batchId, findingIndex);
    };


    const handleCopyAllForBatch = async (batch: Batch) => {
        if (!batch.findings || batch.findings.length === 0) return;

        const allTextPlain = batch.findings.map(f => {
            const isBold = f.includes('BOLD::');
            const cleanFinding = f.replace(/BOLD::/g, '');
            const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(cleanFinding);
            const isImpression = isStructured && !isTable && title.trim().toUpperCase() === 'IMPRESSION:';
            if (isTable) {
              return tableToPlainText(tableLines);
            }
            if (isImpression) {
                return `${title.toUpperCase()}\n${points.map(p => `• ${p}`).join('\n')}`;
            }
            if (isClinicalProfileFinding(cleanFinding)) {
                return formatClinicalProfileText(cleanFinding);
            }
            if (isStructured) {
              return [title, ...points].join('\n');
            }
            if (cleanFinding.startsWith('*') && cleanFinding.endsWith('*')) {
              return cleanFinding.slice(1, -1);
            }
            return cleanFinding;
        }).join('\n\n');

        const allTextHtml = batch.findings.map(f => {
            const isBold = f.includes('BOLD::');
            const cleanFinding = f.replace(/BOLD::/g, '');
            const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
            const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(cleanFinding);
            const isImpression = isStructured && !isTable && title.trim().toUpperCase() === 'IMPRESSION:';
            if (isTitle) {
              return `<p style="text-align:center;"><strong><u>${cleanFinding}</u></strong></p>`;
            }
            if (isTable) {
              return parseMarkdownTable(tableLines);
            }
            if (isImpression) {
                return `<p><strong style="text-decoration: underline;">${title.toUpperCase()}</strong></p><ul>${points.map(p => `<li><strong>${p}</strong></li>`).join('')}</ul>`;
            }
            if (isClinicalProfileFinding(cleanFinding)) {
                return `<p><em>${formatClinicalProfileText(cleanFinding)}</em></p>`;
            }
            if (isStructured) {
                let htmlContent = isBold ? `<p><strong>${title}</strong></p>` : `<p>${title}</p>`;
                htmlContent += points.map(p => isBold ? `<p><strong>${p}</strong></p>` : `<p>${p}</p>`).join('');
                return htmlContent;
            }
            if (cleanFinding.startsWith('*') && cleanFinding.endsWith('*')) {
                return `<p><em>${cleanFinding.slice(1, -1)}</em></p>`;
            }
            return isBold ? `<p><strong>${cleanFinding}</strong></p>` : `<p>${cleanFinding}</p>`;
        }).join('');

        const success = await copyToClipboard(allTextPlain, allTextHtml);
        if (success) {
          setAllCopiedId(batch.id);
          setTimeout(() => setAllCopiedId(null), 2000);
          const allIndices = new Set<number>();
          batch.findings.forEach((f, i) => {
            if (f && f.trim() !== '') allIndices.add(i);
          });
          setSelections(prev => ({ ...prev, [batch.id]: allIndices }));
          setMultiSelectMode(true);
          showNotification(`Copied all for ${batch.name}! Tap any finding or checkbox to deselect.`);
        } else {
          showNotification('Copy failed!');
        }
    };

    const handleCopyAllBatches = async () => {
        const batchesWithFindings = batches.filter(b => b.findings && b.findings.length > 0);
        if (batchesWithFindings.length === 0) return;

        let allTextPlain = '';
        let allTextHtml = '';

        batchesWithFindings.forEach(b => {
            const name = b.name;
            const plainFindings = b.findings!.map(f => {
                const isBold = f.includes('BOLD::');
                const cleanFinding = f.replace(/BOLD::/g, '');
                const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
                const isImpression = isStructured && title.trim().toUpperCase() === 'IMPRESSION:';
                if (isImpression) return `${title.toUpperCase()}\n${points.map(p => `• ${p}`).join('\n')}`;
                if (isClinicalProfileFinding(cleanFinding)) return formatClinicalProfileText(cleanFinding);
                if (isStructured) return [title, ...points].join('\n');
                if (cleanFinding.startsWith('*') && cleanFinding.endsWith('*')) return cleanFinding.slice(1, -1);
                return cleanFinding;
            }).join('\n');
            const htmlFindings = b.findings!.map(f => {
                const isBold = f.includes('BOLD::');
                const cleanFinding = f.replace(/BOLD::/g, '');
                const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
                const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
                const isImpression = isStructured && title.trim().toUpperCase() === 'IMPRESSION:';
                if (isTitle) return `<p style="text-align:center;"><strong><u>${cleanFinding}</u></strong></p>`;
                if (isImpression) return `<p><strong style="text-decoration: underline;">${title.toUpperCase()}</strong></p><ul>${points.map(p => `<li><strong>${p}</strong></li>`).join('')}</ul>`;
                if (isClinicalProfileFinding(cleanFinding)) return `<p><em>${formatClinicalProfileText(cleanFinding)}</em></p>`;
                if (isStructured) {
                  let htmlContent = isBold ? `<p><strong>${title}</strong></p>` : `<p>${title}</p>`;
                  htmlContent += points.map(p => isBold ? `<p><strong>${p}</strong></p>` : `<p>${p}</p>`).join('');
                  return htmlContent;
                }
                if (cleanFinding.startsWith('*') && cleanFinding.endsWith('*')) return `<p><em>${cleanFinding.slice(1, -1)}</em></p>`;
                return isBold ? `<p><strong>${cleanFinding}</strong></p>` : `<p>${cleanFinding}</p>`;
            }).join('');
            
            allTextPlain += `[${name}]\n${plainFindings}\n\n`;
            allTextHtml += `<h3>${name}</h3>` + htmlFindings;
        });

        const success = await copyToClipboard(allTextPlain.trim(), allTextHtml.trim());
        if (success) {
          setIsAllBatchesCopied(true);
          setTimeout(() => setIsAllBatchesCopied(false), 2000);
        }
    };


    const handleDownload = async (batch: Batch) => {
        if (!batch.audioBlobs.length) return;
        try {
            const mergedBlob = await mergeMultipleAudioBlobs(batch.audioBlobs);
            triggerAudioDownload(mergedBlob, batch.name.replace(/\s+/g, '_'));
        } catch (err) {
            console.error('Failed to download audio:', err);
        }
    };

    const handleDownloadHTML = () => {
        const batchesWithFindings = batches.filter(b => b.findings && b.findings.length > 0);
        if (batchesWithFindings.length === 0) {
            showNotification("No processed transcripts to download.");
            return;
        };

        try {
            const htmlContent = generateBatchDictationHTML(batchesWithFindings);
            downloadFile(htmlContent, 'batch-radiology-report.html', 'text/html;charset=utf-8');
        } catch (err) {
            console.error('Failed to generate or download batch HTML:', err);
            showNotification("Failed to create HTML file.");
        }
    };

    // --- Batch Edit Mode Handlers ---
    const handleStartEdit = (batchId: string, index: number) => {
        clearUndoStateForBatch(batchId);
        const batch = batches.find(b => b.id === batchId);
        if (!batch || !batch.findings) return;
        
        setEditingState({ batchId, index });
        
        const findingToEdit = batch.findings[index];
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
        setDictatingState(null);
        setDictateEditingState(null);
        setProcessingState(null);
        setContinuationError(null);
    };

    const handleCancelEdit = () => {
        setEditingState(null);
        setEditingText('');
    };

    const handleDeleteFindingForBatch = (batchId: string, indexToDelete: number) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch || !batch.findings) return;
        setUndoStates(prev => ({ ...prev, [batchId]: [...batch.findings!] }));
        const updatedFindings = batch.findings.filter((_, i) => i !== indexToDelete);
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, findings: updatedFindings } : b));
        if (editingState && editingState.batchId === batchId && editingState.index === indexToDelete) {
            handleCancelEdit();
        }
        setSelections(prev => {
            const current = prev[batchId];
            if (!current) return prev;
            const next = new Set<number>();
            for (const idx of current) {
                if (idx < indexToDelete) next.add(idx);
                else if (idx > indexToDelete) next.add(idx - 1);
            }
            if (next.size > 0 && multiSelectMode) {
                copyBatchSelection(batchId, next);
            }
            return { ...prev, [batchId]: next };
        });
    };

    const handleSaveEdit = () => {
        if (editingState) {
            const currentEditingState = editingState;
            const batch = batches.find(b => b.id === currentEditingState.batchId);
            if (batch && batch.findings) {
                setUndoStates(prev => ({ ...prev, [currentEditingState.batchId]: [...batch.findings!] }));
                const originalFinding = batch.findings[currentEditingState.index];
                const isBold = originalFinding.startsWith('BOLD::');
                const { isStructured } = parseStructuredFinding(originalFinding);

                let newText = editingText;
                if (isStructured) {
                    newText = editingText.split('\n').filter(line => line.trim() !== '').join('###');
                } else if (isClinicalProfileFinding(editingText)) {
                    newText = formatClinicalProfileText(editingText);
                }
                
                if (isBold && !newText.startsWith('BOLD::') && !isClinicalProfileFinding(newText)) {
                  newText = `BOLD::${newText}`;
                }

                handleUpdateFindingForBatch(currentEditingState.batchId, currentEditingState.index, newText);
            }
        }
        setEditingState(null);
        setEditingText('');
    };

    const handleStartDictation = async (batchId: string, index: number) => {
        clearUndoStateForBatch(batchId);
        setEditingState(null);
        setProcessingState(null);
        setContinuationError(null);
        setDictateEditingState(null);
        setDictatingState({ batchId, index });
        await startContinuationRecording();
    };

    const handleStopDictation = async () => {
        if (!dictatingState) return;

        const audioBlob = await stopContinuationRecording();
        const { batchId, index } = dictatingState;
        setDictatingState(null);

        const batch = batches.find(b => b.id === batchId);
        if (batch && batch.findings && audioBlob && audioBlob.size > 0) {
            setUndoStates(prev => ({ ...prev, [batchId]: [...batch.findings!] }));
            setProcessingState({ batchId, index });
            try {
                const existingText = batch.findings[index];
                const newText = await continueAudioDictation(existingText, audioBlob, batch.customPrompt, batch.selectedModel);
                const separator = existingText.trim().length > 0 && !existingText.endsWith(' ') ? ' ' : '';
                const updatedText = existingText + separator + newText.trim();
                handleUpdateFindingForBatch(batchId, index, updatedText);
            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred.';
                setContinuationError({ batchId, index, message });
            } finally {
                setProcessingState(null);
            }
        }
    };
    
    const handleStartDictateEditForBatch = async (batchId: string, index: number) => {
        clearUndoStateForBatch(batchId);
        setEditingState(null);
        setProcessingState(null);
        setContinuationError(null);
        setDictatingState(null);
        try {
            await modifyRecorder.startRecording();
            setDictateEditingState({ batchId, index });
        } catch (err) {
            console.warn("Failed to start dictate edit:", err);
            setDictateEditingState(null);
        }
    };

    const handleStopDictateEditForBatch = async () => {
        if (!dictateEditingState) return;

        const audioBlob = await modifyRecorder.stopRecording();
        const { batchId, index } = dictateEditingState;
        setDictateEditingState(null);

        const batch = batches.find(b => b.id === batchId);
        if (batch && batch.findings && audioBlob && audioBlob.size > 0) {
            setUndoStates(prev => ({ ...prev, [batchId]: [...batch.findings!] }));
            setProcessingState({ batchId, index });
            try {
                const existingText = batch.findings[index];
                const newText = await modifyFindingWithAudio(existingText, audioBlob, batch.customPrompt, batch.selectedModel);
                handleUpdateFindingForBatch(batchId, index, newText);
            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred.';
                setContinuationError({ batchId, index, message });
            } finally {
                setProcessingState(null);
            }
        }
    };
    
    const handleCopyFromCopier = async (text: string) => {
      const success = await copyToClipboard(text, `<strong>${text}</strong>`);
      showNotification(success ? 'Copied selection!' : 'Copy failed!');
      setCopier(null);
    };

    const handleStartContinue = async (batchId: string) => {
        clearUndoStateForBatch(batchId);
        try {
            await startBatchContinuation();
            setContinuationState({ batchId, status: 'recording', error: null });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to start recording.';
            setContinuationState({ batchId, status: 'idle', error: message });
        }
    };

    const handleStopContinue = async () => {
        if (!continuationState.batchId) return;

        const newAudioBlob = await stopBatchContinuation();
        const batchId = continuationState.batchId;

        if (newAudioBlob && newAudioBlob.size > 0) {
            setContinuationState({ batchId, status: 'processing', error: null });
            
            const batch = batches.find(b => b.id === batchId);
            if (!batch || !batch.findings) {
                 setContinuationState({ batchId, status: 'idle', error: "Original batch not found." });
                 return;
            }
            setUndoStates(prev => ({ ...prev, [batchId]: [...batch.findings!] }));

            try {
                const newFindings = await processAudio(newAudioBlob, batch.selectedModel, batch.customPrompt, batch.customImages);
                const updatedFindings = [...batch.findings, ...newFindings];
                
                const updatedAudioBlobs = [...batch.audioBlobs, newAudioBlob];
                const mergedBlob = await mergeMultipleAudioBlobs(updatedAudioBlobs);

                const chatSession = await createChat(mergedBlob, updatedFindings, batch.customPrompt, batch.customImages);
                const aiGreeting = "I have updated the transcript with your new dictation. How can I help you further?";
                const updatedChatHistory = [{ author: 'AI' as const, text: `${updatedFindings.join('\n\n')}\n\n${aiGreeting}` }];

                setBatches(prev => {
                    const updated = prev.map(b => b.id === batchId ? { 
                        ...b,
                        findings: updatedFindings,
                        audioBlobs: updatedAudioBlobs,
                        chat: chatSession,
                        chatHistory: updatedChatHistory,
                    } : b);
                    saveBatchesToDrive(updated);
                    return updated;
                });

                setContinuationState({ batchId: null, status: 'idle', error: null });

            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred.';
                setContinuationState({ batchId, status: 'idle', error: message });
            }
        } else {
            setContinuationState({ batchId: null, status: 'idle', error: null });
        }
    };

    const handleStartModification = async (batchId: string) => {
        clearUndoStateForBatch(batchId);
        setModificationError({ batchId: null, message: null });
        try {
            await modificationRecorder.startRecording();
            setModificationState({ batchId, status: 'recording' });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to start modification recording.';
            setModificationError({ batchId, message });
            setModificationState({ batchId: null, status: 'idle' });
        }
    };
    
    const handleStopModification = async () => {
        const batchId = modificationState.batchId;
        if (!batchId) return;
    
        const audioBlob = await modificationRecorder.stopRecording();
        
        if (audioBlob && audioBlob.size > 0) {
            setModificationState({ batchId, status: 'processing' });
            
            const batchToModify = batches.find(b => b.id === batchId);
            if (!batchToModify || !batchToModify.findings) {
                 setModificationError({ batchId, message: "Could not find the batch to modify." });
                 setModificationState({ batchId: null, status: 'idle' });
                 return;
            }
            setUndoStates(prev => ({ ...prev, [batchId]: [...batchToModify.findings!] }));
    
            try {
                const newFindings = await modifyReportWithAudio(batchToModify.findings, audioBlob, batchToModify.selectedModel, batchToModify.customPrompt, batchToModify.customImages);
                
                const mergedBlob = await mergeMultipleAudioBlobs(batchToModify.audioBlobs);
                const chatSession = await createChat(mergedBlob, newFindings, batchToModify.customPrompt, batchToModify.customImages, batchToModify.selectedModel);
                const aiGreeting = "I have updated the transcript with your new dictation. How can I help you further?";
                const updatedChatHistory = [{ author: 'AI' as const, text: `${newFindings.join('\n\n')}\n\n${aiGreeting}` }];
    
                setBatches(prev => prev.map(b => b.id === batchId ? { 
                    ...b, 
                    findings: newFindings,
                    chat: chatSession,
                    chatHistory: updatedChatHistory,
                    isChatting: false,
                 } : b));
                setModificationState({ batchId: null, status: 'idle' });
            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred.';
                setModificationError({ batchId, message });
                setModificationState({ batchId: null, status: 'idle' });
            }
        } else {
            setModificationState({ batchId: null, status: 'idle' });
        }
    };

    // --- Complex Impression Handlers for Batches ---
    const handleComplexMicClick = async (batchId: string) => {
        setAgenticErrors(prev => ({ ...prev, [batchId]: null }));
        if (complexInputRecorder.isRecording) {
            setIsTranscribingComplex(prev => ({ ...prev, [batchId]: true }));
            try {
                const audioBlob = await complexInputRecorder.stopRecording();
                if (audioBlob && audioBlob.size > 0) {
                    const currentBatch = batches.find(b => b.id === batchId);
                    const modelToUse = currentBatch?.selectedModel || selectedModel;
                    const transcript = await transcribeAudioForPrompt(audioBlob, modelToUse);
                    setComplexInputs(prev => ({ ...prev, [batchId]: prev[batchId] ? `${prev[batchId]} ${transcript}` : transcript }));
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : 'An unknown error occurred during transcription.';
                setAgenticErrors(prev => ({ ...prev, [batchId]: message }));
            } finally {
                setIsTranscribingComplex(prev => ({ ...prev, [batchId]: false }));
            }
        } else {
            try {
                await complexInputRecorder.startRecording();
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to access microphone.';
                setAgenticErrors(prev => ({ ...prev, [batchId]: message }));
            }
        }
    };

    const handleGenerateComplexImpression = async (batchId: string) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch || !batch.findings) return;

        setAgenticStates(prev => ({ ...prev, [batchId]: 'processing' }));
        setAgenticErrors(prev => ({ ...prev, [batchId]: null }));
        setAgenticProgressTexts(prev => ({ ...prev, [batchId]: 'Starting complex impression workflow...' }));
        setExpertNotesForBatches(prev => ({ ...prev, [batchId]: null }));

        try {
            setUndoStates(prev => ({ ...prev, [batchId]: batch.findings! }));
            const complexInput = complexInputs[batchId] || '';
            const result = await runComplexImpressionGeneration(
                batch.findings, 
                complexInput,
                (statusText) => setAgenticProgressTexts(prev => ({ ...prev, [batchId]: statusText }))
            );
            
            setBatches(prevBatches => prevBatches.map(b => b.id === batchId ? { ...b, findings: result.findings } : b));
            setExpertNotesForBatches(prev => ({ ...prev, [batchId]: result.expertNotes }));
            
            setComplexGeneratorVisibleForBatchId(null);
            setComplexInputs(prev => ({ ...prev, [batchId]: '' }));
            setAgenticStates(prev => ({ ...prev, [batchId]: 'idle' }));
            setAgenticProgressTexts(prev => ({ ...prev, [batchId]: '' }));
        } catch (err) {
            const message = err instanceof Error ? err.message : 'An unknown error occurred.';
            setAgenticErrors(prev => ({ ...prev, [batchId]: `Failed to generate impression: ${message}` }));
            setAgenticStates(prev => ({ ...prev, [batchId]: 'error' }));
            setAgenticProgressTexts(prev => ({ ...prev, [batchId]: '' }));
        }
    };

    const handleDownloadExpertNotes = async (batchId: string) => {
        const expertNotes = expertNotesForBatches[batchId];
        if (!expertNotes) return;
        try {
            const docxBlob = await generateDocxFromMarkdown(expertNotes, `Expert Notes - Batch ${batchId}`);
            downloadFile(
                docxBlob,
                `expert-notes-${batchId}.docx`,
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            );
        } catch (err) {
            console.error('Failed to generate authentic docx notes:', err);
            showNotification("Failed to create Word document.");
        }
    };

    // --- Drag and Drop Handlers for Findings ---
    const handleToggleReorderMode = (batchId: string) => {
        clearUndoStateForBatch(batchId);
        setClickMergeBatchState(null);
        setDragOverState(null);
        setDraggedState(null);
        dragItem.current = null;
        dragOverItem.current = null;
        setReorderBatchId(prev => (prev === batchId ? null : batchId));
        setMergeBatchId(null);
    };
    const handleToggleMergeMode = (batchId: string) => {
        clearUndoStateForBatch(batchId);
        setClickMergeBatchState(null);
        setDragOverState(null);
        setDraggedState(null);
        dragItem.current = null;
        dragOverItem.current = null;
        setMergeBatchId(prev => (prev === batchId ? null : batchId));
        setReorderBatchId(null);
    };

    // Reorder Handlers for Findings in Batch
    const handleReorderDragStart = (e: React.DragEvent | undefined, batchId: string, index: number) => {
        dragItem.current = { batchId, index };
        setDraggedState({ batchId, index });
        if (e) {
            e.stopPropagation();
            if (e.dataTransfer) {
                try {
                    e.dataTransfer.setData("text/plain", JSON.stringify({ batchId, index }));
                    e.dataTransfer.effectAllowed = "move";
                } catch (_) {}
            }
        }
    };

    const handleReorderDrop = (e: React.DragEvent, targetBatchId: string, targetIndex: number) => {
        e.preventDefault();
        e.stopPropagation();
        if (dragItem.current && dragItem.current.batchId === targetBatchId) {
            dragOverItem.current = { batchId: targetBatchId, index: targetIndex };
        } else {
            try {
                const text = e.dataTransfer.getData("text/plain");
                if (text) {
                    const parsed = JSON.parse(text);
                    if (parsed && parsed.batchId === targetBatchId && typeof parsed.index === 'number') {
                        dragItem.current = { batchId: targetBatchId, index: parsed.index };
                        dragOverItem.current = { batchId: targetBatchId, index: targetIndex };
                    }
                }
            } catch (_) {}
        }
        handleReorderDragEnd();
    };

    const handleReorderDragEnd = (e?: React.DragEvent) => {
        if (e) {
            e.stopPropagation();
        }
        if (dragItem.current && dragOverItem.current && dragItem.current.batchId === dragOverItem.current.batchId && dragItem.current.index !== dragOverItem.current.index) {
            const { batchId, index: dragIndex } = dragItem.current;
            const { index: dragOverIndex } = dragOverItem.current;
            
            const batch = batches.find(b => b.id === batchId);
            if (batch && batch.findings) {
                setUndoStates(prev => ({ ...prev, [batchId]: [...batch.findings!] }));
            }

            setBatches(prevBatches => {
                return prevBatches.map(b => {
                    if (b.id !== batchId || !b.findings) return b;
                    const newFindings = [...b.findings];
                    const [draggedItemContent] = newFindings.splice(dragIndex, 1);
                    newFindings.splice(dragOverIndex, 0, draggedItemContent);
                    return { ...b, findings: newFindings };
                });
            });
        }
        dragItem.current = null;
        dragOverItem.current = null;
        setDraggedState(null);
    };

    const handleMoveFinding = (batchId: string, index: number, direction: 'up' | 'down') => {
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        const batch = batches.find(b => b.id === batchId);
        if (!batch || !batch.findings || targetIndex < 0 || targetIndex >= batch.findings.length) return;

        setUndoStates(prev => ({ ...prev, [batchId]: [...batch.findings!] }));

        setBatches(prev => prev.map(b => {
            if (b.id !== batchId || !b.findings) return b;
            const newFindings = [...b.findings];
            const [item] = newFindings.splice(index, 1);
            newFindings.splice(targetIndex, 0, item);
            return { ...b, findings: newFindings };
        }));
    };

    // Touch Drag Support for Mobile & Tablets in Batch Findings
    const handleRowTouchStart = (e: React.TouchEvent, batchId: string, index: number) => {
        if (reorderBatchId !== batchId && mergeBatchId !== batchId) return;
        const touch = e.touches[0];
        touchDragRef.current = {
            batchId,
            sourceIndex: index,
            startX: touch.clientX,
            startY: touch.clientY,
            isDragging: false,
        };
    };

    const handleRowTouchMove = (e: React.TouchEvent, batchId: string) => {
        if (reorderBatchId !== batchId && mergeBatchId !== batchId) return;
        if (!touchDragRef.current || touchDragRef.current.batchId !== batchId) return;
        const touch = e.touches[0];
        const deltaX = Math.abs(touch.clientX - touchDragRef.current.startX);
        const deltaY = Math.abs(touch.clientY - touchDragRef.current.startY);

        if (!touchDragRef.current.isDragging && (deltaX > 6 || deltaY > 6)) {
            touchDragRef.current.isDragging = true;
            const src = touchDragRef.current.sourceIndex;
            dragItem.current = { batchId, index: src };
            setDraggedState({ batchId, index: src });
        }

        if (touchDragRef.current.isDragging) {
            if (e.cancelable) {
                e.preventDefault();
            }
            const el = document.elementFromPoint(touch.clientX, touch.clientY);
            const targetItem = el?.closest(`.finding-item[data-batch-id="${batchId}"]`);
            if (targetItem) {
                const targetIdxStr = targetItem.getAttribute('data-finding-index');
                if (targetIdxStr !== null) {
                    const targetIdx = parseInt(targetIdxStr, 10);
                    if (!isNaN(targetIdx)) {
                        if (reorderBatchId === batchId) {
                            dragOverItem.current = { batchId, index: targetIdx };
                        } else if (mergeBatchId === batchId) {
                            setDragOverState({ batchId, index: targetIdx });
                        }
                    }
                }
            }
        }
    };

    const handleRowTouchEnd = (batchId: string) => {
        if (reorderBatchId !== batchId && mergeBatchId !== batchId) return;
        const state = touchDragRef.current;
        touchDragRef.current = null;
        if (!state || state.batchId !== batchId) return;

        if (state.isDragging) {
            if (reorderBatchId === batchId) {
                handleReorderDragEnd();
            } else if (mergeBatchId === batchId) {
                if (dragOverState && dragOverState.batchId === batchId && state.sourceIndex !== dragOverState.index) {
                    executeBatchMerge(batchId, state.sourceIndex, dragOverState.index);
                } else {
                    setDraggedState(null);
                    setDragOverState(null);
                    dragItem.current = null;
                }
            }
        } else {
            // Tap without dragging in mergeMode: tap-to-merge
            if (mergeBatchId === batchId) {
                handleMergeItemClickForBatch(batchId, state.sourceIndex);
            }
        }
    };

    // Safely execute batch merge
    const executeBatchMerge = (batchId: string, sourceIndex: number, targetIndex: number) => {
        if (
            typeof sourceIndex !== 'number' ||
            typeof targetIndex !== 'number' ||
            isNaN(sourceIndex) ||
            isNaN(targetIndex) ||
            sourceIndex === targetIndex
        ) {
            setDragOverState(null);
            setDraggedState(null);
            setClickMergeBatchState(null);
            return;
        }

        const batch = batches.find(b => b.id === batchId);
        if (!batch || !batch.findings) {
            setDragOverState(null);
            setDraggedState(null);
            setClickMergeBatchState(null);
            return;
        }

        if (sourceIndex < 0 || sourceIndex >= batch.findings.length || targetIndex < 0 || targetIndex >= batch.findings.length) {
            setDragOverState(null);
            setDraggedState(null);
            setClickMergeBatchState(null);
            return;
        }

        const sourceFinding = batch.findings[sourceIndex];
        const targetFinding = batch.findings[targetIndex];

        if (sourceFinding === undefined || targetFinding === undefined || typeof sourceFinding !== 'string' || typeof targetFinding !== 'string') {
            setDragOverState(null);
            setDraggedState(null);
            setClickMergeBatchState(null);
            return;
        }

        // Store pre-merge state for undo
        setUndoStates(prev => ({ ...prev, [batchId]: [...batch.findings!] }));

        const mergedText = `${targetFinding.trim()} ${sourceFinding.trim()}`.trim();

        const newFindings = batch.findings
            .map((finding, index) => index === targetIndex ? mergedText : finding)
            .filter((_, index) => index !== sourceIndex);

        setBatches(prev => prev.map(b => 
            b.id === batchId ? { ...b, findings: newFindings } : b
        ));

        setDragOverState(null);
        setDraggedState(null);
        setClickMergeBatchState(null);
    };

    // Merge Drag Handlers
    const handleMergeDragStart = (e: React.DragEvent | undefined, batchId: string, index: number) => {
        dragItem.current = { batchId, index };
        setDraggedState({ batchId, index });
        if (e && e.dataTransfer) {
            try {
                e.dataTransfer.setData("text/plain", JSON.stringify({ batchId, index }));
                e.dataTransfer.setData("sourceInfo", JSON.stringify({ batchId, index }));
                e.dataTransfer.effectAllowed = "copyMove";
            } catch {
                // Ignore dataTransfer errors in sandboxed environments
            }
        }
    };

    const handleMergeDrop = (e: React.DragEvent, targetBatchId: string, targetIndex: number) => {
        e.preventDefault();
        let sourceBatchId: string | null = null;
        let sourceIndex: number | null = null;

        // In-memory ref first (immune to iframe / browser dataTransfer stripping)
        if (dragItem.current && dragItem.current.batchId === targetBatchId && typeof dragItem.current.index === 'number') {
            sourceBatchId = dragItem.current.batchId;
            sourceIndex = dragItem.current.index;
        } else if (draggedState && draggedState.batchId === targetBatchId && typeof draggedState.index === 'number') {
            sourceBatchId = draggedState.batchId;
            sourceIndex = draggedState.index;
        } else {
            try {
                const sourceInfoStr = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("sourceInfo");
                if (sourceInfoStr) {
                    const parsed = JSON.parse(sourceInfoStr);
                    if (parsed && parsed.batchId === targetBatchId && typeof parsed.index === 'number') {
                        sourceBatchId = parsed.batchId;
                        sourceIndex = parsed.index;
                    }
                }
            } catch {
                // Ignore parse errors
            }
        }

        if (sourceBatchId && typeof sourceIndex === 'number' && !isNaN(sourceIndex)) {
            executeBatchMerge(targetBatchId, sourceIndex, targetIndex);
        }

        dragItem.current = null;
        setDragOverState(null);
        setDraggedState(null);
        setClickMergeBatchState(null);
    };

    const handleMergeItemClickForBatch = (batchId: string, index: number) => {
        if (!clickMergeBatchState || clickMergeBatchState.batchId !== batchId) {
            setClickMergeBatchState({ batchId, index });
        } else if (clickMergeBatchState.index === index) {
            // Clicking same item deselects
            setClickMergeBatchState(null);
        } else {
            // Merge selected item into target item
            executeBatchMerge(batchId, clickMergeBatchState.index, index);
        }
    };

    const handleUndo = (batchId: string) => {
        const findingsToRestore = undoStates[batchId];
        if (findingsToRestore) {
            setBatches(prev => prev.map(b => 
                b.id === batchId ? { ...b, findings: findingsToRestore } : b
            ));
            clearUndoStateForBatch(batchId);
        }
    };
    
    // --- Drag and Drop Handlers for Batches ---
    const handleBatchDragStart = (e: React.DragEvent, index: number) => {
        batchDragItem.current = index;
        if (e && e.dataTransfer) {
            try {
                e.dataTransfer.setData("text/plain", `batch-${index}`);
                e.dataTransfer.effectAllowed = "move";
            } catch (_) {}
        }
    };

    const handleBatchDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "move";
        }
    };

    const handleBatchDrop = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        let sourceIndex = batchDragItem.current;
        if (sourceIndex === null) {
            try {
                const text = e.dataTransfer.getData("text/plain");
                if (text && text.startsWith("batch-")) {
                    const parsed = parseInt(text.replace("batch-", ""), 10);
                    if (!isNaN(parsed)) sourceIndex = parsed;
                }
            } catch (_) {}
        }
        if (sourceIndex !== null && sourceIndex !== index) {
            setBatches(prev => {
                const newBatches = [...prev];
                const [draggedItem] = newBatches.splice(sourceIndex!, 1);
                newBatches.splice(index, 0, draggedItem);
                return newBatches;
            });
        }
        batchDragItem.current = null;
        setDragOverBatchIndex(null);
    };

    const handleBatchDragEnd = () => {
        batchDragItem.current = null;
        setDragOverBatchIndex(null);
    };

    const handleMoveBatch = (index: number, direction: 'up' | 'down') => {
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= batches.length) return;

        setBatches(prev => {
            const newBatches = [...prev];
            const [item] = newBatches.splice(index, 1);
            newBatches.splice(targetIndex, 0, item);
            return newBatches;
        });
    };

    const ErrorLegend = () => (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400 my-4 p-2 rounded-md bg-slate-100 dark:bg-slate-700/50">
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

    const allProcessed = batches.every(b => b.status !== 'processing');
    const hasProcessableRecordings = batches.some(b => (b.status === 'complete' || b.status === 'paused') && b.audioBlobs.length > 0 && !b.findings);
    const hasAnyResults = batches.some(b => b.findings);
    const hasAnyErrors = batches.some(b => b.identifiedErrors && b.identifiedErrors.length > 0);

    return (
        <div>
            <TemplateSelectionModal
                isOpen={templateModalBatchId !== null}
                onClose={() => setTemplateModalBatchId(null)}
                templates={REPORT_TEMPLATES}
                onSelectTemplate={handleSelectBatchTemplateToMerge}
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
            <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" accept="audio/*,video/*,image/*,.pdf,.doc,.docx,.txt,.csv,.rtf,.webm,.mp4,.mp3,.wav,.m4a,.png,.jpg,.jpeg" multiple aria-hidden="true" />

            {/* General Drag and Drop Dropzone for New Batches */}
            <div 
                className={`relative border-2 border-dashed rounded-xl p-6 mb-6 text-center transition-all duration-200 cursor-pointer ${
                    isGeneralDragging 
                        ? 'border-blue-500 bg-blue-50/80 dark:bg-blue-900/40 shadow-lg scale-[1.01]' 
                        : 'border-slate-300 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 bg-slate-50/50 dark:bg-slate-800/30'
                }`}
                onDragEnter={handleGeneralDragEnter}
                onDragLeave={handleGeneralDragLeave}
                onDragOver={handleGeneralDragOver}
                onDrop={handleGeneralDrop}
                onClick={() => triggerUpload(null)}
            >
                {isGeneralDragging ? (
                    <div className="flex flex-col items-center justify-center py-2">
                        <UploadIcon className="w-12 h-12 text-blue-600 dark:text-blue-400 animate-bounce mb-2" />
                        <p className="text-lg font-bold text-blue-700 dark:text-blue-300">
                            Drop Files Here
                        </p>
                        <p className="text-xs text-slate-600 dark:text-slate-300">
                            Automatically creates a new batch for each file (Audio, PDF, Images, DOCX, Video, etc.)
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center gap-2">
                        <div className="p-3 bg-blue-100 dark:bg-blue-900/40 rounded-full text-blue-600 dark:text-blue-400">
                            <UploadIcon className="w-6 h-6" />
                        </div>
                        <div>
                            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                                Drag & drop file(s) (Audio, PDF, Images, DOCX, Video) here to add as new batches
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                Or <span className="text-blue-600 dark:text-blue-400 underline font-medium">browse files</span> from your device
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
                            <span className="text-xs text-slate-400 dark:text-slate-500">or</span>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setPasteModalTargetBatchId(null);
                                    setClipboardPastedText('');
                                    setIsPasteModalOpen(true);
                                }}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-100 hover:bg-blue-200 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-900/80 font-bold text-xs transition-colors shadow-2xs"
                                title="Paste any number of texts to generate batches (or press Ctrl+V)"
                            >
                                <ClipboardPaste className="w-3.5 h-3.5" />
                                <span>Paste Text(s) as Batches</span>
                            </button>
                        </div>
                    </div>
                )}
            </div>
            
            {unsavedSession && (
                <div className="w-full my-4 p-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700/60 shadow-sm flex flex-col gap-3">
                    <div className="flex items-center gap-3 text-amber-800 dark:text-amber-200">
                        <WarningIcon className="w-6 h-6 shrink-0 text-amber-600 dark:text-amber-400" />
                        <div>
                            <p className="font-semibold text-sm sm:text-base">
                                Interrupted Audio Recording Detected
                            </p>
                            <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
                                Found un-saved audio recorded at {new Date(unsavedSession.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ({ (unsavedSession.totalBytes / 1024).toFixed(1) } KB). You can restore it as a new batch dictation.
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
                            onClick={handleDownloadRecoveredBatch}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs sm:text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-200/60 dark:bg-amber-800/60 hover:bg-amber-200 rounded-lg transition-colors"
                        >
                            <DownloadIcon className="w-4 h-4" />
                            Save File
                        </button>
                        <button
                            onClick={handleRecoverBatch}
                            className="px-4 py-1.5 text-xs sm:text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500 rounded-lg shadow transition-colors"
                        >
                            Restore into New Batch
                        </button>
                    </div>
                </div>
            )}
            
            <div className="my-4 p-4 border rounded-lg bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700">
                <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-2">Global Instructions</h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
                    These instructions will be applied by default to all new dictation batches you add. You can override them for individual batches later.
                </p>
                <CustomPromptInput
                    prompt={globalCustomPrompt}
                    onPromptChange={setGlobalCustomPrompt}
                    images={globalCustomImages}
                    onImagesChange={setGlobalCustomImages}
                    selectedModel={selectedModel}
                />
            </div>

            <div className="space-y-4">
                {batches.map((batch, index) => (
                        <div 
                            key={batch.id} 
                            id={`batch-card-${batch.id}`}
                            draggable={isBatchReorderMode}
                            onDragStart={e => handleBatchDragStart(e, index)}
                            onDragOver={e => {
                                if (e.dataTransfer.types.includes("Files")) {
                                    handleCardDragOver(e, batch.id);
                                } else if (isBatchReorderMode) {
                                    handleBatchDragOver(e);
                                }
                            }}
                            onDrop={e => {
                                if (e.dataTransfer.types.includes("Files")) {
                                    handleCardDrop(e, batch.id);
                                } else if (isBatchReorderMode) {
                                    handleBatchDrop(e, index);
                                }
                            }}
                            onDragEnd={handleBatchDragEnd}
                            onDragEnter={e => {
                                if (!e.dataTransfer.types.includes("Files") && isBatchReorderMode && batchDragItem.current !== index) {
                                    setDragOverBatchIndex(index);
                                }
                            }}
                            onDragLeave={e => {
                                if (e.dataTransfer.types.includes("Files")) {
                                    handleCardDragLeave(e);
                                } else if (isBatchReorderMode) {
                                    setDragOverBatchIndex(null);
                                }
                            }}
                            className={`relative border rounded-lg bg-slate-50 dark:bg-slate-800/50 transition-all duration-200 
                                ${isBatchReorderMode 
                                    ? 'flex items-center gap-4 p-2 pl-3 cursor-grab shadow-md active:cursor-grabbing' 
                                    : 'flex flex-col gap-3 p-4'}
                                ${dragOverBatchIndex === index || dragOverCardId === batch.id ? 'border-blue-500 border-2 border-dashed bg-blue-50/50 dark:bg-blue-900/30' : 'border-slate-200 dark:border-slate-700'}
                            `}
                        >
                            {dragOverCardId === batch.id && (
                                <div className="absolute inset-0 z-10 bg-blue-500/10 dark:bg-blue-500/20 rounded-lg flex items-center justify-center backdrop-blur-[1px] border-2 border-dashed border-blue-500 pointer-events-none">
                                    <span className="text-sm font-bold text-blue-700 dark:text-blue-300 bg-white/90 dark:bg-slate-800/90 px-3 py-1 rounded-full shadow">
                                        Drop audio to attach to {batch.name}
                                    </span>
                                </div>
                            )}
                            {isBatchReorderMode ? (
                                <>
                                    <ReorderIcon className="w-6 h-6 text-slate-400 flex-shrink-0" aria-label="Drag to reorder batch" />
                                    <div className="flex items-center gap-2 w-full flex-grow">
                                        <input
                                            type="text"
                                            value={batch.name}
                                            onChange={(e) => updateBatchName(batch.id, e.target.value)}
                                            className="font-semibold p-2 border border-slate-300 rounded w-full bg-white text-black disabled:bg-slate-100 disabled:cursor-not-allowed dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 dark:disabled:bg-slate-800"
                                            aria-label={`Batch name for ${batch.name}`}
                                            disabled={true}
                                        />
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                                        <button
                                            type="button"
                                            disabled={index === 0}
                                            onClick={() => handleMoveBatch(index, 'up')}
                                            className="p-1.5 rounded-lg bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 hover:bg-blue-50 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed shadow-xs transition-colors"
                                            title="Move batch up"
                                            aria-label="Move batch up"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 15l7-7 7 7" /></svg>
                                        </button>
                                        <button
                                            type="button"
                                            disabled={index === batches.length - 1}
                                            onClick={() => handleMoveBatch(index, 'down')}
                                            className="p-1.5 rounded-lg bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 hover:bg-blue-50 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed shadow-xs transition-colors"
                                            title="Move batch down"
                                            aria-label="Move batch down"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" /></svg>
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div className="w-full flex flex-col gap-3">
                                    <div className="w-full flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                        <div className="flex items-center gap-2 flex-grow w-full sm:max-w-md">
                                            <input
                                                type="text"
                                                value={batch.name}
                                                onChange={(e) => updateBatchName(batch.id, e.target.value)}
                                                className="font-semibold p-2 border border-slate-300 rounded w-full bg-white text-black disabled:bg-slate-100 disabled:cursor-not-allowed dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 dark:disabled:bg-slate-800"
                                                aria-label={`Batch name for ${batch.name}`}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setExpandedBatchPromptIds(prev => ({ ...prev, [batch.id]: !prev[batch.id] }))}
                                                className={`p-2 rounded-lg border transition-all flex items-center gap-1.5 text-xs font-bold whitespace-nowrap ${
                                                    expandedBatchPromptIds[batch.id]
                                                        ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800/60'
                                                        : 'bg-white text-slate-600 border-slate-200 hover:text-blue-600 hover:border-blue-300 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-600'
                                                }`}
                                                title="Set specific custom instruction / template for this batch"
                                            >
                                                <SparklesIcon className="w-4 h-4 text-yellow-500" />
                                                <span>Template</span>
                                            </button>
                                            <button
                                                onClick={() => removeBatch(batch.id)}
                                                className="p-2 text-slate-500 hover:text-red-600 rounded-lg hover:bg-red-100 dark:text-slate-400 dark:hover:text-red-400 dark:hover:bg-red-900/50 transition-colors flex-shrink-0"
                                                aria-label={`Remove batch ${batch.name}`}
                                            >
                                                <TrashIcon className="w-5 h-5" />
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-start sm:justify-end gap-2 flex-wrap w-full sm:w-auto">
                                            {(batch.status === 'idle' || batch.status === 'paused' || batch.status === 'complete' || batch.status === 'error') && batch.findings === null && (
                                                <>
                                                    {batch.audioBlobs.length === 0 ? (
                                                        <>
                                                            <button onClick={() => handleRecordOrResume(batch)} className="flex items-center gap-2 bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 transition-colors text-sm px-3 disabled:bg-blue-300 disabled:cursor-wait" disabled={isBusy && activeBatchId !== batch.id}>
                                                                <MicIcon className="w-4 h-4"/> Record
                                                            </button>
                                                            <button onClick={() => triggerUpload(batch.id)} className="flex items-center gap-2 bg-slate-200 text-slate-700 p-2 rounded-lg hover:bg-slate-300 transition-colors text-sm px-3 disabled:bg-slate-100 disabled:cursor-wait dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600">
                                                                <UploadIcon className="w-4 h-4" /> Upload
                                                            </button>
                                                            <button 
                                                                onClick={() => {
                                                                    setPasteModalTargetBatchId(batch.id);
                                                                    setClipboardPastedText('');
                                                                    setIsPasteModalOpen(true);
                                                                }} 
                                                                className="flex items-center gap-1.5 bg-blue-50 text-blue-700 border border-blue-200 p-2 rounded-lg hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800 transition-colors text-sm px-3"
                                                                title="Paste text dictation directly into this batch"
                                                            >
                                                                <ClipboardPaste className="w-4 h-4" /> Paste Text
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span className="text-xs font-semibold px-2.5 py-1 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-full border border-slate-300 dark:border-slate-600">
                                                                {batch.audioBlobs.length} {batch.audioBlobs.length === 1 ? 'item' : 'items'}
                                                            </span>
                                                            <button 
                                                                onClick={() => handleRecordOrResume(batch)} 
                                                                className="flex items-center gap-1.5 bg-emerald-600 text-white p-2 rounded-lg hover:bg-emerald-700 transition-colors text-sm px-3 disabled:bg-emerald-300 disabled:cursor-wait font-semibold shadow-2xs" 
                                                                disabled={isBusy && activeBatchId !== batch.id}
                                                                title="Append extra audio by dictating directly here"
                                                            >
                                                                <MicPlusIcon className="w-4 h-4"/> Append Dictation
                                                            </button>
                                                            <button 
                                                                onClick={() => triggerUpload(batch.id)} 
                                                                className="flex items-center gap-1.5 bg-slate-200 text-slate-700 p-2 rounded-lg hover:bg-slate-300 transition-colors text-sm px-3 disabled:bg-slate-100 disabled:cursor-wait dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                                                                title="Upload and append extra audio file to this batch"
                                                            >
                                                                <UploadIcon className="w-4 h-4" /> + Audio
                                                            </button>
                                                            <button 
                                                                onClick={() => {
                                                                    setPasteModalTargetBatchId(batch.id);
                                                                    setClipboardPastedText('');
                                                                    setIsPasteModalOpen(true);
                                                                }} 
                                                                className="flex items-center gap-1.5 bg-blue-50 text-blue-700 border border-blue-200 p-2 rounded-lg hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800 transition-colors text-sm px-3"
                                                                title="Paste text dictation to append to this batch"
                                                            >
                                                                <ClipboardPaste className="w-4 h-4" /> + Text
                                                            </button>
                                                            <button onClick={() => handleDownload(batch)} className="flex items-center gap-2 bg-slate-500 text-white p-2 rounded-lg hover:bg-slate-600 transition-colors text-sm px-3" aria-label={`Download audio for ${batch.name}`}>
                                                                <DownloadIcon className="w-4 h-4" /> Download
                                                            </button>
                                                        </>
                                                    )}
                                                </>
                                            )}
                                            {batch.status === 'recording' && (
                                                <>
                                                    <button onClick={handlePauseToggle} className={`flex items-center gap-2 text-white p-2 rounded-lg transition-colors text-sm px-3 disabled:cursor-wait ${isMainPaused ? 'bg-green-500 hover:bg-green-600' : 'bg-yellow-500 hover:bg-yellow-600'}`} disabled={isBusy}>
                                                        {isMainPaused ? <ResumeIcon className="w-4 h-4" /> : <PauseIcon className="w-4 h-4" />}
                                                        {isMainPaused ? 'Resume' : 'Pause'}
                                                    </button>
                                                    <button onClick={handleStop} className="flex items-center gap-2 bg-red-600 text-white p-2 rounded-lg hover:bg-red-700 transition-colors text-sm px-3 disabled:cursor-wait" disabled={isBusy}>
                                                        <StopIcon className="w-4 h-4"/> Stop
                                                    </button>
                                                </>
                                            )}
                                            {(batch.status === 'complete') && batch.audioBlobs.length > 0 && batch.findings === null && <span className="text-green-600 dark:text-green-400 font-semibold text-sm">Ready to Process</span>}
                                            {batch.status === 'processing' && (
                                                <div className="flex items-center gap-2">
                                                    <Spinner className="w-6 h-6" />
                                                    {batch.audioBlobs.length > 0 && (
                                                        <button onClick={() => handleDownload(batch)} className="flex items-center gap-2 bg-slate-500 text-white p-2 rounded-lg hover:bg-slate-600 transition-colors text-sm px-3" aria-label={`Download audio for ${batch.name}`}>
                                                            <DownloadIcon className="w-4 h-4" /> Download
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                            {batch.status === 'error' && !batch.findings && (
                                                <div className="flex items-center gap-2">
                                                    <span className="text-red-600 dark:text-red-400 font-semibold text-sm">Error</span>
                                                    <button
                                                        onClick={() => handleReprocessBatch(batch.id)}
                                                        className="flex items-center gap-1.5 bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/80 px-2.5 py-1 rounded text-xs font-bold transition-colors"
                                                        title="Retry Processing this Batch"
                                                    >
                                                        Retry
                                                    </button>
                                                </div>
                                            )}
                                            {batch.findings && (
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-blue-600 dark:text-blue-400 font-semibold text-sm">Processed</span>
                                                    {continuationState.status === 'recording' && continuationState.batchId === batch.id ? (
                                                        <div className="flex items-center gap-2 bg-red-100 dark:bg-red-900/20 px-2.5 py-1 rounded-lg">
                                                            <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-ping"></div>
                                                            <span className="text-xs font-bold text-red-700 dark:text-red-300">Recording...</span>
                                                            <button onClick={handleStopContinue} className="flex items-center gap-1 bg-red-600 text-white font-bold py-0.5 px-2 rounded hover:bg-red-700 text-xs">
                                                                <StopIcon className="w-3.5 h-3.5"/> Stop
                                                            </button>
                                                        </div>
                                                    ) : continuationState.status === 'processing' && continuationState.batchId === batch.id ? (
                                                        <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-700 px-2.5 py-1 rounded-lg">
                                                            <Spinner className="w-4 h-4" />
                                                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Appending...</span>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <button 
                                                                type="button"
                                                                onClick={() => {
                                                                    setOpenAccordion(batch.id);
                                                                    setTemplateModalBatchId(batch.id);
                                                                }} 
                                                                disabled={mergingBatchId === batch.id}
                                                                className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white p-1.5 rounded-lg transition-colors text-xs px-2.5 font-medium shadow-2xs disabled:opacity-50" 
                                                                title="Select a normal report template and merge with this batch's dictated findings"
                                                            >
                                                                <SparklesIcon className="w-3.5 h-3.5 text-yellow-300" />
                                                                <span>Merge with Template</span>
                                                            </button>
                                                            <button 
                                                                onClick={() => {
                                                                    setOpenAccordion(batch.id);
                                                                    handleStartContinue(batch.id);
                                                                }} 
                                                                className="flex items-center gap-1.5 bg-emerald-600 text-white p-1.5 rounded-lg hover:bg-emerald-700 transition-colors text-xs px-2.5 font-medium shadow-2xs" 
                                                                title="Append extra dictation directly to this transcript"
                                                            >
                                                                <MicPlusIcon className="w-3.5 h-3.5" /> Append Dictation
                                                            </button>
                                                        </>
                                                    )}
                                                    {batch.audioBlobs.length > 0 && (
                                                        <button onClick={() => handleDownload(batch)} className="flex items-center gap-1.5 bg-slate-500 text-white p-1.5 rounded-lg hover:bg-slate-600 transition-colors text-xs px-2.5" aria-label={`Download audio for ${batch.name}`} title="Download audio for this batch">
                                                            <DownloadIcon className="w-3.5 h-3.5" /> Download Audio
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    {expandedBatchPromptIds[batch.id] && (
                                        <div className="p-4 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900/50 mt-1">
                                            <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100 dark:border-slate-800">
                                                <span className="text-sm font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                                                    <SparklesIcon className="w-4 h-4 text-yellow-500" />
                                                    Custom Instructions & Template: {batch.name}
                                                </span>
                                                <button 
                                                    type="button"
                                                    onClick={() => setExpandedBatchPromptIds(prev => ({ ...prev, [batch.id]: false }))}
                                                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-bold"
                                                >
                                                    Collapse
                                                </button>
                                            </div>
                                            <CustomPromptInput
                                                prompt={batch.customPrompt}
                                                onPromptChange={(p) => updateBatchCustomPrompt(batch.id, p)}
                                                images={batch.customImages || []}
                                                onImagesChange={(imgs) => updateBatchCustomImages(batch.id, imgs)}
                                                selectedModel={batch.selectedModel || selectedModel}
                                            />
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
            </div>

            <div className="mt-6 flex flex-col sm:flex-row gap-3 flex-wrap">
                <button onClick={addBatch} className="bg-slate-200 text-slate-800 font-bold py-2 px-4 rounded-lg hover:bg-slate-300 w-full sm:w-auto dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600">Add Dictation Batch</button>
                <button
                    onClick={() => {
                        setPasteModalTargetBatchId(null);
                        setClipboardPastedText('');
                        setIsPasteModalOpen(true);
                    }}
                    className="bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800 font-bold py-2 px-4 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/60 w-full sm:w-auto flex items-center justify-center gap-2"
                    title="Paste text snippets as new batches"
                >
                    <ClipboardPaste className="w-4 h-4" /> Paste Text(s) as Batches
                </button>
                <button
                    onClick={() => setIsBatchReorderMode(prev => !prev)}
                    className={`bg-slate-200 text-slate-800 font-bold py-2 px-4 rounded-lg hover:bg-slate-300 w-full sm:w-auto flex items-center justify-center gap-2 transition-colors dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600 ${isBatchReorderMode ? 'bg-blue-100 text-blue-800 ring-2 ring-blue-300 dark:bg-blue-900/50 dark:text-blue-300 dark:ring-blue-500/50' : ''}`}
                >
                    <ReorderIcon className={`w-5 h-5 ${isBatchReorderMode ? 'text-blue-700 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'}`} />
                    {isBatchReorderMode ? 'Done Reordering' : 'Reorder Batches'}
                </button>
                <button 
                    onClick={handleProcessAll}
                    disabled={!hasProcessableRecordings || !allProcessed || isBusy}
                    className="bg-green-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-green-700 disabled:bg-green-300 disabled:cursor-not-allowed w-full sm:w-auto flex-grow"
                >
                    {allProcessed ? 'Create All Transcripts' : <><Spinner className="w-5 h-5 inline mr-2" /> Processing...</>}
                </button>
                <button
                    onClick={handleDownloadHTML}
                    disabled={!hasAnyResults}
                    className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed w-full sm:w-auto"
                >
                    Download Report as HTML
                </button>
                <button
                    onClick={clearAllBatches}
                    disabled={batches.length === 0}
                    className="bg-red-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-red-700 w-full sm:w-auto disabled:bg-red-300"
                >
                    Clear All Batches
                </button>
            </div>
            
            {hasAnyResults && (
                <div ref={findingsContainerRef} className="mt-8 border-t dark:border-slate-700 pt-6">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Processed Transcripts</h3>
                    </div>
                    {hasAnyErrors && <ErrorLegend />}
                    {hasAnyResults && (
                        <div className="flex justify-end mb-4">
                            <button
                                onClick={handleCopyAllBatches}
                                className={`text-base font-semibold py-2 px-4 rounded-lg transition-colors ${isAllBatchesCopied ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300' : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'}`}
                            >
                                {isAllBatchesCopied ? 'Copied!' : 'Copy All Transcripts'}
                            </button>
                        </div>
                    )}
                     <div className="space-y-2">
                        {batches.filter(b => b.findings || (b.status === 'error' && b.findings === null)).map(batch => (
                             <div key={batch.id} className="border dark:border-slate-700 rounded-lg overflow-hidden">
                                <button onClick={() => setOpenAccordion(openAccordion === batch.id ? null : batch.id)} className="w-full text-left p-4 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700/50 dark:hover:bg-slate-700 flex justify-between items-center">
                                    <span className="font-semibold text-slate-800 dark:text-slate-200">{batch.name}</span>
                                    <span className={`transition-transform transform ${openAccordion === batch.id ? 'rotate-180' : ''}`}><ChevronDownIcon /></span>
                                </button>
                                {openAccordion === batch.id && (
                                     <div className="p-4 bg-white dark:bg-slate-800">
                                        {batch.status === 'processing' && batch.findings === null ? (
                                            <div className="text-center p-8">
                                                <Spinner />
                                                <p className="text-slate-600 dark:text-slate-300 mt-4 text-lg font-medium">
                                                Analyzing and correcting text...
                                                </p>
                                                <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm">
                                                This may take a moment.
                                                </p>
                                                <div className="mt-4 flex justify-center">
                                                    <button
                                                        onClick={() => handleCancelBatchProcessing(batch.id)}
                                                        className="inline-flex items-center gap-2 bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/70 font-semibold py-1.5 px-4 rounded-lg border border-red-300 dark:border-red-700 transition-colors shadow-sm text-sm"
                                                    >
                                                        <StopIcon className="w-4 h-4" /> Cancel Analysis
                                                    </button>
                                                </div>
                                            </div>
                                        ) : batch.findings ? (
                                            <>
                                                <div className="flex justify-between items-center mb-4">
                                                  <div className="flex items-center gap-2">
                                                    <h4 className="text-lg font-bold text-slate-800 dark:text-slate-200">Transcript</h4>
                                                    {batch.errorCheckStatus === 'checking' && (
                                                        <div className="flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400">
                                                            <Spinner className="w-4 h-4" />
                                                            <span>Checking...</span>
                                                        </div>
                                                    )}
                                                  </div>
                                                </div>

                                                {mergingBatchId === batch.id && (
                                                    <div className="mb-4 p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700/80 flex items-center gap-3 animate-fade-in shadow-xs" role="status">
                                                        <Spinner className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                                                        <div>
                                                            <p className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                                                                Merging dictated findings with {mergingTemplateName || 'template'}...
                                                            </p>
                                                            <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
                                                                Preserving normal template findings, updating dictated findings with bold formatting, and generating impression.
                                                            </p>
                                                        </div>
                                                    </div>
                                                )}

                                                <div className="bg-slate-100 dark:bg-slate-900/50 p-3.5 rounded-xl mb-4 shadow-sm border border-slate-200/80 dark:border-slate-800">
                                                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                                                        <div className="flex items-center gap-2 w-full sm:w-auto">
                                                            <label htmlFor={`model-select-${batch.id}`} className="text-sm font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">Process again with:</label>
                                                            <select 
                                                                id={`model-select-${batch.id}`}
                                                                value={batch.selectedModel}
                                                                onChange={(e) => updateBatchModel(batch.id, e.target.value)}
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
                                                                onClick={() => setBatchExtraOptionsOpen(prev => ({ ...prev, [batch.id]: !prev[batch.id] }))}
                                                                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all border ${
                                                                    batchExtraOptionsOpen[batch.id] || (batch.extraFiles && batch.extraFiles.length > 0) || (batch.customImages && batch.customImages.length > 0)
                                                                        ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                                                                        : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
                                                                }`}
                                                                title="Add extra files, images, or instructions to update the transcript for this batch"
                                                            >
                                                                <span>📎</span>
                                                                <span>Add File(s) / Image(s) / Text</span>
                                                                {(((batch.extraFiles?.length || 0) + (batch.customImages?.length || 0) + (batch.customPrompt?.trim().length > 0 ? 1 : 0)) > 0) && (
                                                                    <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-blue-600 text-white font-bold">
                                                                        {(batch.extraFiles?.length || 0) + (batch.customImages?.length || 0) + (batch.customPrompt?.trim().length > 0 ? 1 : 0)}
                                                                    </span>
                                                                )}
                                                            </button>

                                                            <button
                                                                type="button"
                                                                onClick={() => setTemplateModalBatchId(batch.id)}
                                                                disabled={mergingBatchId === batch.id}
                                                                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm disabled:opacity-50 flex-shrink-0"
                                                                title="Select a normal report template and merge with this batch's dictated findings"
                                                            >
                                                                <SparklesIcon className="w-3.5 h-3.5 text-yellow-300" />
                                                                <span>Merge with Template</span>
                                                            </button>

                                                            <button
                                                                onClick={() => handleReprocessBatch(batch.id)}
                                                                className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto flex-shrink-0"
                                                            >
                                                                Update Transcript
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {/* Collapsible / Expandable Extra Options Panel for Batch */}
                                                    {batchExtraOptionsOpen[batch.id] && (
                                                        <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/80 flex flex-col gap-3">
                                                            <input 
                                                                type="file" 
                                                                id={`batch-extra-files-${batch.id}`}
                                                                onChange={(e) => handleBatchExtraFilesSelected(batch.id, e)} 
                                                                multiple 
                                                                accept="audio/*,video/*,image/*,.pdf,.doc,.docx,.txt,.csv,.rtf,.webm,.mp4,.mp3,.wav,.m4a,.png,.jpg,.jpeg" 
                                                                className="hidden" 
                                                                aria-hidden="true" 
                                                            />
                                                            <input 
                                                                type="file" 
                                                                id={`batch-extra-images-${batch.id}`}
                                                                onChange={(e) => handleBatchExtraImagesSelected(batch.id, e)} 
                                                                multiple 
                                                                accept="image/*" 
                                                                className="hidden" 
                                                                aria-hidden="true" 
                                                            />

                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => document.getElementById(`batch-extra-files-${batch.id}`)?.click()}
                                                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 transition-colors shadow-xs"
                                                                >
                                                                    <UploadIcon className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                                                                    <span>+ Add File(s) (Audio, PDF, DOCX, TXT)</span>
                                                                </button>

                                                                <button
                                                                    type="button"
                                                                    onClick={() => document.getElementById(`batch-extra-images-${batch.id}`)?.click()}
                                                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 transition-colors shadow-xs"
                                                                >
                                                                    <ImageIcon className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                                                                    <span>+ Add Image(s) / Scan</span>
                                                                </button>

                                                                <button
                                                                    type="button"
                                                                    onClick={() => setBatchExtraTextOpen(prev => ({ ...prev, [batch.id]: !prev[batch.id] }))}
                                                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors shadow-xs ${
                                                                        batchExtraTextOpen[batch.id] || (batch.customPrompt && batch.customPrompt.trim().length > 0)
                                                                            ? 'bg-blue-100 dark:bg-blue-900/60 border-blue-400 text-blue-800 dark:text-blue-200'
                                                                            : 'bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                                                                    }`}
                                                                >
                                                                    <PencilIcon className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                                                                    <span>{batchExtraTextOpen[batch.id] ? 'Hide Extra Text' : '+ Add Extra Text / Notes'}</span>
                                                                </button>
                                                            </div>

                                                            {/* Staged Extra Files List */}
                                                            {batch.extraFiles && batch.extraFiles.length > 0 && (
                                                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                                                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Attached Files:</span>
                                                                    {batch.extraFiles.map((file, fIdx) => (
                                                                        <div key={`batch-extra-f-${batch.id}-${fIdx}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-800 text-xs font-medium text-blue-900 dark:text-blue-200">
                                                                            <span className="truncate max-w-[140px]" title={file.name}>{file.name}</span>
                                                                            <span className="text-[10px] text-blue-600 dark:text-blue-400">({(file.size / 1024).toFixed(0)} KB)</span>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => handleRemoveBatchExtraFile(batch.id, fIdx)}
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
                                                            {batch.customImages && batch.customImages.length > 0 && (
                                                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                                                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Reference Images:</span>
                                                                    {batch.customImages.map((img, iIdx) => (
                                                                        <div key={`batch-extra-img-${batch.id}-${iIdx}`} className="relative group inline-flex items-center gap-1 p-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                                                                            <img src={`data:${img.mimeType};base64,${img.data}`} alt="Ref" className="w-8 h-8 rounded object-cover" />
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => handleRemoveBatchCustomImage(batch.id, iIdx)}
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
                                                            {(batchExtraTextOpen[batch.id] || (batch.customPrompt && batch.customPrompt.trim().length > 0)) && (
                                                                <div className="flex flex-col gap-1.5 pt-1">
                                                                    <div className="flex items-center justify-between">
                                                                        <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                                                                            Extra Instructions / Text Notes for Batch Update:
                                                                        </label>
                                                                        {batch.customPrompt && batch.customPrompt.trim().length > 0 && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => updateBatchCustomPrompt(batch.id, '')}
                                                                                className="text-[11px] text-red-500 hover:underline"
                                                                            >
                                                                                Clear Text
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                    <textarea
                                                                        value={batch.customPrompt || ''}
                                                                        onChange={(e) => updateBatchCustomPrompt(batch.id, e.target.value)}
                                                                        placeholder="Add any extra notes, clinical corrections, or dictation instructions to apply when updating this batch..."
                                                                        className="w-full text-xs p-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:outline-none resize-y min-h-[60px]"
                                                                        rows={2}
                                                                    />
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                                <CustomPromptInput 
                                                    prompt={batch.customPrompt}
                                                    onPromptChange={(p) => updateBatchCustomPrompt(batch.id, p)}
                                                    images={batch.customImages || []}
                                                    onImagesChange={(imgs) => updateBatchCustomImages(batch.id, imgs)}
                                                    customDocx={batch.customDocx}
                                                    onCustomDocxChange={(docx) => updateBatchCustomDocx(batch.id, docx)}
                                                    selectedModel={batch.selectedModel || selectedModel}
                                                    className="mb-6"
                                                />
                                                <p className="text-slate-600 dark:text-slate-400 mb-6 text-sm">Click any finding to copy it. To select multiple, click the circle on the left. The 'Continue Dictation' button below adds new findings to this batch.</p>
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
                                                {(() => {
                                                    const effectivePrompt = batch.customPrompt || globalCustomPrompt;
                                                    const effectiveImages = (batch.customImages && batch.customImages.length > 0) ? batch.customImages : globalCustomImages;
                                                    const batchTemplate = detectAndExtractTemplate(effectivePrompt, effectiveImages, null);
                                                    const isBatchTemplateMode = batchTemplate.isTemplateMode;
                                                    const isRtfOpen = batchRtfViewIds[batch.id] !== undefined ? batchRtfViewIds[batch.id] : isBatchTemplateMode;

                                                    return (
                                                        <>
                                                            <div className="flex flex-wrap justify-start sm:justify-end items-center gap-2 mb-4 w-full overflow-x-auto py-1">
                                                                <button
                                                                    onClick={() => setBatchRtfViewIds(prev => ({ ...prev, [batch.id]: !isRtfOpen }))}
                                                                    className={`text-sm font-semibold py-1 px-3 rounded-lg transition-colors flex items-center gap-1.5 ${isRtfOpen ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'}`}
                                                                    title="Toggle Rich Text Format (RTF) & Word editor for this batch"
                                                                >
                                                                    <span>📄</span>
                                                                    <span>{isRtfOpen ? 'Hide RTF' : 'RTF Editor'}</span>
                                                                    {isBatchTemplateMode && (
                                                                        <span className="text-[10px] bg-white/20 text-white px-1.5 py-0.2 rounded-full">Template</span>
                                                                    )}
                                                                </button>
                                                                {undoStates[batch.id] && (
                                                                    <button
                                                                        onClick={() => handleUndo(batch.id)}
                                                                        className="text-sm font-semibold py-1 px-3 rounded-lg bg-yellow-400 text-yellow-900 hover:bg-yellow-500 transition-colors"
                                                                        aria-label="Undo last modification for this batch"
                                                                    >
                                                                        Undo
                                                                    </button>
                                                                )}
                                                                 <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        setMultiSelectMode(prev => {
                                                                            const next = !prev;
                                                                            if (!next) {
                                                                                setSelections({});
                                                                                setSelectionSnippets({});
                                                                            }
                                                                            return next;
                                                                        });
                                                                    }}
                                                                    className={`text-sm font-semibold py-1 px-3 rounded-lg transition-colors flex items-center gap-1.5 ${
                                                                        multiSelectMode 
                                                                          ? 'bg-blue-600 text-white hover:bg-blue-700' 
                                                                          : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'
                                                                    }`}
                                                                    title="Toggle Multi-select Mode to select and copy multiple findings"
                                                                >
                                                                    <CheckSquare className={`w-4 h-4 ${multiSelectMode ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`} />
                                                                    {multiSelectMode ? 'Done Selecting' : 'Multi-select'}
                                                                </button>
                                                                {multiSelectMode && (
                                                                  <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                      const currentSelected = selections[batch.id] || new Set();
                                                                      const allValid = new Set<number>();
                                                                      batch.findings?.forEach((f, i) => {
                                                                        if (f && f.trim() !== '') allValid.add(i);
                                                                      });
                                                                      if (currentSelected.size === allValid.size) {
                                                                        const next = { ...selections };
                                                                        delete next[batch.id];
                                                                        setSelections(next);
                                                                        showNotification(`All findings deselected for ${batch.name}`);
                                                                      } else {
                                                                        const next = { ...selections, [batch.id]: allValid };
                                                                        setSelections(next);
                                                                        copyBatchSelection(batch.id, allValid);
                                                                        showNotification(`Selected & copied all findings for ${batch.name}! Tap any to deselect.`);
                                                                      }
                                                                    }}
                                                                    className="text-xs sm:text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-blue-100 hover:bg-blue-200 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200 border border-blue-300/80 dark:border-blue-700/80 shadow-sm"
                                                                    title={(selections[batch.id]?.size || 0) === (batch.findings?.filter(f => f && f.trim() !== '').length || 0) ? `Deselect all findings for ${batch.name}` : `Select all findings for ${batch.name}`}
                                                                  >
                                                                    {(selections[batch.id]?.size || 0) === (batch.findings?.filter(f => f && f.trim() !== '').length || 0) ? 'Deselect All' : 'Select All'}
                                                                  </button>
                                                                )}
                                                                <button
                                                                    onClick={() => handleToggleMergeMode(batch.id)}
                                                                    className={`text-sm font-semibold py-1 px-3 rounded-lg transition-colors flex items-center gap-1.5 ${mergeBatchId === batch.id ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'}`}
                                                                >
                                                                    <MergeIcon className={`w-4 h-4 ${mergeBatchId === batch.id ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`} />
                                                                    {mergeBatchId === batch.id ? 'Done' : 'Merge'}
                                                                </button>
                                                                <button
                                                                  onClick={() => handleToggleReorderMode(batch.id)}
                                                                  className={`text-sm font-semibold py-1 px-3 rounded-lg transition-colors flex items-center gap-1.5 ${reorderBatchId === batch.id ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'}`}
                                                                >
                                                                  <ReorderIcon className={`w-4 h-4 ${reorderBatchId === batch.id ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`} />
                                                                  {reorderBatchId === batch.id ? 'Done' : 'Reorder'}
                                                                </button>
                                                                <button
                                                                    onClick={() => handleCopyAllForBatch(batch)}
                                                                    className={`text-base font-semibold py-2 px-4 rounded-lg transition-colors ${allCopiedId === batch.id ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300' : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'}`}
                                                                >
                                                                    {allCopiedId === batch.id ? 'Copied!' : 'Copy All'}
                                                                </button>
                                                                {batch.audioBlobs.length > 0 && (
                                                                    <button
                                                                        onClick={() => handleDownload(batch)}
                                                                        className="text-sm font-semibold py-1.5 px-3 rounded-lg bg-slate-600 hover:bg-slate-700 text-white transition-colors flex items-center gap-1.5 shadow-xs"
                                                                        title="Download original audio for this batch"
                                                                    >
                                                                        <DownloadIcon className="w-4 h-4" />
                                                                        <span>Download Audio</span>
                                                                    </button>
                                                                )}
                                                            </div>

                                                             {isRtfOpen && (
                                                                <div className="mb-6 p-4 bg-gradient-to-br from-blue-50/70 to-indigo-50/50 dark:from-slate-800/80 dark:to-blue-950/40 border border-blue-200/80 dark:border-blue-800/60 rounded-xl shadow-xs animate-fade-in">
                                                                    <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b border-blue-200/60 dark:border-blue-900/50">
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-base">📄</span>
                                                                            <h4 className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100">
                                                                                Rich Text Format (RTF) Editor & Template Output: {batch.name}
                                                                            </h4>
                                                                            {isBatchTemplateMode && (
                                                                                <span className="text-[10px] bg-blue-600 text-white font-bold px-2 py-0.5 rounded-full">
                                                                                    {batchTemplate.templateName || 'Template Active'}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                    <RichTextReportEditor
                                                                        findings={batch.findings}
                                                                        templateName={batchTemplate.templateName || batch.name}
                                                                        onUpdateFindings={(updatedFindings) => handleUpdateBatchFindings(batch.id, updatedFindings)}
                                                                    />
                                                                </div>
                                                            )}
                                                        </>
                                                    );
                                                })()}

                                                {/* Merge Mode Guidance Banner for Batch */}
                                                {mergeBatchId === batch.id && (
                                                    <div className="mb-3 p-2.5 sm:p-3 bg-blue-50/90 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-blue-900 dark:text-blue-200 animate-fade-in shadow-xs">
                                                        <div className="flex items-center gap-2">
                                                            <MergeIcon className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                                                            <span>
                                                                {clickMergeBatchState && clickMergeBatchState.batchId === batch.id ? (
                                                                    <>
                                                                        <strong className="text-blue-700 dark:text-blue-300">Finding #{clickMergeBatchState.index + 1}</strong> selected. Click another finding in this batch to merge into it, or click it again to cancel.
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <strong>Merge Mode:</strong> Drag a finding onto another, or click one finding and then click the target to merge them together.
                                                                    </>
                                                                )}
                                                            </span>
                                                        </div>
                                                        {clickMergeBatchState && clickMergeBatchState.batchId === batch.id && (
                                                            <button
                                                                onClick={() => setClickMergeBatchState(null)}
                                                                className="text-xs font-semibold px-2.5 py-1 bg-white dark:bg-slate-800 border border-blue-300 dark:border-blue-700 rounded-md text-blue-700 dark:text-blue-300 hover:bg-blue-50 transition-colors shadow-xs"
                                                            >
                                                                Cancel Selection
                                                            </button>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Reorder Mode Guidance Banner for Batch */}
                                                {reorderBatchId === batch.id && (
                                                    <div className="mb-3 p-2.5 sm:p-3 bg-blue-50/90 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-xl flex items-center gap-2 text-xs sm:text-sm text-blue-900 dark:text-blue-200 animate-fade-in shadow-xs">
                                                        <ReorderIcon className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                                                        <span>
                                                            <strong>Reorder Mode:</strong> Drag any row from anywhere on the card up or down to change its position in the report.
                                                        </span>
                                                    </div>
                                                )}

                                                <div className="space-y-3">
                                                    {batch.findings.map((finding, index) => {
                                                        const isBold = finding.includes('BOLD::');
                                                        const cleanFinding = finding.replace(/BOLD::/g, '');
                                                        const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
                                                        const isClinicalProfile = isClinicalProfileFinding(cleanFinding);
                                                        const { isStructured, isTable, title, points, tableLines } = parseStructuredFinding(cleanFinding);
                                                        const isItalic = !isTable && (isClinicalProfile || (!isStructured && cleanFinding.startsWith('*') && cleanFinding.endsWith('*')));
                                                        const textToDisplay = isClinicalProfile 
                                                            ? formatClinicalProfileText(cleanFinding) 
                                                            : isItalic 
                                                            ? cleanFinding.slice(1, -1) 
                                                            : isStructured 
                                                            ? title 
                                                            : cleanFinding;

                                                        const textContainerClasses = isTitle
                                                            ? 'text-center font-bold underline'
                                                            : isItalic
                                                            ? 'italic'
                                                            : isBold
                                                            ? 'font-bold'
                                                            : '';
                                                        
                                                        const isSelected = selections[batch.id]?.has(index) ?? false;
                                                        const isEditingThis = editingState?.batchId === batch.id && editingState?.index === index;
                                                        const isDictatingThis = dictatingState?.batchId === batch.id && dictatingState?.index === index;
                                                        const isDictateEditingThis = dictateEditingState?.batchId === batch.id && dictateEditingState?.index === index;
                                                        const isProcessingThis = processingState?.batchId === batch.id && processingState?.index === index;
                                                        const hasErrorThis = continuationError?.batchId === batch.id && continuationError?.index === index;
                                                        const isCurrentlyActive = isEditingThis || isDictatingThis || isProcessingThis || hasErrorThis || isDictateEditingThis;
                                                        
                                                        const isReorderingThisBatch = reorderBatchId === batch.id;
                                                        const isMergingThisBatch = mergeBatchId === batch.id;
                                                        const isMergeSource = isMergingThisBatch && clickMergeBatchState?.batchId === batch.id && clickMergeBatchState?.index === index;
                                                        const isDraggingThis = draggedState?.batchId === batch.id && draggedState?.index === index;
                                                        const isDragOverTarget = isMergingThisBatch && dragOverState?.batchId === batch.id && dragOverState?.index === index && draggedState?.index !== index;
                                                        
                                                        const errorsForThisFinding = batch.identifiedErrors?.filter(e => e.findingIndex === index) || [];
                                                        
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
                                                                key={`${batch.id}-${index}`}
                                                                data-batch-id={batch.id}
                                                                data-finding-index={index}
                                                                draggable={!isCurrentlyActive && (isReorderingThisBatch || isMergingThisBatch)}
                                                                onDragStart={
                                                                    !isCurrentlyActive && isReorderingThisBatch ? (e) => handleReorderDragStart(e, batch.id, index) :
                                                                    !isCurrentlyActive && isMergingThisBatch ? (e) => handleMergeDragStart(e, batch.id, index) :
                                                                    undefined
                                                                }
                                                                onDragEnd={
                                                                    isReorderingThisBatch ? (e) => handleReorderDragEnd(e) :
                                                                    isMergingThisBatch ? () => { setDraggedState(null); setDragOverState(null); dragItem.current = null; } :
                                                                    undefined
                                                                }
                                                                onDragEnter={isReorderingThisBatch ? (e) => { e.stopPropagation(); dragOverItem.current = { batchId: batch.id, index }; } : undefined}
                                                                onDrop={
                                                                    isReorderingThisBatch ? (e) => handleReorderDrop(e, batch.id, index) :
                                                                    isMergingThisBatch ? (e) => handleMergeDrop(e, batch.id, index) :
                                                                    undefined
                                                                }
                                                                onDragOver={(isReorderingThisBatch || isMergingThisBatch) ? (e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    if (e.dataTransfer) {
                                                                        e.dataTransfer.dropEffect = 'move';
                                                                    }
                                                                } : undefined}
                                                                onDragEnterCapture={isMergingThisBatch ? (e) => { e.preventDefault(); setDragOverState({ batchId: batch.id, index }); } : undefined}
                                                                onDragLeaveCapture={isMergingThisBatch ? (e) => { e.preventDefault(); setDragOverState(null); } : undefined}
                                                                onTouchStart={!isCurrentlyActive ? (e) => handleRowTouchStart(e, batch.id, index) : undefined}
                                                                onTouchMove={!isCurrentlyActive ? (e) => handleRowTouchMove(e, batch.id) : undefined}
                                                                onTouchEnd={!isCurrentlyActive ? () => handleRowTouchEnd(batch.id) : undefined}
                                                                className={`finding-item relative group p-3 ${(isReorderingThisBatch || isMergingThisBatch) ? 'pl-16 select-none cursor-grab active:cursor-grabbing' : 'pl-11 cursor-pointer'} pr-28 sm:pr-24 border-l-4 rounded-r-lg transition-all duration-200 ${
                                                                    isDragOverTarget
                                                                    ? 'bg-green-100 border-green-500 dark:bg-green-900/30 dark:border-green-500 ring-2 ring-green-200 dark:ring-green-700'
                                                                    : isMergeSource
                                                                    ? 'bg-amber-100 border-amber-500 dark:bg-amber-900/40 dark:border-amber-400 ring-2 ring-amber-300 dark:ring-amber-600 shadow-md'
                                                                    : isSelected && !isCurrentlyActive
                                                                    ? 'bg-blue-100 border-blue-600 dark:bg-blue-900/30 dark:border-blue-500 shadow-md'
                                                                    : hasError
                                                                    ? errorClasses[highestSeverity!]
                                                                    : 'bg-slate-50 border-blue-500 dark:bg-slate-700/50 dark:border-blue-500'
                                                                } ${!isCurrentlyActive && !(isReorderingThisBatch || isMergingThisBatch) ? 'hover:bg-blue-50 dark:hover:bg-slate-700' : ''} ${isDraggingThis ? 'opacity-50 bg-slate-200 dark:bg-slate-600' : ''}`}
                                                                role="button"
                                                                aria-pressed={isSelected && !isCurrentlyActive}
                                                                tabIndex={isCurrentlyActive ? -1 : 0}
                                                                onClick={
                                                                    isCurrentlyActive
                                                                        ? undefined
                                                                        : isMergingThisBatch
                                                                        ? () => handleMergeItemClickForBatch(batch.id, index)
                                                                        : isReorderingThisBatch
                                                                        ? undefined
                                                                        : () => handleFindingClickForBatch(batch.id, index)
                                                                }
                                                                onKeyDown={
                                                                    isCurrentlyActive
                                                                        ? undefined
                                                                        : (e) => {
                                                                            if (e.key === ' ' || e.key === 'Enter') {
                                                                                if (isMergingThisBatch) handleMergeItemClickForBatch(batch.id, index);
                                                                                else if (!isReorderingThisBatch) handleFindingClickForBatch(batch.id, index);
                                                                            }
                                                                        }
                                                                }
                                                            >
                                                                {(isReorderingThisBatch || isMergingThisBatch) && (
                                                                    <div 
                                                                        className="absolute left-1.5 top-0 bottom-0 w-6 flex items-center justify-center cursor-grab active:cursor-grabbing text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 select-none z-10 pointer-events-none" 
                                                                        aria-hidden="true"
                                                                    >
                                                                        {isReorderingThisBatch && <ReorderIcon />}
                                                                        {isMergingThisBatch && (
                                                                            <MergeIcon className={`w-4 h-4 ${dragOverState?.batchId === batch.id && dragOverState?.index === index ? 'text-green-600 dark:text-green-400 scale-125' : isMergeSource ? 'text-amber-600 dark:text-amber-400 scale-110' : ''} transition-all`} />
                                                                        )}
                                                                    </div>
                                                                )}

                                                                <div
                                                                    onClick={(e) => !isCurrentlyActive && handleSelectionHandleClickForBatch(e, batch.id, index)}
                                                                    className={`absolute ${(isReorderingThisBatch || isMergingThisBatch) ? 'left-8' : 'left-0'} top-0 bottom-0 w-8 flex items-center justify-center touch-manipulation ${isCurrentlyActive ? 'cursor-not-allowed' : 'cursor-pointer'}`}
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
                                                                            className={`text-slate-700 dark:text-slate-200 whitespace-pre-wrap ${!isCurrentlyActive ? 'cursor-pointer' : 'cursor-default'} ${textContainerClasses}`}
                                                                        >
                                                                            {isImpression ? (
                                                                                <>
                                                                                    <span className="font-bold underline uppercase">{title}</span>
                                                                                    <ul className="list-disc list-inside pl-4 mt-1">
                                                                                        {points.map((point, i) => (
                                                                                            <li key={i} className="font-bold">{point}</li>
                                                                                        ))}
                                                                                    </ul>
                                                                                </>
                                                                            ) : isTable ? (
                                                                                renderBatchTableFinding(tableLines)
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
                                                                                <button onClick={handleStopDictation} aria-label="Stop dictation" className="p-1 text-slate-600 dark:text-slate-300 hover:text-red-600 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                                                                                    <StopIcon className="w-5 h-5" />
                                                                                </button>
                                                                            </div>
                                                                        ) : isDictateEditingThis ? (
                                                                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2 bg-white dark:bg-slate-800 p-1 rounded-full shadow-lg border border-slate-200 dark:border-slate-700">
                                                                                <div className="w-3 h-3 bg-blue-500 rounded-full animate-ping ml-1"></div>
                                                                                <button onClick={handleStopDictateEditForBatch} aria-label="Stop dictation edit" className="p-1 text-slate-600 dark:text-slate-300 hover:text-red-600 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                                                                                    <StopIcon className="w-5 h-5" />
                                                                                </button>
                                                                            </div>
                                                                        ) : !isReorderingThisBatch && !isMergingThisBatch && (
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
                                                                                 <button onClick={() => handleStartEdit(batch.id, index)} aria-label="Edit text" className="p-1.5 sm:p-1 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors touch-manipulation" title="Edit row">
                                                                                    <PencilIcon />
                                                                                </button>
                                                                                <button onClick={() => handleStartDictation(batch.id, index)} aria-label="Continue dictation" className="p-1.5 sm:p-1 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors touch-manipulation" title="Continue dictation for this row">
                                                                                    <MicIcon className="w-5 h-5" />
                                                                                </button>
                                                                                <button onClick={() => handleStartDictateEditForBatch(batch.id, index)} aria-label="Dictate changes" className="p-1.5 sm:p-1 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-full hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors touch-manipulation" title="Dictate changes to row">
                                                                                    <MicPencilIcon />
                                                                                </button>
                                                                                <button 
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        handleDeleteFindingForBatch(batch.id, index);
                                                                                    }} 
                                                                                    aria-label="Delete this row" 
                                                                                    title="Delete row"
                                                                                    className="p-1.5 sm:p-1 text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 rounded-full hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors touch-manipulation"
                                                                                >
                                                                                    <TrashIcon className="w-5 h-5" />
                                                                                </button>
                                                                            </div>
                                                                        )}
                                                                        {isReorderingThisBatch && (
                                                                            <div 
                                                                                onClick={(e) => e.stopPropagation()} 
                                                                                className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 z-20"
                                                                            >
                                                                                <button
                                                                                    type="button"
                                                                                    disabled={index === 0}
                                                                                    onClick={() => handleMoveFinding(batch.id, index, 'up')}
                                                                                    className="p-1.5 rounded-lg bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 hover:bg-blue-50 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed shadow-xs transition-colors cursor-pointer"
                                                                                    title="Move finding up"
                                                                                    aria-label="Move finding up"
                                                                                >
                                                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 15l7-7 7 7" />
                                                                                    </svg>
                                                                                </button>
                                                                                <button
                                                                                    type="button"
                                                                                    disabled={index === batch.findings.length - 1}
                                                                                    onClick={() => handleMoveFinding(batch.id, index, 'down')}
                                                                                    className="p-1.5 rounded-lg bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 hover:bg-blue-50 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed shadow-xs transition-colors cursor-pointer"
                                                                                    title="Move finding down"
                                                                                    aria-label="Move finding down"
                                                                                >
                                                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
                                                                                    </svg>
                                                                                </button>
                                                                            </div>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>
                                                        )
                                                    })}
                                                </div>

                                                <div className="mt-6 p-4 border rounded-lg bg-slate-50 dark:bg-slate-700/50 dark:border-slate-700">
                                                    <div className="flex items-start sm:items-center gap-3 flex-col sm:flex-row">
                                                        <MicScribbleIcon className="w-8 h-8 text-slate-600 dark:text-slate-300 flex-shrink-0" />
                                                        <div className="flex-grow">
                                                            <h4 className="font-semibold text-slate-800 dark:text-slate-200">Dictate Report Changes</h4>
                                                            <p className="text-sm text-slate-600 dark:text-slate-400">
                                                                Use this to dictate global changes to the entire report, like 'remove all measurements' or 'rephrase the conclusion to be more concise'.
                                                            </p>
                                                        </div>
                                                        <div className="sm:ml-4 flex-shrink-0 w-full sm:w-auto">
                                                            {modificationState.status === 'idle' || modificationState.batchId !== batch.id ? (
                                                                <button onClick={() => handleStartModification(batch.id)} className="w-full bg-blue-100 text-blue-800 font-bold py-2 px-4 rounded-lg hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-900/80 transition-colors">
                                                                    Start Dictating Changes
                                                                </button>
                                                            ) : modificationState.status === 'recording' ? (
                                                                <div className="w-full flex items-center justify-center gap-4 bg-red-100 dark:bg-red-900/20 p-2 rounded-lg">
                                                                    <div className="flex items-center gap-2">
                                                                        <div className="w-3 h-3 bg-red-500 rounded-full animate-ping"></div>
                                                                        <span className="font-semibold text-red-700 dark:text-red-300">Recording...</span>
                                                                    </div>
                                                                    <button onClick={handleStopModification} className="flex items-center justify-center gap-1 bg-red-600 text-white font-bold py-1 px-3 rounded-lg hover:bg-red-700">
                                                                        <StopIcon className="w-5 h-5"/>
                                                                        Stop
                                                                    </button>
                                                                </div>
                                                            ) : modificationState.status === 'processing' ? (
                                                                <div className="w-full flex items-center justify-center gap-2 bg-slate-100 dark:bg-slate-700 p-2 rounded-lg">
                                                                    <Spinner className="w-6 h-6"/>
                                                                    <span className="font-semibold text-slate-700 dark:text-slate-300">Applying Changes...</span>
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                    {modificationError.batchId === batch.id && modificationError.message && <p className="text-red-500 dark:text-red-400 text-sm mt-2">{modificationError.message}</p>}
                                                </div>
                                                
                                                {/* Complex Impression Generator Section */}
                                                {complexGeneratorVisibleForBatchId === batch.id ? (
                                                    <div className="mt-6 p-4 border-2 border-dashed rounded-lg bg-slate-50 dark:bg-slate-700/50 dark:border-slate-600">
                                                        {agenticStates[batch.id] === 'processing' ? (
                                                            <div className="flex flex-col items-center justify-center p-6 text-center">
                                                                <Spinner className="w-8 h-8 text-purple-600 mb-3" />
                                                                <p className="font-semibold text-slate-800 dark:text-slate-200">
                                                                    Generating Complex Impression
                                                                </p>
                                                                <p className="text-sm font-medium text-purple-600 dark:text-purple-400 mt-2 px-3 py-1.5 rounded-lg bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-800/50 max-w-lg animate-pulse">
                                                                    {agenticProgressTexts[batch.id] || 'Running agentic analysis...'}
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
                                                                        value={complexInputs[batch.id] || ''}
                                                                        onChange={(e) => setComplexInputs(prev => ({ ...prev, [batch.id]: e.target.value }))}
                                                                        placeholder="e.g., 'Patient has a history of metastatic lung cancer.'"
                                                                        className="w-full p-2 pr-12 border border-slate-300 rounded-md text-sm bg-white text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500 focus:outline-none dark:bg-slate-900 dark:text-white dark:border-slate-600 dark:placeholder-slate-400"
                                                                        rows={3}
                                                                        aria-label="Additional findings for complex impression"
                                                                    />
                                                                    <button
                                                                        onClick={() => handleComplexMicClick(batch.id)}
                                                                        disabled={isTranscribingComplex[batch.id]}
                                                                        className={`absolute bottom-2 right-2 p-1.5 rounded-full text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                                                            complexInputRecorder.isRecording
                                                                            ? 'bg-red-600 hover:bg-red-700 animate-pulse'
                                                                            : 'bg-blue-600 hover:bg-blue-700'
                                                                        }`}
                                                                        aria-label={complexInputRecorder.isRecording ? 'Stop dictating' : 'Dictate additional findings'}
                                                                    >
                                                                        {isTranscribingComplex[batch.id] ? <Spinner className="w-5 h-5 text-white" /> : complexInputRecorder.isRecording ? <StopIcon className="w-5 h-5" /> : <MicIcon className="w-5 h-5" />}
                                                                    </button>
                                                                </div>
                                                                {agenticErrors[batch.id] && <p className="text-red-500 dark:text-red-400 text-sm mt-2">{agenticErrors[batch.id]}</p>}
                                                                <div className="mt-4 flex justify-end gap-2">
                                                                    <button onClick={() => setComplexGeneratorVisibleForBatchId(null)} className="bg-slate-200 text-slate-800 font-bold py-2 px-4 rounded-lg hover:bg-slate-300 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500">
                                                                        Cancel
                                                                    </button>
                                                                    <button onClick={() => handleGenerateComplexImpression(batch.id)} disabled={isTranscribingComplex[batch.id]} className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                                                                        Generate Impression
                                                                    </button>
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                ) : null}

                                                {batch.chat && (
                                                    <ChatInterface
                                                        history={batch.chatHistory || []}
                                                        isChatting={!!batch.isChatting}
                                                        onSendMessage={(message) => handleSendMessage(batch.id, message)}
                                                        selectedModel={batch.selectedModel}
                                                    />
                                                )}

                                                 <div className="mt-8 pt-6 border-t dark:border-slate-700 flex flex-wrap justify-center items-center gap-2.5 sm:gap-3 w-full">
                                                    {continuationState.status === 'idle' || continuationState.batchId !== batch.id ? (
                                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap justify-center items-center gap-2.5 sm:gap-3 w-full">
                                                            <button
                                                                onClick={() => handleStartContinue(batch.id)}
                                                                disabled={!batch.findings}
                                                                className="bg-emerald-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-opacity-50 transition-all shadow-sm w-full lg:w-auto disabled:bg-emerald-300 dark:disabled:bg-emerald-900/40 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-h-[44px]"
                                                            >
                                                                <MicPlusIcon className="w-4 h-4" />
                                                                Continue Dictation
                                                            </button>
                                                            <button
                                                                onClick={() => setComplexGeneratorVisibleForBatchId(batch.id)}
                                                                className="bg-purple-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-50 transition-all shadow-sm w-full lg:w-auto flex items-center justify-center gap-2 min-h-[44px]"
                                                            >
                                                                <BrainIcon className="w-4 h-4" />
                                                                Complex Impression
                                                            </button>
                                                            {expertNotesForBatches[batch.id] && (
                                                                <button
                                                                    onClick={() => handleDownloadExpertNotes(batch.id)}
                                                                    className="bg-teal-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-opacity-50 transition-all shadow-sm w-full lg:w-auto flex items-center justify-center gap-2 min-h-[44px]"
                                                                >
                                                                    <DownloadIcon className="w-4 h-4" />
                                                                    Download Expert Notes
                                                                </button>
                                                            )}
                                                            <button
                                                                onClick={() => handleDownload(batch)}
                                                                disabled={!batch.audioBlobs.length}
                                                                className="bg-slate-600 text-white font-bold py-2.5 px-5 rounded-xl hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-opacity-50 transition-all shadow-sm disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed w-full lg:w-auto flex items-center justify-center gap-2 min-h-[44px]"
                                                            >
                                                                <DownloadIcon className="w-4 h-4" />
                                                                Download Audio
                                                            </button>
                                                        </div>
                                                    ) : null}
                                                    {continuationState.status === 'recording' && continuationState.batchId === batch.id && (
                                                        <div className="w-full flex items-center justify-center gap-4 bg-red-100 dark:bg-red-900/20 p-2 rounded-lg">
                                                            <div className="flex items-center gap-2">
                                                                <div className="w-3 h-3 bg-red-500 rounded-full animate-ping"></div>
                                                                <span className="font-semibold text-red-700 dark:text-red-300">Recording...</span>
                                                            </div>
                                                            <button
                                                                onClick={handleStopContinue}
                                                                className="flex items-center justify-center gap-2 bg-red-600 text-white font-bold py-1 px-4 rounded-lg hover:bg-red-700"
                                                                aria-label="Stop continuing dictation for this batch"
                                                            >
                                                                <StopIcon className="w-5 h-5"/>
                                                                Stop
                                                            </button>
                                                        </div>
                                                    )}
                                                    {continuationState.status === 'processing' && continuationState.batchId === batch.id && (
                                                        <div className="w-full flex items-center justify-center gap-2 bg-slate-100 dark:bg-slate-700 p-2 rounded-lg">
                                                            <Spinner className="w-6 h-6"/>
                                                            <span className="font-semibold text-slate-700 dark:text-slate-300">Processing...</span>
                                                        </div>
                                                    )}
                                                </div>
                                                {continuationState.error && continuationState.batchId === batch.id && (
                                                    <p className="text-center text-red-500 dark:text-red-400 mt-4" role="alert">{continuationState.error}</p>
                                                )}
                                            </>
                                        ) : (
                                            <div className="p-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30 rounded-xl text-center">
                                                <div className="flex justify-center mb-2">
                                                    <div className="p-2.5 bg-red-100 dark:bg-red-900/40 rounded-full text-red-600 dark:text-red-400">
                                                        <WarningIcon className="w-6 h-6" />
                                                    </div>
                                                </div>
                                                <h4 className="font-bold text-red-700 dark:text-red-300 text-base">An error occurred during processing</h4>
                                                <p className="text-sm text-red-600 dark:text-red-400 mt-1 max-w-xl mx-auto font-medium">{batch.error || 'An unexpected error occurred.'}</p>
                                                <p className="text-xs text-slate-600 dark:text-slate-300 mt-2">
                                                    {batch.audioBlobs.length > 0 
                                                        ? 'Your audio is preserved. You can download the recorded audio file, re-upload an audio file to replace it, or choose a different AI model and retry.' 
                                                        : 'You can upload an audio file directly or record new audio for this batch.'}
                                                </p>

                                                {/* Model selector for reprocessing */}
                                                <div className="mt-4 p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 flex flex-col sm:flex-row items-center justify-between gap-3 max-w-lg mx-auto shadow-sm">
                                                    <label htmlFor={`error-model-select-${batch.id}`} className="text-sm font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                                                        Process with AI Model:
                                                    </label>
                                                    <select
                                                        id={`error-model-select-${batch.id}`}
                                                        value={batch.selectedModel}
                                                        onChange={(e) => updateBatchModel(batch.id, e.target.value)}
                                                        className="bg-slate-50 border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 w-full sm:w-auto dark:bg-slate-700 dark:border-slate-600 dark:text-white"
                                                    >
                                                        {AVAILABLE_MODELS.map((model) => (
                                                            <option key={model.value} value={model.value}>{model.label}</option>
                                                        ))}
                                                    </select>
                                                </div>

                                                {/* Action buttons */}
                                                <div className="mt-5 flex flex-wrap justify-center items-center gap-3">
                                                    {batch.audioBlobs.length > 0 && (
                                                        <button
                                                            onClick={() => handleReprocessBatch(batch.id)}
                                                            className="flex items-center gap-2 bg-blue-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors shadow text-sm"
                                                        >
                                                            Retry Processing
                                                        </button>
                                                    )}

                                                    {batch.audioBlobs.length > 0 && (
                                                        <button
                                                            onClick={() => handleDownload(batch)}
                                                            className="flex items-center gap-2 bg-slate-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-opacity-50 transition-colors shadow text-sm"
                                                        >
                                                            <DownloadIcon className="w-4 h-4" /> Download Audio File
                                                        </button>
                                                    )}

                                                    <button
                                                        onClick={() => triggerUpload(batch.id, true)}
                                                        className="flex items-center gap-2 bg-emerald-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-opacity-50 transition-colors shadow text-sm"
                                                    >
                                                        <UploadIcon className="w-4 h-4" /> Re-upload & Replace Audio
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                     </div>
                                )}
                             </div>
                        ))}
                     </div>
                </div>
            )}
            <PasteTextModal
                isOpen={isPasteModalOpen}
                onClose={() => {
                    setIsPasteModalOpen(false);
                    setPasteModalTargetBatchId(null);
                }}
                targetBatchName={batches.find(b => b.id === pasteModalTargetBatchId)?.name}
                mode={pasteModalTargetBatchId ? 'append' : 'batch'}
                initialText={clipboardPastedText}
                onAppendToBatch={(files) => {
                    handlePasteBatches(files);
                }}
                onProcessBatch={(files) => {
                    handlePasteBatches(files);
                }}
            />

            {multiSelectMode && (
                <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 dark:bg-slate-800/95 text-white rounded-full shadow-2xl border border-slate-700/80 flex items-center gap-2.5 sm:gap-3 px-3.5 sm:px-4 py-2 transition-all duration-300 ease-in-out backdrop-blur-xs">
                  <div className="flex items-center gap-1.5">
                    <CheckSquare className="w-4 h-4 text-blue-400 shrink-0" />
                    <p className="text-xs sm:text-sm font-semibold whitespace-nowrap">Multi-select Active</p>
                  </div>
                  <div className="h-4 w-[1px] bg-slate-700"></div>
                  <label htmlFor="multi-select-toggle-batch" className="flex items-center cursor-pointer select-none">
                    <span className="mr-2 text-xs font-semibold text-slate-400">Done</span>
                    <div className="relative">
                      <input 
                        type="checkbox" 
                        id="multi-select-toggle-batch" 
                        className="sr-only peer" 
                        checked={multiSelectMode}
                        onChange={() => {
                          setMultiSelectMode(false);
                          setSelections({});
                          setSelectionSnippets({});
                        }}
                      />
                      <div className="w-9 h-5 bg-blue-600 rounded-full transition-colors border border-blue-500"></div>
                      <div className="absolute left-1 top-0.5 bg-white w-4 h-4 rounded-full transition-transform translate-x-4 shadow-xs"></div>
                    </div>
                  </label>
                </div>
            )}
        </div>
    );
};

export { BatchProcessor };
