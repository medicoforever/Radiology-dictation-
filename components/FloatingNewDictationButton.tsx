import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Mic } from 'lucide-react';
import { AppStatus } from '../types';

interface FloatingNewDictationButtonProps {
  status: AppStatus;
  mode: 'single' | 'batch' | 'live';
  onResetSingleMode: () => void;
  onNewBatchDictation?: () => void;
}

/**
 * Universal Mobile-Hardened Floating "+ New Dictation" Button.
 * 
 * Specifically optimized for Android mobile browsers (Chrome, Samsung Internet, Firefox Mobile)
 * as well as iOS and desktop:
 * 1. Portaled directly to document.body so it is completely immune to ancestor CSS transforms,
 *    transitions, or overflow containers.
 * 2. Uses visualViewport and scroll offset tracking so it always stays anchored in the user's
 *    working area (visible screen) even when the user scrolls laterally!
 * 3. Incorporates env(safe-area-inset-bottom) to guarantee it is NEVER obscured by the Android
 *    gesture bar, software navigation buttons, or mobile browser toolbars.
 * 4. touch-action: manipulation eliminates the 300ms mobile touch delay for instantaneous taps.
 * 5. Remains pinned in the exact same bottom-right spot wherever the user scrolls.
 */
export const FloatingNewDictationButton: React.FC<FloatingNewDictationButtonProps> = ({
  status,
  mode,
  onResetSingleMode,
  onNewBatchDictation,
}) => {
  const [mounted, setMounted] = useState(false);
  const [rightPx, setRightPx] = useState<number>(16);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Listen for global Alt+N / Option+N keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        const target = e.target as HTMLElement | null;
        if (target) {
          const tagName = target.tagName?.toUpperCase();
          if (tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable) {
            return;
          }
        }
        e.preventDefault();
        handleClick();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [status, mode]);

  // Keep floating button anchored in the visible screen (visual viewport) during lateral scrolling
  const updatePosition = useCallback(() => {
    if (typeof window === 'undefined') return;

    try {
      const docWidth = Math.max(
        document.documentElement.clientWidth || 0,
        document.documentElement.scrollWidth || 0,
        document.body.scrollWidth || 0,
        window.innerWidth || 0
      );

      const scrollLeft = window.visualViewport
        ? window.visualViewport.offsetLeft
        : (window.pageXOffset || document.documentElement.scrollLeft || document.body.scrollLeft || 0);

      const visibleWidth = window.visualViewport
        ? window.visualViewport.width
        : window.innerWidth;

      const diff = docWidth - (scrollLeft + visibleWidth);
      const computedRight = Math.max(16, Math.round(diff + 16));
      setRightPx(computedRight);
    } catch (_) {
      setRightPx(16);
    }
  }, []);

  useEffect(() => {
    updatePosition();

    if (window.visualViewport) {
      window.visualViewport.addEventListener('scroll', updatePosition, { passive: true });
      window.visualViewport.addEventListener('resize', updatePosition, { passive: true });
    }
    window.addEventListener('scroll', updatePosition, { passive: true });
    window.addEventListener('resize', updatePosition, { passive: true });

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('scroll', updatePosition);
        window.visualViewport.removeEventListener('resize', updatePosition);
      }
      window.removeEventListener('scroll', updatePosition);
      window.removeEventListener('resize', updatePosition);
    };
  }, [updatePosition]);

  // Don't show while actively recording audio or waiting for AI processing
  if (status === AppStatus.Processing || status === AppStatus.Recording || mode === 'live') {
    return null;
  }

  // Must be mounted in browser DOM
  if (!mounted || typeof document === 'undefined') {
    return null;
  }

  const handleClick = () => {
    // 1. In Single Mode viewing report findings: reset and start a fresh dictation
    if (status === AppStatus.Success && mode === 'single') {
      onResetSingleMode();
      return;
    }

    // 2. In Batch Mode: add a new batch case
    if (mode === 'batch') {
      if (onNewBatchDictation) {
        onNewBatchDictation();
      } else {
        window.dispatchEvent(new CustomEvent('app-trigger-new-batch-dictation'));
      }
      return;
    }

    // 3. In Idle state on main screen: scroll smoothly to the recorder and trigger mic
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => {
      const micBtn = document.getElementById('main-mic-record-btn');
      if (micBtn) {
        micBtn.focus();
        micBtn.click();
      }
    }, 250);
  };

  const label = mode === 'batch' ? '+ New Batch Dictation' : '+ New Dictation';

  const buttonContent = (
    <div
      id="floating-new-dictation-portal-container"
      className="fixed print:hidden"
      style={{
        position: 'fixed',
        bottom: 'max(1.25rem, calc(1rem + env(safe-area-inset-bottom, 0px)))',
        right: `${rightPx}px`,
        maxWidth: 'calc(100vw - 2rem)',
        zIndex: 9999,
        WebkitTransform: 'translate3d(0, 0, 0)',
        transform: 'translate3d(0, 0, 0)',
        willChange: 'transform, right',
        pointerEvents: 'auto',
      }}
    >
      <button
        type="button"
        onClick={handleClick}
        id="floating-new-dictation-btn"
        className="group flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 active:from-blue-800 active:to-indigo-800 text-white font-bold py-3 px-4 sm:py-2.5 sm:px-4 rounded-full shadow-[0_8px_25px_rgba(37,99,235,0.45)] hover:shadow-[0_12px_30px_rgba(37,99,235,0.6)] active:scale-95 transition-all duration-200 border-2 border-white/30 dark:border-blue-400/30 cursor-pointer text-xs sm:text-sm select-none"
        style={{
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
        }}
        title="Start New Dictation (Alt+N)"
        aria-label="Start New Dictation"
      >
        <div className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
          <Mic className="w-3.5 h-3.5 text-white" />
        </div>
        <span className="whitespace-nowrap font-bold tracking-wide">{label}</span>
        <span className="hidden md:inline-block text-[10px] bg-blue-900/60 text-blue-100 font-mono px-1.5 py-0.5 rounded-full border border-blue-400/30">
          Alt+N
        </span>
      </button>
    </div>
  );

  return createPortal(buttonContent, document.body);
};

export default FloatingNewDictationButton;
