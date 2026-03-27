# Mychat v7

Privacy-first real-time communication built on WebRTC/PeerJS, now hardened for production-facing use with signed peer identity, stricter API validation, scoped abuse controls, rolling encrypted room history, CI, and container tooling.

## Highlights

- Signed Ed25519 peer identities persisted in the browser
- AES-GCM room encryption plus signed transport envelopes
- Bcrypt-backed password and owner-token storage with legacy-hash upgrade
- Scoped rate limits and stricter slug, username, timestamp, and message validation
- Heartbeat timeout detection and reconnect support for permanent rooms
- Health and metrics endpoints at `/api/health` and `/api/health/metrics`
- TURN/STUN override support with `window.__MYCHAT_ICE_SERVERS__`
- GitHub Actions CI, Docker image, and local Docker Compose stack

## Local Run

```bash
docker compose up --build
```

For manual development, run the backend from `backend/` and open `frontend/index.html` separately.

## Infra Gaps Still Outside This Repo

- Dedicated TURN deployment such as `coturn`
- SFU architecture for large group media scaling
- External monitoring stack such as Prometheus/Grafana
- Separate staging/production environments with managed secrets

<<<<<<< HEAD
See `DOCUMENTATION.md` for the broader architecture and implementation notes.
=======
See `DOCUMENTATION.md` for full feature reference.

## Security

- Messages: RAM only, gone on disconnect
- Passwords: SHA-256 hashed in browser before leaving device  
- Backend: One table (`rooms`), four columns, nothing else
- Transport: WebRTC DTLS (text) + SRTP (voice)
- CORS: Locked to Render frontend URL only

---



## The Journey
(v1 to v7): We started as a basic WebRTC prototype and evolved into a hardened, zero-trust operations platform. The architecture shifted from basic sockets to a STUN/TURN mesh network, eliminating server dependencies and moving to a purely ephemeral, RAM-only state. We integrated 10 layers of anti-surveillance tech, DOM-safe searches, exponential backoff, and Bcrypt security—all while keeping hosting costs at absolute **$0**.

>>>>>>> 0c1f0ca1c71a966bb8dcbdf41ee8e2db5e2b246a
