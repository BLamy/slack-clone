const params = new URLSearchParams(window.location.search);
const room = normalizeRoom(params.get("room") || "durable-streams-demo");
const autopilot = params.get("autopilot") === "1";
const closeWhenDone = params.get("close") === "1";
const expectedCount = Number(params.get("expect") || "0");
const autopilotMessage = params.get("message") || `Replay check-in at ${new Date().toLocaleTimeString()}`;

const state = {
  messages: new Map(),
  sentAutopilot: false,
  session: null,
};

const messagesEl = document.querySelector("[data-testid='messages']");
const formEl = document.querySelector("[data-testid='composer']");
const inputEl = document.querySelector("[data-testid='message-input']");
const sendButton = document.querySelector("[data-testid='send-button']");
const connectionStateEl = document.querySelector("[data-testid='connection-state']");
const personaLabelEl = document.querySelector("[data-testid='persona-label']");
const authProviderEl = document.querySelector("[data-testid='auth-provider']");
const authUserEl = document.querySelector("[data-testid='auth-user']");
const streamPathEl = document.querySelector("[data-testid='stream-path']");
const streamOffsetEl = document.querySelector("[data-testid='stream-offset']");

document.querySelector("[data-testid='room-label']").textContent = room;
document.querySelector("[data-testid='header-room']").textContent = room;
inputEl.placeholder = `Message #${room}`;
window.__demoComplete = false;

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  await sendMessage(text);
});

init();

function normalizeRoom(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "durable-streams-demo";
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

async function sendMessage(text) {
  sendButton.disabled = true;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || "Failed to send message");
  } catch (err) {
    setConnectionState(err instanceof Error ? err.message : String(err));
  } finally {
    sendButton.disabled = false;
    inputEl.focus();
  }
}

async function init() {
  const res = await fetch("/api/session", { credentials: "include" });
  if (res.status === 401) {
    window.location.href = `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    return;
  }

  const body = await res.json();
  if (!body.ok) throw new Error(body.error || "Failed to load session");
  state.session = body;

  const userName = body.user.name || body.user.email || "Authenticated User";
  personaLabelEl.textContent = userName;
  authUserEl.textContent = body.user.email || userName;
  authProviderEl.textContent = `${body.provider.name} (${body.provider.url})`;

  connect();
}

function connect() {
  setConnectionState("connecting");
  const events = new EventSource(`/api/rooms/${encodeURIComponent(room)}/events`);

  events.addEventListener("open", () => {
    setConnectionState("live");
  });

  events.addEventListener("snapshot", (event) => {
    const payload = JSON.parse(event.data);
    streamPathEl.textContent = payload.stream;
    streamOffsetEl.textContent = payload.nextOffset;
    state.messages.clear();
    for (const message of payload.messages) {
      state.messages.set(message.id, message);
    }
    render();
    maybeRunAutopilot();
  });

  events.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    state.messages.set(message.id, message);
    render();
    maybeFinishAutopilot();
  });

  events.addEventListener("status", (event) => {
    const payload = JSON.parse(event.data);
    streamPathEl.textContent = payload.stream;
    streamOffsetEl.textContent = payload.nextOffset;
  });

  events.addEventListener("reset", () => {
    state.messages.clear();
    render();
  });

  events.addEventListener("error", (event) => {
    if (event.data) {
      const payload = JSON.parse(event.data);
      setConnectionState(payload.message || "stream error");
    } else {
      setConnectionState("reconnecting");
    }
  });
}

function setConnectionState(value) {
  connectionStateEl.textContent = value;
  document.body.dataset.connection = value;
}

function render() {
  const messages = [...state.messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (messages.length === 0) {
    messagesEl.innerHTML = `<div class="empty">No messages yet. Start the durable stream by sending the first one.</div>`;
    return;
  }

  messagesEl.innerHTML = messages.map(renderMessage).join("");
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(message) {
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `
    <article class="message" data-testid="message" data-message-id="${escapeAttr(message.id)}">
      <div class="message__avatar">${escapeHtml(initials(message.user))}</div>
      <div>
        <div class="message__meta">
          <span class="message__user">${escapeHtml(message.user)}</span>
          <span class="message__time">${escapeHtml(time)}</span>
        </div>
        <div class="message__text">${escapeHtml(message.text)}</div>
      </div>
    </article>
  `;
}

function maybeRunAutopilot() {
  if (!autopilot || state.sentAutopilot) return;
  state.sentAutopilot = true;
  setTimeout(() => {
    void sendMessage(autopilotMessage).then(maybeFinishAutopilot);
  }, Number(params.get("delay") || "500"));
}

function maybeFinishAutopilot() {
  if (!autopilot) return;

  const messages = [...state.messages.values()];
  const userName = state.session?.user?.name || state.session?.user?.email || "";
  const hasOwnMessage = messages.some((message) => message.user === userName && message.text === autopilotMessage);
  const hasExpectedCount = expectedCount > 0 ? messages.length >= expectedCount : hasOwnMessage;

  if (hasOwnMessage && hasExpectedCount) {
    window.__demoComplete = true;
    document.body.dataset.demoState = "complete";
    setConnectionState("complete");
    if (closeWhenDone) {
      setTimeout(() => window.close(), 1000);
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
