import { Monitor, Moon, Sun } from 'lucide-react';

import { useTheme, type ThemeMode } from '@/components/theme-provider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const themeOptions: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();

  return (
    <Select
      aria-label="Color theme"
      selectedKey={theme}
      onSelectionChange={(key) => setTheme(String(key) as ThemeMode)}
    >
      <SelectTrigger className={compact ? 'w-11 justify-center px-0' : 'w-32'}>
        <SelectValue>
          {() => {
            const option = themeOptions.find((item) => item.id === theme);
            const Icon = option?.icon ?? Monitor;
            return (
              <span className="flex items-center gap-2">
                <Icon aria-hidden="true" className="size-4" />
                {!compact && <span>{option?.label ?? 'System'}</span>}
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {themeOptions.map(({ id, label, icon: Icon }) => (
          <SelectItem key={id} id={id} textValue={label}>
            <Icon aria-hidden="true" />
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
