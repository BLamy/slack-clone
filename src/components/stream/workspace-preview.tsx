import { Hash, Headphones, Plus, Search, Settings2, Sparkles, Users } from 'lucide-react';

import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

import { BrandMark } from './brand-mark';
import { MessageCard } from './message-card';

const channels = [
  { name: 'general', unread: false },
  { name: 'design-systems', unread: true },
  { name: 'launch-planning', unread: false },
];

export function WorkspacePreview({ className }: { className?: string }) {
  return (
    <section
      aria-label="Stream Slack workspace preview"
      className={cn(
        'grid min-h-[560px] overflow-hidden rounded-[1.4rem] bg-background shadow-sm md:grid-cols-[15rem_minmax(0,1fr)]',
        className,
      )}
    >
      <aside className="hidden flex-col bg-sidebar px-3 py-4 text-sidebar-foreground md:flex">
        <div className="flex items-center justify-between px-2">
          <BrandMark compact />
          <Button aria-label="Workspace settings" className="text-sidebar-muted" size="icon-sm" variant="ghost">
            <Settings2 aria-hidden="true" />
          </Button>
        </div>
        <div className="mt-5 flex items-center gap-2 rounded-lg bg-sidebar-raised px-2.5 py-2 text-xs text-sidebar-muted">
          <Search aria-hidden="true" className="size-3.5" />
          <span>Search workspace</span>
          <kbd className="ml-auto rounded bg-sidebar-kbd px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        </div>
        <nav aria-label="Workspace channels" className="mt-6 space-y-1">
          <div className="flex items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">
            <span>Channels</span>
            <Button aria-label="Add channel" className="text-sidebar-muted" size="icon-xs" variant="ghost">
              <Plus aria-hidden="true" />
            </Button>
          </div>
          {channels.map((channel, index) => (
            <Button
              key={channel.name}
              className={cn(
                'w-full justify-start gap-2 px-2 text-sm text-sidebar-muted hover:bg-sidebar-raised hover:text-sidebar-foreground',
                index === 0 && 'bg-sidebar-active text-sidebar-foreground',
              )}
              variant="ghost"
            >
              <Hash aria-hidden="true" className="size-4 opacity-70" />
              <span>{channel.name}</span>
              {channel.unread && <span className="ml-auto size-1.5 rounded-full bg-sidebar-accent" />}
            </Button>
          ))}
        </nav>
        <div className="mt-auto rounded-xl bg-sidebar-raised p-3">
          <div className="flex items-center gap-2">
            <Avatar size="sm" className="bg-avatar-surface">
              <AvatarFallback className="bg-avatar-surface text-xs font-semibold text-avatar-foreground">BL</AvatarFallback>
              <AvatarBadge className="bg-online" />
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">Brett Lamy</p>
              <p className="text-[11px] text-sidebar-muted">Available</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col bg-message-surface">
        <header className="flex min-h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Hash aria-hidden="true" className="size-4 text-muted-foreground" />
              <h2 className="truncate text-sm font-semibold">general</h2>
              <Badge variant="outline">public</Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">A calm place for updates, questions, and small wins.</p>
          </div>
          <Button aria-label="Start huddle" className="hidden sm:inline-flex" size="sm" variant="outline">
            <Headphones aria-hidden="true" />
            Huddle
          </Button>
          <Button aria-label="View channel members" size="icon-sm" variant="ghost">
            <Users aria-hidden="true" />
          </Button>
        </header>

        <div className="flex-1 space-y-1 overflow-hidden px-3 py-5 md:px-6">
          <div className="mb-5 flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            <span className="rounded-full bg-date-pill px-3 py-1 font-medium text-date-pill-foreground">Today</span>
            <Separator className="flex-1" />
          </div>
          <MessageCard
            author="Brett Lamy"
            body="The first React Aria primitives are ready for review. I kept the navigation deep plum and let teal carry the action moments."
            canEdit
            initials="BL"
            timestamp="9:42 AM"
          />
          <MessageCard
            author="Stream Agent"
            body="I can turn this into a live channel once the component states are approved."
            initials="SA"
            online={false}
            timestamp="9:44 AM"
            tone="agent"
          />
          <MessageCard
            author="Ada Lovelace"
            body="The focus ring reads clearly against both surfaces. Nice."
            initials="AL"
            timestamp="9:47 AM"
          />
        </div>

        <div className="border-t border-border bg-background/70 p-3 md:p-4">
          <div className="rounded-xl border border-input bg-composer-surface p-2 shadow-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25">
            <Input aria-label="Message #general" className="h-10 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0" placeholder="Message #general" />
            <div className="mt-2 flex items-center justify-between px-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Button aria-label="Add attachment" size="icon-sm" variant="ghost">
                  <Plus aria-hidden="true" />
                </Button>
                <span>Press Enter to send</span>
              </div>
              <Button size="sm">
                <Sparkles aria-hidden="true" />
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
