import React, { useState, useEffect, useCallback } from 'react';
import {
  DriveReportItem,
  listReportsForDate,
  listAvailableDates,
  getReportHtml,
  openHtmlInBrowser,
  extractFindingsFromHtml,
} from '../services/googleDriveService';

interface DriveReportsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadFindings?: (findings: string[], reportName: string) => void;
}

export const DriveReportsModal: React.FC<DriveReportsModalProps> = ({
  isOpen,
  onClose,
  onLoadFindings,
}) => {
  const [reports, setReports] = useState<DriveReportItem[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [openingFileId, setOpeningFileId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Initialize today's date in local YYYY-MM-DD
  const getTodayStr = () => {
    const d = new Date();
    const pad = (n: number) => (n < 10 ? '0' + n : n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const loadDatesAndReports = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const dates = await listAvailableDates();
      const today = getTodayStr();
      const initialDates = dates.includes(today) ? dates : [today, ...dates];
      setAvailableDates(initialDates);

      const activeDate = selectedDate || today;
      if (!selectedDate) {
        setSelectedDate(activeDate);
      }

      const files = await listReportsForDate(activeDate);
      setReports(files);
    } catch (err: any) {
      console.error('Failed to load drive reports:', err);
      setErrorMessage(err?.message || 'Failed to retrieve reports from Google Drive');
    } finally {
      setIsLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    if (isOpen) {
      loadDatesAndReports();
    }
  }, [isOpen, loadDatesAndReports]);

  const handleDateChange = async (newDate: string) => {
    setSelectedDate(newDate);
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const files = await listReportsForDate(newDate);
      setReports(files);
    } catch (err: any) {
      console.error('Failed to load reports for date:', err);
      setErrorMessage('Failed to load reports for selected date.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenInChrome = async (report: DriveReportItem) => {
    setOpeningFileId(report.id);
    try {
      const html = await getReportHtml(report.id);
      if (html) {
        const opened = openHtmlInBrowser(html);
        if (!opened) {
          setErrorMessage('Pop-up was blocked. Please allow pop-ups for this site to open reports.');
        }
      } else {
        setErrorMessage('Could not load report content from Google Drive.');
      }
    } catch (err) {
      console.error('Failed to open report in Chrome:', err);
      setErrorMessage('Error opening report.');
    } finally {
      setOpeningFileId(null);
    }
  };

  const handleLoadIntoEditor = async (report: DriveReportItem) => {
    if (!onLoadFindings) return;
    setOpeningFileId(report.id);
    try {
      const html = await getReportHtml(report.id);
      if (html) {
        const findings = extractFindingsFromHtml(html);
        if (findings.length > 0) {
          onLoadFindings(findings, report.name);
          onClose();
        } else {
          setErrorMessage('No structured findings found in this report to import.');
        }
      }
    } catch (err) {
      console.error('Failed to import report into editor:', err);
      setErrorMessage('Error importing report into editor.');
    } finally {
      setOpeningFileId(null);
    }
  };

  if (!isOpen) return null;

  const filteredReports = reports.filter((r) =>
    r.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatTime = (timeStr?: string) => {
    if (!timeStr) return '';
    try {
      const d = new Date(timeStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="fixed inset-0"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="relative w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[88vh] z-10 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 shadow-xs">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <span>Google Drive Cloud Reports</span>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300">
                  Live Sync
                </span>
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Instantly view or load dictations saved from your mobile phone
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>


        {/* Controls Bar: Date Selector & Search & Refresh */}
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <label htmlFor="drive-date-select" className="text-xs font-semibold text-slate-600 dark:text-slate-300 shrink-0">
              Date:
            </label>
            <select
              id="drive-date-select"
              value={selectedDate}
              onChange={(e) => handleDateChange(e.target.value)}
              className="text-xs font-medium bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
            >
              {availableDates.map((date) => (
                <option key={date} value={date}>
                  {date} {date === getTodayStr() ? '(Today)' : ''}
                </option>
              ))}
            </select>

            <button
              onClick={() => handleDateChange(selectedDate)}
              disabled={isLoading}
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
              title="Refresh reports list"
            >
              <span className={isLoading ? 'animate-spin' : ''}>🔄</span>
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>

          <div className="relative w-full sm:w-56">
            <input
              type="text"
              placeholder="Search reports..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <svg
              className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Error banner */}
        {errorMessage && (
          <div className="mx-4 mt-3 p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center justify-between">
            <span>{errorMessage}</span>
            <button onClick={() => setErrorMessage(null)} className="font-bold underline ml-2">
              Dismiss
            </button>
          </div>
        )}

        {/* Reports List Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {isLoading ? (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="mt-3 text-xs font-semibold text-slate-600 dark:text-slate-400">
                Fetching dictation reports from Google Drive...
              </p>
            </div>
          ) : filteredReports.length === 0 ? (
            <div className="py-12 text-center text-slate-500 dark:text-slate-400">
              <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 mx-auto flex items-center justify-center text-xl mb-2">
                📄
              </div>
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                No dictations found for {selectedDate}
              </p>
              <p className="text-xs mt-1 text-slate-500 max-w-sm mx-auto">
                Dictations you record and save on your phone will automatically show up here in real time.
              </p>
            </div>
          ) : (
            filteredReports.map((report) => {
              const isBusy = openingFileId === report.id;
              const timeDisplay = formatTime(report.createdTime);

              return (
                <div
                  key={report.id}
                  className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 hover:border-blue-300 dark:hover:border-blue-700 transition-all hover:shadow-xs"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 font-mono text-xs font-bold mt-0.5">
                      HTML
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate font-mono" title={report.name}>
                        {report.name}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                        {timeDisplay && (
                          <span className="font-semibold text-slate-700 dark:text-slate-300">
                            🕒 {timeDisplay}
                          </span>
                        )}
                        <span>•</span>
                        <span>Saved to Cloud</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                    <button
                      onClick={() => handleOpenInChrome(report)}
                      disabled={isBusy}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50 min-h-[32px]"
                      title="Open full interactive HTML report in Google Chrome"
                    >
                      {isBusy ? (
                        <span className="animate-spin text-xs">⏳</span>
                      ) : (
                        <span>🌐</span>
                      )}
                      <span>Open in Chrome</span>
                    </button>

                    {onLoadFindings && (
                      <button
                        onClick={() => handleLoadIntoEditor(report)}
                        disabled={isBusy}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50 min-h-[32px]"
                        title="Load findings into this window for inline editing and copying"
                      >
                        <span>✏️</span>
                        <span className="hidden sm:inline">Load in App</span>
                      </button>
                    )}

                    {report.webViewLink && (
                      <a
                        href={report.webViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        title="View in Google Drive"
                      >
                        📁
                      </a>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/60 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>
            {reports.length} report{reports.length === 1 ? '' : 's'} recorded on {selectedDate}
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded-lg text-xs font-medium bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
