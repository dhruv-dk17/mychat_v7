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

See `DOCUMENTATION.md` for the broader architecture and implementation notes.
