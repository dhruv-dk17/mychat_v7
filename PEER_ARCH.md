# Mychat v7 P2P Architecture

This document describes the high-level design of the messaging pipeline, tab-scoped identity model, encrypted transport, and room-call negotiation flow.

## 1. Top-Level Flow

Mychat uses WebRTC through PeerJS for peer discovery and transport. The backend supports room registration, password checks, and encrypted permanent-room history, but live message delivery stays peer-to-peer.

### Layers

1. Signaling Layer: PeerJS coordinates peer discovery and WebRTC session setup.
2. Identity Layer: every tab session generates an ephemeral ECDSA keypair, and the tab is identified by a `peerId` derived from the public key.
3. Security Layer: payloads are signed with ECDSA and encrypted with AES-GCM.
4. Transport Layer: reliable data channels carry encrypted events, and media connections carry audio/video streams.

## 2. Messaging Pipeline

### Sending a Message

1. Generate a message `id`, timestamp, and sequence number.
2. Canonicalize the payload and sign it with the tab's private key.
3. Encrypt the signed payload with the shared room key.
4. Send the encrypted payload through PeerJS, either directly or through the room host relay.

### Receiving a Message

1. Decrypt the payload with the current room key or an allowed fallback key.
2. Verify the signature and confirm the claimed `senderPeerId` matches the attached public key.
3. Drop replayed or out-of-order payloads using per-sender sequence tracking.
4. Render the message as outgoing or incoming by comparing the signed `senderPeerId` with the local tab identity.

## 3. Identity and Tab Isolation

- Identity keys are stored per tab in `sessionStorage`, not shared `localStorage`.
- This keeps duplicated tabs from reusing one sender identity and prevents the "both sides show my own message" bug.
- File sharing, receipts, and normal chat messages all rely on the same signed sender identity.

## 4. Room Call Flow

Room calls use the existing data channel for coordination and PeerJS media connections for camera/mic streams.

### Signaling Events

- `room_call_invite`: announces a live room call and includes the current call ID plus the current participant list.
- `room_call_join`: sent after a participant accepts the invite and enters the call.
- `room_call_leave`: sent when a participant leaves but the rest of the call continues.
- `room_call_end`: sent when the current call is ended for everyone.
- `room_call_state`: lightweight state sync for mute and camera status.

### Media Negotiation Rule

- Calls are capped at 6 simultaneous video participants.
- To avoid duplicate PeerJS media offers, the participant with the lexicographically lower `senderPeerId` initiates the media connection for each pair.
- This creates a deterministic full-mesh pattern for the supported participant cap.

### Join and Mid-Call Behavior

1. A participant starts a room call, creates a `callId`, and broadcasts `room_call_invite`.
2. Other participants accept the invite and broadcast `room_call_join`.
3. Existing participants compare peer IDs and open media connections only for peers they are responsible for dialing.
4. New participants joining the room while a call is active receive a fresh invite announcement and can join without resetting the rest of the call.

### UI Behavior

- Remote participants render as a responsive grid of tiles.
- One tile can be pinned to a larger layout by click or double-click.
- The local camera preview is shown in a movable picture-in-picture card.
- Status pills show joined, muted, camera-off, and reconnecting states.
- The active speaker ring is driven by client-side audio level sampling on remote streams.

## 5. Room Modes

- Private Room: direct P2P messaging and room calls.
- Group Room: host-relayed messaging plus mesh-based room calls for up to 6 video participants.
- Permanent Room: stable relay behavior for room membership plus encrypted rolling history and room calls.
