---
name: QR invite PeerId fix
description: How local_peer_id() is exposed from Rust through JNI to Kotlin for complete libp2p multiaddrs in QR invites
---

## Rule
A libp2p dial requires `/p2p/<peerId>` on the multiaddr to authenticate the remote via the noise handshake. Without it, `connect()` either fails or (worse) connects to the wrong peer.

**Why:** The dial succeeds TCP/QUIC connection, but noise rejects the remote if the PeerId doesn't match the expected key.

## Implementation
- `p2p_runtime.rs`: `static LOCAL_PEER_ID: OnceLock<RwLock<String>>` — set to `peer_id.to_base58()` in `run_swarm` immediately after `PeerId::from(keys.public())`, cleared in `stop()`.
- `pub fn local_peer_id() -> String` — thread-safe read, returns empty string when swarm stopped.
- `jni_bridge.rs`: `Java_com_equilibrium_P2PNode_getLocalPeerId` — returns the string via `env.new_string()`.
- `P2PNode.kt`: `external fun getLocalPeerId(): String` — call after `isRunning()` returns true.

## Invite URI format
```
equilibrium://bootstrap?addr=/ip4/<wifiIP>/tcp/9000/p2p/<peerId>
```
IP selection order (lowest priority number = preferred):
- 0: 192.168.x.x — home/office WiFi
- 1: 10.0.2.x    — emulator host alias
- 2: 10.x.x.x    — corporate LAN
- 3: 172.x.x.x   — Docker/cellular NAT

## Deprecated API replacement
`IntentIntegrator` + `onActivityResult` → `registerForActivityResult(ScanContract(), callback)` + `barcodeLauncher.launch(ScanOptions())`. Must be registered as a class-level property (before `onCreate` returns).
