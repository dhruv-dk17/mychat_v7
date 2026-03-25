# Mychat v7

Privacy-first, zero-trace, real-time P2P communication. Built on WebRTC via PeerJS — messages never touch a server.

## Features

- **Private Room** — Direct P2P, 2 people, blur shield privacy overlay
- **Group Room** — Up to 50 participants, star topology via host relay  
- **Permanent Room** — Custom room ID registered permanently (password protected, stored in PostgreSQL)
- **File Sharing** — Any file type up to 25MB, chunked via DataChannel
- **Voice Messages** — Hold to record, waveform preview, playback
- **Voice Calling** — Audio-only, WebRTC SRTP encrypted
- **Reactions** — 6 emoji, synced across all peers
- **Self-destructing Messages** — 30s to 1hr timer, synced delete
- **Anti-surveillance** — 10 subsystems (blur shield, screenshot detect, devtools detect, emergency wipe, etc.)
- **Message Search** — In-memory, highlights matches
- **Dark/Light Mode** — sessionStorage persisted

## Architecture

All chat is P2P via PeerJS/WebRTC. The backend stores only permanent room slugs and hashed passwords — no messages, no IPs, no usernames.

## Local Development

```bash
# Backend
cd backend
cp .env.example .env
# Edit .env with your local PostgreSQL credentials
npm install
npm run dev    # uses nodemon

# Frontend
# Simply open frontend/index.html in your browser
```

## Deploy to Render.com (Free Forever)

1. Push project to GitHub
2. Go to [render.com](https://render.com) → Sign up with GitHub  
3. Dashboard → **New → Blueprint** → Connect your repo
4. Render reads `render.yaml` → creates 1 web service + 1 PostgreSQL database
5. Render prompts you for `ADMIN_SECRET` during setup
6. Wait ~3 minutes for deploy
7. Open the web service URL and use the app from there

See `DOCUMENTATION.md` for full feature reference.

## Security

- Messages: RAM only, gone on disconnect
- Passwords: SHA-256 hashed in browser before leaving device  
- Backend: One table (`rooms`), four columns, nothing else
- Transport: WebRTC DTLS (text) + SRTP (voice)
- CORS: Locked to Render frontend URL only
