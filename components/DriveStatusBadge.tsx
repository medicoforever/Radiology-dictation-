import React, { useState, useEffect } from 'react';
import {
  subscribeToAuth,
  signInWithGoogle,
  signOutGoogle,
  isDriveConnected,
  DriveUser,
  SaveResult,
  openDriveHtmlInBrowser
} from '../services/googleDriveService';
import { User } from 'firebase/auth';

interface DriveStatusBadgeProps {
  lastSaveResult?: SaveResult | null;
  onClearLastSave?: () => void;
  onOpenReportsModal?: () => void;
}

export const DriveStatusBadge: React.FC<DriveStatusBadgeProps> = ({ lastSaveResult, onClearLastSave, onOpenReportsModal }) => {
  const [user, setUser] = useState<User | DriveUser | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [showDropdown, setShowDropdown] = useState<boolean>(false);
  const [showGuideModal, setShowGuideModal] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToAuth((currentUser, token) => {
      setUser(currentUser);
      setIsConnected(!!(currentUser && token));
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const handleSignIn = async () => {
    try {
      setIsLoading(true);
      setError(null);
      await signInWithGoogle();
      setShowDropdown(false);
    } catch (err: any) {
      console.error('Sign in error:', err);
      setError(err?.message || 'Failed to connect Google Drive');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      setIsLoading(true);
      await signOutGoogle();
      setShowDropdown(false);
    } catch (err: any) {
      console.error('Sign out error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const userDisplayName = user?.displayName || user?.email?.split('@')[0] || '';

  return (
    <div className="relative inline-block text-left">
      {!isConnected ? (
        <div className="inline-flex items-center gap-1.5">
          <button
            onClick={handleSignIn}
            disabled={isLoading}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200/80 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750 transition-all shadow-xs hover:shadow-sm cursor-pointer disabled:opacity-50"
            title={user ? "Google Drive session expired. Click to reconnect for auto-saving." : "Sign in with Google to automatically archive all dictations to Google Drive as HTML"}
          >
            {isLoading ? (
              <div className="w-3.5 h-3.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
            )}
            <span className="whitespace-nowrap">
              {user ? `Reconnect (${userDisplayName || 'Drive'})` : 'Connect Drive'}
            </span>
          </button>

          <button
            onClick={() => setShowGuideModal(true)}
            className="p-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 border border-slate-200/80 dark:border-slate-700 hover:bg-blue-50 dark:hover:bg-slate-700 transition-all shadow-xs cursor-pointer flex items-center justify-center min-h-[32px] min-w-[32px]"
            title="Google Drive instructions: How to add mail & view HTML dictations"
            aria-label="Google Drive instructions"
          >
            <span className="text-xs">ℹ️</span>
          </button>
        </div>
      ) : (
        <div className="relative">
          <div className="inline-flex items-center gap-1.5">
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100/80 dark:hover:bg-emerald-900/60 transition-all shadow-xs cursor-pointer"
              title="Google Drive connected - Automatic saving enabled"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <svg className="w-4 h-4 text-emerald-600 dark:text-emerald-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z" />
              </svg>
              <span className="max-w-[120px] sm:max-w-[160px] truncate font-medium">
                {userDisplayName || 'Drive Connected'}
              </span>
              <svg className={`w-3.5 h-3.5 transition-transform ${showDropdown ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>

            <button
              onClick={() => setShowGuideModal(true)}
              className="p-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 border border-slate-200/80 dark:border-slate-700 hover:bg-blue-50 dark:hover:bg-slate-700 transition-all shadow-xs cursor-pointer flex items-center justify-center min-h-[32px] min-w-[32px]"
              title="Drive instructions & tips"
              aria-label="Drive instructions & tips"
            >
              <span className="text-xs">ℹ️</span>
            </button>
          </div>

          {showDropdown && (
            <>
              <div className="fixed inset-0 z-40 bg-black/10 sm:bg-transparent" onClick={() => setShowDropdown(false)}></div>
              <div className="absolute left-0 mt-2 w-[calc(100vw-1.5rem)] max-w-[360px] sm:w-90 rounded-2xl bg-white dark:bg-slate-800 shadow-2xl border border-slate-200 dark:border-slate-700 py-3.5 px-4 z-50 text-xs space-y-3 animate-in fade-in zoom-in-95 duration-150">
                <div className="flex items-center gap-2.5 pb-2.5 border-b border-slate-100 dark:border-slate-700">
                  {user?.photoURL ? (
                    <img src={user.photoURL} alt="Avatar" className="w-8 h-8 rounded-full shrink-0" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-300 font-bold flex items-center justify-center shrink-0">
                      {(userDisplayName?.[0] || 'U').toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-800 dark:text-slate-100 truncate">
                      {userDisplayName || 'Google User'}
                    </p>
                    <p className="text-slate-500 dark:text-slate-400 truncate text-[11px]" title={user?.email || ''}>
                      {user?.email}
                    </p>
                  </div>
                </div>

                <div className="bg-emerald-50/60 dark:bg-emerald-950/30 rounded-xl p-2.5 border border-emerald-200/50 dark:border-emerald-800/50 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] gap-2">
                    <span className="text-slate-600 dark:text-slate-300 font-medium whitespace-nowrap">Auto-Save Status</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Connected & Active
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 pt-1.5 border-t border-emerald-100 dark:border-emerald-900/40 gap-2">
                    <span className="whitespace-nowrap">Storage Target:</span>
                    <span className="font-semibold text-slate-700 dark:text-slate-300 truncate">Radiology Dictations/</span>
                  </div>
                </div>

                {lastSaveResult && lastSaveResult.success && (
                  <div className="p-2.5 bg-blue-50/60 dark:bg-blue-950/30 rounded-xl border border-blue-200/50 dark:border-blue-800/50 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-700 dark:text-slate-200 text-[11px]">Latest Auto-Saved Report:</span>
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold shrink-0">✓ Synced</span>
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 truncate font-mono bg-white/70 dark:bg-slate-900/60 px-2 py-1 rounded-lg border border-slate-200/60 dark:border-slate-700/60" title={lastSaveResult.fileName}>
                      {lastSaveResult.fileName}
                    </p>
                    <div className="flex items-center gap-2 pt-0.5">
                      <button
                        onClick={() => openDriveHtmlInBrowser(lastSaveResult.fileId, lastSaveResult.htmlContent)}
                        className="flex-1 py-1.5 px-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-[11px] transition-colors flex items-center justify-center gap-1 cursor-pointer shadow-xs min-h-[34px]"
                        title="Open interactive report directly in Google Chrome"
                      >
                        <span>Open in Chrome 🌐</span>
                      </button>
                      {(lastSaveResult.folderLink || lastSaveResult.webViewLink) && (
                        <a
                          href={lastSaveResult.folderLink || lastSaveResult.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="py-1.5 px-3 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium text-[11px] transition-colors flex items-center justify-center shrink-0 min-h-[34px]"
                          title="Open Drive folder"
                        >
                          Drive 📁
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {/* HTML Viewing Guidance */}
                <div className="p-2.5 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-900/50 text-[11px] text-amber-950 dark:text-amber-200 leading-relaxed space-y-1">
                  <p className="font-bold flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
                    <span>💡</span>
                    <span>Optimal HTML Report Viewing</span>
                  </p>
                  <p>
                    Dictated reports are designed to be viewed in HTML format. When accessing your Google Drive folder, download the HTML report file to your device and open it in Google Chrome for the best interactive viewing, editing, and copying experience.
                  </p>
                </div>

                {/* Telegram Guidance for adding mail */}
                <div className="p-2.5 rounded-xl bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200/70 dark:border-blue-900/50 text-[11px] text-blue-950 dark:text-blue-200 leading-relaxed space-y-1">
                  <p className="font-bold flex items-center gap-1.5 text-blue-800 dark:text-blue-300">
                    <span>📱</span>
                    <span>Account Authorization</span>
                  </p>
                  <p>
                    To connect your Google Drive and securely sync your dictated findings across devices, please send a message with your Google email address on Telegram to{' '}
                    <a
                      href="https://t.me/raddoc96"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-bold underline text-blue-600 dark:text-blue-400 hover:text-blue-500"
                    >
                      https://t.me/raddoc96
                    </a>{' '}
                    so your account can be authorized.
                  </p>
                </div>

                {onOpenReportsModal && (
                  <button
                    onClick={() => {
                      setShowDropdown(false);
                      onOpenReportsModal();
                    }}
                    className="w-full text-center py-2.5 px-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-xs transition-all cursor-pointer min-h-[38px] flex items-center justify-center gap-2 shadow-sm"
                  >
                    <span>☁️</span>
                    <span>Browse All Cloud Reports</span>
                  </button>
                )}

                <button
                  onClick={() => {
                    setShowDropdown(false);
                    setShowGuideModal(true);
                  }}
                  className="w-full text-center py-2 px-3 rounded-lg bg-slate-100 dark:bg-slate-700/60 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span>ℹ️</span>
                  <span>Drive Instructions & Tips</span>
                </button>

                <div className="pt-2 border-t border-slate-100 dark:border-slate-700 flex flex-col gap-1.5">
                  <button
                    onClick={handleSignIn}
                    disabled={isLoading}
                    className="w-full text-center py-2 px-3 rounded-lg bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/40 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-medium transition-colors cursor-pointer min-h-[36px] flex items-center justify-center"
                  >
                    Switch or Reconnect Google Account
                  </button>
                  <a
                    href="https://drive.google.com/drive/search?q=Radiology%20Dictations"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full text-center py-2 px-3 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium transition-colors min-h-[36px] flex items-center justify-center"
                  >
                    Open Radiology Dictations in Drive ↗
                  </a>
                  <button
                    onClick={handleSignOut}
                    className="w-full text-center py-2 px-3 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 font-medium transition-colors cursor-pointer min-h-[36px] flex items-center justify-center"
                  >
                    Disconnect Google Account
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Error / Connection Help Notification Banner */}
      {error && (
        <div className="absolute left-0 mt-2 w-[calc(100vw-2rem)] max-w-sm p-3.5 rounded-2xl bg-white dark:bg-slate-800 shadow-2xl border border-amber-300 dark:border-amber-700/80 text-xs space-y-2 z-50 animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between text-amber-800 dark:text-amber-300 font-bold">
            <span className="flex items-center gap-1.5">
              <span>⚠️</span> Google Drive Connection Notice
            </span>
            <button onClick={() => setError(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-sm cursor-pointer">✕</button>
          </div>
          <p className="text-[11.5px] text-slate-700 dark:text-slate-200 leading-relaxed">
            To connect your Google Drive and securely sync your dictated findings across devices, please send a message with your Google email address on Telegram to{' '}
            <a
              href="https://t.me/raddoc96"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold underline text-blue-600 dark:text-blue-400 hover:text-blue-500"
            >
              https://t.me/raddoc96
            </a>{' '}
            so your account can be authorized.
          </p>
          <div className="flex items-center justify-between pt-1.5 border-t border-slate-100 dark:border-slate-700">
            <a
              href="https://t.me/raddoc96"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-xs"
            >
              <span>Telegram @raddoc96</span>
              <span>↗</span>
            </a>
            <button
              onClick={() => setError(null)}
              className="px-2 py-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 font-medium cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Comprehensive Google Drive Connection & HTML Viewing Instructions Modal */}
      {showGuideModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="fixed inset-0" onClick={() => setShowGuideModal(false)} />
          <div className="relative w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-5 sm:p-6 z-10 space-y-4 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold text-xl shadow-xs">
                  ☁️
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                    Google Drive Setup & Viewing Guide
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Guidelines for cloud synchronization and viewing your reports
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowGuideModal(false)}
                className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Point 1: Connection & Adding Email */}
            <div className="p-4 rounded-xl bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-800/60 space-y-2">
              <div className="flex items-center gap-2 text-blue-800 dark:text-blue-300 font-bold text-xs sm:text-sm">
                <span className="text-base">📩</span>
                <span>Connecting Your Google Drive (Account Authorization)</span>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed font-medium">
                To connect your Google Drive to this app so your dictated findings can be saved and accessed from anywhere, your email address needs to be added to the authorized users list. Please reach out on Telegram at{' '}
                <a
                  href="https://t.me/raddoc96"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold underline text-blue-600 dark:text-blue-400 hover:text-blue-500"
                >
                  https://t.me/raddoc96
                </a>{' '}
                with your Google email to get your access authorized.
              </p>
              <div className="pt-1">
                <a
                  href="https://t.me/raddoc96"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-xs"
                >
                  <span>Message on Telegram (@raddoc96)</span>
                  <span>↗</span>
                </a>
              </div>
            </div>

            {/* Point 2: HTML Viewing Instructions */}
            <div className="p-4 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-800/60 space-y-2">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-bold text-xs sm:text-sm">
                <span className="text-base">🌐</span>
                <span>Optimal Viewing Experience for Dictated Reports</span>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed font-medium">
                Dictated files provide the best experience in HTML format. When browsing your Google Drive folder, please download the HTML file to your device first and then open it directly in the Google Chrome browser to view and interact with the report properly.
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                Opening the report in Google Chrome unlocks full functionality: one-click copying of individual findings, rich-text clipboard formatting for your PACS/RIS, inline text editing, and clean clinical layout presentation.
              </p>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
              {!isConnected ? (
                <button
                  onClick={() => {
                    setShowGuideModal(false);
                    handleSignIn();
                  }}
                  disabled={isLoading}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors cursor-pointer flex items-center gap-1.5 shadow-xs"
                >
                  <span>Connect Drive Now</span>
                </button>
              ) : (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                  ✓ Google Drive Connected
                </span>
              )}

              <button
                onClick={() => setShowGuideModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold text-xs transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
