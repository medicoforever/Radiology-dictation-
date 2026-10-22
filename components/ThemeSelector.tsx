import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  Sun, 
  Moon, 
  Palette, 
  Sparkles, 
  Brush, 
  Leaf, 
  Sunset, 
  Waves, 
  Compass, 
  Terminal, 
  Crown, 
  Snowflake, 
  Flame, 
  Flower2, 
  Feather, 
  Coffee, 
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
  | 'ocean'
  | 'aurora'
  | 'cyberpunk'
  | 'velvet'
  | 'nordic'
  | 'solar'
  | 'sakura'
  | 'lavender'
  | 'espresso';

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
  },
  {
    id: 'aurora',
    name: 'Aurora Borealis',
    subtitle: 'Cosmic polar ribbons, teal & boreal green',
    badge: 'Boreal',
    icon: Compass,
    isDark: true,
    swatchGradient: 'linear-gradient(135deg, #042f2e 0%, #0d9488 35%, #10b981 70%, #a7f3d0 100%)'
  },
  {
    id: 'cyberpunk',
    name: 'Cyber Neon',
    subtitle: 'High-voltage phosphor lime & terminal noir',
    badge: 'High-Tech',
    icon: Terminal,
    isDark: true,
    swatchGradient: 'linear-gradient(135deg, #022c22 0%, #15803d 40%, #22c55e 75%, #a3e635 100%)'
  },
  {
    id: 'velvet',
    name: 'Midnight Velvet',
    subtitle: 'Imperial royal plum, amethyst & rich wine',
    badge: 'Regal',
    icon: Crown,
    isDark: true,
    swatchGradient: 'linear-gradient(135deg, #2e0854 0%, #6b21a8 40%, #a21caf 75%, #f472b6 100%)'
  },
  {
    id: 'nordic',
    name: 'Nordic Frost',
    subtitle: 'Scandinavian fjord, polar ice & glacial slate',
    badge: 'Minimal',
    icon: Snowflake,
    isDark: false,
    swatchGradient: 'linear-gradient(135deg, #f0f9ff 0%, #bae6fd 40%, #38bdf8 75%, #0284c7 100%)'
  },
  {
    id: 'solar',
    name: 'Solar Amber',
    subtitle: 'Radiant golden dawn, roasted honey & amber',
    badge: 'Radiant',
    icon: Flame,
    isDark: false,
    swatchGradient: 'linear-gradient(135deg, #fffbeb 0%, #fde68a 35%, #f59e0b 70%, #b45309 100%)'
  },
  {
    id: 'sakura',
    name: 'Cherry Blossom',
    subtitle: 'Kyoto spring petals, soft blush & sakura rose',
    badge: 'Elegant',
    icon: Flower2,
    isDark: false,
    swatchGradient: 'linear-gradient(135deg, #fff1f2 0%, #fecdd3 35%, #fb7185 70%, #e11d48 100%)'
  },
  {
    id: 'lavender',
    name: 'Lavender Mist',
    subtitle: 'Soft Provençal lilac, dreamy violet & silk calm',
    badge: 'Serene',
    icon: Feather,
    isDark: false,
    swatchGradient: 'linear-gradient(135deg, #faf5ff 0%, #e9d5ff 40%, #c084fc 75%, #9333ea 100%)'
  },
  {
    id: 'espresso',
    name: 'Warm Espresso',
    subtitle: 'Artisan dark roast, caramel cream & bronze',
    badge: 'Artisan',
    icon: Coffee,
    isDark: true,
    swatchGradient: 'linear-gradient(135deg, #1c140e 0%, #451a03 40%, #78350f 75%, #d97706 100%)'
  }
];

interface ThemeSelectorProps {
  currentTheme: AppTheme | string;
  onThemeChange: (theme: AppTheme) => void;
}

export const ThemeSelector: React.FC<ThemeSelectorProps> = ({ currentTheme, onThemeChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filterMode, setFilterMode] = useState<'all' | 'light' | 'dark'>('all');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeOption = THEME_OPTIONS.find(t => t.id === currentTheme) || THEME_OPTIONS[0];
  const ActiveIcon = activeOption.icon;

  const filteredOptions = useMemo(() => {
    if (filterMode === 'light') {
      return THEME_OPTIONS.filter(t => !t.isDark);
    }
    if (filterMode === 'dark') {
      return THEME_OPTIONS.filter(t => t.isDark);
    }
    return THEME_OPTIONS;
  }, [filterMode]);

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
        <span className="text-xs font-semibold hidden lg:inline max-w-[95px] truncate">
          {activeOption.name.split('/')[0].trim()}
        </span>
        <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Popover Menu */}
      {isOpen && (
        <div 
          className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200/80 dark:border-slate-700/80 shadow-2xl p-2.5 z-50 animate-fadeIn"
          role="listbox"
          aria-label="Theme choices"
        >
          {/* Header */}
          <div className="px-2.5 py-1.5 border-b border-slate-100 dark:border-slate-800/80 mb-2 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Appearance & Modes
            </span>
            <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500">
              {THEME_OPTIONS.length} Themes
            </span>
          </div>

          {/* Quick Filter Tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl mb-2">
            <button
              type="button"
              onClick={() => setFilterMode('all')}
              className={`flex-1 py-1 px-2 text-xs font-medium rounded-lg transition-colors cursor-pointer text-center ${
                filterMode === 'all'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              All ({THEME_OPTIONS.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('light')}
              className={`flex-1 py-1 px-2 text-xs font-medium rounded-lg transition-colors cursor-pointer text-center ${
                filterMode === 'light'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Light ({THEME_OPTIONS.filter(t => !t.isDark).length})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('dark')}
              className={`flex-1 py-1 px-2 text-xs font-medium rounded-lg transition-colors cursor-pointer text-center ${
                filterMode === 'dark'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Dark ({THEME_OPTIONS.filter(t => t.isDark).length})
            </button>
          </div>

          {/* List of Themes */}
          <div className="max-h-[380px] overflow-y-auto space-y-1 pr-0.5">
            {filteredOptions.map((themeOption) => {
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
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all cursor-pointer group ${
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
                        themeOption.id === 'aurora' ? 'bg-teal-100 dark:bg-teal-900/50 text-teal-700 dark:text-teal-300' :
                        themeOption.id === 'cyberpunk' ? 'bg-lime-100 dark:bg-lime-900/50 text-lime-700 dark:text-lime-300' :
                        themeOption.id === 'velvet' ? 'bg-fuchsia-100 dark:bg-fuchsia-900/50 text-fuchsia-700 dark:text-fuchsia-300' :
                        themeOption.id === 'nordic' ? 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300' :
                        themeOption.id === 'solar' ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300' :
                        themeOption.id === 'sakura' ? 'bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300' :
                        themeOption.id === 'lavender' ? 'bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-300' :
                        themeOption.id === 'espresso' ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-200' :
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
