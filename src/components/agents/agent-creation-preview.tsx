import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CircleHelp,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
  WandSparkles,
} from 'lucide-react';
import { TextField } from 'react-aria-components';

import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type AgentCreationStep = 'directory' | 'identity' | 'review';

const steps = [
  { id: 'identity', label: 'Identity', description: 'Name and role' },
  { id: 'permissions', label: 'Permissions', description: 'What it can do' },
  { id: 'review', label: 'Review', description: 'Confirm setup' },
] as const;

function AgentSidebar({ step }: { step: AgentCreationStep }) {
  return (
    <aside aria-label="Agent builder navigation" className="hidden flex-col bg-sidebar px-3 py-4 text-sidebar-foreground lg:flex">
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="grid size-7 place-items-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Bot aria-hidden="true" className="size-4" />
          </span>
          Agent studio
        </div>
        <Button aria-label="Agent studio help" className="text-sidebar-muted" size="icon-sm" variant="ghost">
          <CircleHelp aria-hidden="true" />
        </Button>
      </div>

      <nav aria-label="Agent studio sections" className="mt-8 space-y-1">
        <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">Workspace</p>
        <Button className="w-full justify-start gap-2 px-2 text-sm text-sidebar-muted hover:bg-sidebar-raised hover:text-sidebar-foreground" variant="ghost">
          <Users aria-hidden="true" className="size-4" />
          Members
        </Button>
        <Button className="w-full justify-start gap-2 bg-sidebar-active px-2 text-sm text-sidebar-foreground" variant="ghost">
          <Sparkles aria-hidden="true" className="size-4" />
          Agents
        </Button>
        <Button className="w-full justify-start gap-2 px-2 text-sm text-sidebar-muted hover:bg-sidebar-raised hover:text-sidebar-foreground" variant="ghost">
          <KeyRound aria-hidden="true" className="size-4" />
          Connections
        </Button>
      </nav>

      <div className="mt-auto rounded-xl bg-sidebar-raised p-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">Current setup</p>
        <p className="mt-2 text-sm font-medium">{step === 'directory' ? 'Agent directory' : 'New agent draft'}</p>
        <p className="mt-1 text-xs leading-5 text-sidebar-muted">Keep identity, permissions, and approvals explicit.</p>
      </div>
    </aside>
  );
}

function AgentStepper({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol aria-label="Agent creation progress" className="grid gap-2 sm:grid-cols-3">
      {steps.map((step, index) => {
        const complete = index < current;
        const active = index === current;
        return (
          <li
            key={step.id}
            className={cn(
              'flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-3',
              active && 'border-primary/60 bg-primary/5',
            )}
          >
            <span
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-full border border-border text-xs font-semibold text-muted-foreground',
                complete && 'border-primary bg-primary text-primary-foreground',
                active && 'border-primary text-primary',
              )}
            >
              {complete ? <Check aria-hidden="true" className="size-4" /> : index + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{step.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{step.description}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function AgentPageHeader({ step, eyebrow, title, description }: { step: AgentCreationStep; eyebrow: string; title: string; description: string }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-8">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{eyebrow}</p>
        <h1 className="mt-2 font-display text-xl font-semibold tracking-[-0.03em] sm:text-2xl">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <Badge variant="agent" className="shrink-0">
        <Sparkles aria-hidden="true" />
        {step === 'directory' ? 'Agent studio' : 'Draft workspace'}
      </Badge>
    </header>
  );
}

function AgentFrame({ step, children }: { step: AgentCreationStep; children: React.ReactNode }) {
  return (
    <section aria-label="Agent creation preview" className="grid min-h-[640px] overflow-hidden rounded-[1.4rem] bg-background shadow-sm lg:grid-cols-[15rem_minmax(0,1fr)]">
      <AgentSidebar step={step} />
      <div className="min-w-0 bg-message-surface">{children}</div>
    </section>
  );
}

function AgentDirectoryPage() {
  return (
    <AgentFrame step="directory">
      <AgentPageHeader
        description="Create focused teammates for channel work, reviews, and repeatable workspace rituals."
        eyebrow="Agents"
        step="directory"
        title="Your agent team"
      />
      <div className="space-y-5 p-5 sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">2 configured agents</p>
            <h2 className="mt-1 font-display text-lg font-semibold tracking-[-0.02em]">Ready when the workspace needs them</h2>
          </div>
          <Button>
            <Plus aria-hidden="true" />
            New agent
          </Button>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>Active agents</CardTitle>
              <CardDescription>Agents use the same identity language as human teammates.</CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border p-0">
              <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
                <Avatar className="bg-avatar-surface">
                  <AvatarFallback className="bg-avatar-surface font-semibold text-avatar-foreground">RC</AvatarFallback>
                  <AvatarBadge role="img" aria-label="Online" className="bg-online" />
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">Release concierge</p>
                  <p className="truncate text-sm text-muted-foreground">Summarizes launch channels and prepares handoffs.</p>
                </div>
                <Badge variant="secondary">Active</Badge>
                <Button aria-label="Release concierge actions" size="icon-sm" variant="ghost">
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </div>
              <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
                <Avatar className="bg-avatar-surface">
                  <AvatarFallback className="bg-avatar-surface font-semibold text-avatar-foreground">QA</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">QA companion</p>
                  <p className="truncate text-sm text-muted-foreground">Turns approved checklists into repeatable runs.</p>
                </div>
                <Badge variant="outline">Draft</Badge>
                <Button aria-label="QA companion actions" size="icon-sm" variant="ghost">
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card">
            <CardHeader>
              <CardTitle>Build a new teammate</CardTitle>
              <CardDescription>Start with a clear identity, then grant only the capabilities it needs.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">1</span>
                  <div><p className="font-medium">Name the role</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">Make its purpose legible in a channel roster.</p></div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">2</span>
                  <div><p className="font-medium">Choose capabilities</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">Keep connection and posting access explicit.</p></div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">3</span>
                  <div><p className="font-medium">Review before launch</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">A human approves the final configuration.</p></div>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button className="w-full">
                <WandSparkles aria-hidden="true" />
                Start setup
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </AgentFrame>
  );
}

function AgentIdentityPage() {
  return (
    <AgentFrame step="identity">
      <AgentPageHeader
        description="Give the agent a stable identity people can understand before it receives any access."
        eyebrow="New agent / Step 1 of 3"
        step="identity"
        title="Define the agent"
      />
      <div className="space-y-5 p-5 sm:p-8">
        <AgentStepper current={0} />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Identity and role</CardTitle>
              <CardDescription>These details are visible anywhere the agent participates.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField defaultValue="Release concierge" className="space-y-2">
                  <Label>Display name</Label>
                  <Input />
                </TextField>
                <TextField defaultValue="release-concierge" className="space-y-2">
                  <Label>Handle</Label>
                  <Input />
                </TextField>
              </div>
              <TextField defaultValue="Summarizes launch channels and prepares concise handoffs for the team." className="space-y-2">
                <Label>Description</Label>
                <Textarea rows={3} />
              </TextField>
              <Select aria-label="Agent harness" defaultSelectedKey="codex">
                <Label>Harness</Label>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem id="codex">Codex</SelectItem>
                  <SelectItem id="claude">Claude Code</SelectItem>
                </SelectContent>
              </Select>
              <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
                <div className="flex items-start gap-3">
                  <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 text-primary" />
                  <div><p className="font-medium">Identity is not authorization</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Capabilities and connections are reviewed separately in the next steps.</p></div>
                </div>
              </div>
            </CardContent>
            <CardFooter className="justify-between gap-3">
              <Button variant="ghost">Save draft</Button>
              <Button>
                Continue
                <ArrowRight aria-hidden="true" />
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>How this agent will appear to teammates.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-2xl border border-border bg-message-surface p-4">
                <div className="flex items-start gap-3">
                  <Avatar className="bg-avatar-surface">
                    <AvatarFallback className="bg-avatar-surface font-semibold text-avatar-foreground">RC</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">Release concierge</p>
                      <Badge variant="agent"><Sparkles aria-hidden="true" />agent</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">@release-concierge · Codex</p>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-6 text-message-foreground">Summarizes launch channels and prepares concise handoffs for the team.</p>
              </div>
              <div className="mt-5 space-y-3 text-sm">
                <p className="font-medium">Next up</p>
                <div className="flex items-center gap-2 text-muted-foreground"><LockKeyhole aria-hidden="true" className="size-4" />Channel and connection grants</div>
                <div className="flex items-center gap-2 text-muted-foreground"><ShieldCheck aria-hidden="true" className="size-4" />Human review before activation</div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AgentFrame>
  );
}

const permissions = [
  { label: 'Read approved channel history', detail: 'Context for summaries and handoffs', icon: Users },
  { label: 'Post in selected channels', detail: 'Only #general and #launch-planning', icon: Sparkles },
  { label: 'Use approved connections', detail: 'No credentials enter the agent prompt', icon: KeyRound },
];

function AgentReviewPage() {
  return (
    <AgentFrame step="review">
      <AgentPageHeader
        description="Check the identity and grants together. Activation stays separate from configuration."
        eyebrow="New agent / Step 3 of 3"
        step="review"
        title="Review before activation"
      />
      <div className="space-y-5 p-5 sm:p-8">
        <AgentStepper current={2} />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>Agent identity</CardTitle>
                <CardAction><Button size="sm" variant="outline">Edit</Button></CardAction>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-3">
                  <Avatar className="bg-avatar-surface">
                    <AvatarFallback className="bg-avatar-surface font-semibold text-avatar-foreground">RC</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><p className="font-semibold">Release concierge</p><Badge variant="agent">agent</Badge></div>
                    <p className="mt-1 text-sm text-muted-foreground">@release-concierge · Codex</p>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-message-foreground">Summarizes launch channels and prepares concise handoffs for the team.</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Capability grants</CardTitle>
                <CardDescription>Each grant is narrow, visible, and revocable.</CardDescription>
                <CardAction><Button size="sm" variant="outline">Edit</Button></CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                {permissions.map(({ detail, icon: Icon, label }) => (
                  <div key={label} className="flex items-start gap-3 rounded-xl border border-border bg-card px-3 py-3">
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-primary"><Icon aria-hidden="true" className="size-4" /></span>
                    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{label}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</p></div>
                    <Badge variant="secondary">Allowed</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card className="self-start">
            <CardHeader>
              <CardTitle>Ready for review</CardTitle>
              <CardDescription>The agent is still inactive until a human approves this exact setup.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl border border-primary/35 bg-primary/5 p-3">
                <div className="flex items-start gap-3">
                  <Check aria-hidden="true" className="mt-0.5 size-4 text-primary" />
                  <div><p className="text-sm font-medium">No blocking warnings</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Identity, grants, and harness are complete.</p></div>
                </div>
              </div>
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Status</dt><dd><Badge variant="outline">Draft</Badge></dd></div>
                <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Channels</dt><dd className="font-medium">2 selected</dd></div>
                <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Connections</dt><dd className="font-medium">0 granted</dd></div>
              </dl>
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-2">
              <Button>
                Submit for review
                <ArrowRight aria-hidden="true" />
              </Button>
              <Button variant="ghost"><ArrowLeft aria-hidden="true" />Back to permissions</Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </AgentFrame>
  );
}

export function AgentCreationPreview({ className, step = 'identity' }: { className?: string; step?: AgentCreationStep }) {
  return (
    <div className={cn(className)}>
      {step === 'directory' && <AgentDirectoryPage />}
      {step === 'identity' && <AgentIdentityPage />}
      {step === 'review' && <AgentReviewPage />}
    </div>
  );
}
