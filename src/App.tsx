import { lazy, Suspense } from 'react';

import { ThemeProvider } from '@/components/theme-provider';

const ChatPage = lazy(async () => {
  const module = await import('@/pages/chat-page');
  return { default: module.ChatPage };
});

const HomePage = lazy(async () => {
  const module = await import('@/pages/home-page');
  return { default: module.HomePage };
});

const LoginPage = lazy(async () => {
  const module = await import('@/pages/login-page');
  return { default: module.LoginPage };
});

function RouteFallback() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground" aria-busy="true">
      <p className="text-sm text-muted-foreground">Loading Stream Slack…</p>
    </main>
  );
}

function route() {
  const pathname = window.location.pathname.replace(/\/$/, '') || '/';
  const params = new URLSearchParams(window.location.search);
  if (pathname === '/login') return <LoginPage />;
  if (pathname === '/app' || pathname === '/app.html' || (pathname === '/' && params.has('room'))) {
    return <ChatPage room={params.get('room') ?? 'durable-streams-demo'} />;
  }
  return <HomePage />;
}

export function App() {
  return (
    <ThemeProvider>
      <Suspense fallback={<RouteFallback />}>{route()}</Suspense>
    </ThemeProvider>
  );
}
