import { ThemeProvider } from '@/components/theme-provider';
import { ChatPage } from '@/pages/chat-page';
import { HomePage } from '@/pages/home-page';
import { LoginPage } from '@/pages/login-page';

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
  return <ThemeProvider>{route()}</ThemeProvider>;
}
