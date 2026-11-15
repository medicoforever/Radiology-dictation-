import React from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { getAudioBlob } from '../services/audioStorage';
import { safeLocalStorage } from '../services/storageService';

interface Props {
  children: ReactNode;
  sectionName?: string;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  recoveringAudio: boolean;
  audioRecoveredUrl: string | null;
}

export class ErrorBoundary extends (React.Component as new (props: Props) => {
  props: Props;
  state: State;
  setState: (updater: Partial<State> | ((prevState: State) => Partial<State>), callback?: () => void) => void;
  }) {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      recoveringAudio: false,
      audioRecoveredUrl: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('ErrorBoundary caught an unhandled error:', error, errorInfo);
    try {
      safeLocalStorage.setItem('last_app_error', {
        message: error.message,
        stack: error.stack,
        timestamp: Date.now(),
        section: this.props.sectionName || 'Root',
      });
    } catch (_) {}
  }

  handleTryRecover = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  handleRecoverAudio = async () => {
    this.setState({ recoveringAudio: true });
    try {
      const blob = (await getAudioBlob('single_mode_audio')) || (await getAudioBlob('in_flight_recording'));
      if (blob && blob.size > 0) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ext = blob.type === 'audio/mpeg' ? 'mp3' : blob.type === 'audio/wav' ? 'wav' : 'webm';
        a.download = `recovered_dictation_${Date.now()}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        this.setState({ audioRecoveredUrl: url });
      } else {
        alert('No saved audio found in local storage cache.');
      }
    } catch (e) {
      console.error('Failed to recover audio:', e);
      alert('Could not recover audio: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      this.setState({ recoveringAudio: false });
    }
  };

  handleClearCacheAndReload = () => {
    try {
      safeLocalStorage.clearTemporaryCaches();
    } catch (_) {}
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isRoot = !this.props.sectionName || this.props.sectionName === 'Root';

      return (
        <div className={`p-6 my-4 mx-auto max-w-3xl rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 shadow-xl ${isRoot ? 'min-h-[60vh] flex flex-col justify-center' : ''}`}>
          <div className="flex items-center gap-3 text-red-600 dark:text-red-400 mb-3">
            <svg className="w-8 h-8 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h2 className="text-xl font-bold">
                {this.props.sectionName ? `Display Issue in ${this.props.sectionName}` : 'Application Display Recovered'}
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                The screen was protected from turning blank. Your dictated data and audio backups are preserved.
              </p>
            </div>
          </div>

          <div className="bg-white/80 dark:bg-slate-800/80 rounded-lg p-4 border border-slate-200 dark:border-slate-700 my-4 text-sm">
            <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1">
              Error details:
            </p>
            <p className="font-mono text-xs text-red-700 dark:text-red-300 break-words">
              {this.state.error?.message || 'An unknown rendering error occurred.'}
            </p>
            {this.state.errorInfo?.componentStack && (
              <details className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                <summary className="cursor-pointer hover:underline">View technical component stack</summary>
                <pre className="mt-2 p-2 bg-slate-100 dark:bg-slate-950 rounded overflow-x-auto text-[11px] leading-tight">
                  {this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={this.handleTryRecover}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg text-sm shadow transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Try Re-rendering View
            </button>

            <button
              onClick={this.handleRecoverAudio}
              disabled={this.state.recoveringAudio}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg text-sm shadow transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {this.state.recoveringAudio ? 'Locating Audio...' : 'Recover & Download Audio'}
            </button>

            <button
              onClick={this.handleClearCacheAndReload}
              className="px-4 py-2 bg-slate-600 hover:bg-slate-700 text-white font-medium rounded-lg text-sm shadow transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Clear Cache & Reload
            </button>

            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium rounded-lg text-sm transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
