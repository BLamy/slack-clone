import { useCallback, useEffect, useMemo, useState } from 'react';

import { Hash, MessageSquareText, Plus, Search, Settings2, Users } from 'lucide-react';

import { MessageCard } from '@/components/stream/message-card';
import { ThreadViewPreview } from '@/components/threads/thread-view-preview';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { BrandMark } from '@/components/stream/brand-mark';
import {
  fetchSession,
  materializeMessages,
  normalizeRoom,
  patchMessage,
  postMessage,
  removeMessage,
  subscribeToRoom,
  type MessageRecord,
  type Session,
} from '@/lib/api';

type ConnectionState = 'loading' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'complete';

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function ChatPage({ room: roomInput }: { room: string }) {
  const room = normalizeRoom(roomInput);
  const params = new URLSearchParams(window.location.search);
  const autopilot = params.get('autopilot') === '1';
  const closeWhenDone = params.get('close') === '1';
  const expectedCount = Number(params.get('expect') ?? '0');
  const autopilotMessage = params.get('message') ?? `Replay check-in at ${new Date().toLocaleTimeString()}`;
  const autopilotDelay = Number(params.get('delay') ?? '500');

  const [session, setSession] = useState<Session>();
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading');
  const [streamPath, setStreamPath] = useState(`/rooms/${room}/messages`);
  const [streamOffset, setStreamOffset] = useState('pending');
  const [records, setRecords] = useState<MessageRecord[]>([]);
  const [composerValue, setComposerValue] = useState('');
  const [streamError, setStreamError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<MessageRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [threadOpen, setThreadOpen] = useState(false);
  const [autopilotSent, setAutopilotSent] = useState(false);

  const messages = useMemo(() => materializeMessages(records), [records]);
  const user = session?.user;

  const isOwnMessage = useCallback((message: MessageRecord) => {
    if (!user) return false;
    return message.email ? Boolean(user.email && message.email === user.email) : message.user === (user.name || user.email);
  }, [user]);

  const mergeRecord = useCallback((record: MessageRecord) => {
    setRecords((current) => [...current.filter((item) => item.id !== record.id), record]);
  }, []);

  const submitMessage = useCallback(async (text: string) => {
    const normalized = text.trim();
    if (!normalized || isSending) return;
    setIsSending(true);
    setStreamError('');
    try {
      const result = await postMessage(room, normalized);
      mergeRecord(result.message);
      setStreamOffset(result.nextOffset);
    } catch (error) {
      setConnectionState('error');
      setStreamError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSending(false);
    }
  }, [isSending, mergeRecord, room]);

  useEffect(() => {
    let cancelled = false;
    let stopSubscription: (() => void) | undefined;

    const load = async () => {
      try {
        const nextSession = await fetchSession();
        if (!nextSession) {
          window.location.href = `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
          return;
        }
        if (cancelled) return;
        setSession(nextSession);
        setConnectionState('connecting');
        stopSubscription = subscribeToRoom(room, {
          onOpen: () => setConnectionState('live'),
          onSnapshot: (snapshot) => {
            setRecords(snapshot.messages);
            setStreamPath(snapshot.stream);
            setStreamOffset(snapshot.nextOffset);
          },
          onMessage: mergeRecord,
          onStatus: (status) => {
            setStreamPath(status.stream);
            setStreamOffset(status.nextOffset);
          },
          onReset: () => setRecords([]),
          onError: (message) => {
            setConnectionState(message ? 'error' : 'reconnecting');
            if (message) setStreamError(message);
          },
        });
      } catch (error) {
        if (cancelled) return;
        setConnectionState('error');
        setStreamError(error instanceof Error ? error.message : String(error));
      }
    };

    void load();
    return () => {
      cancelled = true;
      stopSubscription?.();
    };
  }, [mergeRecord, room]);

  useEffect(() => {
    if (!autopilot || autopilotSent || !session) return;
    const timer = window.setTimeout(() => {
      setAutopilotSent(true);
      void submitMessage(autopilotMessage);
    }, autopilotDelay);
    return () => window.clearTimeout(timer);
  }, [autopilot, autopilotDelay, autopilotMessage, autopilotSent, session, submitMessage]);

  useEffect(() => {
    if (!autopilot || !session) return;
    const userName = session.user.name || session.user.email || '';
    const hasOwnMessage = messages.some((message) => message.user === userName && message.text === autopilotMessage);
    const hasExpectedCount = expectedCount > 0 ? messages.length >= expectedCount : hasOwnMessage;
    if (!hasOwnMessage || !hasExpectedCount) return;

    window.__demoComplete = true;
    document.body.dataset.demoState = 'complete';
    setConnectionState('complete');
    if (closeWhenDone) window.setTimeout(() => window.close(), 1000);
  }, [autopilot, autopilotMessage, closeWhenDone, expectedCount, messages, session]);

  const startEditing = (message: MessageRecord) => {
    if (!isOwnMessage(message)) return;
    setEditingMessageId(message.id);
    setEditingDraft(message.text);
  };

  const cancelEditing = () => {
    setEditingMessageId(null);
    setEditingDraft('');
  };

  const saveEditing = async (messageId: string) => {
    const text = editingDraft.trim();
    if (!text) return;
    try {
      const result = await patchMessage(room, messageId, text);
      mergeRecord(result.message);
      setStreamOffset(result.nextOffset);
      cancelEditing();
    } catch (error) {
      setConnectionState('error');
      setStreamError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const result = await removeMessage(room, deleteTarget.id);
      mergeRecord(result.message);
      setStreamOffset(result.nextOffset);
      setDeleteTarget(null);
    } catch (error) {
      setConnectionState('error');
      setStreamError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground md:h-screen md:overflow-hidden">
      <aside className="hidden w-64 shrink-0 flex-col bg-sidebar px-3 py-4 text-sidebar-foreground md:flex" data-testid="workspace-sidebar">
        <div className="flex items-center justify-between px-2">
          <BrandMark compact />
          <Button aria-label="Workspace settings" className="text-sidebar-muted" size="icon-sm" variant="ghost"><Settings2 aria-hidden="true" /></Button>
        </div>
        <div className="mt-5 flex items-center gap-2 rounded-lg bg-sidebar-raised px-2.5 py-2 text-xs text-sidebar-muted">
          <Search aria-hidden="true" className="size-3.5" />
          <span>Search workspace</span>
          <kbd className="ml-auto rounded bg-sidebar-kbd px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        </div>
        <nav aria-label="Workspace channels" className="mt-6 space-y-1">
          <div className="flex items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">
            <span>Channels</span>
            <Button aria-label="Add channel" className="text-sidebar-muted" size="icon-xs" variant="ghost"><Plus aria-hidden="true" /></Button>
          </div>
          <Button className="w-full justify-start gap-2 bg-sidebar-active px-2 text-sm text-sidebar-foreground" variant="ghost">
            <Hash aria-hidden="true" className="size-4 opacity-70" />
            <span data-testid="room-label">{room}</span>
          </Button>
        </nav>
        <section className="mt-auto rounded-xl bg-sidebar-raised p-3" aria-label="Connection metadata">
          <div className="mb-3 flex items-center gap-2">
            <Avatar size="sm" className="bg-avatar-surface"><AvatarFallback className="bg-avatar-surface text-xs font-semibold text-avatar-foreground">{initials(user?.name ?? 'Visitor')}</AvatarFallback><AvatarBadge role="img" aria-label="Online" className="bg-online" /></Avatar>
            <div className="min-w-0"><p className="truncate text-xs font-semibold" data-testid="persona-label">{user?.name ?? 'visitor'}</p><p className="text-[11px] text-sidebar-muted" data-testid="connection-state">{connectionState}</p></div>
          </div>
          <dl className="space-y-2 text-[11px]">
            <div><dt className="text-sidebar-muted">Auth</dt><dd className="truncate" data-testid="auth-provider">{session ? `${session.provider.name} (${session.provider.url})` : 'pending'}</dd></div>
            <div><dt className="text-sidebar-muted">Signed in</dt><dd className="truncate" data-testid="auth-user">{user?.email ?? 'pending'}</dd></div>
            <div><dt className="text-sidebar-muted">Durable stream</dt><dd className="break-all" data-testid="stream-path">{streamPath}</dd></div>
            <div><dt className="text-sidebar-muted">Next offset</dt><dd className="break-all" data-testid="stream-offset">{streamOffset}</dd></div>
          </dl>
        </section>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col md:min-h-0">
        <header className="flex min-h-16 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
          <div className="md:hidden"><BrandMark compact /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><Hash aria-hidden="true" className="size-4 text-muted-foreground" /><h1 className="truncate text-sm font-semibold"># {room}</h1><Badge variant="outline">public</Badge></div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">Messages append to Durable Streams and replay to each connected client.</p>
          </div>
          <Badge data-testid="mobile-connection-state" className="hidden sm:inline-flex" variant={connectionState === 'live' || connectionState === 'complete' ? 'secondary' : 'outline'}>{connectionState}</Badge>
          <Button aria-label="Open threads" size="icon-sm" variant="outline" onPress={() => setThreadOpen(true)}><MessageSquareText aria-hidden="true" /></Button>
          <Button aria-label="View channel members" className="hidden sm:inline-flex" size="icon-sm" variant="ghost"><Users aria-hidden="true" /></Button>
          <ThemeSwitcher compact />
          <a className="hidden text-xs font-medium text-muted-foreground hover:text-foreground sm:inline" href="/logout">Sign out</a>
        </header>

        {threadOpen ? (
          <div className="min-h-0 flex-1 p-3 sm:p-4"><ThreadViewPreview className="h-full min-h-0" onClose={() => setThreadOpen(false)} /></div>
        ) : (
          <>
            <div className="flex-1 space-y-1 overflow-auto bg-message-surface px-3 py-5 sm:px-6" data-testid="messages" aria-live="polite">
              <div className="mb-5 flex items-center gap-3 text-xs text-muted-foreground"><Separator className="flex-1" /><span className="rounded-full bg-date-pill px-3 py-1 font-medium text-date-pill-foreground">Today</span><Separator className="flex-1" /></div>
              {streamError && <div className="mb-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="connection-error" role="alert">{streamError}</div>}
              {messages.length === 0 ? (
                <Card className="border-dashed bg-card/60"><CardContent className="p-6 text-center text-sm text-muted-foreground">No messages yet. Start the durable stream by sending the first one.</CardContent></Card>
              ) : messages.map((message) => {
                const own = isOwnMessage(message);
                return <MessageCard key={message.id} actionsVisible={own} author={message.user} body={message.text} canDelete={own} canEdit={own} edited={Boolean(message.editedAt)} editValue={editingMessageId === message.id ? editingDraft : message.text} initials={initials(message.user)} isEditing={editingMessageId === message.id} messageId={message.id} onCancelEdit={cancelEditing} onDelete={() => setDeleteTarget(message)} onEdit={() => startEditing(message)} onEditValueChange={setEditingDraft} onSaveEdit={() => void saveEditing(message.id)} timestamp={formatTimestamp(message.createdAt)} />;
              })}
            </div>
            <div className="border-t border-border bg-background/70 p-3 sm:p-4">
              <form className="rounded-xl border border-input bg-composer-surface p-2 shadow-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25" data-testid="composer" onSubmit={(event) => { event.preventDefault(); const text = composerValue.trim(); if (!text) return; setComposerValue(''); void submitMessage(text); }}>
                <Input aria-label="Message to channel" data-testid="message-input" className="h-10 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0" disabled={isSending} onChange={(event) => setComposerValue(event.target.value)} placeholder={`Message #${room}`} value={composerValue} />
                <div className="mt-2 flex items-center justify-between px-1"><span className="text-xs text-muted-foreground">Press Enter to send · messages are durable</span><Button data-testid="send-button" isDisabled={isSending} type="submit" size="sm">{isSending ? 'Sending…' : 'Send'}</Button></div>
              </form>
            </div>
          </>
        )}
      </main>

      <Dialog isOpen={Boolean(deleteTarget)} onOpenChange={(isOpen) => { if (!isOpen && !isDeleting) setDeleteTarget(null); }}>
        <DialogHeader><DialogTitle>Delete this message?</DialogTitle><DialogDescription>This removes the message from the conversation. The durable stream keeps the redacted tombstone for auditability.</DialogDescription></DialogHeader>
        <DialogFooter><DialogClose isDisabled={isDeleting}>Cancel</DialogClose><Button isDisabled={isDeleting} variant="destructive" onPress={() => void confirmDelete()}>{isDeleting ? 'Deleting…' : 'Delete message'}</Button></DialogFooter>
      </Dialog>
    </div>
  );
}

declare global {
  interface Window {
    __demoComplete?: boolean;
  }
}
