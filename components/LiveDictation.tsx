import React, { useState, useCallback, useEffect } from 'react';
import { useLiveSession } from '../hooks/useLiveSession';
import WaveformIcon from './icons/WaveformIcon';
import YinYangMicIcon from './icons/YinYangMicIcon';
import WarningIcon from './icons/WarningIcon';
import DownloadIcon from './icons/DownloadIcon';
import ResultsDisplay, { TieredModelOptgroups } from './ResultsDisplay';
import CustomPromptInput, { DocxTemplateData } from './ui/CustomPromptInput';
import { DEFAULT_LIVE_MODEL, LIVE_DICTATION_MODELS, ModelFallbackPolicy, getLiveModelFallbackChain, getModelDisplayLabel } from '../constants';
import { API_KEYS_UPDATED_EVENT, API_KEY_SETTINGS_UPDATED_EVENT, getModelFallbackPolicy } from '../services/apiKeyService';
import { getIncompleteLiveAudioSessions, recoverLiveSessionAudioAsBlob, clearSessionAudioCache } from '../services/audioCacheService';
import { triggerAudioDownload } from '../services/audioMerger';

function formatLiveStatusForUser(raw: string): string {
    if (!raw) return raw;
    let formatted = raw
        .replace(/Auto-failover:\s*/gi, 'Backup switch: ')
        .replace(/\bfailed\s*\([^)]*503[^)]*\)\s*—\s*switching to subsequent model/gi, 'is busy right now — smoothly switching to')
        .replace(/\bfailed\s*\([^)]*429[^)]*\)\s*—\s*switching to subsequent model/gi, 'reached its short-term limit — smoothly switching to')
        .replace(/\bfailed\s*\(([^)]*)\)\s*—\s*switching to subsequent model/gi, 'was interrupted — smoothly switching to')
        .replace(/\bHTTP\s*503\b|\b503\s*UNAVAILABLE\b|\b503\s*High\s*Demand\b/gi, 'temporarily busy')
        .replace(/\bHTTP\s*429\b|\b429\s*Rate\s*Limit\b|\b429\b/gi, 'short-term limit reached');

    formatted = formatted.replace(/\bmodels\/[a-z0-9.-]+\b|\bgemini-[a-z0-9.-]+\b/gi, (match) =>
        getModelDisplayLabel(match)
    );
    return formatted;
}

interface LiveDictationProps {
    onComplete: (transcript: string, audioBlob: Blob | null) => void;
    onBack: () => void;
    onOpenMacrosModal?: () => void;
}

const LiveDictation: React.FC<LiveDictationProps> = ({ onComplete, onBack, onOpenMacrosModal }) => {
    const [findings, setFindings] = useState<string[]>([]);
    const [customPrompt, setCustomPrompt] = useState('');
    const [customImages, setCustomImages] = useState<Array<{ data: string; mimeType: string }>>([]);
    const [customDocx, setCustomDocx] = useState<DocxTemplateData | null>(null);
    const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_LIVE_MODEL || 'gemini-4-hydrogen');
    const [interruptedSession, setInterruptedSession] = useState<{ sessionId: string; createdAt: number; totalChunks: number } | null>(null);
    const [isRecovering, setIsRecovering] = useState(false);
    const [fallbackPolicy, setFallbackPolicy] = useState<ModelFallbackPolicy>(() => getModelFallbackPolicy());

    useEffect(() => {
        const syncConfig = () => {
            setFallbackPolicy(getModelFallbackPolicy());
        };
        window.addEventListener(API_KEYS_UPDATED_EVENT, syncConfig);
        window.addEventListener(API_KEY_SETTINGS_UPDATED_EVENT, syncConfig);
        return () => {
            window.removeEventListener(API_KEYS_UPDATED_EVENT, syncConfig);
            window.removeEventListener(API_KEY_SETTINGS_UPDATED_EVENT, syncConfig);
        };
    }, []);

    const liveFallbackChain = getLiveModelFallbackChain(selectedModel, fallbackPolicy);

    useEffect(() => {
        getIncompleteLiveAudioSessions().then(sessions => {
            if (sessions && sessions.length > 0) {
                const sorted = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
                setInterruptedSession(sorted[0]);
            }
        }).catch(() => {});
    }, []);

    const {
        status,
        error,
        isSessionActive,
        isPaused,
        audioLevel,
        startSession,
        stopSession,
        pauseSession,
        resumeSession,
        syncFindings,
        syncCustomPrompt,
        syncCustomImages,
        syncCustomDocx,
    } = useLiveSession();

    // Keep active custom instructions, images, and docx template dynamically synchronized with live session
    useEffect(() => {
        if (syncCustomPrompt) {
            syncCustomPrompt(customPrompt);
        }
    }, [customPrompt, syncCustomPrompt]);

    useEffect(() => {
        if (syncCustomImages) {
            syncCustomImages(customImages);
        }
    }, [customImages, syncCustomImages]);

    useEffect(() => {
        if (syncCustomDocx) {
            syncCustomDocx(customDocx);
        }
    }, [customDocx, syncCustomDocx]);

    const handleStart = useCallback(() => {
        startSession(setFindings, customPrompt, selectedModel, customImages, customDocx);
    }, [startSession, customPrompt, selectedModel, customImages, customDocx]);

    const handleStop = useCallback(async () => {
        const { transcript, audioBlob } = await stopSession();
        onComplete(transcript, audioBlob);
    }, [stopSession, onComplete]);

    const handleDownloadRecovered = async () => {
        if (!interruptedSession) return;
        setIsRecovering(true);
        try {
            const blob = await recoverLiveSessionAudioAsBlob(interruptedSession.sessionId);
            if (blob) {
                triggerAudioDownload(blob, `recovered-live-session-${new Date(interruptedSession.createdAt).toLocaleTimeString().replace(/:/g, '-')}`);
            }
        } finally {
            setIsRecovering(false);
        }
    };

    const handleRestoreAndProcess = async () => {
        if (!interruptedSession) return;
        setIsRecovering(true);
        try {
            const blob = await recoverLiveSessionAudioAsBlob(interruptedSession.sessionId);
            await clearSessionAudioCache(interruptedSession.sessionId);
            setInterruptedSession(null);
            if (blob) {
                onComplete('', blob);
            }
        } finally {
            setIsRecovering(false);
        }
    };

    const handleDiscardRecovered = async () => {
        if (!interruptedSession) return;
        await clearSessionAudioCache(interruptedSession.sessionId);
        setInterruptedSession(null);
    };

    const handleSafeBack = useCallback(async () => {
        if (isSessionActive) {
            const { transcript, audioBlob } = await stopSession();
            if (audioBlob || transcript) {
                onComplete(transcript, audioBlob);
                return;
            }
        }
        onBack();
    }, [isSessionActive, stopSession, onComplete, onBack]);

    const handleUpdateFinding = useCallback((index: number, newText: string) => {
        setFindings(prevFindings => {
            const newFindings = [...prevFindings];
            if (newFindings[index] !== undefined) {
                newFindings[index] = newText;
            }
            syncFindings(newFindings);
            return newFindings;
        });
    }, [syncFindings]);

    const handleAllFindingsUpdate = useCallback((newFindings: string[]) => {
        setFindings(newFindings);
        syncFindings(newFindings);
    }, [syncFindings]);

    if (!isSessionActive) {
        return (
            <div className="flex flex-col items-center justify-center p-4">
                {interruptedSession && (
                    <div className="w-full max-w-xl mb-6 p-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700/60 shadow-sm flex flex-col gap-3 animate-in fade-in duration-200">
                        <div className="flex items-center gap-3 text-amber-800 dark:text-amber-200">
                            <WarningIcon className="w-6 h-6 shrink-0 text-amber-600 dark:text-amber-400" />
                            <div>
                                <p className="font-semibold text-sm sm:text-base">
                                    Interrupted Live Dictation Detected
                                </p>
                                <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
                                    Found unfinalized live session from {new Date(interruptedSession.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ({interruptedSession.totalChunks} audio chunks preserved in browser cache).
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2 pt-1 border-t border-amber-200 dark:border-amber-800/50 justify-end">
                            <button
                                onClick={handleDiscardRecovered}
                                disabled={isRecovering}
                                className="px-3 py-1.5 text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-amber-100 dark:hover:bg-amber-800/40 rounded-lg transition-colors cursor-pointer"
                            >
                                Discard
                            </button>
                            <button
                                onClick={handleDownloadRecovered}
                                disabled={isRecovering}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs sm:text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-200/60 dark:bg-amber-800/60 hover:bg-amber-200 rounded-lg transition-colors cursor-pointer"
                            >
                                <DownloadIcon className="w-4 h-4" />
                                {isRecovering ? 'Saving...' : 'Save WAV Audio'}
                            </button>
                            <button
                                onClick={handleRestoreAndProcess}
                                disabled={isRecovering}
                                className="px-4 py-1.5 text-xs sm:text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500 rounded-lg shadow transition-colors cursor-pointer"
                            >
                                {isRecovering ? 'Restoring...' : 'Restore & Generate Report'}
                            </button>
                        </div>
                    </div>
                )}
                <div className="relative mb-6 flex flex-col items-center">
                    <button
                        onClick={handleStart}
                        className="relative w-28 h-28 rounded-full transition-all duration-300 transform hover:scale-105 active:scale-95 hover:shadow-2xl hover:shadow-emerald-500/25 cursor-pointer focus:outline-none focus:ring-4 focus:ring-emerald-400/40 group"
                        aria-label="Start Live Dictation"
                        title="Click logo to start live dictation"
                    >
                        <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center bg-[#0A0B0E] p-1 border-2 border-slate-700/50 dark:border-slate-600 shadow-inner">
                            <YinYangMicIcon className="w-full h-full transform transition-transform duration-300 group-hover:rotate-6" />
                        </div>
                    </button>
                </div>
                <h2 className="text-2xl font-semibold text-slate-700 dark:text-slate-200 mb-2 text-center">
                    Live Dictation Mode
                </h2>
                <p className="text-slate-500 dark:text-slate-400 mb-6 text-center max-w-lg text-sm sm:text-base">
                    Real-time speech recognition and continuous medical transcription powered by <strong className="text-emerald-700 dark:text-emerald-400">{getModelDisplayLabel(selectedModel)}</strong>. Features smart acoustic voice detection, custom instruction &amp; template enforcement, and {liveFallbackChain.length > 1 ? `automatic ${liveFallbackChain.length}-model backup protection when a model is busy` : 'strict selected-model-only routing'}.
                </p>

                {/* Model Selector Card */}
                <div className="w-full max-w-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 p-3.5 rounded-xl mb-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div className="flex-1">
                        <span className="text-xs font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-300 block">
                            Speech Recognition Model
                        </span>
                        <div className="flex items-center gap-2 mt-1">
                            <select
                                value={selectedModel}
                                onChange={(e) => setSelectedModel(e.target.value)}
                                className="bg-white dark:bg-slate-800 border border-emerald-300 dark:border-emerald-700 text-slate-800 dark:text-slate-100 text-sm font-semibold rounded-lg px-2.5 py-1 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                                <TieredModelOptgroups models={LIVE_DICTATION_MODELS} />
                            </select>
                        </div>
                        <p className="text-[11px] text-emerald-700/80 dark:text-emerald-400/80 mt-1.5 leading-snug">
                            {fallbackPolicy === 'selected_only' || liveFallbackChain.length <= 1 ? (
                                <>Routing: <span className="font-semibold">{getModelDisplayLabel(selectedModel)}</span> (selected model only)</>
                            ) : (
                                <>Automatic backup order: <span className="font-semibold">{liveFallbackChain.map(getModelDisplayLabel).join(' → ')}</span></>
                            )}
                        </p>
                    </div>
                    <span className="inline-flex items-center self-start sm:self-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-800/50 dark:text-emerald-200 whitespace-nowrap">
                        {fallbackPolicy === 'selected_only' || liveFallbackChain.length <= 1
                            ? '🎯 Selected Model Only'
                            : `🛡️ ${liveFallbackChain.length}-Model Backup Safe`}
                    </span>
                </div>

                <div className="w-full max-w-md mb-6">
                   <CustomPromptInput 
                        prompt={customPrompt} 
                        onPromptChange={setCustomPrompt}
                        images={customImages}
                        onImagesChange={setCustomImages}
                        customDocx={customDocx}
                        onCustomDocxChange={setCustomDocx}
                        isLiveMode={true}
                        selectedModel={selectedModel}
                    />
                </div>

                {/* Centered Start Live Dictation Button */}
                <div className="flex items-center justify-center w-full max-w-md mb-6">
                    <button
                        onClick={handleStart}
                        className="w-full sm:w-auto px-8 flex items-center justify-center gap-2.5 bg-emerald-600 text-white font-bold py-3.5 rounded-xl hover:bg-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-300 transition-all shadow-md min-h-[48px] touch-manipulation cursor-pointer text-base"
                        aria-label="Start Live Session"
                    >
                        <WaveformIcon className="w-6 h-6" />
                        <span>Start Live Dictation</span>
                    </button>
                </div>

                {/* Voice Commands Guide placed below the start live dictation button */}
                <div className="w-full max-w-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/40 p-4 rounded-xl mb-4 text-xs text-blue-900 dark:text-blue-200 space-y-2 shadow-sm">
                    <div className="flex items-center gap-1.5 font-bold text-sm text-blue-950 dark:text-blue-100">
                        <span>🎙️</span>
                        <span>Smart Voice Commands (Obeys & Strips Commands):</span>
                    </div>
                    <ul className="list-disc list-inside space-y-1.5 text-slate-700 dark:text-slate-300">
                        <li><strong>"Next line"</strong> / <strong>"New finding"</strong>: Starts a new finding line (never dictates command words).</li>
                        <li><strong>"Full stop"</strong> / <strong>"Period"</strong>, <strong>"Comma"</strong>, <strong>"Colon"</strong>: Inserts punctuation (. , :).</li>
                        <li><strong>"Impression section"</strong> / <strong>"Start impression"</strong>: Starts uppercase IMPRESSION block.</li>
                        <li><strong>"Delete last finding"</strong> / <strong>"Remove last line"</strong>: Erases the previous finding.</li>
                        <li><strong>"Delete last word"</strong> / <strong>"Scratch that"</strong> / <strong>"Undo"</strong>: Undoes last spoken phrase.</li>
                        <li><strong>"It is not [misheard], [corrected]"</strong>: Replaces text in place (e.g. <em>"It is not calories, calculus"</em>).</li>
                        <li><strong>"Mark as bold"</strong>: Applies bold formatting.</li>
                    </ul>
                </div>

                <div className="mt-2 text-center text-sm min-h-[20px]">
                    {error ? <span className="text-red-500 font-medium">{formatLiveStatusForUser(error)}</span> : <span className="text-slate-500 dark:text-slate-400">{formatLiveStatusForUser(status)}</span>}
                </div>
            </div>
        );
    }

    return (
        <ResultsDisplay
            isLive={true}
            onStopLive={handleStop}
            liveStatus={formatLiveStatusForUser(status)}
            liveError={error ? formatLiveStatusForUser(error) : null}
            audioLevel={audioLevel}
            isPausedLive={isPaused}
            findings={findings}
            onUpdateFinding={handleUpdateFinding}
            onAllFindingsUpdate={handleAllFindingsUpdate}
            onPauseLive={pauseSession}
            onResumeLive={resumeSession}
            customPrompt={customPrompt}
            onCustomPromptChange={setCustomPrompt}
            customImages={customImages}
            onCustomImagesChange={setCustomImages}
            customDocx={customDocx}
            onCustomDocxChange={setCustomDocx}
            onReset={handleSafeBack}
            onOpenMacrosModal={onOpenMacrosModal}
            audioBlob={null}
            chatHistory={[]}
            isChatting={false}
            onSendMessage={() => {}}
            onSwitchToBatch={() => {}}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            onReprocess={() => {}}
            onContinueDictation={async () => {}}
            identifiedErrors={[]}
            errorCheckStatus={'idle'}
        />
    );
};

export default LiveDictation;

