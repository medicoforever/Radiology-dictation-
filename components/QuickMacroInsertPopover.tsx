import React, { useState, useRef, useEffect } from 'react';
import { BookOpen, ChevronDown, Search, Plus, Settings } from 'lucide-react';
import { getMacroDictionaryStore, subscribeToMacroDictionary, RadiologyMacro } from '../services/macroDictionaryService';

interface QuickMacroInsertPopoverProps {
  compact?: boolean;
  buttonLabel?: string;
  onOpenManagerModal?: () => void;
  onInsertMacroFindings: (expandedLines: string[], macro: RadiologyMacro) => void;
}

export const QuickMacroInsertPopover: React.FC<QuickMacroInsertPopoverProps> = ({
  compact = false,
  buttonLabel,
  onOpenManagerModal,
  onInsertMacroFindings,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [macros, setMacros] = useState<RadiologyMacro[]>(() =>
    getMacroDictionaryStore().macros.filter(m => m.enabled !== false)
  );
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = subscribeToMacroDictionary(store => {
      setMacros((store.macros || []).filter(m => m.enabled !== false));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isOpen]);

  const filteredMacros = macros.filter(m => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const content = m.text || (m.findings ? m.findings.join(' ') : '');
    return m.name.toLowerCase().includes(q) || content.toLowerCase().includes(q);
  });

  const handleSelectMacro = (macro: RadiologyMacro) => {
    const lines = macro.text
      ? macro.text.split('\n').filter(Boolean)
      : (macro.findings || [macro.name]);
    onInsertMacroFindings(lines, macro);
    setIsOpen(false);
    setSearchQuery('');
  };

  return (
    <div className="relative inline-block text-left" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className={
          compact
            ? "px-2.5 h-7 flex items-center justify-center gap-1 text-xs font-semibold rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600 shadow-xs transition-colors cursor-pointer"
            : "text-xs sm:text-sm font-semibold py-1.5 px-3 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm bg-white text-slate-700 hover:bg-slate-200 border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600 cursor-pointer"
        }
        title="Insert a macro into report"
        aria-expanded={isOpen}
      >
        <BookOpen className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
        <span>{buttonLabel || (compact ? 'Macro' : 'Insert Macro')}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 sm:left-0 z-50 mt-1.5 w-72 sm:w-80 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-2xl p-2.5 animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100 dark:border-slate-700/80">
            <span className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
              Macros
            </span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 border border-indigo-200/60 dark:border-indigo-800/60">
              {filteredMacros.length} available
            </span>
          </div>

          {macros.length > 3 && (
            <div className="relative mb-2">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search macros..."
                className="w-full text-xs pl-8 pr-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          )}

          <div className="max-h-56 overflow-y-auto space-y-1 divide-y divide-slate-100 dark:divide-slate-750">
            {filteredMacros.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-500 dark:text-slate-400">
                {macros.length === 0 ? 'No macros created yet.' : 'No matching macros found.'}
              </div>
            ) : (
              filteredMacros.map((macro) => {
                const previewText = macro.text || (macro.findings ? macro.findings.join(' ') : '');
                return (
                  <button
                    key={macro.id}
                    type="button"
                    onClick={() => handleSelectMacro(macro)}
                    className="w-full text-left p-2 rounded-lg hover:bg-indigo-50 dark:hover:bg-slate-700/70 transition-colors group cursor-pointer block"
                  >
                    <div className="text-xs font-bold text-slate-800 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 truncate">
                      {macro.name}
                    </div>
                    {previewText && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2 leading-snug">
                        {previewText}
                      </p>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {onOpenManagerModal && (
            <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-700/80">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  onOpenManagerModal();
                }}
                className="w-full py-1.5 px-2 rounded-lg text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-slate-700 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {macros.length === 0 ? (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create New Macro</span>
                  </>
                ) : (
                  <>
                    <Settings className="w-3.5 h-3.5" />
                    <span>Manage Macros</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default QuickMacroInsertPopover;
