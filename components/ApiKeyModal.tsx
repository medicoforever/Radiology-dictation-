import React, { useState, useEffect, useCallback } from 'react';
import {
  Key,
  X,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Shield,
  ShieldCheck,
  Eye,
  EyeOff,
  Sparkles,
  ExternalLink,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Clock,
} from 'lucide-react';
import {
  getUserApiKeys,
  addUserApiKey,
  removeUserApiKey,
  clearUserApiKeys,
  getDefaultApiKeys,
  getCandidateKeysForOperation,
  getTotalActiveApiKeyCount,
  maskApiKey,
  testApiKeyValidity,
  isBuiltinKeysUnlocked,
  unlockBuiltinKeys,
  lockBuiltinKeys,
  syncApiKeysWithGoogleDrive,
  API_KEYS_UPDATED_EVENT,
  API_KEY_SETTINGS_UPDATED_EVENT,
  OverloadedModelInfo,
  MODEL_OVERLOAD_UPDATED_EVENT,
  isRetryTopTierAllKeysOn503Enabled,
  setRetryTopTierAllKeysOn503Enabled,
  getOverloadedModelStates,
  clearModelTemporarilyUnavailable,
  clearAllModelUnavailableCooldowns,
} from '../services/apiKeyService';
import { getModelDisplayLabel } from '../constants';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedModel?: string;
}

function formatRemainingMs(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}h ${remMins}m`;
  }
  if (mins > 0) {
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({
  isOpen,
  onClose,
  selectedModel,
}) => {
  const [userKeys, setUserKeys] = useState<string[]>([]);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [keyValidationStatus, setKeyValidationStatus] = useState<
    Record<string, { valid: boolean; message?: string }>
  >({});
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [isTestingFailover, setIsTestingFailover] = useState(false);
  const [failoverTestResult, setFailoverTestResult] = useState<string | null>(null);
  const [secretKeyInput, setSecretKeyInput] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(() => isBuiltinKeysUnlocked());
  const [showGuide, setShowGuide] = useState(false);

  // Active key count & multi-key Top-Tier retry preference
  const [totalActiveKeys, setTotalActiveKeys] = useState<number>(() => getTotalActiveApiKeyCount());
  const [retryTopTierAllKeys, setRetryTopTierAllKeys] = useState<boolean>(() =>
    isRetryTopTierAllKeysOn503Enabled()
  );

  // Temporary busy model pauses state
  const [overloadedModels, setOverloadedModels] = useState<OverloadedModelInfo[]>(() =>
    getOverloadedModelStates()
  );

  const refreshState = useCallback(() => {
    setUserKeys(getUserApiKeys());
    setIsUnlocked(isBuiltinKeysUnlocked());
    setTotalActiveKeys(getTotalActiveApiKeyCount());
    setRetryTopTierAllKeys(isRetryTopTierAllKeysOn503Enabled());
    setOverloadedModels(getOverloadedModelStates());
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshState();
      setBannerMessage(null);
      setFailoverTestResult(null);
      setSecretKeyInput('');
      syncApiKeysWithGoogleDrive()
        .then(() => refreshState())
        .catch(() => {});
    }

    const handleKeyUpdate = () => refreshState();
    const handleOverloadUpdate = () => setOverloadedModels(getOverloadedModelStates());

    window.addEventListener(API_KEYS_UPDATED_EVENT, handleKeyUpdate);
    window.addEventListener(API_KEY_SETTINGS_UPDATED_EVENT, handleKeyUpdate);
    window.addEventListener(MODEL_OVERLOAD_UPDATED_EVENT, handleOverloadUpdate);

    return () => {
      window.removeEventListener(API_KEYS_UPDATED_EVENT, handleKeyUpdate);
      window.removeEventListener(API_KEY_SETTINGS_UPDATED_EVENT, handleKeyUpdate);
      window.removeEventListener(MODEL_OVERLOAD_UPDATED_EVENT, handleOverloadUpdate);
    };
  }, [isOpen, refreshState]);

  // Live countdown ticker for active temporary pauses while modal is open
  useEffect(() => {
    if (!isOpen || overloadedModels.length === 0) return;
    const timer = setInterval(() => {
      setOverloadedModels(getOverloadedModelStates());
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen, overloadedModels.length]);

  if (!isOpen) return null;

  const defaultKeysCount = getDefaultApiKeys().length;
  const isUsingCustomKeys = userKeys.length > 0;

  const handleAddKey = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const raw = newKeyInput.trim();
    if (!raw) return;

    const keysToProcess = raw
      .split(/[\n,;]+/)
      .map((k) =>
        k
          .trim()
          .replace(/^(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|API_KEY)\s*=\s*/i, '')
          .replace(/^Bearer\s+/i, '')
          .replace(/^['"`]+|['"`]+$/g, '')
          .trim()
      )
      .filter((k) => k.length >= 10);

    if (keysToProcess.length === 0) {
      setBannerMessage({
        type: 'error',
        text: 'Please enter a valid Gemini API key (e.g. AQ...., AIzaSy...).',
      });
      return;
    }

    let addedCount = 0;
    for (const key of keysToProcess) {
      if (addUserApiKey(key)) {
        addedCount++;
      }
    }

    setNewKeyInput('');
    refreshState();
    setBannerMessage({
      type: 'success',
      text:
        addedCount === 1
          ? 'API Key added! Custom keys are prioritized first with LRU + 60s RPM rotation.'
          : `${addedCount} API Keys added! LRU rotation & automatic failover will run across your keys.`,
    });
  };

  const handleRemoveKey = (key: string) => {
    removeUserApiKey(key);
    refreshState();
    setBannerMessage({ type: 'info', text: 'API Key removed.' });
  };

  const handleClearAll = () => {
    if (window.confirm('Are you sure you want to remove all your custom API keys?')) {
      clearUserApiKeys();
      refreshState();
      setKeyValidationStatus({});
      setBannerMessage({ type: 'info', text: 'All custom keys cleared.' });
    }
  };

  const handleUnlockSecretKey = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const res = unlockBuiltinKeys(secretKeyInput);
    if (res.success) {
      setIsUnlocked(true);
      setSecretKeyInput('');
      refreshState();
      setBannerMessage({ type: 'success', text: res.message });
    } else {
      setBannerMessage({ type: 'error', text: res.message });
    }
  };

  const handleLockSecretKey = () => {
    lockBuiltinKeys();
    setIsUnlocked(false);
    refreshState();
    setBannerMessage({ type: 'info', text: 'Built-in 9-key pool deactivated.' });
  };

  const handleTestKey = async (key: string) => {
    setTestingKey(key);
    try {
      const res = await testApiKeyValidity(key);
      setKeyValidationStatus((prev) => ({
        ...prev,
        [key]: { valid: res.valid, message: res.valid ? 'Active & Valid' : res.error || 'Invalid key' },
      }));
    } finally {
      setTestingKey(null);
    }
  };

  const handleRunFailoverTest = async () => {
    setIsTestingFailover(true);
    setFailoverTestResult('Initiating key priority & failover test...');
    try {
      const startTime = Date.now();
      const { candidateKeys, isCustom } = getCandidateKeysForOperation();
      if (!candidateKeys || candidateKeys.length === 0) {
        setFailoverTestResult(
          'No API keys configured. Add a free Gemini API key or unlock the 9-key pool.'
        );
        return;
      }
      const firstKeyToTry = candidateKeys[0];
      const res = await testApiKeyValidity(firstKeyToTry);
      const elapsed = Date.now() - startTime;

      if (res.valid) {
        setFailoverTestResult(
          isCustom
            ? `Success! Custom key ${maskApiKey(firstKeyToTry)} verified in ${elapsed}ms. Active model: ${getModelDisplayLabel(selectedModel || 'gemini-4-hydrogen')}.`
            : `Success! Built-in key ${maskApiKey(firstKeyToTry)} verified in ${elapsed}ms. Pool has ${defaultKeysCount} keys.`
        );
      } else {
        setFailoverTestResult(`Key ${maskApiKey(firstKeyToTry)} responded: ${res.error}.`);
      }
    } catch (e: any) {
      setFailoverTestResult(`Test encountered: ${e?.message || 'Error'}`);
    } finally {
      setIsTestingFailover(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-100"
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-keys-modal-title"
      >
        {/* Header */}
        <div className="px-5 sm:px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-800/40">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 shrink-0">
              <Key className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 id="api-keys-modal-title" className="text-base sm:text-lg font-bold text-slate-900 dark:text-white truncate">
                Gemini API Keys &amp; Backup Routing
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                Free Gemini API keys, automatic key rotation, and calm backup model switching
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-5 flex-1">
          {bannerMessage && (
            <div
              className={`p-3.5 rounded-xl text-xs sm:text-sm font-medium flex items-start gap-2.5 ${
                bannerMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : bannerMessage.type === 'error'
                  ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                  : 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
              }`}
            >
              {bannerMessage.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
              {bannerMessage.type === 'error' && <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              {bannerMessage.type === 'info' && <Shield className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>{bannerMessage.text}</span>
            </div>
          )}

          {/* Active Route Summary Pill */}
          <div
            className={`p-4 rounded-xl border transition-all ${
              isUsingCustomKeys
                ? 'bg-gradient-to-br from-emerald-500/5 to-teal-500/10 border-emerald-500/30 dark:border-emerald-500/20'
                : isUnlocked
                ? 'bg-gradient-to-br from-purple-500/5 to-indigo-500/10 border-purple-500/30 dark:border-purple-500/20'
                : 'bg-gradient-to-br from-amber-500/5 to-orange-500/10 border-amber-500/30 dark:border-amber-500/20'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2.5 h-2.5 rounded-full animate-pulse ${
                    isUsingCustomKeys
                      ? 'bg-emerald-500'
                      : isUnlocked
                      ? 'bg-purple-500'
                      : 'bg-amber-500'
                  }`}
                />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Active Connection
                </span>
              </div>
              <span
                className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                  isUsingCustomKeys
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300'
                    : isUnlocked
                    ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300'
                }`}
              >
                {isUsingCustomKeys && isUnlocked
                  ? `Custom (${userKeys.length}) + 9 Backup Keys`
                  : isUsingCustomKeys
                  ? `Custom Free Keys Active (${userKeys.length})`
                  : isUnlocked
                  ? 'Built-In Pool Active (9 Keys)'
                  : 'No API Key Configured'}
              </span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              {isUsingCustomKeys ? (
                <>
                  Your custom keys are prioritized <strong>strictly first</strong> using LRU + 60s request pacing
                  {isUnlocked ? ' with the 9 built-in keys available automatically as backup.' : '.'}
                </>
              ) : isUnlocked ? (
                <>
                  The 9 built-in rotating keys are active with automatic busy-model backup switching and 60s request pacing.
                </>
              ) : (
                <>
                  Add your free Gemini API key or unlock the 9-key pool to start dictating.
                </>
              )}
            </p>
          </div>

          <div className="space-y-5">
            {/* Temporary Busy Model Pauses Panel */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/70 dark:bg-slate-800/40 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-500" />
                  <span className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100">
                    Temporary Busy Model Pauses
                  </span>
                </div>
                {overloadedModels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      clearAllModelUnavailableCooldowns();
                      setOverloadedModels([]);
                      setBannerMessage({
                        type: 'info',
                        text: 'All temporary model pauses cleared. Primary models will be retried immediately.',
                      });
                    }}
                    className="px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-100 hover:bg-amber-200 text-amber-900 dark:bg-amber-900/50 dark:hover:bg-amber-800/70 dark:text-amber-200 transition-colors cursor-pointer"
                  >
                    Clear All Pauses
                  </button>
                )}
              </div>
              {overloadedModels.length === 0 ? (
                <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  All models ready — no active pauses (busy models pause briefly on their own to protect your daily quota).
                </p>
              ) : (
                <div className="space-y-2">
                  {overloadedModels.map((item) => (
                    <div
                      key={item.model}
                      className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-800/70 flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 flex flex-wrap items-center gap-2">
                        <span className="font-bold text-slate-800 dark:text-slate-100">
                          {getModelDisplayLabel(item.model)}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200 font-semibold text-[11px]">
                          Busy right now • paused {formatRemainingMs(item.remainingMs)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          clearModelTemporarilyUnavailable(item.model);
                          setOverloadedModels(getOverloadedModelStates());
                        }}
                        className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer"
                      >
                        Try Again
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* >= 2 Keys Top-Tier Retry Option */}
            {totalActiveKeys >= 2 && (
              <div className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-800/70 bg-indigo-50/40 dark:bg-indigo-950/20 flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="modal-retry-top-tier-toggle"
                    className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white block cursor-pointer"
                  >
                    Try All Keys on Top Models When Busy (Uses Extra Quota)
                  </label>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                    You have <strong>{totalActiveKeys} active keys</strong>. If you only dictate a few cases a day, turning this on keeps trying{' '}
                    <strong>Gemini 4 Hydrogen</strong> and <strong>Gemini 3.8 Flash</strong> across all {totalActiveKeys} keys when Google is busy before switching to a backup model, even though it uses extra daily quota.
                  </p>
                </div>
                <button
                  id="modal-retry-top-tier-toggle"
                  type="button"
                  onClick={() => {
                    const next = !retryTopTierAllKeys;
                    setRetryTopTierAllKeysOn503Enabled(next);
                    setRetryTopTierAllKeys(next);
                  }}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer mt-0.5 ${
                    retryTopTierAllKeys ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-600'
                  }`}
                  role="switch"
                  aria-checked={retryTopTierAllKeys}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                      retryTopTierAllKeys ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            )}

              {/* Add Custom API Key Form */}
              <div className="space-y-2.5">
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Add Custom Gemini API Key(s)
                </label>
                <div className="relative">
                  <input
                    type={showKeyInput ? 'text' : 'password'}
                    value={newKeyInput}
                    onChange={(e) => setNewKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddKey();
                      }
                    }}
                    placeholder="Paste any Gemini API key (AQ...., AIzaSy..., or comma/newline separated)"
                    className="w-full px-3.5 py-2.5 pr-28 text-xs sm:text-sm bg-slate-50 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900 dark:text-slate-100 placeholder-slate-400 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKeyInput(!showKeyInput)}
                    className="absolute right-16 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
                    title={showKeyInput ? 'Hide Key' : 'Show Key'}
                  >
                    {showKeyInput ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAddKey()}
                    disabled={!newKeyInput.trim()}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:pointer-events-none rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Accepts any format (<code className="font-mono">AQ....</code>, <code className="font-mono">AIzaSy...</code>). Keys stay in browser <code className="font-mono">localStorage</code> (and your Google Drive if connected).
                </p>
              </div>

              {/* Configured Custom Keys List */}
              {userKeys.length > 0 && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Your Configured Keys ({userKeys.length})
                    </span>
                    <button
                      type="button"
                      onClick={handleClearAll}
                      className="text-xs text-rose-500 hover:text-rose-600 dark:hover:text-rose-400 font-medium cursor-pointer"
                    >
                      Clear all custom keys
                    </button>
                  </div>
                  <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                    {userKeys.map((key, index) => {
                      const status = keyValidationStatus[key];
                      const isCurrentTesting = testingKey === key;
                      return (
                        <div
                          key={`${key}-${index}`}
                          className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60 flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Key className="w-4 h-4 text-emerald-500 shrink-0" />
                            <span className="font-mono font-medium truncate text-slate-700 dark:text-slate-200">
                              {maskApiKey(key)}
                            </span>
                            {status && (
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                  status.valid
                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                                    : 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                                }`}
                              >
                                {status.valid ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                                {status.message}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleTestKey(key)}
                              disabled={isCurrentTesting}
                              className="px-2 py-1 rounded-lg text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1 cursor-pointer"
                            >
                              <RefreshCw className={`w-3 h-3 ${isCurrentTesting ? 'animate-spin' : ''}`} />
                              Test
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveKey(key)}
                              className="p-1 rounded-lg text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 transition-colors cursor-pointer"
                              title="Remove key"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Administrative Secret Key (1198 9-Key Backup Pool) */}
              <div className="p-4 rounded-xl border border-purple-200 dark:border-purple-800/70 bg-purple-50/40 dark:bg-purple-950/20 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    <span className="text-xs sm:text-sm font-bold text-purple-900 dark:text-purple-200">
                      Built-In 9-Key Backup Pool (Secret Code)
                    </span>
                  </div>
                  {isUnlocked && (
                    <span className="text-[10px] sm:text-xs font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-300">
                      ✓ 9 Keys Active
                    </span>
                  )}
                </div>

                {isUnlocked ? (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-purple-800 dark:text-purple-300">
                    <p>
                      9 built-in rotating keys are unlocked ({isUsingCustomKeys ? 'active as automatic backup after your custom keys' : 'active as primary pool'}).
                    </p>
                    <button
                      type="button"
                      onClick={handleLockSecretKey}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-purple-200 dark:bg-purple-900/60 text-purple-900 dark:text-purple-200 hover:bg-purple-300 transition-colors shrink-0 cursor-pointer self-start sm:self-auto"
                    >
                      Lock / Deactivate
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={secretKeyInput}
                      onChange={(e) => setSecretKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleUnlockSecretKey();
                        }
                      }}
                      placeholder="Enter administrative passcode..."
                      className="flex-1 px-3 py-2 text-xs sm:text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => handleUnlockSecretKey()}
                      disabled={!secretKeyInput.trim()}
                      className="px-4 py-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded-xl transition-colors cursor-pointer shrink-0"
                    >
                      Unlock 9 Keys
                    </button>
                  </div>
                )}
              </div>

              {/* Failover Engine Verification */}
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-500" />
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                      Failover Engine Test
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleRunFailoverTest}
                    disabled={isTestingFailover}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${isTestingFailover ? 'animate-spin' : ''}`} />
                    Test Engine
                  </button>
                </div>
                {failoverTestResult && (
                  <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-700 dark:text-slate-300">
                    {failoverTestResult}
                  </div>
                )}
              </div>

              {/* Collapsible 1-Minute Free Key Guide */}
              <div className="p-3.5 rounded-xl border border-blue-200 dark:border-blue-800/80 bg-blue-50/50 dark:bg-blue-950/20 space-y-2.5">
                <button
                  type="button"
                  onClick={() => setShowGuide((g) => !g)}
                  className="w-full flex items-center justify-between text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-xs sm:text-sm font-bold text-blue-900 dark:text-blue-200">
                      1-Minute Guide: How to Get a Free Gemini API Key
                    </span>
                  </div>
                  {showGuide ? <ChevronUp className="w-4 h-4 text-blue-600" /> : <ChevronDown className="w-4 h-4 text-blue-600" />}
                </button>
                {showGuide && (
                  <ol className="space-y-2 text-xs text-slate-700 dark:text-slate-300 pt-1 list-decimal list-inside">
                    <li>
                      Open{' '}
                      <a
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-bold text-blue-600 dark:text-blue-400 underline"
                      >
                        aistudio.google.com/app/apikey <ExternalLink className="w-3 h-3" />
                      </a>{' '}
                      and sign in with Gmail.
                    </li>
                    <li>
                      Click <strong>Create project</strong> first (required before Create API key appears).
                    </li>
                    <li>
                      Click <strong>Create API key</strong> inside that project, copy it, and paste above.
                    </li>
                  </ol>
                )}
              </div>
          </div>

          {/* Privacy Note */}
          <div className="p-3 rounded-xl bg-slate-100/70 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/60 flex items-start gap-2.5 text-xs text-slate-500 dark:text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-700 dark:text-slate-300">Privacy &amp; Clinical Note:</span> Custom keys remain in browser <code className="font-mono text-[11px]">localStorage</code> (and your personal Google Drive if connected) and are sent directly to Google Gemini.
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 sm:px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 text-xs sm:text-sm font-semibold rounded-xl bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer shadow-sm"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
