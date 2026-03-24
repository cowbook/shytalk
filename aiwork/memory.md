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
