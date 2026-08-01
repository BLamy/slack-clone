import { ArrowRight, Bot, Check, Database, LockKeyhole, Radio, ShieldCheck, Sparkles } from 'lucide-react';

import { BrandMark } from '@/components/stream/brand-mark';
import { WorkspacePreview } from '@/components/stream/workspace-preview';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const demoPath = '/app?room=demo';
const loginPath = `/login?returnTo=${encodeURIComponent(demoPath)}`;

const features = [
  {
    icon: Radio,
    title: 'Live by default',
    body: 'Durable Streams keeps the conversation append-only and makes updates visible in every connected session.',
  },
  {
    icon: Bot,
    title: 'Agents as teammates',
    body: 'Humans and agents share the same workspace language, with room for runs, approvals, and provenance.',
  },
  {
    icon: ShieldCheck,
    title: 'Clear trust boundaries',
    body: 'Auth0, stream offsets, and capability-aware surfaces stay visible without crowding the conversation.',
  },
];

export function HomePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-5 px-4 sm:h-[4.5rem] sm:px-8">
          <BrandMark />
          <nav aria-label="Primary navigation" className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
            <a className="transition-colors hover:text-foreground" href="#features">Why Stream Slack</a>
            <a className="transition-colors hover:text-foreground" href="#stack">The stack</a>
            <a className="transition-colors hover:text-foreground" href="#try">Demo room</a>
          </nav>
          <div className="flex items-center gap-2">
            <LinkButton href={loginPath} size="sm" variant="outline">Sign in</LinkButton>
            <ThemeSwitcher compact />
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:items-center lg:gap-16">
          <div className="max-w-2xl">
            <Badge variant="outline" className="mb-5 gap-1.5 border-agent-border bg-agent-surface text-agent-foreground">
              <Check aria-hidden="true" />
              React Aria + shadcn workspace
            </Badge>
            <h1 className="font-display text-4xl font-semibold tracking-[-0.065em] text-foreground sm:text-6xl">
              Slack-style room backed by BLamy/emulate.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
              Calm collaboration for human and agent teammates, with durable messages, explicit identity, and an interface built to keep important state understandable.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <LinkButton data-testid="home-open-chat" href={demoPath} size="lg">
                Open demo room
                <ArrowRight aria-hidden="true" />
              </LinkButton>
              <LinkButton href="#features" size="lg" variant="outline">
                Explore the model
              </LinkButton>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2"><Database aria-hidden="true" className="size-3.5 text-link" />Durable Streams authority</span>
              <span className="inline-flex items-center gap-2"><LockKeyhole aria-hidden="true" className="size-3.5 text-link" />Auth0 emulator boundary</span>
            </div>
          </div>
          <WorkspacePreview className="min-h-[500px]" />
        </section>

        <section id="features" className="border-y border-border bg-message-surface px-4 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-link">A workspace for real state</p>
              <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.05em] sm:text-5xl">A shared room with durable edges.</h2>
              <p className="mt-4 text-base leading-7 text-muted-foreground">The first slice is intentionally small: a two-user room, an emulator-backed identity layer, and enough metadata to make the stream interrogable.</p>
            </div>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {features.map(({ body, icon: Icon, title }) => (
                <Card key={title} className="bg-card/80">
                  <CardHeader>
                    <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground"><Icon aria-hidden="true" className="size-5" /></span>
                    <CardTitle className="mt-4 text-lg">{title}</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-sm leading-6 text-muted-foreground">{body}</CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section id="stack" className="mx-auto grid max-w-7xl gap-8 px-4 py-16 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.72fr)] lg:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-link">The architecture</p>
            <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.05em] sm:text-5xl">The server stays the boundary.</h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">React owns the interaction layer and token system. Node continues to own auth, API, SSE, and the production static boundary.</p>
            <div className="mt-7 flex flex-wrap gap-2">
              <Badge variant="secondary"><Sparkles aria-hidden="true" />React Aria behavior</Badge>
              <Badge variant="secondary"><Database aria-hidden="true" />Durable Streams</Badge>
              <Badge variant="secondary"><ShieldCheck aria-hidden="true" />Auditable identity</Badge>
            </div>
          </div>
          <dl className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="grid gap-1 border-b border-border p-5"><dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Client</dt><dd className="font-mono text-sm">React 19 + Vite + shadcn/aria</dd></div>
            <div className="grid gap-1 border-b border-border p-5"><dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Runtime</dt><dd className="font-mono text-sm">Node auth, API, SSE, static bundle</dd></div>
            <div className="grid gap-1 p-5"><dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Authority</dt><dd className="font-mono text-sm">Durable Streams source records</dd></div>
          </dl>
        </section>

        <section id="try" className="bg-sidebar px-4 py-14 text-sidebar-foreground sm:px-8 sm:py-16">
          <div className="mx-auto flex max-w-7xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sidebar-accent">Try the room</p>
              <h2 className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">Open a durable conversation.</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-sidebar-muted">Use the seeded Auth0 accounts to open two sessions and watch messages move between them.</p>
            </div>
            <Button className="shrink-0 bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent/85" onPress={() => { window.location.href = demoPath; }} size="lg">
              Enter demo room
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
