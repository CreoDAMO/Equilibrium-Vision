# Equilibrium Vision — QR Invite, SPV Bridge & Mobile App Analysis

**Date:** 2026-08-04
**Scope:** QR invite implementation gaps, full SPV feasibility, mobile vs web app architecture

---

## Why the QR Invite Isn't Working in the Field

The QR code **is** implemented in `BootstrapQrActivity.kt`, but three real problems prevent it from working:

### 1. The QR is on a separate screen
You have to tap **"Join Network (QR / Share)"** on `MainActivity` to open `BootstrapQrActivity`. The QR isn't on the main screen. The user flow is:

1. Start P2P node
2. Tap **Join Network**
3. See QR

### 2. The invite URI has no PeerId
Your `buildMyInviteUri()` generates:

```
equilibrium://bootstrap?addr=%2Fip4%2F192.168.x.x%2Ftcp%2F9000
```

A libp2p dial needs the **PeerId** to authenticate the remote peer. Without `/p2p/<peer-id>` on the multiaddr, `connect()` may fail or connect to the wrong peer. The Rust side has the PeerId after swarm start — it's just not exposed to Kotlin.

### 3. IP detection prefers mobile data over WiFi
`getLocalIpv4()` walks `NetworkInterface` and returns the first non-loopback IPv4. On a phone with mobile data active, this often returns the **cellular IP** (10.x.x.x or 172.x.x.x), which is NAT'd and unreachable from another phone on the same WiFi. The other phone can't dial it.

### 4. Silent failure if ZXing isn't bundled
`showMyQr()` catches all exceptions and sets `qrImage` to null. If the ZXing `BarcodeEncoder` isn't in the APK (ProGuard/R8 stripped it, or the dependency is missing), the QR simply disappears with no error message.

---

## The Fix: Complete QR Implementation

### A. Expose PeerId from Rust → Kotlin

**`equilibrium/src/p2p_runtime.rs`** — add:

```rust
/// Return this node's PeerId as a base58 string, or empty if swarm not started.
pub fn local_peer_id() -> String {
    SWARM.with(|s| {
        s.borrow().as_ref()
         .map(|swarm| swarm.local_peer_id().to_base58())
         .unwrap_or_default()
    })
}
```

**`equilibrium/src/jni_bridge.rs`** — add:

```rust
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_P2PNode_getLocalPeerId(
    env: JNIEnv,
    _obj: JObject,
) -> jstring {
    let id = p2p_runtime::local_peer_id();
    env.new_string(&id)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
```

**`P2PNode.kt`** — add:

```kotlin
@JvmStatic
external fun getLocalPeerId(): String
```

### B. Prefer WiFi IP, fallback to all interfaces

Replace `getLocalIpv4()` in `BootstrapQrActivity.kt`:

```kotlin
private fun getLocalIpv4(): String? {
    val interfaces = NetworkInterface.getNetworkInterfaces()?.toList() ?: return null

    // Prefer WiFi (wlan) first, then other non-cellular, then anything
    val preferred = interfaces
        .flatMap { it.inetAddresses?.toList() ?: emptyList() }
        .filter { !it.isLoopbackAddress && it is java.net.Inet4Address }
        .sortedBy { addr ->
            val name = (addr as java.net.InetAddress).hostAddress ?: ""
            when {
                name.startsWith("192.168.") -> 0   // Home WiFi — best
                name.startsWith("10.") -> 1        // Corporate / mobile NAT
                name.startsWith("172.") -> 2       // Docker / cellular
                else -> 3
            }
        }
        .firstOrNull()

    return preferred?.hostAddress
}
```

### C. Build complete invite URI with PeerId

```kotlin
private fun buildMyInviteUri(): String {
    val ip = getLocalIpv4() ?: run {
        statusView.text = "No local IP — connect to WiFi first"
        return ""
    }
    val peerId = P2PNode.getLocalPeerId()
    if (peerId.isEmpty()) {
        statusView.text = "P2P node not started — tap 'Start embedded P2P node' first"
        return ""
    }
    val multiaddr = "/ip4/$ip/tcp/9000/p2p/$peerId"
    return "equilibrium://bootstrap?addr=" + Uri.encode(multiaddr)
}
```

### D. Show error instead of blank QR on failure

```kotlin
private fun showMyQr() {
    val uri = buildMyInviteUri()
    if (uri.isEmpty()) return  // error already shown in statusView

    runCatching {
        val bitmap = BarcodeEncoder().encodeBitmap(uri, BarcodeFormat.QR_CODE, 512, 512)
        qrImage.setImageBitmap(bitmap)
        statusView.text = "Scan this QR from another Equilibrium device"
    }.onFailure { e ->
        qrImage.setImageDrawable(null)
        statusView.text = "QR generation failed: ${e.message}"
    }
}
```

---

## Full SPV Bridge: Can It Be Implemented Completely?

**Short answer:** Not without a multi-month program that touches consensus, foreign-chain light clients, and economic security. The current commit (`2e33ab1`) is the **honest boundary**.

| Layer | Current (`2e33ab1`) | Full SPV | Effort |
|-------|---------------------|----------|--------|
| **BLS aggregate** | ✅ Done | Still needed | — |
| **Merkle inclusion** | ✅ Done (SHA-256) | Still needed | — |
| **Foreign header chain** | ❌ Relayer-submitted root only | Light client sync (BTC headers / ETH sync committee) | 2–3 months |
| **Receipt proof format** | ❌ Plain SHA-256 tree | BTC double-SHA or EVM Patricia trie | 1–2 months each |
| **Challenge game** | ❌ None | Fraud proof + bond slashing | 1 month |
| **Economic security** | ❌ Relayer reputation | Staked relayers + slashing conditions | 2 weeks |

### What "full SPV" actually means

1. The **contract** independently verifies that a foreign-chain header is valid (Bitcoin: chain of PoW headers; Ethereum: sync committee signatures)
2. The **contract** verifies that a specific receipt/log is included in that header's Merkle tree
3. A **challenge window** lets honest parties dispute invalid headers with a fraud proof
4. Relayers are **bonded** and slashed for lying

Your current implementation stops at step 2's Merkle check — but step 1 (foreign header validity) is delegated to the relayer. That's correctly documented in LIMITATIONS §12.

### Can you add it without breaking anything?

**Yes, incrementally.** Each foreign chain needs its own adapter:
- `btc_spv_bridge` module already has header storage — extend it to verify header chain PoW
- `eth_spv_bridge` would need SSZ + sync committee verification (BLS12-381 on BN254 is hard)
- Keep the BLS + Merkle path as fallback for chains without full SPV

### Recommendation

Don't chase full SPV now. The honest scope you have (BLS aggregate + Merkle inclusion under a submitted root) is already stronger than most bridges. Document it honestly and move to **field-proving the P2P mesh** — that's the visible milestone.

---

## Mobile App vs Web App

| | Mobile (Android) | Web (Explorer) |
|---|---|---|
| **Purpose** | Mining node + P2P mesh participant | Block explorer + wallet + governance |
| **Stack** | Kotlin + JNI + Rust libp2p | React + Vite + TypeScript API |
| **UI density** | Minimal — start/stop, peer count, QR | Rich — charts, tables, 3D timeline |
| **Wallet** | No embedded wallet UI | Full self-custody wallet |
| **Contracts** | No direct UI | Deploy, call, view storage |
| **DEX** | No direct UI | Swap, add liquidity, arbitrage panel |

They're intentionally different: the phone is a **node**, the web app is a **dashboard**. If you want the phone to also show explorer features, that's a separate product decision — not a bug.

---

## Immediate Next Steps

1. **Add the PeerId JNI method** and rebuild the Rust lib
2. **Update `buildMyInviteUri()`** to include PeerId + better IP selection
3. **Rebuild APK** and test phone-to-phone on the same WiFi
4. **Leave full SPV for later** — it's a roadmap item, not a weekend fix

---

*Generated from session analysis. Edit and adapt to your repo structure.*
