import { ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react';

import { BrandMark } from '@/components/stream/brand-mark';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const defaultReturnTo = '/app?room=demo';
const auth0EmulatorUrl = import.meta.env.VITE_AUTH0_EMULATOR_URL ?? 'http://127.0.0.1:4101';

function safeReturnTo(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return defaultReturnTo;
  return value;
}

export function LoginPage() {
  const searchParams = new URLSearchParams(window.location.search);
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const error = searchParams.get('error');

  return (
    <main className="min-h-screen bg-message-surface px-4 py-5 text-foreground sm:px-8 sm:py-8">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <BrandMark />
        <div className="flex items-center gap-2">
          <LinkButton href="/" size="sm" variant="ghost"><ArrowLeft aria-hidden="true" />Home</LinkButton>
          <ThemeSwitcher compact />
        </div>
      </header>
      <div className="mx-auto grid min-h-[calc(100svh-7rem)] max-w-6xl items-center gap-10 py-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(24rem,0.72fr)] lg:gap-20">
        <section className="max-w-xl">
          <Badge variant="outline" className="gap-1.5 border-agent-border bg-agent-surface text-agent-foreground"><ShieldCheck aria-hidden="true" />Local identity boundary</Badge>
          <h1 className="mt-5 font-display text-4xl font-semibold tracking-[-0.065em] sm:text-6xl">Come back to the room.</h1>
          <p className="mt-5 text-base leading-7 text-muted-foreground sm:text-lg">Sign in through the local Auth0 emulator to open a durable Stream Slack conversation.</p>
          <div className="mt-8 grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4"><p className="font-semibold text-foreground">Ada Lovelace</p><p className="mt-1">ada@example.test</p></div>
            <div className="rounded-xl border border-border bg-card p-4"><p className="font-semibold text-foreground">Linus Torvalds</p><p className="mt-1">linus@example.test</p></div>
          </div>
        </section>

        <Card className="mx-auto w-full max-w-md bg-card shadow-sm">
          <CardHeader>
            <span className="grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground"><KeyRound aria-hidden="true" className="size-5" /></span>
            <CardTitle className="mt-4 text-2xl">Sign in to Stream Slack</CardTitle>
            <CardDescription>Credentials are checked by the local Auth0 emulator at <code data-testid="auth0-emulator-url" className="break-all text-xs">{auth0EmulatorUrl}</code>.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="min-h-16" aria-live="polite" data-testid="login-error-slot">
              {error && <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" data-testid="login-error" role="alert">{error}</div>}
            </div>
            <form method="post" action="/login" data-testid="login-form" className="space-y-4">
              <input type="hidden" name="returnTo" value={returnTo} />
              <label className="grid gap-2 text-sm font-medium" htmlFor="email-input">
                Email
                <Input id="email-input" data-testid="email-input" name="email" autoComplete="username" placeholder="ada@example.test" />
              </label>
              <label className="grid gap-2 text-sm font-medium" htmlFor="password-input">
                Password
                <Input id="password-input" data-testid="password-input" name="password" type="password" autoComplete="current-password" defaultValue="DemoPass123" />
              </label>
              <Button className="w-full" data-testid="login-button" type="submit" size="lg">Sign in with Auth0 emulator</Button>
            </form>
            <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">Use a seeded account above with password <code>DemoPass123</code>.</p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
