import React, { useState, useRef, useEffect } from 'react';
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
import { saveUserTemplate, getUserTemplates, deleteUserTemplate, UserTemplate } from '../../services/templateStorage';

const CustomPromptInput: React.FC<{
  prompt: string;
  onPromptChange: (prompt: string) => void;
  className?: string;
  images?: Array<{ data: string; mimeType: string }>;
  onImagesChange?: (images: Array<{ data: string; mimeType: string }>) => void;
  isLiveMode?: boolean;
}> = ({ prompt, onPromptChange, className, images = [], onImagesChange, isLiveMode = false }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { isRecording, startRecording, stopRecording, error: recorderError } = useAudioRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounter = useRef(0);

  // Custom template management states
  const [savedTemplates, setSavedTemplates] = useState<UserTemplate[]>([]);
  const [activeTab, setActiveTab] = useState<'saved' | 'create' | 'builtin'>('saved');
  const [templateName, setTemplateName] = useState('');
  const [templateText, setTemplateText] = useState('');
  const [templateImages, setTemplateImages] = useState<Array<{ data: string; mimeType: string }>>([]);
  const [templateSaveSuccess, setTemplateSaveSuccess] = useState(false);
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null);
  const [appliedTemplateName, setAppliedTemplateName] = useState<string | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const templateFileInputRef = useRef<HTMLInputElement>(null);

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
          const transcript = await transcribeAudioForPrompt(audioBlob);
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

  const handleSelectTemplate = (template: ReportTemplate) => {
    onPromptChange(`Use the normal ${template.name} report template. Integrate my dictation and generate a new impression.`);
    setAppliedTemplateName(`Built-in ${template.name}`);
    setIsModalOpen(false);
    setTimeout(() => setAppliedTemplateName(null), 4000);
  };

  const processFiles = (files: FileList | null) => {
    if (files && files.length > 0 && onImagesChange) {
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
  };

  const processTemplateFiles = (files: FileList | null) => {
    if (files && files.length > 0) {
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

  const handleImageFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(event.target.files);
    if (event.target) {
        event.target.value = "";
    }
  };

  const handleTemplateImageSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    processTemplateFiles(event.target.files);
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
        text: templateText.trim(),
        images: templateImages,
      });

      setTemplateSaveSuccess(true);
      setTemplateName('');
      setTemplateText('');
      setTemplateImages([]);
      
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
    try {
      await deleteUserTemplate(id);
      setDeletingTemplateId(null);
      await loadSavedTemplates();
    } catch (err) {
      console.warn('Failed to delete template:', err);
    }
  };

  const handleApplyCustomTemplate = (template: UserTemplate) => {
    onPromptChange(template.text);
    if (onImagesChange) {
      onImagesChange(template.images);
    }
    setAppliedTemplateName(template.name);
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
              <div className="space-y-2">
                {templateSaveSuccess && (
                  <div className="p-2 text-xs text-green-700 bg-green-50 dark:bg-green-950/40 dark:text-green-300 border border-green-150 rounded-lg text-center animate-pulse">
                    ✓ Custom template saved permanently to your browser database!
                  </div>
                )}
                {savedTemplates.length === 0 ? (
                  <div className="text-center py-6 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/35">
                    <SparklesIcon className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">No saved templates yet</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 mb-3">Create one to store text or screenshot guidelines permanently.</p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('create')}
                      className="text-xs font-bold py-1.5 px-3 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 border border-blue-100 dark:border-blue-900/50 transition-colors"
                    >
                      + Create Custom Template
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-60 overflow-y-auto pr-1">
                    {savedTemplates.map((tmpl) => {
                      const isConfirming = deletingTemplateId === tmpl.id;
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
                              
                              {!isConfirming ? (
                                <button
                                  type="button"
                                  onClick={() => setDeletingTemplateId(tmpl.id)}
                                  className="text-slate-400 hover:text-red-500 p-0.5 rounded-md hover:bg-red-50 dark:hover:bg-red-950/20 transition-all flex-shrink-0"
                                  title="Delete template permanently"
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
                              {tmpl.text && (
                                <span className="text-[9px] bg-slate-100 dark:bg-slate-800 font-semibold px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-400">
                                  📝 Text content
                                </span>
                              )}
                              {tmpl.images && tmpl.images.length > 0 && (
                                <span className="text-[9px] bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-bold px-1.5 py-0.5 rounded border border-blue-100 dark:border-blue-900/40">
                                  📷 {tmpl.images.length} {tmpl.images.length === 1 ? 'screenshot' : 'screenshots'}
                                </span>
                              )}
                              <span className="text-[9px] text-slate-400 dark:text-slate-500">
                                • {new Date(tmpl.createdAt).toLocaleDateString()}
                              </span>
                            </div>

                            {tmpl.text && (
                              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 line-clamp-2 italic bg-white dark:bg-slate-950/50 p-2 rounded border border-slate-150/40 dark:border-slate-800/40 leading-relaxed">
                                "{tmpl.text}"
                              </p>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => handleApplyCustomTemplate(tmpl)}
                            className="w-full mt-1.5 py-1 px-3 text-xs font-bold text-center rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60 transition-colors"
                          >
                            Use Template
                          </button>
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
                    ℹ️ <strong>How to replicate your template:</strong> Take screenshots of your report template layout and upload them here. If the template is large, take multiple sequential screenshots and add them together. You can also upload screenshots combined with custom text guidelines!
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

          <div className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed bg-slate-50 dark:bg-slate-950 p-2.5 rounded-lg border border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row gap-2 justify-between">
            <span>
              ℹ️ Custom instructions and reference images fine-tune the AI's transcription style, report format, and structure.
            </span>
            {!isLiveMode && (
              <span className="font-semibold text-blue-600 dark:text-blue-400 flex-shrink-0 cursor-pointer hover:underline" onClick={() => fileInputRef.current?.click()}>
                + Click here to add quick screenshots to active session
              </span>
            )}
          </div>
          
          <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageFileSelect}
              className="hidden"
              accept="image/*"
              multiple
          />
        </div>
      )}
    </div>
  );
};

export default CustomPromptInput;
