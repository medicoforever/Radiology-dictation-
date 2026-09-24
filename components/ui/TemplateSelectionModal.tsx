import React, { useState, useEffect, useMemo } from 'react';
import { ReportTemplate } from '../../constants';
import SearchIcon from '../icons/SearchIcon';
import CloseIcon from '../icons/CloseIcon';
import { FileText, Check, Sparkles, Filter, Eye } from 'lucide-react';
import { isTableRowFinding, parseTableRow } from '../../services/docxService';

interface TemplateSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  templates: ReportTemplate[];
  onSelectTemplate: (template: ReportTemplate) => void;
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

const TemplateSelectionModal: React.FC<TemplateSelectionModalProps> = ({ isOpen, onClose, templates, onSelectTemplate }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [modalityFilter, setModalityFilter] = useState<'ALL' | 'CT' | 'MRI'>('ALL');
  const [regionFilter, setRegionFilter] = useState<string>('ALL');
  const [selectedPreview, setSelectedPreview] = useState<ReportTemplate | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setModalityFilter('ALL');
      setRegionFilter('ALL');
      setSelectedPreview(null);
    }
  }, [isOpen]);

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

  // Parse details for preview pane
  const parsedPreview = useMemo(() => {
    if (!selectedPreview) return null;
    let title = selectedPreview.name;
    let technique = '';
    let findings: string[] = [];
    let impression = '';

    if (selectedPreview.lines && selectedPreview.lines.length > 0) {
      title = selectedPreview.lines[0] || selectedPreview.name;
      let inImpression = false;
      const impLines: string[] = [];

      for (let i = 1; i < selectedPreview.lines.length; i++) {
        const line = selectedPreview.lines[i].trim();
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
        const parsed = JSON.parse(selectedPreview.content);
        title = parsed.title || selectedPreview.name;
        technique = parsed.technique || '';
        findings = parsed.normal_findings || [];
        impression = (parsed.default_impression || parsed.impression || '').replace(/^IMPRESSION:?#*/i, '');
      } catch {
        technique = selectedPreview.description;
        findings = selectedPreview.content.split('\n').filter(Boolean);
      }
    }

    return { title, technique, findings, impression };
  }, [selectedPreview]);

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
        </div>

        {/* Content Body: Split View (List on left, Preview on right) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          {/* Template List Column */}
          <div className="w-full md:w-1/2 lg:w-5/12 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 overflow-y-auto p-3 space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 px-2 py-1">
              Found {filteredTemplates.length} matching {filteredTemplates.length === 1 ? 'template' : 'templates'}
            </div>

            {filteredTemplates.length > 0 ? (
              <ul className="space-y-1.5">
                {filteredTemplates.map((template) => {
                  const isSelected = selectedPreview?.name === template.name;
                  const isCT = (template.modality || template.category || '').toUpperCase().includes('CT');
                  const isMRI = (template.modality || template.category || '').toUpperCase().includes('MRI');
                  const linesCount = template.lines?.length || 0;

                  return (
                    <li key={template.id || template.name}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedPreview(template)}
                        onDoubleClick={() => onSelectTemplate(template)}
                        onKeyDown={(e) => { if (e.key === 'Enter') onSelectTemplate(template); }}
                        className={`w-full text-left p-3 rounded-xl transition-all flex items-start justify-between gap-2.5 border cursor-pointer ${
                          isSelected
                            ? 'bg-blue-50/80 dark:bg-blue-950/40 border-blue-400 dark:border-blue-600 ring-1 ring-blue-400 shadow-xs'
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 mb-1">
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
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectTemplate(template);
                            }}
                            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-xs font-bold rounded-lg shadow-xs transition-all cursor-pointer"
                            title={`Select ${template.name}`}
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Select</span>
                          </button>
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
          <div className="w-full md:w-1/2 lg:w-7/12 flex flex-col bg-slate-50/50 dark:bg-slate-950/40 overflow-hidden">
            {selectedPreview && parsedPreview ? (
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
                    onClick={() => onSelectTemplate(selectedPreview)}
                    className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-xs sm:text-sm font-bold rounded-xl shadow-md transition-all flex-shrink-0"
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
                <div className="pt-3 mt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between flex-shrink-0">
                  <span className="text-[11px] text-slate-400">
                    Click "Use Template" to insert this structure into dictation.
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelectTemplate(selectedPreview)}
                    className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl shadow-xs transition-colors"
                  >
                    Select "{selectedPreview.name}"
                  </button>
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
      </div>
    </div>
  );
};

export default TemplateSelectionModal;
