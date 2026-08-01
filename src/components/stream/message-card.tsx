import { MoreHorizontal, Pencil } from 'lucide-react';

import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type MessageCardProps = {
  author: string;
  initials: string;
  timestamp: string;
  body: string;
  edited?: boolean;
  online?: boolean;
  canEdit?: boolean;
  tone?: 'default' | 'agent';
  onEdit?: () => void;
};

export function MessageCard({
  author,
  initials,
  timestamp,
  body,
  edited = false,
  online = true,
  canEdit = false,
  tone = 'default',
  onEdit,
}: MessageCardProps) {
  return (
    <article
      className={cn(
        'group/message flex gap-3 rounded-2xl px-3 py-3 transition-colors hover:bg-message-hover',
        tone === 'agent' && 'bg-agent-surface/65 ring-1 ring-agent-border/70',
      )}
      data-slot="message-card"
    >
      <Avatar size="default" className="mt-0.5 bg-avatar-surface">
        <AvatarFallback className="bg-avatar-surface font-semibold text-avatar-foreground">
          {initials}
        </AvatarFallback>
        {online && <AvatarBadge aria-label="Online" className="bg-online" />}
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold text-foreground">{author}</span>
          {tone === 'agent' && <Badge variant="agent">agent</Badge>}
          <time className="text-xs text-muted-foreground">{timestamp}</time>
          {edited && <span className="text-xs text-muted-foreground">(edited)</span>}
        </div>
        <p className="mt-1 whitespace-pre-wrap text-[0.95rem] leading-6 text-message-foreground">
          {body}
        </p>
      </div>
      <div className="flex shrink-0 self-start opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
        {canEdit && (
          <Button
            aria-label={`Edit ${author}'s message`}
            className="text-muted-foreground"
            size="icon-sm"
            variant="ghost"
            onPress={onEdit}
          >
            <Pencil aria-hidden="true" />
          </Button>
        )}
        <Button aria-label="More message actions" className="text-muted-foreground" size="icon-sm" variant="ghost">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}
