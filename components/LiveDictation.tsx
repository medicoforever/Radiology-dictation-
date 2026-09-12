import React, { useState, useCallback, useEffect } from 'react';
import { useLiveSession } from '../hooks/useLiveSession';
import WaveformIcon from './icons/WaveformIcon';
import ResultsDisplay from './ResultsDisplay';
import CustomPromptInput from './ui/CustomPromptInput';
import { DEFAULT_LIVE_MODEL, LIVE_DICTATION_MODELS, getLiveModelFallbackChain } from '../constants';

interface LiveDictationProps {
    onComplete: (transcript: string, audioBlob: Blob | null) => void;
    onBack: () => void;
}

const LiveDictation: React.FC<LiveDictationProps> = ({ onComplete, onBack }) => {
    const [findings, setFindings] = useState<string[]>([]);
    const [customPrompt, setCustomPrompt] = useState('');
    const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_LIVE_MODEL || 'gemini-3.7-flash');

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
    } = useLiveSession();

    // Keep active custom instructions and template prompt dynamically synchronized with live session
    useEffect(() => {
        if (syncCustomPrompt) {
            syncCustomPrompt(customPrompt);
        }
    }, [customPrompt, syncCustomPrompt]);

    const handleStart = useCallback(() => {
        startSession(setFindings, customPrompt, selectedModel);
    }, [startSession, customPrompt, selectedModel]);

    const handleStop = useCallback(async () => {
        const { transcript, audioBlob } = await stopSession();
        onComplete(transcript, audioBlob);
    }, [stopSession, onComplete]);

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
                <div className="relative mb-6">
                    <div className="relative w-24 h-24 rounded-full bg-white dark:bg-slate-700 shadow-lg flex items-center justify-center">
                        <WaveformIcon className="w-10 h-10 text-emerald-600 dark:text-emerald-400 animate-pulse" />
                    </div>
                </div>
                <h2 className="text-2xl font-semibold text-slate-700 dark:text-slate-200 mb-2 text-center">
                    Live Dictation Mode
                </h2>
                <p className="text-slate-500 dark:text-slate-400 mb-6 text-center max-w-lg text-sm sm:text-base">
                    Real-time speech recognition and continuous medical transcription powered by <strong className="text-emerald-700 dark:text-emerald-400">{selectedModel}</strong>. Features smart acoustic voice detection, custom instruction & template enforcement, and automatic 3-model failover protection against rate limits.
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
                                className="bg-white dark:bg-slate-800 border border-emerald-300 dark:border-emerald-700 text-slate-800 dark:text-slate-100 font-mono text-sm font-semibold rounded-lg px-2.5 py-1 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                                {LIVE_DICTATION_MODELS.map(m => (
                                    <option key={m.value} value={m.value}>
                                        {m.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <p className="text-[11px] text-emerald-700/80 dark:text-emerald-400/80 mt-1.5 leading-snug">
                            Auto-failover chain: <span className="font-mono font-semibold">{getLiveModelFallbackChain(selectedModel).join(' → ')}</span>
                        </p>
                    </div>
                    <span className="inline-flex items-center self-start sm:self-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-800/50 dark:text-emerald-200 whitespace-nowrap">
                        🛡️ 3-Model Failover Safe
                    </span>
                </div>

                {/* Voice Commands Guide */}
                <div className="w-full max-w-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/40 p-4 rounded-xl mb-6 text-xs text-blue-900 dark:text-blue-200 space-y-2 shadow-sm">
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

                <div className="w-full max-w-md mb-6">
                   <CustomPromptInput 
                        prompt={customPrompt} 
                        onPromptChange={setCustomPrompt}
                        isLiveMode={true}
                    />
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-center gap-3 w-full max-w-md">
                    <button
                        onClick={onBack}
                        className="w-full sm:w-auto bg-slate-200 text-slate-700 font-bold py-3 px-6 rounded-xl hover:bg-slate-300 transition-colors dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600 min-h-[48px] touch-manipulation"
                    >
                        &larr; Back
                    </button>
                    <button
                        onClick={handleStart}
                        className="w-full sm:w-auto flex-1 flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-300 transition-all shadow-md min-h-[48px] touch-manipulation"
                        aria-label="Start Live Session"
                    >
                        <WaveformIcon className="w-6 h-6" />
                        Start Live Dictation
                    </button>
                </div>
                <div className="mt-6 text-center text-sm min-h-[20px]">
                    {error ? <span className="text-red-500 font-medium">{error}</span> : <span className="text-slate-500 dark:text-slate-400">{status}</span>}
                </div>
            </div>
        );
    }

    return (
        <ResultsDisplay
            isLive={true}
            onStopLive={handleStop}
            liveStatus={status}
            liveError={error}
            audioLevel={audioLevel}
            isPausedLive={isPaused}
            findings={findings}
            onUpdateFinding={handleUpdateFinding}
            onAllFindingsUpdate={handleAllFindingsUpdate}
            onPauseLive={pauseSession}
            onResumeLive={resumeSession}
            customPrompt={customPrompt}
            onCustomPromptChange={setCustomPrompt}
            onReset={onBack}
            audioBlob={null}
            chatHistory={[]}
            isChatting={false}
            onSendMessage={() => {}}
            onSwitchToBatch={() => {}}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            onReprocess={() => {}}
            onContinueDictation={async () => {}}
            customImages={[]}
            onCustomImagesChange={() => {}}
            identifiedErrors={[]}
            errorCheckStatus={'idle'}
        />
    );
};

export default LiveDictation;

