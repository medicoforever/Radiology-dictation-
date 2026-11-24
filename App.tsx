


import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import AudioRecorder from './components/AudioRecorder';
import ResultsDisplay from './components/ResultsDisplay';
import { AppStatus, IdentifiedError } from './types';
import { processAudio, createChat, blobToBase64, base64ToBlob, createChatFromText, findBuiltinTemplates, runClinicalQaErrorCheck, ClinicalQaAssessment } from './services/geminiService';
import ClinicalQaPanel from './components/ui/ClinicalQaPanel';
import Spinner from './components/ui/Spinner';
import { Chat } from '@google/genai';
import { saveAudioBlob, getAudioBlob, deleteAudioBlob, saveReportSession, getReportSession, deleteReportSession } from './services/audioStorage';
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
import { mergeAudioBlobs, triggerAudioDownload } from './services/audioMerger';
import { autoSaveSingleDictation, autoSaveLiveDictation, autoSaveBatchDictations, SaveResult, syncPendingLocalDictationsToDrive, isDriveConnected, subscribeToAuth } from './services/googleDriveService';
import { DriveStatusBadge } from './components/DriveStatusBadge';
import { DriveAutoSaveToast } from './components/DriveAutoSaveToast';
import { DriveReportsModal } from './components/DriveReportsModal';
import { RotateCcw, X, ExternalLink, Power, Sparkles, Trash2, Download, ShieldCheck, BookOpen, Key } from 'lucide-react';
import { OwnershipModal } from './components/ui/OwnershipModal';
import { ApiKeyModal } from './components/ApiKeyModal';
import { getUserApiKeys, API_KEYS_UPDATED_EVENT, isBuiltinKeysUnlocked, unlockBuiltinKeys, syncApiKeysWithGoogleDrive } from './services/apiKeyService';
import ThemeSelector from './components/ThemeSelector';
import { getUpcomingTemplate, clearUpcomingTemplate, subscribeToUpcomingTemplate, UpcomingTemplateConfig } from './services/upcomingTemplateService';
import MacrosAndDictionaryModal from './components/MacrosAndDictionaryModal';
import { subscribeToMacroDictionary, syncMacrosWithGoogleDrive, expandMacrosInFindings } from './services/macroDictionaryService';
import { FloatingNewDictationButton } from './components/FloatingNewDictationButton';
import ErrorBoundary from './components/ErrorBoundary';
import { safeLocalStorage, getTabId, markTabActive, isTabHeartbeatAlive, getSingleModeStorageKey, getSingleModeAudioKey, getBatchModeStorageKey } from './services/storageService';

interface ChatMessage {
  author: 'You' | 'AI';
  text: string;
}

interface QueuedConcurrentItem {
  audioBlobs: Blob[];
  customPrompt: string;
  customImages: Array<{ data: string; mimeType: string }>;
  customDocx: DocxTemplateData | null;
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

const SINGLE_MODE_STORAGE_KEY = 'radiologyDictationSingleMode';
const BATCH_MODE_STORAGE_KEY = 'radiologyDictationBatchMode';
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
  const [singleExtraFiles, setSingleExtraFiles] = useState<File[]>([]);
  const [upcomingTemplate, setUpcomingTemplateState] = useState<UpcomingTemplateConfig | null>(() => getUpcomingTemplate());

  const activeTemplateDisplayName = useMemo(() => {
    if (customDocx && customDocx.name) {
      return customDocx.name;
    }
    const matched = findBuiltinTemplates(customPrompt);
    if (matched && matched.length > 0) {
      return matched.map(t => t.name).join(' + ');
    }
    if (upcomingTemplate && upcomingTemplate.name) {
      return upcomingTemplate.name;
    }
    return null;
  }, [customPrompt, customDocx, upcomingTemplate]);

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
        setConcurrentCustomPrompt(config.promptText);
        setConcurrentCustomDocx(config.docxData || null);
      } else {
        setCustomPrompt('');
        setCustomDocx(null);
        setConcurrentCustomPrompt('');
        setConcurrentCustomDocx(null);
      }
    });
    return unsubscribe;
  }, []);
  const [identifiedErrors, setIdentifiedErrors] = useState<IdentifiedError[]>([]);
  const [qaAssessment, setQaAssessment] = useState<ClinicalQaAssessment | null>(null);
  const [errorCheckStatus, setErrorCheckStatus] = useState<'idle' | 'checking' | 'complete'>('idle');
  const [theme, setTheme] = useState(() => {
    const storedTheme = safeLocalStorage.getRaw('theme', '');
    if (storedTheme) {
      return storedTheme;
    }
    return (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  });
  const [isErrorCheckEnabled, setIsErrorCheckEnabled] = useState(() => {
    return safeLocalStorage.getItem<boolean>(ERROR_CHECK_ENABLED_KEY, false);
  });
  const [isPowerMode, setIsPowerMode] = useState<boolean>(() => {
    const saved = safeLocalStorage.getRaw(POWER_MODE_KEY, '');
    return saved !== '' ? saved === 'true' : true;
  });
  const [multipleFilesModal, setMultipleFilesModal] = useState<File[] | null>(null);
  const [pendingBatchFiles, setPendingBatchFiles] = useState<File[] | null>(null);
  const [isReportsModalOpen, setIsReportsModalOpen] = useState<boolean>(false);
  const [isOwnershipModalOpen, setIsOwnershipModalOpen] = useState<boolean>(false);
  const [isMacrosModalOpen, setIsMacrosModalOpen] = useState<boolean>(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState<boolean>(false);
  const [activeMacrosCount, setActiveMacrosCount] = useState<number>(0);
  const [customKeysCount, setCustomKeysCount] = useState<number>(() => getUserApiKeys().length);
  const [isSecretUnlocked, setIsSecretUnlocked] = useState<boolean>(() => isBuiltinKeysUnlocked());
  const [hasMultipleSingleDictations, setHasMultipleSingleDictations] = useState<boolean>(false);
  const [errorRecorderStatus, setErrorRecorderStatus] = useState<AppStatus>(AppStatus.Idle);

  const handleHeaderTitleClick = useCallback(() => {
    const input = window.prompt("Enter secret key:");
    if (input !== null && input.trim()) {
      const res = unlockBuiltinKeys(input.trim());
      if (res.success) {
        setIsSecretUnlocked(true);
        alert("Success: 9 Built-in API keys unlocked and activated!");
      } else {
        alert(res.message);
      }
    }
  }, []);

  useEffect(() => {
    const handleKeyUpdate = () => {
      setCustomKeysCount(getUserApiKeys().length);
      setIsSecretUnlocked(isBuiltinKeysUnlocked());
    };
    window.addEventListener(API_KEYS_UPDATED_EVENT, handleKeyUpdate);
    return () => window.removeEventListener(API_KEYS_UPDATED_EVENT, handleKeyUpdate);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToMacroDictionary(store => {
      setActiveMacrosCount((store.macros || []).length);
    });
    return unsubscribe;
  }, []);

  const [driveSaveResult, setDriveSaveResult] = useState<SaveResult | null>(null);
  const processingRequestIdRef = useRef<number>(0);
  const inFlightAbortControllerRef = useRef<AbortController | null>(null);
  const handleRecordingCompleteRef = useRef<(audioInput: Blob | Blob[], overridePrompt?: string, overrideDocx?: any, overrideImages?: Array<{ data: string; mimeType: string }>) => Promise<void>>(() => Promise.resolve());
  const customPromptRef = useRef<string>(customPrompt);
  customPromptRef.current = customPrompt;
  const customDocxRef = useRef<DocxTemplateData | null>(customDocx);
  customDocxRef.current = customDocx;
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
    qaAssessment?: ClinicalQaAssessment | null;
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

  // Simultaneous / Concurrent Dictation while loading (each queued dictation gets its own fresh Custom Instructions & Template config)
  const [concurrentRecordingStatus, setConcurrentRecordingStatus] = useState<AppStatus>(AppStatus.Idle);
  const queuedConcurrentAudiosRef = useRef<QueuedConcurrentItem[]>([]);
  const [queuedAudiosCount, setQueuedAudiosCount] = useState<number>(0);
  const isConcurrentRecordingActiveRef = useRef<boolean>(false);
  const isConcurrentIntentActiveRef = useRef<boolean>(false);
  const [isSimultaneousQueued, setIsSimultaneousQueued] = useState<boolean>(false);
  const [isSeparatingConcurrent, setIsSeparatingConcurrent] = useState<boolean>(false);
  const isSeparatingConcurrentRef = useRef<boolean>(false);
  const [isContinuousSessionReady, setIsContinuousSessionReady] = useState<boolean>(false);
  const [activeConcurrentBatchesCount, setActiveConcurrentBatchesCount] = useState<number>(0);
  const hasConcurrentUnsavedAudioRef = useRef<boolean>(false);
  const activeConcurrentBatchesRef = useRef<any[]>([]);
  const activeConcurrentBatchTsRef = useRef<number | null>(null);
  const currentFirstBatchAddedRef = useRef<boolean>(false);
  const visitedBatchSinceLastConcurrentRef = useRef<boolean>(false);
  const concurrentAbortControllerRef = useRef<AbortController | null>(null);
  const firstDictationSuccessMetaRef = useRef<{
    blobs: Blob[];
    prompt: string;
    images: Array<{ data: string; mimeType: string }>;
    reqId: number;
  } | null>(null);
  const flushQueuedConcurrentIfReadyRef = useRef<() => void>(() => {});
  const firstDictationFindingsRef = useRef<string[] | null>(null);
  const firstDictationAudioRef = useRef<Blob | null>(null);
  const firstDictationErrorRef = useRef<string | null>(null);
  const [firstDictationError, setFirstDictationError] = useState<string | null>(null);
  const isFirstDictationProcessingRef = useRef<boolean>(false);
  const [batchModeInstanceKey, setBatchModeInstanceKey] = useState<number>(Date.now());
  const handleContinueDictationRef = useRef<((newAudioBlob: Blob, premergedBlob?: Blob) => Promise<void>) | null>(null);

  useEffect(() => {
    if (mode === 'batch') {
      visitedBatchSinceLastConcurrentRef.current = true;
    }
  }, [mode]);

  const [concurrentCustomPrompt, setConcurrentCustomPrompt] = useState<string>(() => getUpcomingTemplate()?.promptText || '');
  const concurrentCustomPromptRef = useRef<string>(concurrentCustomPrompt);
  concurrentCustomPromptRef.current = concurrentCustomPrompt;

  const [concurrentCustomImages, setConcurrentCustomImages] = useState<Array<{ data: string; mimeType: string }>>([]);
  const concurrentCustomImagesRef = useRef<Array<{ data: string; mimeType: string }>>(concurrentCustomImages);
  concurrentCustomImagesRef.current = concurrentCustomImages;

  const [concurrentCustomDocx, setConcurrentCustomDocx] = useState<DocxTemplateData | null>(() => getUpcomingTemplate()?.docxData || null);
  const concurrentCustomDocxRef = useRef<DocxTemplateData | null>(concurrentCustomDocx);
  concurrentCustomDocxRef.current = concurrentCustomDocx;

  const resetConcurrentCustomConfig = useCallback(() => {
    const up = getUpcomingTemplate();
    setConcurrentCustomPrompt(up ? up.promptText : '');
    setConcurrentCustomDocx(up ? (up.docxData || null) : null);
    setConcurrentCustomImages([]);
  }, []);

  const concurrentActiveTemplateDisplayName = useMemo(() => {
    if (concurrentCustomDocx && concurrentCustomDocx.name) return concurrentCustomDocx.name;
    const matched = findBuiltinTemplates(concurrentCustomPrompt);
    if (matched && matched.length > 0) return matched.map(t => t.name).join(' + ');
    return null;
  }, [concurrentCustomPrompt, concurrentCustomDocx]);

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
    safeLocalStorage.setRaw('theme', theme);

    // Dynamically update mobile browser theme-color meta tag for Android status and navigation bar
    try {
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', isDarkVariant ? '#0f172a' : '#f8fafc');
      }
    } catch (_) {}
  }, [theme]);
  
  useEffect(() => {
    safeLocalStorage.setRaw(POWER_MODE_KEY, String(isPowerMode));
    if (!isPowerMode) {
      document.documentElement.classList.add('low-power-mode');
    } else {
      document.documentElement.classList.remove('low-power-mode');
    }
  }, [isPowerMode]);

  useEffect(() => {
    safeLocalStorage.setItem(ERROR_CHECK_ENABLED_KEY, isErrorCheckEnabled);
  }, [isErrorCheckEnabled]);

  const toggleTheme = () => {
    setTheme(prevTheme => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  const [isRestored, setIsRestored] = useState(false);

  // Load state from localStorage on initial render
  useEffect(() => {
    const loadState = async () => {
      try {
        const currentTabId = getTabId();
        const singleKey = getSingleModeStorageKey(currentTabId);
        const audioKey = getSingleModeAudioKey(currentTabId);
        let savedState = await getReportSession<any>(singleKey);
        if (!savedState) {
          savedState = safeLocalStorage.getItem<any>(singleKey, null);
        }
        // Fallback to legacy global key once, and adopt to tab-scoped key
        if (!savedState) {
          savedState = await getReportSession<any>(SINGLE_MODE_STORAGE_KEY);
          if (!savedState) {
            savedState = safeLocalStorage.getItem<any>(SINGLE_MODE_STORAGE_KEY, null);
          }
          if (savedState) {
            await saveReportSession(singleKey, savedState);
            await deleteReportSession(SINGLE_MODE_STORAGE_KEY).catch(() => {});
            safeLocalStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
          }
        }
        if (savedState) {
          let blob: Blob | null = null;

          // Try loading audio blob from IndexedDB by tab key, fallback to legacy
          blob = (await getAudioBlob(audioKey)) || (await getAudioBlob('single_mode_audio'));
          if (blob && !(await getAudioBlob(audioKey))) {
            await saveAudioBlob(audioKey, blob);
            await deleteAudioBlob('single_mode_audio').catch(() => {});
          }

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
          
          const validModel = (savedState.selectedModel && savedState.selectedModel !== 'gemini-3.5-flash' && AVAILABLE_MODELS.some(m => m.value === savedState.selectedModel))
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
          const currentTabId = getTabId();
          let meta: { tabId?: string; timestamp: number; type: string; size: number } | null = null;
          try {
            const rawMeta = safeLocalStorage.getRaw(`in_flight_recording_meta_${currentTabId}`, safeLocalStorage.getRaw('in_flight_recording_meta', ''));
            if (rawMeta) meta = JSON.parse(rawMeta);
          } catch (_) {}

          // Multi-tab protection: if this audio belongs to another active tab, never hijack or recover it in this tab
          const isFromOtherTab = !!(meta?.tabId && meta.tabId !== currentTabId);
          const isOtherActive = isFromOtherTab && isTabHeartbeatAlive(meta.tabId);

          if (!isOtherActive && !isFromOtherTab) {
            const inFlightBlob = (await getAudioBlob(`in_flight_recording_${currentTabId}`)) || (await getAudioBlob('in_flight_recording'));
            if (inFlightBlob && inFlightBlob.size > 0 && (!meta?.tabId || meta.tabId === currentTabId)) {
              setRecoveredInFlightAudio({
                blob: inFlightBlob,
                timestamp: meta?.timestamp || Date.now(),
                size: inFlightBlob.size,
              });
            }
          }
        } catch (inFlightErr) {
          console.warn("Notice: could not check in-flight recording recovery:", inFlightErr);
        }
      } catch (err) {
        console.error("Failed to load state from localStorage:", err);
        safeLocalStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
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
      const currentTabId = getTabId();
      const singleKey = getSingleModeStorageKey(currentTabId);
      const audioKey = getSingleModeAudioKey(currentTabId);

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
          // Save full report state directly to IndexedDB isolated per tab (bypassing the 5MB localStorage limit completely!)
          await saveReportSession(singleKey, stateToSave);
          // Purge from localStorage and legacy global keys so storage remains free
          safeLocalStorage.removeItem(singleKey);
          safeLocalStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
          await deleteReportSession(SINGLE_MODE_STORAGE_KEY).catch(() => {});

          if (audioBlob) {
            await saveAudioBlob(audioKey, audioBlob);
          } else {
            await deleteAudioBlob(audioKey);
          }
          await deleteAudioBlob('single_mode_audio').catch(() => {});
        } catch (err) {
          console.error("Failed to save state:", err);
        }
      } else if (status === AppStatus.Idle && findings.length === 0) {
        safeLocalStorage.removeItem(singleKey);
        safeLocalStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
        deleteAudioBlob(audioKey).catch(() => {});
        deleteAudioBlob('single_mode_audio').catch(() => {});
        deleteReportSession(singleKey).catch(() => {});
        deleteReportSession(SINGLE_MODE_STORAGE_KEY).catch(() => {});
      }
    };
    saveState();
  }, [status, findings, audioBlob, chatHistory, selectedModel, customPrompt, customImages, isRestored]);

  // Listen for Google Drive auth reconnection to sync offline/pending dictations, custom API keys & macros dictionary
  useEffect(() => {
    let wasConnected = isDriveConnected();
    if (wasConnected) {
      syncMacrosWithGoogleDrive().catch(() => {});
      syncApiKeysWithGoogleDrive()
        .then(() => {
          setCustomKeysCount(getUserApiKeys().length);
          setIsSecretUnlocked(isBuiltinKeysUnlocked());
        })
        .catch(err => console.warn('Drive API key sync notice:', err));
    }
    const unsubscribe = subscribeToAuth(async (user, token) => {
      const isNowConnected = Boolean(user && token && isDriveConnected());
      if (isNowConnected && !wasConnected) {
        wasConnected = true;
        syncMacrosWithGoogleDrive().catch(() => {});
        syncApiKeysWithGoogleDrive()
          .then(() => {
            setCustomKeysCount(getUserApiKeys().length);
            setIsSecretUnlocked(isBuiltinKeysUnlocked());
          })
          .catch(err => console.warn('Drive API key sync notice:', err));
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


  // useEffect to run Gemini Decision 1 clinical QA & conditional error check in background
  useEffect(() => {
    const abortController = new AbortController();

    const checkForErrors = async () => {
        // Only run when enabled, processing is successful and we have findings
        if (isErrorCheckEnabled && status === AppStatus.Success && findings.length > 0) {
            setErrorCheckStatus('checking');
            setIdentifiedErrors([]);
            setQaAssessment(null);
            try {
                const { errors, qaAssessment: assessment } = await runClinicalQaErrorCheck(
                  findings,
                  selectedModel,
                  abortController.signal
                );
                if (!abortController.signal.aborted) {
                  setIdentifiedErrors(errors);
                  setQaAssessment(assessment);
                }
            } catch (err: any) {
                if (err?.name === 'AbortError' || abortController.signal.aborted) {
                  return;
                }
                console.error("Failed to check for errors:", err);
                // Don't show this error to the user, it's a background task.
            } finally {
                if (!abortController.signal.aborted) {
                  setErrorCheckStatus('complete');
                }
            }
        } else {
            // Clear errors if disabled, status is not 'Success', or there are no findings
            setIdentifiedErrors([]);
            setQaAssessment(null);
            setErrorCheckStatus('idle');
        }
    };

    checkForErrors();
    return () => {
      abortController.abort();
    };
  }, [findings, status, selectedModel, isErrorCheckEnabled]);


  const handleCancelProcessing = useCallback(() => {
    if (inFlightAbortControllerRef.current) {
      try {
        inFlightAbortControllerRef.current.abort();
      } catch (_) {}
      inFlightAbortControllerRef.current = null;
    }
    if (concurrentAbortControllerRef.current) {
      try {
        concurrentAbortControllerRef.current.abort();
      } catch (_) {}
      concurrentAbortControllerRef.current = null;
    }
    processingRequestIdRef.current++;

    const hasQueuedOrActive =
      queuedConcurrentAudiosRef.current.length > 0 ||
      activeConcurrentBatchesRef.current.length > 0 ||
      isConcurrentRecordingActiveRef.current ||
      isConcurrentIntentActiveRef.current ||
      hasConcurrentUnsavedAudioRef.current;

    if (hasQueuedOrActive) {
      if (isFirstDictationProcessingRef.current) {
        // Never lose already-dictated #1 or queued #2/#3 dictations when cancelling #1 analysis
        const cancelMsg = 'Dictation #1 analysis was cancelled. Recorded audio has been preserved in Batch Mode.';
        firstDictationErrorRef.current = cancelMsg;
        setFirstDictationError(cancelMsg);
        firstDictationFindingsRef.current = [
          "BOLD::Dictation #1 analysis cancelled by user.",
          `[${cancelMsg}]`
        ];
        isFirstDictationProcessingRef.current = false;
      }
      // Do not forcibly clear isSeparatingConcurrentRef while its async loop is unwinding from AbortError
      if (!isSeparatingConcurrentRef.current) {
        setTimeout(() => flushQueuedConcurrentIfReadyRef.current(), 0);
      }
      return;
    }

    queuedConcurrentAudiosRef.current = [];
    setQueuedAudiosCount(0);
    firstDictationFindingsRef.current = null;
    firstDictationAudioRef.current = null;
    firstDictationErrorRef.current = null;
    firstDictationSuccessMetaRef.current = null;
    setFirstDictationError(null);
    isFirstDictationProcessingRef.current = false;
    isSeparatingConcurrentRef.current = false;
    setIsSeparatingConcurrent(false);
    setIsSimultaneousQueued(false);
    setIsContinuousSessionReady(false);
    setActiveConcurrentBatchesCount(0);
    currentFirstBatchAddedRef.current = false;
    isConcurrentRecordingActiveRef.current = false;
    setConcurrentRecordingStatus(AppStatus.Idle);
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
    handleRecordingCompleteRef.current(audio);
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
      const currentTabId = getTabId();
      localStorage.removeItem(`in_flight_recording_meta_${currentTabId}`);
      localStorage.removeItem('in_flight_recording_meta');
      await deleteAudioBlob(`in_flight_recording_${currentTabId}`);
      await deleteAudioBlob('in_flight_recording');
    } catch (e) {
      console.warn("Could not discard in-flight recording:", e);
    }
  }, []);

  const serializeBatchesForStorage = (batches: any[]) =>
    batches.map(({ audioBlobs, chat, ...rest }) => ({
      ...rest,
      audioCount: Array.isArray(audioBlobs) ? audioBlobs.length : (rest.audioCount || 0),
    }));

  const finalizeFirstDictationSuccess = useCallback(async (
    processedText: string[],
    blobsForChat: Blob[],
    promptToUse: string,
    imagesToUse: Array<{ data: string; mimeType: string }>,
    reqId: number
  ) => {
    try {
      const chatSession = await createChat(blobsForChat, processedText, promptToUse, imagesToUse, selectedModel);
      if (processingRequestIdRef.current === reqId) {
        setChat(chatSession);
      }
    } catch (chatErr) {
      console.warn("Follow-up AI chat initialization notice:", chatErr);
    }

    const aiGreeting = "I have reviewed the audio and the transcript. How can I help you further?";
    setChatHistory([{ author: 'AI', text: `${processedText.join('\n\n')}\n\n${aiGreeting}` }]);

    const timestamp = Date.now();
    activeDictationTimestampRef.current = timestamp;
    activeDictationIsLiveRef.current = false;
    driveSyncedHashRef.current = processedText.join('|||');

    setIsContinuousSessionReady(false);
    setStatus(AppStatus.Success);
    window.scrollTo({ top: 0, behavior: 'instant' });

    const currentTabId = getTabId();
    deleteAudioBlob(`in_flight_recording_${currentTabId}`).catch(() => {});
    deleteAudioBlob('in_flight_recording').catch(() => {});
    try {
      localStorage.removeItem(`in_flight_recording_meta_${currentTabId}`);
      localStorage.removeItem('in_flight_recording_meta');
    } catch (_) {}

    autoSaveSingleDictation(processedText, undefined, timestamp).then(result => {
      if (result.success) {
        setDriveSaveResult(result);
      }
    }).catch(err => console.warn('Drive auto-save background notice:', err));
  }, [selectedModel]);

  const separateConcurrentDictationsToBatch = useCallback(async (
    firstFindings: string[],
    firstAudio: Blob | null,
    subsequentItems: QueuedConcurrentItem[],
    firstErrorMsg?: string | null
  ) => {
    // Serialize execution: if a separation loop is already running, enqueue items so nothing is overwritten!
    if (isSeparatingConcurrentRef.current) {
      if (subsequentItems.length > 0) {
        queuedConcurrentAudiosRef.current.push(...subsequentItems);
        setQueuedAudiosCount(queuedConcurrentAudiosRef.current.length);
      }
      return;
    }

    isSeparatingConcurrentRef.current = true;
    setIsSeparatingConcurrent(true);
    setIsContinuousSessionReady(false);
    setStatus(AppStatus.Processing);
    setIsSimultaneousQueued(false);
    isConcurrentRecordingActiveRef.current = false;
    setConcurrentRecordingStatus(AppStatus.Idle);

    const curTabId = getTabId();
    const curBatchKey = getBatchModeStorageKey(curTabId);
    const now = activeConcurrentBatchTsRef.current || Date.now();
    activeConcurrentBatchTsRef.current = now;

    const getTitle = (findingsList: string[], defaultName: string) => {
      if (!findingsList || findingsList.length === 0) return defaultName;
      const first = findingsList[0].replace(/^BOLD::/i, '').replace(/[*_#~`]+/g, '').trim();
      if (first.length > 0 && first.length < 80 && !first.toLowerCase().startsWith('clinical') && !first.toLowerCase().startsWith('error')) {
        return first;
      }
      return defaultName;
    };

    try {
      // 1. Reuse accumulated session batches if continuing while recording #3+, syncing if user edited/cleared Batch Mode
      if (activeConcurrentBatchesRef.current.length > 0 && visitedBatchSinceLastConcurrentRef.current) {
        visitedBatchSinceLastConcurrentRef.current = false;
        const stored = await getReportSession<any[]>(curBatchKey);
        if (!stored || stored.length === 0) {
          activeConcurrentBatchesRef.current = [];
        } else {
          const storedById = new Map(stored.map(s => [s.id, s]));
          activeConcurrentBatchesRef.current = activeConcurrentBatchesRef.current
            .filter(b => storedById.has(b.id))
            .map(b => {
              const s = storedById.get(b.id);
              return s ? { ...b, name: s.name || b.name, findings: s.findings || b.findings, status: s.status || b.status } : b;
            });
        }
      }
      visitedBatchSinceLastConcurrentRef.current = false;

      let updatedBatches: Array<any> = activeConcurrentBatchesRef.current.length > 0
        ? [...activeConcurrentBatchesRef.current]
        : [];

      if (!currentFirstBatchAddedRef.current && firstAudio) {
        const firstReportNum = updatedBatches.length + 1;
        const batch1Id = `batch-sep-${firstReportNum}-${now}`;
        const name1 = firstErrorMsg ? `Report ${firstReportNum} (Interrupted)` : getTitle(firstFindings, `Report ${firstReportNum}`);
        await saveAudioBlob(`batch_audio_${curTabId}_${batch1Id}_0`, firstAudio);
        await saveAudioBlob(`batch_audio_${batch1Id}_0`, firstAudio);

        const batch1 = {
          id: batch1Id,
          name: name1,
          audioCount: 1,
          audioBlobs: [firstAudio],
          findings: firstErrorMsg ? [
            "BOLD::Previous dictation encountered an error during analysis.",
            `[Error: ${firstErrorMsg}]. Your recorded audio is preserved below. You can retry processing or view findings.`
          ] : firstFindings,
          status: firstErrorMsg ? ('error' as const) : ('complete' as const),
          error: firstErrorMsg || undefined,
          selectedModel,
          customPrompt,
          customImages,
          customDocx: customDocx || null,
        };
        updatedBatches.push(batch1);
        currentFirstBatchAddedRef.current = true;
      }

      const pendingWork: Array<{ batchId: string; reportNumber: number; item: QueuedConcurrentItem }> = [];

      const persistBatchesSnapshot = async (batchesToPersist: any[]) => {
        activeConcurrentBatchesRef.current = [...batchesToPersist];
        setActiveConcurrentBatchesCount(batchesToPersist.length);
        const serializable = serializeBatchesForStorage(batchesToPersist);
        await saveReportSession(curBatchKey, serializable);
        safeLocalStorage.setItem(curBatchKey, serializable);
        await saveReportSession(BATCH_MODE_STORAGE_KEY, serializable).catch(() => {});
        safeLocalStorage.setItem(BATCH_MODE_STORAGE_KEY, serializable);
        window.dispatchEvent(new CustomEvent('raddoc_batch_mode_updated'));
      };

      const enqueueItemsToBatches = async (itemsToAdd: QueuedConcurrentItem[]) => {
        if (!itemsToAdd || itemsToAdd.length === 0) return;
        for (const item of itemsToAdd) {
          const reportNum = updatedBatches.length + 1;
          const batchId = `batch-sep-${reportNum}-${now + reportNum}-${Math.random().toString(36).slice(2, 6)}`;
          for (let bIdx = 0; bIdx < item.audioBlobs.length; bIdx++) {
            await saveAudioBlob(`batch_audio_${curTabId}_${batchId}_${bIdx}`, item.audioBlobs[bIdx]);
            await saveAudioBlob(`batch_audio_${batchId}_${bIdx}`, item.audioBlobs[bIdx]);
          }

          updatedBatches.push({
            id: batchId,
            name: `Report ${reportNum}`,
            audioCount: item.audioBlobs.length,
            audioBlobs: item.audioBlobs,
            findings: ['Processing audio with AI...'],
            status: 'processing' as const,
            selectedModel,
            customPrompt: item.customPrompt,
            customImages: item.customImages,
            customDocx: item.customDocx || null,
          });
          pendingWork.push({ batchId, reportNumber: reportNum, item });
        }

        await persistBatchesSnapshot(updatedBatches);
      };

      const drainLiveQueue = async () => {
        if (queuedConcurrentAudiosRef.current.length > 0) {
          const extra = [...queuedConcurrentAudiosRef.current];
          queuedConcurrentAudiosRef.current = [];
          setQueuedAudiosCount(0);
          await enqueueItemsToBatches(extra);
        }
      };

      // Persist all initially passed items AND anything sitting in live queue right now (0ms delay on disk!)
      await enqueueItemsToBatches(subsequentItems);
      await drainLiveQueue();

      if (isDriveConnected()) {
        autoSaveBatchDictations(updatedBatches, undefined, now).then(res => {
          if (res.success) {
            setDriveSaveResult({ success: true, fileName: `${updatedBatches.length} reports saved to Drive` });
          }
        }).catch(err => console.warn('Drive batch auto-save notice:', err));
      }

      // 2. Process every pending item serially; dynamically pick up any #3, #4, #5 dictated mid-transfer!
      let wasCancelledByUser = false;
      for (let i = 0; i < pendingWork.length; i++) {
        await drainLiveQueue();
        const { batchId, reportNumber, item } = pendingWork[i];
        const itemAbortController = new AbortController();
        concurrentAbortControllerRef.current = itemAbortController;

        let findings: string[] = [];
        let itemStatus: 'complete' | 'error' = 'complete';
        try {
          findings = await processAudio(
            item.audioBlobs.length === 1 ? item.audioBlobs[0] : item.audioBlobs,
            selectedModel,
            item.customPrompt,
            item.customImages,
            undefined,
            item.customDocx,
            itemAbortController.signal
          );
        } catch (err: any) {
          if (err?.name === 'AbortError' || itemAbortController.signal.aborted) {
            wasCancelledByUser = true;
            itemStatus = 'error';
            findings = [
              `BOLD::Dictation #${reportNumber} analysis cancelled by user.`,
              `[Cancelled by user. Audio preserved below in Batch Mode.]`
            ];
          } else {
            console.error(`Error transcribing concurrent dictation #${reportNumber}:`, err);
            itemStatus = 'error';
            const msg = err instanceof Error ? err.message : 'Error processing dictation';
            findings = [
              `BOLD::Error processing dictation #${reportNumber}.`,
              `[Error: ${msg}]. Audio preserved below. You can retry processing or download audio.`
            ];
          }
        } finally {
          if (concurrentAbortControllerRef.current === itemAbortController) {
            concurrentAbortControllerRef.current = null;
          }
        }

        const reportName = itemStatus === 'error'
          ? `Report ${reportNumber} (${wasCancelledByUser ? 'Cancelled' : 'Error'})`
          : getTitle(findings, `Report ${reportNumber}`);
        const targetBatch = updatedBatches.find(b => b.id === batchId);
        if (targetBatch) {
          targetBatch.findings = findings;
          targetBatch.name = reportName;
          targetBatch.status = itemStatus;
          targetBatch.audioBlobs = item.audioBlobs;
          if (itemStatus === 'error') {
            targetBatch.error = findings[1] || 'Error processing dictation';
          }
        }

        if (wasCancelledByUser) {
          // Preserve any unstarted queued items cleanly as idle so none remain stuck in 'processing'
          for (let j = i + 1; j < pendingWork.length; j++) {
            const unstarted = updatedBatches.find(b => b.id === pendingWork[j].batchId);
            if (unstarted) {
              unstarted.status = 'idle' as const;
              unstarted.findings = null;
            }
          }
          await persistBatchesSnapshot(updatedBatches);
          break;
        }

        await persistBatchesSnapshot(updatedBatches);

        if (isDriveConnected()) {
          autoSaveBatchDictations(updatedBatches, undefined, now).then(res => {
            if (res.success) {
              setDriveSaveResult({ success: true, fileName: `${updatedBatches.filter(b => b.status === 'complete').length} reports saved to Drive` });
            }
          }).catch(err => console.warn('Drive incremental batch auto-save notice:', err));
        }

        await drainLiveQueue();
      }

      // If user is CURRENTLY recording/opening mic for another consecutive dictation OR resolving an unsaved audio alarm,
      // stay in AppStatus.Processing with accumulated batches preserved so we never interrupt or lose it!
      if (
        isConcurrentRecordingActiveRef.current ||
        isConcurrentIntentActiveRef.current ||
        hasConcurrentUnsavedAudioRef.current ||
        queuedConcurrentAudiosRef.current.length > 0
      ) {
        isSeparatingConcurrentRef.current = false;
        setIsSeparatingConcurrent(false);
        if (
          queuedConcurrentAudiosRef.current.length > 0 &&
          !isConcurrentRecordingActiveRef.current &&
          !isConcurrentIntentActiveRef.current &&
          !hasConcurrentUnsavedAudioRef.current
        ) {
          setTimeout(() => flushQueuedConcurrentIfReadyRef.current(), 0);
        }
        return;
      }

      // 3. Clean up single mode in-flight states once queue finishes, while keeping continuous session ready!
      deleteAudioBlob(`in_flight_recording_${curTabId}`).catch(() => {});
      deleteAudioBlob('in_flight_recording').catch(() => {});
      try {
        localStorage.removeItem(`in_flight_recording_meta_${curTabId}`);
        localStorage.removeItem('in_flight_recording_meta');
      } catch (_) {}

      activeConcurrentBatchesRef.current = [...updatedBatches];
      setActiveConcurrentBatchesCount(updatedBatches.length);
      firstDictationFindingsRef.current = null;
      firstDictationSuccessMetaRef.current = null;
      queuedConcurrentAudiosRef.current = [];
      setQueuedAudiosCount(0);
      isFirstDictationProcessingRef.current = false;
      isSeparatingConcurrentRef.current = false;
      setIsSeparatingConcurrent(false);
      setHasMultipleSingleDictations(true);
      setIsContinuousSessionReady(true);
    } catch (err) {
      console.error('Error saving separated concurrent dictations:', err);
      setIsSeparatingConcurrent(false);
      isSeparatingConcurrentRef.current = false;
      setError(err instanceof Error ? err.message : 'Error organizing separated dictations into Batch Mode.');
      setStatus(AppStatus.Error);
    }
  }, [selectedModel, customPrompt, customImages, customDocx]);

  const flushQueuedConcurrentIfReady = useCallback(() => {
    if (
      isFirstDictationProcessingRef.current ||
      isSeparatingConcurrentRef.current ||
      isConcurrentRecordingActiveRef.current ||
      isConcurrentIntentActiveRef.current ||
      hasConcurrentUnsavedAudioRef.current
    ) {
      return;
    }

    if (queuedConcurrentAudiosRef.current.length > 0) {
      const queuedList = [...queuedConcurrentAudiosRef.current];
      queuedConcurrentAudiosRef.current = [];
      setQueuedAudiosCount(0);
      const firstFindings = firstDictationFindingsRef.current;
      const firstBlob = firstDictationAudioRef.current || (Array.isArray(audioBlob) ? audioBlob[0] : audioBlob);
      const firstErr = firstDictationErrorRef.current;
      if (firstBlob || activeConcurrentBatchesRef.current.length > 0) {
        separateConcurrentDictationsToBatch(
          firstFindings || ["BOLD::Report 1"],
          firstBlob || null,
          queuedList,
          firstErr
        );
      }
      return;
    }

    // If queue is empty and an earlier #1 finished/errored while user was opening mic or recording #2 (which was later cancelled):
    if (status === AppStatus.Processing) {
      if (activeConcurrentBatchesRef.current.length > 0) {
        setActiveConcurrentBatchesCount(activeConcurrentBatchesRef.current.length);
        setHasMultipleSingleDictations(true);
        setIsContinuousSessionReady(true);
      } else if (firstDictationErrorRef.current) {
        setError(firstDictationErrorRef.current);
        firstDictationErrorRef.current = null;
        setFirstDictationError(null);
        setStatus(AppStatus.Error);
      } else if (firstDictationFindingsRef.current && firstDictationFindingsRef.current.length > 0) {
        const restoredFindings = firstDictationFindingsRef.current;
        const meta = firstDictationSuccessMetaRef.current;
        firstDictationFindingsRef.current = null;
        firstDictationSuccessMetaRef.current = null;
        setFindings(restoredFindings);
        if (meta) {
          finalizeFirstDictationSuccess(restoredFindings, meta.blobs, meta.prompt, meta.images, meta.reqId);
        } else {
          setStatus(AppStatus.Success);
        }
      }
    }
  }, [audioBlob, status, separateConcurrentDictationsToBatch, finalizeFirstDictationSuccess]);

  flushQueuedConcurrentIfReadyRef.current = flushQueuedConcurrentIfReady;

  const handleRecordingComplete = useCallback(async (
    audioInput: Blob | Blob[],
    overridePrompt?: string,
    overrideDocx?: DocxTemplateData | null,
    overrideImages?: Array<{ data: string; mimeType: string }>,
    options?: { preserveConcurrentSession?: boolean }
  ) => {
    // 0. Immediately abort any active in-flight network request
    if (inFlightAbortControllerRef.current) {
      try {
        inFlightAbortControllerRef.current.abort();
      } catch (_) {}
    }
    const currentAbortController = new AbortController();
    inFlightAbortControllerRef.current = currentAbortController;

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
    firstDictationFindingsRef.current = null;
    firstDictationErrorRef.current = null;
    firstDictationSuccessMetaRef.current = null;
    setFirstDictationError(null);
    isFirstDictationProcessingRef.current = true;
    currentFirstBatchAddedRef.current = false;
    setIsContinuousSessionReady(false);
    if (!options?.preserveConcurrentSession) {
      activeConcurrentBatchesRef.current = [];
      activeConcurrentBatchTsRef.current = null;
      setActiveConcurrentBatchesCount(0);
    }
    queuedConcurrentAudiosRef.current = [];
    setQueuedAudiosCount(0);
    setIsSimultaneousQueued(false);
    setConcurrentRecordingStatus(AppStatus.Idle);
    isConcurrentRecordingActiveRef.current = false;
    isSeparatingConcurrentRef.current = false;
    setIsSeparatingConcurrent(false);
    resetConcurrentCustomConfig();

    const primaryBlob = audioBlobs[0];
    firstDictationAudioRef.current = primaryBlob;
    setAudioBlob(audioBlobs.length > 1 ? audioBlobs : primaryBlob); // Preserve all input blobs (audio, text files, docx, etc.)

    // Multi-tab isolated pre-save: pulse heartbeat and tag in_flight_recording_meta with current tabId
    const currentTabId = getTabId();
    markTabActive('processing');
    const processingHeartbeatTimer = setInterval(() => {
      markTabActive('processing');
    }, 3000);

    saveAudioBlob(`in_flight_recording_${currentTabId}`, primaryBlob).catch(err => {
      console.warn("Could not pre-save in-flight audio:", err);
    });
    try {
      safeLocalStorage.setItem(`in_flight_recording_meta_${currentTabId}`, {
        tabId: currentTabId,
        timestamp: Date.now(),
        type: primaryBlob.type || 'audio/webm',
        size: primaryBlob.size,
      });
      safeLocalStorage.setItem('in_flight_recording_meta', {
        tabId: currentTabId,
        timestamp: Date.now(),
        type: primaryBlob.type || 'audio/webm',
        size: primaryBlob.size,
      });
    } catch (_) {}
    setRecoveredInFlightAudio(null);

    const promptToUse = overridePrompt !== undefined ? overridePrompt : customPromptRef.current;
    const docxToUse = overrideDocx !== undefined ? overrideDocx : customDocxRef.current;
    const imagesToUse = overrideImages !== undefined ? overrideImages : customImages;

    try {
      const processedText = await processAudio(
        audioBlobs,
        selectedModel,
        promptToUse,
        imagesToUse,
        undefined,
        docxToUse,
        currentAbortController.signal
      );
      clearInterval(processingHeartbeatTimer);
      markTabActive('idle');
      if (currentAbortController.signal.aborted || processingRequestIdRef.current !== reqId) return; // cancelled or template re-triggered

      isFirstDictationProcessingRef.current = false;
      firstDictationFindingsRef.current = processedText;
      firstDictationAudioRef.current = primaryBlob;
      firstDictationSuccessMetaRef.current = {
        blobs: audioBlobs,
        prompt: promptToUse,
        images: imagesToUse,
        reqId,
      };
      setFindings(processedText);

      // Check if user has queued any concurrent audios, is opening mic/recording, or has an unresolved unsaved audio alarm
      const isConcurrentBusy =
        isConcurrentRecordingActiveRef.current ||
        isConcurrentIntentActiveRef.current ||
        hasConcurrentUnsavedAudioRef.current;

      if (queuedConcurrentAudiosRef.current.length > 0 && !isConcurrentBusy) {
        const queuedList = [...queuedConcurrentAudiosRef.current];
        queuedConcurrentAudiosRef.current = [];
        setQueuedAudiosCount(0);
        setIsSimultaneousQueued(false);
        await separateConcurrentDictationsToBatch(processedText, primaryBlob, queuedList, null);
        return;
      } else if (isConcurrentBusy || queuedConcurrentAudiosRef.current.length > 0) {
        // User is recording, opening mic, staging files, or resolving unsaved audio — keep Processing mounted cleanly.
        return;
      }

      await finalizeFirstDictationSuccess(processedText, audioBlobs, promptToUse, imagesToUse, reqId);
    } catch (err: any) {
      clearInterval(processingHeartbeatTimer);
      markTabActive('idle');
      isFirstDictationProcessingRef.current = false;
      if (currentAbortController.signal.aborted || err?.name === 'AbortError' || processingRequestIdRef.current !== reqId) {
        return; // cancelled / aborted, do not show error
      }
      console.error(err);

      const errMessage = err instanceof Error ? err.message : 'An unknown error occurred during processing.';
      firstDictationErrorRef.current = errMessage;

      // If user is currently opening mic/recording a concurrent dictation, has an unresolved unsaved audio alarm, OR has already queued audio:
      const isConcurrentBusy =
        isConcurrentRecordingActiveRef.current ||
        isConcurrentIntentActiveRef.current ||
        hasConcurrentUnsavedAudioRef.current;
      const hasConcurrent = isConcurrentBusy || queuedConcurrentAudiosRef.current.length > 0;
      if (hasConcurrent) {
        setFirstDictationError(errMessage);
        firstDictationFindingsRef.current = [
          "BOLD::Previous dictation encountered an error during analysis.",
          `[Error: ${errMessage}]. Audio preserved.`
        ];
        // If not actively recording/opening mic/resolving alarm and has queued audios, dispatch them now!
        if (queuedConcurrentAudiosRef.current.length > 0 && !isConcurrentBusy) {
          const queuedList = [...queuedConcurrentAudiosRef.current];
          queuedConcurrentAudiosRef.current = [];
          setQueuedAudiosCount(0);
          separateConcurrentDictationsToBatch(firstDictationFindingsRef.current, primaryBlob, queuedList, errMessage);
        }
        return;
      }

      setError(errMessage);
      setStatus(AppStatus.Error);
    }
  }, [selectedModel, customImages, separateConcurrentDictationsToBatch, finalizeFirstDictationSuccess, resetConcurrentCustomConfig]);

  handleRecordingCompleteRef.current = handleRecordingComplete;

  const handleConcurrentRecordingComplete = useCallback(async (newAudioInput: Blob | Blob[]) => {
    isConcurrentRecordingActiveRef.current = false;
    setConcurrentRecordingStatus(AppStatus.Idle);
    const audioBlobs = Array.isArray(newAudioInput) ? newAudioInput : [newAudioInput];
    if (audioBlobs.length === 0 || audioBlobs.every(b => !b || b.size === 0)) return;

    const queuedItem: QueuedConcurrentItem = {
      audioBlobs,
      customPrompt: concurrentCustomPromptRef.current,
      customImages: concurrentCustomImagesRef.current,
      customDocx: concurrentCustomDocxRef.current,
    };

    // Push item to unlimited concurrent queue and reset the concurrent template/instructions selector for the next new dictation
    queuedConcurrentAudiosRef.current.push(queuedItem);
    setQueuedAudiosCount(queuedConcurrentAudiosRef.current.length);
    setIsSimultaneousQueued(true);
    setHasMultipleSingleDictations(true);
    setIsContinuousSessionReady(false);
    resetConcurrentCustomConfig();

    // If first dictation is still running its processAudio OR separation loop is already running OR another unsaved backup alarm needs resolving:
    if (isFirstDictationProcessingRef.current || isSeparatingConcurrentRef.current || hasConcurrentUnsavedAudioRef.current) {
      return;
    }

    // If first dictation has finished (either complete or error) or continuous session already has accumulated batches:
    const firstFindings = firstDictationFindingsRef.current;
    const firstBlob = firstDictationAudioRef.current || (Array.isArray(audioBlob) ? audioBlob[0] : audioBlob);
    const firstErr = firstDictationErrorRef.current;

    if (firstBlob || activeConcurrentBatchesRef.current.length > 0) {
      const queuedList = [...queuedConcurrentAudiosRef.current];
      queuedConcurrentAudiosRef.current = [];
      setQueuedAudiosCount(0);
      await separateConcurrentDictationsToBatch(
        firstFindings || ["BOLD::Report 1"],
        firstBlob || null,
        queuedList,
        firstErr
      );
    }
  }, [audioBlob, separateConcurrentDictationsToBatch, resetConcurrentCustomConfig]);

  const handleSubsequentDictationAfterError = useCallback(async (newAudioInput: Blob | Blob[]) => {
    // 1. Preserve the failed audio into Batch Mode AND seed activeConcurrentBatchesRef so subsequent dictations never overwrite it!
    const failedAudio = firstDictationAudioRef.current || (Array.isArray(audioBlob) ? audioBlob[0] : audioBlob);
    const failedErrMsg = error || firstDictationErrorRef.current || 'Processing error';
    
    if (failedAudio) {
      try {
        const curTabId = getTabId();
        const now = activeConcurrentBatchTsRef.current || Date.now();
        activeConcurrentBatchTsRef.current = now;
        const nextReportNum = activeConcurrentBatchesRef.current.length + 1;
        const batchId = `batch-err-${now}-${nextReportNum}`;
        await saveAudioBlob(`batch_audio_${curTabId}_${batchId}_0`, failedAudio);
        await saveAudioBlob(`batch_audio_${batchId}_0`, failedAudio);

        const curBatchKey = getBatchModeStorageKey(curTabId);
        const existingBatches: any[] = (await getReportSession(curBatchKey)) || safeLocalStorage.getItem(curBatchKey, []);
        
        const failedBatchItem = {
          id: batchId,
          name: `Report ${nextReportNum} (Interrupted)`,
          audioCount: 1,
          audioBlobs: [failedAudio],
          findings: [
            "BOLD::Previous dictation encountered an error during analysis.",
            `[Error: ${failedErrMsg}]. Your recorded audio is preserved below. You can retry processing or download audio.`
          ],
          status: 'error' as const,
          error: failedErrMsg,
          selectedModel,
          customPrompt,
          customDocx: customDocx || null,
        };

        const sessionBatches = [...activeConcurrentBatchesRef.current, failedBatchItem];
        activeConcurrentBatchesRef.current = sessionBatches;
        setActiveConcurrentBatchesCount(sessionBatches.length);
        currentFirstBatchAddedRef.current = false;

        const mergedStorageBatches = activeConcurrentBatchesRef.current.length > 1
          ? sessionBatches
          : [failedBatchItem, ...existingBatches.filter(b => b.id !== batchId)];
        const serializable = serializeBatchesForStorage(mergedStorageBatches);
        await saveReportSession(curBatchKey, serializable);
        safeLocalStorage.setItem(curBatchKey, serializable);
        await saveReportSession(BATCH_MODE_STORAGE_KEY, serializable).catch(() => {});
        safeLocalStorage.setItem(BATCH_MODE_STORAGE_KEY, serializable);
        window.dispatchEvent(new CustomEvent('raddoc_batch_mode_updated'));
        setHasMultipleSingleDictations(true);
      } catch (saveErr) {
        console.warn("Could not save failed audio to batch mode:", saveErr);
      }
    }

    // 2. Capture fresh per-dictation template & instructions selected for this new dictation
    const nextPrompt = concurrentCustomPromptRef.current;
    const nextImages = concurrentCustomImagesRef.current;
    const nextDocx = concurrentCustomDocxRef.current;
    setCustomPrompt(nextPrompt);
    setCustomImages(nextImages);
    setCustomDocx(nextDocx);

    // 3. Clear error state and start processing the new subsequent dictation while preserving prior preserved batch(es)!
    setError(null);
    firstDictationErrorRef.current = null;
    setFirstDictationError(null);
    setErrorRecorderStatus(AppStatus.Idle);
    await handleRecordingComplete(newAudioInput, nextPrompt, nextDocx, nextImages, { preserveConcurrentSession: true });
  }, [audioBlob, error, selectedModel, customPrompt, customDocx, handleRecordingComplete]);

  const handleSubsequentFileSelectAfterError = useCallback(async (files: File[]) => {
    if (!files || files.length === 0) return;
    await handleSubsequentDictationAfterError(files);
  }, [handleSubsequentDictationAfterError]);
  
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
    } catch (err) {
      if (processingRequestIdRef.current !== reqId) return; // cancelled
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred during re-processing.');
      setStatus(AppStatus.Error);
    }
  }, [audioBlob, selectedModel, customPrompt, customImages, customDocx, findings]);

  const driveEditDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const debouncedDriveAutoSave = useCallback((updatedFindings: string[]) => {
    if (!isDriveConnected() || updatedFindings.length === 0) return;
    if (driveEditDebounceTimerRef.current) {
      clearTimeout(driveEditDebounceTimerRef.current);
    }
    driveEditDebounceTimerRef.current = setTimeout(() => {
      const timestamp = activeDictationTimestampRef.current || Date.now();
      const currentHash = updatedFindings.join('|||');
      if (currentHash === driveSyncedHashRef.current) return;
      driveSyncedHashRef.current = currentHash;

      const savePromise = activeDictationIsLiveRef.current
        ? autoSaveLiveDictation(updatedFindings, timestamp)
        : autoSaveSingleDictation(updatedFindings, undefined, timestamp);

      savePromise.then(res => {
        if (res.success) {
          setDriveSaveResult(res);
        }
      }).catch(err => console.warn('Drive edit auto-save notice:', err));
    }, 1500);
  }, []);

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
    debouncedDriveAutoSave(updatedFindingsToSync);
  };

  const handleAllFindingsUpdate = useCallback((newFindings: string[]) => {
    const expanded = expandMacrosInFindings(newFindings);
    setFindings(expanded);
    debouncedDriveAutoSave(expanded);
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

    } catch (err) {
      console.error("Error during dictation continuation:", err);
      throw err; // Propagate error to the UI component
    }
  }, [audioBlob, findings, selectedModel, customPrompt, customImages]);
  handleContinueDictationRef.current = handleContinueDictation;

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
    // 1. If there was active session content, hold it in RAM memory ONLY for the 15-second Undo window
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
        qaAssessment,
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
            // 15 seconds elapsed without undo: permanently discard RAM copy!
            previousSingleSessionRef.current = null;
            return null;
          }
          return { ...prev, secondsRemaining: prev.secondsRemaining - 1 };
        });
      }, 1000);
    }

    // 2. WIPE PERSISTENT STORAGE IMMEDIATELY AT SECOND 0 FOR THIS TAB!
    try {
      const curTabId = getTabId();
      const singleKey = getSingleModeStorageKey(curTabId);
      const audioKey = getSingleModeAudioKey(curTabId);
      safeLocalStorage.removeItem(singleKey);
      safeLocalStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
      deleteAudioBlob(audioKey).catch(() => {});
      deleteAudioBlob('single_mode_audio').catch(() => {});
      deleteReportSession(singleKey).catch(() => {});
      deleteReportSession(SINGLE_MODE_STORAGE_KEY).catch(() => {});
      deleteAudioBlob(`in_flight_recording_${curTabId}`).catch(() => {});
      safeLocalStorage.removeItem(`in_flight_recording_meta_${curTabId}`);
      safeLocalStorage.removeItem(`has_unsaved_session_${curTabId}`);
    } catch (e) {
      console.warn("Storage wipe on reset:", e);
    }

    // Reset workspace to idle immediately so user can record right away without confirmation friction
    if (inFlightAbortControllerRef.current) {
      try { inFlightAbortControllerRef.current.abort(); } catch (_) {}
      inFlightAbortControllerRef.current = null;
    }
    if (concurrentAbortControllerRef.current) {
      try { concurrentAbortControllerRef.current.abort(); } catch (_) {}
      concurrentAbortControllerRef.current = null;
    }
    firstDictationFindingsRef.current = null;
    firstDictationAudioRef.current = null;
    firstDictationErrorRef.current = null;
    firstDictationSuccessMetaRef.current = null;
    setFirstDictationError(null);
    isFirstDictationProcessingRef.current = false;
    activeConcurrentBatchesRef.current = [];
    activeConcurrentBatchTsRef.current = null;
    currentFirstBatchAddedRef.current = false;
    visitedBatchSinceLastConcurrentRef.current = false;
    setActiveConcurrentBatchesCount(0);
    setIsContinuousSessionReady(false);
    queuedConcurrentAudiosRef.current = [];
    setQueuedAudiosCount(0);
    isConcurrentRecordingActiveRef.current = false;
    isConcurrentIntentActiveRef.current = false;
    hasConcurrentUnsavedAudioRef.current = false;
    isSeparatingConcurrentRef.current = false;
    setIsSeparatingConcurrent(false);
    setIsSimultaneousQueued(false);
    setConcurrentRecordingStatus(AppStatus.Idle);
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
    resetConcurrentCustomConfig();
    setSingleExtraFiles([]);
    setIdentifiedErrors([]);
    setQaAssessment(null);
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
    const restoredModel = (prev.selectedModel && prev.selectedModel !== 'gemini-3.5-flash' && AVAILABLE_MODELS.some(m => m.value === prev.selectedModel))
      ? prev.selectedModel
      : DEFAULT_SELECTED_MODEL;
    setSelectedModel(restoredModel);
    setIdentifiedErrors(prev.identifiedErrors);
    setQaAssessment(prev.qaAssessment ?? null);
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
      const curTabId = getTabId();
      const singleKey = getSingleModeStorageKey(curTabId);
      const audioKey = getSingleModeAudioKey(curTabId);
      await saveReportSession(singleKey, stateToSave);
      safeLocalStorage.removeItem(singleKey);
      safeLocalStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
      if (prev.audioBlob) {
        await saveAudioBlob(audioKey, prev.audioBlob);
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
      const curTabId = getTabId();
      const singleKey = getSingleModeStorageKey(curTabId);
      const audioKey = getSingleModeAudioKey(curTabId);
      safeLocalStorage.removeItem(singleKey);
      safeLocalStorage.removeItem(SINGLE_MODE_STORAGE_KEY);
      deleteAudioBlob(audioKey).catch(() => {});
      deleteAudioBlob('single_mode_audio').catch(() => {});
      deleteReportSession(singleKey).catch(() => {});
      deleteReportSession(SINGLE_MODE_STORAGE_KEY).catch(() => {});
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
                className="mb-4"
            />
            {activeTemplateDisplayName && (
              <div className="mb-4 p-3 bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-purple-500/10 dark:from-blue-900/30 dark:via-indigo-900/30 dark:to-purple-900/30 border border-blue-300 dark:border-blue-700 rounded-xl flex items-center justify-between text-xs sm:text-sm shadow-xs animate-fade-in">
                <div className="flex items-center gap-2 text-blue-950 dark:text-blue-100 font-medium">
                  <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span>
                    Attached Template: <strong className="font-bold underline text-blue-700 dark:text-blue-300">{activeTemplateDisplayName}</strong> — Dictation findings will be merged into this layout
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCustomPrompt('');
                    setCustomDocx(null);
                    setCustomImages([]);
                    clearUpcomingTemplate();
                  }}
                  className="text-xs text-rose-600 dark:text-rose-400 hover:text-rose-800 font-bold ml-2 underline cursor-pointer"
                >
                  Remove Template
                </button>
              </div>
            )}
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
          <div className="space-y-6 animate-fade-in">
            {firstDictationError && (
              <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-700/60 p-4 rounded-2xl flex flex-col sm:flex-row items-start justify-between gap-3 text-left shadow-sm">
                <div className="flex items-start gap-3">
                  <WarningIcon className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                  <div className="text-xs sm:text-sm">
                    <p className="font-bold text-rose-800 dark:text-rose-200">
                      Previous dictation error: {firstDictationError}
                    </p>
                    <p className="text-rose-700 dark:text-rose-300 mt-1">
                      Your previous dictation's audio has been safely preserved! You can download it below, retry analysis, or continue dictating below without interruption.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 self-end sm:self-center flex-wrap">
                  {(firstDictationAudioRef.current || audioBlob) && (
                    <button
                      type="button"
                      onClick={() => {
                        const blob = firstDictationAudioRef.current || (Array.isArray(audioBlob) ? audioBlob[0] : audioBlob);
                        if (blob) {
                          triggerAudioDownload(blob, 'preserved_previous_dictation');
                        }
                      }}
                      className="px-3 py-1.5 bg-rose-700 hover:bg-rose-800 text-white rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
                      title="Download the audio that encountered an error"
                    >
                      <DownloadIcon className="w-3.5 h-3.5" /> Download Audio
                    </button>
                  )}
                  {(firstDictationAudioRef.current || audioBlob) && (
                    <button
                      type="button"
                      onClick={async () => {
                        const blob = firstDictationAudioRef.current || (Array.isArray(audioBlob) ? audioBlob[0] : audioBlob);
                        if (!blob) return;
                        setFirstDictationError(null);
                        firstDictationErrorRef.current = null;

                        const hasConcurrentSession =
                          activeConcurrentBatchesRef.current.length > 0 ||
                          isConcurrentRecordingActiveRef.current ||
                          isConcurrentIntentActiveRef.current ||
                          queuedConcurrentAudiosRef.current.length > 0 ||
                          hasConcurrentUnsavedAudioRef.current;

                        if (!hasConcurrentSession) {
                          await handleRecordingComplete(blob);
                          return;
                        }

                        // Retry Report #1 in-place without disrupting active recordings or Batch Mode entries
                        if (activeConcurrentBatchesRef.current.length > 0) {
                          const targetBatch = activeConcurrentBatchesRef.current[0];
                          const retryBlob = (targetBatch.audioBlobs && targetBatch.audioBlobs[0]) || blob;
                          try {
                            const retriedFindings = await processAudio(
                              retryBlob,
                              selectedModel,
                              targetBatch.customPrompt || customPromptRef.current,
                              targetBatch.customImages || customImages,
                              undefined,
                              targetBatch.customDocx || customDocxRef.current
                            );
                            const firstLine = (retriedFindings[0] || '').replace(/^BOLD::/i, '').replace(/[*_#~`]+/g, '').trim();
                            targetBatch.findings = retriedFindings;
                            targetBatch.status = 'complete';
                            targetBatch.error = undefined;
                            targetBatch.name = (firstLine.length > 0 && firstLine.length < 80 && !firstLine.toLowerCase().startsWith('clinical'))
                              ? firstLine
                              : 'Report 1';
                            const curTabId = getTabId();
                            const curBatchKey = getBatchModeStorageKey(curTabId);
                            const serializable = serializeBatchesForStorage(activeConcurrentBatchesRef.current);
                            await saveReportSession(curBatchKey, serializable);
                            safeLocalStorage.setItem(curBatchKey, serializable);
                            await saveReportSession(BATCH_MODE_STORAGE_KEY, serializable).catch(() => {});
                            safeLocalStorage.setItem(BATCH_MODE_STORAGE_KEY, serializable);
                            window.dispatchEvent(new CustomEvent('raddoc_batch_mode_updated'));
                          } catch (retryErr: any) {
                            const msg = retryErr instanceof Error ? retryErr.message : 'Retry failed.';
                            firstDictationErrorRef.current = msg;
                            setFirstDictationError(msg);
                          }
                        } else {
                          isFirstDictationProcessingRef.current = true;
                          try {
                            const retriedFindings = await processAudio(
                              blob,
                              selectedModel,
                              customPromptRef.current,
                              customImages,
                              undefined,
                              customDocxRef.current
                            );
                            isFirstDictationProcessingRef.current = false;
                            firstDictationFindingsRef.current = retriedFindings;
                            setFindings(retriedFindings);
                            setTimeout(() => flushQueuedConcurrentIfReadyRef.current(), 0);
                          } catch (retryErr: any) {
                            isFirstDictationProcessingRef.current = false;
                            const msg = retryErr instanceof Error ? retryErr.message : 'Retry failed.';
                            firstDictationErrorRef.current = msg;
                            setFirstDictationError(msg);
                          }
                        }
                      }}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
                      title="Retry processing with rotating API keys"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Retry Analysis
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setFirstDictationError(null);
                      firstDictationErrorRef.current = null;
                    }}
                    className="px-2.5 py-1.5 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Flashing instruction banner to switch to Batch Dictation */}
            {(hasMultipleSingleDictations || queuedAudiosCount > 0 || isSeparatingConcurrent || isSimultaneousQueued) && (
              <div 
                onClick={() => {
                  setHasMultipleSingleDictations(false);
                  setMode('batch');
                  window.dispatchEvent(new CustomEvent('raddoc_batch_mode_updated'));
                }}
                className="p-3.5 bg-gradient-to-r from-amber-500 via-rose-500 to-indigo-600 hover:from-amber-600 hover:to-indigo-700 text-white rounded-2xl shadow-xl flex items-center justify-between cursor-pointer transition-all animate-pulse hover:scale-[1.01] border-2 border-white/50"
                title="Click here to switch to Batch Dictation to view all your dictated reports side-by-side"
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-3.5 h-3.5 rounded-full bg-yellow-300 animate-ping shrink-0" />
                  <div>
                    <p className="text-xs sm:text-sm font-black tracking-wide uppercase text-yellow-100 flex items-center gap-1.5">
                      👉 SWITCH TO BATCH DICTATION TO VIEW DICTATED REPORTS!
                    </p>
                    <p className="text-[11px] sm:text-xs text-white/95 font-medium">
                      All your single dictations are placed as separate reports in Batch Mode. Previous batches replaced. Auto-saved to Google Drive.
                    </p>
                  </div>
                </div>
                <span className="bg-white text-slate-900 font-extrabold text-xs px-3 py-1.5 rounded-xl whitespace-nowrap shadow-md shrink-0 ml-2">
                  Open Batch Mode →
                </span>
              </div>
            )}

            {(() => {
              const isActivelyBusy = isSeparatingConcurrent || isFirstDictationProcessingRef.current || queuedAudiosCount > 0;
              const isSessionReady = isContinuousSessionReady && !isActivelyBusy;
              const nextNum = (activeConcurrentBatchesCount > 0 ? activeConcurrentBatchesCount : 1) + queuedAudiosCount + 1;
              return (
                <>
                  <div className={`rounded-2xl p-5 shadow-sm text-center border ${
                    isSessionReady
                      ? 'bg-emerald-50/90 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800'
                      : 'bg-blue-50/90 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800'
                  }`}>
                    {!isSessionReady && (
                      <Spinner className="w-8 h-8 mx-auto text-blue-600 dark:text-blue-400" />
                    )}
                    <p className={`text-slate-800 dark:text-slate-100 ${isSessionReady ? '' : 'mt-3'} text-lg font-bold`}>
                      {isSeparatingConcurrent
                        ? 'Processing and organizing all dictations into Batch Mode...'
                        : isConcurrentRecordingActiveRef.current
                          ? (activeConcurrentBatchesCount > 0
                              ? `Capturing Report #${nextNum}...`
                              : isFirstDictationProcessingRef.current
                                ? 'Analyzing Dictation #1 while capturing Dictation #2...'
                                : firstDictationError
                                  ? 'Capturing Dictation #2 (Dictation #1 error preserved above)...'
                                  : 'First dictation completed! Still capturing your ongoing dictation...')
                          : isSessionReady
                            ? `✓ ${activeConcurrentBatchesCount} Report${activeConcurrentBatchesCount === 1 ? '' : 's'} Saved to Batch Mode — Continuous Dictation Ready`
                            : firstDictationError
                              ? 'Simultaneous Dictation Active'
                              : 'Analyzing and correcting dictation...'}
                    </p>
                    <p className="text-slate-600 dark:text-slate-300 mt-1 text-sm font-medium">
                      {isSeparatingConcurrent
                        ? 'All dictations are being placed as separate independent reports in Batch Mode.'
                        : isSessionReady
                          ? 'Keep dictating unlimited reports below without interruption, open Batch Mode above to view them, or start a fresh single session.'
                          : queuedAudiosCount > 0
                            ? `✓ ${queuedAudiosCount} additional dictation(s) queued! You can dictate even more below, or view in Batch Mode.`
                            : 'Simultaneous dictation active: You can dictate your next separate report below right now while this is processing!'}
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center items-center gap-3">
                      {isSessionReady ? (
                        <button
                          type="button"
                          onClick={resetSingleMode}
                          className="inline-flex items-center gap-2 bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 font-semibold py-2 px-5 rounded-lg border border-slate-300 dark:border-slate-600 transition-colors shadow-sm text-sm cursor-pointer"
                        >
                          <RotateCcw className="w-4 h-4" /> Start Fresh Single Report
                        </button>
                      ) : (
                        <button
                          onClick={handleCancelProcessing}
                          className="inline-flex items-center gap-2 bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/70 font-semibold py-2 px-5 rounded-lg border border-red-300 dark:border-red-700 transition-colors shadow-sm text-sm cursor-pointer"
                          aria-label="Cancel Analysis"
                        >
                          <StopIcon className="w-4 h-4" /> Cancel Analysis
                        </button>
                      )}
                      {audioBlob && !isSeparatingConcurrent && !isSessionReady && (
                        <button
                          onClick={handleDownload}
                          className="inline-flex items-center gap-2 bg-slate-600 text-white font-semibold py-2 px-5 rounded-lg hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-opacity-50 transition-colors shadow-sm text-sm cursor-pointer"
                          aria-label="Download Audio / File"
                        >
                          <DownloadIcon className="w-4 h-4" /> Download Audio
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Always keep Simultaneous Dictation active & visible - never forbidden! */}
                  <div className="border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/40 dark:bg-emerald-950/20 rounded-2xl p-4 sm:p-5 shadow-sm">
                      <div className="flex items-center justify-between mb-3 px-1">
                        <span className="text-sm font-bold text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
                          <MicIcon className="w-4 h-4 text-emerald-600 animate-pulse" />
                          Simultaneous Dictation (Dictate {nextNum > 2 || queuedAudiosCount > 0 ? `#${nextNum}` : 'next report'} {isSessionReady ? 'continuously' : 'while loading'})
                        </span>
                        <div className="flex items-center gap-2">
                          {queuedAudiosCount > 0 && (
                            <span className="text-xs bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 px-2.5 py-0.5 rounded-full font-bold">
                              {queuedAudiosCount} in Queue
                            </span>
                          )}
                          <span className="text-xs bg-emerald-200/70 dark:bg-emerald-900/60 text-emerald-800 dark:text-emerald-200 px-2.5 py-0.5 rounded-full font-semibold">
                            Unlimited Dictations Ready
                          </span>
                        </div>
                      </div>

                      {queuedAudiosCount > 0 && (
                        <div className="mb-3 p-2.5 bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/50 rounded-xl text-xs text-blue-800 dark:text-blue-200 flex flex-wrap items-center justify-between gap-2">
                          <span>
                            ✓ {queuedAudiosCount} additional dictation{queuedAudiosCount > 1 ? 's' : ''} queued! You can continue dictating as many times as you like below.
                          </span>
                          {!isFirstDictationProcessingRef.current && !isSeparatingConcurrent && concurrentRecordingStatus !== AppStatus.Recording && (
                            <button
                              onClick={() => {
                                if (hasConcurrentUnsavedAudioRef.current) {
                                  alert('Please recover or discard the interrupted simultaneous audio backup below first so nothing is lost before moving to Batch Mode.');
                                  return;
                                }
                                flushQueuedConcurrentIfReadyRef.current();
                              }}
                              className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-1 px-3 rounded-lg text-xs transition-colors shrink-0 cursor-pointer"
                            >
                              Process in Batch Mode Now →
                            </button>
                          )}
                        </div>
                      )}

                      <div className="mb-4">
                        <div className="text-xs font-bold text-emerald-800 dark:text-emerald-200 mb-2 flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span>Custom Instructions &amp; Templates (New Dictation #{nextNum})</span>
                        </div>
                        <CustomPromptInput
                          key={`concurrent-prompt-${activeConcurrentBatchesCount}-${queuedAudiosCount}`}
                          prompt={concurrentCustomPrompt}
                          onPromptChange={setConcurrentCustomPrompt}
                          images={concurrentCustomImages}
                          onImagesChange={setConcurrentCustomImages}
                          customDocx={concurrentCustomDocx}
                          onCustomDocxChange={setConcurrentCustomDocx}
                          selectedModel={selectedModel}
                          className="mb-2"
                        />
                        {concurrentActiveTemplateDisplayName && (
                          <div className="mb-2 p-2.5 bg-white/80 dark:bg-slate-900/70 border border-emerald-300 dark:border-emerald-700 rounded-xl flex items-center justify-between text-xs shadow-2xs animate-fade-in">
                            <div className="flex items-center gap-2 text-emerald-950 dark:text-emerald-100 font-medium min-w-0">
                              <Sparkles className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                              <span className="truncate">
                                Template for Dictation #{nextNum}: <strong className="font-bold underline text-emerald-700 dark:text-emerald-300">{concurrentActiveTemplateDisplayName}</strong>
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setConcurrentCustomPrompt('');
                                setConcurrentCustomDocx(null);
                                setConcurrentCustomImages([]);
                              }}
                              className="text-xs text-rose-600 dark:text-rose-400 hover:text-rose-800 font-bold ml-2 underline cursor-pointer shrink-0"
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </div>

                      <AudioRecorder
                        status={concurrentRecordingStatus}
                        setStatus={(newSt) => {
                          const wasRecording = isConcurrentRecordingActiveRef.current;
                          setConcurrentRecordingStatus(newSt);
                          isConcurrentRecordingActiveRef.current = (newSt === AppStatus.Recording);
                          if (wasRecording && newSt !== AppStatus.Recording) {
                            setTimeout(() => flushQueuedConcurrentIfReadyRef.current(), 0);
                          }
                        }}
                        onRecordingIntentChange={(hasIntent) => {
                          const wasIntent = isConcurrentIntentActiveRef.current;
                          isConcurrentIntentActiveRef.current = hasIntent;
                          if (wasIntent && !hasIntent) {
                            setTimeout(() => flushQueuedConcurrentIfReadyRef.current(), 0);
                          }
                        }}
                        onUnsavedStateChange={(hasUnsaved) => {
                          const wasUnsaved = hasConcurrentUnsavedAudioRef.current;
                          hasConcurrentUnsavedAudioRef.current = hasUnsaved;
                          if (wasUnsaved && !hasUnsaved) {
                            setTimeout(() => flushQueuedConcurrentIfReadyRef.current(), 0);
                          }
                        }}
                        onRecordingComplete={handleConcurrentRecordingComplete}
                        onMultipleFilesUploaded={(files) => setMultipleFilesModal(files)}
                      />
                    </div>
                </>
              );
            })()}
          </div>
        );
      case AppStatus.Success:
        return (
          <ErrorBoundary sectionName="Results Display" onReset={resetSingleMode}>
            {hasMultipleSingleDictations && (
              <div 
                onClick={() => {
                  setHasMultipleSingleDictations(false);
                  setMode('batch');
                  window.dispatchEvent(new CustomEvent('raddoc_batch_mode_updated'));
                }}
                className="mb-4 p-3.5 bg-gradient-to-r from-amber-500 via-rose-500 to-indigo-600 hover:from-amber-600 hover:to-indigo-700 text-white rounded-2xl shadow-xl flex items-center justify-between cursor-pointer transition-all animate-pulse hover:scale-[1.01] border-2 border-white/50"
                title="Click here to switch to Batch Dictation to view all your dictated reports side-by-side"
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-3.5 h-3.5 rounded-full bg-yellow-300 animate-ping shrink-0" />
                  <div>
                    <p className="text-xs sm:text-sm font-black tracking-wide uppercase text-yellow-100 flex items-center gap-1.5">
                      👉 SWITCH TO BATCH DICTATION TO VIEW DICTATED REPORTS!
                    </p>
                    <p className="text-[11px] sm:text-xs text-white/95 font-medium">
                      You dictated multiple reports! All reports have replaced previous batches in Batch Mode and are saved to Google Drive.
                    </p>
                  </div>
                </div>
                <span className="bg-white text-slate-900 font-extrabold text-xs px-3 py-1.5 rounded-xl whitespace-nowrap shadow-md shrink-0 ml-2">
                  Open Batch Mode →
                </span>
              </div>
            )}
            {isErrorCheckEnabled && (
              <ClinicalQaPanel
                assessment={qaAssessment}
                errorCheckStatus={errorCheckStatus}
                errorCount={identifiedErrors.length}
                className="mb-4"
              />
            )}
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
            initialExtraFiles={singleExtraFiles}
            identifiedErrors={identifiedErrors}
            errorCheckStatus={errorCheckStatus}
            onOpenMacrosModal={() => setIsMacrosModalOpen(true)}
            />
          </ErrorBoundary>
        );
      case AppStatus.Error:
        return (
          <div className="space-y-6">
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
                  : 'You can re-upload an audio file directly to process, or start a new recording below.'}
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
                    className="flex items-center gap-2 bg-blue-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition-colors shadow text-sm cursor-pointer"
                  >
                    Retry Processing Audio
                  </button>
                )}
                {audioBlob && (
                  <button
                    onClick={handleDownload}
                    className="flex items-center gap-2 bg-slate-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-opacity-50 transition-colors shadow text-sm cursor-pointer"
                  >
                    <DownloadIcon className="w-4 h-4" /> Download Audio File
                  </button>
                )}
                <button
                  onClick={() => errorFileInputRef.current?.click()}
                  className="flex items-center gap-2 bg-emerald-600 text-white font-bold py-2.5 px-5 rounded-lg hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-opacity-50 transition-colors shadow text-sm cursor-pointer"
                >
                  <UploadIcon className="w-4 h-4" /> Re-upload & Process Audio
                </button>
                <button
                  onClick={resetSingleMode}
                  className="bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 font-bold py-2.5 px-5 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-opacity-50 transition-colors text-sm cursor-pointer"
                >
                  Start New Recording
                </button>
              </div>
            </div>

            {/* Active Subsequent Dictation Section - Unlocked and NEVER forbidden */}
            <div className="max-w-4xl mx-auto border-t-2 border-dashed border-slate-300 dark:border-slate-700 pt-6">
              <div className="bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/30 border border-emerald-300 dark:border-emerald-700/60 p-4 rounded-2xl mb-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
                <div className="flex items-center gap-2.5">
                  <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  <div>
                    <h4 className="text-sm font-bold text-emerald-900 dark:text-emerald-100">
                      🎙️ Dictate Next Report Now (Subsequent Dictation Unlocked)
                    </h4>
                    <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-0.5">
                      Your prior audio is safely preserved above. You can speak or upload your next dictation right below without waiting!
                    </p>
                  </div>
                </div>
                <span className="bg-emerald-600 text-white font-bold text-xs px-3 py-1.5 rounded-xl shadow-xs shrink-0">
                  Ready to Record
                </span>
              </div>

              <div className="mb-4">
                <div className="text-xs font-bold text-emerald-800 dark:text-emerald-200 mb-2 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>Custom Instructions &amp; Templates (New Next Dictation)</span>
                </div>
                <CustomPromptInput
                  prompt={concurrentCustomPrompt}
                  onPromptChange={setConcurrentCustomPrompt}
                  images={concurrentCustomImages}
                  onImagesChange={setConcurrentCustomImages}
                  customDocx={concurrentCustomDocx}
                  onCustomDocxChange={setConcurrentCustomDocx}
                  selectedModel={selectedModel}
                  className="mb-2"
                />
                {concurrentActiveTemplateDisplayName && (
                  <div className="mb-2 p-2.5 bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700 rounded-xl flex items-center justify-between text-xs shadow-2xs animate-fade-in">
                    <div className="flex items-center gap-2 text-emerald-950 dark:text-emerald-100 font-medium min-w-0">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span className="truncate">
                        Attached Template for Next Dictation: <strong className="font-bold underline text-emerald-700 dark:text-emerald-300">{concurrentActiveTemplateDisplayName}</strong>
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setConcurrentCustomPrompt('');
                        setConcurrentCustomDocx(null);
                        setConcurrentCustomImages([]);
                      }}
                      className="text-xs text-rose-600 dark:text-rose-400 hover:text-rose-800 font-bold ml-2 underline cursor-pointer shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>

              <AudioRecorder
                status={errorRecorderStatus}
                setStatus={setErrorRecorderStatus}
                onRecordingComplete={handleSubsequentDictationAfterError}
                onMultipleFilesUploaded={(files) => handleSubsequentFileSelectAfterError(files)}
              />
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const handleApplyAutonomousBatches = async (newBatches: Array<{
    id?: string;
    name: string;
    findings: string[];
    audioBlobs: Blob[];
    selectedModel: string;
    customPrompt?: string;
    customDocx?: DocxTemplateData | null;
    customImages?: Array<{ data: string; mimeType: string }>;
    extraFiles?: File[];
  }>) => {
    try {
      const currentTabId = getTabId();
      const curBatchKey = getBatchModeStorageKey(currentTabId);
      let currentBatches: any[] = (await getReportSession(curBatchKey)) || (await getReportSession('radiologyDictationBatchMode')) || [];
      if (!currentBatches || currentBatches.length === 0) {
        const currentBatchesRaw = localStorage.getItem(curBatchKey) || localStorage.getItem('radiologyDictationBatchMode');
        currentBatches = currentBatchesRaw ? JSON.parse(currentBatchesRaw) : [];
      }
      
      for (let idx = 0; idx < newBatches.length; idx++) {
        const b = newBatches[idx];
        const incomingName = (b.name || '').trim().toLowerCase();
        
        // Match existing batch by ID, or by patient name
        const existingIdx = currentBatches.findIndex(existing => {
          if (b.id && existing.id === b.id) return true;
          const existName = (existing.name || '').trim().toLowerCase();
          return existName === incomingName;
        });

        const batchId = existingIdx !== -1 
          ? currentBatches[existingIdx].id 
          : (b.id || `batch-auto-${Date.now()}-${idx}`);

        // Save audio blobs to IndexedDB if provided
        if (b.audioBlobs && b.audioBlobs.length > 0) {
          for (let bIdx = 0; bIdx < b.audioBlobs.length; bIdx++) {
            try {
              await saveAudioBlob(`batch_audio_${currentTabId}_${batchId}_${bIdx}`, b.audioBlobs[bIdx]);
              await saveAudioBlob(`batch_audio_${batchId}_${bIdx}`, b.audioBlobs[bIdx]);
            } catch (e) {
              console.warn('Failed to save batch audio blob to IndexedDB:', e);
            }
          }
        }

        const formattedBatch = {
          id: batchId,
          name: b.name,
          audioCount: b.audioBlobs && b.audioBlobs.length > 0 
            ? b.audioBlobs.length 
            : (existingIdx !== -1 ? currentBatches[existingIdx].audioCount : 0),
          findings: b.findings,
          status: 'complete',
          selectedModel: b.selectedModel || selectedModel,
          customPrompt: b.customPrompt || (existingIdx !== -1 ? currentBatches[existingIdx].customPrompt : ''),
          customDocx: b.customDocx !== undefined ? b.customDocx : (existingIdx !== -1 ? currentBatches[existingIdx].customDocx : null),
          customImages: b.customImages || (existingIdx !== -1 ? currentBatches[existingIdx].customImages : []),
          extraFiles: b.extraFiles || (existingIdx !== -1 ? currentBatches[existingIdx].extraFiles : []),
          identifiedErrors: [],
          qaAssessment: undefined,
          qaFindingsHash: undefined,
          errorCheckStatus: 'idle' as const,
        };

        if (existingIdx !== -1) {
          // Replace previous version in-place so modified version stays where it is
          currentBatches[existingIdx] = {
            ...currentBatches[existingIdx],
            ...formattedBatch,
          };
        } else {
          // New patient: append to batch queue
          currentBatches.push(formattedBatch);
        }
      }

      await saveReportSession(curBatchKey, currentBatches);
      safeLocalStorage.removeItem(curBatchKey);
      safeLocalStorage.removeItem('radiologyDictationBatchMode');
      await deleteReportSession('radiologyDictationBatchMode').catch(() => {});
    } catch (e) {
      console.warn('Failed to save/update autonomous batches in storage:', e);
    }
  };


  const getPageDescription = () => {
    if (mode === 'autonomous') return 'Dictate naturally to orchestrate Single Mode, Batch Mode, Templates, File Handovers, and Exports in one step.';
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
    loadedExtraFiles?: File[],
    loadedPrompt?: string,
    loadedDocx?: DocxTemplateData | null,
    templateUsed?: string
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
    if (loadedExtraFiles && loadedExtraFiles.length > 0) {
      setSingleExtraFiles(loadedExtraFiles);
    } else {
      setSingleExtraFiles([]);
    }
    if (loadedPrompt) {
      setCustomPrompt(loadedPrompt);
    } else if (templateUsed) {
      setCustomPrompt(`[TEMPLATE_ID: ${templateUsed}] Merged with template: ${templateUsed}`);
    }
    if (loadedDocx) {
      setCustomDocx(loadedDocx);
    }
    setError(null);
    setDriveSaveResult({
      success: true,
      fileName: reportName,
    });
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
                  id="api-keys-header-btn-mobile"
                  onClick={() => setIsApiKeyModalOpen(true)}
                  className={`p-1.5 rounded-lg border min-h-[34px] min-w-[34px] flex items-center justify-center relative cursor-pointer shadow-xs ${
                    customKeysCount > 0
                      ? 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700/60'
                      : isSecretUnlocked
                      ? 'text-purple-700 bg-purple-50 dark:bg-purple-950/40 border-purple-300 dark:border-purple-700/60'
                      : 'text-amber-700 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700/60 animate-pulse'
                  }`}
                  aria-label="Gemini API Keys"
                  title={
                    customKeysCount > 0
                      ? `API Keys (${customKeysCount} active)`
                      : isSecretUnlocked
                      ? 'API Keys (Secret Mode: 9 built-in keys active)'
                      : 'No API Key — Click to add your free Gemini API key'
                  }
                >
                  <Key className="w-4 h-4" />
                  {customKeysCount > 0 ? (
                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-500 text-white rounded-full text-[9px] font-bold flex items-center justify-center">
                      {customKeysCount}
                    </span>
                  ) : isSecretUnlocked ? (
                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-purple-600 text-white rounded-full text-[9px] font-bold flex items-center justify-center">
                      9
                    </span>
                  ) : (
                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-amber-500 text-white rounded-full text-[9px] font-bold flex items-center justify-center">
                      !
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
              <h1 
                onClick={handleHeaderTitleClick}
                className="text-lg font-extrabold text-slate-800 dark:text-slate-100 tracking-tight flex items-center justify-center gap-1.5 cursor-pointer select-none"
                title="RADDOC's Dictation app (Click to enter secret key)"
              >
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
              <h1 
                onClick={handleHeaderTitleClick}
                className="text-xl sm:text-2xl md:text-3xl font-extrabold text-slate-800 dark:text-slate-100 tracking-tight whitespace-nowrap flex items-center justify-center gap-2 cursor-pointer select-none"
                title="RADDOC's Dictation app (Click to enter secret key)"
              >
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
                id="api-keys-header-btn"
                onClick={() => setIsApiKeyModalOpen(true)}
                className={`p-2 sm:p-2.5 rounded-xl transition-colors shrink-0 shadow-sm border cursor-pointer min-h-[36px] min-w-[36px] flex items-center justify-center gap-1.5 relative ${
                  customKeysCount > 0
                    ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60'
                    : isSecretUnlocked
                    ? 'text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/40 border-purple-300 dark:border-purple-700/60 hover:bg-purple-100 dark:hover:bg-purple-900/60'
                    : 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700/60 hover:bg-amber-100 dark:hover:bg-amber-900/60'
                }`}
                aria-label="Gemini API Keys & Failover"
                title={
                  customKeysCount > 0
                    ? `API Keys (${customKeysCount} custom keys active)`
                    : isSecretUnlocked
                    ? 'API Keys (Secret Mode: 9 rotating keys active)'
                    : 'No API Key Configured — Click to Add Your Key'
                }
              >
                <Key className={`w-5 h-5 shrink-0 ${
                  customKeysCount > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : isSecretUnlocked
                    ? 'text-purple-600 dark:text-purple-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`} />
                <span className="text-xs font-semibold hidden md:inline">
                  {customKeysCount > 0
                    ? `Custom Keys (${customKeysCount})`
                    : isSecretUnlocked
                    ? 'Secret Keys (9)'
                    : 'Add API Key (!)'}
                </span>
                {customKeysCount > 0 ? (
                  <span className="md:hidden absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center shadow-sm">
                    {customKeysCount}
                  </span>
                ) : isSecretUnlocked ? (
                  <span className="md:hidden absolute -top-1 -right-1 w-4 h-4 bg-purple-600 text-white rounded-full text-[10px] font-bold flex items-center justify-center shadow-sm">
                    9
                  </span>
                ) : (
                  <span className="md:hidden absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center shadow-sm">
                    !
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
            <nav className="grid grid-cols-2 sm:inline-flex gap-1 p-1 bg-slate-200/80 dark:bg-slate-800 rounded-xl shadow-inner border border-slate-300/60 dark:border-slate-700/60 w-full sm:w-auto" aria-label="Dictation modes">
              <button
                type="button"
                onClick={() => setMode('single')}
                className={`flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all min-h-[44px] cursor-pointer ${
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
                onClick={() => {
                  setHasMultipleSingleDictations(false);
                  setMode('batch');
                  window.dispatchEvent(new CustomEvent('raddoc_batch_mode_updated'));
                }}
                className={`flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all min-h-[44px] relative cursor-pointer ${
                  mode === 'batch'
                    ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                    : (hasMultipleSingleDictations || queuedAudiosCount > 0 || isSeparatingConcurrent || isSimultaneousQueued)
                      ? 'text-white bg-gradient-to-r from-amber-500 via-rose-500 to-indigo-600 animate-pulse shadow-md font-bold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
                aria-label="Batch Processing Mode"
              >
                <span className="text-sm shrink-0">📑</span>
                <span className="whitespace-nowrap">Batch Mode</span>
                {(hasMultipleSingleDictations || queuedAudiosCount > 0 || isSeparatingConcurrent || isSimultaneousQueued) && (
                  <span className="absolute -top-2 -right-1 px-1.5 py-0.5 bg-yellow-400 text-slate-900 text-[10px] font-black rounded-full animate-bounce shadow">
                    GO HERE!
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setMode('live')}
                className={`flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all min-h-[44px] cursor-pointer ${
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
                className={`flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all min-h-[44px] cursor-pointer ${
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
          <div className="mt-4 flex flex-col sm:flex-row justify-center items-center gap-3 sm:gap-6 bg-slate-100/80 dark:bg-slate-800/60 p-2.5 sm:p-3 rounded-xl border border-slate-200/70 dark:border-slate-700/60 max-w-2xl mx-auto">
              {(status === AppStatus.Idle || isContinuousSessionReady) && (mode === 'single' || mode === 'batch' || mode === 'autonomous') && (
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
                  <label
                      htmlFor="error-check-toggle"
                      className="text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-300 cursor-pointer flex items-center gap-1.5"
                      title="Runs single-pass Gemini Decision-1 QA (laterality, contradictions, impression numbers, critical STAT alert & completeness score) before conditional explanation generation"
                  >
                      <span>Automatic Error Finding</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 border border-blue-200/70 dark:border-blue-800/60">
                        Decision-1 QA
                      </span>
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

        {/* Friendly Quick-Setup Callout when no Gemini API key is configured */}
        {customKeysCount === 0 && !isSecretUnlocked && (
          <div
            onClick={() => setIsApiKeyModalOpen(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setIsApiKeyModalOpen(true);
              }
            }}
            className="mb-4 max-w-2xl mx-auto p-3 sm:p-3.5 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/50 dark:to-orange-950/40 border border-amber-300 dark:border-amber-700/80 rounded-xl shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 cursor-pointer hover:border-amber-400 transition-all"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/70 text-amber-700 dark:text-amber-300 shrink-0">
                <Key className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs sm:text-sm font-bold text-amber-950 dark:text-amber-100">
                  Gemini API Key Required to Transcribe
                </p>
                <p className="text-[11px] sm:text-xs text-amber-800 dark:text-amber-300">
                  Free 1-minute setup in Google AI Studio (Create Project first → Create API Key → Paste any key format like AQ... or AIzaSy...).
                </p>
              </div>
            </div>
            <span className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-2xs shrink-0">
              Add API Key →
            </span>
          </div>
        )}

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

        {/* Active background recording indicator across mode tabs */}
        {(mode !== 'single' && (status === AppStatus.Recording || concurrentRecordingStatus === AppStatus.Recording)) && (
          <div 
            onClick={() => setMode('single')}
            className="mb-4 p-3 bg-red-600 hover:bg-red-700 text-white rounded-xl shadow-md flex items-center justify-between cursor-pointer transition-all animate-pulse"
            title="Single Dictation audio recording is active in background. Click to return."
          >
            <div className="flex items-center gap-2.5">
              <span className="w-3 h-3 rounded-full bg-white animate-ping"></span>
              <span className="text-xs sm:text-sm font-bold">
                Single Dictation audio recording is active in the background — click here to return
              </span>
            </div>
            <span className="text-xs bg-red-800/80 px-2.5 py-1 rounded-md font-semibold">
              Return to Recording →
            </span>
          </div>
        )}

        {/* Main Content Card */}
        <main className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-3.5 sm:p-6 md:p-8 min-h-[300px] border border-slate-100 dark:border-slate-700/50 transition-all">
          <div className={mode === 'single' ? 'block' : 'hidden'}>
            {renderSingleModeContent()}
          </div>
          <div className={mode === 'batch' ? 'block' : 'hidden'}>
            <ErrorBoundary sectionName="Batch Mode" onReset={() => setMode('single')}>
              <BatchProcessor 
                key={`batch-proc-${batchModeInstanceKey}`}
                selectedModel={selectedModel} 
                isErrorCheckEnabled={isErrorCheckEnabled}
                initialFiles={pendingBatchFiles}
                onClearInitialFiles={() => setPendingBatchFiles(null)}
                onSaveToDrive={(res) => {
                  setDriveSaveResult(res);
                }}
                onBack={() => {
                  setMode('single');
                }} 
              />
            </ErrorBoundary>
          </div>
          <div className={mode === 'live' ? 'block' : 'hidden'}>
            <ErrorBoundary sectionName="Live Dictation" onReset={() => setMode('single')}>
              <LiveDictation onComplete={handleLiveDictationComplete} onBack={() => setMode('single')} onOpenMacrosModal={() => setIsMacrosModalOpen(true)} />
            </ErrorBoundary>
          </div>
          <div className={mode === 'autonomous' ? 'block' : 'hidden'}>
            <ErrorBoundary sectionName="Autonomous Mode" onReset={() => setMode('single')}>
              <AutonomousModeView
                selectedModel={selectedModel}
                onApplyBatchReports={handleApplyAutonomousBatches}
                onNavigateToBatch={() => setMode('batch')}
                onSaveToDrive={(res) => {
                  setDriveSaveResult(res);
                }}
              />
            </ErrorBoundary>
          </div>
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
                    if (status === AppStatus.Processing) {
                      handleConcurrentRecordingComplete(files);
                    } else {
                      handleRecordingComplete(files);
                    }
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
      </div>
    </div>
  );
};

export default App;
