import React, { useState } from 'react';
import { ShieldCheck, Scale, Lock, Copy, Check, X, ExternalLink, Award, FileCode } from 'lucide-react';

interface OwnershipModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CANONICAL_APPLET_ID = '3f0807e3-2494-4289-a3a6-c12032da731c';
export const CANONICAL_AUTHOR_EMAIL = 'medicoforever002@gmail.com';
export const CANONICAL_FINGERPRINT = 'RADDOC-SHA256:3f0807e3-2494-4289-a3a6-c12032da731c:medicoforever002@gmail.com:ORIGIN';

export const OwnershipModal: React.FC<OwnershipModalProps> = ({ isOpen, onClose }) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopyFingerprint = async () => {
    try {
      const textToCopy = `APP: ☯️ RADDOC™ - Medical AI Dictation Suite
AUTHOR: ${CANONICAL_AUTHOR_EMAIL}
APPLET_ID: ${CANONICAL_APPLET_ID}
PROVENANCE_FINGERPRINT: ${CANONICAL_FINGERPRINT}
COPYRIGHT: © 2024–2026 RADDOC™. All Rights Reserved.
TERMS: Proprietary Medical Software & Architecture. Uncredited commercial copying, white-labeling, or resale is strictly prohibited.`;
      
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ownership-modal-title"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-2xl w-full shadow-2xl overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-200">
        {/* Header with decorative badge */}
        <div className="bg-gradient-to-r from-blue-700 via-indigo-700 to-slate-900 text-white p-5 sm:p-6 relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 text-slate-300 hover:text-white hover:bg-white/10 rounded-full transition-colors cursor-pointer"
            aria-label="Close ownership dialog"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center text-amber-300 shrink-0 shadow-inner">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-400/20 text-amber-300 border border-amber-400/30 mb-1">
                <Award className="w-3 h-3" />
                Verified Provenance &amp; Copyright
              </div>
              <h2 id="ownership-modal-title" className="text-xl sm:text-2xl font-black text-white tracking-tight flex items-center gap-2">
                <span>☯️ RADDOC™</span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-blue-500/30 text-blue-200 border border-blue-400/30">Official Build</span>
              </h2>
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 space-y-5 max-h-[75vh] overflow-y-auto text-slate-700 dark:text-slate-300 text-xs sm:text-sm leading-relaxed">
          {/* Ownership Certificate Card */}
          <div className="bg-slate-50 dark:bg-slate-800/80 rounded-2xl p-4 border border-slate-200 dark:border-slate-700/80 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Scale className="w-3.5 h-3.5 text-blue-500" />
                Certificate of Authorship &amp; Origin
              </span>
              <span className="text-[11px] font-mono font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-800">
                Lineage-Protected
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-2.5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200/80 dark:border-slate-700/60">
                <p className="text-slate-400 dark:text-slate-500 font-medium">Original Author &amp; Creator:</p>
                <p className="font-bold text-slate-900 dark:text-slate-100 font-mono text-[11px] sm:text-xs truncate select-all">
                  {CANONICAL_AUTHOR_EMAIL}
                </p>
              </div>

              <div className="p-2.5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200/80 dark:border-slate-700/60">
                <p className="text-slate-400 dark:text-slate-500 font-medium">Canonical Applet ID:</p>
                <p className="font-bold text-blue-600 dark:text-blue-400 font-mono text-[11px] truncate select-all">
                  {CANONICAL_APPLET_ID}
                </p>
              </div>
            </div>

            {/* Cryptographic Provenance Fingerprint */}
            <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200/80 dark:border-slate-700/60 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1">
                  <FileCode className="w-3.5 h-3.5 text-indigo-500" />
                  Canonical Digital Provenance Fingerprint:
                </span>
                <button
                  onClick={handleCopyFingerprint}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Proof</span>
                    </>
                  )}
                </button>
              </div>
              <p className="font-mono text-[11px] text-slate-600 dark:text-slate-300 break-all select-all bg-slate-50 dark:bg-slate-800/60 p-2 rounded-lg border border-slate-200/60 dark:border-slate-700/40">
                {CANONICAL_FINGERPRINT}
              </p>
            </div>
          </div>

          {/* Legal Rights & Enforcement Clauses */}
          <div className="space-y-3">
            <h4 className="font-bold text-slate-900 dark:text-slate-100 text-xs sm:text-sm flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-amber-500" />
              Proprietary Rights &amp; Anti-Remix Protection Terms:
            </h4>

            <div className="space-y-2.5 text-xs text-slate-600 dark:text-slate-300">
              <div className="p-3 bg-blue-50/50 dark:bg-blue-950/20 border-l-4 border-blue-600 dark:border-blue-400 rounded-r-xl">
                <p className="font-semibold text-blue-900 dark:text-blue-200 mb-0.5">
                  1. Automatic Platform Lineage Tracking (AI Studio Remixes)
                </p>
                <p>
                  Any project remixed from this workspace permanently retains Google AI Studio parent-child lineage metadata linking back to original Applet ID <code className="font-mono bg-blue-100 dark:bg-blue-900/50 px-1 py-0.5 rounded text-[11px]">{CANONICAL_APPLET_ID}</code>. Google Cloud audit stamps establish immutable legal proof of original creation date and priority.
                </p>
              </div>

              <div className="p-3 bg-amber-50/50 dark:bg-amber-950/20 border-l-4 border-amber-600 dark:border-amber-400 rounded-r-xl">
                <p className="font-semibold text-blue-900 dark:text-blue-200 mb-0.5">
                  2. Strict Commercial &amp; Resale Prohibition
                </p>
                <p>
                  Free access is granted solely for personal, non-commercial clinical dictation use by medical practitioners. Commercial re-distribution, sublicensing, white-labeling, paid wrapping, or re-selling this application or its internal assets without express written authorization is strictly prohibited under international copyright laws (Berne Convention &amp; DMCA).
                </p>
              </div>

              <div className="p-3 bg-purple-50/50 dark:bg-purple-950/20 border-l-4 border-purple-600 dark:border-purple-400 rounded-r-xl">
                <p className="font-semibold text-purple-900 dark:text-purple-200 mb-0.5">
                  3. Digital Provenance &amp; Forensic Fingerprinting
                </p>
                <p>
                  The prompt engineering architecture, audio processing engine, and workstation synchronization protocols contain unique digital provenance signatures. Uncredited reproduction or extraction creates undeniable forensic evidence of copying.
                </p>
              </div>
            </div>
          </div>

          {/* Legal Notice & Contact */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div>
              <p className="font-bold text-slate-800 dark:text-slate-200">
                Inquiries, Licensing &amp; Infringement Reports:
              </p>
              <a 
                href={`mailto:${CANONICAL_AUTHOR_EMAIL}?subject=RADDOC%20Copyright%20%26%20Licensing%20Inquiry`}
                className="text-blue-600 dark:text-blue-400 hover:underline font-mono"
              >
                {CANONICAL_AUTHOR_EMAIL}
              </a>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyFingerprint}
                className="px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-semibold rounded-xl transition-colors cursor-pointer text-xs flex items-center gap-1.5"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{copied ? 'Proof Copied!' : 'Copy Ownership Proof'}</span>
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition-colors cursor-pointer text-xs shadow-sm shadow-blue-500/20"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
