# Commit Notes

## 2026-03-24
- Scaffolded ShyTalk full-stack project (Vue 3 + Node.js 22 + WebSocket + SQLite).
- Implemented register/login with persistent local credential cache and browser-side key handling.
- Added encrypted contact chat with text, emoji, and image support.
- Added mobile-first UX: tab navigation, contact/chat/profile panes, unread badges, and message previews.
- Added deployment files and documentation: Dockerfile, README, and production serving setup.
- Added message read tracking endpoint and unread count support in contact list APIs.
- Added chat option `[] 自动清除` default enabled: when enabled, opening a conversation loads only unread incoming messages.
- Added message lifecycle UI states for outgoing messages: `发送中` / `已送达` / `已读`.
- Added read receipt websocket event handling and optimistic local sending with client IDs.
- Added image fullscreen preview overlay from chat bubbles.
- Added PWA support (manifest + service worker + install prompt) for add-to-home-screen on mobile.
- Added GitHub Actions CI workflow for automatic build checks.
- Added one-click Ubuntu deployment script with Caddy HTTPS reverse proxy.

## 2026-03-25
- Added user profile fields and migrations: nickname, avatar_url, gender, bio.
- Added 10 preset cute avatar options and auto-assigned a random avatar at registration.
- Added profile APIs to fetch and update nickname/avatar/gender/bio with validation.
- Included avatar and nickname in user/contact payloads for frontend display.
- Updated mobile UI to show avatars in sidebar and contact list.
- Added profile editor with avatar picker, gender selector, nickname, and bio editing.
- Changed default backend/deploy/runtime port from 3000 to 4000 across server, Vite proxy, Dockerfile, Caddy, deploy script, and README.
- Added webhook endpoint `POST /api/webhook` to force-update local source on GitHub push (`git fetch` + `git reset --hard` + `git clean -fd`).
- Adjusted webhook behavior to not require webhook secret verification; kept branch and optional repo name filters.
- Refactored message sending path: added HTTP send endpoint `POST /api/messages/:username`, keeping WebSocket for realtime notifications/receipts.
- Added WebSocket auto-reconnect with backoff and removed hard dependency on socket-ready for sending messages.
- Changed conversation opening default to load only unconfirmed messages (`read_at IS NULL`) with `unconfirmedOnly=1`.
- Updated auth behavior: disabled auto-login, only remembers username, manual password entry required every login.
- Added logout flow end-to-end: backend `/api/auth/logout` + frontend logout button in profile page and local/session cleanup.
- Updated chat composer UX to compact inline layout, right-aligned actions, pill-shaped send button, and icon-style image trigger.
- Added expandable composer tools: default hidden; circular toggle button reveals emoji row with image button on upper line.
- Synced major UI theme updates to pink palette and refined compact form controls.
- Pushed all above changes to GitHub `main`.
	- Commit: `607537e`
	- Message: `feat: update chat UX, auth flow, webhook, and default port`
- Updated webhook deploy flow to non-blocking async mode: immediate GitHub response, then background pull/install/build and service self-restart.
- Improved mobile chat UX: hide bottom tab bar while draft textarea is focused.
- Fixed iOS keyboard focus layout issue by preventing horizontal overflow and avoiding focus zoom side effects in chat composer.
