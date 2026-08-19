# Stream Slack component inventory

This is the starting map for Frontend Epic 0. A row is a component contract, not a
promise that every variant ships in the first connected page. Stories should make the
states visible before implementation is promoted into application composition.

## Foundations and visual language

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `ThemeProvider` | light, dark, system, persisted reload, OS preference change | foundation ready |
| `ThemeSwitcher` | compact, full label, keyboard select, current selection | foundation ready |
| `BrandMark` | full, compact, light surface, dark sidebar | foundation ready |
| `Typography` | display, heading, body, metadata, code, long content | planned |
| `Surface` / `Card` | default, raised, muted, agent, destructive | planned |
| `Separator` / `DateDivider` | horizontal, vertical, today, older date | partial |
| `Kbd` / `ShortcutHint` | single key, chord, compact sidebar hint | planned |
| `FocusRing` | light, dark, keyboard-only, high-contrast | planned |

## Actions, identity, and status

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `Button` | primary, secondary, outline, ghost, link, destructive; xs–lg; icon; loading; disabled | foundation ready |
| `IconButton` | tooltip, selected, destructive, disabled, mobile toolbar | planned |
| `ButtonGroup` | adjacent actions, split action, responsive wrap | planned |
| `Badge` | live, draft, public, agent, destructive, count, icon | foundation ready |
| `StatusDot` | online, away, busy, offline, unknown; labeled and unlabeled | planned |
| `Avatar` | human, agent, fallback initials, image error, sizes, presence | foundation ready |
| `AvatarGroup` | two, many, overflow count, mixed principal types | planned |
| `Tooltip` | short label, keyboard focus, delayed, edge placement | generated |
| `Progress` / `Spinner` | determinate, indeterminate, compact inline | planned |

## Fields and forms

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `Label` | required, optional, disabled, description association | generated |
| `Input` | empty, filled, focus, disabled, invalid, read-only, prefix/suffix | generated |
| `Textarea` | composer, multiline, max length, invalid, disabled | generated |
| `TextField` | label, description, validation, async validation, required | planned |
| `SearchField` | empty, query, clear, keyboard shortcut, no results | planned |
| `PasswordField` | hidden, visible, invalid, strength hint | planned |
| `Select` | single, grouped, disabled, invalid, long options, mobile width | generated |
| `Combobox` | channel search, mention search, loading, no results, create option | planned |
| `ListBox` / `Option` | focus, selected, disabled, sections, keyboard movement | planned |
| `Checkbox` / `CheckboxGroup` | checked, indeterminate, error, disabled, mixed values | planned |
| `RadioGroup` | provider choice, selected, disabled, invalid | planned |
| `Switch` | enabled, disabled, loading, destructive confirmation | planned |
| `Slider` | budget, volume, min/max, keyboard increment | planned |
| `FileUpload` | empty, drag over, uploading, success, rejected | planned |
| `FieldMessage` | description, error, warning, success, live region | planned |

## Navigation and overlays

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `WorkspaceSwitcher` | one workspace, many workspaces, create workspace | planned |
| `Sidebar` | expanded, collapsed, mobile drawer, unread counts, ring-free surface | partial |
| `SidebarSection` | expanded, collapsed, add action, empty | partial |
| `NavItem` | active, hover, focus, unread, locked, agent channel | partial |
| `ChannelList` / `ChannelItem` | public, private, DM, unread, muted, active | partial |
| `UserMenu` | available, away, settings, sign out | planned |
| `Tabs` | channel sections, keyboard movement, overflow, disabled | planned |
| `Breadcrumbs` | workspace, channel, thread, narrow truncation | planned |
| `DropdownMenu` | actions, destructive action, shortcut, disabled | generated |
| `ContextMenu` | message actions, pointer and keyboard invocation | planned |
| `Popover` | mention picker, help, anchored edge placement | generated |
| `Tooltip` | action hints and keyboard focus | generated |
| `Dialog` | review, settings, confirm, long content, dismissal | generated |
| `AlertDialog` | delete, revoke, leave channel, exact action confirmation | planned |
| `Sheet` / `Drawer` | mobile sidebar, thread panel, filters | planned |
| `CommandPalette` | search, keyboard shortcuts, grouped commands, no results | planned |
| `Toast` / `Notification` | success, error, undo, persistent, live announcement | planned |

## Workspace and channel surfaces

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `WorkspaceShell` | desktop, tablet, mobile, narrow sidebar | partial |
| `WorkspaceHeader` | channel title, description, members, huddle, overflow | planned |
| `ChannelHeader` | public/private/DM, topic, unread state, actions | planned |
| `MemberRoster` | humans, agents, presence, loading, empty | planned |
| `ConnectionState` | connected, connecting, reconnecting, offline, error | planned |
| `UnreadDivider` | unread count, new message, keyboard navigation | planned |
| `TypingIndicator` | one, many, agent working, reduced motion | planned |

## Messaging surfaces

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `MessageCard` | human, agent, edited, neutral surface, owner actions, hover/focus | foundation ready |
| `MessageHeader` | author, timestamp, edited, agent badge, verified marker | partial |
| `MessageBody` | plain text, links, code, long wrap, mention highlight | planned |
| `MessageActions` | edit, delete, reply, react, more; owner/non-owner, confirmation | foundation ready |
| `Reaction` / `ReactionPicker` | none, one, many, selected, overflow | planned |
| `ThreadPanel` | empty, active, replies, unread, selected agent run, mobile sheet | foundation ready |
| `ThreadMessage` | root, reply, nested metadata, agent response trigger | foundation ready |
| `Composer` | empty, focused, text, multiline, sending, disabled, error | planned |
| `ComposerToolbar` | attachment, emoji, mention, formatting, shortcuts | planned |
| `MentionAutocomplete` | humans, agents, loading, no results, keyboard selection | planned |
| `AttachmentCard` | image, file, upload, rejected, permission denied | planned |
| `LinkPreview` | loading, resolved, unavailable, external link warning | planned |
| `MessageEditForm` | editing, save, cancel, invalid, conflict | foundation ready |

## Agent and run surfaces

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `AgentDirectory` | active, draft, empty, actions, responsive | foundation ready |
| `AgentCreationWizard` | identity, permissions, review, current/completed steps | foundation ready |
| `AgentIdentityForm` | display name, handle, description, harness, preview | foundation ready |
| `AgentPermissionReview` | grants, warnings, draft, submit-for-review, dark mode | foundation ready |
| `AgentBadge` / `AgentAvatar` | enabled, disabled, owner, harness label | planned |
| `AgentRunLogPanel` | empty selection, selected response, timeline, tool calls, redacted raw log, mobile | foundation ready |
| `RunStatusBadge` | queued, running, waiting approval, succeeded, failed, canceled | partial |
| `RunTimeline` | pending, streaming, tool call, approval, terminal | partial |
| `ToolCallCard` | read, write, blocked, approval required, redacted args | partial |
| `ApprovalCard` | exact request, approve, reject, expired, changed digest | planned |
| `RunControls` | cancel, retry, open details, disabled by state | planned |
| `ArtifactCard` | diff, log, image, link, checksum, unavailable | planned |
| `ProvenanceReference` | stream offset, digest, source link, copied state | planned |
| `AuditEvent` | actor, action, result, redaction, timestamp | planned |

## Front door and administration

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `Hero` | desktop, mobile, primary CTA, secondary CTA | planned |
| `FeatureCard` | icon, metric, agent capability, responsive grid | planned |
| `LoginForm` | empty, seeded users, invalid credentials, loading, stable error | planned |
| `DemoUserPicker` | Ada, Linus, keyboard selection, unavailable | planned |
| `ProviderCard` | Codex, Claude, Fly, AlmostNode reach label | planned |
| `ProviderPicker` | selected, capability list, unavailable, warning | planned |
| `ConnectionCard` | connected, needs auth, revoked, policy summary | planned |
| `PolicyRule` | allow, deny, approval, destination, scope | planned |
| `PermissionMatrix` | human/agent roles, read/write/admin, disabled cells | planned |
| `Wizard` / `Stepper` | steps, current, complete, blocked, mobile | planned |
| `ReviewSummary` | config, grants, warnings, exact diff | planned |

## Feedback and resilient states

| Component | Stories and variants | Initial status |
| --- | --- | --- |
| `Skeleton` | sidebar, message, card, table, reduced motion | planned |
| `EmptyState` | no channels, no search, no messages, no agents | planned |
| `ErrorState` | retryable, auth, permission, unknown, support link | planned |
| `InlineBanner` | info, warning, destructive, success, dismissible | planned |
| `OfflineBanner` | offline, reconnecting, reconnected announcement | planned |
| `NotFound` | route, channel, message, recovery CTA | planned |
| `ConfirmAction` | destructive, exact request, loading, failure | planned |

## Review matrix

Every component task should add stories from the applicable matrix:

| Dimension | Required cases |
| --- | --- |
| Theme | light, dark, system preference, persisted selection |
| Interaction | default, hover, keyboard focus, pressed/selected, disabled |
| Async | loading, success, retryable failure, terminal failure |
| Content | short, long, empty, overflow, localized-length placeholder |
| Viewport | 360px mobile, 768px tablet, 1280px desktop |
| Accessibility | role/name, label association, focus return, live status, reduced motion |
