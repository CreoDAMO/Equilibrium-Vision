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

    /**
     * Publish a solved block hash to all connected peers via Gossipsub.
     * No-op (returns false) if the swarm is not running.
     */
    @JvmStatic
    external fun gossipBlock(hash: String): Boolean

    /**
     * Pop the next inbound block hash received from peers, or an empty string
     * if the queue is empty.  Call this after submitting a solved block to
     * skip re-solving a height that a peer has already won.
     */
    @JvmStatic
    external fun pollGossip(): String

    /** Whether the in-process swarm is currently running. */
    @JvmStatic
    external fun isRunning(): Boolean

    /**
     * Return the latest locally-cached chain tip as a JSON string, or an empty
     * string if no tip is known yet.
     *
     * JSON: `{"height":<Long>,"hash":"<hex>","difficulty":<Long>}`
     *
     * Call this before the HTTP fallback in MiningWorker so that, when peers
     * are reachable, the mining loop is independent of the cloud node for tip
     * data.
     */
    @JvmStatic
    external fun fetchTip(): String

    /**
     * Update the local tip cache after a block is accepted or received from
     * a peer.  Returns `true` if the height advanced.
     *
     * MiningWorker calls this after every successful submit so subsequent
     * cycles can use the P2P tip path immediately.
     */
    @JvmStatic
    external fun setLocalTip(height: Long, hash: String, difficulty: Long): Boolean

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