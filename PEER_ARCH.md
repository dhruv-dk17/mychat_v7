# MyChat v7 P2P Architecture

This document describes the high-level design of the Peer-to-Peer (P2P) messaging pipeline, identity management, and End-to-End Encryption (E2EE) implementation.

## 1. Top-Level Flow

MyChat is a "zero-knowledge, zero-server" platform. Messages are exchanged directly between participants using WebRTC without ever passing through a centralized message store.

### Layers:
1.  **Signaling Layer (PeerJS)**: Coordinates the initial discovery. Tabs find each other by connecting to a shared Room ID.
2.  **Identity Layer (ECDSA)**: Every tab session generates ephemeral elliptic-curve keys. Each tab is uniquely identified by a `peerId` (SHA256 fingerprint of its public key).
3.  **Security Layer (E2EE)**: Payloads are encrypted via AES-GCM and signed via ECDSA.
4.  **Transport Layer**: Reliable DataChannels carry the encrypted binary/JSON blobs.

---

## 2. Messaging Pipeline

### Sending a Message
1.  **Prepare**: Generate a unique message `id` and `ts`.
2.  **Sign**: Canonicalize the message and sign it with the tab's **private key**. 
    - The signature and the **public key** are attached to the payload.
3.  **Encrypt**: The entire signed payload is encrypted using the `roomKey` (AES-GCM).
4.  **Transmit**: Send the encrypted string via PeerJS to either the Host (relay mode) or all peers (direct mode).

### Receiving a Message
1.  **Decrypt**: Decrypt the blob using the shared `roomKey`. If decryption fails, the message is dropped (indicating someone switched rooms or has the wrong key).
2.  **Verify Signature**: Check that the message was signed by the key claimed in the payload.
3.  **Anti-Replay & Order**: Compare the message's `sequenceNumber` against the `lastSequenceSeen` for that specific sender. If the number is old or already processed, the message is dropped.
4.  **Identity Check**: `isOwnMessage()` compares the `senderPeerId` from the signature against the local `peerId` to decide if the bubble should be rendered on the right (sent) or left (received).

---

## 3. Reliability & Security

### Sequential Transport
Since Web Crypto (AES-GCM) is asynchronous, MyChat uses an internal **Outbound Queue** in `peer.js`. This ensures that even if encryption for Message B finishes faster than Message A, Message A always hits the wire first. This preserves the strict sequence numbers required for anti-replay verification.

### Tab Isolation
Identity keys are **ephemeral** and stored only in RAM (or cleared from sessionStorage on load). This prevents "cloned" tabs (duplicated tabs) from sharing the same identity and causing UI glitches where messages appear sent by oneself in both tabs.

---

## 4. Room Modes
-   **Private Room**: Direct P2P.
-   **Group Room**: Host acts as a "blind relay," moving traffic between guests without being able to modify the signatures (which are verified guest-to-guest).
-   **Permanent Room**: A stable relay point is used for participants to join asynchronously.
