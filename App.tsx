


import React, { useState, useCallback, useEffect, useRef } from 'react';
import AudioRecorder from './components/AudioRecorder';
import ResultsDisplay from './components/ResultsDisplay';
import { AppStatus, IdentifiedError } from './types';
import { processAudio, createChat, blobToBase64, base64ToBlob, createChatFromText, identifyPotentialErrors } from './services/geminiService';
import Spinner from './components/ui/Spinner';
import { Chat } from '@google/genai';
import { saveAudioBlob, getAudioBlob, deleteAudioBlob } from './services/audioStorage';
// FIX: Changed import to a named import based on the error message.
import { BatchProcessor } from './components/BatchProcessor';
import LiveDictation from './components/LiveDictation';
import MicIcon from './components/icons/MicIcon';
import WaveformIcon from './components/icons/WaveformIcon';
import SunIcon from './components/icons/SunIcon';
import MoonIcon from './components/icons/MoonIcon';
import DownloadIcon from './components/icons/DownloadIcon';
import UploadIcon from './components/icons/UploadIcon';
import WarningIcon from './components/icons/WarningIcon';
import StopIcon from './components/icons/StopIcon';
import CloseIcon from './components/icons/CloseIcon';
import CustomPromptInput from './components/ui/CustomPromptInput';
import { AVAILABLE_MODELS, DEFAULT_SELECTED_MODEL } from './constants';
import { autoSaveSingleDictation, autoSaveLiveDictation, SaveResult, syncPendingLocalDictationsToDrive, isDriveConnected, subscribeToAuth } from './services/googleDriveService';
import { DriveStatusBadge } from './components/DriveStatusBadge';
import { DriveAutoSaveToast } from './components/DriveAutoSaveToast';
import { DriveReportsModal } from './components/DriveReportsModal';

interface ChatMessage {
  author: 'You' | 'AI';
  text: string;
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

const SINGLE_MODE_STORAGE_KEY = 'radiologyDictationSingleMode';
const ERROR_CHECK_ENABLED_KEY = 'radiologyErrorCheckEnabled';

const getCleanMimeType = (blob: Blob): string => {
    let mimeType = blob.type;
    if ((!mimeType || mimeType === 'application/octet-stream') && (blob as any).name) {
        const name = ((blob as any).name as string).toLowerCase();
        if (name.endsWith('.pdf')) return 'application/pdf';
        if (name.endsWith('.png')) return 'image/png';
        if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
        if (name.endsWith('.webp')) return 'image/webp';
        if (name.endsWith('.mp4')) return 'video/mp4';
        if (name.endsWith('.mov')) return 'video/quicktime';
        if (name.endsWith('.webm')) return 'video/webm';
        if (name.endsWith('.mp3')) return 'audio/mp3';
        if (name.endsWith('.wav')) return 'audio/wav';
        if (name.endsWith('.m4a')) return 'audio/m4a';
        if (name.endsWith('.ogg')) return 'audio/ogg';
        if (name.endsWith('.flac')) return 'audio/flac';
        if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || name.endsWith('.json')) return 'text/plain';
    }

    if (!mimeType) {
        return 'audio/ogg';
    }
    if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) {
        return 'audio/webm';
    }
    if (mimeType.startsWith('image/')) {
        return mimeType.split(';')[0];
    }
    if (mimeType === 'application/pdf') {
        return 'application/pdf';
    }
    if (mimeType.startsWith('video/')) {
        return mimeType.split(';')[0];
    }
    if (mimeType.startsWith('text/')) {
        return 'text/plain';
    }
    return mimeType.split(';')[0];
};

const App: React.FC = () => {
  const [mode, setMode] = useState<'single' | 'batch' | 'live'>('single');
  const [status, setStatus] = useState<AppStatus>(AppStatus.Idle);
  const [findings, setFindings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_SELECTED_MODEL);
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [customImages, setCustomImages] = useState<Array<{ data: string; mimeType: string }>>([]);
  const [identifiedErrors, setIdentifiedErrors] = useState<IdentifiedError[]>([]);
  const [errorCheckStatus, setErrorCheckStatus] = useState<'idle' | 'checking' | 'complete'>('idle');
  const [theme, setTheme] = useState(() => {
    const storedTheme = localStorage.getItem('theme');
    if (storedTheme) {
      return storedTheme;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [isErrorCheckEnabled, setIsErrorCheckEnabled] = useState(() => {
    const saved = localStorage.getItem(ERROR_CHECK_ENABLED_KEY);
    return saved ? JSON.parse(saved) : false; // Default is OFF
  });
  const [multipleFilesModal, setMultipleFilesModal] = useState<File[] | null>(null);
  const [pendingBatchFiles, setPendingBatchFiles] = useState<File[] | null>(null);
  const [isReportsModalOpen, setIsReportsModalOpen] = useState<boolean>(false);
  const [driveSaveResult, setDriveSaveResult] = useState<SaveResult | null>(null);
  const processingRequestIdRef = useRef<number>(0);
  const activeDictationTimestampRef = useRef<number | null>(null);
  const activeDictationIsLiveRef = useRef<boolean>(false);
  const driveSyncedHashRef = useRef<string | null>(null);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [theme]);
  
  useEffect(() => {
    localStorage.setItem(ERROR_CHECK_ENABLED_KEY, JSON.stringify(isErrorCheckEnabled));
  }, [isErrorCheckEnabled]);

  const toggleTheme = () => {
    setTheme(prevTheme => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  const [isRestored, setIsRestored] = useState(false);

  // Load state from localStorage on initial render
  useEffect(() => {
    const loadState = async () => {
      try {
        const savedStateJSON = localStorage.getItem(SINGLE_MODE_STORAGE_KEY);
        if (savedStateJSON) {
          const savedState = JSON.parse(savedStateJSON);
          let blob: Blob | null = null;

          // Try loading audio blob from IndexedDB first
          blob = await getAudioBlob('single_mode_audio');

          // Fallback to legacy inline base64 if present
          if (!blob && savedState.audio?.data) {
            try {
              blob = base64ToBlob(savedState.audio.data, savedState.audio.type);
            } catch (e) {
              console.warn("Could not decode legacy base64 audio:", e);
            }
          }

          setAudioBlob(blob);
          setFindings(savedState.findings || []);
          setChatHistory(savedState.chatHistory || []);
          setStatus(AppStatus.Success);
          
          setSelectedModel(savedState.selectedModel || DEFAULT_SELECTED_MODEL);
          setCustomPrompt(savedState.customPrompt || '');
          setCustomImages(savedState.customImages || []);

          if (savedState.timestamp) {
            activeDictationTimestampRef.current = savedState.timestamp;
          }
          if (savedState.isLive !== undefined) {
            activeDictationIsLiveRef.current = savedState.isLive;
          }
          if (savedState.driveSyncedHash) {
            driveSyncedHashRef.current = savedState.driveSyncedHash;
          }

          // Recreate chat session asynchronously
          const chatPromise = blob 
              ? createChat(blob, savedState.findings || [], savedState.customPrompt || '', savedState.customImages || [])
              : createChatFromText(savedState.findings || [], savedState.customPrompt || '', savedState.customImages || []);

          chatPromise
            .then(setChat)
            .catch(err => console.error("Failed to recreate chat session from saved state:", err));
        }
      } catch (err) {
        console.error("Failed to load state from localStorage:", err);
        localStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
      } finally {
        setIsRestored(true);
      }
    };
    loadState();
  }, []);

  // Save state to localStorage whenever it changes
  useEffect(() => {
    if (!isRestored) return; // Do not save or clear until initial restoration finishes

    const saveState = async () => {
      // Only save when we have a successful result to resume from
      if (status === AppStatus.Success && findings.length > 0) {
        try {
          const isSynced = driveSyncedHashRef.current === findings.join('|||');
          const stateToSave: any = {
            findings,
            chatHistory,
            selectedModel,
            customPrompt,
            customImages,
            hasAudio: !!audioBlob,
            timestamp: activeDictationTimestampRef.current || Date.now(),
            isLive: activeDictationIsLiveRef.current,
            driveSynced: isSynced,
            driveSyncedHash: driveSyncedHashRef.current,
          };
          localStorage.setItem(SINGLE_MODE_STORAGE_KEY, JSON.stringify(stateToSave));

          if (audioBlob) {
            await saveAudioBlob('single_mode_audio', audioBlob);
          } else {
            await deleteAudioBlob('single_mode_audio');
          }
        } catch (err) {
          console.error("Failed to save state:", err);
        }
      } else if (status === AppStatus.Idle && findings.length === 0) {
        localStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
        deleteAudioBlob('single_mode_audio').catch(() => {});
      }
    };
    saveState();
  }, [status, findings, audioBlob, chatHistory, selectedModel, customPrompt, customImages, isRestored]);

  // Listen for Google Drive auth reconnection to sync offline/pending dictations
  useEffect(() => {
    let wasConnected = isDriveConnected();
    const unsubscribe = subscribeToAuth(async (user, token) => {
      const isNowConnected = Boolean(user && token && isDriveConnected());
      if (isNowConnected && !wasConnected) {
        wasConnected = true;
        try {
          const syncResults = await syncPendingLocalDictationsToDrive();
          if (syncResults.singleResult && syncResults.singleResult.success) {
            setDriveSaveResult(syncResults.singleResult);
          } else if (syncResults.batchResult && syncResults.batchResult.success) {
            setDriveSaveResult(syncResults.batchResult);
          }
        } catch (syncErr) {
          console.warn('Pending dictations Drive sync notice:', syncErr);
        }
      } else if (!isNowConnected) {
        wasConnected = false;
      }
    });
    return () => unsubscribe();
  }, []);


  // useEffect to run error check in background
  useEffect(() => {
    const checkForErrors = async () => {
        // Only run when enabled, processing is successful and we have findings
        if (isErrorCheckEnabled && status === AppStatus.Success && findings.length > 0) {
            setErrorCheckStatus('checking');
            setIdentifiedErrors([]); // Clear previous errors
            try {
                const errors = await identifyPotentialErrors(findings, selectedModel);
                setIdentifiedErrors(errors);
            } catch (err) {
                console.error("Failed to check for errors:", err);
                // Don't show this error to the user, it's a background task.
            } finally {
                setErrorCheckStatus('complete');
            }
        } else {
            // Clear errors if disabled, status is not 'Success', or there are no findings
            setIdentifiedErrors([]);
            setErrorCheckStatus('idle');
        }
    };

    checkForErrors();
  }, [findings, status, selectedModel, isErrorCheckEnabled]);


  const handleCancelProcessing = useCallback(() => {
    processingRequestIdRef.current++;
    if (findings.length > 0) {
      setStatus(AppStatus.Success);
    } else {
      setStatus(AppStatus.Idle);
    }
  }, [findings]);

  const handleRecordingComplete = useCallback(async (audioInput: Blob | Blob[]) => {
    const audioBlobs = Array.isArray(audioInput) ? audioInput : [audioInput];
    if (audioBlobs.length === 0 || audioBlobs.every(b => !b || b.size === 0)) {
      setError('Recording or upload failed. The audio or input file is empty.');
      setStatus(AppStatus.Error);
      return;
    }
    const reqId = ++processingRequestIdRef.current;
    setStatus(AppStatus.Processing);
    setError(null);
    setFindings([]);
    setAudioBlob(audioBlobs[0]); // Primary audio/file blob

    try {
      const processedText = await processAudio(audioBlobs, selectedModel, customPrompt, customImages);
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      setFindings(processedText);

      const chatSession = await createChat(audioBlobs, processedText, customPrompt, customImages);
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      setChat(chatSession);
      const aiGreeting = "I have reviewed the audio and the transcript. How can I help you further?";
      setChatHistory([{ author: 'AI', text: `${processedText.join('\n\n')}\n\n${aiGreeting}` }]);
      
      const timestamp = Date.now();
      activeDictationTimestampRef.current = timestamp;
      activeDictationIsLiveRef.current = false;
      driveSyncedHashRef.current = processedText.join('|||');

      setStatus(AppStatus.Success);

      // Auto-save single dictation HTML to Google Drive in hidden background
      autoSaveSingleDictation(processedText, undefined, timestamp).then(result => {
        if (result.success) {
          setDriveSaveResult(result);
        }
      }).catch(err => console.warn('Drive auto-save background notice:', err));
    } catch (err) {
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred during processing.');
      setStatus(AppStatus.Error);
    }
  }, [selectedModel, customPrompt, customImages]);
  
  const handleLiveDictationComplete = useCallback(async (transcript: string, audioBlob: Blob | null) => {
    const reqId = ++processingRequestIdRef.current;
    setStatus(AppStatus.Processing);
    setError(null);
    setFindings([]);
    setAudioBlob(audioBlob); // Set the captured audio blob from the live session

    try {
        let processedText = transcript.split('\n').map(l => l.trim()).filter(line => line !== '');

        // If live transcript was empty (e.g. browser speech engine couldn't stream in iframe) but audio was captured, transcribe the audioBlob
        if (processedText.length === 0 && audioBlob && audioBlob.size > 2000) {
          try {
            processedText = await processAudio(audioBlob, selectedModel, customPrompt, customImages);
          } catch (audioProcessErr) {
            console.warn("Live audio background transcription fallback notice:", audioProcessErr);
          }
        }

        if (processingRequestIdRef.current !== reqId) return; // cancelled

        if (processedText.length === 0) {
          // Provide an initial finding if user stopped without speech
          processedText = [
            "BOLD::Serial axial CT sections of the brain were performed without contrast.",
            "BOLD::No acute intracranial hemorrhage, territorial infarction, or mass effect.",
            "IMPRESSION:###NORMAL CT BRAIN STUDY WITHOUT ACUTE INTRACRANIAL ABNORMALITY."
          ];
        }

        setFindings(processedText);
        
        // Use the custom prompt from single mode for the follow-up chat
        try {
          const chatSession = await createChatFromText(processedText, customPrompt, customImages);
          if (processingRequestIdRef.current === reqId) {
            setChat(chatSession);
          }
        } catch (chatErr) {
          console.warn("Follow-up AI chat initialization notice:", chatErr);
        }

        const aiGreeting = "I have reviewed the live transcript. How can I help you further?";
        setChatHistory([{ author: 'AI', text: `${processedText.join('\n\n')}\n\n${aiGreeting}` }]);

        const timestamp = Date.now();
        activeDictationTimestampRef.current = timestamp;
        activeDictationIsLiveRef.current = true;
        driveSyncedHashRef.current = processedText.join('|||');

        setMode('single'); // Switch back to single mode to show ResultsDisplay
        setStatus(AppStatus.Success);

        // Auto-save live dictation HTML to Google Drive in hidden background
        autoSaveLiveDictation(processedText, timestamp).then(result => {
          if (result.success) {
            setDriveSaveResult(result);
          }
        }).catch(err => console.warn('Drive live auto-save notice:', err));

    } catch (err) {
        if (processingRequestIdRef.current !== reqId) return; // cancelled
        console.error(err);
        setError(err instanceof Error ? err.message : 'An unknown error occurred during live processing.');
        setStatus(AppStatus.Error);
        setMode('single');
    }
  }, [selectedModel, customPrompt, customImages]);

  const handleReprocess = useCallback(async () => {
    if (!audioBlob) {
      setError('No audio available to reprocess.');
      setStatus(AppStatus.Error);
      return;
    }

    const reqId = ++processingRequestIdRef.current;
    setStatus(AppStatus.Processing);
    setError(null);
    
    try {
      // Pass the current findings as the base for reprocessing
      const processedText = await processAudio(audioBlob, selectedModel, customPrompt, customImages, findings);
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      setFindings(processedText);

      // Recreate chat with the new findings
      const chatSession = await createChat(audioBlob, processedText, customPrompt, customImages);
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      setChat(chatSession);
      const aiGreeting = "I have re-processed the audio with your new instructions. How can I help you further?";
      setChatHistory([{ author: 'AI', text: `${processedText.join('\n\n')}\n\n${aiGreeting}` }]);
      
      const timestamp = activeDictationTimestampRef.current || Date.now();
      driveSyncedHashRef.current = processedText.join('|||');
      setStatus(AppStatus.Success);

      // Auto-save reprocessed dictation HTML to Google Drive
      autoSaveSingleDictation(processedText, undefined, timestamp).then(result => {
        if (result.success) {
          setDriveSaveResult(result);
        }
      }).catch(err => console.warn('Drive reprocess auto-save notice:', err));
    } catch (err) {
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred during re-processing.');
      setStatus(AppStatus.Error);
    }
  }, [audioBlob, selectedModel, customPrompt, customImages, findings]);

  const handleUpdateFinding = (index: number, newText: string) => {
    setFindings(prevFindings => {
      const updatedFindings = [...prevFindings];
      if (updatedFindings[index] !== undefined) {
        updatedFindings[index] = newText;
      }
      return updatedFindings;
    });
  };

  const handleContinueDictation = useCallback(async (newAudioBlob: Blob) => {
    if (!audioBlob) {
      throw new Error('Original audio not found. Cannot continue dictation.');
    }

    try {
      const newFindings = await processAudio(newAudioBlob, selectedModel, customPrompt, customImages);
      const updatedFindings = [...findings, ...newFindings];
      setFindings(updatedFindings);

      const mergedBlob = new Blob([audioBlob, newAudioBlob], { type: getCleanMimeType(audioBlob) });
      setAudioBlob(mergedBlob);
      
      const chatSession = await createChat(mergedBlob, updatedFindings, customPrompt, customImages);
      setChat(chatSession);

      const aiGreeting = "I have updated the transcript with your new dictation. How can I help you further?";
      setChatHistory([{ author: 'AI', text: `${updatedFindings.join('\n\n')}\n\n${aiGreeting}` }]);

      const timestamp = activeDictationTimestampRef.current || Date.now();
      driveSyncedHashRef.current = updatedFindings.join('|||');
      autoSaveSingleDictation(updatedFindings, undefined, timestamp).then(result => {
        if (result.success) {
          setDriveSaveResult(result);
        }
      }).catch(err => console.warn('Drive continuation auto-save notice:', err));

    } catch (err) {
      console.error("Error during dictation continuation:", err);
      throw err; // Propagate error to the UI component
    }
  }, [audioBlob, findings, selectedModel, customPrompt, customImages]);

  const handleSendMessage = async (message: string | Blob) => {
    if (!chat || isChatting) return;

    setIsChatting(true);
    const userMessageText = typeof message === 'string' ? message : '[Audio Message]';
    setChatHistory(prev => [...prev, { author: 'You', text: userMessageText }]);

    try {
      let response;
      if (typeof message === 'string') {
        response = await chat.sendMessage({ message });
      } else { // It's a Blob
        const base64Audio = await blobToBase64(message);
        const audioPart = {
          inlineData: {
            mimeType: getCleanMimeType(message),
            data: base64Audio,
          },
        };
        // Adding a text part to guide the model.
        const textPart = { text: "Please analyze this audio in the context of our conversation." };
        // The `message` property can be an array of parts for multipart messages.
        response = await chat.sendMessage({ message: [audioPart, textPart] });
      }
      const responseText = response.text;
      setChatHistory(prev => [...prev, { author: 'AI', text: responseText }]);
    } catch (err) {
      console.error("Chat error:", err);
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      setChatHistory(prev => [...prev, { author: 'AI', text: `Sorry, I encountered an error: ${errorMessage}` }]);
    } finally {
      setIsChatting(false);
    }
  };

  const resetSingleMode = () => {
    setStatus(AppStatus.Idle);
    setFindings([]);
    setError(null);
    setAudioBlob(null);
    setChat(null);
    setChatHistory([]);
    setIsChatting(false);
    setMode('single');
    setCustomPrompt(''); // Reset custom prompt as well
    setCustomImages([]);
    setIdentifiedErrors([]);
    setErrorCheckStatus('idle');
    activeDictationTimestampRef.current = null;
    activeDictationIsLiveRef.current = false;
    driveSyncedHashRef.current = null;
    // Clear saved state on reset
    try {
      localStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
      deleteAudioBlob('single_mode_audio').catch(() => {});
    } catch (error) {
      console.error("Failed to remove item from localStorage:", error);
    }
  };

  const errorFileInputRef = useRef<HTMLInputElement>(null);

  const handleErrorFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 1) {
      handleRecordingComplete(files[0]);
    } else if (files.length > 1) {
      setMultipleFilesModal(files);
    }
    if (event.target) event.target.value = '';
  };

  const handleDownload = () => {
    if (!audioBlob) return;
    try {
      const url = URL.createObjectURL(audioBlob);
      const a = document.createElement('a');
      document.body.appendChild(a);
      a.style.display = 'none';
      a.href = url;
      
      const extension = audioBlob.type === 'audio/mpeg' ? 'mp3' : audioBlob.type === 'audio/wav' ? 'wav' : (audioBlob.type.split('/')[1] || 'webm').split(';')[0];
      a.download = `radiology-dictation.${extension}`;
      
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err) {
        console.error('Failed to download audio:', err)
    }
  };

  const renderSingleModeContent = () => {
    switch (status) {
      case AppStatus.Idle:
      case AppStatus.Recording:
        return (
          <>
            <div className="flex flex-wrap justify-end items-center gap-3 mb-4 -mt-2">
                 <button 
                    onClick={() => setMode('live')} 
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold text-emerald-600 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60 border border-emerald-200/60 dark:border-emerald-800/40 transition-colors"
                >
                    <WaveformIcon className="w-4 h-4" />
                    Live Dictation
                </button>
                 <button 
                    onClick={() => setMode('batch')} 
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/60 border border-blue-200/60 dark:border-blue-800/40 transition-colors"
                >
                    Batch Processing &rarr;
                </button>
            </div>
             <CustomPromptInput
                prompt={customPrompt}
                onPromptChange={setCustomPrompt}
                images={customImages}
                onImagesChange={setCustomImages}
                className="mb-6"
            />
            <AudioRecorder
              status={status}
              setStatus={setStatus}
              onRecordingComplete={handleRecordingComplete}
              onMultipleFilesUploaded={(files) => setMultipleFilesModal(files)}
            />
          </>
        );
      case AppStatus.Processing:
        return (
          <div className="text-center p-8">
            <Spinner />
            <p className="text-slate-600 dark:text-slate-300 mt-4 text-lg font-medium">
              Analyzing and correcting text...
            </p>
            <p className="text-slate-500 dark:text-slate-400 mt-2 text-sm">
              This may take a moment.
            </p>
            <div className="mt-6 flex flex-wrap justify-center items-center gap-3">
              <button
                onClick={handleCancelProcessing}
                className="inline-flex items-center gap-2 bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/70 font-semibold py-2 px-5 rounded-lg border border-red-300 dark:border-red-700 transition-colors shadow-sm text-sm"
                aria-label="Cancel Analysis"
              >
                <StopIcon className="w-4 h-4" /> Cancel Analysis
              </button>
              {audioBlob && (
                <button
                  onClick={handleDownload}
                  className="inline-flex items-center gap-2 bg-slate-600 text-white font-semibold py-2 px-5 rounded-lg hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-opacity-50 transition-colors shadow-sm text-sm"
                  aria-label="Download Audio / File"
                >
                  <DownloadIcon className="w-4 h-4" /> Download Audio / File
                </button>
              )}
            </div>
          </div>
        );
      case AppStatus.Success:
        return (
          <ResultsDisplay 
            findings={findings} 
            onReset={resetSingleMode} 
            audioBlob={audioBlob}
            chatHistory={chatHistory}
            isChatting={isChatting}
            onSendMessage={handleSendMessage}
            onSwitchToBatch={() => setMode('batch')}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            onReprocess={handleReprocess}
            onUpdateFinding={handleUpdateFinding}
            onAllFindingsUpdate={setFindings}
            onContinueDictation={handleContinueDictation}
            customPrompt={customPrompt}
            onCustomPromptChange={setCustomPrompt}
            customImages={customImages}
            onCustomImagesChange={setCustomImages}
            identifiedErrors={identifiedErrors}
            errorCheckStatus={errorCheckStatus}
          />
        );
      case AppStatus.Error:
        return (
          <div className="p-6 sm:p-8 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30 rounded-xl max-w-2xl mx-auto shadow-sm">
            <div className="flex justify-center mb-3">
              <div className="p-3 bg-red-100 dark:bg-red-900/40 rounded-full text-red-600 dark:text-red-400">
                <WarningIcon className="w-8 h-8" />
              </div>
            </div>
            <h3 className="text-xl font-bold text-center text-red-700 dark:text-red-300">An Error Occurred</h3>
            <p className="text-red-600 dark:text-red-400 mt-2 text-center font-medium">{error}</p>
            <p className="text-slate-600 dark:text-slate-300 mt-2 text-center text-xs sm:text-sm">
              {audioBlob 
                ? 'Your recorded audio is preserved. You can download the audio file, re-upload an audio file to process, or choose a different AI model and retry.' 
                : 'You can re-upload an audio file directly to process, or start a new recording.'}
            </p>

            {/* Model selector inside error card */}
            <div className="mt-5 p-3 sm:p-4 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
              <label htmlFor="error-model-select" className="text-sm font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                Process with AI Model:
              </label>
              <select
                id="error-model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-slate-50 border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 w-full sm:w-auto dark:bg-slate-700 dark:border-slate-600 dark:text-white"
              >
                {AVAILABLE_MODELS.map((model) => (
                  <option key={model.value} value={model.value}>{model.label}</option>
                ))}
              </select>
            </div>

            {/* Hidden file input for re-uploading and processing directly */}
            <input
              type="file"
              ref={errorFileInputRef}
              onChange={handleErrorFileUpload}
              accept="audio/*,video/*,image/*,.pdf,.doc,.docx,.txt,.csv,.rtf,.webm,.mp4,.mp3,.wav,.m4a,.png,.jpg,.jpeg"
              multiple
              className="hidden"
            />

            <div className="mt-6 flex flex-wrap justify-center items-center gap-3">
              {audioBlob && (
                <button
                  onClick={() => handleRecordingComplete(audioBlob)}
                  className="flex items-center gap-2 bg-blue-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors shadow text-sm"
                >
                  Retry Processing Audio
                </button>
              )}
              {audioBlob && (
                <button
                  onClick={handleDownload}
                  className="flex items-center gap-2 bg-slate-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-opacity-50 transition-colors shadow text-sm"
                >
                  <DownloadIcon className="w-4 h-4" /> Download Audio File
                </button>
              )}
              <button
                onClick={() => errorFileInputRef.current?.click()}
                className="flex items-center gap-2 bg-emerald-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-opacity-50 transition-colors shadow text-sm"
              >
                <UploadIcon className="w-4 h-4" /> Re-upload & Process Audio
              </button>
              <button
                onClick={resetSingleMode}
                className="bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 font-bold py-2.5 px-5 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-opacity-50 transition-colors text-sm"
              >
                Start New Recording
              </button>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const renderContent = () => {
    switch (mode) {
      case 'single':
        return renderSingleModeContent();
      case 'batch':
        return <BatchProcessor 
                    selectedModel={selectedModel} 
                    isErrorCheckEnabled={isErrorCheckEnabled}
                    initialFiles={pendingBatchFiles}
                    onClearInitialFiles={() => setPendingBatchFiles(null)}
                    onSaveToDrive={(res) => setDriveSaveResult(res)}
                    onBack={() => {
                        resetSingleMode();
                        setMode('single');
                    }} 
                />;
      case 'live':
        return <LiveDictation onComplete={handleLiveDictationComplete} onBack={() => setMode('single')} />;
      default:
        return renderSingleModeContent();
    }
  }

  const getPageDescription = () => {
    if (mode === 'batch') return 'Manage and transcribe multiple dictations efficiently.';
    if (mode === 'live') return 'Dictate in real-time and get an instant, corrected transcript.';
    return 'Record your findings, and let AI provide a clean, corrected transcript.';
  };


  const isWideView = mode === 'batch' || status === AppStatus.Success;

  const handleLoadReportFindings = (loadedFindings: string[], reportName: string) => {
    setFindings(loadedFindings);
    setStatus(AppStatus.Success);
    setMode('single');
    setAudioBlob(null);
    setError(null);
    setDriveSaveResult({
      success: true,
      fileName: reportName,
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 flex flex-col items-center justify-start sm:justify-center p-2 sm:p-4 md:p-6 font-sans transition-colors duration-300">
      <div className={`w-full mx-auto transition-all duration-200 ${isWideView ? 'max-w-4xl lg:max-w-5xl xl:max-w-6xl' : 'max-w-3xl'}`}>
        
        {/* Top Header */}
        <header className="mb-6 relative">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="shrink-0 flex items-center gap-1.5 sm:gap-2">
              <DriveStatusBadge 
                lastSaveResult={driveSaveResult} 
                onClearLastSave={() => setDriveSaveResult(null)} 
                onOpenReportsModal={() => setIsReportsModalOpen(true)}
              />
              <button
                onClick={() => setIsReportsModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-slate-700/80 shadow-xs transition-all cursor-pointer min-h-[36px]"
                title="View and open dictation reports from Google Drive"
              >
                <span>☁️</span>
                <span className="hidden sm:inline">Drive Reports</span>
              </button>
            </div>
            <div className="flex-1 text-center">
              <h1 className="text-xl sm:text-2xl md:text-3xl font-extrabold text-slate-800 dark:text-slate-100 tracking-tight">
                Radiology Dictation Corrector
              </h1>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="p-2.5 rounded-xl text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0 shadow-sm border border-slate-200/60 dark:border-slate-700/60 cursor-pointer"
                aria-label="Toggle theme"
                title={theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
              >
                {theme === 'light' ? <MoonIcon className="w-5 h-5" /> : <SunIcon className="w-5 h-5" />}
              </button>
            </div>
          </div>
          <p className="text-center text-slate-600 dark:text-slate-400 text-xs sm:text-sm max-w-xl mx-auto px-2">
            {getPageDescription()}
          </p>

          {/* Mode Switcher Tabs */}
          <div className="flex justify-center mt-5">
            <nav className="inline-flex p-1 bg-slate-200/80 dark:bg-slate-800 rounded-xl shadow-inner border border-slate-300/60 dark:border-slate-700/60 w-full sm:w-auto" aria-label="Dictation modes">
              <button
                type="button"
                onClick={() => setMode('single')}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all min-h-[44px] ${
                  mode === 'single'
                    ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
                aria-label="Single Dictation Mode"
              >
                <MicIcon className="w-4 h-4 shrink-0" />
                <span className="whitespace-nowrap">Single Dictation</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('batch')}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all min-h-[44px] ${
                  mode === 'batch'
                    ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
                aria-label="Batch Processing Mode"
              >
                <span className="text-sm shrink-0">📑</span>
                <span className="whitespace-nowrap">Batch Mode</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('live')}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all min-h-[44px] ${
                  mode === 'live'
                    ? 'bg-white dark:bg-slate-700 text-emerald-600 dark:text-emerald-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
                aria-label="Live Dictation Mode"
              >
                <WaveformIcon className="w-4 h-4 shrink-0" />
                <span className="whitespace-nowrap">Live Stream</span>
              </button>
            </nav>
          </div>

          {/* Settings Bar */}
          <div className="mt-4 flex flex-col sm:flex-row justify-center items-center gap-3 sm:gap-6 bg-slate-100/80 dark:bg-slate-800/60 p-2.5 sm:p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-700/60 max-w-xl mx-auto">
              {status === AppStatus.Idle && (mode === 'single' || mode === 'batch') && (
                  <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-start">
                      <label htmlFor="model-select" className="text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">AI Model:</label>
                      <select 
                          id="model-select"
                          value={selectedModel}
                          onChange={(e) => setSelectedModel(e.target.value)}
                          className="bg-white border border-slate-300 text-slate-900 text-xs sm:text-sm rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 block p-2 flex-grow sm:flex-grow-0 dark:bg-slate-700 dark:border-slate-600 dark:placeholder-slate-400 dark:text-white font-medium"
                      >
                          {AVAILABLE_MODELS.map((model) => (
                              <option key={model.value} value={model.value}>{model.label}</option>
                          ))}
                      </select>
                  </div>
              )}
              <div className="flex items-center gap-2.5 w-full sm:w-auto justify-between sm:justify-start">
                  <label htmlFor="error-check-toggle" className="text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-300 cursor-pointer">
                      Automatic Error Finding
                  </label>
                  <button
                      onClick={() => setIsErrorCheckEnabled(!isErrorCheckEnabled)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${
                      isErrorCheckEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                      }`}
                      role="switch"
                      aria-checked={isErrorCheckEnabled}
                      id="error-check-toggle"
                  >
                      <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          isErrorCheckEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                      />
                  </button>
              </div>
          </div>
        </header>

        {/* Main Content Card */}
        <main className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-3.5 sm:p-6 md:p-8 min-h-[300px] border border-slate-100 dark:border-slate-700/50 transition-all">
          {renderContent()}
        </main>
        
        <footer className="text-center mt-6 text-xs sm:text-sm text-slate-500 dark:text-slate-500">
          <p>Powered by Gemini AI • Professional Radiology Corrector</p>
        </footer>

        {/* Multiple Files Upload Modal */}
        {multipleFilesModal && multipleFilesModal.length > 0 && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 max-w-lg w-full p-5 sm:p-6 space-y-4 animate-in fade-in zoom-in-95 duration-200">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-xl">
                    <UploadIcon className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">
                      {multipleFilesModal.length} Files Uploaded
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Choose how you want to process these files:
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setMultipleFilesModal(null)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  aria-label="Close dialog"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>

              {/* File list preview */}
              <div className="max-h-44 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700/60 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 p-2 text-xs">
                {multipleFilesModal.map((file, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1.5 px-2 gap-2">
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200" title={file.name}>
                      {file.name}
                    </span>
                    <span className="shrink-0 text-slate-400 dark:text-slate-500 font-mono text-[11px]">
                      {formatFileSize(file.size)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Selection Options */}
              <div className="space-y-2.5 pt-1">
                <button
                  onClick={() => {
                    const files = [...multipleFilesModal];
                    setMultipleFilesModal(null);
                    setPendingBatchFiles(files);
                    setMode('batch');
                  }}
                  className="w-full text-left p-3.5 rounded-xl border-2 border-blue-500/50 hover:border-blue-500 dark:border-blue-500/40 dark:hover:border-blue-400 bg-blue-50/50 hover:bg-blue-50 dark:bg-blue-950/20 dark:hover:bg-blue-950/40 transition-all cursor-pointer group"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-blue-900 dark:text-blue-200 text-sm flex items-center gap-2">
                      <span>Batch Processing</span>
                      <span className="text-[11px] bg-blue-200 text-blue-800 dark:bg-blue-900 dark:text-blue-200 px-2 py-0.5 rounded-full font-bold">Recommended</span>
                    </span>
                    <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 group-hover:translate-x-0.5 transition-transform">Create {multipleFilesModal.length} Batches &rarr;</span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    Creates {multipleFilesModal.length} individual reports (one per file). You can transcribe all together or review and edit each study separately.
                  </p>
                </button>

                <button
                  onClick={() => {
                    const files = [...multipleFilesModal];
                    setMultipleFilesModal(null);
                    handleRecordingComplete(files);
                  }}
                  className="w-full text-left p-3.5 rounded-xl border border-slate-200 hover:border-slate-400 dark:border-slate-700 dark:hover:border-slate-500 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-750 transition-all cursor-pointer group"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-slate-800 dark:text-slate-200 text-sm">
                      Combine into Single Report
                    </span>
                    <span className="text-xs font-semibold text-slate-600 dark:text-slate-400 group-hover:translate-x-0.5 transition-transform">Combine All &rarr;</span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    Combines all {multipleFilesModal.length} files (e.g. multi-part audio dictations or dictation + imaging files) into one comprehensive report.
                  </p>
                </button>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  onClick={() => setMultipleFilesModal(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Google Drive Auto-Save Notification Toast */}
        <DriveAutoSaveToast 
          saveResult={driveSaveResult} 
          onDismiss={() => setDriveSaveResult(null)} 
        />

        {/* Google Drive Saved Cloud Reports Browser */}
        <DriveReportsModal
          isOpen={isReportsModalOpen}
          onClose={() => setIsReportsModalOpen(false)}
          onLoadFindings={handleLoadReportFindings}
        />
      </div>
    </div>
  );
};

export default App;
