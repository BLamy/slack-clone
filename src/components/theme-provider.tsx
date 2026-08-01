import * as React from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = Exclude<ThemeMode, 'system'>;

const THEME_STORAGE_KEY = 'stream-slack-theme';

type ThemeContextValue = {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

function getStoredTheme(storageKey: string, fallback: ThemeMode): ThemeMode {
  if (typeof window === 'undefined') return fallback;

  const stored = window.localStorage.getItem(storageKey);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : fallback;
}

function getSystemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = THEME_STORAGE_KEY,
}: {
  children: React.ReactNode;
  defaultTheme?: ThemeMode;
  storageKey?: string;
}) {
  const [theme, setThemeState] = React.useState<ThemeMode>(() =>
    getStoredTheme(storageKey, defaultTheme),
  );
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(getSystemTheme);
  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  const setTheme = React.useCallback(
    (nextTheme: ThemeMode) => {
      setThemeState(nextTheme);
      window.localStorage.setItem(storageKey, nextTheme);
    },
    [storageKey],
  );

  React.useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.themeMode = theme;
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme, theme]);

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemTheme(media.matches ? 'dark' : 'light');
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [resolvedTheme, setTheme, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = React.useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}

export { THEME_STORAGE_KEY };
