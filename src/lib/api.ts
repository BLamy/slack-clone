export type MessageRecord = {
  id: string;
  room: string;
  user: string;
  email: string;
  text: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
};

export type Session = {
  ok: true;
  user: {
    sub?: string;
    name?: string;
    email?: string;
    preferredUsername?: string;
  };
  provider: {
    name: string;
    url: string;
  };
};

export type StreamSnapshot = {
  messages: MessageRecord[];
  stream: string;
  durableStreamsUrl: string;
  nextOffset: string;
};

export type StreamStatus = Pick<StreamSnapshot, 'stream' | 'durableStreamsUrl' | 'nextOffset'> & {
  clients: number;
};

export function normalizeRoom(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'durable-streams-demo';
}

export function materializeMessages(records: MessageRecord[]) {
  const latest = new Map<string, MessageRecord>();
  for (const record of records) {
    if (!record || typeof record.id !== 'string') continue;
    latest.set(record.id, record);
  }

  return [...latest.values()]
    .filter((message) => !message.deletedAt)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function parseResponse<T>(response: Response) {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; ok?: boolean };
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error ?? `Request failed with status ${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return body;
}

export async function fetchSession() {
  const response = await fetch('/api/session', { credentials: 'include' });
  if (response.status === 401) return null;
  return parseResponse<Session>(response);
}

export async function postMessage(room: string, text: string) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text }),
  });
  return parseResponse<{ ok: true; message: MessageRecord; nextOffset: string }>(response);
}

export async function patchMessage(room: string, messageId: string, text: string) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text }),
  });
  return parseResponse<{ ok: true; message: MessageRecord; nextOffset: string }>(response);
}

export async function removeMessage(room: string, messageId: string) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  return parseResponse<{ ok: true; message: MessageRecord; nextOffset: string }>(response);
}

export function subscribeToRoom(
  room: string,
  handlers: {
    onOpen: () => void;
    onSnapshot: (snapshot: StreamSnapshot) => void;
    onMessage: (message: MessageRecord) => void;
    onStatus: (status: StreamStatus) => void;
    onReset: () => void;
    onError: (message?: string) => void;
  },
) {
  const events = new EventSource(`/api/rooms/${encodeURIComponent(room)}/events`);
  const parseEvent = <T,>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;

  events.addEventListener('open', handlers.onOpen);
  events.addEventListener('snapshot', (event) => handlers.onSnapshot(parseEvent<StreamSnapshot>(event)));
  events.addEventListener('message', (event) => handlers.onMessage(parseEvent<MessageRecord>(event)));
  events.addEventListener('status', (event) => handlers.onStatus(parseEvent<StreamStatus>(event)));
  events.addEventListener('reset', handlers.onReset);
  events.addEventListener('error', (event) => {
    const data = (event as MessageEvent<string>).data;
    handlers.onError(data ? parseEvent<{ message?: string }>(event).message : undefined);
  });

  return () => events.close();
}
