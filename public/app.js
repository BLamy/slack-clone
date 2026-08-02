import {
  applicationApiEvents,
  applicationApiFetch,
} from "./application-api.js";

const params = new URLSearchParams(window.location.search);
const room = normalizeRoom(params.get("room") || "durable-streams-demo");
const autopilot = params.get("autopilot") === "1";
const closeWhenDone = params.get("close") === "1";
const expectedCount = Number(params.get("expect") || "0");
const autopilotMessage =
  params.get("message") ||
  `Replay check-in at ${new Date().toLocaleTimeString()}`;

const state = {
  editingDraft: "",
  editingMessageId: null,
  messages: new Map(),
  sentAutopilot: false,
  session: null,
};

const messagesEl = document.querySelector("[data-testid='messages']");
const formEl = document.querySelector("[data-testid='composer']");
const inputEl = document.querySelector("[data-testid='message-input']");
const sendButton = document.querySelector("[data-testid='send-button']");
const connectionStateEl = document.querySelector(
  "[data-testid='connection-state']",
);
const personaLabelEl = document.querySelector("[data-testid='persona-label']");
const authProviderEl = document.querySelector("[data-testid='auth-provider']");
const authUserEl = document.querySelector("[data-testid='auth-user']");
const streamPathEl = document.querySelector("[data-testid='stream-path']");
const streamOffsetEl = document.querySelector("[data-testid='stream-offset']");
const streamDigestEl = document.querySelector("[data-testid='stream-digest']");

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

messagesEl.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest("button[data-message-action]");
  const messageEl = button?.closest("[data-message-id]");
  const messageId = messageEl?.dataset.messageId;
  if (!button || !messageId) return;

  if (button.dataset.messageAction === "edit") {
    startEditing(messageId);
  } else if (button.dataset.messageAction === "cancel-edit") {
    stopEditing();
  }
});

messagesEl.addEventListener("input", (event) => {
  const target =
    event.target instanceof HTMLTextAreaElement ? event.target : null;
  if (target?.dataset.testid === "edit-message-input") {
    state.editingDraft = target.value;
  }
});

messagesEl.addEventListener("submit", (event) => {
  const target = event.target instanceof HTMLFormElement ? event.target : null;
  if (!target?.matches("[data-message-edit-form]")) return;
  event.preventDefault();
  const messageId = target.dataset.messageId;
  if (messageId) void saveMessage(messageId);
});

init();

function normalizeRoom(value) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "durable-streams-demo"
  );
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
    const res = await applicationApiFetch(
      `/api/rooms/${encodeURIComponent(room)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );
    const body = await res.json();
    if (!res.ok || !body.ok)
      throw new Error(body.error || "Failed to send message");
    setConnectionState("live");
  } catch (err) {
    setConnectionState(err instanceof Error ? err.message : String(err));
  } finally {
    sendButton.disabled = false;
    inputEl.focus();
  }
}

async function init() {
  const res = await applicationApiFetch("/api/session");
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
  const events = applicationApiEvents(
    `/api/rooms/${encodeURIComponent(room)}/events`,
  );

  events.addEventListener("open", () => {
    setConnectionState("live");
  });

  events.addEventListener("snapshot", (event) => {
    const payload = JSON.parse(event.data);
    streamPathEl.textContent = payload.stream;
    streamOffsetEl.textContent = payload.nextOffset;
    streamDigestEl.textContent = payload.streamDigest;
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
    streamDigestEl.textContent = payload.streamDigest;
  });

  events.addEventListener("reset", (event) => {
    const payload = JSON.parse(event.data);
    state.messages.clear();
    streamOffsetEl.textContent = payload.nextOffset;
    streamDigestEl.textContent = payload.streamDigest;
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
  const messages = [...state.messages.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  if (messages.length === 0) {
    messagesEl.innerHTML = `<div class="empty">No messages yet. Start the durable stream by sending the first one.</div>`;
    return;
  }

  messagesEl.innerHTML = messages.map(renderMessage).join("");
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(message) {
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const isEditing = state.editingMessageId === message.id;
  const isSaving = state.savingMessageId === message.id;
  const isOwn = isOwnMessage(message);
  const editedLabel = message.editedAt
    ? `<span class="message__edited" data-testid="message-edited">(edited)</span>`
    : "";
  const actions =
    isOwn && !isEditing
      ? `<div class="message__actions">
        <button class="message__action" type="button" data-message-action="edit" aria-label="Edit message">Edit</button>
      </div>`
      : "";
  const content = isEditing
    ? `<form class="message__edit-form" data-message-edit-form data-message-id="${escapeAttr(message.id)}">
        <label class="visually-hidden" for="edit-message-input">Edit message</label>
        <textarea id="edit-message-input" data-testid="edit-message-input" rows="2" ${isSaving ? "disabled" : ""}>${escapeHtml(state.editingDraft)}</textarea>
        <div class="message__edit-actions">
          <button class="message__edit-button message__edit-button--save" type="submit" ${isSaving ? "disabled" : ""}>${isSaving ? "Saving..." : "Save"}</button>
          <button class="message__edit-button" type="button" data-message-action="cancel-edit" ${isSaving ? "disabled" : ""}>Cancel</button>
        </div>
      </form>`
    : `<div class="message__text">${escapeHtml(message.text)}</div>`;

  return `
    <article class="message" data-testid="message" data-message-id="${escapeAttr(message.id)}">
      <div class="message__avatar">${escapeHtml(initials(message.user))}</div>
      <div>
        <div class="message__meta">
          <span class="message__user">${escapeHtml(message.user)}</span>
          <span class="message__time">${escapeHtml(time)}</span>
          ${editedLabel}
          ${actions}
        </div>
        ${content}
      </div>
    </article>
  `;
}

function isOwnMessage(message) {
  const user = state.session?.user;
  if (!user) return false;
  if (message.actorId) return Boolean(user.sub && message.actorId === user.sub);
  return Boolean(message.email && user.email && message.email === user.email);
}

function startEditing(messageId) {
  const message = state.messages.get(messageId);
  if (!message || !isOwnMessage(message)) return;
  state.editingMessageId = messageId;
  state.editingDraft = message.text;
  render();
  const editInput = document.querySelector(
    "[data-testid='edit-message-input']",
  );
  editInput?.focus();
  editInput?.select();
}

function stopEditing() {
  state.editingMessageId = null;
  state.editingDraft = "";
  state.savingMessageId = null;
  render();
}

async function saveMessage(messageId) {
  const text = state.editingDraft.trim();
  if (!text) return;

  state.savingMessageId = messageId;
  render();
  try {
    const res = await applicationApiFetch(
      `/api/rooms/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );
    const body = await res.json();
    if (!res.ok || !body.ok)
      throw new Error(body.error || "Failed to edit message");
    if (body.message) state.messages.set(body.message.id, body.message);
    state.editingMessageId = null;
    state.editingDraft = "";
    state.savingMessageId = null;
    setConnectionState("live");
    render();
  } catch (err) {
    state.savingMessageId = null;
    render();
    setConnectionState(err instanceof Error ? err.message : String(err));
  }
}

function maybeRunAutopilot() {
  if (!autopilot || state.sentAutopilot) return;
  state.sentAutopilot = true;
  setTimeout(
    () => {
      void sendMessage(autopilotMessage).then(maybeFinishAutopilot);
    },
    Number(params.get("delay") || "500"),
  );
}

function maybeFinishAutopilot() {
  if (!autopilot) return;

  const messages = [...state.messages.values()];
  const userName =
    state.session?.user?.name || state.session?.user?.email || "";
  const hasOwnMessage = messages.some(
    (message) => message.user === userName && message.text === autopilotMessage,
  );
  const hasExpectedCount =
    expectedCount > 0 ? messages.length >= expectedCount : hasOwnMessage;

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
