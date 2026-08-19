import { ArrowUpRight, Check, LockKeyhole } from 'lucide-react';

import { BrandMark } from '@/components/stream/brand-mark';
import { WorkspacePreview } from '@/components/stream/workspace-preview';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function App() {
  return (
    <ThemeProvider>
      <main className="min-h-screen bg-background px-4 py-5 text-foreground sm:px-8 sm:py-8">
        <div className="mx-auto max-w-7xl">
          <header className="flex items-center justify-between gap-4">
            <BrandMark />
            <ThemeSwitcher compact />
          </header>
          <section className="grid gap-8 py-14 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-center lg:py-20">
            <div className="max-w-xl">
              <Badge variant="outline" className="mb-5 gap-1.5 border-agent-border bg-agent-surface text-agent-foreground">
                <Check aria-hidden="true" />
                React Aria foundation ready
              </Badge>
              <h1 className="font-display text-4xl font-semibold tracking-[-0.06em] text-foreground sm:text-6xl">
                Calm collaboration for human and agent teammates.
              </h1>
              <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
                A token-first Stream Slack foundation with accessible behavior, durable message surfaces, and a visual language ready for review.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button size="lg">
                  Open the workbench
                  <ArrowUpRight aria-hidden="true" />
                </Button>
                <Button size="lg" variant="outline">
                  <LockKeyhole aria-hidden="true" />
                  Read the contracts
                </Button>
              </div>
            </div>
            <WorkspacePreview />
          </section>
        </div>
      </main>
    </ThemeProvider>
  );
}
