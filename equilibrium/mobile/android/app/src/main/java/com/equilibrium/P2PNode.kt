package com.equilibrium

import android.net.Uri

/**
 * Thin Android facade over the Rust in-process libp2p node.
 *
 * Bootstrap invites are intentionally plain, shareable URIs:
 *   equilibrium://bootstrap?addr=%2Fip4%2F...
 *
 * The same URI can be encoded as a QR payload or written to an NFC NDEF tag.
 * No central rendezvous service is required after the first peer connection.
 */
object P2PNode {
    private const val DEFAULT_TCP_PORT = 9000
    private const val DEFAULT_QUIC_PORT = 9001

    init {
        System.loadLibrary("equilibrium_core")
    }

    @JvmStatic
    external fun start(tcpPort: Int, quicPort: Int): Boolean

    @JvmStatic
    external fun stop()

    @JvmStatic
    external fun connect(inviteAddress: String): Boolean

    fun startDefault(): Boolean = start(DEFAULT_TCP_PORT, DEFAULT_QUIC_PORT)

    /**
     * Accept either a raw libp2p multiaddr or an
     * `equilibrium://bootstrap?addr=...` QR/NFC invite.
     */
    fun connectInvite(value: String): Boolean {
        val raw = value.trim()
        val multiaddr = if (raw.startsWith("/")) {
            raw
        } else {
            val uri = runCatching { Uri.parse(raw) }.getOrNull() ?: return false
            if (uri.scheme != "equilibrium" || uri.host != "bootstrap") return false
            uri.getQueryParameter("addr") ?: return false
        }
        return multiaddr.startsWith("/") && connect(multiaddr)
    }
}