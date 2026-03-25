# Mychat v7 — Full Documentation

## Overview

Mychat v7 is a privacy-first, real-time P2P communication web app. All chat is peer-to-peer via WebRTC DataChannels — **no messages ever touch the server**. The backend only stores permanent room registrations (slug + hashed password + hashed owner token).

---

## Architecture

```
Users → HTTPS
  ├── Render Static Site     (frontend/ — index.html, chat.html, assets/)
  ├── Render Web Service     (backend/ — 4 API endpoints only)
  └── Render PostgreSQL      (1 table: rooms — slug, hashes, timestamp)

All chat: WebRTC P2P via PeerJS CDN
All voice: WebRTC SRTP (encrypted by spec)
```

---

## File Structure

```
mychat_v7/
├── frontend/
│   ├── index.html              # Home page
│   ├── chat.html               # Chat room page
│   └── assets/
│       ├── css/
│       │   ├── main.css        # Design system (variables, buttons, modals, toasts)
│       │   ├── home.css        # Home page layout & cards
│       │   ├── chat.css        # Chat room layout & bubbles
│       │   └── anti-surveillance.css # Blur shield, print block, wipe screen
│       └── js/
│           ├── config.js       # All constants (API URL, timeouts, limits)
│           ├── crypto.js       # sha256, AES-GCM, HMAC, randomToken, escHtml
│           ├── rooms.js        # API calls, PeerJS ID helpers, room creation
│           ├── peer.js         # P2P connection management, auth, relay, ping
│           ├── chat.js         # Text messages, reactions, context menu, search
│           ├── media.js        # File sharing, voice recording, voice calling
│           ├── surveillance.js # 10 anti-surveillance subsystems
│           ├── ui.js           # Toasts, modals, navigation, cold start, sound
│           └── app.js          # Entry point, event listeners, page init
├── backend/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── server.js           # Express + CORS + helmet + rate limit
│       ├── db/database.js      # PostgreSQL pool, initDB (creates rooms table)
│       ├── middleware/validate.js # validateSlug, validateHash
│       └── routes/
│           ├── rooms.js        # 4 endpoints
│           └── health.js       # GET /api/health
├── render.yaml                 # Render blueprint (1 web service + PostgreSQL)
├── .gitignore
└── README.md
```

---

## Room Types

### Private Room
- 2 people maximum (direct P2P)
- No password required
- Temporary — room only exists while host is connected
- Room ID is a 6-char random alphanumeric string

### Group Room  
- Up to 50 participants
- Star topology: host is hub, relays all messages to/from guests
- Host election: if host disconnects, peer with lowest peer ID alphabetically becomes new host
- Temporary — same as private

### Permanent Room
- Custom slug (3-8 chars, a-z 0-9)
- Password protected — SHA-256 hashed in browser before API call
- Double verification: guest must pass both API check AND host P2P check
- Stored in PostgreSQL indefinitely (free 1GB forever on Render)
- Owner token: 64-byte random hex, SHA-256 hashed before storing. Raw token shown only once at registration — save it!

---

## P2P Connection Flow

### Host
1. `initAsHost()` → creates `Peer(hostPeerId)` via PeerJS
2. Listens for `connection` events from guests
3. Each incoming connection: waits for `auth` message → validates → sends `auth_ok` or `auth_fail`
4. Maintains `connectedPeers` Map, broadcasts user list after every join/leave

### Guest
1. `initAsGuest()` → creates `Peer(guestPeerId)` → connects to host peer ID
2. On open: sends `{ type: "auth", username, [passwordHash] }`
3. On `auth_ok`: connection is live, receives user list from host
4. On `auth_fail`: shows toast, redirects home

### Message Relay (Group)
- Host broadcasts directly to all peers
- Guests send `{ type: "relay", payload: originalMessage }` to host, who relays to all others
- `broadcastOrRelay()` wrapper handles this automatically

---

## Message Types (DataChannel)

| type | description |
|------|-------------|
| `msg` | Text message |
| `file_meta` | File transfer metadata (name, size, mimeType, totalChunks) |
| `file_chunk` | One chunk of a file (base64, 16KB) |
| `voice_msg` | Voice recording (base64 webm audio) |
| `clear_chat` | Clear all messages for everyone |
| `typing` | Typing indicator |
| `ping` / `pong` | Latency measurement |
| `reaction` | Emoji reaction on a message |
| `delete_msg` | Delete a specific message |
| `screenshot_attempt` | Alert peers of screenshot detection |
| `devtools_detected` | Alert peers of DevTools open |
| `kick` / `force_mute` / `promote` | Host actions |
| `room_locked` | New connections rejected |
| `room_end` | Host ending room for all |
| `user_list` | Host broadcasts full participant list |
| `relay` | Wrapper for guest→guest via host |
| `auth` / `auth_ok` / `auth_fail` | Authentication flow |

---

## Anti-Surveillance System (10 Subsystems)

1. **Blur Shield** — Chat is hidden behind a blur overlay whenever the tab is not active, window loses focus, or cursor leaves the window. User taps to dismiss.

2. **Screenshot Key Detection** — PrintScreen, Alt+PrintScreen, macOS Cmd+Shift+3/4/5 and more are intercepted. Activates blur + notifies all peers. 3 strikes = emergency wipe.

3. **CSS Anti-Capture** — `.msg-text` has a sub-pixel letter-spacing animation at 0.15s that is invisible to the human eye but disrupts screenshot timing on many capture tools.

4. **DevTools Detection** — Checks `outerWidth - innerWidth` and `outerHeight - innerHeight` every 2 seconds. If DevTools appear to be open, blur activates and peers are alerted.

5. **Screen Capture API Override** — `navigator.mediaDevices.getDisplayMedia` is replaced with a function that throws `NotAllowedError` and triggers screenshot detection logic.

6. **Mouse Leave Detection** — When cursor exits the browser window (e.g. to take a screenshot via OS tool), blur shield activates immediately.

7. **Right-click + Copy Disable** — `contextmenu`, `dragstart`, and Ctrl+C/A key combos are blocked within the chat feed element.

8. **Print Block** — `@media print` hides all body content and shows a protection message. `beforeprint` event also activates blur shield.

9. **Self-Destructing Messages** — Timer set via context menu (30s to 1hr). When timer fires, `sendDeleteMessage()` removes locally and broadcasts `delete_msg` to all peers. Countdown visible in message timestamp.

10. **Emergency Auto-Wipe** — If screenshot strikes reach `MAX_SCREENSHOT_STRIKES` (default 3): stops all media streams, destroys all peer connections, clears message array, revokes all blob URLs, clears sessionStorage, shows wipe screen, redirects home.

---

## Backend API

### `GET /api/health`
Returns `{ status: "ok", db: "connected", ts: ..., v: "7" }` or 503 if DB is down.
Used for cold start detection and 14-minute keep-alive pings.

### `GET /api/rooms/check/:slug`
Returns `{ available: true/false }`. Validates slug format (3-8 chars, a-z0-9).

### `POST /api/rooms/register`
Body: `{ slug, passwordHash, ownerTokenHash }` (all hashed in browser).  
Rate limited: 5 registrations per IP per hour.  
Returns `{ success: true, slug }` or error.

### `POST /api/rooms/verify-password`
Body: `{ slug, passwordHash }`.  
Returns `{ valid: true/false }`.  
Uses timing-safe comparison to prevent timing attacks.

### `POST /api/rooms/verify-owner`
Body: `{ slug, ownerTokenHash }`.  
Returns `{ valid: true/false }`.

---

## Security Summary

| What | How |
|------|-----|
| Message confidentiality | WebRTC DTLS (built-in transport encryption) |
| Voice confidentiality | WebRTC SRTP (built-in) |
| Password storage | SHA-256 one-way hash in browser, never plaintext |
| Owner token | 64-byte random hex, SHA-256 before DB |
| Hash comparison | Timing-safe character-by-character XOR |
| Backend exposure | CORS locked to Render frontend URL |
| Payload attacks | express.json limit 10kb |
| Rate limiting | 60/min global, 5/hour on registration |
| Proxy trust | `trust proxy 1` for correct Render IP detection |
| localStorage | **Never used** — sessionStorage only (cleared on tab close) |
| Database contents | Only: slug, passwordHash, ownerTokenHash, created_at |

---

## Render Deploy Steps

1. Push project root to GitHub (must include `render.yaml` at root)
2. Render.com → Dashboard → **New → Blueprint** → Connect repo
3. Render auto-creates 1 web service plus PostgreSQL
4. Enter the `ADMIN_SECRET` value when Render prompts you
5. Wait ~3 min
6. Open the web service URL
6. `git push` → frontend redeploys in ~30s

### Cold Start
Render free tier spins down after 15 mins of inactivity.
- **Keep-alive**: Every page pings `/api/health` every 14 minutes (prevents sleep while app is open)
- **Cold start banner**: On page load, if health check times out in 2s, amber banner with animated progress bar shows. Auto-hides when backend responds.

---

## Configuration (`config.js`)

| Key | Default | Description |
|-----|---------|-------------|
| `API_BASE` | (your Render URL) | Backend API URL |
| `MAX_FILE_SIZE_MB` | 25 | Max file transfer size |
| `CHUNK_SIZE_BYTES` | 16384 | DataChannel chunk size |
| `ROOM_ID_LENGTH` | 6 | Temp room ID length |
| `MAX_SCREENSHOT_STRIKES` | 3 | Before emergency wipe |
| `PING_INTERVAL_MS` | 10000 | Peer latency ping rate |
| `TYPING_DEBOUNCE_MS` | 2000 | Typing indicator debounce |
| `VOICE_MAX_MS` | 300000 | Max voice recording (5 min) |
| `MAX_GROUP_SIZE` | 50 | Max group participants |
| `KEEPALIVE_MS` | 840000 | Keep-alive ping (14 min) |
