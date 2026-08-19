import { Check, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';

import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type MessageCardProps = {
  author: string;
  initials: string;
  timestamp: string;
  body: string;
  messageId?: string;
  edited?: boolean;
  online?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  actionsVisible?: boolean;
  isEditing?: boolean;
  editValue?: string;
  tone?: 'default' | 'agent';
  onEdit?: () => void;
  onDelete?: () => void;
  onEditValueChange?: (value: string) => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
};

export function MessageCard({
  author,
  initials,
  timestamp,
  body,
  messageId,
  edited = false,
  online = true,
  canEdit = false,
  canDelete = false,
  actionsVisible = false,
  isEditing = false,
  editValue,
  tone = 'default',
  onEdit,
  onDelete,
  onEditValueChange,
  onSaveEdit,
  onCancelEdit,
}: MessageCardProps) {
  return (
    <article
      className="group/message flex gap-3 rounded-2xl px-3 py-3 transition-colors hover:bg-message-hover"
      data-tone={tone}
      data-slot="message-card"
      data-testid="message"
      data-message-id={messageId}
    >
      <Avatar size="default" className="mt-0.5 bg-avatar-surface">
        <AvatarFallback className="bg-avatar-surface font-semibold text-avatar-foreground">
          {initials}
        </AvatarFallback>
        {online && <AvatarBadge role="img" aria-label="Online" className="bg-online" />}
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold text-foreground">{author}</span>
          {tone === 'agent' && <Badge variant="agent">agent</Badge>}
          <time className="text-xs text-muted-foreground">{timestamp}</time>
          {edited && <span className="text-xs text-muted-foreground" data-testid="message-edited">(edited)</span>}
        </div>
        {isEditing ? (
          <div className="mt-2 space-y-2">
            <Textarea
              aria-label={`Edit ${author}'s message`}
              data-testid="edit-message-input"
              rows={3}
              value={editValue ?? body}
              onChange={(event) => onEditValueChange?.(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onPress={onSaveEdit}>
                <Check aria-hidden="true" />
                Save edit
              </Button>
              <Button size="sm" variant="ghost" onPress={onCancelEdit}>
                <X aria-hidden="true" />
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-[0.95rem] leading-6 text-message-foreground">
            {body}
          </p>
        )}
      </div>
      <div
        className={cn(
          'flex shrink-0 self-start transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100',
          !actionsVisible && 'opacity-0',
        )}
        data-slot="message-actions"
      >
        {canEdit && !isEditing && (
          <Button
            aria-label="Edit message"
            className="text-muted-foreground"
            size="icon-sm"
            variant="ghost"
            onPress={onEdit}
          >
            <Pencil aria-hidden="true" />
          </Button>
        )}
        {canDelete && !isEditing && (
          <Button
            aria-label="Delete message"
            className="text-destructive"
            size="icon-sm"
            variant="ghost"
            onPress={onDelete}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        )}
        {!isEditing && (
          <Button aria-label="More message actions" className="text-muted-foreground" size="icon-sm" variant="ghost">
          <MoreHorizontal aria-hidden="true" />
          </Button>
        )}
      </div>
    </article>
  );
}
