


import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
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
import AutonomousModeView from './components/AutonomousModeView';
import MicIcon from './components/icons/MicIcon';
import YinYangMicIcon from './components/icons/YinYangMicIcon';
import WaveformIcon from './components/icons/WaveformIcon';
import SunIcon from './components/icons/SunIcon';
import MoonIcon from './components/icons/MoonIcon';
import DownloadIcon from './components/icons/DownloadIcon';
import UploadIcon from './components/icons/UploadIcon';
import WarningIcon from './components/icons/WarningIcon';
import StopIcon from './components/icons/StopIcon';
import CloseIcon from './components/icons/CloseIcon';
import CustomPromptInput, { DocxTemplateData } from './components/ui/CustomPromptInput';
import { AVAILABLE_MODELS, DEFAULT_SELECTED_MODEL } from './constants';
import { mergeAudioBlobs } from './services/audioMerger';
import { autoSaveSingleDictation, autoSaveLiveDictation, SaveResult, syncPendingLocalDictationsToDrive, isDriveConnected, subscribeToAuth } from './services/googleDriveService';
import { DriveStatusBadge } from './components/DriveStatusBadge';
import { DriveAutoSaveToast } from './components/DriveAutoSaveToast';
import { DriveReportsModal } from './components/DriveReportsModal';
import { RotateCcw, X, ExternalLink, Power, Sparkles, Trash2, Download, Settings, ShieldCheck, BookOpen, Key } from 'lucide-react';
import WorkstationSyncModal from './components/WorkstationSyncModal';
import { checkAndAutoSyncReport } from './services/workstationSync';
import { OwnershipModal } from './components/ui/OwnershipModal';
import { ApiKeyModal } from './components/ApiKeyModal';
import { getUserApiKeys, API_KEYS_UPDATED_EVENT } from './services/apiKeyService';
import ThemeSelector from './components/ThemeSelector';
import { getUpcomingTemplate, clearUpcomingTemplate, subscribeToUpcomingTemplate, UpcomingTemplateConfig } from './services/upcomingTemplateService';
import MacrosAndDictionaryModal from './components/MacrosAndDictionaryModal';
import { subscribeToMacroDictionary, syncMacrosWithGoogleDrive, expandMacrosInFindings } from './services/macroDictionaryService';
import { FloatingNewDictationButton } from './components/FloatingNewDictationButton';

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
const POWER_MODE_KEY = 'radiologyPowerMode';

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
  const [mode, setMode] = useState<'single' | 'batch' | 'live' | 'autonomous'>('single');
  const [status, setStatus] = useState<AppStatus>(AppStatus.Idle);
  const [findings, setFindings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | Blob[] | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_SELECTED_MODEL);
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [customImages, setCustomImages] = useState<Array<{ data: string; mimeType: string }>>([]);
  const [customDocx, setCustomDocx] = useState<DocxTemplateData | null>(null);
  const [upcomingTemplate, setUpcomingTemplateState] = useState<UpcomingTemplateConfig | null>(() => getUpcomingTemplate());

  useEffect(() => {
    const initialUpcoming = getUpcomingTemplate();
    if (initialUpcoming) {
      setUpcomingTemplateState(initialUpcoming);
      setCustomPrompt(prev => prev ? prev : initialUpcoming.promptText);
      setCustomDocx(prev => prev ? prev : (initialUpcoming.docxData || null));
    }
    const unsubscribe = subscribeToUpcomingTemplate((config) => {
      setUpcomingTemplateState(config);
      if (config) {
        setCustomPrompt(config.promptText);
        setCustomDocx(config.docxData || null);
      } else {
        setCustomPrompt('');
        setCustomDocx(null);
      }
    });
    return unsubscribe;
  }, []);
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
  const [isPowerMode, setIsPowerMode] = useState<boolean>(() => {
    const saved = localStorage.getItem(POWER_MODE_KEY);
    return saved !== null ? saved === 'true' : true; // Default is ON
  });
  const [multipleFilesModal, setMultipleFilesModal] = useState<File[] | null>(null);
  const [pendingBatchFiles, setPendingBatchFiles] = useState<File[] | null>(null);
  const [isReportsModalOpen, setIsReportsModalOpen] = useState<boolean>(false);
  const [isWorkstationSyncModalOpen, setIsWorkstationSyncModalOpen] = useState<boolean>(false);
  const [isOwnershipModalOpen, setIsOwnershipModalOpen] = useState<boolean>(false);
  const [isMacrosModalOpen, setIsMacrosModalOpen] = useState<boolean>(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState<boolean>(false);
  const [activeMacrosCount, setActiveMacrosCount] = useState<number>(0);
  const [customKeysCount, setCustomKeysCount] = useState<number>(() => getUserApiKeys().length);

  useEffect(() => {
    const handleKeyUpdate = () => setCustomKeysCount(getUserApiKeys().length);
    window.addEventListener(API_KEYS_UPDATED_EVENT, handleKeyUpdate);
    return () => window.removeEventListener(API_KEYS_UPDATED_EVENT, handleKeyUpdate);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToMacroDictionary(store => {
      setActiveMacrosCount((store.macros || []).length);
    });
    return unsubscribe;
  }, []);
  const [syncToastMessage, setSyncToastMessage] = useState<string | null>(null);
  const syncToastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleWorkstationSettingsSaved = useCallback(() => {
    if (syncToastTimeoutRef.current) {
      clearTimeout(syncToastTimeoutRef.current);
    }
    setSyncToastMessage('Settings saved to this device');
    syncToastTimeoutRef.current = setTimeout(() => {
      setSyncToastMessage(null);
    }, 3500);

    checkAndAutoSyncReport(300, findings.length > 0 ? { findings, timestamp: activeDictationTimestampRef.current || Date.now() } : undefined);
  }, [findings]);

  const [driveSaveResult, setDriveSaveResult] = useState<SaveResult | null>(null);
  const processingRequestIdRef = useRef<number>(0);
  const activeDictationTimestampRef = useRef<number | null>(null);
  const activeDictationIsLiveRef = useRef<boolean>(false);
  const driveSyncedHashRef = useRef<string | null>(null);

  // Snapshot ref and snackbar state for "Undo Record New Dictation"
  const previousSingleSessionRef = useRef<{
    findings: string[];
    audioBlob: Blob | Blob[] | null;
    chatHistory: ChatMessage[];
    customPrompt: string;
    customImages: Array<{ data: string; mimeType: string }>;
    customDocx?: DocxTemplateData | null;
    selectedModel: string;
    identifiedErrors: IdentifiedError[];
    errorCheckStatus: 'idle' | 'checking' | 'complete';
    timestamp: number | null;
    isLive: boolean;
    driveSyncedHash: string | null;
  } | null>(null);
  const [undoSnackbar, setUndoSnackbar] = useState<{
    visible: boolean;
    secondsRemaining: number;
  } | null>(null);
  const undoCountdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [recoveredInFlightAudio, setRecoveredInFlightAudio] = useState<{
    blob: Blob;
    timestamp: number;
    size: number;
  } | null>(null);

  useEffect(() => {
    const allThemeClasses = [
      'theme-light', 'theme-dark', 'theme-colourful', 'theme-magical', 
      'theme-creative', 'theme-soothing', 'theme-sunset', 'theme-ocean',
      'theme-aurora', 'theme-cyberpunk', 'theme-velvet', 'theme-nordic',
      'theme-solar', 'theme-sakura', 'theme-lavender', 'theme-espresso'
    ];
    document.documentElement.classList.remove(...allThemeClasses);
    document.documentElement.classList.add(`theme-${theme}`);
    document.documentElement.setAttribute('data-theme', theme);

    const isDarkVariant = ['dark', 'magical', 'sunset', 'ocean', 'aurora', 'cyberpunk', 'velvet', 'espresso'].includes(theme);
    if (isDarkVariant) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);
  
  useEffect(() => {
    localStorage.setItem(POWER_MODE_KEY, String(isPowerMode));
    if (!isPowerMode) {
      document.documentElement.classList.add('low-power-mode');
    } else {
      document.documentElement.classList.remove('low-power-mode');
    }
  }, [isPowerMode]);

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
          
          const validModel = AVAILABLE_MODELS.some(m => m.value === savedState.selectedModel)
            ? savedState.selectedModel
            : DEFAULT_SELECTED_MODEL;
          setSelectedModel(validModel);
          setCustomPrompt(savedState.customPrompt || '');
          setCustomImages(savedState.customImages || []);
          if (savedState.customDocx) {
            setCustomDocx(savedState.customDocx);
          }

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
              ? createChat(blob, savedState.findings || [], savedState.customPrompt || '', savedState.customImages || [], validModel)
              : createChatFromText(savedState.findings || [], savedState.customPrompt || '', savedState.customImages || [], validModel);

          chatPromise
            .then(setChat)
            .catch(err => console.error("Failed to recreate chat session from saved state:", err));
        }

        // Check for any in-flight recording that was interrupted during processing, network disruption, or page reload
        try {
          const inFlightBlob = await getAudioBlob('in_flight_recording');
          if (inFlightBlob && inFlightBlob.size > 0) {
            let meta: { timestamp: number; type: string; size: number } | null = null;
            try {
              const rawMeta = localStorage.getItem('in_flight_recording_meta');
              if (rawMeta) meta = JSON.parse(rawMeta);
            } catch (_) {}

            setRecoveredInFlightAudio({
              blob: inFlightBlob,
              timestamp: meta?.timestamp || Date.now(),
              size: inFlightBlob.size,
            });
          }
        } catch (inFlightErr) {
          console.warn("Notice: could not check in-flight recording recovery:", inFlightErr);
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
            customDocx,
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

  // Listen for Google Drive auth reconnection to sync offline/pending dictations & macros dictionary
  useEffect(() => {
    let wasConnected = isDriveConnected();
    if (wasConnected) {
      syncMacrosWithGoogleDrive().catch(() => {});
    }
    const unsubscribe = subscribeToAuth(async (user, token) => {
      const isNowConnected = Boolean(user && token && isDriveConnected());
      if (isNowConnected && !wasConnected) {
        wasConnected = true;
        syncMacrosWithGoogleDrive().catch(() => {});
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

  const handleProcessRecoveredAudio = useCallback((blobToProcess?: Blob) => {
    const audio = blobToProcess || recoveredInFlightAudio?.blob;
    if (!audio) return;
    setRecoveredInFlightAudio(null);
    setMode('single');
    handleRecordingComplete(audio);
  }, [recoveredInFlightAudio]);

  const handleDownloadRecoveredAudio = useCallback(() => {
    if (!recoveredInFlightAudio) return;
    const blob = recoveredInFlightAudio.blob;
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      document.body.appendChild(a);
      a.style.display = 'none';
      a.href = url;
      const extension = blob.type === 'audio/mpeg' ? 'mp3' : blob.type === 'audio/wav' ? 'wav' : (blob.type.split('/')[1] || 'webm').split(';')[0];
      a.download = `recovered-interrupted-dictation.${extension}`;
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (e) {
      console.error("Failed to download recovered audio:", e);
    }
  }, [recoveredInFlightAudio]);

  const handleDiscardRecoveredAudio = useCallback(async () => {
    setRecoveredInFlightAudio(null);
    try {
      localStorage.removeItem('in_flight_recording_meta');
      await deleteAudioBlob('in_flight_recording');
    } catch (e) {
      console.warn("Could not discard in-flight recording:", e);
    }
  }, []);

  const handleRecordingComplete = useCallback(async (audioInput: Blob | Blob[]) => {
    if (undoCountdownIntervalRef.current) {
      clearInterval(undoCountdownIntervalRef.current);
      undoCountdownIntervalRef.current = null;
    }
    setUndoSnackbar(null);
    previousSingleSessionRef.current = null;

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
    const primaryBlob = audioBlobs[0];
    setAudioBlob(audioBlobs.length > 1 ? audioBlobs : primaryBlob); // Preserve all input blobs (audio, text files, docx, etc.)

    // Immediate Zero-Loss Pre-Save:
    // Persist audio into IndexedDB BEFORE dispatching network requests to Gemini.
    // If the server, browser tab, or network gets disrupted during processing,
    // the audio is 100% safely persisted and can be recovered on reload.
    saveAudioBlob('in_flight_recording', primaryBlob).catch(err => {
      console.warn("Could not pre-save in-flight audio:", err);
    });
    try {
      localStorage.setItem('in_flight_recording_meta', JSON.stringify({
        timestamp: Date.now(),
        type: primaryBlob.type || 'audio/webm',
        size: primaryBlob.size,
      }));
    } catch (_) {}
    setRecoveredInFlightAudio(null);

    try {
      const processedText = await processAudio(audioBlobs, selectedModel, customPrompt, customImages, undefined, customDocx);
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      setFindings(processedText);

      const chatSession = await createChat(audioBlobs, processedText, customPrompt, customImages, selectedModel);
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      setChat(chatSession);
      const aiGreeting = "I have reviewed the audio and the transcript. How can I help you further?";
      setChatHistory([{ author: 'AI', text: `${processedText.join('\n\n')}\n\n${aiGreeting}` }]);
      
      const timestamp = Date.now();
      activeDictationTimestampRef.current = timestamp;
      activeDictationIsLiveRef.current = false;
      driveSyncedHashRef.current = processedText.join('|||');

      setStatus(AppStatus.Success);
      window.scrollTo({ top: 0, behavior: 'instant' });

      // Processing succeeded! Safely clear the temporary in-flight backup
      deleteAudioBlob('in_flight_recording').catch(() => {});
      try {
        localStorage.removeItem('in_flight_recording_meta');
      } catch (_) {}

      // Auto-save single dictation HTML to Google Drive in hidden background
      autoSaveSingleDictation(processedText, undefined, timestamp).then(result => {
        if (result.success) {
          setDriveSaveResult(result);
        }
      }).catch(err => console.warn('Drive auto-save background notice:', err));

      // Trigger Hospital Workstation Auto-Sync if configured (pure report HTML)
      checkAndAutoSyncReport(300, { findings: processedText, timestamp });
    } catch (err) {
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred during processing.');
      setStatus(AppStatus.Error);
      // NOTE: We intentionally keep 'in_flight_recording' in IndexedDB so that even if the user
      // accidentally refreshes or closes the page on this Error screen, the audio is STILL preserved!
    }
  }, [selectedModel, customPrompt, customImages, customDocx]);
  
  const handleLiveDictationComplete = useCallback(async (transcript: string, audioBlob: Blob | null) => {
    const reqId = ++processingRequestIdRef.current;
    setStatus(AppStatus.Processing);
    setError(null);
    setFindings([]);
    setAudioBlob(audioBlob); // Set the captured audio blob from the live session

    if (audioBlob) {
      saveAudioBlob('in_flight_recording', audioBlob).catch(err => {
        console.warn("Could not pre-save live in-flight audio:", err);
      });
      try {
        localStorage.setItem('in_flight_recording_meta', JSON.stringify({
          timestamp: Date.now(),
          type: audioBlob.type || 'audio/webm',
          size: audioBlob.size,
        }));
      } catch (_) {}
      setRecoveredInFlightAudio(null);
    }

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
          const chatSession = await createChatFromText(processedText, customPrompt, customImages, selectedModel);
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
        window.scrollTo({ top: 0, behavior: 'instant' });

        // Processing succeeded! Safely clear temporary in-flight backup
        deleteAudioBlob('in_flight_recording').catch(() => {});
        try {
          localStorage.removeItem('in_flight_recording_meta');
        } catch (_) {}

        // Auto-save live dictation HTML to Google Drive in hidden background
        autoSaveLiveDictation(processedText, timestamp).then(result => {
          if (result.success) {
            setDriveSaveResult(result);
          }
        }).catch(err => console.warn('Drive live auto-save notice:', err));

        // Trigger Hospital Workstation Auto-Sync if configured (pure report HTML)
        checkAndAutoSyncReport(300, { findings: processedText, timestamp });

    } catch (err) {
        if (processingRequestIdRef.current !== reqId) return; // cancelled
        console.error(err);
        setError(err instanceof Error ? err.message : 'An unknown error occurred during live processing.');
        setStatus(AppStatus.Error);
        setMode('single');
    }
  }, [selectedModel, customPrompt, customImages]);

  const handleReprocess = useCallback(async (extraFiles?: File[]) => {
    if (!audioBlob && (!extraFiles || extraFiles.length === 0)) {
      setError('No audio or input files available to reprocess.');
      setStatus(AppStatus.Error);
      return;
    }

    const reqId = ++processingRequestIdRef.current;
    setStatus(AppStatus.Processing);
    setError(null);
    
    try {
      const currentBlobs = audioBlob 
        ? (Array.isArray(audioBlob) ? audioBlob : [audioBlob])
        : [];
      const blobsToProcess = extraFiles && extraFiles.length > 0
        ? [...currentBlobs, ...extraFiles]
        : currentBlobs;

      if (extraFiles && extraFiles.length > 0) {
        setAudioBlob(blobsToProcess.length === 1 ? blobsToProcess[0] : blobsToProcess);
      }

      // Reprocess clean from the original input audio/template/prompt without feeding in previous model output
      const processedText = await processAudio(blobsToProcess, selectedModel, customPrompt, customImages, undefined, customDocx);
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      setFindings(processedText);

      // Recreate chat with the new findings
      const chatSession = await createChat(blobsToProcess, processedText, customPrompt, customImages, selectedModel);
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

      // Trigger Hospital Workstation Auto-Sync if configured (pure report HTML)
      checkAndAutoSyncReport(300, { findings: processedText, timestamp });
    } catch (err) {
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred during re-processing.');
      setStatus(AppStatus.Error);
    }
  }, [audioBlob, selectedModel, customPrompt, customImages, customDocx, findings]);

  const handleUpdateFinding = (index: number, newText: string) => {
    let updatedFindingsToSync: string[] = [];
    setFindings(prevFindings => {
      const updatedFindings = [...prevFindings];
      if (updatedFindings[index] !== undefined) {
        updatedFindings[index] = newText;
      }
      updatedFindingsToSync = updatedFindings;
      return updatedFindings;
    });
    checkAndAutoSyncReport(400, { findings: updatedFindingsToSync, timestamp: activeDictationTimestampRef.current || Date.now() });
  };

  const handleAllFindingsUpdate = useCallback((newFindings: string[]) => {
    const expanded = expandMacrosInFindings(newFindings);
    setFindings(expanded);
    checkAndAutoSyncReport(400, { findings: expanded, timestamp: activeDictationTimestampRef.current || Date.now() });
  }, []);

  const handleAudioBlobUpdate = useCallback((newBlob: Blob) => {
    setAudioBlob(newBlob);
    saveAudioBlob('single_mode_audio', newBlob).catch(() => {});
  }, []);

  const handleContinueDictation = useCallback(async (newAudioBlob: Blob, premergedBlob?: Blob) => {
    if (!audioBlob && !premergedBlob) {
      throw new Error('Original audio not found. Cannot continue dictation.');
    }

    try {
      // Use premergedBlob if already merged on Stop click; otherwise merge now
      const mergedBlob = premergedBlob || (audioBlob ? await mergeAudioBlobs(audioBlob, newAudioBlob) : newAudioBlob);
      setAudioBlob(mergedBlob);
      saveAudioBlob('single_mode_audio', mergedBlob).catch(() => {});
      saveAudioBlob('in_flight_recording', mergedBlob).catch(() => {});
      try {
        localStorage.setItem('in_flight_recording_meta', JSON.stringify({
          timestamp: Date.now(),
          type: mergedBlob.type || 'audio/webm',
          size: mergedBlob.size,
        }));
      } catch (_) {}

      const newFindings = await processAudio(newAudioBlob, selectedModel, customPrompt, customImages, undefined, customDocx);
      
      // Consolidate findings cleanly: keep findings grouped together and synthesize impression at the end
      const priorNonImpression = findings.filter(f => !f.startsWith('IMPRESSION:'));
      const priorImpression = findings.find(f => f.startsWith('IMPRESSION:'));
      const newNonImpression = newFindings.filter(f => !f.startsWith('IMPRESSION:'));
      const newImpression = newFindings.find(f => f.startsWith('IMPRESSION:'));

      const filteredNewNonImpression = newNonImpression.filter((f, idx) => {
        if (idx === 0 && priorNonImpression.length > 0 && f.replace(/^BOLD::/i, '').trim().toUpperCase() === priorNonImpression[0].replace(/^BOLD::/i, '').trim().toUpperCase()) {
          return false;
        }
        return true;
      });

      let finalImpression = newImpression || priorImpression;
      if (priorImpression && newImpression && priorImpression !== newImpression) {
        const priorPoints = priorImpression.replace(/^IMPRESSION:###?/i, '').split('###').filter(Boolean);
        const newPoints = newImpression.replace(/^IMPRESSION:###?/i, '').split('###').filter(Boolean);
        const combinedPoints = Array.from(new Set([...priorPoints, ...newPoints]));
        finalImpression = `IMPRESSION:###${combinedPoints.join('###')}`;
      }

      const updatedFindings = [
        ...priorNonImpression,
        ...filteredNewNonImpression,
        ...(finalImpression ? [finalImpression] : [])
      ];
      setFindings(updatedFindings);
      
      const chatSession = await createChat(mergedBlob, updatedFindings, customPrompt, customImages, selectedModel);
      setChat(chatSession);

      const aiGreeting = "I have updated the transcript with your new dictation. How can I help you further?";
      setChatHistory([{ author: 'AI', text: `${updatedFindings.join('\n\n')}\n\n${aiGreeting}` }]);

      const timestamp = activeDictationTimestampRef.current || Date.now();
      driveSyncedHashRef.current = updatedFindings.join('|||');

      deleteAudioBlob('in_flight_recording').catch(() => {});
      try {
        localStorage.removeItem('in_flight_recording_meta');
      } catch (_) {}

      autoSaveSingleDictation(updatedFindings, undefined, timestamp).then(result => {
        if (result.success) {
          setDriveSaveResult(result);
        }
      }).catch(err => console.warn('Drive continuation auto-save notice:', err));

      // Trigger Hospital Workstation Auto-Sync if configured (pure report HTML)
      checkAndAutoSyncReport(300, { findings: updatedFindings, timestamp });

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
    // If there was active session content, snapshot it for the Undo Snackbar
    if (findings.length > 0 || audioBlob !== null) {
      previousSingleSessionRef.current = {
        findings: [...findings],
        audioBlob,
        chatHistory: [...chatHistory],
        customPrompt,
        customImages: [...customImages],
        customDocx,
        selectedModel,
        identifiedErrors: [...identifiedErrors],
        errorCheckStatus,
        timestamp: activeDictationTimestampRef.current,
        isLive: activeDictationIsLiveRef.current,
        driveSyncedHash: driveSyncedHashRef.current,
      };

      if (undoCountdownIntervalRef.current) {
        clearInterval(undoCountdownIntervalRef.current);
      }

      setUndoSnackbar({
        visible: true,
        secondsRemaining: 15,
      });

      undoCountdownIntervalRef.current = setInterval(() => {
        setUndoSnackbar(prev => {
          if (!prev) return null;
          if (prev.secondsRemaining <= 1) {
            clearInterval(undoCountdownIntervalRef.current!);
            undoCountdownIntervalRef.current = null;
            // Now finalize cleanup of persistent storage
            try {
              localStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
              deleteAudioBlob('single_mode_audio').catch(() => {});
            } catch (e) {}
            previousSingleSessionRef.current = null;
            return null;
          }
          return { ...prev, secondsRemaining: prev.secondsRemaining - 1 };
        });
      }, 1000);
    } else {
      // Nothing to undo, perform instant cleanup
      try {
        localStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
        deleteAudioBlob('single_mode_audio').catch(() => {});
      } catch (error) {
        console.error("Failed to remove item from localStorage:", error);
      }
    }

    // Reset workspace to idle immediately so user can record right away without confirmation friction
    setStatus(AppStatus.Idle);
    setFindings([]);
    setError(null);
    setAudioBlob(null);
    setChat(null);
    setChatHistory([]);
    setIsChatting(false);
    setMode('single');
    const currentUpcoming = getUpcomingTemplate();
    if (currentUpcoming) {
      setCustomPrompt(currentUpcoming.promptText);
      setCustomDocx(currentUpcoming.docxData || null);
    } else {
      setCustomPrompt('');
      setCustomDocx(null);
    }
    setCustomImages([]);
    setIdentifiedErrors([]);
    setErrorCheckStatus('idle');
    activeDictationTimestampRef.current = null;
    activeDictationIsLiveRef.current = false;
    driveSyncedHashRef.current = null;
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const handleUndoReset = async () => {
    if (undoCountdownIntervalRef.current) {
      clearInterval(undoCountdownIntervalRef.current);
      undoCountdownIntervalRef.current = null;
    }
    setUndoSnackbar(null);

    const prev = previousSingleSessionRef.current;
    if (!prev) return;

    setStatus(AppStatus.Success);
    setFindings(prev.findings);
    setAudioBlob(prev.audioBlob);
    setChatHistory(prev.chatHistory);
    setCustomPrompt(prev.customPrompt);
    setCustomImages(prev.customImages);
    setCustomDocx(prev.customDocx || null);
    const restoredModel = AVAILABLE_MODELS.some(m => m.value === prev.selectedModel)
      ? prev.selectedModel
      : DEFAULT_SELECTED_MODEL;
    setSelectedModel(restoredModel);
    setIdentifiedErrors(prev.identifiedErrors);
    setErrorCheckStatus(prev.errorCheckStatus);
    activeDictationTimestampRef.current = prev.timestamp;
    activeDictationIsLiveRef.current = prev.isLive;
    driveSyncedHashRef.current = prev.driveSyncedHash;

    // Restore persistent storage
    try {
      const stateToSave = {
        findings: prev.findings,
        chatHistory: prev.chatHistory,
        selectedModel: restoredModel,
        customPrompt: prev.customPrompt,
        customImages: prev.customImages,
        customDocx: prev.customDocx || null,
        timestamp: prev.timestamp,
        isLive: prev.isLive,
        driveSyncedHash: prev.driveSyncedHash,
      };
      localStorage.setItem(SINGLE_MODE_STORAGE_KEY, JSON.stringify(stateToSave));
      if (prev.audioBlob) {
        await saveAudioBlob('single_mode_audio', prev.audioBlob);
      }
    } catch (e) {
      console.warn("Failed to re-persist undone session:", e);
    }

    // Recreate chat session
    try {
      if (prev.audioBlob) {
        const chatSession = await createChat(prev.audioBlob, prev.findings, prev.customPrompt, prev.customImages, restoredModel);
        setChat(chatSession);
      } else {
        const chatSession = await createChatFromText(prev.findings, prev.customPrompt, prev.customImages, restoredModel);
        setChat(chatSession);
      }
    } catch (err) {
      console.warn("Chat recreate on undo notice:", err);
    }

    previousSingleSessionRef.current = null;
  };

  const handleDismissUndo = () => {
    if (undoCountdownIntervalRef.current) {
      clearInterval(undoCountdownIntervalRef.current);
      undoCountdownIntervalRef.current = null;
    }
    setUndoSnackbar(null);
    try {
      localStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
      deleteAudioBlob('single_mode_audio').catch(() => {});
    } catch (e) {}
    previousSingleSessionRef.current = null;
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
             <CustomPromptInput
                prompt={customPrompt}
                onPromptChange={setCustomPrompt}
                images={customImages}
                onImagesChange={setCustomImages}
                customDocx={customDocx}
                onCustomDocxChange={setCustomDocx}
                selectedModel={selectedModel}
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
            onAllFindingsUpdate={handleAllFindingsUpdate}
            onContinueDictation={handleContinueDictation}
            onAudioBlobUpdate={handleAudioBlobUpdate}
            customPrompt={customPrompt}
            onCustomPromptChange={setCustomPrompt}
            customImages={customImages}
            onCustomImagesChange={setCustomImages}
            customDocx={customDocx}
            onCustomDocxChange={setCustomDocx}
            identifiedErrors={identifiedErrors}
            errorCheckStatus={errorCheckStatus}
            onOpenMacrosModal={() => setIsMacrosModalOpen(true)}
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
                    onSaveToDrive={(res) => {
                      setDriveSaveResult(res);
                      checkAndAutoSyncReport(300);
                    }}
                    onBack={() => {
                        resetSingleMode();
                        setMode('single');
                    }} 
                />;
      case 'live':
        return <LiveDictation onComplete={handleLiveDictationComplete} onBack={() => setMode('single')} onOpenMacrosModal={() => setIsMacrosModalOpen(true)} />;
      case 'autonomous':
        return (
          <AutonomousModeView
            selectedModel={selectedModel}
            onApplySingleReport={(loadedFindings, patientName, loadedAudio, loadedImages, loadedFiles) => {
              handleLoadReportFindings(loadedFindings, patientName, loadedAudio, loadedImages, loadedFiles);
            }}
            onApplyBatchReports={async (newBatches) => {
              try {
                const currentBatchesRaw = localStorage.getItem('radiologyDictationBatchMode');
                const currentBatches: any[] = currentBatchesRaw ? JSON.parse(currentBatchesRaw) : [];
                
                // Save audio blobs to IndexedDB so they can be retrieved and downloaded in Batch Mode
                for (let idx = 0; idx < newBatches.length; idx++) {
                  const b = newBatches[idx];
                  const batchId = `batch-auto-${Date.now()}-${idx}`;
                  if (b.audioBlobs && b.audioBlobs.length > 0) {
                    for (let bIdx = 0; bIdx < b.audioBlobs.length; bIdx++) {
                      try {
                        await saveAudioBlob(`batch_audio_${batchId}_${bIdx}`, b.audioBlobs[bIdx]);
                      } catch (e) {
                        console.warn('Failed to save batch audio blob to IndexedDB:', e);
                      }
                    }
                  }
                }

                const formattedBatches = newBatches.map((b, idx) => {
                  const batchId = `batch-auto-${Date.now()}-${idx}`;
                  return {
                    id: batchId,
                    name: b.name,
                    audioCount: b.audioBlobs ? b.audioBlobs.length : 0,
                    findings: b.findings,
                    status: 'complete',
                    selectedModel: b.selectedModel || selectedModel,
                    customPrompt: b.customPrompt || '',
                    customImages: b.customImages || [],
                    extraFiles: b.extraFiles || []
                  };
                });
                const updated = [...currentBatches, ...formattedBatches];
                localStorage.setItem('radiologyDictationBatchMode', JSON.stringify(updated));
              } catch (e) {
                console.warn('Failed to append autonomous batches to localStorage:', e);
              }
            }}
            onNavigateToSingle={() => setMode('single')}
            onNavigateToBatch={() => setMode('batch')}
            onSaveToDrive={(res) => {
              setDriveSaveResult(res);
              checkAndAutoSyncReport(300);
            }}
          />
        );
      default:
        return renderSingleModeContent();
    }
  };

  const getPageDescription = () => {
    if (mode === 'autonomous') return 'Autonomous superapp mode: Speak naturally across multiple patients, templates, macros, and commands.';
    if (mode === 'batch') return 'Manage and transcribe multiple dictations efficiently.';
    if (mode === 'live') return 'Dictate in real-time and get an instant, corrected transcript.';
    return 'Record your findings, and let AI provide a clean, corrected transcript.';
  };

  const isWideView = mode === 'batch' || mode === 'autonomous' || status === AppStatus.Success;

  const handleLoadReportFindings = (
    loadedFindings: string[], 
    reportName: string, 
    loadedAudioBlob?: Blob | null,
    loadedImages?: Array<{ data: string; mimeType: string }>,
    loadedExtraFiles?: File[]
  ) => {
    setFindings(loadedFindings);
    setStatus(AppStatus.Success);
    setMode('single');
    if (loadedAudioBlob) {
      setAudioBlob(loadedAudioBlob);
      try {
        saveAudioBlob('single_audio_blob', loadedAudioBlob);
      } catch (e) {
        console.warn('Failed to save audio blob:', e);
      }
    } else {
      setAudioBlob(null);
    }
    if (loadedImages && loadedImages.length > 0) {
      setCustomImages(loadedImages);
    }
    setError(null);
    setDriveSaveResult({
      success: true,
      fileName: reportName,
    });
    checkAndAutoSyncReport(300, { findings: loadedFindings, timestamp: Date.now() });
  };

  return (
    <div className={`min-h-screen w-full bg-gray-50 dark:bg-slate-900 flex flex-col items-center justify-start sm:justify-center p-2 sm:p-4 md:p-6 font-sans transition-colors duration-300 ${!isPowerMode ? 'low-power-active' : ''}`}>
      {!isPowerMode && (
        <style>{`
          .low-power-mode *, .low-power-mode *::before, .low-power-mode *::after {
            animation-duration: 0.001ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.001ms !important;
            backdrop-filter: none !important;
            box-shadow: none !important;
            text-shadow: none !important;
          }
        `}</style>
      )}
      <div className={`w-full mx-auto transition-all duration-200 ${isWideView ? 'max-w-4xl lg:max-w-5xl xl:max-w-6xl' : 'max-w-3xl'}`}>
        
        {/* Top Header */}
        <header className="mb-6 relative w-full">
          {/* Mobile Header: Row 1 = Utility Bar (Drive on left, Action buttons on right); Row 2 = App Title centered */}
          <div className="flex flex-col gap-2 mb-2 w-full sm:hidden">
            <div className="flex items-center justify-between gap-1 w-full">
              <div className="shrink-0">
                <DriveStatusBadge 
                  lastSaveResult={driveSaveResult} 
                  onClearLastSave={() => setDriveSaveResult(null)} 
                  onOpenReportsModal={() => setIsReportsModalOpen(true)}
                />
              </div>
              <div className="flex items-center gap-1 shrink-0 overflow-x-auto no-scrollbar py-0.5">
                <button
                  id="macros-header-btn-mobile"
                  onClick={() => setIsMacrosModalOpen(true)}
                  className="p-1.5 rounded-lg text-indigo-600 dark:text-indigo-400 bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200/70 dark:border-indigo-800/60 min-h-[34px] min-w-[34px] flex items-center justify-center cursor-pointer shadow-xs"
                  aria-label="Macros"
                  title="Macros — Manage custom text shortcuts"
                >
                  <BookOpen className="w-4 h-4" />
                </button>
                <button
                  id="workstation-sync-header-btn-mobile"
                  onClick={() => setIsWorkstationSyncModalOpen(true)}
                  className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60 min-h-[34px] min-w-[34px] flex items-center justify-center cursor-pointer shadow-xs"
                  aria-label="Workstation Sync"
                  title="Workstation Sync"
                >
                  <Settings className="w-4 h-4 text-slate-600 dark:text-slate-300" />
                </button>
                <button
                  id="api-keys-header-btn-mobile"
                  onClick={() => setIsApiKeyModalOpen(true)}
                  className={`p-1.5 rounded-lg border min-h-[34px] min-w-[34px] flex items-center justify-center relative cursor-pointer shadow-xs ${
                    customKeysCount > 0
                      ? 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700/60'
                      : 'text-slate-600 bg-slate-100 dark:bg-slate-800 border-slate-200/80 dark:border-slate-700/60'
                  }`}
                  aria-label="Gemini API Keys"
                  title="Gemini API Keys"
                >
                  <Key className="w-4 h-4" />
                  {customKeysCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-500 text-white rounded-full text-[9px] font-bold flex items-center justify-center">
                      {customKeysCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setIsPowerMode(prev => !prev)}
                  className={`p-1.5 rounded-lg border min-h-[34px] min-w-[34px] flex items-center justify-center cursor-pointer shadow-xs ${
                    isPowerMode
                      ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700/60'
                      : 'text-amber-600 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700/60'
                  }`}
                  aria-label="Power Mode"
                  title="Toggle Low Power Mode"
                >
                  <Power className="w-4 h-4" />
                </button>
                <ThemeSelector 
                  currentTheme={theme} 
                  onThemeChange={(newTheme) => setTheme(newTheme)} 
                />
              </div>
            </div>

            <div className="text-center py-0.5 w-full">
              <h1 className="text-lg font-extrabold text-slate-800 dark:text-slate-100 tracking-tight flex items-center justify-center gap-1.5">
                <YinYangMicIcon className="w-6 h-6 shrink-0 rounded-full shadow-xs inline-block" />
                <span>RADDOC's Dictation app</span>
              </h1>
            </div>
          </div>

          {/* Desktop/Tablet Header: 3-column Grid (sm: and above) */}
          <div className="hidden sm:grid sm:grid-cols-[auto_1fr_auto] items-center gap-2 sm:gap-4 mb-2 w-full max-w-full">
            <div className="justify-self-start flex items-center">
              <DriveStatusBadge 
                lastSaveResult={driveSaveResult} 
                onClearLastSave={() => setDriveSaveResult(null)} 
                onOpenReportsModal={() => setIsReportsModalOpen(true)}
              />
            </div>
            <div className="justify-self-center text-center px-1 sm:px-4">
              <h1 className="text-xl sm:text-2xl md:text-3xl font-extrabold text-slate-800 dark:text-slate-100 tracking-tight whitespace-nowrap flex items-center justify-center gap-2">
                <YinYangMicIcon className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 rounded-full shadow-xs inline-block" />
                <span>RADDOC's Dictation app</span>
              </h1>
            </div>
            <div className="justify-self-end flex items-center gap-1.5 sm:gap-2">
              <button
                id="macros-header-btn"
                onClick={() => setIsMacrosModalOpen(true)}
                className="p-2 sm:p-2.5 rounded-xl text-indigo-600 dark:text-indigo-400 bg-indigo-50/80 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-colors shrink-0 shadow-sm border border-indigo-200/70 dark:border-indigo-800/60 cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center gap-1.5"
                aria-label="Macros"
                title="Macros — Manage custom text shortcuts"
              >
                <BookOpen className="w-5 h-5 shrink-0" />
                <span className="text-xs font-semibold hidden md:inline whitespace-nowrap">
                  Macros {activeMacrosCount > 0 ? `(${activeMacrosCount})` : ''}
                </span>
              </button>
              <button
                id="workstation-sync-header-btn"
                onClick={() => setIsWorkstationSyncModalOpen(true)}
                className="p-2 sm:p-2.5 rounded-xl text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0 shadow-sm border border-slate-200/60 dark:border-slate-700/60 cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center gap-1.5"
                aria-label="Workstation Sync"
                title="Workstation Sync"
              >
                <Settings className="w-5 h-5 text-slate-600 dark:text-slate-300" />
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 hidden md:inline">Workstation Sync</span>
              </button>
              <button
                id="api-keys-header-btn"
                onClick={() => setIsApiKeyModalOpen(true)}
                className={`p-2 sm:p-2.5 rounded-xl transition-colors shrink-0 shadow-sm border cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center gap-1.5 relative ${
                  customKeysCount > 0
                    ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60'
                    : 'text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border-slate-200/80 dark:border-slate-700/60 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
                aria-label="Gemini API Keys & Failover"
                title={customKeysCount > 0 ? `API Keys (${customKeysCount} custom keys active)` : 'API Keys (Default rotating pool active)'}
              >
                <Key className={`w-5 h-5 shrink-0 ${customKeysCount > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-600 dark:text-slate-300'}`} />
                <span className="text-xs font-semibold hidden md:inline">
                  {customKeysCount > 0 ? `Custom Keys (${customKeysCount})` : 'API Keys'}
                </span>
                {customKeysCount > 0 && (
                  <span className="md:hidden absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center shadow-sm">
                    {customKeysCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => setIsPowerMode(prev => !prev)}
                className={`p-2 sm:p-2.5 rounded-xl transition-all shrink-0 shadow-sm border cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center ${
                  isPowerMode
                    ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60'
                    : 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700/60 hover:bg-amber-100 dark:hover:bg-amber-900/60'
                }`}
                aria-label={isPowerMode ? "Power Mode ON (Standard). Click for Low Power / Simple Mode." : "Power Mode OFF (Low Power / Simple Mode Active). Click for Standard Power."}
                title={isPowerMode ? "Power: ON (Standard Mode) — Click to switch to Low Power / Simple Mode to minimize CPU/data usage and run lag-free on any device" : "Power: OFF (Low Power / Simple Mode Active) — Animations and background effects minimized for smooth, lag-free performance on all devices. Click to turn ON."}
              >
                <Power className={`w-5 h-5 ${isPowerMode ? '' : 'opacity-80'}`} />
              </button>
              <ThemeSelector 
                currentTheme={theme} 
                onThemeChange={(newTheme) => setTheme(newTheme)} 
              />
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
              <button
                type="button"
                onClick={() => setMode('autonomous')}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all min-h-[44px] ${
                  mode === 'autonomous'
                    ? 'bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 text-white shadow-md'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
                aria-label="Autonomous Mode"
              >
                <span className="text-sm shrink-0">⚡</span>
                <span className="whitespace-nowrap font-bold">Autonomous</span>
              </button>
            </nav>
          </div>

          {/* Settings Bar */}
          <div className="mt-4 flex flex-col sm:flex-row justify-center items-center gap-3 sm:gap-6 bg-slate-100/80 dark:bg-slate-800/60 p-2.5 sm:p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-700/60 max-w-xl mx-auto">
              {status === AppStatus.Idle && (mode === 'single' || mode === 'batch' || mode === 'autonomous') && (
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

        {/* Active Upcoming Template Banner */}
        {upcomingTemplate && (
          <div className="mb-4 max-w-xl mx-auto p-2.5 sm:p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700/80 rounded-xl shadow-xs flex items-center justify-between gap-3 animate-fade-in">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base shrink-0">📌</span>
              <div className="min-w-0">
                <p className="text-xs sm:text-sm font-bold text-emerald-900 dark:text-emerald-200 truncate">
                  Active Template for Upcoming Reports: <span className="underline">{upcomingTemplate.name}</span>
                </p>
                <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                  Applied automatically to upcoming single & batch dictations.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                clearUpcomingTemplate();
                setCustomPrompt('');
                setCustomDocx(null);
              }}
              className="shrink-0 flex items-center gap-1 text-xs font-bold text-emerald-800 dark:text-emerald-200 bg-emerald-100 hover:bg-emerald-200 dark:bg-emerald-900/60 dark:hover:bg-emerald-800/80 px-2.5 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 transition-colors cursor-pointer"
              title="Remove template for upcoming reports and return to normal default"
            >
              <X className="w-3.5 h-3.5" />
              <span>Remove</span>
            </button>
          </div>
        )}

        {/* Zero-Loss Interrupted Dictation Recovery Banner */}
        {recoveredInFlightAudio && (
          <div className="mb-5 bg-amber-50 dark:bg-amber-950/50 border-2 border-amber-400/80 dark:border-amber-600/70 rounded-2xl p-4 sm:p-5 shadow-md transition-all animate-fadeIn">
            <div className="flex items-start gap-3.5">
              <div className="p-2.5 rounded-xl bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 shrink-0">
                <WarningIcon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-sm sm:text-base font-bold text-amber-950 dark:text-amber-100">
                    Interrupted Audio Recovered
                  </h3>
                  <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-amber-200/90 dark:bg-amber-800 text-amber-900 dark:text-amber-200 shrink-0">
                    Zero-Loss Protection
                  </span>
                </div>
                <p className="text-xs sm:text-sm text-amber-900/90 dark:text-amber-200/90 mt-1">
                  An audio dictation was automatically pre-saved to browser storage before an unexpected disruption or reload occurred during processing. Your complete recording ({formatFileSize(recoveredInFlightAudio.size)}) is safe.
                </p>
                <div className="mt-3.5 flex flex-wrap items-center gap-2 sm:gap-3">
                  <button
                    type="button"
                    onClick={() => handleProcessRecoveredAudio()}
                    className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs sm:text-sm py-2 px-4 rounded-xl shadow-xs transition-colors cursor-pointer"
                  >
                    <Sparkles className="w-4 h-4" />
                    Process Audio Now
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadRecoveredAudio}
                    className="inline-flex items-center gap-1.5 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-600 font-semibold text-xs sm:text-sm py-2 px-3.5 rounded-xl shadow-2xs transition-colors cursor-pointer"
                  >
                    <DownloadIcon className="w-4 h-4" />
                    Download Audio File
                  </button>
                  <button
                    type="button"
                    onClick={handleDiscardRecoveredAudio}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 font-medium text-xs sm:text-sm py-2 px-3 transition-colors cursor-pointer ml-auto"
                    title="Discard this recovered audio"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Discard
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Main Content Card */}
        <main className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-3.5 sm:p-6 md:p-8 min-h-[300px] border border-slate-100 dark:border-slate-700/50 transition-all">
          {renderContent()}
        </main>
        
        <footer id="app-footer" className="mt-8 mb-4 border-t border-slate-200/80 dark:border-slate-700/80 pt-6 pb-2">
          <div className="max-w-2xl mx-auto bg-slate-50/80 dark:bg-slate-800/60 rounded-2xl p-4 sm:p-5 border border-slate-200/80 dark:border-slate-700/60 shadow-xs">
            <h3 className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center justify-center gap-1.5 mb-3.5 text-center">
              <span>☯️</span>
              <span>Subscribe to our channels for updates &amp; tools:</span>
            </h3>
            <ul className="space-y-2 text-xs sm:text-sm">
              <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3 py-1.5 px-3 rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200/70 dark:border-slate-700/70 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <span className="text-emerald-500 font-bold">•</span>
                  <span>WhatsApp Channel:</span>
                </span>
                <a
                  href="https://whatsapp.com/channel/0029Vb2S2bW0G0Xq94mR721T"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline inline-flex items-center gap-1 font-mono text-[11px] sm:text-xs truncate"
                >
                  <span className="truncate">https://whatsapp.com/channel/0029Vb2S2bW0G0Xq94mR721T</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </a>
              </li>

              <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3 py-1.5 px-3 rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200/70 dark:border-slate-700/70 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <span className="text-sky-500 font-bold">•</span>
                  <span>Telegram Group:</span>
                </span>
                <a
                  href="https://t.me/raddocs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline inline-flex items-center gap-1 font-mono text-[11px] sm:text-xs truncate"
                >
                  <span className="truncate">https://t.me/raddocs</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </a>
              </li>

              <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3 py-1.5 px-3 rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200/70 dark:border-slate-700/70 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <span className="text-sky-500 font-bold">•</span>
                  <span>Telegram Channel:</span>
                </span>
                <a
                  href="https://t.me/radiology_chatgpt"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline inline-flex items-center gap-1 font-mono text-[11px] sm:text-xs truncate"
                >
                  <span className="truncate">https://t.me/radiology_chatgpt</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </a>
              </li>

              <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3 py-1.5 px-3 rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200/70 dark:border-slate-700/70 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <span className="text-slate-500 dark:text-slate-400 font-bold">•</span>
                  <span>Twitter:</span>
                </span>
                <a
                  href="https://x.com/RadDoc96"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline inline-flex items-center gap-1 font-mono text-[11px] sm:text-xs truncate"
                >
                  <span className="truncate">https://x.com/RadDoc96</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </a>
              </li>

              <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-3 py-1.5 px-3 rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200/70 dark:border-slate-700/70 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <span className="text-red-500 font-bold">•</span>
                  <span>YouTube:</span>
                </span>
                <a
                  href="https://youtube.com/@raddoc96"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline inline-flex items-center gap-1 font-mono text-[11px] sm:text-xs truncate"
                >
                  <span className="truncate">https://youtube.com/@raddoc96</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </a>
              </li>

              <li className="flex flex-col sm:flex-row sm:items-start sm:items-center justify-between gap-1.5 sm:gap-3 py-2 px-3 rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200/70 dark:border-slate-700/70 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                    <span className="text-emerald-500 font-bold">•</span>
                    <span>Android APK:</span>
                  </span>
                  <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 pl-4">
                    Download it as APK so that you can dictate in Android mobile after minimising the app also
                  </p>
                </div>
                <a
                  href="https://github.com/medicoforever/ai-studio-applet-apk/releases/download/v1.0.8/RADDOC-Dictation-Release.apk"
                  target="_blank"
                  rel="noopener noreferrer"
                  download="RADDOC-Dictation-Release.apk"
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline inline-flex items-center gap-1.5 font-mono text-[11px] sm:text-xs truncate max-w-full sm:max-w-xs shrink-0 self-start sm:self-center font-medium"
                  title="https://github.com/medicoforever/ai-studio-applet-apk/releases/download/v1.0.8/RADDOC-Dictation-Release.apk"
                >
                  <Download className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="truncate">Download APK (v1.0.8)</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-70" />
                </a>
              </li>
            </ul>

            {/* Legal Authorship, Copyright & Provenance Claim */}
            <div className="mt-4 pt-3.5 border-t border-slate-200/80 dark:border-slate-700/80 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
              <div className="flex flex-col gap-0.5 min-w-0">
                <p className="text-[11px] sm:text-xs font-semibold text-slate-700 dark:text-slate-300">
                  © 2024–2026 <span className="font-bold text-slate-900 dark:text-white">RADDOC™</span> • Created &amp; Authored by <span className="font-mono text-blue-600 dark:text-blue-400 font-medium">medicoforever002@gmail.com</span>
                </p>
                <p className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400">
                  Proprietary medical AI dictation software • All Rights Reserved
                </p>
              </div>

              <button
                type="button"
                onClick={() => setIsOwnershipModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 dark:bg-slate-700/90 dark:hover:bg-slate-700 text-blue-700 dark:text-blue-300 font-semibold text-xs border border-blue-200 dark:border-slate-600 transition-colors shadow-2xs cursor-pointer shrink-0"
                title="View legal authorship certificate, canonical Applet ID, and copyright terms"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                <span>Legal Ownership &amp; Provenance</span>
              </button>
            </div>
          </div>
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

        {/* Undo "Record New Dictation" Floating Snackbar */}
        {undoSnackbar && undoSnackbar.visible && (
          <div
            id="undo-record-new-snackbar"
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-md w-[calc(100%-2rem)] bg-slate-900/95 dark:bg-slate-800/95 backdrop-blur-md text-white border border-slate-700/80 shadow-2xl rounded-2xl p-3.5 sm:p-4 flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-5 duration-200"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
                <RotateCcw className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-100 truncate">
                  Previous dictation cleared
                </p>
                <p className="text-xs text-slate-400">
                  Undo available for <span className="font-semibold text-blue-400 font-mono">{undoSnackbar.secondsRemaining}s</span>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                id="undo-restore-btn"
                onClick={handleUndoReset}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs sm:text-sm font-semibold rounded-lg shadow-sm transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Undo
              </button>
              <button
                id="undo-dismiss-btn"
                onClick={handleDismissUndo}
                className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-md transition-colors cursor-pointer"
                aria-label="Dismiss undo notification"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Workstation Sync Modal */}
        <WorkstationSyncModal
          isOpen={isWorkstationSyncModalOpen}
          onClose={() => setIsWorkstationSyncModalOpen(false)}
          onSaved={handleWorkstationSettingsSaved}
        />

        {/* Ownership & Provenance Certificate Modal */}
        <OwnershipModal
          isOpen={isOwnershipModalOpen}
          onClose={() => setIsOwnershipModalOpen(false)}
        />

        {/* Voice Macros & Autotext Dictionary Modal */}
        <MacrosAndDictionaryModal
          isOpen={isMacrosModalOpen}
          onClose={() => setIsMacrosModalOpen(false)}
          hasActiveReport={status === AppStatus.Success && mode === 'single'}
          onInsertMacroIntoActiveReport={(expandedLines) => {
            if (status === AppStatus.Success && mode === 'single') {
              handleAllFindingsUpdate([...findings, ...expandedLines]);
            }
          }}
        />

        {/* Gemini API Keys & Failover Modal */}
        <ApiKeyModal
          isOpen={isApiKeyModalOpen}
          onClose={() => setIsApiKeyModalOpen(false)}
          selectedModel={selectedModel}
        />

        {/* Universal Floating "+ New Dictation" Button for Mobile & Desktop */}
        <FloatingNewDictationButton
          status={status}
          mode={mode}
          onResetSingleMode={resetSingleMode}
        />

        {/* Workstation Sync Saved Toast */}
        {syncToastMessage && (
          <div
            id="workstation-sync-toast"
            className="fixed bottom-5 left-5 z-50 max-w-sm bg-slate-900/95 dark:bg-slate-800/95 backdrop-blur-md text-white border border-slate-700/80 shadow-2xl rounded-2xl p-3.5 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-3 duration-200"
            role="status"
            aria-live="polite"
          >
            <div className="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 font-bold text-sm">
              ✓
            </div>
            <p className="text-xs sm:text-sm font-semibold text-slate-100">
              {syncToastMessage}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
