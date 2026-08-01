import { useState } from 'react';

import { Clock3, FileText, Hash, LockKeyhole, ScrollText, ShieldCheck, Terminal, X } from 'lucide-react';

import { MessageCard } from '@/components/stream/message-card';
import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

export type ThreadViewPreviewProps = {
  className?: string;
  initialRunOpen?: boolean;
  onClose?: () => void;
};

const runEvents = [
  { time: '09:44:08', title: 'Run started', detail: 'Release concierge received a scoped request from #launch-planning.', icon: Terminal },
  { time: '09:44:09', title: 'Channel context read', detail: 'Loaded 12 approved events from the current thread.', icon: FileText },
  { time: '09:44:10', title: 'Drafted response', detail: 'Prepared a concise handoff with three launch risks.', icon: ScrollText },
  { time: '09:44:11', title: 'Response posted', detail: 'Published the reply to this thread as the agent principal.', icon: ShieldCheck },
] as const;

function ThreadHeader({ onClose }: { onClose?: () => void }) {
  return (
    <header className="flex min-h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur sm:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Hash aria-hidden="true" className="size-4 text-muted-foreground" />
          <h1 className="truncate text-sm font-semibold">launch-planning</h1>
          <Badge variant="outline">Thread</Badge>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">A focused conversation about the release handoff.</p>
      </div>
      <Button aria-label="Close thread" size="icon-sm" variant="ghost" onPress={onClose}>
        <X aria-hidden="true" />
      </Button>
    </header>
  );
}

function AgentResponseButton({ isSelected, onPress }: { isSelected: boolean; onPress: () => void }) {
  return (
    <Button
      aria-label="Open full run logs for Release concierge"
      aria-pressed={isSelected}
      className={cn(
        'h-auto w-full flex-col items-stretch gap-3 rounded-xl border border-border px-4 py-4 text-left whitespace-normal',
        isSelected ? 'bg-muted' : 'bg-card hover:bg-muted/60',
      )}
      onPress={onPress}
      variant="ghost"
    >
      <div className="flex items-start gap-3">
        <Avatar className="bg-avatar-surface">
          <AvatarFallback className="bg-avatar-surface font-semibold text-avatar-foreground">RC</AvatarFallback>
          <AvatarBadge role="img" aria-label="Online" className="bg-online" />
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Release concierge</span>
            <Badge variant="agent">agent</Badge>
            <time className="text-xs font-normal text-muted-foreground">9:44 AM</time>
          </div>
          <p className="mt-2 text-sm leading-6 text-message-foreground">
            I found three release risks: the migration window is unowned, the rollback checklist is stale, and the launch channel needs a final go/no-go owner.
          </p>
          <span className="mt-3 flex items-center gap-2 text-xs font-medium text-link">
            <Terminal aria-hidden="true" className="size-3.5" />
            {isSelected ? 'Run logs open' : 'Click to inspect full run logs'}
          </span>
        </div>
      </div>
    </Button>
  );
}

function EmptyRunLogPanel() {
  return (
    <aside aria-label="Agent run log selection" className="bg-background p-5 sm:p-6">
      <div className="flex h-full min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-6 text-center">
        <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
          <Terminal aria-hidden="true" className="size-5" />
        </span>
        <h2 className="mt-4 text-base font-semibold">Inspect an agent response</h2>
        <p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">Select the AI response in the thread to see its complete run timeline, tools, and redacted log output.</p>
      </div>
    </aside>
  );
}

function AgentRunLogPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside aria-label="Full logs for Release concierge run" className="min-w-0 bg-background">
      <header className="flex items-start gap-3 border-b border-border px-5 py-5 sm:px-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg font-semibold tracking-[-0.02em]">Full run logs</h2>
            <Badge variant="secondary">Succeeded</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">Release concierge · run_rc_01J8F4K7 · 3.2s</p>
        </div>
        <Button aria-label="Close run logs" size="icon-sm" variant="ghost" onPress={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="space-y-5 overflow-auto p-5 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">Principal</p>
            <p className="mt-1 text-sm font-medium">Release concierge</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">Source</p>
            <p className="mt-1 text-sm font-medium">#launch-planning thread</p>
          </div>
        </div>

        <section aria-labelledby="run-timeline-heading">
          <div className="flex items-center justify-between gap-3">
            <h3 id="run-timeline-heading" className="text-sm font-semibold">Run timeline</h3>
            <Badge variant="outline"><Clock3 aria-hidden="true" />3.2s</Badge>
          </div>
          <ol className="mt-3 space-y-0" aria-label="Agent run timeline">
            {runEvents.map(({ detail, icon: Icon, time, title }, index) => (
              <li key={title} className="relative flex gap-3 pb-4 last:pb-0">
                {index < runEvents.length - 1 && <span aria-hidden="true" className="absolute top-7 left-3.5 h-full w-px bg-border" />}
                <span className="relative z-10 grid size-7 shrink-0 place-items-center rounded-full border border-border bg-background text-link">
                  <Icon aria-hidden="true" className="size-3.5" />
                </span>
                <div className="min-w-0 pt-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><p className="text-sm font-medium">{title}</p><time className="text-[11px] text-muted-foreground">{time}</time></div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <Separator />

        <section aria-labelledby="tool-calls-heading">
          <div className="flex items-center justify-between gap-3">
            <h3 id="tool-calls-heading" className="text-sm font-semibold">Tool calls</h3>
            <Badge variant="outline">2 calls</Badge>
          </div>
          <div className="mt-3 space-y-2">
            <details open className="rounded-xl border border-border bg-card p-3">
              <summary className="cursor-pointer text-sm font-medium">channels.read</summary>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">scope: approved · channel: launch-planning · events: 12</p>
            </details>
            <details open className="rounded-xl border border-border bg-card p-3">
              <summary className="cursor-pointer text-sm font-medium">messages.append</summary>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">destination: current thread · secret values: redacted</p>
            </details>
          </div>
        </section>

        <section aria-labelledby="raw-log-heading">
          <div className="flex items-center justify-between gap-3">
            <h3 id="raw-log-heading" className="text-sm font-semibold">Raw log</h3>
            <Badge variant="outline"><LockKeyhole aria-hidden="true" />Redacted</Badge>
          </div>
          <pre aria-label="Redacted agent run log" className="mt-3 overflow-auto rounded-xl bg-foreground p-4 font-mono text-[11px] leading-5 text-background">
{`09:44:08.104  run.started       principal=agent:release-concierge
09:44:08.451  context.loaded    stream=channel:launch-planning events=12
09:44:09.220  tool.completed    name=channels.read result=approved
09:44:10.087  response.drafted  tokens=412 secrets=[redacted]
09:44:11.306  message.appended  source_offset=00000042 digest=sha256:…
09:44:11.318  run.succeeded     duration_ms=3214`}
          </pre>
        </section>
      </div>
    </aside>
  );
}

export function ThreadViewPreview({ className, initialRunOpen = false, onClose }: ThreadViewPreviewProps) {
  const [selectedRunOpen, setSelectedRunOpen] = useState(initialRunOpen);

  return (
    <section aria-label="Thread view with agent run logs" className={cn('grid min-h-[640px] overflow-hidden rounded-[1.4rem] bg-background shadow-sm xl:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]', className)}>
      <div className="flex min-w-0 flex-col bg-message-surface">
        <ThreadHeader onClose={onClose} />
        <div className="flex-1 space-y-4 overflow-auto px-4 py-5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Thread</p>
              <p className="mt-1 text-sm font-medium">How should we sequence the release handoff?</p>
            </div>
            <Badge variant="secondary">3 replies</Badge>
          </div>
          <article className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <Avatar className="bg-avatar-surface">
                <AvatarFallback className="bg-avatar-surface font-semibold text-avatar-foreground">BL</AvatarFallback>
                <AvatarBadge role="img" aria-label="Online" className="bg-online" />
              </Avatar>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2"><span className="font-semibold">Brett Lamy</span><time className="text-xs text-muted-foreground">9:41 AM</time></div>
                <p className="mt-2 text-sm leading-6 text-message-foreground">Can someone turn the launch notes into a clear sequence with owners and a rollback checkpoint?</p>
              </div>
            </div>
          </article>
          <Separator />
          <div className="space-y-3" aria-label="Thread replies">
            <AgentResponseButton isSelected={selectedRunOpen} onPress={() => setSelectedRunOpen(true)} />
            <MessageCard
              author="Ada Lovelace"
              body="I can own the rollback checkpoint once the migration window has a confirmed owner."
              initials="AL"
              timestamp="9:46 AM"
            />
          </div>
        </div>
        <div className="border-t border-border bg-background/70 p-3 sm:p-4">
          <div className="rounded-xl border border-input bg-composer-surface p-2 shadow-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25">
            <Input aria-label="Reply in thread" className="h-10 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0" placeholder="Reply in thread" />
            <div className="mt-2 flex items-center justify-between px-1 text-xs text-muted-foreground"><span>Only thread participants will be notified</span><Button size="sm">Reply</Button></div>
          </div>
        </div>
      </div>
      {selectedRunOpen ? <AgentRunLogPanel onClose={() => setSelectedRunOpen(false)} /> : <EmptyRunLogPanel />}
    </section>
  );
}
