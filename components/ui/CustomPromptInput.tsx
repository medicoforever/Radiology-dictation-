import React, { useState, useRef, useEffect, useMemo } from 'react';
import ChevronDownIcon from '../icons/ChevronDownIcon';
import SparklesIcon from '../icons/SparklesIcon';
import { useAudioRecorder } from '../../hooks/useAudioRecorder';
import { transcribeAudioForPrompt } from '../../services/geminiService';
import MicIcon from '../icons/MicIcon';
import StopIcon from '../icons/StopIcon';
import Spinner from './Spinner';
import TemplateSelectionModal from './TemplateSelectionModal';
import { REPORT_TEMPLATES, ReportTemplate } from '../../constants';
import ImageIcon from '../icons/ImageIcon';
import CloseIcon from '../icons/CloseIcon';
import TrashIcon from '../icons/TrashIcon';
import SearchIcon from '../icons/SearchIcon';
import { saveUserTemplate, getUserTemplates, deleteUserTemplate, UserTemplate } from '../../services/templateStorage';
import { parseDocx } from '../../services/docxService';
import { getTemplateDocxBase64 } from '../../services/builtInTemplates';
import { getUpcomingTemplate, setUpcomingTemplate, clearUpcomingTemplate, subscribeToUpcomingTemplate, UpcomingTemplateConfig } from '../../services/upcomingTemplateService';

export interface DocxTemplateData {
  name: string;
  data?: string;
  size: number;
  extractedText: string;
  extractedHtml?: string;
}

const CustomPromptInput: React.FC<{
  prompt: string;
  onPromptChange: (prompt: string) => void;
  className?: string;
  images?: Array<{ data: string; mimeType: string }>;
  onImagesChange?: (images: Array<{ data: string; mimeType: string }>) => void;
  customDocx?: DocxTemplateData | null;
  onCustomDocxChange?: (docx: DocxTemplateData | null) => void;
  isLiveMode?: boolean;
  selectedModel?: string;
}> = ({ prompt, onPromptChange, className, images = [], onImagesChange, customDocx, onCustomDocxChange, isLiveMode = false, selectedModel }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { isRecording, startRecording, stopRecording, error: recorderError } = useAudioRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounter = useRef(0);

  // Custom template management states
  const [savedTemplates, setSavedTemplates] = useState<UserTemplate[]>([]);
  const [activeTab, setActiveTab] = useState<'saved' | 'create' | 'builtin'>('saved');
  const [templateName, setTemplateName] = useState('');
  const [templateText, setTemplateText] = useState('');
  const [templateImages, setTemplateImages] = useState<Array<{ data: string; mimeType: string }>>([]);
  const [templateDocx, setTemplateDocx] = useState<DocxTemplateData | null>(null);
  const [isParsingDocx, setIsParsingDocx] = useState(false);
  const [docxParseError, setDocxParseError] = useState<string | null>(null);
  const [templateSaveSuccess, setTemplateSaveSuccess] = useState(false);
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null);
  const [appliedTemplateName, setAppliedTemplateName] = useState<string | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const [activeUpcoming, setActiveUpcoming] = useState<UpcomingTemplateConfig | null>(() => getUpcomingTemplate());
  const templateFileInputRef = useRef<HTMLInputElement>(null);
  const templateDocxInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setActiveUpcoming(getUpcomingTemplate());
    const unsub = subscribeToUpcomingTemplate(setActiveUpcoming);
    return unsub;
  }, []);

  // Load saved templates from browser database
  const loadSavedTemplates = async () => {
    try {
      const templates = await getUserTemplates();
      setSavedTemplates(templates);
    } catch (err) {
      console.warn('Failed to load user templates:', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadSavedTemplates();
    }
  }, [isOpen]);

  const handleMicClick = async () => {
    setTranscriptionError(null);
    if (isRecording) {
      setIsTranscribing(true);
      try {
        const audioBlob = await stopRecording();
        if (audioBlob && audioBlob.size > 0) {
          const transcript = await transcribeAudioForPrompt(audioBlob, selectedModel);
          const newPrompt = prompt ? `${prompt} ${transcript}` : transcript;
          onPromptChange(newPrompt);
        }
      } catch (err) {
        setTranscriptionError(err instanceof Error ? err.message : 'An unknown error occurred during transcription.');
      } finally {
        setIsTranscribing(false);
      }
    } else {
      await startRecording();
    }
  };

  const [savedSearchQuery, setSavedSearchQuery] = useState('');
  const [savedModalityFilter, setSavedModalityFilter] = useState<'ALL' | 'CT' | 'MRI' | 'USER'>('ALL');

  const filteredSavedTemplates = useMemo(() => {
    let list = savedTemplates;
    if (savedModalityFilter === 'CT') {
      list = list.filter(t => (t.modality || t.category || '').toUpperCase().includes('CT'));
    } else if (savedModalityFilter === 'MRI') {
      list = list.filter(t => (t.modality || t.category || '').toUpperCase().includes('MRI'));
    } else if (savedModalityFilter === 'USER') {
      list = list.filter(t => !t.isBuiltIn);
    }
    if (savedSearchQuery.trim()) {
      const q = savedSearchQuery.toLowerCase().trim();
      list = list.filter(t => t.name.toLowerCase().includes(q) || (t.text && t.text.toLowerCase().includes(q)));
    }
    return list;
  }, [savedTemplates, savedModalityFilter, savedSearchQuery]);

  const handleSelectTemplate = async (template: ReportTemplate) => {
    // 1. Tag prompt with exact template ID and quoted name for 100% deterministic detection
    const promptText = `[TEMPLATE_ID: ${template.id}] Use the normal "${template.name}" report template. Integrate my dictation and generate a new impression.`;
    onPromptChange(promptText);

    // 2. Fetch docxBase64 asynchronously if not already present
    let docx = template.docxBase64;
    if (!docx && template.id) {
      try {
        docx = await getTemplateDocxBase64(template.id);
      } catch (err) {
        console.warn('Error loading docx for template:', err);
      }
    }

    // 3. Always update customDocx so old template is guaranteed to be replaced!
    if (onCustomDocxChange) {
      const extractedText = template.lines ? template.lines.join('\n') : template.content;
      onCustomDocxChange({
        name: template.fileName || `${template.name}.docx`,
        data: docx || '',
        size: docx ? Math.round(docx.length * 0.75) : 0,
        extractedText,
      });
    }

    setAppliedTemplateName(`Built-in ${template.name}`);
    setIsModalOpen(false);
    setTimeout(() => setAppliedTemplateName(null), 4000);
  };

  const handleProcessDocxFile = async (file: File, isTemplateCreation = false) => {
    setIsParsingDocx(true);
    setDocxParseError(null);
    try {
      const parsed = await parseDocx(file);
      const docxData: DocxTemplateData = {
        name: parsed.fileName,
        size: parsed.fileSize,
        extractedText: parsed.text,
        extractedHtml: parsed.html,
      };

      if (isTemplateCreation) {
        setTemplateDocx(docxData);
        if (!templateName.trim()) {
          setTemplateName(parsed.fileName.replace(/\.[^/.]+$/, ''));
        }
        if (!templateText.trim()) {
          setTemplateText(parsed.text);
        }
      } else {
        if (onCustomDocxChange) {
          onCustomDocxChange(docxData);
        }
        onPromptChange(`Use the attached DOCX report template (${parsed.fileName}). Integrate my dictation findings into this template layout and synthesize a new impression.`);
        setAppliedTemplateName(`DOCX ${parsed.fileName}`);
        setTimeout(() => setAppliedTemplateName(null), 4000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to parse DOCX file.';
      setDocxParseError(msg);
    } finally {
      setIsParsingDocx(false);
    }
  };

  const processFiles = (files: FileList | null) => {
    if (files && files.length > 0) {
      // Check for DOCX files
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.name.toLowerCase().endsWith('.docx') || file.type.includes('wordprocessingml')) {
          handleProcessDocxFile(file, false);
          return;
        }
      }

      if (onImagesChange) {
        const newImagesPromises = Array.from(files).map(file => {
          return new Promise<{ data: string; mimeType: string } | null>(resolve => {
            if (file.type.startsWith('image/')) {
              const reader = new FileReader();
              reader.onloadend = () => {
                if (reader.result) {
                  const base64data = (reader.result as string).split(',')[1];
                  resolve({ data: base64data, mimeType: file.type });
                } else {
                  resolve(null);
                }
              };
              reader.readAsDataURL(file);
            } else {
              resolve(null);
            }
          });
        });

        Promise.all(newImagesPromises).then(newImages => {
          const validNewImages = newImages.filter((img): img is { data: string; mimeType: string } => img !== null);
          if (onImagesChange) {
            onImagesChange([...images, ...validNewImages]);
          }
        });
      }
    }
  };

  const processTemplateFiles = (files: FileList | null) => {
    if (files && files.length > 0) {
      // If docx file is uploaded, process it
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.name.toLowerCase().endsWith('.docx') || file.type.includes('wordprocessingml')) {
          handleProcessDocxFile(file, true);
          return;
        }
      }

      const newImagesPromises = Array.from(files).map(file => {
        return new Promise<{ data: string; mimeType: string } | null>(resolve => {
          if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onloadend = () => {
              if (reader.result) {
                const base64data = (reader.result as string).split(',')[1];
                resolve({ data: base64data, mimeType: file.type });
              } else {
                resolve(null);
              }
            };
            reader.readAsDataURL(file);
          } else {
            resolve(null);
          }
        });
      });

      Promise.all(newImagesPromises).then(newImages => {
        const validNewImages = newImages.filter((img): img is { data: string; mimeType: string } => img !== null);
        setTemplateImages(prev => [...prev, ...validNewImages]);
      });
    }
  };

  const handleTemplateImageSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    processTemplateFiles(event.target.files);
    if (event.target) {
      event.target.value = "";
    }
  };

  const handleTemplateDocxSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      handleProcessDocxFile(event.target.files[0], true);
    }
    if (event.target) {
      event.target.value = "";
    }
  };

  const handleRemoveImage = (indexToRemove: number) => {
    if (onImagesChange) {
      onImagesChange(images.filter((_, index) => index !== indexToRemove));
    }
  };

  const handleRemoveTemplateImage = (indexToRemove: number) => {
    setTemplateImages(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (!isLiveMode) {
        setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current--;
      if (dragCounter.current === 0) {
          setIsDraggingOver(false);
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
      setIsDraggingOver(false);
      if (!isLiveMode) {
          processFiles(e.dataTransfer.files);
      }
  };

  const handleSaveCustomTemplate = async () => {
    if (!templateName.trim()) {
      setTemplateSaveError('Please provide a name for the template.');
      return;
    }

    try {
      setTemplateSaveError(null);
      const newId = `template_${Date.now()}`;
      await saveUserTemplate({
        id: newId,
        name: templateName.trim(),
        text: templateText.trim() || (templateDocx?.extractedText || ''),
        images: templateImages,
        docxFile: templateDocx || undefined,
      });

      setTemplateSaveSuccess(true);
      setTemplateName('');
      setTemplateText('');
      setTemplateImages([]);
      setTemplateDocx(null);
      
      await loadSavedTemplates();
      setActiveTab('saved');

      setTimeout(() => {
        setTemplateSaveSuccess(false);
      }, 4000);
    } catch (err) {
      setTemplateSaveError('Failed to save the template to your browser.');
    }
  };

  const handleDeleteCustomTemplate = async (id: string) => {
    // Built-in templates cannot be deleted
    if (id.startsWith('builtin_') || id.startsWith('tpl_')) {
      setDeletingTemplateId(null);
      return;
    }
    try {
      await deleteUserTemplate(id);
      setDeletingTemplateId(null);
      await loadSavedTemplates();
    } catch (err) {
      console.warn('Failed to delete template:', err);
    }
  };

  const handleApplyCustomTemplate = async (template: UserTemplate, forUpcoming = false) => {
    const cleanId = template.id.startsWith('builtin_') ? template.id.replace('builtin_', '') : null;
    const isBuiltIn = template.isBuiltIn || Boolean(cleanId);

    let docxData = template.docxFile || null;

    if (isBuiltIn && cleanId && (!docxData || !docxData.data)) {
      try {
        const docxBase64 = await getTemplateDocxBase64(cleanId);
        if (docxBase64) {
          docxData = {
            name: `${template.name}.docx`,
            data: docxBase64,
            size: Math.round(docxBase64.length * 0.75),
            extractedText: template.text || '',
          };
        }
      } catch (err) {
        console.warn('Could not load docx for builtin template:', err);
      }
    }

    const tag = cleanId ? `[TEMPLATE_ID: ${cleanId}] ` : `[TEMPLATE: ${template.name}] `;
    const promptText = isBuiltIn && cleanId
      ? `${tag}Use the normal "${template.name}" report template. Integrate my dictation and generate a new impression.`
      : (template.text ? `${tag}${template.text}` : `${tag}Use the custom "${template.name}" report template. Integrate dictation into the layout and synthesize a new impression.`);

    if (forUpcoming) {
      await setUpcomingTemplate({
        ...template,
        docxBase64: docxData?.data,
        lines: template.lines,
        text: promptText,
      });
      setActiveUpcoming(getUpcomingTemplate());
    }

    onPromptChange(promptText);

    if (onImagesChange) {
      onImagesChange(template.images || []);
    }
    if (onCustomDocxChange) {
      onCustomDocxChange(docxData);
    }
    setAppliedTemplateName(forUpcoming ? `${template.name} (Active for Upcoming Reports)` : template.name);
    setTimeout(() => {
      setAppliedTemplateName(null);
    }, 4000);
  };

  return (
    <div className={`w-full ${className}`}>
      <TemplateSelectionModal 
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        templates={REPORT_TEMPLATES}
        onSelectTemplate={handleSelectTemplate}
      />
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex justify-between items-center p-3 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200/80 dark:hover:bg-slate-750 transition-colors border border-slate-200/55 dark:border-slate-700/50"
        aria-expanded={isOpen}
        aria-controls="custom-prompt-container"
      >
        <div className="flex items-center gap-2">
            <SparklesIcon className="w-5 h-5 text-yellow-500" />
            <span className="font-semibold text-slate-800 dark:text-slate-200 text-sm">Custom Instructions & Templates</span>
        </div>
        <ChevronDownIcon className={`w-5 h-5 text-slate-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div 
            id="custom-prompt-container" 
            className={`relative mt-2 space-y-4 p-4 border-2 border-dashed rounded-xl bg-white dark:bg-slate-900 transition-colors duration-200 ${
                isDraggingOver
                ? 'border-blue-500 bg-blue-50/40 dark:bg-blue-900/10'
                : 'border-slate-200 dark:border-slate-800'
            }`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {isDraggingOver && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/95 dark:bg-slate-900/95 pointer-events-none rounded-xl">
                    <ImageIcon className="w-12 h-12 text-blue-500 animate-bounce" />
                    <p className="mt-2 text-lg font-semibold text-blue-600 dark:text-blue-400">
                        Drop images here to add to current template
                    </p>
                </div>
            )}

          {appliedTemplateName && (
            <div className="p-3 text-xs text-green-700 bg-green-50 dark:bg-green-950/40 dark:text-green-300 rounded-lg border border-green-200 dark:border-green-900/50 flex justify-between items-center animate-fade-in shadow-sm">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                Template <strong>"{appliedTemplateName}"</strong> loaded! Instructions & reference images have been applied.
              </span>
              <button 
                type="button" 
                onClick={() => setAppliedTemplateName(null)}
                className="text-green-500 hover:text-green-700 font-bold ml-2 text-sm"
              >
                &times;
              </button>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              Active Instructions for AI
            </label>
            <div className="relative">
              <textarea
                value={prompt}
                onChange={(e) => onPromptChange(e.target.value)}
                placeholder="e.g., 'Always use metric units.' or 'Format findings for a chest CT report.'"
                className="w-full p-3 pr-12 border border-slate-200 dark:border-slate-700 rounded-lg text-sm bg-slate-50 text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none dark:bg-slate-950 dark:text-white dark:placeholder-slate-500 min-h-[80px]"
                rows={3}
                aria-label="Custom instructions for the AI model"
              />
              <button
                type="button"
                onClick={handleMicClick}
                disabled={isTranscribing}
                title={isRecording ? 'Stop recording custom instructions' : `Dictate custom instructions using ${selectedModel || 'selected AI model'}`}
                className={`absolute bottom-3 right-3 p-2 rounded-full text-white transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${
                  isRecording
                    ? 'bg-red-600 hover:bg-red-700 animate-pulse scale-105'
                    : 'bg-blue-600 hover:bg-blue-700 hover:scale-105'
                }`}
                aria-label={isRecording ? 'Stop dictating' : 'Dictate custom instructions'}
              >
                {isTranscribing ? (
                  <Spinner className="w-4 h-4 text-white" />
                ) : isRecording ? (
                  <StopIcon className="w-4 h-4" />
                ) : (
                  <MicIcon className="w-4 h-4" />
                )}
              </button>
            </div>
            {(recorderError || transcriptionError) && (
              <p className="text-xs text-red-500 mt-1">
                {recorderError || transcriptionError}
              </p>
            )}
          </div>

          {/* Current Reference Images View */}
          {!isLiveMode && images.length > 0 && (
            <div className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800 rounded-lg">
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2 flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-blue-500" />
                Active Template Reference Images ({images.length}):
              </p>
              <div className="flex flex-wrap gap-2">
                {images.map((img, index) => (
                  <div key={index} className="relative w-16 h-16 border border-slate-200 dark:border-slate-700 rounded-md p-0.5 bg-white dark:bg-slate-900">
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt={`Template preview ${index + 1}`}
                      className="object-contain w-full h-full rounded"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveImage(index)}
                      className="absolute -top-1.5 -right-1.5 bg-red-600 hover:bg-red-700 text-white rounded-full p-0.5 shadow-md transition-colors"
                      aria-label={`Remove image ${index + 1}`}
                    >
                      <CloseIcon className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Active DOCX Template Badge */}
          {customDocx && (
            <div className="p-3 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-lg flex items-center justify-between gap-3 shadow-xs">
              <div className="flex items-center gap-2.5 overflow-hidden">
                <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold text-xs flex-shrink-0 shadow-sm">
                  DOCX
                </div>
                <div className="overflow-hidden">
                  <p className="text-xs font-bold text-blue-950 dark:text-blue-200 truncate">
                    {customDocx.name}
                  </p>
                  <p className="text-[10px] text-blue-700 dark:text-blue-400">
                    {(customDocx.size / 1024).toFixed(1)} KB • Word template active for merging & RTF editor
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onCustomDocxChange && onCustomDocxChange(null)}
                className="text-xs font-bold text-red-600 dark:text-red-400 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors flex-shrink-0"
                title="Remove attached DOCX template"
              >
                Remove
              </button>
            </div>
          )}
          
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
            <div className="flex justify-between items-center mb-3">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-300">
                Template Repository
              </p>
              
              {/* Tab Toggles */}
              <div className="flex border border-slate-200 dark:border-slate-700 rounded-lg p-0.5 bg-slate-100 dark:bg-slate-800">
                <button
                  type="button"
                  onClick={() => { setActiveTab('saved'); loadSavedTemplates(); }}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-md transition-all ${
                    activeTab === 'saved'
                      ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  My Templates ({savedTemplates.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('create')}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-md transition-all ${
                    activeTab === 'create'
                      ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  + New Template
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('builtin')}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-md transition-all ${
                    activeTab === 'builtin'
                      ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  Built-In
                </button>
              </div>
            </div>

            {/* TAB CONTENTS */}

            {/* A. SAVED CUSTOM TEMPLATES TAB */}
            {activeTab === 'saved' && (
              <div className="space-y-3">
                {templateSaveSuccess && (
                  <div className="p-2 text-xs text-green-700 bg-green-50 dark:bg-green-950/40 dark:text-green-300 border border-green-150 rounded-lg text-center animate-pulse">
                    ✓ Custom template saved permanently to your browser database!
                  </div>
                )}

                {/* Filter and Search Bar for Templates */}
                <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center justify-between pb-1">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={savedSearchQuery}
                      onChange={(e) => setSavedSearchQuery(e.target.value)}
                      placeholder="Filter templates..."
                      className="w-full py-1.5 pl-8 pr-6 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
                      <SearchIcon className="w-3.5 h-3.5" />
                    </div>
                    {savedSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setSavedSearchQuery('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg flex-shrink-0 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setSavedModalityFilter('ALL')}
                      className={`px-2 py-1 rounded-md font-semibold transition-all ${
                        savedModalityFilter === 'ALL'
                          ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-xs'
                          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                      }`}
                    >
                      All ({savedTemplates.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSavedModalityFilter('CT')}
                      className={`px-2 py-1 rounded-md font-semibold transition-all ${
                        savedModalityFilter === 'CT'
                          ? 'bg-blue-600 text-white shadow-xs'
                          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                      }`}
                    >
                      CT
                    </button>
                    <button
                      type="button"
                      onClick={() => setSavedModalityFilter('MRI')}
                      className={`px-2 py-1 rounded-md font-semibold transition-all ${
                        savedModalityFilter === 'MRI'
                          ? 'bg-purple-600 text-white shadow-xs'
                          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                      }`}
                    >
                      MRI
                    </button>
                    <button
                      type="button"
                      onClick={() => setSavedModalityFilter('USER')}
                      className={`px-2 py-1 rounded-md font-semibold transition-all ${
                        savedModalityFilter === 'USER'
                          ? 'bg-amber-600 text-white shadow-xs'
                          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                      }`}
                    >
                      My Uploads
                    </button>
                  </div>
                </div>

                {filteredSavedTemplates.length === 0 ? (
                  <div className="text-center py-6 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/35">
                    <SparklesIcon className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">No matching templates found</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 mb-3">Try adjusting your search query or modality filters.</p>
                    <button
                      type="button"
                      onClick={() => { setSavedSearchQuery(''); setSavedModalityFilter('ALL'); }}
                      className="text-xs font-bold py-1.5 px-3 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 border border-blue-100 dark:border-blue-900/50 transition-colors"
                    >
                      Reset Filters
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-72 overflow-y-auto pr-1">
                    {filteredSavedTemplates.map((tmpl) => {
                      const isConfirming = deletingTemplateId === tmpl.id;
                      const isCT = (tmpl.modality || tmpl.category || '').toUpperCase().includes('CT');
                      const isMRI = (tmpl.modality || tmpl.category || '').toUpperCase().includes('MRI');

                      return (
                        <div 
                          key={tmpl.id}
                          className="p-3 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/30 dark:bg-slate-950/30 hover:border-slate-300 dark:hover:border-slate-700 transition-all flex flex-col justify-between gap-2.5"
                        >
                          <div>
                            <div className="flex justify-between items-start gap-1">
                              <h4 className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate" title={tmpl.name}>
                                {tmpl.name}
                              </h4>
                              
                              {tmpl.isBuiltIn ? (
                                <span 
                                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-200/80 dark:border-slate-700/80 flex-shrink-0 select-none"
                                  title="Built-in clinical template (permanent, non-deletable)"
                                >
                                  <span className="text-[10px]">🔒</span> Built-in
                                </span>
                              ) : !isConfirming ? (
                                <button
                                  type="button"
                                  onClick={() => setDeletingTemplateId(tmpl.id)}
                                  className="text-slate-400 hover:text-red-500 p-0.5 rounded-md hover:bg-red-50 dark:hover:bg-red-950/20 transition-all flex-shrink-0"
                                  title="Delete custom template permanently"
                                >
                                  <TrashIcon className="w-3.5 h-3.5" />
                                </button>
                              ) : (
                                <div className="flex items-center gap-1 text-[10px] bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/30 p-1 rounded-md">
                                  <span className="text-red-600 dark:text-red-400 font-bold px-0.5">Delete?</span>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteCustomTemplate(tmpl.id)}
                                    className="bg-red-600 text-white py-0.5 px-1.5 rounded text-[9px] font-bold hover:bg-red-700"
                                  >
                                    Yes
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDeletingTemplateId(null)}
                                    className="bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 py-0.5 px-1 rounded text-[9px] font-bold hover:bg-slate-300"
                                  >
                                    No
                                  </button>
                                </div>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              {!tmpl.isBuiltIn && (
                                <span className="text-[9px] bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 font-bold px-1.5 py-0.5 rounded border border-amber-200/80 dark:border-amber-900/50">
                                  Custom
                                </span>
                              )}
                              {(isCT || isMRI) && (
                                <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded ${
                                  isCT 
                                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-900' 
                                    : 'bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200 dark:border-purple-900'
                                }`}>
                                  {isCT ? 'CT' : 'MRI'}
                                </span>
                              )}
                              {tmpl.docxFile && (
                                <span className="text-[9px] bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-bold px-1.5 py-0.5 rounded border border-indigo-200 dark:border-indigo-900/50 flex items-center gap-1">
                                  📄 DOCX: {tmpl.docxFile.name} ({(tmpl.docxFile.size / 1024).toFixed(1)} KB)
                                </span>
                              )}
                              {tmpl.text && !tmpl.docxFile && (
                                <span className="text-[9px] bg-slate-100 dark:bg-slate-800 font-semibold px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">
                                  📝 Text content
                                </span>
                              )}
                              {tmpl.images && tmpl.images.length > 0 && (
                                <span className="text-[9px] bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-bold px-1.5 py-0.5 rounded border border-blue-100 dark:border-blue-900/40">
                                  📷 {tmpl.images.length} {tmpl.images.length === 1 ? 'screenshot' : 'screenshots'}
                                </span>
                              )}
                              {!tmpl.isBuiltIn && (
                                <span className="text-[9px] text-slate-400 dark:text-slate-500">
                                  • {new Date(tmpl.createdAt).toLocaleDateString()}
                                </span>
                              )}
                            </div>

                            {tmpl.text && (
                              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 line-clamp-2 italic bg-white dark:bg-slate-950/50 p-2 rounded border border-slate-150/40 dark:border-slate-800/40 leading-relaxed font-mono">
                                "{tmpl.text}"
                              </p>
                            )}
                          </div>

                          {activeUpcoming && (activeUpcoming.id === tmpl.id || activeUpcoming.name === tmpl.name || (tmpl.id.startsWith('builtin_') && activeUpcoming.id === tmpl.id.replace('builtin_', ''))) ? (
                            <div className="w-full mt-1.5 p-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 flex items-center justify-between text-xs text-emerald-800 dark:text-emerald-200">
                              <span className="font-bold text-[11px] truncate flex items-center gap-1">
                                <span>📌</span> Active for Upcoming
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  clearUpcomingTemplate();
                                  setActiveUpcoming(null);
                                }}
                                className="text-[11px] font-bold text-red-600 dark:text-red-400 hover:underline px-1 py-0.5 rounded cursor-pointer"
                              >
                                Remove
                              </button>
                            </div>
                          ) : (
                            <div className="w-full mt-1.5 flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleApplyCustomTemplate(tmpl, false)}
                                className="flex-1 py-1 px-2.5 text-xs font-bold text-center rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60 transition-colors"
                                title="Use this template for current report only"
                              >
                                Use Template
                              </button>
                              <button
                                type="button"
                                onClick={() => handleApplyCustomTemplate(tmpl, true)}
                                className="py-1 px-2 text-xs font-bold text-center rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition-colors flex items-center gap-1 shrink-0"
                                title="Use this template for upcoming reports in Single & Batch dictations"
                              >
                                <span>📌</span>
                                <span className="text-[11px]">Upcoming</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* B. CREATE CUSTOM TEMPLATE TAB */}
            {activeTab === 'create' && (
              <div className="space-y-3 bg-slate-50/50 dark:bg-slate-950/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800 animate-fade-in">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                    Template Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="e.g., Chest CT - Double screenshot reference"
                    className="w-full p-2 border border-slate-200 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                </div>

                {/* DOCX Template Upload Section */}
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                    Template Word Document (.docx) (Optional)
                  </label>

                  {templateDocx ? (
                    <div className="p-3 bg-blue-50/70 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/70 rounded-lg flex items-center justify-between gap-2 shadow-xs">
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold text-xs flex-shrink-0">
                          DOCX
                        </div>
                        <div className="overflow-hidden">
                          <p className="text-xs font-bold text-blue-950 dark:text-blue-200 truncate">
                            {templateDocx.name}
                          </p>
                          <p className="text-[10px] text-blue-700 dark:text-blue-400">
                            {(templateDocx.size / 1024).toFixed(1)} KB • Extracted {templateDocx.extractedText.split(/\s+/).filter(Boolean).length} words
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setTemplateDocx(null)}
                        className="text-xs font-bold text-red-600 dark:text-red-400 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div>
                      <input
                        type="file"
                        ref={templateDocxInputRef}
                        onChange={handleTemplateDocxSelect}
                        className="hidden"
                        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      />
                      <button
                        type="button"
                        onClick={() => templateDocxInputRef.current?.click()}
                        disabled={isParsingDocx}
                        className="w-full text-xs font-bold py-2.5 px-3 border border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-500 dark:hover:border-blue-500 rounded-lg text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 bg-white dark:bg-slate-900 flex items-center justify-center gap-2 transition-colors shadow-xs"
                      >
                        {isParsingDocx ? (
                          <>
                            <Spinner className="w-4 h-4 text-blue-600" />
                            <span>Extracting text & formatting from Word document...</span>
                          </>
                        ) : (
                          <>
                            <span className="text-base">📄</span>
                            <span>Upload .docx Template (Word Document)</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  {docxParseError && (
                    <p className="text-xs text-red-500 mt-1">{docxParseError}</p>
                  )}
                  <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
                    Upload your institution's Word template. All sections and normal wording will be parsed and stored locally.
                  </p>
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                    Template Text Guidelines or Draft (Optional)
                  </label>
                  <textarea
                    value={templateText}
                    onChange={(e) => setTemplateText(e.target.value)}
                    placeholder="Paste report layout, structural instructions, or sample draft text here..."
                    className="w-full p-2 border border-slate-200 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:outline-none min-h-[60px]"
                    rows={2}
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                    Template Screenshots or Layout Images (Optional)
                  </label>
                  
                  {templateImages.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2 p-2 bg-white dark:bg-slate-900 rounded-lg border border-slate-100 dark:border-slate-800">
                      {templateImages.map((img, index) => (
                        <div key={index} className="relative w-14 h-14 border border-slate-200 dark:border-slate-700 rounded-md p-0.5 bg-slate-50 dark:bg-slate-800">
                          <img
                            src={`data:${img.mimeType};base64,${img.data}`}
                            alt={`Upload preview ${index + 1}`}
                            className="object-contain w-full h-full rounded"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveTemplateImage(index)}
                            className="absolute -top-1.5 -right-1.5 bg-red-600 hover:bg-red-700 text-white rounded-full p-0.5 shadow-md"
                          >
                            <CloseIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <input
                    type="file"
                    ref={templateFileInputRef}
                    onChange={handleTemplateImageSelect}
                    className="hidden"
                    accept="image/*"
                    multiple
                  />
                  
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => templateFileInputRef.current?.click()}
                      className="w-full text-xs font-bold py-2 px-3 border border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-500 dark:hover:border-blue-500 rounded-lg text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 bg-white dark:bg-slate-900 flex items-center justify-center gap-1.5 transition-colors shadow-sm"
                    >
                      <ImageIcon className="w-4 h-4 text-blue-500 animate-pulse" />
                      Add Screenshots or Images ({templateImages.length})
                    </button>
                    {templateImages.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setTemplateImages([])}
                        className="text-xs font-semibold py-2 px-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 hover:bg-red-50 text-slate-500 hover:text-red-600 transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed bg-blue-50/40 dark:bg-blue-950/15 p-2.5 rounded-lg border border-blue-100/20 dark:border-blue-900/20">
                    ℹ️ <strong>How to replicate your template:</strong> Upload your Word .docx template or take screenshots of your report layout. You can combine .docx files, screenshots, and custom text guidelines for seamless merging.
                  </p>
                </div>

                {templateSaveError && (
                  <p className="text-xs text-red-500">{templateSaveError}</p>
                )}

                <div className="flex justify-end gap-2 pt-1 border-t border-slate-200/50 dark:border-slate-800/50">
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateName('');
                      setTemplateText('');
                      setTemplateImages([]);
                      setTemplateDocx(null);
                      setTemplateSaveError(null);
                      setActiveTab('saved');
                    }}
                    className="text-xs font-semibold py-1.5 px-3 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-850 text-slate-600 dark:text-slate-400"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveCustomTemplate}
                    className="text-xs font-bold py-1.5 px-4 rounded-lg bg-blue-600 text-white hover:bg-blue-700 shadow-md transition-all flex items-center gap-1.5"
                  >
                    💾 Save Template Permanently
                  </button>
                </div>
              </div>
            )}

            {/* C. BUILT-IN TEMPLATES TAB */}
            {activeTab === 'builtin' && (
              <div className="text-center py-6 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/35 animate-fade-in">
                <SparklesIcon className="w-8 h-8 text-blue-500 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">Standard Built-In Templates</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 mb-4">Choose from our pre-configured radiology report structures.</p>
                <button 
                  type="button"
                  onClick={() => setIsModalOpen(true)}
                  className="text-xs font-bold py-2 px-4 rounded-lg bg-blue-500 text-white hover:bg-blue-600 shadow-sm transition-colors"
                >
                  Select Built-In Template...
                </button>
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
};

export default CustomPromptInput;
