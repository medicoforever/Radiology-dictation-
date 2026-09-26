import React, { useState, useRef, useEffect } from 'react';
import { 
  Sun, 
  Moon, 
  Palette, 
  Sparkles, 
  Brush, 
  Leaf, 
  Sunset, 
  Waves, 
  Check, 
  ChevronDown 
} from 'lucide-react';

export type AppTheme = 
  | 'light'
  | 'dark'
  | 'colourful'
  | 'magical'
  | 'creative'
  | 'soothing'
  | 'sunset'
  | 'ocean';

export interface ThemeOption {
  id: AppTheme;
  name: string;
  subtitle: string;
  badge: string;
  icon: React.ComponentType<{ className?: string }>;
  isDark: boolean;
  swatchGradient: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'light',
    name: 'White / Light',
    subtitle: 'Classic clean clinical mode',
    badge: 'Standard',
    icon: Sun,
    isDark: false,
    swatchGradient: 'linear-gradient(135deg, #ffffff 0%, #f1f5f9 50%, #e2e8f0 100%)'
  },
  {
    id: 'dark',
    name: 'Dark Mode',
    subtitle: 'Deep obsidian & low-light comfort',
    badge: 'Standard',
    icon: Moon,
    isDark: true,
    swatchGradient: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%)'
  },
  {
    id: 'colourful',
    name: 'Colourful',
    subtitle: 'Vibrant rainbow prism & cheerful vibes',
    badge: 'Vibrant',
    icon: Palette,
    isDark: false,
    swatchGradient: 'linear-gradient(135deg, #f43f5e 0%, #fbbf24 25%, #10b981 50%, #3b82f6 75%, #8b5cf6 100%)'
  },
  {
    id: 'magical',
    name: 'Magical',
    subtitle: 'Enchanted stardust & cosmic violet',
    badge: 'Enchanted',
    icon: Sparkles,
    isDark: true,
    swatchGradient: 'linear-gradient(135deg, #2e1065 0%, #7e22ce 40%, #db2777 75%, #6366f1 100%)'
  },
  {
    id: 'creative',
    name: 'Creative',
    subtitle: 'Warm terracotta, coral & art studio',
    badge: 'Artistic',
    icon: Brush,
    isDark: false,
    swatchGradient: 'linear-gradient(135deg, #ffedd5 0%, #f97316 40%, #e11d48 75%, #facc15 100%)'
  },
  {
    id: 'soothing',
    name: 'Soothing',
    subtitle: 'Zen eucalyptus, calming sage & mint',
    badge: 'Relaxing',
    icon: Leaf,
    isDark: false,
    swatchGradient: 'linear-gradient(135deg, #ecfdf5 0%, #34d399 40%, #059669 75%, #0d9488 100%)'
  },
  {
    id: 'sunset',
    name: 'Sunset Glow',
    subtitle: 'Twilight golden hour, peach & warm rose',
    badge: 'Warm',
    icon: Sunset,
    isDark: true,
    swatchGradient: 'linear-gradient(135deg, #311339 0%, #c026d3 35%, #f43f5e 70%, #f97316 100%)'
  },
  {
    id: 'ocean',
    name: 'Ocean Breeze',
    subtitle: 'Deep sapphire, tidal azure & marine calm',
    badge: 'Cool',
    icon: Waves,
    isDark: true,
    swatchGradient: 'linear-gradient(135deg, #081326 0%, #0369a1 40%, #06b6d4 70%, #14b8a6 100%)'
  }
];

interface ThemeSelectorProps {
  currentTheme: AppTheme | string;
  onThemeChange: (theme: AppTheme) => void;
}

export const ThemeSelector: React.FC<ThemeSelectorProps> = ({ currentTheme, onThemeChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeOption = THEME_OPTIONS.find(t => t.id === currentTheme) || THEME_OPTIONS[0];
  const ActiveIcon = activeOption.icon;

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className="p-2 sm:p-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all shrink-0 shadow-sm border border-slate-200/60 dark:border-slate-700/60 cursor-pointer min-h-[36px] flex items-center justify-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        aria-label={`Select theme mode (Current: ${activeOption.name})`}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        title={`Theme Mode: ${activeOption.name} (Click to change)`}
      >
        <span 
          className="w-3.5 h-3.5 rounded-full shrink-0 shadow-xs border border-white/40"
          style={{ background: activeOption.swatchGradient }}
          aria-hidden="true"
        />
        <ActiveIcon className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-current" />
        <span className="text-xs font-semibold hidden lg:inline max-w-[85px] truncate">
          {activeOption.name.split('/')[0].trim()}
        </span>
        <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Popover Menu */}
      {isOpen && (
        <div 
          className="absolute right-0 mt-2 w-72 sm:w-80 rounded-2xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200/80 dark:border-slate-700/80 shadow-2xl p-2 z-50 animate-fadeIn"
          role="listbox"
          aria-label="Theme choices"
        >
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800/80 mb-1 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Appearance & Modes
            </span>
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
              8 Themes
            </span>
          </div>

          <div className="max-h-[360px] overflow-y-auto space-y-1 pr-0.5">
            {THEME_OPTIONS.map((themeOption) => {
              const isSelected = themeOption.id === currentTheme;
              const Icon = themeOption.icon;

              return (
                <button
                  key={themeOption.id}
                  type="button"
                  onClick={() => {
                    onThemeChange(themeOption.id);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all cursor-pointer group ${
                    isSelected
                      ? 'bg-blue-50/90 dark:bg-blue-950/60 text-blue-900 dark:text-blue-100 border border-blue-200 dark:border-blue-700/60 shadow-xs'
                      : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/70 text-slate-700 dark:text-slate-200 border border-transparent'
                  }`}
                  role="option"
                  aria-selected={isSelected}
                >
                  {/* Swatch Pill with Icon */}
                  <div 
                    className="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center shadow-xs border border-black/10 dark:border-white/10 group-hover:scale-105 transition-transform"
                    style={{ background: themeOption.swatchGradient }}
                  >
                    <Icon className={`w-4 h-4 ${themeOption.isDark ? 'text-white' : 'text-slate-900'}`} />
                  </div>

                  {/* Text Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs sm:text-sm font-semibold truncate">
                        {themeOption.name}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.2 rounded font-medium shrink-0 ${
                        themeOption.id === 'colourful' ? 'bg-pink-100 dark:bg-pink-900/50 text-pink-700 dark:text-pink-300' :
                        themeOption.id === 'magical' ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300' :
                        themeOption.id === 'creative' ? 'bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300' :
                        themeOption.id === 'soothing' ? 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300' :
                        themeOption.id === 'sunset' ? 'bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300' :
                        themeOption.id === 'ocean' ? 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300' :
                        'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                      }`}>
                        {themeOption.badge}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {themeOption.subtitle}
                    </p>
                  </div>

                  {/* Active Checkmark */}
                  {isSelected && (
                    <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default ThemeSelector;
