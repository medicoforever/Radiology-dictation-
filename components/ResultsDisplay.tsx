import React, { useState, useEffect, useRef } from 'react';
import ChatInterface from './ChatInterface';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { continueAudioDictation, modifyFindingWithAudio, modifyReportWithAudio, runComplexImpressionGeneration, transcribeAudioForPrompt, detectAndExtractTemplate } from '../services/geminiService';
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
import { AVAILABLE_MODELS } from '../constants';
import WarningIcon from './icons/WarningIcon';
import BrainIcon from './icons/BrainIcon';
import MicIcon from './icons/MicIcon';
import DownloadIcon from './icons/DownloadIcon';
import TrashIcon from './icons/TrashIcon';
import PauseIcon from './icons/PauseIcon';
import ResumeIcon from './icons/ResumeIcon';
import { mergeAudioBlobs, triggerAudioDownload } from '../services/audioMerger';
import { stopRepeatingInterruptedAlert } from '../services/soundService';
import RichTextReportEditor from './RichTextReportEditor';
import type { DocxTemplateData } from './ui/CustomPromptInput';

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
  onReprocess: () => void;
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
}



const parseStructuredFinding = (finding: string) => {
  const parts = finding.split('###');
  if (parts.length > 1 && parts[0].trim() !== '') {
    return {
      isStructured: true,
      title: parts[0],
      points: parts.slice(1).filter(p => p.trim() !== ''),
    };
  }
  return {
    isStructured: false,
    title: finding,
    points: [],
  };
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

  const activeTemplateName = customDocx?.name
    ? customDocx.name.replace(/\.[^/.]+$/, '')
    : (detectedTemplate.templateName || (customImages && customImages.length > 0
      ? 'Reference Image Template'
      : (customPrompt?.match(/normal (.*?) report template/i)?.[1] || 'Radiology Template')));

  // State to toggle RTF editor view (defaults to open in template merge mode, or user toggleable)
  const [showRtfEditor, setShowRtfEditor] = useState<boolean>(true);

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
    unsavedSession: modifyUnsavedSession,
    recoverUnsavedSession: recoverModifySession,
    discardUnsavedSession: discardModifySession,
    getUnsavedSessionBlob: getModifyRecoveredBlob,
  } = modificationRecorder;
  const [isRecoveringModify, setIsRecoveringModify] = useState(false);

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
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [undoState, setUndoState] = useState<string[] | null>(null);
  const [isMakingSelection, setIsMakingSelection] = useState<boolean>(false);

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
        const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
        const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
        const isImpression = isStructured && title.trim().toUpperCase() === 'IMPRESSION:';
        const isItalic = !isStructured && cleanFinding.startsWith('*') && cleanFinding.endsWith('*');

        if (isTitle) {
          acc.plain.push(cleanFinding);
          acc.html.push(`<p style="text-align:center;"><strong><u>${cleanFinding}</u></strong></p>`);
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
    const notificationText = success
      ? `Copied ${indices.size} finding${indices.size > 1 ? 's' : ''}!`
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
    const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
    const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
    const isImpression = isStructured && title.trim().toUpperCase() === 'IMPRESSION:';
    const isItalic = !isStructured && cleanFinding.startsWith('*') && cleanFinding.endsWith('*');

    let plainText: string;
    let htmlText: string;

    if (isTitle) {
      plainText = cleanFinding;
      htmlText = `<p style="text-align:center;"><strong><u>${cleanFinding}</u></strong></p>`;
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

    const allTextPlain = findings.map(f => {
      const isBold = f.includes('BOLD::');
      const cleanFinding = f.replace(/BOLD::/g, '');
      const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
      const isImpression = isStructured && title.trim().toUpperCase() === 'IMPRESSION:';

      if (isImpression) {
          return `${title.toUpperCase()}\n${points.map(p => `• ${p}`).join('\n')}`;
      }
      if (isStructured) {
        return [title, ...points].join('\n');
      }
      if (cleanFinding.startsWith('*') && cleanFinding.endsWith('*')) {
        return cleanFinding.slice(1, -1);
      }
      return cleanFinding;
    }).join('\n\n');

    const allTextHtml = findings.map(f => {
      const isBold = f.includes('BOLD::');
      const cleanFinding = f.replace(/BOLD::/g, '');
      const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
      const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
      const isImpression = isStructured && title.trim().toUpperCase() === 'IMPRESSION:';
      
      if (isTitle) {
          return `<p style="text-align:center;"><strong><u>${cleanFinding}</u></strong></p>`;
      }
      if (isImpression) {
          return `<p><strong style="text-decoration: underline;">${title.toUpperCase()}</strong></p><ul>${points.map(p => `<li><strong>${p}</strong></li>`).join('')}</ul>`;
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
        setIsAllCopied(true);
        setTimeout(() => setIsAllCopied(false), 2000);
        showNotification('Copied all!');
    } else {
        showNotification('Copy failed!');
    }
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
  
  const handleRecordNew = () => {
    setExpertNotes(null);
    onReset();
  }

  const handleDownloadHTML = () => {
    if (!findings || findings.length === 0) return;
    try {
      const htmlContent = generateSingleDictationHTML(findings);
      const blob = new Blob([htmlContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      document.body.appendChild(a);
      a.style.display = 'none';
      a.href = url;
      a.download = 'radiology-report.html';
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
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
    
    const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
    const textForEditing = isStructured ? [title, ...points].join('\n') : cleanFinding;
    
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
      }
      
      if(isBold && !newText.startsWith('BOLD::')) {
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
      await modificationRecorder.startRecording();
      setModificationState('recording');
    } catch (err) {
      console.warn("Failed to start modification recording:", err);
      setModificationState('idle');
    }
  };

  const handleStopModification = async () => {
      const audioBlob = await modificationRecorder.stopRecording();
      if (audioBlob && audioBlob.size > 0) {
          setModificationState('processing');
          try {
              setUndoState(findings);
              const newFindings = await modifyReportWithAudio(findings, audioBlob, selectedModel, customPrompt, customImages);
              onAllFindingsUpdate(newFindings);
              setModificationState('idle');
          } catch (err) {
              const message = err instanceof Error ? err.message : 'An unknown error occurred.';
              setModificationError(message);
              setModificationState('idle');
          }
      } else {
          setModificationState('idle');
      }
      if (isLive) onResumeLive?.();
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
        setModificationState('processing');
        const modifiedFindings = await modifyReportWithAudio(findings, recoveredBlob, selectedModel, customPrompt, customImages);
        onAllFindingsUpdate(modifiedFindings);
        setModificationState('idle');
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
                    const transcript = await transcribeAudioForPrompt(audioBlob);
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

    const handleDownloadExpertNotes = () => {
        if (!expertNotes) return;
        
        // Simple markdown to HTML conversion for Word-compatible file
        let htmlContent = expertNotes
          .replace(/^## (.*$)/gim, '<h2>$1</h2>')
          .replace(/^### (.*$)/gim, '<h3>$1</h3>')
          .replace(/\n/g, '<br />');
    
        const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' "+
                   "xmlns:w='urn:schemas-microsoft-com:office:word' "+
                   "xmlns='http://www.w3.org/TR/REC-html40'>"+
                   "<head><meta charset='utf-8'><title>Expert Notes</title></head><body>";
        const footer = "</body></html>";
        const source = header + htmlContent + footer;
    
        const fileBlob = new Blob([source], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const url = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'expert-notes.docx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

  // --- Drag and Drop Handlers ---
  const handleToggleReorderMode = () => {
    setUndoState(null);
    setReorderMode(prev => !prev);
    setMergeMode(false);
  };
  const handleToggleMergeMode = () => {
    setUndoState(null);
    setMergeMode(prev => !prev);
    setReorderMode(false);
  };

  // Reorder
  const handleReorderDragStart = (index: number) => {
    dragItem.current = index;
    setDraggedIndex(index);
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

  // Merge
  const handleMergeDragStart = (e: React.DragEvent, index: number) => {
      e.dataTransfer.setData("sourceIndex", index.toString());
      setDraggedIndex(index);
  };
  const handleMergeDrop = (e: React.DragEvent, targetIndex: number) => {
      e.preventDefault();
      const sourceIndexStr = e.dataTransfer.getData("sourceIndex");
      if (sourceIndexStr === null) return;
      const sourceIndex = parseInt(sourceIndexStr, 10);

      if (sourceIndex === targetIndex) {
          setDragOverIndex(null);
          setDraggedIndex(null);
          return;
      }
      
      // Store pre-merge state for undo
      setUndoState(findings);

      const sourceFinding = findings[sourceIndex];
      const targetFinding = findings[targetIndex];
      
      const mergedText = targetFinding + ' ' + sourceFinding;
      
      const newFindings = findings
          .map((finding, index) => index === targetIndex ? mergedText : finding)
          .filter((_, index) => index !== sourceIndex);
          
      onAllFindingsUpdate(newFindings);
      
      setDragOverIndex(null);
      setDraggedIndex(null);
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
        <div className="fixed bottom-4 right-4 bg-slate-800 text-white text-sm font-bold py-2 px-4 rounded-lg shadow-lg z-50 transition-all duration-300 ease-in-out" role="alert">
          {copyNotification.text}
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
        <div className="bg-slate-100 dark:bg-slate-900/50 p-3 rounded-lg mb-4 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <label htmlFor="model-select-reprocess" className="text-sm font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">Process again with:</label>
            <select 
                id="model-select-reprocess"
                value={selectedModel}
                onChange={(e) => onModelChange(e.target.value)}
                className="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 w-full dark:bg-slate-700 dark:border-slate-600 dark:text-white"
                aria-label="Select AI model for reprocessing"
            >
                {AVAILABLE_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>{model.label}</option>
                ))}
            </select>
          </div>
          <button
              onClick={() => {
                setExpertNotes(null);
                setUndoState(findings);
                onReprocess();
              }}
              className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors w-full sm:w-auto flex-shrink-0"
            >
              Update Transcript
            </button>
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
                      ? `Merged into institution Word document: "${customDocx.name}". Edit formatting directly with live RTF tools or export to Word (.doc) / RTF.` 
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
        <div className="flex flex-wrap justify-between items-center gap-2 mb-4 p-2 bg-slate-100/70 dark:bg-slate-800/70 rounded-xl border border-slate-200/80 dark:border-slate-700/80">
            <div className="flex items-center gap-2">
              <span className="text-xs sm:text-sm font-semibold text-slate-600 dark:text-slate-300">
                {findings.filter(f => f && f.trim()).length} findings
              </span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              {undoState && (
                <button
                  onClick={handleUndo}
                  className="text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg bg-yellow-400 text-yellow-900 hover:bg-yellow-500 transition-colors shadow-sm"
                  aria-label="Undo last modification"
                >
                  Undo
                </button>
              )}
              <button
                  onClick={handleToggleMergeMode}
                  className={`text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm ${mergeMode ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'}`}
                >
                <MergeIcon className={`w-4 h-4 ${mergeMode ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`} />
                {mergeMode ? 'Done' : 'Merge'}
              </button>
              <button
                  onClick={handleToggleReorderMode}
                  className={`text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm ${reorderMode ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'}`}
                >
                <ReorderIcon className={`w-4 h-4 ${reorderMode ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`} />
                {reorderMode ? 'Done' : 'Reorder'}
              </button>
              <button
                onClick={handleCopyAll}
                className={`text-xs sm:text-sm font-semibold py-1.5 px-3.5 rounded-lg transition-colors shadow-sm flex items-center gap-1.5 ${isAllCopied ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
              >
                {isAllCopied ? 'Copied!' : 'Copy All'}
              </button>
            </div>
        </div>
      )}

      <div ref={findingsContainerRef} className="space-y-3 min-h-[150px]">
        {findings.map((finding, index) => {
          if (!finding && index === findings.length - 1) return null; // Don't render the trailing empty string from split
          
          const isBold = finding.includes('BOLD::');
          const cleanFinding = finding.replace(/BOLD::/g, '');
          const isTitle = cleanFinding.trim() === 'C.T.SCAN OF BRAIN (PLAIN)';
          const { isStructured, title, points } = parseStructuredFinding(cleanFinding);
          const isItalic = !isStructured && cleanFinding.startsWith('*') && cleanFinding.endsWith('*');
          const textToDisplay = isItalic ? cleanFinding.slice(1, -1) : isStructured ? title : cleanFinding;

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
              draggable={reorderMode || mergeMode}
              onDragStart={
                reorderMode ? () => handleReorderDragStart(index) :
                mergeMode ? (e) => handleMergeDragStart(e, index) :
                undefined
              }
              onDragEnd={
                reorderMode ? handleReorderDragEnd :
                mergeMode ? () => { setDraggedIndex(null); setDragOverIndex(null); } :
                undefined
              }
              onDragEnter={reorderMode ? () => (dragOverItem.current = index) : undefined}
              onDrop={mergeMode ? (e) => handleMergeDrop(e, index) : undefined}
              onDragOver={mergeMode || reorderMode ? (e) => e.preventDefault() : undefined}
              onDragEnterCapture={mergeMode ? (e) => { e.preventDefault(); setDragOverIndex(index); } : undefined}
              onDragLeaveCapture={mergeMode ? (e) => { e.preventDefault(); setDragOverIndex(null); } : undefined}
              className={`finding-item relative group p-3 pl-11 pr-28 sm:pr-24 border-l-4 rounded-r-lg transition-all duration-200 ${
                  isSelected && !isCurrentlyActive && !reorderMode && !mergeMode
                  ? 'bg-blue-100 border-blue-600 dark:bg-blue-900/30 dark:border-blue-500 shadow-md'
                  : isDragOverTarget
                  ? 'bg-green-100 border-green-500 dark:bg-green-900/30 dark:border-green-500 ring-2 ring-green-200 dark:ring-green-700'
                  : hasError
                  ? errorClasses[highestSeverity!]
                  : 'bg-slate-50 border-blue-500 dark:bg-slate-700/50 dark:border-blue-500'
              } ${!isCurrentlyActive && !reorderMode && !mergeMode ? 'hover:bg-blue-50 dark:hover:bg-slate-700' : ''} ${isDraggingThis ? 'opacity-50 bg-slate-200 dark:bg-slate-600' : ''} ${reorderMode ? 'cursor-grab' : ''} ${mergeMode ? 'cursor-copy' : ''}`}
              role={(reorderMode || mergeMode) ? 'listitem' : 'button'}
              aria-pressed={isSelected && !isCurrentlyActive}
              tabIndex={isCurrentlyActive ? -1 : 0}
              onClick={(reorderMode || mergeMode || isCurrentlyActive) ? undefined : () => handleFindingClick(index)}
              onKeyDown={(reorderMode || mergeMode || isCurrentlyActive) ? undefined : (e) => (e.key === ' ' || e.key === 'Enter') && handleFindingClick(index)}
            >
              {(reorderMode || mergeMode) ? (
                  <div className="absolute left-0 top-0 bottom-0 w-10 flex items-center justify-center" aria-label="Drag to reorder or merge">
                      {reorderMode && <ReorderIcon />}
                      {mergeMode && <MergeIcon className="w-5 h-5 text-slate-500 dark:text-slate-400" />}
                  </div>
              ) : (
                <div
                    onClick={(e) => !isCurrentlyActive && handleSelectionHandleClick(e, index)}
                    className={`absolute left-0 top-0 bottom-0 w-10 flex items-center justify-center touch-manipulation ${isCurrentlyActive ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-disabled={isCurrentlyActive}
                    aria-label="Toggle selection for this finding"
                >
                    <div className={`w-5 h-5 rounded-full border-2 transition-colors flex items-center justify-center text-[10px] font-bold ${isSelected && !isCurrentlyActive ? 'bg-blue-600 border-blue-600 dark:bg-blue-500 dark:border-blue-500 text-white' : 'border-slate-400 bg-white group-hover:border-blue-500 dark:border-slate-500 dark:bg-slate-600 dark:group-hover:border-blue-400'}`}>
                        {isSelected && !isCurrentlyActive && '✓'}
                    </div>
                </div>
              )}

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
                    className={`text-slate-700 dark:text-slate-200 whitespace-pre-wrap ${!isCurrentlyActive && !reorderMode && !mergeMode ? 'cursor-pointer' : 'cursor-default'} ${textContainerClasses}`}
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
        <div className="flex items-start sm:items-center gap-3 flex-col sm:flex-row">
            <MicScribbleIcon className="w-8 h-8 text-slate-600 dark:text-slate-300 flex-shrink-0" />
            <div className="flex-grow">
                <h4 className="font-semibold text-slate-800 dark:text-slate-200">Dictate Report Changes</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                    Use this to dictate global changes to the entire report, like 'remove all measurements' or 'rephrase the conclusion to be more concise'.
                </p>
            </div>
            <div className="sm:ml-4 flex-shrink-0 w-full sm:w-auto">
                {modificationState === 'idle' && (
                    <button onClick={handleStartModification} className="w-full bg-blue-100 text-blue-800 font-bold py-2 px-4 rounded-lg hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-900/80 transition-colors">
                        Start Dictating Changes
                    </button>
                )}
                {modificationState === 'recording' && (
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
                )}
                {modificationState === 'processing' && (
                    <div className="w-full flex items-center justify-center gap-2 bg-slate-100 dark:bg-slate-700 p-2 rounded-lg">
                        <Spinner className="w-6 h-6"/>
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Applying Changes...</span>
                    </div>
                )}
            </div>
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
          <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-800 text-white rounded-full shadow-lg flex items-center gap-4 px-5 py-2 transition-all duration-300 ease-in-out">
            <p className="text-sm font-semibold">Multi-select Mode</p>
            <label htmlFor="multi-select-toggle-single" className="flex items-center cursor-pointer">
              <span className="mr-2 text-sm font-medium text-slate-300">OFF</span>
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
                <div className="w-12 h-6 bg-slate-600 rounded-full peer-checked:bg-blue-600"></div>
                <div className="absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform peer-checked:translate-x-6"></div>
              </div>
              <span className="ml-2 text-sm font-medium">ON</span>
            </label>
          </div>
      )}
    </div>
  );
};

export default ResultsDisplay;
