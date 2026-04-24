# Security

## Overview

Mychat keeps live room traffic peer-to-peer where possible and encrypts permanent-room history in the browser before upload. The UI now treats display names, room aliases, contact labels, search snippets, and message-adjacent metadata as untrusted input and renders them through safe DOM APIs in the main user-facing paths.

## Security Guarantees

- Live room payloads are encrypted client-side before transport.
- Permanent-room history is encrypted client-side before backend storage.
- Identity keys are generated and stored locally in the browser.
- Payload envelopes are signed and fingerprint-linked to the sender identity.
- Pinned third-party browser dependencies are integrity-checked with SRI.
- Outbound navigation is hardened with `noopener noreferrer`.
- Primary chat, participant, contact, and conversation surfaces no longer rely on HTML-string interpolation for untrusted labels.

## Threat Model

This repository is hardened against:

- Stored or reflected XSS through room aliases, display names, message previews, contacts, or search results.
- CDN tampering of pinned browser-side dependencies.
- Tabnabbing or `window.opener` abuse from new-tab navigation.
- Backend compromise exposing stored permanent-room history ciphertext.

It does not fully protect against:

- A compromised endpoint, browser extension, or operating system.
- OS-level screenshots or cameras pointed at the screen.
- Deliberate secret sharing by a participant.
- Metadata leakage inherent to signaling, timing, and room/account identifiers.
- Denial-of-service or peer availability attacks.

## Zero-Knowledge Boundary

“Zero-knowledge” in this project is limited to permanent-room message confidentiality at rest on the backend:

- The backend stores ciphertext plus limited sync metadata.
- The room password remains the browser-side decryption secret.
- The server can still observe metadata such as room IDs, timestamps, account actions, and request volume.

## Frontend Hardening Notes

- Display names and room aliases are normalized before storage and routing.
- Third-party assets currently protected with SRI:
  - Google Fonts stylesheet used by the HTML entrypoints
  - `jsQR`
  - `QRCode.js`
  - lazy-loaded `PeerJS`
- Duplicate external font loading through CSS import has been removed so the HTML-level SRI remains authoritative.

## Maintenance Rules

- Keep CDN URLs pinned to exact versions and update the SRI hash whenever a dependency changes.
- Prefer DOM node construction over `innerHTML` for any user-controlled content.
- Re-run the hardening grep and automated tests after changing renderers or third-party loading paths.
