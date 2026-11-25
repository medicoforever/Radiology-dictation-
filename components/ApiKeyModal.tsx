import React, { useState, useEffect } from 'react';
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
  Lock,
  Unlock,
} from 'lucide-react';
import {
  getUserApiKeys,
  addUserApiKey,
  removeUserApiKey,
  clearUserApiKeys,
  getDefaultApiKeys,
  getCandidateKeysForOperation,
  getFreeTierDailyQuotaStats,
  resetFreeTierDailyQuotaStats,
  maskApiKey,
  testApiKeyValidity,
  isBuiltinKeysUnlocked,
  unlockBuiltinKeys,
  lockBuiltinKeys,
  syncApiKeysWithGoogleDrive,
  API_KEYS_UPDATED_EVENT,
  type FreeTierModelQuotaStat,
} from '../services/apiKeyService';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedModel?: string;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ isOpen, onClose, selectedModel }) => {
  const [userKeys, setUserKeys] = useState<string[]>([]);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [keyValidationStatus, setKeyValidationStatus] = useState<Record<string, { valid: boolean; message?: string }>>({});
  const [bannerMessage, setBannerMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isTestingFailover, setIsTestingFailover] = useState(false);
  const [failoverTestResult, setFailoverTestResult] = useState<string | null>(null);
  const [secretKeyInput, setSecretKeyInput] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(isBuiltinKeysUnlocked());
  const [showGuide, setShowGuide] = useState(true);
  const [quotaStats, setQuotaStats] = useState<{ datePt: string; totalKeys: number; models: FreeTierModelQuotaStat[] }>(() =>
    getFreeTierDailyQuotaStats()
  );

  // Sync state from storage
  const refreshKeys = () => {
    setUserKeys(getUserApiKeys());
    setIsUnlocked(isBuiltinKeysUnlocked());
    setQuotaStats(getFreeTierDailyQuotaStats());
  };

  useEffect(() => {
    if (isOpen) {
      refreshKeys();
      setBannerMessage(null);
      setFailoverTestResult(null);
      setSecretKeyInput('');
      syncApiKeysWithGoogleDrive().then(() => refreshKeys()).catch(() => {});
    }

    const handleUpdate = () => refreshKeys();
    window.addEventListener(API_KEYS_UPDATED_EVENT, handleUpdate);
    return () => window.removeEventListener(API_KEYS_UPDATED_EVENT, handleUpdate);
  }, [isOpen]);

  if (!isOpen) return null;

  const defaultKeysCount = getDefaultApiKeys().length;
  const isUsingCustomKeys = userKeys.length > 0;

  const handleAddKey = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const raw = newKeyInput.trim();
    if (!raw) return;

    // Support comma or newline separated multi-key pasting, and normalize optional env prefixes/quotes
    const keysToProcess = raw
      .split(/[\n,;]+/)
      .map(k =>
        k
          .trim()
          .replace(/^(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|API_KEY)\s*=\s*/i, '')
          .replace(/^Bearer\s+/i, '')
          .replace(/^['"`]+|['"`]+$/g, '')
          .trim()
      )
      .filter(k => k.length >= 10);

    if (keysToProcess.length === 0) {
      setBannerMessage({
        type: 'error',
        text: 'Please enter a valid Gemini API key (any valid key format is accepted, such as AQ...., AIzaSy..., etc.)',
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
    refreshKeys();
    setBannerMessage({
      type: 'success',
      text: addedCount === 1
        ? 'API Key successfully added! It will now be used exclusively for your requests.'
        : `${addedCount} API Keys successfully added! Random rotation and failover will run across your keys.`,
    });
  };

  const handleRemoveKey = (key: string) => {
    removeUserApiKey(key);
    refreshKeys();
    setBannerMessage({
      type: 'info',
      text: 'API Key removed.',
    });
  };

  const handleClearAll = () => {
    if (window.confirm('Are you sure you want to remove all your custom API keys?')) {
      clearUserApiKeys();
      refreshKeys();
      setKeyValidationStatus({});
      setBannerMessage({
        type: 'info',
        text: 'All custom keys cleared.',
      });
    }
  };

  const handleUnlockSecretKey = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const res = unlockBuiltinKeys(secretKeyInput);
    if (res.success) {
      setIsUnlocked(true);
      setSecretKeyInput('');
      refreshKeys();
      setBannerMessage({ type: 'success', text: res.message });
    } else {
      setBannerMessage({ type: 'error', text: res.message });
    }
  };

  const handleLockSecretKey = () => {
    lockBuiltinKeys();
    setIsUnlocked(false);
    refreshKeys();
    setBannerMessage({ type: 'info', text: 'Built-in keys deactivated.' });
  };

  const handleTestKey = async (key: string) => {
    setTestingKey(key);
    try {
      const res = await testApiKeyValidity(key);
      setKeyValidationStatus(prev => ({
        ...prev,
        [key]: { valid: res.valid, message: res.valid ? 'Active & Valid' : (res.error || 'Invalid key') },
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
        setFailoverTestResult('No API keys currently configured. Add a Gemini API key or unlock with secret key.');
        return;
      }
      const firstKeyToTry = candidateKeys[0];
      const res = await testApiKeyValidity(firstKeyToTry);
      const elapsed = Date.now() - startTime;
      
      if (res.valid) {
        setFailoverTestResult(
          isCustom
            ? `Success! Custom key ${maskApiKey(firstKeyToTry)} verified in ${elapsed}ms. Active model: ${selectedModel || 'gemini-3.5-flash'}.`
            : `Success! Secret unlocked key ${maskApiKey(firstKeyToTry)} verified in ${elapsed}ms. Pool has ${defaultKeysCount} keys.`
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-100"
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-keys-modal-title"
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <h2 id="api-keys-modal-title" className="text-lg font-bold text-slate-900 dark:text-white">
                Gemini API Keys & Failover
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Random load-balancing with automatic zero-error failover
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Status Alert Banner */}
          {bannerMessage && (
            <div
              className={`p-3.5 rounded-xl text-xs sm:text-sm font-medium flex items-center gap-2.5 ${
                bannerMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : bannerMessage.type === 'error'
                  ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                  : 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
              }`}
            >
              {bannerMessage.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0" />}
              {bannerMessage.type === 'error' && <AlertCircle className="w-4 h-4 shrink-0" />}
              {bannerMessage.type === 'info' && <Shield className="w-4 h-4 shrink-0" />}
              <span>{bannerMessage.text}</span>
            </div>
          )}

          {/* Current Pool Status Card */}
          <div
            className={`p-4 rounded-xl border transition-all ${
              isUsingCustomKeys
                ? 'bg-gradient-to-br from-emerald-500/5 to-teal-500/10 border-emerald-500/30 dark:border-emerald-500/20'
                : isUnlocked
                ? 'bg-gradient-to-br from-purple-500/5 to-indigo-500/10 border-purple-500/30 dark:border-purple-500/20'
                : 'bg-gradient-to-br from-amber-500/5 to-orange-500/10 border-amber-500/30 dark:border-amber-500/20'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2.5 h-2.5 rounded-full animate-pulse ${
                    isUsingCustomKeys ? 'bg-emerald-500' : isUnlocked ? 'bg-purple-500' : 'bg-amber-500'
                  }`}
                />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Active Mode
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
                  ? `Custom (${userKeys.length}) → +9 Built-In Backup`
                  : isUsingCustomKeys
                  ? `Custom Keys Active (${userKeys.length})`
                  : isUnlocked
                  ? `Secret Mode Active (9 Built-In Keys)`
                  : `No API Key Configured`}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              {isUsingCustomKeys && isUnlocked ? (
                <>
                  <strong>Priority Failover Active:</strong> Your <strong>{userKeys.length} custom API key(s)</strong> are always tried first with smart load balancing; if they reach quota or rate limits, the app seamlessly fails over to the <strong>9 built-in keys</strong>. Both custom keys and secret mode are saved permanently in local storage and Google Drive (when signed in).
                </>
              ) : isUsingCustomKeys ? (
                <>
                  The app is using <strong>your custom API key(s)</strong>, permanently saved in local storage and Google Drive (when signed in). Requests rotate cleanly across healthy keys and fail over automatically on quota limits.
                </>
              ) : isUnlocked ? (
                <>
                  Administrative Secret Mode is active! The app is <strong>load-balancing across all 9 built-in rotating keys</strong> on every request with automatic failover and zero interruptions.
                </>
              ) : (
                <>
                  By default, <strong>no API key is active</strong>. Please follow the quick 1-minute step-by-step guide below to add your free Gemini API key, or enter a secret key if you have one.
                </>
              )}
            </p>
          </div>

          {/* Step-by-Step AI Studio Visual Guide for Non-Tech Users */}
          <div className="p-4 rounded-xl border border-blue-200 dark:border-blue-800/80 bg-blue-50/50 dark:bg-blue-950/20 space-y-3">
            <div className="flex items-center justify-between cursor-pointer" onClick={() => setShowGuide(!showGuide)}>
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span className="text-xs sm:text-sm font-bold text-blue-900 dark:text-blue-200">
                  📘 Step-by-Step Guide: How to Get Your FREE Gemini API Key (1 Minute)
                </span>
              </div>
              <button type="button" className="text-blue-600 dark:text-blue-400">
                {showGuide ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>

            {showGuide && (
              <div className="space-y-3 text-xs text-slate-700 dark:text-slate-300 pt-1">
                <p className="font-medium text-slate-600 dark:text-slate-300 leading-relaxed">
                  Google provides a generous <strong>100% free tier</strong> for Gemini with <strong>no credit card required</strong>. Follow these 4 simple steps in order:
                </p>

                {/* Visual Quick-Flow Pills */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
                  <span className="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300">
                    1. Open AI Studio
                  </span>
                  <span className="text-slate-400">→</span>
                  <span className="px-2 py-1 rounded-lg bg-indigo-600 text-white shadow-2xs">
                    2. Create Project FIRST
                  </span>
                  <span className="text-slate-400">→</span>
                  <span className="px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300">
                    3. Create API Key
                  </span>
                  <span className="text-slate-400">→</span>
                  <span className="px-2 py-1 rounded-lg bg-emerald-600 text-white shadow-2xs">
                    4. Copy &amp; Paste Below
                  </span>
                </div>

                <ol className="space-y-2.5 leading-relaxed">
                  <li className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-700/70">
                    <span className="font-bold text-slate-900 dark:text-white">1. Open Google AI Studio &amp; Sign In:</span> Click{' '}
                    <a
                      href="https://aistudio.google.com/app/apikey"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-bold text-blue-600 dark:text-blue-400 underline hover:text-blue-700"
                    >
                      aistudio.google.com/app/apikey <ExternalLink className="w-3 h-3" />
                    </a>{' '}
                    and sign in with any normal Google / Gmail account.
                  </li>

                  <li className="p-2.5 rounded-lg bg-indigo-50/90 dark:bg-indigo-950/40 border border-indigo-300 dark:border-indigo-700/80">
                    <span className="font-bold text-indigo-950 dark:text-indigo-200">2. Create a Project FIRST (Required):</span> Inside Google AI Studio, click <strong>&quot;Create project&quot;</strong> (or <strong>&quot;+ Create a new project&quot;</strong> / import an existing Google Cloud project), enter any simple name (e.g. <code className="bg-white/80 dark:bg-slate-800 px-1 py-0.5 rounded font-mono">My Dictation</code>), and save it.
                    <span className="block mt-1 text-[11px] font-semibold text-indigo-800 dark:text-indigo-300">
                      ⚠️ Important: The &quot;Create API key&quot; option only becomes available AFTER you create or select a project there!
                    </span>
                  </li>

                  <li className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-700/70">
                    <span className="font-bold text-slate-900 dark:text-white">3. Create Your API Key Inside That Project:</span> Once your project is created and selected, click the <strong>&quot;Create API key&quot;</strong> button, select your new project, and generate your key.
                  </li>

                  <li className="p-2.5 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/70">
                    <span className="font-bold text-emerald-950 dark:text-emerald-200">4. Copy &amp; Paste Any Key Format Below:</span> Click the copy icon next to your newly created key and paste it into the <strong>&quot;Add Custom API Key(s)&quot;</strong> field below, then click <strong>Add</strong>.
                    <span className="block mt-1 text-[11px] text-emerald-800 dark:text-emerald-300">
                      ✓ <strong>All Gemini key formats work:</strong> Google API keys may start with <code className="bg-white/90 dark:bg-slate-800 px-1 py-0.5 rounded font-mono font-bold">AQ.</code> (e.g. <code className="bg-white/90 dark:bg-slate-800 px-1 py-0.5 rounded font-mono">AQ.Ab8...</code>), <code className="bg-white/90 dark:bg-slate-800 px-1 py-0.5 rounded font-mono font-bold">AIzaSy...</code>, or any other prefix — every valid Gemini API key works here!
                    </span>
                  </li>
                </ol>

                <div className="mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-amber-900 dark:text-amber-200">
                  <p className="font-bold flex items-center gap-1.5 text-xs">
                    <span>💡</span> Free-Tier Multi-Account Pooling (For You &amp; Friends):
                  </p>
                  <p className="mt-1 leading-relaxed text-[11px] sm:text-xs text-amber-800 dark:text-amber-300">
                    Each free Google Cloud project gives <strong>20 RPD</strong> on Gemini 4 Hydrogen, 3.8 Flash, 3.6 Flash, 3 Flash, and Robotics ER-2 Preview (<strong>100</strong> frontier reports/day) plus <strong>500 RPD</strong> on Gemini 3.5 Flash Lite. Keys from <strong>different Google accounts / separate projects</strong> have completely independent quotas—the app spreads load across healthy keys and fails over automatically with zero rate-limit penalty. Avoid creating multiple keys under the same Google Cloud project, as those share one quota.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Administrative Secret Key Section */}
          <div className="p-4 rounded-xl border border-purple-200 dark:border-purple-800/70 bg-purple-50/40 dark:bg-purple-950/20 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                <span className="text-xs sm:text-sm font-bold text-purple-900 dark:text-purple-200">
                  Administrative Secret Key (Unlock 9 Built-In Keys)
                </span>
              </div>
              {isUnlocked && (
                <span className="text-[10px] sm:text-xs font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-300">
                  ✓ 9 Keys Unlocked
                </span>
              )}
            </div>

            {isUnlocked ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs text-purple-800 dark:text-purple-300">
                <p>
                  The 9 built-in rotating API keys are currently <strong>unlocked and active</strong> on this device.
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
              <div className="space-y-2">
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  If you have an administrative secret key, enter it below to activate the built-in pool of 9 rotating API keys:
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={secretKeyInput}
                    onChange={e => setSecretKeyInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleUnlockSecretKey();
                      }
                    }}
                    placeholder="Enter secret key..."
                    className="flex-1 px-3 py-2 text-xs sm:text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => handleUnlockSecretKey()}
                    disabled={!secretKeyInput.trim()}
                    className="px-4 py-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded-xl transition-colors cursor-pointer shrink-0"
                  >
                    Unlock Keys
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Add Key Input Form */}
          <div className="space-y-3">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Add Custom API Key(s)
            </label>
            <div className="relative">
              <input
                type={showKeyInput ? 'text' : 'password'}
                value={newKeyInput}
                onChange={e => setNewKeyInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddKey();
                  }
                }}
                placeholder="Paste any Gemini API key (e.g. AQ...., AIzaSy..., or comma-separated keys)"
                className="w-full px-3.5 py-2.5 pr-20 text-xs sm:text-sm bg-slate-50 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900 dark:text-slate-100 placeholder-slate-400 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKeyInput(!showKeyInput)}
                className="absolute right-12 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
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
              💡 Accepts any Gemini key format (<code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 rounded">AQ....</code>, <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 rounded">AIzaSy...</code>, etc.). Paste one key or multiple separated by newlines or commas.
            </p>
          </div>

          {/* User Stored Keys List */}
          {userKeys.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Your Configured Keys ({userKeys.length})
                </span>
                <button
                  onClick={handleClearAll}
                  className="text-xs text-rose-500 hover:text-rose-600 dark:hover:text-rose-400 font-medium cursor-pointer"
                >
                  Clear all custom keys
                </button>
              </div>

              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {userKeys.map((key, index) => {
                  const status = keyValidationStatus[key];
                  const isCurrentTesting = testingKey === key;

                  return (
                    <div
                      key={`${key}-${index}`}
                      className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60 flex items-center justify-between gap-3 text-xs"
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
                          onClick={() => handleTestKey(key)}
                          disabled={isCurrentTesting}
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1 cursor-pointer"
                          title="Verify API key connectivity"
                        >
                          <RefreshCw className={`w-3 h-3 ${isCurrentTesting ? 'animate-spin' : ''}`} />
                          Test
                        </button>
                        <button
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

          {/* Daily Free-Tier Model Quota Tracker */}
          {quotaStats.totalKeys > 0 && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block">
                    Estimated Daily Free-Tier Quotas ({quotaStats.datePt} PT)
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Across {quotaStats.totalKeys} active key pool{quotaStats.totalKeys > 1 ? 's' : ''} • Resets midnight Pacific Time • Flash Lite excluded from auto-failover
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    resetFreeTierDailyQuotaStats();
                    refreshKeys();
                  }}
                  className="px-2 py-1 text-[11px] font-semibold rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 transition-colors shrink-0 cursor-pointer"
                  title="Clear local daily quota counters if AI Studio quotas already reset"
                >
                  Reset Stats
                </button>
              </div>
              <div className="space-y-1.5">
                {quotaStats.models.map((stat) => {
                  const isExhausted = stat.totalKeys > 0 && stat.exhaustedKeys >= stat.totalKeys;
                  const pct = stat.totalCapacity > 0 ? Math.min(100, Math.round((stat.usedToday / stat.totalCapacity) * 100)) : 0;
                  return (
                    <div key={stat.model} className="text-[11px] space-y-0.5">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-700 dark:text-slate-300">{stat.label}</span>
                        <span className={`font-mono font-semibold ${isExhausted ? 'text-rose-600 dark:text-rose-400' : 'text-slate-600 dark:text-slate-300'}`}>
                          {stat.usedToday} / {stat.totalCapacity} {isExhausted ? '• Daily Exhausted' : ''}
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all ${
                            isExhausted ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${isExhausted ? 100 : pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Failover Engine Verification Card */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-800 space-y-2">
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
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Verifies load balancing across active keys. Model selected: <span className="font-semibold text-blue-600 dark:text-blue-400">{selectedModel || 'gemini-4-hydrogen'}</span>.
            </p>
            {failoverTestResult && (
              <div className="mt-2 p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-700 dark:text-slate-300">
                {failoverTestResult}
              </div>
            )}
          </div>

          {/* Privacy & Security Guarantee */}
          <div className="p-3.5 rounded-xl bg-slate-100/70 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/60 flex items-start gap-2.5 text-xs text-slate-500 dark:text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-700 dark:text-slate-300">Privacy & Confidentiality:</span> Custom keys are stored exclusively in your browser's private <code className="font-mono text-[11px] bg-slate-200 dark:bg-slate-700 px-1 py-0.5 rounded">localStorage</code>. They are never sent to any server other than directly to Google's official Gemini API endpoints.
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex justify-end">
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
