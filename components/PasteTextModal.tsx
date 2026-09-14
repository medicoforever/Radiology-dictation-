import React, { useState, useRef, useEffect } from 'react';
import { 
  ClipboardPaste, 
  Plus, 
  Trash2, 
  FileText, 
  Upload, 
  X, 
  Layers, 
  ArrowRight, 
  Check, 
  Split,
  Sparkles,
  FileCode
} from 'lucide-react';

export interface TextSnippet {
  id: string;
  title: string;
  text: string;
}

export interface PasteTextModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Called when user wants to process as single report (combining all items)
  onProcessSingle?: (files: File[]) => void;
  // Called when user wants to process items as separate batches
  onProcessBatch?: (files: File[]) => void;
  // When opened from an existing batch to attach or append
  targetBatchName?: string;
  onAppendToBatch?: (files: File[]) => void;
  // When opened from ResultsDisplay to append to active report
  onAppendToActiveReport?: (text: string) => void;
  // Mode context
  mode?: 'single' | 'batch' | 'append';
  initialText?: string;
}

export const PasteTextModal: React.FC<PasteTextModalProps> = ({
  isOpen,
  onClose,
  onProcessSingle,
  onProcessBatch,
  targetBatchName,
  onAppendToBatch,
  onAppendToActiveReport,
  mode = 'single',
  initialText = '',
}) => {
  const [snippets, setSnippets] = useState<TextSnippet[]>([
    { id: '1', title: 'Dictation Text 1', text: initialText }
  ]);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [copiedNotification, setCopiedNotification] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isAppending = mode === 'append' || Boolean(targetBatchName) || Boolean(onAppendToActiveReport);

  // Sync initialText if provided
  useEffect(() => {
    if (initialText) {
      setSnippets([{ id: '1', title: 'Pasted Dictation 1', text: initialText }]);
    }
  }, [initialText]);

  // Reset when modal opens
  useEffect(() => {
    if (isOpen && !initialText) {
      setSnippets([{ id: '1', title: 'Dictation Text 1', text: '' }]);
      setAttachedFiles([]);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAddSnippet = () => {
    const nextIdx = snippets.length + 1;
    setSnippets(prev => [
      ...prev,
      { id: String(Date.now()), title: `Dictation Text ${nextIdx}`, text: '' }
    ]);
  };

  const handleRemoveSnippet = (id: string) => {
    if (snippets.length <= 1) {
      setSnippets([{ id: '1', title: 'Dictation Text 1', text: '' }]);
      return;
    }
    setSnippets(prev => prev.filter(s => s.id !== id));
  };

  const handleUpdateSnippet = (id: string, field: 'title' | 'text', val: string) => {
    setSnippets(prev => prev.map(s => s.id === id ? { ...s, [field]: val } : s));
  };

  const handlePasteFromClipboard = async (id: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const clipText = await navigator.clipboard.readText();
        if (clipText) {
          handleUpdateSnippet(id, 'text', clipText);
          showToast('Text pasted from clipboard!');
        } else {
          showToast('Clipboard is empty.');
        }
      } else {
        showToast('Clipboard access not supported. Use Ctrl+V inside the box.');
      }
    } catch {
      showToast('Please press Ctrl+V directly into the text box.');
    }
  };

  const showToast = (msg: string) => {
    setCopiedNotification(msg);
    setTimeout(() => setCopiedNotification(null), 2500);
  };

  // Helper to split a multi-case text by dividers
  const handleSplitCases = (id: string) => {
    const snippet = snippets.find(s => s.id === id);
    if (!snippet || !snippet.text.trim()) return;

    // Check for common dividers: "---", "Case 2", "CASE 2", double page breaks, or "Patient:"
    const raw = snippet.text;
    const parts = raw.split(/(?:\n\s*---\s*\n|\n\s*===+\s*\n|\n\s*(?:CASE|Case)\s+\d+[:\.]?|\n\s*STUDY\s+\d+[:\.]?)/gi)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    if (parts.length > 1) {
      const newSnippets: TextSnippet[] = parts.map((part, idx) => ({
        id: String(Date.now() + idx),
        title: `${snippet.title || 'Case'} Part ${idx + 1}`,
        text: part
      }));
      setSnippets(prev => {
        const withoutOld = prev.filter(s => s.id !== id);
        return [...withoutOld, ...newSnippets];
      });
      showToast(`Split into ${parts.length} distinct cases!`);
    } else {
      showToast('No case divider found (e.g. "---" or "Case 2").');
    }
  };

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setAttachedFiles(prev => [...prev, ...files]);
      showToast(`Attached ${files.length} file(s)!`);
    }
    if (e.target) e.target.value = '';
  };

  const handleRemoveFile = (idx: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const convertSnippetsToFiles = (): File[] => {
    const validSnippets = snippets.filter(s => s.text.trim().length > 0);
    return validSnippets.map((s, idx) => {
      const safeTitle = (s.title.trim() || `Pasted_Dictation_${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `${safeTitle}.txt`;
      return new File([s.text], filename, { type: 'text/plain' });
    });
  };

  const totalTextItems = snippets.filter(s => s.text.trim().length > 0).length;
  const totalItems = totalTextItems + attachedFiles.length;

  const handleSubmitSingle = () => {
    const textFiles = convertSnippetsToFiles();
    const allFiles = [...textFiles, ...attachedFiles];
    if (allFiles.length === 0) {
      showToast('Please paste text or attach a file first.');
      return;
    }

    if (onAppendToActiveReport) {
      const combinedText = snippets
        .map(s => s.text.trim())
        .filter(Boolean)
        .join('\n\n');
      onAppendToActiveReport(combinedText);
      onClose();
      return;
    }

    if (onProcessSingle) {
      onProcessSingle(allFiles);
    }
    onClose();
  };

  const handleSubmitBatch = () => {
    const textFiles = convertSnippetsToFiles();
    const allFiles = [...textFiles, ...attachedFiles];
    if (allFiles.length === 0) {
      showToast('Please paste text or attach a file first.');
      return;
    }

    if (onProcessBatch) {
      onProcessBatch(allFiles);
    }
    onClose();
  };

  const handleSubmitAppendBatch = () => {
    const textFiles = convertSnippetsToFiles();
    const allFiles = [...textFiles, ...attachedFiles];
    if (allFiles.length === 0) {
      showToast('Please paste text or attach a file first.');
      return;
    }

    if (onAppendToBatch) {
      onAppendToBatch(allFiles);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-200">
      <div 
        className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 max-w-2xl w-full my-auto flex flex-col max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700/80 flex items-center justify-between shrink-0 bg-slate-50/70 dark:bg-slate-900/40">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-xl shadow-xs">
              <ClipboardPaste className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <span>
                  {isAppending 
                    ? targetBatchName ? `Append Text to "${targetBatchName}"` : 'Append Text to Report'
                    : 'Paste Dictation & Text'}
                </span>
                {totalItems > 0 && (
                  <span className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-300 px-2 py-0.5 rounded-full font-semibold">
                    {totalItems} {totalItems === 1 ? 'item' : 'items'}
                  </span>
                )}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Paste any number of text dictations, PACS impressions, clinical notes, and attach files.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Toast Notification */}
        {copiedNotification && (
          <div className="bg-blue-600 text-white text-xs font-semibold py-1.5 px-4 text-center animate-in slide-in-from-top-2 duration-150">
            {copiedNotification}
          </div>
        )}

        {/* Scrollable Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-grow">
          {snippets.map((snippet, idx) => {
            const charCount = snippet.text.length;
            const wordCount = snippet.text.trim() ? snippet.text.trim().split(/\s+/).length : 0;
            return (
              <div 
                key={snippet.id}
                className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/30 space-y-2.5 transition-all focus-within:border-blue-500/80 focus-within:ring-2 focus-within:ring-blue-500/20 shadow-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-grow">
                    <span className="text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800/60 px-2 py-0.5 rounded-md shrink-0">
                      #{idx + 1}
                    </span>
                    <input
                      type="text"
                      value={snippet.title}
                      onChange={(e) => handleUpdateSnippet(snippet.id, 'title', e.target.value)}
                      placeholder={`Dictation Text ${idx + 1}`}
                      className="text-xs sm:text-sm font-semibold text-slate-800 dark:text-slate-100 bg-transparent border-b border-dashed border-slate-300 dark:border-slate-600 focus:border-blue-500 focus:outline-none py-0.5 px-1 w-full max-w-xs"
                    />
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handlePasteFromClipboard(snippet.id)}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-750 transition-colors shadow-2xs font-medium"
                      title="Paste directly from your clipboard"
                    >
                      <ClipboardPaste className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                      <span className="hidden sm:inline">Paste</span>
                    </button>

                    {snippet.text.includes('---') && (
                      <button
                        type="button"
                        onClick={() => handleSplitCases(snippet.id)}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 text-amber-800 dark:text-amber-300 hover:bg-amber-100 transition-colors font-medium"
                        title="Split this snippet into multiple cases by '---'"
                      >
                        <Split className="w-3 h-3" />
                        <span className="hidden sm:inline">Split</span>
                      </button>
                    )}

                    {snippets.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveSnippet(snippet.id)}
                        className="p-1 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                        title="Delete this text snippet"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="relative">
                  <textarea
                    rows={4}
                    value={snippet.text}
                    onChange={(e) => handleUpdateSnippet(snippet.id, 'text', e.target.value)}
                    placeholder="Paste radiology dictation text, clinical history, MRI/CT impressions, EHR findings, or transcription draft here..."
                    className="w-full text-xs sm:text-sm p-3 rounded-lg border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 leading-relaxed resize-y font-sans"
                  />
                  
                  <div className="flex justify-between items-center text-[11px] text-slate-400 dark:text-slate-500 mt-1 px-1">
                    <span>
                      {wordCount} {wordCount === 1 ? 'word' : 'words'} • {charCount} characters
                    </span>
                    {snippet.text.trim().length === 0 && (
                      <span className="italic text-slate-400">
                        Tip: Ctrl+V to paste or click Paste button
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add Another Text Snippet & Attach File Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={handleAddSnippet}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-dashed border-blue-400 dark:border-blue-600/70 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 font-semibold text-xs sm:text-sm transition-all shadow-2xs"
            >
              <Plus className="w-4 h-4" />
              <span>Add Another Text Snippet (+{snippets.length + 1})</span>
            </button>

            <div className="flex items-center gap-2">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileAttach}
                className="hidden"
                accept="audio/*,video/*,image/*,.pdf,.doc,.docx,.txt,.csv,.rtf,.webm,.mp4,.mp3,.wav,.m4a,.png,.jpg,.jpeg"
                multiple
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-750 font-medium text-xs transition-colors shadow-2xs"
                title="Attach audio, PDF, scans, or DOCX alongside your pasted text"
              >
                <Upload className="w-3.5 h-3.5 text-slate-500" />
                <span>Attach File(s)</span>
              </button>
            </div>
          </div>

          {/* Attached Files List */}
          {attachedFiles.length > 0 && (
            <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 space-y-1.5">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                <span>Attached Supporting Files ({attachedFiles.length}):</span>
              </div>
              <div className="max-h-28 overflow-y-auto space-y-1 text-xs divide-y divide-slate-100 dark:divide-slate-800">
                {attachedFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1 px-1 gap-2">
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                      <FileCode className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                      <span className="truncate">{file.name}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(idx)}
                      className="text-slate-400 hover:text-red-500 p-0.5 rounded transition-colors"
                      title="Remove file"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:p-5 border-t border-slate-200 dark:border-slate-700/80 bg-slate-50/80 dark:bg-slate-900/60 shrink-0 flex flex-col sm:flex-row items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 font-semibold text-xs sm:text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>

          <div className="w-full sm:w-auto flex flex-col sm:flex-row items-center gap-2.5">
            {targetBatchName && onAppendToBatch ? (
              <button
                type="button"
                onClick={handleSubmitAppendBatch}
                disabled={totalItems === 0}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Check className="w-4 h-4" />
                <span>Append to {targetBatchName}</span>
              </button>
            ) : onAppendToActiveReport ? (
              <button
                type="button"
                onClick={handleSubmitSingle}
                disabled={totalItems === 0}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Check className="w-4 h-4" />
                <span>Append Text to Report</span>
              </button>
            ) : mode === 'batch' ? (
              <button
                type="button"
                onClick={handleSubmitBatch}
                disabled={totalItems === 0}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Layers className="w-4 h-4" />
                <span>Add {totalItems} Batch{totalItems > 1 ? 'es' : ''}</span>
              </button>
            ) : totalItems > 1 ? (
              <>
                <button
                  type="button"
                  onClick={handleSubmitBatch}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl border-2 border-blue-500/60 hover:border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-bold text-xs sm:text-sm transition-all flex items-center justify-center gap-1.5"
                  title="Create individual reports for each pasted text/file"
                >
                  <Layers className="w-4 h-4" />
                  <span>Create {totalItems} Batches</span>
                </button>
                <button
                  type="button"
                  onClick={handleSubmitSingle}
                  className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm shadow-md transition-all flex items-center justify-center gap-2"
                  title="Combine all pasted texts and files into one report"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Combine into Single Report</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleSubmitSingle}
                disabled={totalItems === 0}
                className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>Process Dictation Text</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PasteTextModal;
