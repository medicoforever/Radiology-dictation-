import React, { useState, useEffect, useMemo } from 'react';
import { ReportTemplate } from '../../constants';
import SearchIcon from '../icons/SearchIcon';
import CloseIcon from '../icons/CloseIcon';
import { FileText, Check, Sparkles, Filter, Eye } from 'lucide-react';
import { isTableRowFinding, parseTableRow } from '../../services/docxService';
import { getUpcomingTemplate, setUpcomingTemplate, clearUpcomingTemplate, subscribeToUpcomingTemplate, UpcomingTemplateConfig } from '../../services/upcomingTemplateService';

interface TemplateSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  templates: ReportTemplate[];
  onSelectTemplate: (template: ReportTemplate | ReportTemplate[]) => void;
  onSelectTemplates?: (templates: ReportTemplate[]) => void;
}

interface RegionTag {
  id: string;
  label: string;
  titleMatch?: string[];
  exclude?: string[];
}

const REGION_TAGS: RegionTag[] = [
  { id: 'ALL', label: 'All Regions' },
  { 
    id: 'BRAIN', 
    label: '🧠 Brain & Head', 
    titleMatch: ['brain', 'temporal', 'head', 'pns', 'sella', 'pituitary', 'orbit', 'cerebell', 'calvarium', 'skull', 'facial'] 
  },
  { 
    id: 'SPINE', 
    label: '🦴 Spine', 
    titleMatch: ['spine', 'cervical', 'lumbar', 'dorsal', 'thoracic spine', 'myelogram', 'sacroiliac', 'whole spine'] 
  },
  { 
    id: 'STROKE', 
    label: '⚡ Stroke & Trauma', 
    titleMatch: ['stroke', 'trauma'] 
  },
  { 
    id: 'CHEST', 
    label: '🫁 Chest & Thorax', 
    titleMatch: ['chest', 'thorax', 'hrct', 'lung', 'mediastin'],
    exclude: ['angio', 'angiography', 'coronary']
  },
  { 
    id: 'ABDOMEN', 
    label: '🩺 Abdomen & Pelvis', 
    titleMatch: ['abdomen', 'pelvis', 'kub', 'urogram', 'liver', 'pancreas', 'mrcp', 'adrenal', 'pelvimetry', 'triphasic'],
    exclude: ['angio', 'angiography', 'trauma']
  },
  { 
    id: 'MSK', 
    label: '🦵 MSK & Extremities', 
    titleMatch: ['joint', 'knee', 'shoulder', 'wrist', 'ankle', 'elbow', 'hip', 'forearm', 'thigh', 'leg', 'foot', 'arm', 'hand', 'extremit', 'musculoskeletal'] 
  },
  { 
    id: 'CARDIAC', 
    label: '❤️ Cardiac & Angio', 
    titleMatch: ['angio', 'angiography', 'angiogram', 'coronary', 'cardiac', 'aorta', 'aortogram', 'tavi', 'cabg', 'renal angio'] 
  },
];

const TemplateSelectionModal: React.FC<TemplateSelectionModalProps> = ({ isOpen, onClose, templates, onSelectTemplate, onSelectTemplates }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [modalityFilter, setModalityFilter] = useState<'ALL' | 'CT' | 'MRI'>('ALL');
  const [regionFilter, setRegionFilter] = useState<string>('ALL');
  const [selectedPreview, setSelectedPreview] = useState<ReportTemplate | null>(null);
  const [selectedTemplates, setSelectedTemplates] = useState<ReportTemplate[]>([]);
  const [previewTab, setPreviewTab] = useState<'combined' | string>('combined');
  const [activeUpcoming, setActiveUpcoming] = useState<UpcomingTemplateConfig | null>(() => getUpcomingTemplate());
  const [useForUpcoming, setUseForUpcoming] = useState<boolean>(false);
  const [mobileTab, setMobileTab] = useState<'list' | 'preview'>('list');

  useEffect(() => {
    setActiveUpcoming(getUpcomingTemplate());
    const unsubscribe = subscribeToUpcomingTemplate((config) => {
      setActiveUpcoming(config);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setModalityFilter('ALL');
      setRegionFilter('ALL');
      setSelectedPreview(null);
      setSelectedTemplates([]);
      setPreviewTab('combined');
      setUseForUpcoming(false);
      setMobileTab('list');
    } else {
      setActiveUpcoming(getUpcomingTemplate());
    }
  }, [isOpen]);

  const toggleTemplateSelection = (template: ReportTemplate) => {
    setSelectedTemplates(prev => {
      const exists = prev.some(t => t.id === template.id || t.name === template.name);
      if (exists) {
        const next = prev.filter(t => t.id !== template.id && t.name !== template.name);
        return next;
      } else {
        const next = [...prev, template];
        if (next.length >= 2) {
          setPreviewTab('combined');
        }
        setSelectedPreview(template);
        return next;
      }
    });
  };

  const handleConfirmSelect = async (templateOrTemplates: ReportTemplate | ReportTemplate[], forUpcoming = useForUpcoming) => {
    if (forUpcoming) {
      await setUpcomingTemplate(templateOrTemplates);
      setActiveUpcoming(getUpcomingTemplate());
    }
    if (Array.isArray(templateOrTemplates) && onSelectTemplates) {
      onSelectTemplates(templateOrTemplates);
    } else {
      onSelectTemplate(templateOrTemplates);
    }
  };

  const ctCount = useMemo(() => {
    return templates.filter(t => (t.modality || t.category || '').toUpperCase().includes('CT')).length;
  }, [templates]);

  const mriCount = useMemo(() => {
    return templates.filter(t => (t.modality || t.category || '').toUpperCase().includes('MRI')).length;
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    let list = templates;

    // Modality filter
    if (modalityFilter === 'CT') {
      list = list.filter(t => (t.modality || t.category || '').toUpperCase().includes('CT'));
    } else if (modalityFilter === 'MRI') {
      list = list.filter(t => (t.modality || t.category || '').toUpperCase().includes('MRI'));
    }

    // Region filter
    if (regionFilter !== 'ALL') {
      const activeRegion = REGION_TAGS.find(r => r.id === regionFilter);
      if (activeRegion && activeRegion.titleMatch) {
        list = list.filter(t => {
          // Focus matching on template name, category, and short description to prevent deep finding cross-contamination
          const headerText = `${t.name} ${t.category || ''} ${t.description || ''}`.toLowerCase();
          
          // Check exclusions first (e.g. prevent angio or trauma from bleeding into regular plain abdomen/chest)
          if (activeRegion.exclude && activeRegion.exclude.some(ex => headerText.includes(ex))) {
            return false;
          }

          // Check if template title matches the targeted clinical region keywords
          return activeRegion.titleMatch!.some(keyword => headerText.includes(keyword));
        });
      }
    }

    // Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const parts = q.split(/\s+/).filter(Boolean);
      list = list.filter(t => {
        const text = `${t.name} ${t.description} ${t.modality || ''} ${t.lines ? t.lines.join(' ') : ''}`.toLowerCase();
        return parts.every(part => text.includes(part));
      });
    }

    return list;
  }, [templates, modalityFilter, regionFilter, searchQuery]);

  // Set default preview to first filtered template
  useEffect(() => {
    if (filteredTemplates.length > 0) {
      if (!selectedPreview || !filteredTemplates.some(t => t.name === selectedPreview.name)) {
        setSelectedPreview(filteredTemplates[0]);
      }
    } else {
      setSelectedPreview(null);
    }
  }, [filteredTemplates, selectedPreview]);

  const parseTemplateDetails = (template: ReportTemplate | null) => {
    if (!template) return null;
    let title = template.name;
    let technique = '';
    let findings: string[] = [];
    let impression = '';

    if (template.lines && template.lines.length > 0) {
      title = template.lines[0] || template.name;
      let inImpression = false;
      const impLines: string[] = [];

      for (let i = 1; i < template.lines.length; i++) {
        const line = template.lines[i].trim();
        if (!line || line.toLowerCase().startsWith('clinical profile:')) continue;
        if (line.toUpperCase().startsWith('IMPRESSION:') || line.toUpperCase() === 'IMPRESSION') {
          inImpression = true;
          const afterColon = line.replace(/^IMPRESSION:?/i, '').trim();
          if (afterColon) impLines.push(afterColon);
          continue;
        }
        if (inImpression) {
          impLines.push(line);
        } else {
          if (!technique && (line.toLowerCase().includes('section') || line.toLowerCase().includes('studied') || line.toLowerCase().includes('protocol') || line.toLowerCase().includes('sequence') || line.toLowerCase().includes('show:'))) {
            technique = line;
          } else {
            findings.push(line);
          }
        }
      }
      impression = impLines.length > 0 ? impLines.join('\n') : 'No significant abnormality noted.';
    } else {
      try {
        const parsed = JSON.parse(template.content);
        title = parsed.title || template.name;
        technique = parsed.technique || '';
        findings = parsed.normal_findings || [];
        impression = (parsed.default_impression || parsed.impression || '').replace(/^IMPRESSION:?#*/i, '');
      } catch {
        technique = template.description;
        findings = template.content.split('\n').filter(Boolean);
      }
    }

    return { title, technique, findings, impression, template };
  };

  // Parse details for single preview pane
  const parsedPreview = useMemo(() => {
    return parseTemplateDetails(selectedPreview);
  }, [selectedPreview]);

  // Parse combined details when multiple templates are selected
  const parsedCombinedPreview = useMemo(() => {
    if (selectedTemplates.length < 2) return null;
    const parsedList = selectedTemplates.map(t => parseTemplateDetails(t)).filter(Boolean) as NonNullable<ReturnType<typeof parseTemplateDetails>>[];
    const title = `COMBINED STUDY: ${selectedTemplates.map(t => t.name).join(' & ')}`;
    const techniques = parsedList.map(p => ({ templateName: p.template.name, technique: p.technique })).filter(p => Boolean(p.technique));
    const impressions = parsedList.map(p => p.impression).filter(Boolean);
    return {
      title,
      techniques,
      sections: parsedList.map(p => ({
        template: p.template,
        title: p.title,
        technique: p.technique,
        findings: p.findings,
        impression: p.impression,
      })),
      impression: impressions.join(' | '),
    };
  }, [selectedTemplates]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-2 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-modal-title"
    >
      <div
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col h-[90vh] max-h-[820px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="p-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50/70 dark:bg-slate-950/50 flex-shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                <FileText className="w-5 h-5" />
              </span>
              <h2 id="template-modal-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
                Radiology Report Template Library
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Select any of {templates.length} authoritative clinical normal report templates with native DOCX formatting.
            </p>
          </div>
          <button 
            onClick={onClose} 
            className="p-1.5 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors" 
            aria-label="Close template selection"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
        </header>

        {/* Active Upcoming Template Banner */}
        {activeUpcoming && (
          <div className="bg-emerald-50 dark:bg-emerald-950/60 border-b border-emerald-200 dark:border-emerald-800/80 px-4 py-2 flex items-center justify-between text-xs flex-shrink-0 animate-fade-in">
            <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-200 font-semibold min-w-0">
              <span className="shrink-0 text-sm">📌</span>
              <span className="truncate">
                Active for upcoming reports: <strong className="underline">{activeUpcoming.name}</strong>
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                clearUpcomingTemplate();
                setActiveUpcoming(null);
              }}
              className="text-emerald-700 hover:text-emerald-900 dark:text-emerald-300 dark:hover:text-emerald-100 font-bold px-2.5 py-1 rounded-md hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition-colors shrink-0 cursor-pointer text-xs"
              title="Remove template for upcoming reports"
            >
              ✕ Remove
            </button>
          </div>
        )}

        {/* Filter Controls Bar */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-3 flex-shrink-0">
          <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
            {/* Search Input */}
            <div className="relative flex-1">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search templates by scan name, organ, finding, or keyword..."
                className="w-full py-2 pl-9 pr-8 text-sm border border-slate-300 dark:border-slate-700 rounded-xl bg-slate-50/50 dark:bg-slate-950/50 text-slate-900 placeholder-slate-400 dark:text-white focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                aria-label="Search for report templates"
                autoFocus
              />
              <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
                <SearchIcon className="w-4 h-4 text-slate-400" />
              </div>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-0.5"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Modality Filter Pills */}
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl flex-shrink-0">
              <button
                type="button"
                onClick={() => setModalityFilter('ALL')}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                  modalityFilter === 'ALL'
                    ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                All ({templates.length})
              </button>
              <button
                type="button"
                onClick={() => setModalityFilter('CT')}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                  modalityFilter === 'CT'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                CT ({ctCount})
              </button>
              <button
                type="button"
                onClick={() => setModalityFilter('MRI')}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                  modalityFilter === 'MRI'
                    ? 'bg-purple-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                MRI ({mriCount})
              </button>
            </div>
          </div>

          {/* Quick Region Filter Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none text-[11px]">
            <span className="text-slate-400 font-medium flex items-center gap-1 mr-1 flex-shrink-0">
              <Filter className="w-3 h-3" /> Quick Filter:
            </span>
            {REGION_TAGS.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => setRegionFilter(tag.id)}
                className={`px-2.5 py-1 rounded-lg font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                  regionFilter === tag.id
                    ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 font-bold border border-blue-300 dark:border-blue-700'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                {tag.label}
              </button>
            ))}
          </div>

          {/* Upcoming Reports Option Toggle */}
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between flex-wrap gap-2">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useForUpcoming}
                onChange={(e) => setUseForUpcoming(e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 h-4 w-4"
              />
              <span>Use selected template for upcoming reports (Single & Batch dictations)</span>
            </label>
            {useForUpcoming && (
              <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-300 dark:border-emerald-700">
                Will be set as active template for upcoming dictations
              </span>
            )}
          </div>
        </div>

        {/* Mobile View Switcher Tabs (Only on small screens) */}
        <div className="md:hidden flex items-center border-b border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-950 p-1.5 gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setMobileTab('list')}
            className={`flex-1 py-2 px-3 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              mobileTab === 'list'
                ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs border border-slate-200 dark:border-slate-700'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Templates ({filteredTemplates.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('preview')}
            className={`flex-1 py-2 px-3 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              mobileTab === 'preview'
                ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs border border-slate-200 dark:border-slate-700'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>
              {selectedTemplates.length >= 2
                ? `Combined Preview (${selectedTemplates.length})`
                : 'Preview'}
            </span>
            {selectedTemplates.length >= 2 && (
              <span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center font-bold">
                {selectedTemplates.length}
              </span>
            )}
          </button>
        </div>

        {/* Content Body: Split View (List on left, Preview on right) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          {/* Template List Column */}
          <div className={`w-full md:w-1/2 lg:w-5/12 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 overflow-y-auto p-3 space-y-1.5 ${mobileTab === 'list' ? 'flex-1' : 'hidden md:block'}`}>
            <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 px-2 py-1">
              <span>Found {filteredTemplates.length} matching {filteredTemplates.length === 1 ? 'template' : 'templates'}</span>
              {selectedTemplates.length > 0 && (
                <span className="text-blue-600 dark:text-blue-400 normal-case font-bold">
                  {selectedTemplates.length} selected
                </span>
              )}
            </div>

            {/* Combined Selection Bar */}
            {selectedTemplates.length > 0 && (
              <div className="mb-2 p-2.5 bg-blue-50 dark:bg-blue-950/70 border border-blue-300 dark:border-blue-700/80 rounded-xl flex flex-col gap-2 shadow-xs animate-fade-in">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-blue-900 dark:text-blue-100 min-w-0">
                    <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                    <span className="truncate">Combined Selection ({selectedTemplates.length} templates)</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedTemplates([])}
                    className="text-[11px] font-semibold text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 cursor-pointer"
                  >
                    Clear all
                  </button>
                </div>
                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pr-1">
                  {selectedTemplates.map((t, idx) => (
                    <span
                      key={t.id || t.name}
                      className="inline-flex items-center gap-1 text-[11px] font-medium bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 px-2 py-0.5 rounded-md border border-blue-200 dark:border-blue-800 shadow-2xs"
                    >
                      <span className="w-3.5 h-3.5 rounded-full bg-blue-600 text-white text-[9px] flex items-center justify-center font-bold shrink-0">{idx + 1}</span>
                      <span className="truncate max-w-[130px]">{t.name}</span>
                      <button
                        type="button"
                        onClick={() => toggleTemplateSelection(t)}
                        className="text-slate-400 hover:text-red-500 font-bold ml-0.5 cursor-pointer"
                        title="Remove from combination"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => handleConfirmSelect(selectedTemplates)}
                  className="w-full py-1.5 px-3 bg-blue-600 hover:bg-blue-700 active:scale-98 text-white text-xs font-bold rounded-lg shadow-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Apply Combined ({selectedTemplates.length} Templates)</span>
                </button>
              </div>
            )}

            {filteredTemplates.length > 0 ? (
              <ul className="space-y-1.5">
                {filteredTemplates.map((template) => {
                  const isSelected = selectedPreview?.name === template.name;
                  const isMultiSelected = selectedTemplates.some(t => t.id === template.id || t.name === template.name);
                  const multiIndex = selectedTemplates.findIndex(t => t.id === template.id || t.name === template.name);
                  const isCurrentUpcoming = Boolean(activeUpcoming && (activeUpcoming.id === template.id || activeUpcoming.name === template.name));
                  const isCT = (template.modality || template.category || '').toUpperCase().includes('CT');
                  const isMRI = (template.modality || template.category || '').toUpperCase().includes('MRI');
                  const linesCount = template.lines?.length || 0;

                  return (
                    <li key={template.id || template.name}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          setSelectedPreview(template);
                          if (selectedTemplates.length >= 2) {
                            setPreviewTab(template.id || template.name);
                          }
                        }}
                        onDoubleClick={() => {
                          if (selectedTemplates.length >= 2 && isMultiSelected) {
                            handleConfirmSelect(selectedTemplates);
                          } else {
                            handleConfirmSelect(template);
                          }
                        }}
                        onKeyDown={(e) => { 
                          if (e.key === 'Enter') {
                            if (selectedTemplates.length >= 2 && isMultiSelected) {
                              handleConfirmSelect(selectedTemplates);
                            } else {
                              handleConfirmSelect(template);
                            }
                          }
                        }}
                        className={`w-full text-left p-3 rounded-xl transition-all flex items-start justify-between gap-2.5 border cursor-pointer ${
                          isMultiSelected
                            ? 'bg-blue-50/90 dark:bg-blue-950/50 border-blue-400 dark:border-blue-600 ring-1 ring-blue-400 shadow-xs'
                            : isSelected
                            ? 'bg-slate-100/90 dark:bg-slate-800/80 border-slate-300 dark:border-slate-700 shadow-xs'
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                        }`}
                      >
                        {/* Checkbox button to toggle multi-template combination */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleTemplateSelection(template);
                          }}
                          className={`mt-0.5 p-1 rounded-lg border transition-all shrink-0 cursor-pointer ${
                            isMultiSelected
                              ? 'bg-blue-600 text-white border-blue-600 shadow-xs ring-2 ring-blue-300 dark:ring-blue-800'
                              : 'bg-slate-100 hover:bg-blue-50 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-400 border-slate-300 dark:border-slate-600 hover:border-blue-400'
                          }`}
                          title={isMultiSelected ? `Remove ${template.name} from combined selection` : `Select ${template.name} to combine with another template`}
                          aria-label={isMultiSelected ? `Deselect ${template.name}` : `Select ${template.name} for combination`}
                        >
                          {isMultiSelected ? (
                            <div className="w-4 h-4 flex items-center justify-center font-bold text-[10px]">
                              {multiIndex + 1}
                            </div>
                          ) : (
                            <div className="w-4 h-4 flex items-center justify-center text-[10px] text-slate-400 font-bold">
                              +
                            </div>
                          )}
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                            <span
                              className={`text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded tracking-wide ${
                                isCT
                                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-300'
                                  : isMRI
                                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-300'
                                  : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300'
                              }`}
                            >
                              {template.modality || (isCT ? 'CT' : isMRI ? 'MRI' : 'SCAN')}
                            </span>
                            {isCurrentUpcoming && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700 animate-pulse">
                                📌 Active for Upcoming
                              </span>
                            )}
                            {linesCount > 0 && (
                              <span className="text-[10px] text-slate-400 dark:text-slate-500">
                                {linesCount} lines
                              </span>
                            )}
                          </div>
                          <p className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">
                            {template.name}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-1 mt-0.5">
                            {template.description}
                          </p>
                        </div>

                        <div className="flex flex-col items-end gap-1.5 flex-shrink-0 pt-0.5">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (selectedTemplates.length >= 2 && isMultiSelected) {
                                  handleConfirmSelect(selectedTemplates, false);
                                } else {
                                  handleConfirmSelect(template, false);
                                }
                              }}
                              className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-xs font-bold rounded-lg shadow-xs transition-all cursor-pointer"
                              title={selectedTemplates.length >= 2 && isMultiSelected ? `Apply combined ${selectedTemplates.length} templates` : `Use ${template.name} for this report only`}
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>{selectedTemplates.length >= 2 && isMultiSelected ? `Combine (${selectedTemplates.length})` : 'Select'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isCurrentUpcoming) {
                                  clearUpcomingTemplate();
                                  setActiveUpcoming(null);
                                } else {
                                  if (selectedTemplates.length >= 2 && isMultiSelected) {
                                    handleConfirmSelect(selectedTemplates, true);
                                  } else {
                                    handleConfirmSelect(template, true);
                                  }
                                }
                              }}
                              className={`flex items-center gap-1 px-2 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${
                                isCurrentUpcoming
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 hover:bg-red-50 hover:text-red-700 hover:border-red-300'
                                  : 'bg-slate-100 hover:bg-emerald-50 text-slate-700 hover:text-emerald-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-emerald-950/40 border-slate-200 dark:border-slate-700'
                              }`}
                              title={isCurrentUpcoming ? 'Click to remove this template from upcoming reports' : `Use ${template.name} for upcoming reports in Single & Batch`}
                            >
                              <span>📌</span>
                              <span className="text-[11px] hidden sm:inline">{isCurrentUpcoming ? 'Remove' : 'Upcoming'}</span>
                            </button>
                          </div>
                          {isSelected ? (
                            <span className="text-[10px] text-blue-600 dark:text-blue-400 font-semibold flex items-center gap-0.5">
                              <Eye className="w-3 h-3" /> Previewing
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-0.5">
                              Click to preview
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-center py-12 px-4">
                <p className="text-sm font-semibold text-slate-600 dark:text-slate-400">No matching templates found</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Try adjusting your search keywords or modality filters.</p>
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setModalityFilter('ALL'); setRegionFilter('ALL'); }}
                  className="mt-3 text-xs font-semibold px-3 py-1.5 bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300 rounded-lg hover:underline"
                >
                  Reset all filters
                </button>
              </div>
            )}
          </div>

          {/* Template Preview Column */}
          <div className={`w-full md:w-1/2 lg:w-7/12 flex flex-col bg-slate-50/50 dark:bg-slate-950/40 overflow-hidden ${mobileTab === 'preview' ? 'flex-1' : 'hidden md:flex'}`}>
            {/* Multi-template Tabs when 2 or more templates are selected */}
            {selectedTemplates.length >= 2 && (
              <div className="flex items-center gap-1.5 p-2 bg-slate-100 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 flex-shrink-0 overflow-x-auto scrollbar-none">
                <button
                  type="button"
                  onClick={() => setPreviewTab('combined')}
                  className={`flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer shrink-0 ${
                    previewTab === 'combined'
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white/70 dark:bg-slate-900/70'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Combined Report Preview ({selectedTemplates.length})</span>
                </button>
                {selectedTemplates.map((t, idx) => (
                  <button
                    key={t.id || t.name}
                    type="button"
                    onClick={() => {
                      setPreviewTab(t.id || t.name);
                      setSelectedPreview(t);
                    }}
                    className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all cursor-pointer truncate max-w-[150px] shrink-0 ${
                      previewTab === (t.id || t.name)
                        ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 font-bold border border-blue-300 dark:border-blue-700'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 bg-white/60 dark:bg-slate-900/60'
                    }`}
                    title={t.name}
                  >
                    {idx + 1}. {t.name}
                  </button>
                ))}
              </div>
            )}

            {/* COMBINED PREVIEW TAB */}
            {selectedTemplates.length >= 2 && previewTab === 'combined' && parsedCombinedPreview ? (
              <div className="flex-1 flex flex-col overflow-hidden p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 uppercase tracking-wide">
                        Combined Examination ({selectedTemplates.length} Templates)
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        Multi-Region Merge
                      </span>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">
                      {parsedCombinedPreview.title}
                    </h3>
                    <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 font-medium">
                      Dictate findings for any or all regions — observations will be accurately placed into their proper anatomical sections, while unmentioned areas retain full normal findings.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleConfirmSelect(selectedTemplates, false)}
                    className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-xs sm:text-sm font-bold rounded-xl shadow-md transition-all flex-shrink-0 cursor-pointer"
                  >
                    <Sparkles className="w-4 h-4 text-yellow-300" /> Combine &amp; Use ({selectedTemplates.length})
                  </button>
                </div>

                {/* Combined Report Content Preview Body */}
                <div className="flex-1 overflow-y-auto mt-3 pr-1 space-y-4 text-xs font-mono">
                  {/* Techniques */}
                  {parsedCombinedPreview.techniques.length > 0 && (
                    <div className="bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                      <p className="font-bold text-slate-500 dark:text-slate-400 uppercase text-[10px] tracking-wider mb-1">
                        Techniques &amp; Protocols:
                      </p>
                      <div className="space-y-1 text-slate-800 dark:text-slate-200 font-sans leading-relaxed">
                        {parsedCombinedPreview.techniques.map((t, idx) => (
                          <p key={idx}><strong className="text-blue-600 dark:text-blue-400">[{t.templateName}]:</strong> {t.technique}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Combined Baseline Findings Grouped by Template */}
                  {parsedCombinedPreview.sections.map((sec, secIdx) => (
                    <div key={secIdx} className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2 mb-2">
                        <span className="font-bold text-blue-700 dark:text-blue-400 uppercase text-[10px] tracking-wider flex items-center gap-1.5 font-sans">
                          <span className="w-4 h-4 rounded-full bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 text-[10px] flex items-center justify-center font-bold">
                            {secIdx + 1}
                          </span>
                          Section {secIdx + 1}: {sec.title}
                        </span>
                        <span className="text-[10px] text-slate-400 font-sans">
                          {sec.findings.length} baseline points
                        </span>
                      </div>
                      <div className="space-y-2 font-sans">
                        {sec.findings.map((f, fIdx) => (
                          <div key={fIdx} className="flex items-start gap-2 text-slate-700 dark:text-slate-300 leading-relaxed text-xs">
                            <span className="text-blue-500 font-bold">•</span>
                            <span>{f}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {/* Synthesized Impression Baseline */}
                  <div className="bg-blue-50/60 dark:bg-blue-950/40 p-3.5 rounded-xl border border-blue-200 dark:border-blue-900/50">
                    <p className="font-bold text-blue-700 dark:text-blue-400 uppercase text-[10px] tracking-wider mb-1 flex items-center gap-1 font-sans">
                      <Sparkles className="w-3.5 h-3.5" /> Synthesized Combined Impression:
                    </p>
                    <p className="text-slate-900 dark:text-slate-100 font-bold font-sans">
                      {parsedCombinedPreview.impression || 'All examined regions within normal baseline limits.'}
                    </p>
                  </div>
                </div>

                {/* Bottom Action Footer for Combined */}
                <div className="pt-3 mt-2 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={useForUpcoming}
                        onChange={(e) => setUseForUpcoming(e.target.checked)}
                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 h-4 w-4"
                      />
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Use combined templates for upcoming reports <span className="font-normal text-slate-500 dark:text-slate-400">(Single &amp; Batch)</span>
                      </span>
                    </label>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <button
                      type="button"
                      onClick={() => handleConfirmSelect(selectedTemplates, false)}
                      className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-300 dark:border-slate-600 transition-colors cursor-pointer"
                      title="Combine templates and apply to current report"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                      <span>Combine &amp; Apply to Current</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmSelect(selectedTemplates, true)}
                      className="flex items-center justify-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs transition-colors cursor-pointer"
                      title="Use these combined templates for upcoming reports across Single and Batch dictations"
                    >
                      <span>📌</span>
                      <span>Use Combined for Upcoming</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : selectedPreview && parsedPreview ? (
              /* SINGLE TEMPLATE PREVIEW TAB */
              <div className="flex-1 flex flex-col overflow-hidden p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 uppercase tracking-wide">
                        {selectedPreview.modality || 'Radiology Template'}
                      </span>
                      {selectedPreview.docxBase64 && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 flex items-center gap-1">
                          📄 Word (.docx) Included
                        </span>
                      )}
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">
                      {parsedPreview.title}
                    </h3>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleConfirmSelect(selectedPreview, false)}
                    className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-xs sm:text-sm font-bold rounded-xl shadow-md transition-all flex-shrink-0 cursor-pointer"
                  >
                    <Check className="w-4 h-4" /> Use Template
                  </button>
                </div>

                {/* Report Content Preview Body */}
                <div className="flex-1 overflow-y-auto mt-3 pr-1 space-y-4 text-xs font-mono">
                  {/* Technique */}
                  {parsedPreview.technique && (
                    <div className="bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                      <p className="font-bold text-slate-500 dark:text-slate-400 uppercase text-[10px] tracking-wider mb-1">
                        Technique / Protocol:
                      </p>
                      <p className="text-slate-800 dark:text-slate-200 font-sans leading-relaxed">
                        {parsedPreview.technique}
                      </p>
                    </div>
                  )}

                  {/* Findings */}
                  <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
                    <p className="font-bold text-slate-500 dark:text-slate-400 uppercase text-[10px] tracking-wider mb-2">
                      Normal Findings Baseline ({parsedPreview.findings.length} points):
                    </p>
                    <div className="space-y-2 font-sans">
                      {(() => {
                        const items: React.ReactNode[] = [];
                        let i = 0;
                        const findings = parsedPreview.findings;

                        while (i < findings.length) {
                          const f = findings[i];
                          if (isTableRowFinding(f)) {
                            const tableLines: string[] = [f];
                            while (i + 1 < findings.length && isTableRowFinding(findings[i + 1])) {
                              i++;
                              tableLines.push(findings[i]);
                            }

                            // Flatten any rows that were joined with ###
                            const flattenedRows: string[] = [];
                            tableLines.forEach(tl => {
                              if (tl.includes('###')) {
                                flattenedRows.push(...tl.split('###').map(r => r.trim()).filter(Boolean));
                              } else {
                                flattenedRows.push(tl);
                              }
                            });

                            const parsedRows = flattenedRows.map(row => parseTableRow(row));
                            const maxCols = Math.max(...parsedRows.map(r => r.length), 1);
                            const header = parsedRows[0];
                            const body = parsedRows.slice(1);

                            items.push(
                              <div key={`table-${i}`} className="my-2.5 overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg shadow-xs">
                                <table className="w-full text-xs text-left border-collapse">
                                  <thead>
                                    <tr className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-bold border-b border-slate-200 dark:border-slate-700">
                                      {header.map((col, idx) => (
                                        <th key={idx} className="p-2 border-r last:border-r-0 border-slate-200 dark:border-slate-700">
                                          {col}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {body.map((row, rIdx) => (
                                      <tr key={rIdx} className={`border-b last:border-b-0 border-slate-200 dark:border-slate-800 ${rIdx % 2 === 1 ? 'bg-slate-50/50 dark:bg-slate-900/50' : 'bg-white dark:bg-slate-900'}`}>
                                        {Array.from({ length: maxCols }).map((_, cIdx) => (
                                          <td key={cIdx} className="p-2 border-r last:border-r-0 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300">
                                            {row[cIdx] || ''}
                                          </td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            );
                          } else {
                            items.push(
                              <div key={i} className="flex items-start gap-2 text-slate-700 dark:text-slate-300 leading-relaxed text-xs">
                                <span className="text-blue-500 font-bold">•</span>
                                <span>{f}</span>
                              </div>
                            );
                          }
                          i++;
                        }
                        return items;
                      })()}
                    </div>
                  </div>

                  {/* Impression */}
                  <div className="bg-blue-50/60 dark:bg-blue-950/40 p-3.5 rounded-xl border border-blue-200 dark:border-blue-900/50">
                    <p className="font-bold text-blue-700 dark:text-blue-400 uppercase text-[10px] tracking-wider mb-1 flex items-center gap-1 font-sans">
                      <Sparkles className="w-3.5 h-3.5" /> Baseline Impression:
                    </p>
                    <p className="text-slate-900 dark:text-slate-100 font-bold font-sans">
                      {parsedPreview.impression}
                    </p>
                  </div>
                </div>

                {/* Bottom Action Footer */}
                <div className="pt-3 mt-2 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    {activeUpcoming && (activeUpcoming.id === selectedPreview.id || activeUpcoming.name === selectedPreview.name) ? (
                      <div className="flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-200 font-bold bg-emerald-50 dark:bg-emerald-950/60 px-3 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700">
                        <span>📌 Active for upcoming reports</span>
                        <button
                          type="button"
                          onClick={() => {
                            clearUpcomingTemplate();
                            setActiveUpcoming(null);
                          }}
                          className="ml-2 text-xs text-red-600 dark:text-red-400 hover:underline font-bold cursor-pointer"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={useForUpcoming}
                          onChange={(e) => setUseForUpcoming(e.target.checked)}
                          className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 h-4 w-4"
                        />
                        <span className="font-semibold text-slate-800 dark:text-slate-200">
                          Use for upcoming reports <span className="font-normal text-slate-500 dark:text-slate-400">(Single &amp; Batch)</span>
                        </span>
                      </label>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {selectedTemplates.length >= 2 && (
                      <button
                        type="button"
                        onClick={() => handleConfirmSelect(selectedTemplates, false)}
                        className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-xs font-bold rounded-xl shadow-xs transition-colors cursor-pointer"
                        title="Apply the combined selected templates"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Apply Combined ({selectedTemplates.length})</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleConfirmSelect(selectedPreview, false)}
                      className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-300 dark:border-slate-600 transition-colors cursor-pointer"
                      title="Apply only this template without combination"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{selectedTemplates.length >= 2 ? `Use "${selectedPreview.name}" Only` : 'Apply to Current Only'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmSelect(selectedTemplates.length >= 2 ? selectedTemplates : selectedPreview, true)}
                      className="flex items-center justify-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs transition-colors cursor-pointer"
                      title="Use template for upcoming reports across Single and Batch dictations"
                    >
                      <span>📌</span>
                      <span>{selectedTemplates.length >= 2 ? `Use Combined (${selectedTemplates.length}) for Upcoming` : 'Use for Upcoming Reports'}</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400">
                <FileText className="w-12 h-12 stroke-1 text-slate-300 dark:text-slate-700 mb-2" />
                <p className="text-sm font-semibold">Select a template on the left to preview</p>
              </div>
            )}
          </div>
        </div>

        {/* Persistent Sticky Bottom Combine Bar for Multi-Template Selection (Always visible on mobile & desktop when 2+ templates selected) */}
        {selectedTemplates.length >= 2 && (
          <div className="p-3 sm:px-6 bg-blue-50/95 dark:bg-slate-950/95 backdrop-blur-md border-t-2 border-blue-500 dark:border-blue-600 shadow-2xl flex flex-col sm:flex-row items-center justify-between gap-2.5 z-40 shrink-0">
            <div className="flex items-center justify-between w-full sm:w-auto gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                  {selectedTemplates.length}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-blue-900 dark:text-blue-100 truncate">
                    {selectedTemplates.map(t => t.name).join(' + ')}
                  </p>
                  <p className="text-[11px] text-blue-700 dark:text-blue-300 hidden sm:block">
                    Multi-template cohesive report combination
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 sm:hidden shrink-0">
                <button
                  type="button"
                  onClick={() => setMobileTab(mobileTab === 'list' ? 'preview' : 'list')}
                  className="text-[11px] font-bold px-2 py-1 rounded-lg bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 cursor-pointer"
                >
                  {mobileTab === 'list' ? '👁️ Preview' : '📋 List'}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedTemplates([])}
                  className="text-[11px] font-semibold text-slate-500 hover:text-red-600 dark:text-slate-400 px-1 py-1 cursor-pointer"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <button
                type="button"
                onClick={() => handleConfirmSelect(selectedTemplates, false)}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-xs sm:text-sm font-bold rounded-xl shadow-lg transition-all cursor-pointer min-h-[44px]"
              >
                <Sparkles className="w-4 h-4 text-yellow-300" />
                <span>Combine &amp; Apply ({selectedTemplates.length} Templates)</span>
              </button>

              <button
                type="button"
                onClick={() => handleConfirmSelect(selectedTemplates, true)}
                className="flex items-center justify-center gap-1 px-3.5 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs sm:text-sm font-bold rounded-xl shadow-md transition-all cursor-pointer min-h-[44px]"
                title="Combine and set as active for upcoming reports"
              >
                <span>📌</span>
                <span className="hidden sm:inline">Use for Upcoming</span>
                <span className="sm:hidden">+ Upcoming</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TemplateSelectionModal;
