# Mychat v7 Documentation

## Overview

Mychat v7 is a privacy-first communication app with WebRTC transport for private and group rooms plus encrypted rolling history for permanent rooms. The production-hardening pass in this repo adds signed browser identities, stronger validation, route-level abuse controls, health/metrics reporting, reconnect handling, and deployment scaffolding.

## Current Security Model

- Browser clients generate persistent Ed25519 identities and sign outbound message envelopes.
- Peer IDs are derived from the hash of the exported public key.
- Room payloads are encrypted with AES-GCM before transport or storage.
- Permanent-room credentials and owner tokens are stored as bcrypt hashes on the backend.
- Legacy stored hashes are upgraded automatically after successful verification.
- Express routes enforce stricter validation for slugs, usernames, timestamps, and persisted message metadata.
- Helmet, CORS restrictions, and route/global rate limits are enabled on the API.

## Operational Endpoints

- `GET /api/health`
  Returns API status, DB reachability, timestamp, and in-memory metrics snapshot.
- `GET /api/health/metrics`
  Returns the in-memory request and event counters used for lightweight observability.

## Deployment

- `backend/Dockerfile` builds the backend service container.
- `docker-compose.yml` provides a local backend + PostgreSQL stack.
- `.github/workflows/ci.yml` runs backend install and test on pushes and pull requests.

## Remaining Infrastructure Work

These roadmap items still require external infrastructure or bigger architecture changes beyond an in-repo patch:

- Dedicated TURN infrastructure such as `coturn`
- SFU for large-room media scaling such as LiveKit, mediasoup, or Janus
- Prometheus/Grafana or equivalent external monitoring
- Separate staging/production environments, secret management, and rollout policy

## Notes

- Group-room media still follows the existing host-relay model; this repo does not introduce an SFU.
- TURN support is configurable from the frontend via `window.__MYCHAT_ICE_SERVERS__`, but production credentials must come from your deployment environment.
- Permanent room history remains capped to a rolling 7-day retention window.
