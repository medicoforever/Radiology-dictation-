import React, { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Trash2,
  Edit2,
  BookOpen,
  Cloud,
  Search,
  Download,
  Upload,
  Check,
  RotateCcw,
} from 'lucide-react';
import {
  getMacroDictionaryStore,
  saveMacroDictionaryStore,
  subscribeToMacroDictionary,
  syncMacrosWithGoogleDrive,
  RadiologyMacro,
} from '../services/macroDictionaryService';

interface MacrosAndDictionaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  hasActiveReport?: boolean;
  onInsertMacroIntoActiveReport?: (expandedLines: string[]) => void;
}

export const MacrosAndDictionaryModal: React.FC<MacrosAndDictionaryModalProps> = ({
  isOpen,
  onClose,
  hasActiveReport = false,
  onInsertMacroIntoActiveReport,
}) => {
  const [macros, setMacros] = useState<RadiologyMacro[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  const [syncNotice, setSyncNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Inline Delete confirmation state (never uses window.confirm which gets blocked in iframes)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletedMacroBackup, setDeletedMacroBackup] = useState<RadiologyMacro | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  // Edit / Create Macro State: ONLY Macro Name and Sentence/Paragraph
  const [isEditingMacro, setIsEditingMacro] = useState(false);
  const [editingMacroId, setEditingMacroId] = useState<string | null>(null);
  const [macroName, setMacroName] = useState('');
  const [macroText, setMacroText] = useState('');

  useEffect(() => {
    const unsubscribe = subscribeToMacroDictionary(store => {
      setMacros(store.macros || []);
    });
    return unsubscribe;
  }, []);

  if (!isOpen) return null;

  const handleSyncDrive = async () => {
    setIsSyncingDrive(true);
    setSyncNotice(null);
    try {
      const result = await syncMacrosWithGoogleDrive();
      if (result.success) {
        setSyncNotice({ message: result.message || 'Synced successfully with Google Drive', type: 'success' });
      } else {
        setSyncNotice({ message: result.message || 'Could not sync with Google Drive', type: 'error' });
      }
    } catch (err: any) {
      setSyncNotice({ message: err?.message || 'Sync failed', type: 'error' });
    } finally {
      setIsSyncingDrive(false);
      setTimeout(() => setSyncNotice(null), 4000);
    }
  };

  const executeDeleteMacro = (macroId: string) => {
    const store = getMacroDictionaryStore();
    const macroToDelete = store.macros.find(m => m.id === macroId);
    const updated = store.macros.filter(m => m.id !== macroId);
    saveMacroDictionaryStore({ ...store, macros: updated });
    setConfirmDeleteId(null);
    if (isEditingMacro && editingMacroId === macroId) {
      setIsEditingMacro(false);
      setEditingMacroId(null);
    }
    if (macroToDelete) {
      setDeletedMacroBackup(macroToDelete);
      setDeleteNotice(`Macro "${macroToDelete.name}" deleted`);
      setTimeout(() => {
        setDeleteNotice(null);
      }, 5000);
    }
  };

  const handleUndoDelete = () => {
    if (!deletedMacroBackup) return;
    const store = getMacroDictionaryStore();
    saveMacroDictionaryStore({ ...store, macros: [deletedMacroBackup, ...store.macros] });
    setDeletedMacroBackup(null);
    setDeleteNotice(null);
  };

  const handleOpenCreateMacro = () => {
    setEditingMacroId(null);
    setMacroName('');
    setMacroText('');
    setConfirmDeleteId(null);
    setIsEditingMacro(true);
  };

  const handleOpenEditMacro = (macro: RadiologyMacro) => {
    setEditingMacroId(macro.id);
    setMacroName(macro.name);
    setMacroText(macro.text || (macro.findings ? macro.findings.join('\n') : ''));
    setConfirmDeleteId(null);
    setIsEditingMacro(true);
  };

  const handleSaveMacro = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = macroName.trim();
    const trimmedText = macroText.trim();
    if (!trimmedName || !trimmedText) return;

    const store = getMacroDictionaryStore();
    const textLines = trimmedText.split('\n').map(l => l.trim()).filter(Boolean);

    if (editingMacroId) {
      const updated = store.macros.map(m =>
        m.id === editingMacroId
          ? {
              ...m,
              name: trimmedName,
              text: trimmedText,
              findings: textLines.length > 0 ? textLines : [trimmedText],
              triggerPhrases: [trimmedName.toLowerCase(), `macro ${trimmedName.toLowerCase()}`],
              updatedAt: Date.now(),
            }
          : m
      );
      saveMacroDictionaryStore({ ...store, macros: updated });
    } else {
      const newMacro: RadiologyMacro = {
        id: `macro_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: trimmedName,
        text: trimmedText,
        findings: textLines.length > 0 ? textLines : [trimmedText],
        triggerPhrases: [trimmedName.toLowerCase(), `macro ${trimmedName.toLowerCase()}`],
        enabled: true,
        updatedAt: Date.now(),
      };
      saveMacroDictionaryStore({ ...store, macros: [newMacro, ...store.macros] });
    }

    setIsEditingMacro(false);
  };

  const handleExportJson = () => {
    const store = getMacroDictionaryStore();
    const exportData = {
      version: 2,
      macros: store.macros.map(m => ({
        id: m.id,
        name: m.name,
        text: m.text || (m.findings ? m.findings.join('\n') : ''),
      })),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `macros_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.macros)) {
          const store = getMacroDictionaryStore();
          const importedMacros: RadiologyMacro[] = parsed.macros
            .filter((m: any) => m && m.name && (m.text || m.findings))
            .map((m: any) => {
              const macroContent = (m.text || (Array.isArray(m.findings) ? m.findings.join('\n') : '') || '').trim();
              const mName = String(m.name).trim();
              return {
                id: m.id || `macro_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                name: mName,
                text: macroContent,
                findings: macroContent.split('\n').filter(Boolean),
                triggerPhrases: [mName.toLowerCase(), `macro ${mName.toLowerCase()}`],
                enabled: true,
                updatedAt: Date.now(),
              };
            });

          saveMacroDictionaryStore({ ...store, macros: [...importedMacros, ...store.macros] });
          setSyncNotice({ message: `Successfully imported ${importedMacros.length} macros!`, type: 'success' });
          setTimeout(() => setSyncNotice(null), 4000);
        } else {
          setSyncNotice({ message: 'Invalid format. File must contain a "macros" array.', type: 'error' });
          setTimeout(() => setSyncNotice(null), 4000);
        }
      } catch (err: any) {
        setSyncNotice({ message: 'Failed to parse JSON file: ' + err?.message, type: 'error' });
        setTimeout(() => setSyncNotice(null), 4000);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const filteredMacros = macros.filter(m => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const content = m.text || (m.findings ? m.findings.join(' ') : '');
    return m.name.toLowerCase().includes(q) || content.toLowerCase().includes(q);
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-white dark:bg-slate-850 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-900/40">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 truncate">
                <span>Macros</span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300">
                  {macros.length}
                </span>
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 truncate">
                Save macros here — say "macro [name]" while dictating to add the corresponding text.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleSyncDrive}
              disabled={isSyncingDrive}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-semibold transition-colors cursor-pointer shadow-xs disabled:opacity-50"
              title="Sync macros with Google Drive"
            >
              <Cloud className={`w-3.5 h-3.5 text-blue-600 dark:text-blue-400 ${isSyncingDrive ? 'animate-pulse' : ''}`} />
              <span className="hidden sm:inline">{isSyncingDrive ? 'Syncing...' : 'Drive Sync'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              aria-label="Close dialog"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* User Info Guide Card (Clear Dictation Instruction) */}
        <div className="mx-4 sm:mx-5 mt-3.5 mb-1 p-3 bg-indigo-50/90 dark:bg-indigo-950/60 border border-indigo-200/90 dark:border-indigo-800/80 rounded-xl flex items-start gap-2.5 text-xs text-indigo-950 dark:text-indigo-200 shadow-xs">
          <span className="text-base shrink-0 leading-none mt-0.5">💡</span>
          <div className="leading-relaxed">
            <span className="font-bold">Dictation Voice Trigger: </span>
            Save your macros here. When dictating, simply say <strong className="font-mono bg-indigo-100/90 dark:bg-indigo-900/90 px-1.5 py-0.5 rounded text-indigo-950 dark:text-indigo-100 border border-indigo-200 dark:border-indigo-800">"macro [exact macro name]"</strong> (for example: <em className="text-indigo-700 dark:text-indigo-300 font-medium">"macro normal chest"</em>), and the corresponding sentence or paragraph will automatically be added to your report.
          </div>
        </div>

        {/* Sync Toast Notice */}
        {syncNotice && (
          <div
            className={`mx-4 sm:mx-5 mt-2 px-3.5 py-2 text-xs font-semibold flex items-center justify-between rounded-lg border ${
              syncNotice.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
                : 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800'
            }`}
          >
            <span>{syncNotice.message}</span>
            <button type="button" onClick={() => setSyncNotice(null)} className="ml-2 font-bold cursor-pointer">
              ✕
            </button>
          </div>
        )}

        {/* Delete Toast with Undo Option */}
        {deleteNotice && (
          <div className="mx-4 sm:mx-5 mt-2 px-3.5 py-2 text-xs font-semibold flex items-center justify-between rounded-lg bg-slate-900 text-white dark:bg-slate-800 border border-slate-700 shadow-md">
            <span>{deleteNotice}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleUndoDelete}
                className="inline-flex items-center gap-1 text-indigo-300 hover:text-white underline cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Undo</span>
              </button>
              <button type="button" onClick={() => setDeleteNotice(null)} className="text-slate-400 hover:text-white cursor-pointer ml-1">
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Top Action Bar (when not editing) */}
        {!isEditingMacro && (
          <div className="p-3 sm:px-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 bg-white dark:bg-slate-850">
            <div className="relative flex-grow max-w-sm">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search macros..."
                className="w-full text-xs pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <button
              type="button"
              onClick={handleOpenCreateMacro}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Macro</span>
            </button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-4 sm:p-5 flex-1 overflow-y-auto min-h-[280px]">
          {/* EDIT / CREATE MACRO: Just Macro Name and Sentence/Paragraph */}
          {isEditingMacro ? (
            <form onSubmit={handleSaveMacro} className="space-y-4 max-w-xl mx-auto py-1">
              <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-700">
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  {editingMacroId ? 'Edit Macro' : 'New Macro'}
                </h3>
                <button
                  type="button"
                  onClick={() => setIsEditingMacro(false)}
                  className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline cursor-pointer"
                >
                  Cancel
                </button>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-200">
                  Macro Name *
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={macroName}
                  onChange={(e) => setMacroName(e.target.value)}
                  placeholder="e.g. Normal Appendix, Clear Chest, Normal Brain"
                  className="w-full text-xs sm:text-sm p-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                />
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  When dictating, say <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">"macro {macroName.trim() || '[macro name]'}"</span> to automatically add this text.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-200">
                  Sentence / Paragraph *
                </label>
                <textarea
                  required
                  rows={7}
                  value={macroText}
                  onChange={(e) => setMacroText(e.target.value)}
                  placeholder="Type the sentence or paragraph that will be inserted..."
                  className="w-full text-xs sm:text-sm p-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 leading-relaxed font-sans"
                />
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-700">
                {editingMacroId ? (
                  <button
                    type="button"
                    onClick={() => executeDeleteMacro(editingMacroId)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Macro</span>
                  </button>
                ) : (
                  <div />
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsEditingMacro(false)}
                    className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer"
                  >
                    {editingMacroId ? 'Save Changes' : 'Save Macro'}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            /* LIST OF USER MACROS */
            <div className="space-y-3">
              {filteredMacros.length === 0 ? (
                <div className="py-14 text-center text-slate-400">
                  <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30 text-indigo-500" />
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
                    {searchQuery.trim() ? 'No matching macros found' : 'No macros created yet'}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                    {searchQuery.trim()
                      ? 'Try adjusting your search query.'
                      : 'Create your own shortcuts by typing a macro name and its corresponding sentence or paragraph.'}
                  </p>
                  {!searchQuery.trim() && (
                    <button
                      type="button"
                      onClick={handleOpenCreateMacro}
                      className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Create Your First Macro</span>
                    </button>
                  )}
                </div>
              ) : (
                filteredMacros.map((macro) => (
                  <div
                    key={macro.id}
                    className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 shadow-xs hover:border-slate-300 dark:hover:border-slate-600 transition-all"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                            {macro.name}
                          </h4>
                          <span className="text-[10px] font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-200/60 dark:border-indigo-900/60 font-semibold">
                            Say: "macro {macro.name.toLowerCase()}"
                          </span>
                        </div>
                        <div className="mt-1.5 text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed bg-slate-50 dark:bg-slate-900/60 p-2.5 rounded-lg border border-slate-100 dark:border-slate-800 font-sans">
                          {macro.text || (macro.findings ? macro.findings.join('\n') : '')}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                        {hasActiveReport && onInsertMacroIntoActiveReport && (
                          <button
                            type="button"
                            onClick={() => {
                              const lines = macro.text
                                ? macro.text.split('\n').filter(Boolean)
                                : (macro.findings || [macro.name]);
                              onInsertMacroIntoActiveReport(lines);
                              onClose();
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 text-xs font-bold border border-emerald-200 dark:border-emerald-800 transition-colors cursor-pointer"
                            title="Insert into current report"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Insert</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleOpenEditMacro(macro)}
                          className="p-1.5 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                          title="Edit macro"
                          aria-label={`Edit ${macro.name}`}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>

                        {/* Direct, reliable inline delete (no window.confirm block) */}
                        {confirmDeleteId === macro.id ? (
                          <div className="flex items-center gap-1 bg-red-50 dark:bg-red-950/60 p-1 rounded-lg border border-red-300 dark:border-red-800 animate-in fade-in duration-100">
                            <button
                              type="button"
                              onClick={() => executeDeleteMacro(macro.id)}
                              className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-bold shadow-xs cursor-pointer"
                              title="Confirm delete"
                            >
                              Delete?
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="p-0.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 rounded cursor-pointer"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(macro.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
                            title="Delete macro"
                            aria-label={`Delete ${macro.name}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 sm:px-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportJson}
              className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer font-medium"
              title="Backup your macros to a JSON file"
            >
              <Download className="w-3 h-3" />
              <span>Export</span>
            </button>
            <span className="text-slate-300 dark:text-slate-700">•</span>
            <label
              className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer font-medium"
              title="Import macros from a JSON file"
            >
              <Upload className="w-3 h-3" />
              <span>Import</span>
              <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
            </label>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 font-semibold cursor-pointer transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default MacrosAndDictionaryModal;
