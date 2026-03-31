# Mychat v7

Privacy-first real-time communication built on WebRTC and PeerJS, with encrypted room history, signed peer identity, and a redesigned premium chat interface.

## Highlights

- Signed peer identity per browser tab
- AES-GCM room encryption with signed transport envelopes
- Private, group, and password-protected operations rooms
- Rolling encrypted 7-day history for permanent rooms
- Multi-participant room calling with a 6-person video cap
- 100 MB file transfer limit
- Health endpoints, Docker support, and CI tooling

## Local Run

```bash
docker compose up --build
```

For manual development, run the backend from `backend/` and open `frontend/index.html` separately.

## Security Notes

- Messages are encrypted in transit between participants and room history is stored encrypted for permanent rooms.
- Passwords are hashed in the browser before they are sent to the backend.
- The app uses privacy masks, blur shields, and suspicious-activity reactions to reduce casual observation.
- The app does **not** enforce OS-level screenshot blocking or prevent unauthorized captures at the operating system level.

## Infra Gaps Still Outside This Repo

- Dedicated TURN deployment such as `coturn`
- SFU infrastructure for large-scale media routing
- External monitoring stack such as Prometheus/Grafana
- Separate staging and production environments with managed secrets

See `DOCUMENTATION.md` for broader product and architecture notes.
