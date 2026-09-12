import React, { useEffect, useState } from 'react';
import { SaveResult, openDriveHtmlInBrowser } from '../services/googleDriveService';

interface DriveAutoSaveToastProps {
  saveResult: SaveResult | null;
  onDismiss: () => void;
}

export const DriveAutoSaveToast: React.FC<DriveAutoSaveToastProps> = ({ saveResult, onDismiss }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (saveResult && saveResult.success) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(onDismiss, 300);
      }, 7000); // 7s so user has time to click "Open in Chrome"
      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [saveResult, onDismiss]);

  if (!saveResult || !saveResult.success) return null;

  const handleOpenInBrowser = (e: React.MouseEvent) => {
    e.preventDefault();
    openDriveHtmlInBrowser(saveResult.fileId, saveResult.htmlContent);
  };

  return (
    <div
      className={`fixed bottom-5 right-5 z-50 transition-all duration-300 transform ${
        visible ? 'translate-y-0 opacity-100 scale-100' : 'translate-y-4 opacity-0 scale-95 pointer-events-none'
      }`}
    >
      <div className="bg-slate-900/95 dark:bg-slate-800/95 backdrop-blur-md text-white px-4 py-3 rounded-2xl shadow-2xl border border-slate-700/60 flex items-center gap-3 max-w-md">
        <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-xl shrink-0">
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
            <span>Saved to Google Drive</span>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </p>
          <p className="text-[11px] text-slate-400 truncate mt-0.5" title={saveResult.folderPath}>
            {saveResult.fileName}
          </p>
          <p className="text-[10px] text-amber-300/90 mt-0.5 leading-tight">
            💡 For the best experience, download the HTML report from Drive and open in Google Chrome.
          </p>
        </div>
        
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleOpenInBrowser}
            className="px-2.5 py-1 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors shadow-xs flex items-center gap-1 cursor-pointer"
            title="Open pure interactive HTML report directly in Google Chrome"
          >
            <span>Chrome</span>
            <span>↗</span>
          </button>
          
          {(saveResult.folderLink || saveResult.webViewLink) && (
            <a
              href={saveResult.folderLink || saveResult.webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2 py-1 text-xs font-medium bg-slate-700/80 hover:bg-slate-600 text-slate-200 rounded-lg transition-colors"
              title="Open folder in Google Drive"
            >
              Drive
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
