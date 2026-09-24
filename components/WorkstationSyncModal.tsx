import React, { useState, useEffect } from 'react';
import { X, Eye, EyeOff, Settings } from 'lucide-react';

interface WorkstationSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const WorkstationSyncModal: React.FC<WorkstationSyncModalProps> = ({
  isOpen,
  onClose,
  onSaved,
}) => {
  const [token, setToken] = useState<string>('');
  const [gistId, setGistId] = useState<string>('');
  const [isEnabled, setIsEnabled] = useState<boolean>(false);
  const [showToken, setShowToken] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      const storedToken = localStorage.getItem('workstation_sync_token') || '';
      const storedGistId = localStorage.getItem('workstation_gist_id') || '';
      const storedEnabled = localStorage.getItem('workstation_sync_enabled') === 'true';
      setToken(storedToken);
      setGistId(storedGistId);
      setIsEnabled(storedEnabled);
      setShowToken(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('workstation_sync_token', token.trim());
    localStorage.setItem('workstation_gist_id', gistId.trim());
    localStorage.setItem('workstation_sync_enabled', isEnabled ? 'true' : 'false');
    onSaved();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        id="workstation-sync-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workstation-sync-modal-title"
        className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-700/60">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400">
              <Settings className="w-5 h-5" />
            </div>
            <h2
              id="workstation-sync-modal-title"
              className="text-lg font-bold text-slate-800 dark:text-slate-100"
            >
              Hospital Workstation Sync
            </h2>
          </div>
          <button
            id="workstation-close-modal-btn"
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body Form */}
        <form onSubmit={handleSave} className="p-6 space-y-5">
          {/* Input 1: GitHub Token */}
          <div>
            <label
              htmlFor="workstation-github-token-input"
              className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
            >
              GitHub Token
            </label>
            <div className="relative">
              <input
                id="workstation-github-token-input"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                className="w-full pr-10 pl-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono transition-colors"
              />
              <button
                id="workstation-token-toggle-btn"
                type="button"
                onClick={() => setShowToken((prev) => !prev)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                aria-label={showToken ? 'Hide token' : 'Show token'}
                title={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Input 2: Gist ID */}
          <div>
            <label
              htmlFor="workstation-gist-id-input"
              className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Gist ID
            </label>
            <input
              id="workstation-gist-id-input"
              type="text"
              value={gistId}
              onChange={(e) => setGistId(e.target.value)}
              placeholder="e.g. 7f8a3b2c1d0e..."
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono transition-colors"
            />
          </div>

          {/* Toggle: Enable Automatic Sync */}
          <div className="pt-1">
            <label
              htmlFor="workstation-sync-enabled-toggle"
              className="flex items-center gap-3 cursor-pointer select-none"
            >
              <input
                id="workstation-sync-enabled-toggle"
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => setIsEnabled(e.target.checked)}
                className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-slate-800 focus:ring-2 border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 cursor-pointer"
              />
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                Enable Automatic Sync
              </span>
            </label>
          </div>

          {/* Actions */}
          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              id="workstation-save-settings-btn"
              type="submit"
              className="px-5 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition-colors cursor-pointer"
            >
              Save Settings
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default WorkstationSyncModal;
