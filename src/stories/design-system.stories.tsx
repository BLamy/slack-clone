import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bell, Check, ChevronDown, Command, MoreHorizontal, Plus, Sparkles } from 'lucide-react';
import { TextField } from 'react-aria-components';

import { BrandMark } from '@/components/stream/brand-mark';
import { MessageCard } from '@/components/stream/message-card';
import { WorkspacePreview } from '@/components/stream/workspace-preview';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="mb-5">
        <h2 className="font-display text-base font-semibold tracking-[-0.02em]">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function DesignSystemShowcase({ mode = 'light' }: { mode?: 'light' | 'dark' }) {
  return (
    <ThemeProvider defaultTheme={mode} storageKey={`stream-slack-story-${mode}`}>
      <main className="min-h-screen bg-background p-5 text-foreground sm:p-8">
        <div className="mx-auto max-w-6xl">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
            <div>
              <BrandMark />
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                React Aria behavior, shadcn composition, and a token map for the Stream Slack workspace.
              </p>
            </div>
            <ThemeSwitcher />
          </header>

          <div className="grid gap-5 py-6 lg:grid-cols-2">
            <Section title="Action language" description="Teal carries intent; focus rings stay visible across both themes.">
              <div className="flex flex-wrap items-center gap-2">
                <Button>
                  <Sparkles aria-hidden="true" />
                  Primary action
                </Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="link">Text link</Button>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Button size="xs">XS</Button>
                <Button size="sm">Small</Button>
                <Button size="lg">Large</Button>
                <Button aria-label="Add" size="icon" variant="outline"><Plus aria-hidden="true" /></Button>
                <Button aria-label="More" size="icon-sm" variant="ghost"><MoreHorizontal aria-hidden="true" /></Button>
              </div>
            </Section>

            <Section title="Status language" description="Compact signals for channels, agents, and presence.">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>Live</Badge>
                <Badge variant="secondary">Draft</Badge>
                <Badge variant="outline">Public channel</Badge>
                <Badge variant="agent"><Sparkles aria-hidden="true" />Agent</Badge>
                <Badge variant="destructive">Needs attention</Badge>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-message-surface p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium"><span className="size-2 rounded-full bg-online" />Online</div>
                  <p className="mt-1 text-xs text-muted-foreground">Human and agent presence use the same language.</p>
                </div>
                <div className="rounded-xl border border-agent-border bg-agent-surface p-3 text-sm text-agent-foreground">
                  <div className="flex items-center gap-2 font-medium"><Check aria-hidden="true" className="size-4" />Verified state</div>
                  <p className="mt-1 text-xs opacity-80">Evidence can sit beside the work it describes.</p>
                </div>
              </div>
            </Section>

            <Section title="Fields and selection" description="React Aria field semantics stay unstyled until the token layer gives them shape.">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField defaultValue="design-systems" className="space-y-2">
                  <Label>Channel name</Label>
                  <Input />
                </TextField>
                <Select aria-label="Workspace role" defaultSelectedKey="member">
                  <Label>Workspace role</Label>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem id="member">Member</SelectItem>
                    <SelectItem id="agent">Agent</SelectItem>
                    <SelectItem id="owner">Owner</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <TextField defaultValue="Keep the next message concise and kind." className="mt-4 space-y-2">
                <Label>Composer preview</Label>
                <Textarea rows={3} />
              </TextField>
            </Section>

            <Section title="Menus and dialogs" description="Keyboard-first overlays for workspace actions.">
              <div className="flex flex-wrap gap-3">
                <DropdownMenuTrigger>
                  <Button variant="outline">
                    <Command aria-hidden="true" />
                    Workspace menu
                    <ChevronDown aria-hidden="true" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuLabel>Workspace</DropdownMenuLabel>
                    <DropdownMenuItem>Invite teammate</DropdownMenuItem>
                    <DropdownMenuItem>Manage channels</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem>Open preferences</DropdownMenuItem>
                  </DropdownMenu>
                </DropdownMenuTrigger>
                <DialogTrigger>
                  <Button>
                    <Bell aria-hidden="true" />
                    Open dialog
                  </Button>
                  <Dialog>
                    <DialogHeader>
                      <DialogTitle>Review handoff</DialogTitle>
                      <DialogDescription>Approve the component states before they become connected workspace surfaces.</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button variant="outline">Keep iterating</Button>
                      <Button>Approve direction</Button>
                    </DialogFooter>
                  </Dialog>
                </DialogTrigger>
              </div>
            </Section>
          </div>

          <Section title="Message variants" description="The message timeline keeps human and agent authors visually related but distinct.">
            <div className="max-w-3xl space-y-1">
              <MessageCard
                author="Brett Lamy"
                body="The teal action is readable without overpowering the calm lavender surface."
                canEdit
                edited
                initials="BL"
                timestamp="9:42 AM"
              />
              <MessageCard
                author="Stream Agent"
                body="Agent replies get a quiet cyan wash and a small identity badge."
                initials="SA"
                online={false}
                timestamp="9:44 AM"
                tone="agent"
              />
            </div>
          </Section>
        </div>
      </main>
    </ThemeProvider>
  );
}

const meta = {
  title: 'Stream Slack/Design system',
  component: DesignSystemShowcase,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof DesignSystemShowcase>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LightMode: Story = {
  args: { mode: 'light' },
};

export const DarkMode: Story = {
  args: { mode: 'dark' },
};

function OverlayStates() {
  const [selected, setSelected] = useState('general');

  return (
    <div className="min-h-[360px] bg-background p-8 text-foreground">
      <div className="mx-auto max-w-lg rounded-2xl border border-border bg-card p-6 shadow-sm">
        <h2 className="font-display text-lg font-semibold">Focused interaction states</h2>
        <p className="mt-2 text-sm text-muted-foreground">Tab into each control to review the high-contrast focus ring.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button autoFocus>Focused on load</Button>
          <Select aria-label="Channel" selectedKey={selected} onSelectionChange={(key) => setSelected(String(key))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem id="general"># general</SelectItem>
              <SelectItem id="design-systems"># design-systems</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="mt-5 text-xs text-muted-foreground">Current channel: <span className="font-medium text-foreground">{selected}</span></p>
      </div>
    </div>
  );
}

export const InteractionStates: Story = {
  render: () => (
    <ThemeProvider defaultTheme="light" storageKey="stream-slack-story-interaction">
      <OverlayStates />
    </ThemeProvider>
  ),
};

export const WorkspaceShell: Story = {
  render: () => (
    <ThemeProvider defaultTheme="light" storageKey="stream-slack-story-workspace">
      <div className="min-h-screen bg-background p-4 sm:p-8">
        <WorkspacePreview />
      </div>
    </ThemeProvider>
  ),
};
