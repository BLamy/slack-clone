import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import { MessageCard } from '@/components/stream/message-card';
import { ThemeProvider } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

function MessageActionsDemo() {
  const initialBody = 'I can take the launch checklist and turn it into a concise handoff.';
  const [body, setBody] = useState(initialBody);
  const [draft, setDraft] = useState(initialBody);
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleted, setIsDeleted] = useState(false);

  if (isDeleted) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <p className="font-medium">Message deleted</p>
            <p className="mt-1 text-sm text-muted-foreground">The destructive action is explicit and reversible in this fixture.</p>
          </div>
          <Button
            variant="outline"
            onPress={() => {
              setIsDeleted(false);
              setBody(initialBody);
            }}
          >
            Restore fixture
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <MessageCard
        actionsVisible
        author="Brett Lamy"
        body={body}
        canDelete
        canEdit
        edited={body !== initialBody}
        initials="BL"
        isEditing={isEditing}
        editValue={draft}
        onCancelEdit={() => {
          setDraft(body);
          setIsEditing(false);
        }}
        onDelete={() => setIsDeleteOpen(true)}
        onEdit={() => {
          setDraft(body);
          setIsEditing(true);
        }}
        onEditValueChange={setDraft}
        onSaveEdit={() => {
          setBody(draft);
          setIsEditing(false);
        }}
        timestamp="9:42 AM"
      />
      <Dialog isOpen={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogHeader>
          <DialogTitle>Delete this message?</DialogTitle>
          <DialogDescription>This removes the message from the conversation. The action is shown as a confirmation state before any backend call exists.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <Button
            variant="destructive"
            onPress={() => {
              setIsDeleteOpen(false);
              setIsDeleted(true);
            }}
          >
            Delete message
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function MessageActionShowcase({ mode = 'light' }: { mode?: 'light' | 'dark' }) {
  return (
    <ThemeProvider defaultTheme={mode} storageKey={`stream-slack-story-message-actions-${mode}`}>
      <div className="min-h-screen bg-background p-5 text-foreground sm:p-8">
        <div className="mx-auto max-w-5xl space-y-5">
          <header>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Messaging / owner controls</p>
            <h1 className="mt-2 font-display text-2xl font-semibold tracking-[-0.03em]">Neutral messages, explicit actions</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Messages share one calm surface. Ownership is communicated through the action affordances, with inline editing and a destructive confirmation state.</p>
          </header>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Owner action state</CardTitle>
                <CardDescription>Use Edit or Delete, then confirm the state change.</CardDescription>
              </CardHeader>
              <CardContent className="p-2 sm:p-3">
                <MessageActionsDemo />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Inline edit state</CardTitle>
                <CardDescription>The composer stays close to the original message.</CardDescription>
              </CardHeader>
              <CardContent className="p-2 sm:p-3">
                <MessageCard
                  actionsVisible
                  author="Brett Lamy"
                  body="The message editor keeps the context visible while the copy changes."
                  canDelete
                  canEdit
                  editValue="The message editor keeps the context visible while the copy changes."
                  initials="BL"
                  isEditing
                  onCancelEdit={() => undefined}
                  onEditValueChange={() => undefined}
                  onSaveEdit={() => undefined}
                  timestamp="9:42 AM"
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </ThemeProvider>
  );
}

const meta = {
  title: 'Stream Slack/Messages',
  component: MessageActionShowcase,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MessageActionShowcase>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActionStates: Story = { args: { mode: 'light' } };
export const ActionStatesDark: Story = { args: { mode: 'dark' } };
