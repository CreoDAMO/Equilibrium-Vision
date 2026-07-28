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

    /**
     * Ask a connected peer for its chain tip via the lightnode RR protocol.
     * Returns a JSON string `{"height":<Long>,"hash":"<hex>","difficulty":<Long>}`,
     * or an empty string if no peer is reachable or the request times out (~5 s).
     *
     * MiningWorker uses this as the second tier in the tip priority chain:
     *   1. `fetchTip()`           — local cache (instant, no network)
     *   2. `queryLightnodeTip()`  — P2P lightnode RR (this, ~1–5 s)
     *   3. HTTP `/api/chain/status` — last resort
     */
    @JvmStatic
    external fun queryLightnodeTip(): String

    /**
     * Request a full block body from a connected peer by hash via the sync RR protocol.
     * Also checks the local block ring first to avoid a network round-trip.
     * Returns the block JSON string, or an empty string on failure / timeout.
     */
    @JvmStatic
    external fun querySyncBlock(hash: String): String

    /**
     * Publish a full block body JSON string to connected peers via Gossipsub.
     * Also stores the body in the local block ring so peers can fetch it via sync RR.
     * Returns `true` if the body was queued for sending.
     *
     * MiningWorker calls this after a successful HTTP block submit so other phones
     * can store the accepted block without needing their own HTTP connection.
     */
    @JvmStatic
    external fun gossipBlockBody(bodyJson: String): Boolean

    /**
     * Push a block body JSON string into the local ring buffer without gossiping.
     * Use this after fetching a block via HTTP or sync RR so the phone can serve
     * it to other peers over the sync RR protocol.
     *
     * Unlike [gossipBlockBody], this does NOT publish to Gossipsub.
     */
    @JvmStatic
    external fun pushBlockBody(bodyJson: String)

    /**
     * Request a range of block bodies from a connected peer by height via the
     * sync RR protocol.
     *
     * Returns a JSON string `{"blocks":[...]}` with all available blocks in
     * [fromHeight, toHeight], or an empty string on failure / timeout.
     *
     * Use during initial sync to fill the local block ring from a peer without
     * requiring HTTP access to the API server.
     */
    @JvmStatic
    external fun querySyncBlocks(fromHeight: Long, toHeight: Long): String

    /** Return the number of currently established peer connections. */
    @JvmStatic
    external fun getConnectedPeerCount(): Int

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